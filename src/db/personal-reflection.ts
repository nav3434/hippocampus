import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3-multiple-ciphers';
import { config } from '../config.js';
import { getDatabase } from './index.js';
import { cosineSimilarity } from '../embeddings/similarity.js';

export const PERSONAL_REFLECTION_SCOPE = 'personal-reflection' as const;
const EMBEDDING_DIM = 384;
const MAX_RECORD_BYTES = 20_000;
const MAX_GENERATION_RECORDS = 5_000;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface PersonalReflectionRecord {
  scope: typeof PERSONAL_REFLECTION_SCOPE;
  canonical_id: string;
  canonical_version: number;
  content: string;
  payload_digest: string;
}

export class PersonalReflectionError extends Error {
  constructor(readonly code: 'unauthorized' | 'invalid_scope' | 'invalid_request' | 'conflict' | 'unavailable') {
    super(code);
    this.name = 'PersonalReflectionError';
  }
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function assertPersonalReflectionAccess(
  principalId: string,
  scope: string,
  consumer?: string,
  sensitivity?: string
): asserts scope is typeof PERSONAL_REFLECTION_SCOPE {
  if (scope !== PERSONAL_REFLECTION_SCOPE) throw new PersonalReflectionError('invalid_scope');
  if (!principalId || !config.personalReflectionPrincipals.includes(principalId)) {
    throw new PersonalReflectionError('unauthorized');
  }
  if ((consumer !== undefined && consumer !== 'personal-reflection') ||
      (sensitivity !== undefined && sensitivity !== 'private')) {
    throw new PersonalReflectionError('unauthorized');
  }
}

export function validatePersonalReflectionRecord(record: PersonalReflectionRecord): void {
  if (record.scope !== PERSONAL_REFLECTION_SCOPE || !UUID_V4.test(record.canonical_id) ||
      !Number.isSafeInteger(record.canonical_version) || record.canonical_version < 1 ||
      typeof record.content !== 'string' || !record.content.trim() ||
      Buffer.byteLength(record.content, 'utf8') > MAX_RECORD_BYTES || !SHA256_HEX.test(record.payload_digest) ||
      sha256Hex(Buffer.from(record.content, 'utf8')) !== record.payload_digest) {
    throw new PersonalReflectionError('invalid_request');
  }
}

function validateGeneration(generation: string): void {
  if (!UUID_V4.test(generation)) throw new PersonalReflectionError('invalid_request');
}

function validateOperationKey(value: string, expected: string): void {
  if (!SHA256_HEX.test(value) || value !== expected) throw new PersonalReflectionError('invalid_request');
}

function manifestDigest(records: Array<{ canonical_id: string; canonical_version: number; payload_digest: string }>): string {
  const identities = [...records]
    .sort((a, b) => a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 :
      a.canonical_version - b.canonical_version || a.payload_digest.localeCompare(b.payload_digest))
    .map((record) => [record.canonical_id, record.canonical_version, record.payload_digest]);
  return sha256Hex(JSON.stringify(identities));
}

function expectedUpsertKey(record: PersonalReflectionRecord, generation?: string): string {
  return sha256Hex(`personal-reflection:upsert:${generation ?? 'active'}:${record.canonical_id}:${record.canonical_version}:${record.payload_digest}`);
}

function expectedDeleteKey(canonicalId: string, version: number): string {
  return sha256Hex(`personal-reflection:delete:${canonicalId}:${version}`);
}

function validateVector(vector: Float32Array): Buffer {
  if (!(vector instanceof Float32Array) || vector.length !== EMBEDDING_DIM ||
      vector.some((value) => !Number.isFinite(value))) {
    throw new PersonalReflectionError('unavailable');
  }
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function activeGeneration(db: Database.Database): string | undefined {
  const row = db.prepare(`
    SELECT active_generation_id FROM personal_reflection_scope_state
    WHERE scope = ?
  `).get(PERSONAL_REFLECTION_SCOPE) as { active_generation_id: string | null } | undefined;
  if (!row?.active_generation_id) return undefined;
  const active = db.prepare(`
    SELECT generation_id FROM personal_reflection_generations
    WHERE generation_id = ? AND scope = ? AND status = 'active'
  `).get(row.active_generation_id, PERSONAL_REFLECTION_SCOPE) as { generation_id: string } | undefined;
  if (!active) throw new PersonalReflectionError('unavailable');
  return active.generation_id;
}

function ensureActiveGeneration(db: Database.Database): string {
  const existing = activeGeneration(db);
  if (existing) return existing;
  const generation = randomUUID();
  const digest = manifestDigest([]);
  db.prepare(`INSERT INTO personal_reflection_generations
    (generation_id, scope, status, record_count, manifest_digest)
    VALUES (?, ?, 'active', 0, ?)`)
    .run(generation, PERSONAL_REFLECTION_SCOPE, digest);
  db.prepare(`INSERT INTO personal_reflection_scope_state(scope, active_generation_id) VALUES (?, ?)
    ON CONFLICT(scope) DO UPDATE SET active_generation_id = excluded.active_generation_id`)
    .run(PERSONAL_REFLECTION_SCOPE, generation);
  return generation;
}

function readOperation<T>(
  db: Database.Database,
  principalId: string,
  operationKey: string,
  operation: 'upsert' | 'delete',
  canonicalId: string,
  version: number,
  digest: string,
  generation?: string
): T | undefined {
  const row = db.prepare(`SELECT operation, scope, canonical_id, canonical_version,
      payload_digest, generation_id, response_json
    FROM personal_reflection_operations WHERE principal_id = ? AND operation_key = ?`)
    .get(principalId, operationKey) as {
      operation: string; scope: string; canonical_id: string; canonical_version: number;
      payload_digest: string; generation_id: string | null; response_json: string;
    } | undefined;
  if (!row) return undefined;
  if (row.operation !== operation || row.scope !== PERSONAL_REFLECTION_SCOPE ||
      row.canonical_id !== canonicalId || row.canonical_version !== version ||
      row.payload_digest !== digest || (generation !== undefined && row.generation_id !== generation)) {
    throw new PersonalReflectionError('conflict');
  }
  return JSON.parse(row.response_json) as T;
}

function writeOperation(
  db: Database.Database,
  principalId: string,
  operationKey: string,
  operation: 'upsert' | 'delete',
  canonicalId: string,
  version: number,
  digest: string,
  generation: string,
  response: Record<string, unknown>
): void {
  db.prepare(`INSERT INTO personal_reflection_operations
    (principal_id, operation_key, operation, scope, canonical_id, canonical_version,
     payload_digest, generation_id, response_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(principalId, operationKey, operation, PERSONAL_REFLECTION_SCOPE, canonicalId,
      version, digest, generation, JSON.stringify(response));
}

export function personalReflectionScopeStatus(principalId: string, scope: string): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, scope);
  return {
    scope: PERSONAL_REFLECTION_SCOPE,
    contract_version: '1.0',
    pre_rank_scope_enforced: true,
    capability_filter_enforced: true,
    sensitivity_filter_enforced: true,
    cross_topic_requires_authorized_representation: true,
    unique_canonical_identity: true,
    idempotent_lifecycle: true,
    atomic_generation_swap: true,
  };
}

export function personalReflectionUpsert(
  principalId: string,
  record: PersonalReflectionRecord,
  operationKey: string,
  vector: Float32Array,
  generation?: string
): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, record?.scope ?? '');
  validatePersonalReflectionRecord(record);
  if (generation !== undefined) validateGeneration(generation);
  validateOperationKey(operationKey, expectedUpsertKey(record, generation));
  const vectorBlob = validateVector(vector);
  const db = getDatabase();

  return db.transaction(() => {
    const replay = readOperation<Record<string, unknown>>(db, principalId, operationKey, 'upsert',
      record.canonical_id, record.canonical_version, record.payload_digest, generation);
    if (replay) return replay;

    let targetGeneration: string;
    if (generation !== undefined) {
      const target = db.prepare(`SELECT generation_id FROM personal_reflection_generations
        WHERE generation_id = ? AND scope = ? AND status = 'inactive'`)
        .get(generation, PERSONAL_REFLECTION_SCOPE) as { generation_id: string } | undefined;
      if (!target) throw new PersonalReflectionError('conflict');
      targetGeneration = target.generation_id;
    } else {
      targetGeneration = ensureActiveGeneration(db);
    }

    const existing = db.prepare(`SELECT canonical_version, payload_digest FROM personal_reflection_records
      WHERE scope = ? AND generation_id = ? AND canonical_id = ?`)
      .get(PERSONAL_REFLECTION_SCOPE, targetGeneration, record.canonical_id) as {
        canonical_version: number; payload_digest: string;
      } | undefined;
    let status: 'created' | 'updated' | 'unchanged';
    if (existing) {
      if (record.canonical_version < existing.canonical_version ||
          (record.canonical_version === existing.canonical_version && record.payload_digest !== existing.payload_digest)) {
        throw new PersonalReflectionError('conflict');
      }
      if (record.canonical_version === existing.canonical_version) {
        status = 'unchanged';
      } else {
        status = 'updated';
      }
    } else {
      status = 'created';
    }

    if (status !== 'unchanged') {
      db.prepare(`INSERT INTO personal_reflection_records
        (scope, generation_id, canonical_id, canonical_version, content, payload_digest, sensitivity)
        VALUES (?, ?, ?, ?, ?, ?, 'private')
        ON CONFLICT(scope, generation_id, canonical_id) DO UPDATE SET
          canonical_version = excluded.canonical_version,
          content = excluded.content,
          payload_digest = excluded.payload_digest,
          sensitivity = 'private'`)
        .run(PERSONAL_REFLECTION_SCOPE, targetGeneration, record.canonical_id,
          record.canonical_version, record.content, record.payload_digest);
      db.prepare(`INSERT INTO personal_reflection_embeddings(scope, generation_id, canonical_id, vector)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(scope, generation_id, canonical_id) DO UPDATE SET vector = excluded.vector`)
        .run(PERSONAL_REFLECTION_SCOPE, targetGeneration, record.canonical_id, vectorBlob);
    }

    const response = {
      scope: PERSONAL_REFLECTION_SCOPE,
      canonical_id: record.canonical_id,
      canonical_version: record.canonical_version,
      payload_digest: record.payload_digest,
      status,
    };
    writeOperation(db, principalId, operationKey, 'upsert', record.canonical_id,
      record.canonical_version, record.payload_digest, targetGeneration, response);
    return response;
  }).immediate();
}

export function personalReflectionGet(
  principalId: string,
  scope: string,
  canonicalId: string
): { scope: typeof PERSONAL_REFLECTION_SCOPE; found: false } |
   { scope: typeof PERSONAL_REFLECTION_SCOPE; found: true; record: PersonalReflectionRecord } {
  assertPersonalReflectionAccess(principalId, scope);
  if (!UUID_V4.test(canonicalId)) throw new PersonalReflectionError('invalid_request');
  const db = getDatabase();
  const generation = activeGeneration(db);
  if (!generation) return { scope: PERSONAL_REFLECTION_SCOPE, found: false };
  const row = db.prepare(`SELECT scope, canonical_id, canonical_version, content, payload_digest
    FROM personal_reflection_records
    WHERE scope = ? AND generation_id = ? AND canonical_id = ? AND sensitivity = 'private'`)
    .get(PERSONAL_REFLECTION_SCOPE, generation, canonicalId) as PersonalReflectionRecord | undefined;
  return row ? { scope: PERSONAL_REFLECTION_SCOPE, found: true, record: row } :
    { scope: PERSONAL_REFLECTION_SCOPE, found: false };
}

export function personalReflectionDelete(
  principalId: string,
  scope: string,
  canonicalId: string,
  canonicalVersion: number,
  operationKey: string
): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, scope);
  if (!UUID_V4.test(canonicalId) || !Number.isSafeInteger(canonicalVersion) || canonicalVersion < 1) {
    throw new PersonalReflectionError('invalid_request');
  }
  validateOperationKey(operationKey, expectedDeleteKey(canonicalId, canonicalVersion));
  const requestDigest = sha256Hex(`delete:${canonicalId}:${canonicalVersion}`);
  const db = getDatabase();
  return db.transaction(() => {
    const replay = readOperation<Record<string, unknown>>(db, principalId, operationKey, 'delete',
      canonicalId, canonicalVersion, requestDigest);
    if (replay) return replay;
    const generation = activeGeneration(db);
    if (generation) {
      const existing = db.prepare(`SELECT canonical_version FROM personal_reflection_records
        WHERE scope = ? AND generation_id = ? AND canonical_id = ?`)
        .get(PERSONAL_REFLECTION_SCOPE, generation, canonicalId) as { canonical_version: number } | undefined;
      if (existing && existing.canonical_version > canonicalVersion) {
        throw new PersonalReflectionError('conflict');
      }
      if (existing) {
        db.prepare(`DELETE FROM personal_reflection_records
          WHERE scope = ? AND generation_id = ? AND canonical_id = ? AND canonical_version <= ?`)
          .run(PERSONAL_REFLECTION_SCOPE, generation, canonicalId, canonicalVersion);
      }
    }
    const response = {
      scope: PERSONAL_REFLECTION_SCOPE,
      canonical_id: canonicalId,
      canonical_version: canonicalVersion,
      deleted: true,
    };
    writeOperation(db, principalId, operationKey, 'delete', canonicalId,
      canonicalVersion, requestDigest, generation ?? '', response);
    return response;
  }).immediate();
}

export function personalReflectionRebuildBegin(
  principalId: string,
  scope: string,
  generation: string,
  recordCount: number,
  digest: string
): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, scope);
  validateGeneration(generation);
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > MAX_GENERATION_RECORDS || !SHA256_HEX.test(digest)) {
    throw new PersonalReflectionError('invalid_request');
  }
  const db = getDatabase();
  return db.transaction(() => {
    const existing = db.prepare(`SELECT scope, status, record_count, manifest_digest
      FROM personal_reflection_generations WHERE generation_id = ?`)
      .get(generation) as { scope: string; status: string; record_count: number; manifest_digest: string } | undefined;
    if (existing) {
      if (existing.scope !== PERSONAL_REFLECTION_SCOPE || existing.record_count !== recordCount || existing.manifest_digest !== digest ||
          !['inactive', 'active'].includes(existing.status)) throw new PersonalReflectionError('conflict');
      return { scope: PERSONAL_REFLECTION_SCOPE, generation, record_count: recordCount, manifest_digest: digest };
    }
    const building = db.prepare(`SELECT generation_id FROM personal_reflection_generations
      WHERE scope = ? AND status = 'inactive'`).get(PERSONAL_REFLECTION_SCOPE);
    if (building) throw new PersonalReflectionError('conflict');
    db.prepare(`INSERT INTO personal_reflection_generations
      (generation_id, scope, status, record_count, manifest_digest)
      VALUES (?, ?, 'inactive', ?, ?)`)
      .run(generation, PERSONAL_REFLECTION_SCOPE, recordCount, digest);
    return { scope: PERSONAL_REFLECTION_SCOPE, generation, record_count: recordCount, manifest_digest: digest };
  }).immediate();
}

export function personalReflectionRebuildActivate(
  principalId: string,
  scope: string,
  generation: string,
  recordCount: number,
  digest: string
): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, scope);
  validateGeneration(generation);
  if (!Number.isSafeInteger(recordCount) || recordCount < 0 || recordCount > MAX_GENERATION_RECORDS || !SHA256_HEX.test(digest)) {
    throw new PersonalReflectionError('invalid_request');
  }
  const db = getDatabase();
  return db.transaction(() => {
    const gen = db.prepare(`SELECT status, record_count, manifest_digest FROM personal_reflection_generations
      WHERE generation_id = ? AND scope = ?`)
      .get(generation, PERSONAL_REFLECTION_SCOPE) as { status: string; record_count: number; manifest_digest: string } | undefined;
    const active = activeGeneration(db);
    if (gen?.status === 'active' && active === generation && gen.record_count === recordCount && gen.manifest_digest === digest) {
      return { scope: PERSONAL_REFLECTION_SCOPE, generation, active: true, record_count: recordCount, manifest_digest: digest };
    }
    if (!gen || gen.status !== 'inactive' || gen.record_count !== recordCount || gen.manifest_digest !== digest) {
      throw new PersonalReflectionError('conflict');
    }
    const rows = db.prepare(`SELECT canonical_id, canonical_version, payload_digest
      FROM personal_reflection_records WHERE scope = ? AND generation_id = ? ORDER BY canonical_id`)
      .all(PERSONAL_REFLECTION_SCOPE, generation) as Array<{
        canonical_id: string; canonical_version: number; payload_digest: string;
      }>;
    if (rows.length !== recordCount || manifestDigest(rows) !== digest) throw new PersonalReflectionError('conflict');

    // The generation pointer switch, state labels, and deletion of the previous
    // generation are one SQLite transaction. Any failure rolls back to the old
    // searchable generation.
    const previous = active;
    if (previous) {
      db.prepare(`UPDATE personal_reflection_generations SET status = 'retired'
        WHERE generation_id = ? AND scope = ? AND status = 'active'`)
        .run(previous, PERSONAL_REFLECTION_SCOPE);
    }
    db.prepare(`UPDATE personal_reflection_generations SET status = 'active'
      WHERE generation_id = ? AND scope = ? AND status = 'inactive'`)
      .run(generation, PERSONAL_REFLECTION_SCOPE);
    db.prepare(`INSERT INTO personal_reflection_scope_state(scope, active_generation_id) VALUES (?, ?)
      ON CONFLICT(scope) DO UPDATE SET active_generation_id = excluded.active_generation_id`)
      .run(PERSONAL_REFLECTION_SCOPE, generation);
    if (previous) {
      db.prepare('DELETE FROM personal_reflection_generations WHERE generation_id = ?').run(previous);
    }
    return { scope: PERSONAL_REFLECTION_SCOPE, generation, active: true, record_count: recordCount, manifest_digest: digest };
  }).immediate();
}

export function personalReflectionRebuildAbort(
  principalId: string,
  scope: string,
  generation: string
): Record<string, unknown> {
  assertPersonalReflectionAccess(principalId, scope);
  validateGeneration(generation);
  const db = getDatabase();
  return db.transaction(() => {
    const row = db.prepare(`SELECT status FROM personal_reflection_generations
      WHERE generation_id = ? AND scope = ?`)
      .get(generation, PERSONAL_REFLECTION_SCOPE) as { status: string } | undefined;
    if (row?.status === 'active') throw new PersonalReflectionError('conflict');
    if (row?.status === 'inactive') {
      db.prepare(`DELETE FROM personal_reflection_generations
        WHERE generation_id = ? AND scope = ? AND status = 'inactive'`)
        .run(generation, PERSONAL_REFLECTION_SCOPE);
    }
    return { scope: PERSONAL_REFLECTION_SCOPE, generation, aborted: true };
  }).immediate();
}

export function personalReflectionRecall(
  principalId: string,
  scope: string,
  queryVector: Float32Array,
  limit: number,
  consumer: string,
  sensitivity: string,
  onPreRankCandidates?: (canonicalIds: readonly string[]) => void
): { scope: typeof PERSONAL_REFLECTION_SCOPE; degraded: false; matches: Array<{ canonical_id: string; canonical_version: number }> } {
  // All caller and principal capabilities are checked before selecting rows or
  // invoking cosine ranking. `consumer` is only a requested capability; the
  // authenticated principal allowlist above is what authorizes it.
  assertPersonalReflectionAccess(principalId, scope, consumer, sensitivity);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new PersonalReflectionError('invalid_request');
  validateVector(queryVector);
  const db = getDatabase();
  const generation = activeGeneration(db);
  if (!generation) return { scope: PERSONAL_REFLECTION_SCOPE, degraded: false, matches: [] };

  // Namespace + active generation + capability-controlled sensitivity are in
  // SQL before any vector is loaded, candidate object is constructed, cosine is
  // computed, ranking occurs, or limit is applied. No global recall path runs.
  const candidates = db.prepare(`SELECT r.canonical_id, r.canonical_version, e.vector
    FROM personal_reflection_records r
    JOIN personal_reflection_embeddings e
      ON e.scope = r.scope AND e.generation_id = r.generation_id AND e.canonical_id = r.canonical_id
    JOIN personal_reflection_generations g
      ON g.generation_id = r.generation_id AND g.scope = r.scope
    JOIN personal_reflection_scope_state s
      ON s.scope = r.scope AND s.active_generation_id = g.generation_id
    WHERE r.scope = ? AND r.generation_id = ? AND g.status = 'active' AND r.sensitivity = ?`)
    .all(PERSONAL_REFLECTION_SCOPE, generation, 'private') as Array<{
      canonical_id: string; canonical_version: number; vector: Buffer;
    }>;

  // Acceptance instrumentation observes opaque IDs before vector validation,
  // cosine scoring, sorting, or truncation. Normal callers omit the callback.
  onPreRankCandidates?.(candidates.map((row) => row.canonical_id));

  const ranked = candidates.map((row) => {
    if (row.vector.byteLength !== EMBEDDING_DIM * Float32Array.BYTES_PER_ELEMENT) {
      throw new PersonalReflectionError('unavailable');
    }
    const vector = new Float32Array(row.vector.buffer, row.vector.byteOffset, EMBEDDING_DIM);
    return {
      canonical_id: row.canonical_id,
      canonical_version: row.canonical_version,
      similarity: cosineSimilarity(queryVector, vector),
    };
  });
  ranked.sort((a, b) => b.similarity - a.similarity);
  return {
    scope: PERSONAL_REFLECTION_SCOPE,
    degraded: false,
    matches: ranked.slice(0, limit).map(({ canonical_id, canonical_version }) => ({ canonical_id, canonical_version })),
  };
}
