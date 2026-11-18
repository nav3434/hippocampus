import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  generatePersonalReflectionEmbedding,
  generatePersonalReflectionRecordEmbedding,
  splitPersonalReflectionRecord,
} from '../src/embeddings/personal-reflection.js';
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

test('Personal Reflection record representation uses overlapping 32-word chunks with stride 16', () => {
  const words = Array.from({ length: 48 }, (_, index) => `w${index + 1}`);
  const chunks = splitPersonalReflectionRecord(words.join(' '));

  assert.equal(chunks.length, 2);
  assert.equal(chunks[0], words.slice(0, 32).join(' '));
  assert.equal(chunks[1], words.slice(16, 48).join(' '));
  assert.deepEqual(splitPersonalReflectionRecord('  one   two three  '), ['one two three']);
});

test('Personal Reflection record embedding is the normalized mean of chunk embeddings', async () => {
  const words = Array.from({ length: 48 }, (_, index) => `слово${index + 1}`);
  const text = words.join(' ');
  const chunks = splitPersonalReflectionRecord(text);
  const chunkVectors = [];
  for (const chunk of chunks) chunkVectors.push(await generatePersonalReflectionEmbedding(chunk));

  const expected = new Float32Array(chunkVectors[0].length);
  for (const vector of chunkVectors) {
    for (let index = 0; index < expected.length; index += 1) expected[index] += vector[index];
  }
  let squaredNorm = 0;
  for (const value of expected) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  for (let index = 0; index < expected.length; index += 1) expected[index] /= norm;

  const actual = await generatePersonalReflectionRecordEmbedding(text);
  assert.equal(actual.length, 384);
  assert.ok(actual.every(Number.isFinite));
  assert.ok(Math.abs(Math.hypot(...actual) - 1) < 1e-5);

  let maxDelta = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(actual[index] - expected[index]));
  }
  assert.ok(maxDelta < 1e-7);
});


test('Personal Reflection record embedding preserves the single-vector path for short records', async () => {
  const text = '  Короткая запись должна использовать один нормализованный вектор без чанкинга.  ';
  const expected = await generatePersonalReflectionEmbedding(text.trim());
  const actual = await generatePersonalReflectionRecordEmbedding(text);

  assert.equal(actual.length, expected.length);
  let maxDelta = 0;
  for (let index = 0; index < actual.length; index += 1) {
    maxDelta = Math.max(maxDelta, Math.abs(actual[index] - expected[index]));
  }
  assert.ok(maxDelta < 1e-7);
});
