import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-context-threshold-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-context-threshold';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { IMPORTANCE_MAX } = await import('../src/db/observations.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { context } = await import('../src/mcp/tools/context.js');
const { semanticSearch, generateEmbedding } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

/**
 * The severe half of the `context` resolution bug, in its own file because it
 * only reproduces when no strongly-matching row is present — any row above the
 * boosted decoy's score resolves first and hides it. Node gives each test file
 * its own process, so this database holds exactly the two fixtures.
 *
 * Shape: a boosted row whose own cosine is BELOW context's 0.2 gate still wins
 * the ranking (0.1774 x 2 = 0.355). The old code took index 0, tested that row's
 * raw cosine, failed, and returned `success: false, "No entity found for topic"`
 * — while an admissible match sat one row down at 0.2801. A read path reporting
 * absence while the thing is present is this repo's recurring injury (D13's
 * empty `since` result, D16's degraded-empty `recall`), and it is the reason the
 * D16 comment sitting directly above this code in `context.ts` exists.
 */

const TOPIC = 'what are the core identity facts about this person';
// ~0.1774 — BELOW the 0.2 gate, so it can never be a valid answer. Boosted it
// scores ~0.355 and takes index 0 anyway.
const BELOW_THRESHOLD_BOOSTED = 'They grew up somewhere cold';
// ~0.2801 — clears the gate, and scores below the boosted decoy.
const ADMISSIBLE_MATCH = 'Facts and figures from the quarterly report';

const SEMANTIC_THRESHOLD = 0.2; // mirrors the constant in context.ts

before(async () => {
  initDatabase();
  await remember({
    content: BELOW_THRESHOLD_BOOSTED,
    entity: 'ctx:boosted-decoy',
    importance: IMPORTANCE_MAX,
  });
  await remember({ content: ADMISSIBLE_MATCH, entity: 'ctx:admissible' });
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('a sub-threshold boosted row does not turn a real match into "No entity found"', () => {
  test('PRECONDITION: the decoy fails the gate but outscores the admissible match', async () => {
    const q = await generateEmbedding(TOPIC);
    const decoy = cosineSimilarity(q, await generateEmbedding(BELOW_THRESHOLD_BOOSTED));
    const admissible = cosineSimilarity(q, await generateEmbedding(ADMISSIBLE_MATCH));

    assert.ok(
      decoy < SEMANTIC_THRESHOLD,
      `the decoy (${decoy.toFixed(4)}) must fail the ${SEMANTIC_THRESHOLD} gate — that is what made this a false negative`
    );
    assert.ok(
      admissible >= SEMANTIC_THRESHOLD,
      `the admissible match (${admissible.toFixed(4)}) must clear the gate`
    );
    assert.ok(
      decoy * IMPORTANCE_MAX > admissible,
      `boosting ${decoy.toFixed(4)} must outscore ${admissible.toFixed(4)} or the decoy never reaches index 0`
    );
  });

  test('CONTROL: index 0 is the decoy, and its own similarity fails the gate', async () => {
    const results = await semanticSearch(TOPIC, { limit: 20 });
    assert.equal(
      results[0]?.entity_name,
      'ctx:boosted-decoy',
      'the decoy no longer sorts first — the fixture stopped reproducing the false negative'
    );
    assert.ok(
      results[0].similarity < SEMANTIC_THRESHOLD,
      'index 0 must be a row whose own cosine fails the gate, or nothing is being suppressed'
    );
  });

  test('context finds the admissible match instead of reporting absence', async () => {
    const result = await context({ topic: TOPIC });
    assert.equal(result.success, true, `context reported absence: ${result.message}`);
    assert.equal(
      result.entity?.name,
      'ctx:admissible',
      'context resolved to something other than the only row above its threshold'
    );
  });
});
