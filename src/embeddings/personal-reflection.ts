import type { FeatureExtractionPipeline } from '@huggingface/transformers';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const REVISION = '2c4055b12046f11709e9df2c122e59ffbdc2f900';

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
