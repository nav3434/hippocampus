/**
 * D22 — the two read-path defects in `recall` that D21 disclosed rather than
 * fixed, plus the third one found while fixing them and the `context` sibling.
 *
 * 1. `similarity` meant two things in one response: raw cosine on the direct
 *    path, `sim * recallBoost * importance * SPREAD_DECAY` on the spread path.
 * 2. `recall` sliced to `limit` inside the search (ranked by the boosted
 *    composite) and then filtered on raw similarity, so a boosted row could
 *    take a slot and vanish, returning fewer rows than asked for.
 * 3. The spread branch's re-sort ordered DIRECT hits by raw cosine, throwing
 *    away the boost the search had just ranked them by.
 * The fourth defect — `context`'s semantic fallback — is pinned in
 * `tests/context-scoring.test.ts`, which needs a database no other fixture
 * writes to: `context` takes no type filter, so any boosted row seeded here
 * would compete for its topic.
 *
 * Every guard here carries a POSITIVE CONTROL: an assertion that the fixture
 * would have fired against the unfixed code. Without one, "the defect no longer
 * happens" is equally satisfied by a fixture that never reached the defect —
 * which is how three guards in this repo passed vacuously in a single session.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-recall-scoring-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-recall-scoring';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall } = await import('../src/mcp/tools/recall.js');
const { findOrCreateEntity } = await import('../src/db/entities.js');
const { createRelationship } = await import('../src/db/relationships.js');
const { generateEmbedding, semanticSearchWithVector } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

// Mirrors of the private constants in the modules under test. If either drifts,
// the precondition assertions below fail rather than the guards silently
// measuring against the wrong number.
const SIMILARITY_THRESHOLD = 0.15;
const SPREAD_DECAY = 0.5;
const ALPHA = 0.1;

const boostFor = (recallCount: number) => 1 + ALPHA * Math.log(1 + recallCount);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function setRecallCount(observationId: string, count: number): void {
  getDatabase().prepare('UPDATE observations SET recall_count = ? WHERE id = ?').run(count, observationId);
}

before(() => {
  initDatabase();
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

// ---------------------------------------------------------------------------
// Defect 2 — a boosted row takes a slot and is then filtered out
// ---------------------------------------------------------------------------

describe('recall returns as many rows as it was asked for (D22)', () => {
  const QUERY = 'winter cycling in Helsinki';
  // Separate entities throughout: dedup-on-write is per-entity and same-day, so
  // two similar observations on ONE entity collapse into one row and every
  // count below would quietly measure something else.
  const TEXTS = [
    'Cycling year-round in Helsinki through snow and ice',
    'Riding a bicycle to work in cold weather',
    'Bike lanes are ploughed before the roads in Nordic cities',
    'Studded tyres make the bike commute safe in January',
    'Strength training three times a week with progressive overload',
    'SQLCipher encrypts the whole database file at rest',
    'Atmospheric physics doctorate at TU Delft',
    'Kubernetes ingress controller annotations for TLS termination',
    'The dog is called Caper and walks every morning',
    'Quarterly board pack for the accounting business',
  ];

  // Its own entity type, so every query in this block is scoped to its own
  // fixture. The file shares one database across five describe blocks, and a
  // block that queries unscoped is correct only for as long as suites run in
  // declaration order — which is not a property worth depending on.
  const SLOT_TYPE = 'slot-fixture';

  let qualifying = 0;
  let queryVector: Float32Array;

  before(async () => {
    for (let i = 0; i < TEXTS.length; i++) {
      await remember({ content: TEXTS[i], entity: `slot-e${i}`, type: SLOT_TYPE });
    }

    queryVector = await generateEmbedding(QUERY);
    const all = semanticSearchWithVector(queryVector, { limit: 100, type: SLOT_TYPE });

    // Boost every row that sits BELOW the floor. These are exactly the rows
    // that can never be returned, so any slot one of them wins is a lost row.
    // 100 is the recall count CLAUDE.md uses as its own worked example (~1.46x)
    // — not a contrived number.
    for (const r of all) {
      if (r.similarity < SIMILARITY_THRESHOLD) setRecallCount(r.observation_id, 100);
    }
    qualifying = all.filter(r => r.similarity >= SIMILARITY_THRESHOLD).length;
  });

  test('precondition: the fixture straddles the floor in both directions', () => {
    const all = semanticSearchWithVector(queryVector, { limit: 100, type: SLOT_TYPE });
    const below = all.filter(r => r.similarity < SIMILARITY_THRESHOLD);
    assert.ok(qualifying >= 2, `need >= 2 rows above the floor, got ${qualifying}`);
    assert.ok(below.length >= 1, `need >= 1 row below the floor, got ${below.length}`);
  });

  test('POSITIVE CONTROL: without the floor, a below-floor row wins a slot', () => {
    // This is the unfixed mechanism, still callable: rank the whole set and
    // slice to `limit`. If no below-floor row makes the cut here, the fixture
    // never reaches the defect and the guard below proves nothing.
    const unfloored = semanticSearchWithVector(queryVector, { limit: qualifying, type: SLOT_TYPE });
    const wasted = unfloored.filter(r => r.similarity < SIMILARITY_THRESHOLD);
    assert.ok(
      wasted.length >= 1,
      'fixture does not reach the defect: no below-floor row took one of the ' +
      `${qualifying} slots (boost may be too small for this embedding model)`
    );
  });

  test('the floored search fills every slot with a qualifying row', () => {
    const floored = semanticSearchWithVector(queryVector, {
      limit: qualifying,
      type: SLOT_TYPE,
      minSimilarity: SIMILARITY_THRESHOLD,
    });
    assert.equal(floored.length, qualifying);
    for (const r of floored) {
      assert.ok(r.similarity >= SIMILARITY_THRESHOLD, `row under the floor came back: ${r.similarity}`);
    }
  });

  test('recall returns min(limit, qualifying rows), not fewer', async () => {
    const result = await recall({
      query: QUERY,
      limit: qualifying,
      type: SLOT_TYPE,
      spread: false,
      format: 'full',
    }) as { count: number; memories: Array<{ similarity?: number }> };

    assert.equal(
      result.count,
      qualifying,
      `asked for ${qualifying} with ${qualifying} qualifying rows in the store, got ${result.count}`
    );
    for (const m of result.memories) {
      assert.ok(m.similarity === undefined || m.similarity >= SIMILARITY_THRESHOLD);
    }
  });

  test('a limit below the qualifying count is still honoured exactly', async () => {
    const result = await recall({ query: QUERY, limit: 2, type: SLOT_TYPE, spread: false, format: 'full' }) as { count: number };
    assert.equal(result.count, 2);
  });
});

// ---------------------------------------------------------------------------
// Defect 1 — `similarity` is raw cosine on every path that computes one
// ---------------------------------------------------------------------------

describe('recall reports raw cosine in `similarity`, on both paths (D22)', () => {
  const QUERY = 'atmospheric physics research';
  // Verbatim-matching text on the spread side, so its cosine is near 1 and the
  // old composite lands ABOVE 1.0 — a value no cosine can take, which is the
  // symptom that makes the two meanings visible without needing D21's wider
  // importance range.
  const SPREAD_TEXT = 'atmospheric physics research';
  const DIRECT_TEXT = 'PhD atmospheric physics from TU Delft in the Netherlands';
  const SPREAD_RECALL_COUNT = 100000;

  let spreadObsId = '';
  let spreadVector: Float32Array;
  let directVector: Float32Array;
  let queryVector: Float32Array;

  before(async () => {
    const person = findOrCreateEntity('sim-person', 'person');
    const project = findOrCreateEntity('sim-project', 'project');
    await remember({ content: DIRECT_TEXT, entity: 'sim-person', type: 'person' });
    await remember({ content: SPREAD_TEXT, entity: 'sim-project', type: 'project' });
    createRelationship(person.id, project.id, 'created');

    const row = getDatabase()
      .prepare('SELECT id FROM observations WHERE content = ?')
      .get(SPREAD_TEXT) as { id: string };
    spreadObsId = row.id;
    setRecallCount(spreadObsId, SPREAD_RECALL_COUNT);

    queryVector = await generateEmbedding(QUERY);
    spreadVector = await generateEmbedding(SPREAD_TEXT);
    directVector = await generateEmbedding(DIRECT_TEXT);
  });

  test('POSITIVE CONTROL: the old formula would report a similarity above 1.0', () => {
    const sim = cosineSimilarity(queryVector, spreadVector);
    const oldReported = round3(sim * boostFor(SPREAD_RECALL_COUNT) * 1.0 * SPREAD_DECAY);
    assert.ok(
      oldReported > 1.0,
      `fixture does not reach the defect: the old composite is ${oldReported}, ` +
      'which is a value a cosine could legitimately take'
    );
    // ...and it differs from the raw cosine, so the two are distinguishable at all.
    assert.notEqual(oldReported, round3(sim));
  });

  test('a spread hit reports its raw cosine, not the damped composite', async () => {
    const result = await recall({
      query: QUERY,
      type: 'person',
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const spreadRow = result.memories.find(m => m.entity === 'sim-project');
    assert.ok(spreadRow, 'spread should have reached the related project entity');

    const expected = round3(cosineSimilarity(queryVector, spreadVector));
    assert.equal(spreadRow.similarity, expected, 'reported value is not the raw cosine');
  });

  test('no reported similarity exceeds 1.0 on any path', async () => {
    const result = await recall({
      query: QUERY,
      type: 'person',
      spread: true,
      format: 'full',
    }) as { memories: Array<{ similarity?: number }> };

    for (const m of result.memories) {
      if (m.similarity === undefined) continue;
      assert.ok(m.similarity <= 1.0, `similarity ${m.similarity} is not a cosine`);
      assert.ok(m.similarity >= -1.0, `similarity ${m.similarity} is not a cosine`);
    }
  });

  test('the decay penalises the spread row rather than guaranteeing it ranks last', async () => {
    // Worth stating plainly, because the pre-D22 test's name implied otherwise:
    // SPREAD_DECAY halves the spread row's OWN score. It does not guarantee the
    // row sorts below every direct hit. This fixture is the proof — the spread
    // text matches the query verbatim and carries a large recall count, so even
    // halved it out-ranks a direct hit with a mediocre cosine.
    //
    // That was equally true before this change (the old sort compared the
    // spread row's damped composite against the direct row's raw cosine and
    // reached the same order), so nothing regressed here. What changed is only
    // which number is REPORTED. The case where the decay does decide the order
    // is pinned separately, in the re-sort suite below.
    const result = await recall({
      query: QUERY,
      type: 'person',
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const direct = result.memories.find(m => m.entity === 'sim-person');
    const spread = result.memories.find(m => m.entity === 'sim-project');
    assert.ok(direct && spread, 'both rows should be present');

    // The ORDERING assertion the name makes. Without this the test survived a
    // mutation forcing every spread row to sort last — it only failed under the
    // raw-cosine mutation, because it duplicated the assertion above it.
    const directIdx = result.memories.findIndex(m => m.entity === 'sim-person');
    const spreadIdx = result.memories.findIndex(m => m.entity === 'sim-project');
    assert.ok(
      spreadIdx < directIdx,
      `the spread hit ranked at ${spreadIdx}, behind the direct hit at ${directIdx} — ` +
      'on this fixture its damped score is the larger of the two, so ranking it ' +
      'lower means the decay is being treated as a subordination rule'
    );

    // PRECONDITION making that assertion meaningful: the damped spread score
    // really does exceed the direct row's rank score on this fixture, so
    // "spread first" is the arithmetic and not an accident of insertion order.
    const sim = cosineSimilarity(queryVector, spreadVector);
    const dampedSpread = sim * boostFor(SPREAD_RECALL_COUNT) * 1.0 * SPREAD_DECAY;
    const directSim = cosineSimilarity(queryVector, directVector);
    assert.ok(
      dampedSpread > directSim,
      `damped spread ${round3(dampedSpread)} does not exceed the direct rank ` +
      `${round3(directSim)} — the fixture no longer shows what this test claims`
    );
  });
});

// ---------------------------------------------------------------------------
// A consequence of the fix, pinned rather than left to be rediscovered
// ---------------------------------------------------------------------------

describe('a spread row may report a similarity below the direct floor (D22)', () => {
  // Not a defect, and not a change to which rows come back — but it is new, and
  // it is the kind of thing a caller writing `similarity >= 0.15` would trip on.
  //
  // Spread rows are admitted on their DAMPED score, direct rows on raw cosine.
  // Those two bars were never commensurable; before D22 the difference was
  // invisible because the spread row DISPLAYED the damped value, which by
  // construction cleared the floor. Now it displays the raw cosine, which need
  // not. The set of rows returned is identical either way — only the number is
  // honest now. Pinned so the next reader meets it as a decision.
  const QUERY = 'winter cycling in Helsinki';
  const ANCHOR_TYPE = 'floor-anchor';
  const RELATED_TYPE = 'floor-related';
  const ANCHOR_TEXT = 'Cycling all winter in Helsinki on studded tyres';
  const WEAK_TEXT = 'Column-level encryption keys are rotated on a schedule';
  // The band this fixture must sit in is `[0.15 / (boost * SPREAD_DECAY), 0.15)`
  // — under the direct floor, over the damped bar — and the boost is what sets
  // its width. This count is chosen for MARGIN, not realism: it centres the
  // fixture with ~30% clearance on both sides, where a realistic count leaves
  // a band a few percent wide that a change of embedding model would flip. The
  // property is reachable at far lower counts; it is only harder to pin there.
  // (The realism claims in this file belong to the `limit` suite, which runs at
  // the recall count of 100 CLAUDE.md uses as its own worked example.)
  const WEAK_RECALL_COUNT = 1_000_000_000_000;

  let weakSim = 0;

  before(async () => {
    await remember({ content: ANCHOR_TEXT, entity: 'floor-anchor-e', type: ANCHOR_TYPE });
    await remember({ content: WEAK_TEXT, entity: 'floor-related-e', type: RELATED_TYPE });
    const anchor = findOrCreateEntity('floor-anchor-e', ANCHOR_TYPE);
    const related = findOrCreateEntity('floor-related-e', RELATED_TYPE);
    createRelationship(anchor.id, related.id, 'mentions');

    const row = getDatabase()
      .prepare('SELECT id FROM observations WHERE content = ?')
      .get(WEAK_TEXT) as { id: string };
    setRecallCount(row.id, WEAK_RECALL_COUNT);

    const q = await generateEmbedding(QUERY);
    weakSim = cosineSimilarity(q, await generateEmbedding(WEAK_TEXT));
  });

  test('precondition: the row is under the direct floor but over the damped bar', () => {
    assert.ok(
      weakSim < SIMILARITY_THRESHOLD,
      `raw cosine ${round3(weakSim)} clears the direct floor — the fixture shows nothing`
    );
    const damped = weakSim * boostFor(WEAK_RECALL_COUNT) * 1.0 * SPREAD_DECAY;
    assert.ok(
      damped >= SIMILARITY_THRESHOLD,
      `damped ${round3(damped)} does not clear the spread bar — the row would not be returned at all`
    );
  });

  test('the row comes back, reporting its true cosine rather than the composite', async () => {
    const result = await recall({
      query: QUERY,
      type: ANCHOR_TYPE,
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const row = result.memories.find(m => m.entity === 'floor-related-e');
    assert.ok(row, 'the spread row should still be returned — the inclusion rule did not change');
    assert.equal(row.similarity, round3(weakSim));
    assert.ok(
      (row.similarity ?? 1) < SIMILARITY_THRESHOLD,
      'this is the property under test: a returned row below the direct floor'
    );
  });

  test('direct rows are still never below the floor', async () => {
    const result = await recall({
      query: QUERY,
      type: ANCHOR_TYPE,
      spread: false,
      format: 'full',
    }) as { memories: Array<{ similarity?: number }> };

    for (const m of result.memories) {
      if (m.similarity === undefined) continue;
      assert.ok(m.similarity >= SIMILARITY_THRESHOLD, `direct row under the floor: ${m.similarity}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Defect 3 — the spread re-sort discarded the direct path's boost
// ---------------------------------------------------------------------------

describe('the spread re-sort preserves the search ranking (D22)', () => {
  const QUERY = 'restoring a dry stone wall on the hillside';
  const STRONGER = 'Rebuilding the old dry stone wall along the upper field';
  const WEAKER = 'The hillside path was cleared of loose rubble last spring';
  // Chosen so all three margins below are comfortable rather than marginal — a
  // fixture that only just clears them becomes a coin flip when the embedding
  // model changes, and a coin flip that lands green is worse than a failure.
  const BOOST_COUNT = 1000;

  let strongerSim = 0;
  let weakerSim = 0;

  before(async () => {
    // Both are DIRECT hits of the same type. The unrelated entity exists only
    // to carry a relationship, so the spread branch — and with it the re-sort
    // under test — actually executes.
    await remember({ content: STRONGER, entity: 'rank-stronger', type: 'voyage' });
    await remember({ content: WEAKER, entity: 'rank-weaker', type: 'voyage' });
    await remember({ content: 'A ledger of port fees paid in cash', entity: 'rank-unrelated', type: 'voyage' });
    const anchor = findOrCreateEntity('rank-stronger', 'voyage');
    const far = findOrCreateEntity('rank-unrelated', 'voyage');
    createRelationship(anchor.id, far.id, 'mentions');

    const q = await generateEmbedding(QUERY);
    strongerSim = cosineSimilarity(q, await generateEmbedding(STRONGER));
    weakerSim = cosineSimilarity(q, await generateEmbedding(WEAKER));

    const row = getDatabase()
      .prepare('SELECT id FROM observations WHERE content = ?')
      .get(WEAKER) as { id: string };
    setRecallCount(row.id, BOOST_COUNT);
  });

  test('precondition: the boost is what inverts the order, not the cosine', () => {
    const boosted = weakerSim * boostFor(BOOST_COUNT);
    assert.ok(
      strongerSim > weakerSim,
      `fixture assumes the unboosted row has the higher cosine (${round3(strongerSim)} vs ${round3(weakerSim)})`
    );
    assert.ok(
      boosted > strongerSim,
      `boosted ${round3(boosted)} does not beat raw ${round3(strongerSim)} — the ` +
      'fixture cannot show the re-sort discarding the boost'
    );
    assert.ok(weakerSim >= SIMILARITY_THRESHOLD, 'the boosted row must clear the floor to be returned at all');
  });

  test('a boosted direct hit keeps its position through a spread recall', async () => {
    const result = await recall({
      query: QUERY,
      type: 'voyage',
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string }> };

    const boosted = result.memories.findIndex(m => m.entity === 'rank-weaker');
    const unboosted = result.memories.findIndex(m => m.entity === 'rank-stronger');
    assert.ok(boosted >= 0 && unboosted >= 0, 'both direct hits should be present');
    assert.ok(
      boosted < unboosted,
      `the boosted row fell to ${boosted} behind ${unboosted} — the re-sort is ` +
      'ordering direct hits by raw cosine again'
    );
  });

  test('format: index lists entities in the same order as format: full', async () => {
    // The index formatter re-derived its own order from the displayed value.
    // That was equivalent while the merged set was sorted on that value too,
    // and stopped being equivalent when ranking moved off it — so the same
    // query answered in two different orders depending on the format. This
    // fixture is one where the two disagree, which is what makes it a test.
    const opts = { query: QUERY, type: 'voyage', spread: true } as const;
    const full = await recall({ ...opts, format: 'full' }) as {
      memories: Array<{ entity: string; similarity?: number }>;
    };
    const index = await recall({ ...opts, format: 'index' }) as { text: string };

    const fullOrder: string[] = [];
    for (const m of full.memories) if (!fullOrder.includes(m.entity)) fullOrder.push(m.entity);
    const indexOrder = index.text
      .split('\n')
      .slice(1) // drop the "#I N results, M entities" header
      .map(line => line.split('|')[0]);

    assert.deepEqual(indexOrder, fullOrder, 'index and full disagree about relevance order');

    // POSITIVE CONTROL: the two orders are only distinguishable because this
    // fixture's displayed similarities run the other way. Without this, an
    // index formatter sorting by similarity would satisfy the assertion above.
    const boosted = full.memories.find(m => m.entity === 'rank-weaker');
    const unboosted = full.memories.find(m => m.entity === 'rank-stronger');
    assert.ok(boosted && unboosted);
    assert.ok(
      (boosted.similarity ?? 0) < (unboosted.similarity ?? 0),
      'fixture does not discriminate: sorting the index by similarity would give ' +
      'the same order as following the ranked rows'
    );
    assert.ok(
      fullOrder.indexOf('rank-weaker') < fullOrder.indexOf('rank-stronger'),
      'the ranked order is not the one under test'
    );
  });

  test('POSITIVE CONTROL: the displayed values would sort the other way', async () => {
    // Two controls in one. (1) `spread: false` already ranks the boosted row
    // first, so the test above measures the re-sort rather than the search.
    // (2) The reported similarities are in the OPPOSITE order to the result, so
    // a re-sort on the displayed value — which is what the code did before —
    // would fail that test rather than passing it by coincidence.
    const flat = await recall({
      query: QUERY,
      type: 'voyage',
      spread: false,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const boosted = flat.memories.find(m => m.entity === 'rank-weaker');
    const unboosted = flat.memories.find(m => m.entity === 'rank-stronger');
    assert.ok(boosted && unboosted);
    assert.ok(
      flat.memories.indexOf(boosted) < flat.memories.indexOf(unboosted),
      'the base search does not rank the boosted row first'
    );
    assert.ok(
      (boosted.similarity ?? 0) < (unboosted.similarity ?? 0),
      'fixture does not discriminate: sorting by the displayed value would give ' +
      'the same order the rank key gives'
    );
  });
});

// ---------------------------------------------------------------------------
// The keyword leg keeps its shape
// ---------------------------------------------------------------------------

describe('keyword-fallback rows carry no similarity (D22)', () => {
  // `searchObservations` matches `content LIKE ?` OR `e.name LIKE ?`. Matching
  // on the NAME is what makes this row keyword-ONLY: any content sharing a
  // substring with the query also embeds near it, so a content match cannot be
  // kept under the similarity floor. Here the content is about something else
  // entirely and the cosine is near zero, so the semantic leg cannot supply it.
  const NONSENSE_ENTITY = 'zqxjvt-registry';
  const UNRELATED = 'The tide comes in twice a day along the estuary';

  before(async () => {
    await remember({ content: UNRELATED, entity: NONSENSE_ENTITY, type: 'note' });
  });

  test('precondition: the semantic leg cannot reach this row', async () => {
    const q = await generateEmbedding('zqxjvt');
    const sim = cosineSimilarity(q, await generateEmbedding(UNRELATED));
    assert.ok(
      sim < SIMILARITY_THRESHOLD,
      `cosine ${round3(sim)} clears the floor — the row could arrive semantically ` +
      'and the assertion below would be measuring the wrong leg'
    );
  });

  test('a keyword-only match has no similarity field rather than a zero', async () => {
    const result = await recall({ query: 'zqxjvt', limit: 10, spread: false, format: 'full' }) as {
      memories: Array<{ entity: string; similarity?: number }>;
    };
    const row = result.memories.find(m => m.entity === NONSENSE_ENTITY);
    assert.ok(row, 'the keyword leg should have found it by entity name');
    assert.equal(row.similarity, undefined, 'a LIKE match has no cosine to report');
  });
});

// ---------------------------------------------------------------------------
// The floor itself must not fail toward absence
// ---------------------------------------------------------------------------

describe('an unusable minSimilarity throws rather than emptying the result (D22)', () => {
  let queryVector: Float32Array;

  before(async () => {
    await remember({ content: 'A lighthouse keeper logs the weather each dawn', entity: 'floor-guard-e', type: 'note' });
    queryVector = await generateEmbedding('lighthouse weather log');
  });

  test('POSITIVE CONTROL: without a floor the query does match something', () => {
    assert.ok(
      semanticSearchWithVector(queryVector, { limit: 10 }).length > 0,
      'the query matches nothing at all, so an empty result would prove nothing'
    );
  });

  for (const bad of [NaN, Infinity, -Infinity]) {
    test(`minSimilarity ${String(bad)} is an error, not an empty answer`, () => {
      assert.throws(
        () => semanticSearchWithVector(queryVector, { limit: 10, minSimilarity: bad }),
        /minSimilarity must be a finite number/,
        // The three differ in what they do, and are refused together because
        // all three are a caller error rather than a request: NaN compares
        // false against every row and +Infinity clears none, so both return []
        // with no error — indistinguishable from an empty database, the failure
        // D13 and D15 exist to prevent in this same options object. -Infinity
        // is the harmless one (it filters nothing), refused because a floor
        // nobody could have meant is worth a message, not a silent no-op.
        `minSimilarity: ${String(bad)} silently returned a result set`
      );
    });
  }

  test('a finite floor still filters rather than throwing', () => {
    assert.doesNotThrow(() => semanticSearchWithVector(queryVector, { limit: 10, minSimilarity: 0.9 }));
    assert.doesNotThrow(() => semanticSearchWithVector(queryVector, { limit: 10, minSimilarity: 0 }));
  });
});

// ---------------------------------------------------------------------------
// The internal rank key must not reach the wire
// ---------------------------------------------------------------------------

describe('the rank key is stripped from every response (D22)', () => {
  before(async () => {
    await remember({ content: 'Helsinki harbour freezes in a hard winter', entity: 'strip-e0', type: 'note' });
  });

  for (const spread of [false, true]) {
    test(`spread: ${spread} — no memory carries a rank field`, async () => {
      const result = await recall({
        query: 'Helsinki harbour ice',
        limit: 10,
        spread,
        format: 'full',
      }) as { memories: Array<Record<string, unknown>> };

      assert.ok(result.memories.length > 0, 'need at least one row to inspect');
      for (const m of result.memories) {
        assert.ok(!('rank' in m), `internal rank key leaked: ${JSON.stringify(m)}`);
        assert.ok(!('rank_score' in m), `internal rank_score leaked: ${JSON.stringify(m)}`);
      }
    });
  }
});
