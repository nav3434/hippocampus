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
 * A fourth instance of the same mechanism lives in `context`'s semantic
 * fallback. It is NOT covered here and is not D22's to claim: D21 landed a
 * stronger fix for it (`orderBy: 'similarity'`, which also closes the window
 * displacement a floor alone leaves open), with its own guards in
 * `tests/context-resolution*.test.ts`. This file's own draft of that test was
 * deleted at the merge rather than kept as a near-duplicate.
 *
 * Every guard here that could pass vacuously carries a POSITIVE CONTROL: an
 * assertion that the fixture would have fired against the unfixed code.
 * Without one, "the defect no longer happens" is equally satisfied by a
 * fixture that never reached the defect — which is how three guards in this
 * repo passed vacuously in a single session. The exception is the rank-key
 * strip suite, where the assertion is an absence and there is nothing for a
 * control to establish beyond the non-emptiness it already checks.
 */
import { describe, test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-recall-scoring-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-recall-scoring';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { recall, SIMILARITY_THRESHOLD, SPREAD_DECAY } = await import('../src/mcp/tools/recall.js');
const { findOrCreateEntity } = await import('../src/db/entities.js');
const { createRelationship } = await import('../src/db/relationships.js');
const { generateEmbedding, semanticSearchWithVector, RECALL_BOOST_ALPHA } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

// IMPORTED, not mirrored. A test that re-declares the constant it is testing
// against silently desyncs from it, and every fixture margin computed here then
// describes a system that no longer exists.
//
// What that does and does not buy, stated precisely because two earlier
// versions of this comment got it wrong in opposite directions. Retuning
// SPREAD_DECAY fails two tests, since the fixture window
// `directSim < spreadSim < directSim / SPREAD_DECAY` stops holding. Retuning
// RECALL_BOOST_ALPHA is asymmetric: LOWERING it fails several tests (the
// boost-dependent fixtures stop clearing their bars — measured, 0.05 fails 7),
// while RAISING it fails none of them, because every fixture moves with it and
// stays inside its window. That is why the sweep suite below pins the constant
// against the worked example CLAUDE.md quotes — importing a constant protects
// the tests from desyncing, and pins nothing about its value.
const boostFor = (recallCount: number) => 1 + RECALL_BOOST_ALPHA * Math.log(1 + recallCount);
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
// The decay must be what decides the order, not decoration on it
// ---------------------------------------------------------------------------

describe('SPREAD_DECAY subordinates a related memory that would otherwise win (D22)', () => {
  // The suite above proves the decay does NOT guarantee spread rows rank last.
  // This one proves it still decides the order in the case it was built for:
  // a related memory whose raw cosine BEATS the direct hit, which the damping
  // must nonetheless place second. Without this, removing the decay from
  // ranking entirely — or retuning it to 0.9 — left the whole file green.
  const QUERY = 'a harbour seal hauled out on the rocks';
  const DIRECT_TEXT = 'Seals rest on the skerries outside the harbour mouth';
  const SPREAD_TEXT = 'A harbour seal hauled out on the rocks at low tide';
  const ANCHOR_TYPE = 'decay-anchor';
  const RELATED_TYPE = 'decay-related';

  let directSim = 0;
  let spreadSim = 0;

  before(async () => {
    await remember({ content: DIRECT_TEXT, entity: 'decay-direct-e', type: ANCHOR_TYPE });
    await remember({ content: SPREAD_TEXT, entity: 'decay-spread-e', type: RELATED_TYPE });
    const anchor = findOrCreateEntity('decay-direct-e', ANCHOR_TYPE);
    const related = findOrCreateEntity('decay-spread-e', RELATED_TYPE);
    createRelationship(anchor.id, related.id, 'mentions');

    const q = await generateEmbedding(QUERY);
    directSim = cosineSimilarity(q, await generateEmbedding(DIRECT_TEXT));
    spreadSim = cosineSimilarity(q, await generateEmbedding(SPREAD_TEXT));
  });

  test('precondition: undamped the spread row wins, damped it loses', () => {
    // Neither row is boosted, so each rank score is its cosine times the decay
    // that applies to it. The window this fixture must sit in is
    // `directSim < spreadSim < directSim / SPREAD_DECAY`.
    assert.ok(
      spreadSim > directSim,
      `spread ${spreadSim.toFixed(3)} does not beat direct ${directSim.toFixed(3)} — ` +
      'without the decay there would be nothing for it to overturn'
    );
    // Compared against the direct row's RANK score, which is what the code
    // orders on — `directSim * recallBoost * importance`. Neither fixture row
    // is boosted and both sit at neutral importance, so the rank score is the
    // cosine here; saying so keeps the precondition aligned with the condition
    // rather than being a weaker stand-in for it.
    const directRank = directSim * boostFor(0) * 1.0;
    assert.equal(directRank, directSim, 'fixture assumes the direct row is unboosted at neutral importance');
    assert.ok(
      spreadSim * SPREAD_DECAY < directRank,
      `damped spread ${(spreadSim * SPREAD_DECAY).toFixed(3)} still beats the direct ` +
      `rank ${directRank.toFixed(3)} — the decay is too weak to decide this fixture`
    );
    assert.ok(spreadSim * SPREAD_DECAY >= SIMILARITY_THRESHOLD, 'the spread row must clear its own bar');
  });

  test('the direct hit ranks first even though it is the weaker cosine', async () => {
    const result = await recall({
      query: QUERY,
      type: ANCHOR_TYPE,
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const directIdx = result.memories.findIndex(m => m.entity === 'decay-direct-e');
    const spreadIdx = result.memories.findIndex(m => m.entity === 'decay-spread-e');
    assert.ok(directIdx >= 0 && spreadIdx >= 0, 'both rows should be present');
    assert.ok(
      directIdx < spreadIdx,
      `the related memory ranked at ${spreadIdx}, ahead of the direct hit at ` +
      `${directIdx} — the decay is no longer subordinating spread rows`
    );

    // POSITIVE CONTROL: the displayed values run the other way, so this ordering
    // cannot have come from sorting on `similarity`.
    const direct = result.memories[directIdx];
    const spread = result.memories[spreadIdx];
    assert.ok(
      (spread.similarity ?? 0) > (direct.similarity ?? 0),
      'fixture does not discriminate: the ranked order matches the cosine order'
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
    // A second, much weaker row on the same entity as STRONGER — dissimilar
    // enough (pairwise ~0.21) that dedup-on-write keeps both rather than
    // collapsing them into one, which would leave every group a single row.
    await remember({ content: 'Lichen grows thick on the north face of the wall', entity: 'rank-stronger', type: 'voyage' });
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

  // Reset before EVERY test, not once. `recall` calls `touchRecalledObservations`
  // on what it returns, so each test in this suite raises the recall counts of
  // the rows the next one measures — and this fixture's whole point is a
  // recall-count difference. Left unreset, the unboosted row overtakes after
  // about five recalls and the suite starts failing on its own side effects,
  // which is how the index test added later first surfaced.
  beforeEach(() => {
    const db = getDatabase();
    for (const [content, count] of [[STRONGER, 0], [WEAKER, BOOST_COUNT]] as const) {
      const row = db.prepare('SELECT id FROM observations WHERE content = ?').get(content) as { id: string };
      setRecallCount(row.id, count);
    }
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

  test('an index line shows the best similarity in its entity group', async () => {
    // The formatter's own comment claims this ("what makes it useful for
    // deciding where to expand"), and picking the WORST of each group instead
    // left every test green.
    // `rank-stronger` carries a second, weaker observation (added in this
    // suite's setup) so at least one entity group has a best and a worst to
    // tell apart — otherwise the assertion is satisfied by any choice.
    const opts = { query: QUERY, type: 'voyage', limit: 50 } as const;
    const full = await recall({ ...opts, format: 'full' }) as {
      memories: Array<{ entity: string; similarity?: number }>;
    };
    const index = await recall({ ...opts, format: 'index' }) as { text: string };

    const best = new Map<string, number>();
    for (const m of full.memories) {
      if (m.similarity === undefined) continue;
      best.set(m.entity, Math.max(best.get(m.entity) ?? -Infinity, m.similarity));
    }
    assert.ok(best.size > 0, 'no scored rows to compare');

    for (const line of index.text.split('\n').slice(1)) {
      const [name, , , shown] = line.split('|');
      const expected = best.get(name);
      if (expected === undefined) continue;
      assert.equal(shown, expected.toFixed(2), `index line for ${name} does not show its best similarity`);
    }

    // POSITIVE CONTROL: at least one entity contributes more than one row, so
    // "best" and "worst" are distinguishable at all.
    const counts = new Map<string, number>();
    for (const m of full.memories) counts.set(m.entity, (counts.get(m.entity) ?? 0) + 1);
    assert.ok(
      [...counts.values()].some(n => n > 1),
      'every entity has exactly one row, so best-vs-worst cannot be told apart here'
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

  // Second fixture, for the ranking test below: an entity whose NAME contains
  // the query while its content sits well clear of the similarity floor.
  const NAMED_ENTITY = 'harbour seal filings';
  const FAR_CONTENT = 'Quarterly depreciation schedule for office furniture';
  const SEMANTIC_ENTITY = 'kw-semantic';
  const NEAR_CONTENT = 'Harbour seals bask on the skerries at low tide';

  before(async () => {
    await remember({ content: UNRELATED, entity: NONSENSE_ENTITY, type: 'note' });
    await remember({ content: FAR_CONTENT, entity: NAMED_ENTITY, type: 'note' });
    await remember({ content: NEAR_CONTENT, entity: SEMANTIC_ENTITY, type: 'note' });
  });

  test('precondition: the named entity is unreachable semantically', async () => {
    const q = await generateEmbedding('harbour seal');
    const far = cosineSimilarity(q, await generateEmbedding(FAR_CONTENT));
    const near = cosineSimilarity(q, await generateEmbedding(NEAR_CONTENT));
    assert.ok(far < SIMILARITY_THRESHOLD, `far content scores ${round3(far)}, above the floor`);
    assert.ok(near >= SIMILARITY_THRESHOLD, `near content scores ${round3(near)}, below the floor`);
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

  test('a keyword-only row ranks below every semantic row', async () => {
    // The `ScoredMemory` comment says keyword rows carry a literal 0 and sort
    // last. Nothing checked it: giving them a huge rank left the suite green,
    // while in practice a LIKE match with no cosine at all would displace real
    // matches out of `limit`. Only the spread path re-sorts, so that is where
    // a wrong rank would actually surface.
    //
    // This needs a query that is BOTH meaningful (so semantic rows exist to
    // rank against) and a substring of an entity NAME whose content is far away
    // (so that row can only arrive by LIKE). The nonsense-token fixture above
    // cannot do it: nothing matches a nonsense token semantically, so there is
    // nothing for the keyword row to rank below.
    const result = await recall({
      query: 'harbour seal',
      limit: 50,
      type: 'note',
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string; similarity?: number }> };

    const keywordIdx = result.memories.findIndex(m => m.similarity === undefined);
    assert.ok(keywordIdx >= 0, 'need a keyword-only row in the result to place');
    const semanticAfter = result.memories.slice(keywordIdx + 1).filter(m => m.similarity !== undefined);
    assert.equal(
      semanticAfter.length,
      0,
      `${semanticAfter.length} semantic row(s) ranked below a keyword-only row`
    );

    // POSITIVE CONTROL: there is something for it to rank below.
    assert.ok(
      result.memories.slice(0, keywordIdx).some(m => m.similarity !== undefined),
      'no semantic row present, so the ordering claim is untested'
    );
  });

  test('a keyword-only match has no similarity field rather than a zero', async () => {
    const result = await recall({ query: 'zqxjvt', limit: 10, type: 'note', spread: false, format: 'full' }) as {
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

  // A cosine cannot leave [-1, 1], so every one of these is a floor nobody
  // could have meant. They fail differently — NaN, +Infinity and 5 drop every
  // row and return an empty set indistinguishable from an empty database;
  // -Infinity and -2 filter nothing — and are refused together because the
  // rule is statable in one line only if it covers both directions.
  for (const bad of [NaN, Infinity, -Infinity, 5, -2, 1.0001]) {
    test(`minSimilarity ${String(bad)} is an error, not an empty answer`, () => {
      assert.throws(
        () => semanticSearchWithVector(queryVector, { limit: 10, minSimilarity: bad }),
        /minSimilarity must be a finite number in \[-1, 1\]/,
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
    for (const ok of [0.9, 0, -1, 1]) {
      assert.doesNotThrow(
        () => semanticSearchWithVector(queryVector, { limit: 10, minSimilarity: ok }),
        `minSimilarity ${ok} is inside [-1, 1] and must be accepted`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The floor widens the SEED set, so spread returns rows it could not reach
// ---------------------------------------------------------------------------

describe('freeing a direct slot makes its relationships reachable (D22)', () => {
  // The disclosure paragraph in D22 originally said the set of rows coming back
  // was unchanged and only the displayed number moved. That is true of the
  // spread path in isolation and FALSE of the two together: spreading seeds
  // from the direct rows, so a direct row that was displaced by a boosted
  // below-floor row took its relationships out of the answer with it. Round 3
  // caught the claim; this pins the behaviour it should have described.
  const QUERY = 'a footpath along the cliff edge';
  const SEED_TYPE = 'seed-direct';
  const RELATED_TYPE = 'seed-related';
  const STRONG = 'The coastal footpath runs right along the cliff edge';
  const SEED = 'A waymarked trail follows the headland above the sea';
  const RELATED = 'a footpath along the cliff edge';
  const DECOYS = [
    'Depreciation is charged on a straight-line basis',
    'The build pipeline caches node modules between runs',
  ];
  const LIMIT = 3;

  let seedSim = 0;
  let decoySims: number[] = [];
  let queryVector: Float32Array;
  const getQueryVector = () => queryVector;

  before(async () => {
    await remember({ content: STRONG, entity: 'seed-strong-e', type: SEED_TYPE });
    await remember({ content: SEED, entity: 'seed-seed-e', type: SEED_TYPE });
    for (let i = 0; i < DECOYS.length; i++) {
      await remember({ content: DECOYS[i], entity: `seed-decoy-${i}`, type: SEED_TYPE });
    }
    await remember({ content: RELATED, entity: 'seed-related-e', type: RELATED_TYPE });
    createRelationship(
      findOrCreateEntity('seed-seed-e', SEED_TYPE).id,
      findOrCreateEntity('seed-related-e', RELATED_TYPE).id,
      'mentions'
    );

    const q = await generateEmbedding(QUERY);
    queryVector = q;
    seedSim = cosineSimilarity(q, await generateEmbedding(SEED));
    decoySims = [];
    for (const d of DECOYS) decoySims.push(cosineSimilarity(q, await generateEmbedding(d)));

    // Derive the recall count from the MEASURED similarities rather than
    // hard-coding one: each decoy is boosted just past 1.5x the seed's score,
    // so the fixture keeps its margin if the embedding model moves.
    const db = getDatabase();
    for (let i = 0; i < DECOYS.length; i++) {
      const needed = (1.5 * seedSim) / Math.max(decoySims[i], 1e-6);
      const count = Math.ceil(Math.exp((needed - 1) / RECALL_BOOST_ALPHA));
      const row = db.prepare('SELECT id FROM observations WHERE content = ?').get(DECOYS[i]) as { id: string };
      setRecallCount(row.id, count);
    }
  });

  test('precondition: the decoys are below the floor and outrank the seed', () => {
    for (const sim of decoySims) {
      assert.ok(sim < SIMILARITY_THRESHOLD, `a decoy scores ${round3(sim)}, above the floor`);
    }
    assert.ok(seedSim >= SIMILARITY_THRESHOLD, `the seed scores ${round3(seedSim)}, below the floor`);

    // The unfixed mechanism, still callable: rank the whole set and slice.
    const unfloored = semanticSearchWithVector(getQueryVector(), { limit: LIMIT, type: SEED_TYPE });
    assert.ok(
      !unfloored.some(r => r.entity_name === 'seed-seed-e'),
      'the seed survives an unfloored slice, so nothing was displacing it'
    );
  });

  test('the related row is reachable because the seed kept its slot', async () => {
    const result = await recall({
      query: QUERY,
      type: SEED_TYPE,
      limit: LIMIT,
      spread: true,
      format: 'full',
    }) as { memories: Array<{ entity: string }> };

    assert.ok(
      result.memories.some(m => m.entity === 'seed-seed-e'),
      'the seed entity should hold a slot now that the floor runs before the slice'
    );
    assert.ok(
      result.memories.some(m => m.entity === 'seed-related-e'),
      'the related row is only reachable by spreading from the seed — pre-D22 the ' +
      'seed was displaced by a boosted below-floor row and this row did not exist ' +
      'in the answer at all'
    );
  });
});

// ---------------------------------------------------------------------------
// Contracts the survivors of the round-3 mutation sweep left unpinned
// ---------------------------------------------------------------------------

describe('the search honours its own limit and its own boost constant (D22)', () => {
  const SWEEP_TYPE = 'sweep-fixture';
  const TEXTS = [
    'The ferry leaves the quay at first light',
    'Gulls follow the wake all the way across',
    'A thermos of coffee sits wedged by the rail',
    'The crossing takes two hours in fair weather',
    'Cars are lashed down on the vehicle deck',
  ];

  let queryVector: Float32Array;

  before(async () => {
    for (let i = 0; i < TEXTS.length; i++) {
      await remember({ content: TEXTS[i], entity: `sweep-e${i}`, type: SWEEP_TYPE });
    }
    queryVector = await generateEmbedding('the morning ferry crossing');
  });

  test('semanticSearchWithVector slices to limit', () => {
    // Nothing pinned this. Removing the slice entirely left the whole suite
    // green, while every over-fetch guard in this file is written on the
    // assumption that the slice is what makes a slot scarce.
    const all = semanticSearchWithVector(queryVector, { limit: 100, type: SWEEP_TYPE });
    assert.ok(all.length >= 3, `need >= 3 rows in the fixture, got ${all.length}`);
    for (const limit of [1, 2, 3]) {
      const got = semanticSearchWithVector(queryVector, { limit, type: SWEEP_TYPE });
      assert.equal(got.length, limit, `limit ${limit} returned ${got.length} rows`);
    }
  });

  test('RECALL_BOOST_ALPHA still produces the boost the docs quote', () => {
    // CLAUDE.md documents the decay boost with a worked example — a recall
    // count of 100 giving ~1.46x — and three fixtures in this file are sized
    // against it. Because the tests import the constant rather than mirroring
    // it, raising it tenfold left everything green: the fixtures move with it.
    // This is the one place that pins the value, so the documented example and
    // the code cannot drift apart silently.
    assert.equal(RECALL_BOOST_ALPHA, 0.1);
    assert.ok(
      Math.abs(boostFor(100) - 1.4615) < 0.001,
      `boost at a recall count of 100 is ${boostFor(100).toFixed(4)}, not the ~1.46x CLAUDE.md quotes`
    );
  });

  test('the direct path reports similarity rounded to three places', async () => {
    const result = await recall({
      query: 'the morning ferry crossing',
      type: SWEEP_TYPE,
      spread: false,
      format: 'full',
    }) as { memories: Array<{ similarity?: number }> };

    assert.ok(result.memories.length > 0);
    for (const m of result.memories) {
      if (m.similarity === undefined) continue;
      assert.equal(m.similarity, round3(m.similarity), `similarity ${m.similarity} is not rounded`);
    }
  });

  test('an index line shows "-" for an entity with no similarity at all', async () => {
    // Not `0.00`, which is a real cosine and reads as "compared, and distant"
    // in the one format an AI uses to choose what to expand.
    const result = await recall({
      query: 'harbour seal',
      limit: 50,
      type: 'note',
      spread: false,
      format: 'index',
    }) as { text: string };

    const line = result.text.split('\n').slice(1).find(l => l.startsWith('harbour seal filings|'));
    assert.ok(line, 'the keyword-only entity should be in the index');
    assert.equal(line.split('|')[3].split('|')[0], '-', `index line reads: ${line}`);
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
