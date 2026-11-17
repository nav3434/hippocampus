import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generatePersonalReflectionEmbedding } from '../src/embeddings/personal-reflection.js';
import { cosineSimilarity } from '../src/embeddings/similarity.js';

test('Personal Reflection produces normalized 384d vectors that rank a Russian paraphrase first', async () => {
  const query = await generatePersonalReflectionEmbedding('Как наладить сон и ложиться раньше?');
  const relevant = await generatePersonalReflectionEmbedding('Чтобы восстановить режим сна, я стал засыпать до полуночи.');
  const distractor = await generatePersonalReflectionEmbedding('На выходных я отремонтировал велосипед и заменил тормоза.');

  for (const vector of [query, relevant, distractor]) {
    assert.equal(vector.length, 384);
    assert.ok(vector.every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...vector) - 1) < 1e-5);
  }
  assert.ok(cosineSimilarity(query, relevant) > cosineSimilarity(query, distractor));
});
