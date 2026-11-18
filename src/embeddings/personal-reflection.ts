import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';
const RECORD_CHUNK_WORDS = 32;
const RECORD_CHUNK_STRIDE = 16;

let pipelinePromise: Promise<FeatureExtractionPipeline> | undefined;

async function loadPipeline() {
  const { pipeline } = await import('@huggingface/transformers');
  return pipeline('feature-extraction', MODEL, {
    revision: REVISION,
    dtype: 'q8',
    cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
  });
}

export async function generatePersonalReflectionEmbedding(text: string): Promise<Float32Array> {
  pipelinePromise ??= loadPipeline().catch((error: unknown) => {
    pipelinePromise = undefined;
    throw error;
  });
  const extractor = await pipelinePromise;
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export function splitPersonalReflectionRecord(text: string): string[] {
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/u).filter(Boolean);
  if (words.length <= RECORD_CHUNK_WORDS) return [trimmed];

  const chunks: string[] = [];
  for (let start = 0; start < words.length; start += RECORD_CHUNK_STRIDE) {
    const chunk = words.slice(start, start + RECORD_CHUNK_WORDS);
    if (chunk.length < 8 && chunks.length) break;
    chunks.push(chunk.join(' '));
    if (start + RECORD_CHUNK_WORDS >= words.length) break;
  }
  return [...new Set(chunks)];
}

function normalizedMean(vectors: readonly Float32Array[]): Float32Array {
  if (!vectors.length) throw new Error('personal reflection embedding unavailable');
  const result = new Float32Array(vectors[0].length);
  for (const vector of vectors) {
    if (vector.length !== result.length) throw new Error('personal reflection embedding unavailable');
    for (let index = 0; index < result.length; index += 1) result[index] += vector[index];
  }
  let squaredNorm = 0;
  for (const value of result) squaredNorm += value * value;
  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) throw new Error('personal reflection embedding unavailable');
  for (let index = 0; index < result.length; index += 1) result[index] /= norm;
  return result;
}

export async function generatePersonalReflectionRecordEmbedding(text: string): Promise<Float32Array> {
  const chunks = splitPersonalReflectionRecord(text);
  const vectors: Float32Array[] = [];
  for (const chunk of chunks) vectors.push(await generatePersonalReflectionEmbedding(chunk));
  return normalizedMean(vectors);
}
