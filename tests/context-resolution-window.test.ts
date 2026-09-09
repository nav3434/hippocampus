import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-context-window-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-context-window';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { IMPORTANCE_MAX } = await import('../src/db/observations.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { context } = await import('../src/mcp/tools/context.js');
const { semanticSearch } = await import('../src/embeddings/embedder.js');

/**
 * The residual the first version of the `context` fix left open, and the reason
 * `orderBy` lives in the search rather than a re-pick in the caller.
 *
 * That version took the raw-similarity maximum out of the array `semanticSearch`
 * returned. But the `limit` slice happens INSIDE the search, ordered by
 * `similarity * recallBoost * importance`, and it is final — so the re-pick was
 * still choosing from a window that weighting had selected. Enough boosted rows
 * and the genuine match is dropped before the caller ever sees it. Every test
 * written for that version passed, because they all used two rows.
 *
 * The population is not hypothetical: D21 exists so `onboard` can write identity
 * facts at 1.5-2.0, and it writes them to one entity. Thirty of those on
 * `karolina` is an ordinary store, not a pathological one.
 *
 * Fixture: 30 boosted rows that are all weak matches, plus one neutral row that
 * is the only strong match. By score the strong match sorts last; by raw
 * similarity it sorts first.
 */

const TOPIC = 'what are the core identity facts about this person';
// ~0.6715 against TOPIC — the raw-best row, stored at neutral importance so it
// scores 0.6715 and sorts BELOW every decoy.
const STRONG_MATCH = 'Identity fact: core biographical detail about this person, load-bearing';
// ~0.4451 raw, so ~0.890 boosted — genuinely the weaker match, and still ahead
// of the strong one once weighting is applied. Identical text across all the
// decoy entities on purpose: dedup-on-write is per-entity, so they all survive,
// and equal similarity keeps the fixture's arithmetic exact.
const WEAK_DECOY = 'Personal history and where this individual grew up';

const DECOY_COUNT = 30;
const SEMANTIC_THRESHOLD = 0.2; // mirrors the constant in context.ts

before(async () => {
  initDatabase();
  // Seeded first so the strong match cannot win on insertion order.
  for (let i = 0; i < DECOY_COUNT; i++) {
    await remember({
      content: WEAK_DECOY,
      entity: `win:boosted-${i}`,
      importance: IMPORTANCE_MAX,
    });
  }
  await remember({ content: STRONG_MATCH, entity: 'win:strong-match' });
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('context() sees the raw-best match even when boosted rows fill the window', () => {
  test('CONTROL: by score the strong match is pushed outside any reasonable slice', async () => {
    // This is the whole hazard. If the boosted rows stop outscoring the strong
    // match, the test below passes because nothing is being displaced.
    const byScore = await semanticSearch(TOPIC, { limit: DECOY_COUNT + 1 });
    const rank = byScore.findIndex(r => r.entity_name === 'win:strong-match');
    assert.ok(rank >= 0, 'the strong match should be somewhere in a full listing');
    assert.ok(
      rank > 20,
      `the strong match ranks ${rank} by score — it must fall outside a 20-row window for this to prove anything`
    );
  });

  test('CONTROL: the strong match is nonetheless the best raw match, and clears the gate', async () => {
    const bySimilarity = await semanticSearch(TOPIC, { limit: 5, orderBy: 'similarity' });
    assert.equal(
      bySimilarity[0]?.entity_name,
      'win:strong-match',
      'the fixture no longer makes the strong match the raw-best row'
    );
    assert.ok(bySimilarity[0].similarity >= SEMANTIC_THRESHOLD, 'the strong match must clear the threshold');
  });

  test('context resolves to the strong match, not to a boosted decoy or to absence', async () => {
    const result = await context({ topic: TOPIC });
    assert.equal(result.success, true, `context reported absence: ${result.message}`);
    assert.equal(
      result.entity?.name,
      'win:strong-match',
      'context resolved from a weighted window rather than from the raw ordering'
    );
  });
});
