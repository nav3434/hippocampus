/**
 * D22, fourth defect — `context`'s semantic fallback read position [0] only.
 *
 * `semanticSearch` ranks by the boosted composite and `context` then checks the
 * RAW similarity of `[0]` against its own 0.2 floor. So a row whose cosine is
 * under the floor could hold [0] on its recall count alone, and the topic
 * resolved to "No entity found" while a qualifying entity sat at [1].
 *
 * The loss is total rather than partial: this is the last leg of
 * exact -> LIKE -> semantic, so the miss is the whole answer, and the message
 * states the opposite of the truth. Same shape as the `recall` half of D22 and
 * the same one-argument fix.
 *
 * Its own file, and so its own database: `context` takes no type filter, so a
 * boosted fixture row seeded by any other suite would compete for this topic.
 * Sharing one database is exactly how the first draft of this test resolved to
 * an entity belonging to a different suite.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unlinkSync, existsSync } from 'node:fs';

const DB_PATH = join(tmpdir(), `hippo-test-context-scoring-${Date.now()}.db`);

process.env.HIPPO_PASSPHRASE = 'test-passphrase-for-context-scoring';
process.env.HIPPO_DB_PATH = DB_PATH;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const { remember } = await import('../src/mcp/tools/remember.js');
const { context } = await import('../src/mcp/tools/context.js');
const { semanticSearch } = await import('../src/embeddings/embedder.js');

/** Mirrors the private constant in `context.ts`. */
const CONTEXT_THRESHOLD = 0.2;
const round3 = (n: number) => Math.round(n * 1000) / 1000;

// A topic that resolves neither exactly nor by LIKE, so the semantic leg runs.
const TOPIC = 'overwintering honeybee colonies in the apiary';
const GENUINE = 'The queen was marked with a dot of blue paint';
const DECOY = 'Equipment is stacked in the shed until spring returns';
// 100 is the recall count CLAUDE.md uses as its own worked example of the
// decay boost (~1.46x). Nothing here needs a contrived number.
const DECOY_RECALL_COUNT = 100;

before(async () => {
  initDatabase();
  await remember({ content: GENUINE, entity: 'apiary-genuine', type: 'note' });
  await remember({ content: DECOY, entity: 'apiary-decoy', type: 'note' });
  const row = getDatabase()
    .prepare('SELECT id FROM observations WHERE content = ?')
    .get(DECOY) as { id: string };
  getDatabase()
    .prepare('UPDATE observations SET recall_count = ? WHERE id = ?')
    .run(DECOY_RECALL_COUNT, row.id);
});

after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    const path = DB_PATH + suffix;
    if (existsSync(path)) unlinkSync(path);
  }
});

describe('context resolves a topic a boosted row was hiding (D22)', () => {
  test('POSITIVE CONTROL: unfloored, the below-floor decoy holds [0]', async () => {
    // The unfixed mechanism, still callable: rank the whole set, return the top
    // 5, let the caller check `[0]`. If the decoy does not take that position
    // the fixture never reaches the defect and the guard below proves nothing.
    const unfloored = await semanticSearch(TOPIC, { limit: 5 });
    assert.ok(unfloored.length > 0, 'the fixture should produce candidates');
    assert.ok(
      unfloored[0].similarity < CONTEXT_THRESHOLD,
      `[0] has raw similarity ${round3(unfloored[0].similarity)}, at or above the ` +
      `${CONTEXT_THRESHOLD} floor — the fixture does not reach the defect`
    );
    assert.ok(
      unfloored.some(r => r.similarity >= CONTEXT_THRESHOLD),
      'no qualifying row exists at all, so nothing was being hidden'
    );
  });

  test('the floored search puts a qualifying row at [0]', async () => {
    const floored = await semanticSearch(TOPIC, { limit: 5, minSimilarity: CONTEXT_THRESHOLD });
    assert.ok(floored.length > 0, 'the floor should not have emptied the result');
    assert.ok(floored[0].similarity >= CONTEXT_THRESHOLD);
    for (const r of floored) {
      assert.ok(r.similarity >= CONTEXT_THRESHOLD, `row under the floor came back: ${round3(r.similarity)}`);
    }
  });

  test('the topic resolves to the qualifying entity', async () => {
    const result = await context({ topic: TOPIC, depth: 1 });
    assert.equal(result.success, true, `context returned: ${result.message}`);
    // Assert the RETURNED name, not just the success flag — `context` resolves
    // topics fuzzily, so a success alone does not say which entity came back.
    assert.equal(result.entity?.name, 'apiary-genuine');
  });

  test('a topic with nothing above the floor still reports no entity', async () => {
    // The floor must not turn every miss into a match. This one has no
    // qualifying row, and the honest answer is still that nothing was found.
    const result = await context({ topic: 'hydraulic fracturing permit appeals in Alberta', depth: 1 });
    assert.equal(result.success, false);
    assert.match(result.message ?? '', /No entity found/);
  });
});
