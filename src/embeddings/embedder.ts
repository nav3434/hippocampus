import { randomUUID } from 'crypto';
import { getDatabase } from '../db/index.js';
import { assertStoredSinceBound } from '../db/timestamps.js';
import { cosineSimilarity } from './similarity.js';

const EMBEDDING_DIM = 384;

// Lazy-loaded pipeline
let pipelineInstance: any = null;

async function getPipeline() {
  if (!pipelineInstance) {
    const { pipeline } = await import('@huggingface/transformers');
    // dtype: 'q8' is load-bearing, not a perf tweak. The previous
    // @xenova/transformers@2 stack defaulted to the *quantized* (q8) model;
    // @huggingface/transformers defaults to fp32. Stored vectors in the prod DB
    // were written by the q8 model, and recall compares new query vectors
    // against them by cosine similarity — so we must keep emitting q8 vectors
    // (cosine ≈ 1.0 vs the old stack; fp32 would drift to ~0.99 and silently
    // degrade recall). cache_dir wiring (TRANSFORMERS_CACHE → /data/.models in
    // Docker) is unchanged.
    pipelineInstance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
      dtype: 'q8',
      cache_dir: process.env.TRANSFORMERS_CACHE || undefined,
    });
  }
  return pipelineInstance;
}

export async function generateEmbedding(text: string): Promise<Float32Array> {
  const extractor = await getPipeline();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

export interface StoredEmbedding {
  id: string;
  entity_id: string;
  observation_id: string;
  vector: Buffer;
  text_content: string;
  created_at: string;
}

export function storeEmbedding(
  entityId: string,
  observationId: string,
  vector: Float32Array,
  textContent: string
): string {
  const db = getDatabase();
  const id = randomUUID();
  const vectorBlob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);

  db.prepare(`
    INSERT INTO embeddings (id, entity_id, observation_id, vector, text_content)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, entityId, observationId, vectorBlob, textContent);

  return id;
}

export interface StoredVector {
  observation_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string | null;
  content: string;
  source: string | null;
  kind: string | null;
  created_at: string;
  recall_count: number;
  importance: number;
  vector: Float32Array;
}

export function getEmbeddingsByEntity(entityId?: string): StoredVector[] {
  const db = getDatabase();

  let sql = `
    SELECT emb.observation_id, emb.entity_id, emb.vector,
      o.content, o.source, o.kind, o.created_at,
      o.recall_count, o.importance,
      e.name as entity_name, e.type as entity_type
    FROM embeddings emb
    JOIN observations o ON emb.observation_id = o.id
    JOIN entities e ON emb.entity_id = e.id
  `;

  const params: string[] = [];
  if (entityId) {
    sql += ' WHERE emb.entity_id = ?';
    params.push(entityId);
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    observation_id: string;
    entity_id: string;
    vector: Buffer;
    content: string;
    source: string | null;
    kind: string | null;
    created_at: string;
    recall_count: number;
    importance: number;
    entity_name: string;
    entity_type: string | null;
  }>;

  return rows.map(row => ({
    observation_id: row.observation_id,
    entity_id: row.entity_id,
    entity_name: row.entity_name,
    entity_type: row.entity_type,
    content: row.content,
    source: row.source,
    kind: row.kind,
    created_at: row.created_at,
    recall_count: row.recall_count ?? 0,
    importance: row.importance ?? 1.0,
    vector: new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      EMBEDDING_DIM
    ),
  }));
}

/**
 * Decay-weighted scoring: `similarity * recallBoost * importance`, where
 * `recallBoost = 1 + RECALL_BOOST_ALPHA * ln(1 + recall_count)`. A gentle nudge
 * — similarity stays the dominant signal.
 *
 * Exported because `recall`'s spreading-activation path computes the same boost
 * for rows this function never sees, and then merges the two sets into one
 * ordering. That merge is only meaningful if both sides use this constant, and
 * a private copy in each module is a silent drift waiting to happen (there was
 * one, `SPREAD_ALPHA`, until D22).
 */
export const RECALL_BOOST_ALPHA = 0.1;

export interface SemanticSearchResult {
  observation_id: string;
  entity_id: string;
  entity_name: string;
  entity_type: string | null;
  content: string;
  source: string | null;
  kind: string | null;
  created_at: string;
  /**
   * RAW cosine between the query vector and the stored vector. Bounded by
   * [-1, 1] and comparable across rows, which is what makes it the only thing
   * safe to report to a caller. It is deliberately NOT what this function
   * ranks by — see `rank_score`.
   */
  similarity: number;
  /**
   * The decay-weighted composite this function sorts by:
   * `similarity * recallBoost * importance`. UNBOUNDED above — `recallBoost` is
   * `1 + RECALL_BOOST_ALPHA * ln(1 + recall_count)` with no cap — so it can
   * exceed 1 and is meaningless as a "similarity". It exists so a caller that
   * MERGES these rows with rows scored
   * some other way (recall's spreading-activation path) can re-sort the merged
   * set on the same scale the search itself used. Anything that reaches a
   * caller's caller should carry `similarity`, never this.
   */
  rank_score: number;
}

export interface SemanticSearchOptions {
  limit?: number;
  type?: string;
  /**
   * Lower bound on RAW cosine similarity, applied BEFORE the sort-and-slice.
   *
   * Without it, a caller that slices to `limit` here and then applies its own
   * raw-similarity floor gets fewer rows than it asked for, silently: this
   * function ranks by `rank_score`, so a row whose raw cosine is under the
   * caller's floor can still out-rank a qualifying one, occupy a slot, and
   * then be dropped by the caller. The slot is not given back. Filtering here
   * is exact rather than a guessed over-fetch factor, and it is free — every
   * row is already loaded and scored in memory before the slice, so the floor
   * costs one comparison per row and nothing else.
   *
   * Omit it to rank the whole set (the pre-existing behaviour).
   */
  minSimilarity?: number;
  /**
   * Lower bound on `created_at`, **already normalized** to the stored UTC form
   * `YYYY-MM-DD HH:MM:SS` — the comparison below is lexicographic, so any other
   * spelling silently matches nothing (an ISO `T` sorts above every stored
   * row). Callers normalize via `normalizeSinceBound`. That precondition is
   * asserted, not merely documented: a violation throws rather than returning
   * the empty set (D15).
   */
  since?: string;
  kind?: string;
  /**
   * What to sort by before the `limit` slice.
   *
   * `'score'` (default) is the decay-weighted ranking —
   * `similarity * recallBoost * importance` — which is what a relevance query
   * wants. `'similarity'` is the raw cosine, for callers asking the different
   * question "which row is the closest match", where weighting is noise.
   *
   * The distinction is load-bearing because the slice happens BEFORE the
   * caller sees anything: a caller that re-picks by raw similarity from a
   * score-ordered slice is still choosing from a window that weighting
   * selected, so the raw-best row can have been dropped before it ever
   * arrives. `context`'s entity resolution is that caller (D21).
   */
  orderBy?: 'score' | 'similarity';
}

export async function semanticSearch(
  query: string,
  options?: SemanticSearchOptions
): Promise<SemanticSearchResult[]> {
  const queryVector = await generateEmbedding(query);
  return semanticSearchWithVector(queryVector, options);
}

export function semanticSearchWithVector(
  queryVector: Float32Array,
  options?: SemanticSearchOptions
): SemanticSearchResult[] {
  assertStoredSinceBound(options?.since, 'semanticSearchWithVector');

  const limit = options?.limit ?? 10;

  const db = getDatabase();

  // Build query with optional filters
  // Pull recall_count + importance for decay-weighted scoring
  let sql = `
    SELECT emb.observation_id, emb.entity_id, emb.vector,
      o.content, o.source, o.kind, o.created_at,
      o.recall_count, o.importance,
      e.name as entity_name, e.type as entity_type
    FROM embeddings emb
    JOIN observations o ON emb.observation_id = o.id
    JOIN entities e ON emb.entity_id = e.id
  `;

  const conditions: string[] = [];
  const params: string[] = [];

  if (options?.type) {
    conditions.push('e.type = ?');
    params.push(options.type);
  }
  if (options?.since) {
    conditions.push('o.created_at >= ?');
    params.push(options.since);
  }
  if (options?.kind) {
    conditions.push('o.kind = ?');
    params.push(options.kind);
  }

  if (conditions.length > 0) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }

  const rows = db.prepare(sql).all(...params) as Array<{
    observation_id: string;
    entity_id: string;
    vector: Buffer;
    content: string;
    source: string | null;
    kind: string | null;
    created_at: string;
    recall_count: number;
    importance: number;
    entity_name: string;
    entity_type: string | null;
  }>;

  const scored = rows.map(row => {
    const storedVector = new Float32Array(
      row.vector.buffer,
      row.vector.byteOffset,
      EMBEDDING_DIM
    );
    const similarity = cosineSimilarity(queryVector, storedVector);
    const recallBoost = 1 + RECALL_BOOST_ALPHA * Math.log(1 + (row.recall_count ?? 0));
    const importance = row.importance ?? 1.0;
    const rank_score = similarity * recallBoost * importance;
    return {
      observation_id: row.observation_id,
      entity_id: row.entity_id,
      entity_name: row.entity_name,
      entity_type: row.entity_type,
      content: row.content,
      source: row.source,
      kind: row.kind,
      created_at: row.created_at,
      similarity, // raw cosine, for display and for `minSimilarity`
      rank_score, // boosted composite, for ranking only — see the interface
    };
  });

  // `minSimilarity` and `orderBy` are the two independent halves of one fact:
  // THE SLICE IS FINAL. The floor decides which rows are allowed to compete for
  // a slot; `orderBy` decides which key they compete on. Get either wrong and
  // the row the caller wanted is gone before it ever sees the array — filtering
  // after the slice loses rows that a boost promoted past the cut (D22), and
  // re-picking the raw maximum out of a score-ordered slice re-picks from a
  // window that weighting already chose (D21). Both keys are computed for every
  // row either way, so neither costs anything but the comparison.
  const floor = options?.minSimilarity;
  if (floor !== undefined && !(Number.isFinite(floor) && floor >= -1 && floor <= 1)) {
    // Refused as a caller error rather than honoured, in BOTH directions and
    // for the same reason the range is checked at all: a cosine cannot leave
    // [-1, 1], so a floor outside it cannot be what anyone meant. The two
    // directions fail differently and only one is loud — a floor above 1 (or
    // NaN) drops every row and returns an empty set with no error, which is
    // indistinguishable from an empty database and is the exact failure `since`
    // is asserted against two fields up (D13/D15); a floor below -1 merely
    // filters nothing. Refusing both keeps the rule statable in one line
    // instead of leaving the harmless half to look deliberate. The value is
    // safe to name: it is a caller-supplied number, never memory content.
    throw new Error(
      `semanticSearchWithVector: minSimilarity must be a finite number in [-1, 1], got ${String(floor)}`
    );
  }
  const eligible = floor === undefined ? scored : scored.filter(r => r.similarity >= floor);

  eligible.sort((a, b) =>
    options?.orderBy === 'similarity' ? b.similarity - a.similarity : b.rank_score - a.rank_score
  );
  return eligible.slice(0, limit);
}

export function deleteEmbedding(observationId: string): boolean {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM embeddings WHERE observation_id = ?').run(observationId);
  return result.changes > 0;
}

export function deleteEmbeddingsByEntity(entityId: string): number {
  const db = getDatabase();
  const result = db.prepare('DELETE FROM embeddings WHERE entity_id = ?').run(entityId);
  return result.changes;
}

export function moveEmbeddingsToEntity(fromEntityId: string, toEntityId: string): number {
  const db = getDatabase();
  const result = db.prepare(
    'UPDATE embeddings SET entity_id = ? WHERE entity_id = ?'
  ).run(toEntityId, fromEntityId);
  return result.changes;
}

export async function backfillEmbeddings(): Promise<number> {
  const db = getDatabase();

  const missing = db.prepare(`
    SELECT o.id, o.entity_id, o.content
    FROM observations o
    LEFT JOIN embeddings emb ON o.id = emb.observation_id
    WHERE emb.id IS NULL
  `).all() as Array<{ id: string; entity_id: string; content: string }>;

  if (missing.length === 0) return 0;

  console.log(`Backfilling embeddings for ${missing.length} observations...`);

  let count = 0;
  for (const obs of missing) {
    const vector = await generateEmbedding(obs.content);
    storeEmbedding(obs.entity_id, obs.id, vector, obs.content);
    count++;
  }

  console.log(`Backfilled ${count} embeddings.`);
  return count;
}
