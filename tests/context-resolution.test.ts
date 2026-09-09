import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-context-resolution-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-context-resolution';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase } = await import('../src/db/index.js');
const { IMPORTANCE_MAX } = await import('../src/db/observations.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { context } = await import('../src/mcp/tools/context.js');
const { semanticSearch, generateEmbedding } = await import('../src/embeddings/embedder.js');
const { cosineSimilarity } = await import('../src/embeddings/similarity.js');

/**
 * `context` resolves a topic to an entity through exact -> LIKE -> semantic.
 * The semantic leg used to read `semanticResults[0]` — index 0 of a list ordered
 * by `similarity * recallBoost * importance` — and then gate that row on its RAW
 * cosine. Sorting by one quantity and gating on another applies the gate to
 * whichever row won on weighting, not to the best match.
 *
 * Reachable before D21 by demotion; D21's ceiling of 2.0 added the promotion
 * direction, which is the commoner shape now that `onboard` successfully writes
 * identity facts at 1.5-2.0.
 *
 * This file covers the hijack: every row clears the threshold, and the caller
 * gets a different entity's entire context back under `success: true` with
 * nothing marking the substitution. The more severe shape — a boosted row BELOW
 * the threshold turning a real match into "No entity found" — needs the two
 * high scorers here absent to reproduce, so it lives in
 * `context-resolution-threshold.test.ts`, which node runs in its own process.
 *
 * Similarity figures were measured with `generateEmbedding` + `cosineSimilarity`
 * rather than guessed, and are re-asserted at run time so a change in the
 * embedding model breaks this loudly instead of turning it into a coin flip.
 */

const TOPIC = 'what are the core identity facts about this person';
// ~0.6715 against TOPIC — the best match by raw cosine.
const STRONG_MATCH = 'Identity fact: core biographical detail about this person, load-bearing';
// ~0.4451 — genuinely less similar, but at 2x it scores ~0.890 and wins the sort.
const WEAKER_BUT_BOOSTED = 'Personal history and where this individual grew up';

const SEMANTIC_THRESHOLD = 0.2; // mirrors the constant in context.ts

before(async () => {
  initDatabase();
  await remember({
    content: WEAKER_BUT_BOOSTED,
    entity: 'ctx:boosted-weaker',
    importance: IMPORTANCE_MAX,
  });
  await remember({ content: STRONG_MATCH, entity: 'ctx:strong-match' });
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('context() resolves on raw similarity, not on the ranking score', () => {
  test('PRECONDITION: the boosted row is the less similar one, and boosting flips the sort', async () => {
    const q = await generateEmbedding(TOPIC);
    const strong = cosineSimilarity(q, await generateEmbedding(STRONG_MATCH));
    const weaker = cosineSimilarity(q, await generateEmbedding(WEAKER_BUT_BOOSTED));

    assert.ok(weaker < strong, 'the boosted row must be the LESS similar one, or this proves nothing');
    assert.ok(
      weaker * IMPORTANCE_MAX > strong,
      `boosting ${weaker.toFixed(4)} must beat ${strong.toFixed(4)} or the sort never flips`
    );
    assert.ok(strong >= SEMANTIC_THRESHOLD, 'the strong match must clear the threshold');
  });

  test('CONTROL: the boosted row does win the ranking, so index 0 is the wrong answer', async () => {
    // Exactly what the old code read. If this stops holding, the test below is
    // green because nothing is being displaced, not because anything is fixed.
    const results = await semanticSearch(TOPIC, { limit: 20 });
    assert.equal(
      results[0]?.entity_name,
      'ctx:boosted-weaker',
      'the boosted row no longer sorts first — the fixture stopped reproducing the hazard'
    );
  });

  test('a boosted, less-similar entity does not hijack resolution', async () => {
    const result = await context({ topic: TOPIC });
    assert.equal(result.success, true, result.message);
    assert.equal(
      result.entity?.name,
      'ctx:strong-match',
      'context resolved to the boosted entity instead of the best match'
    );
  });
});
