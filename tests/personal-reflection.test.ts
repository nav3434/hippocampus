import { createHash, randomUUID } from 'node:crypto';
import { unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';

const DB_PATH = join(tmpdir(), `hippo-personal-reflection-${Date.now()}.db`);
const AGENT_TOKEN = 'p'.repeat(64);
const PRINCIPAL = `agent:${createHash('sha256').update(AGENT_TOKEN).digest('hex')}`;
process.env.HIPPO_PASSPHRASE = 'synthetic-personal-reflection-test-passphrase';
process.env.HIPPO_DB_PATH = DB_PATH;
process.env.HIPPO_AGENT_TOKEN = AGENT_TOKEN;
process.env.HIPPO_PERSONAL_REFLECTION_PRINCIPALS = PRINCIPAL;

const { initDatabase, closeDatabase, getDatabase } = await import('../src/db/index.js');
const pr = await import('../src/db/personal-reflection.js');
const { semanticSearchWithVector } = await import('../src/embeddings/embedder.js');

before(() => initDatabase());
after(() => {
  closeDatabase();
  for (const suffix of ['', '-wal', '-shm']) {
    try { unlinkSync(DB_PATH + suffix); } catch { /* absent */ }
  }
});

function record(content: string, id = randomUUID(), version = 1) {
  return {
    scope: 'personal-reflection' as const,
    canonical_id: id,
    canonical_version: version,
    content,
    payload_digest: pr.sha256Hex(Buffer.from(content, 'utf8')),
  };
}

function operationKey(r: ReturnType<typeof record>, generation?: string) {
  return pr.sha256Hex(`personal-reflection:upsert:${generation ?? 'active'}:${r.canonical_id}:${r.canonical_version}:${r.payload_digest}`);
}

function vector(index: number): Float32Array {
  const value = new Float32Array(384);
  value[index] = 1;
  return value;
}

function manifest(records: ReturnType<typeof record>[]) {
  const identities = records
    .map((r) => [r.canonical_id, r.canonical_version, r.payload_digest] as const)
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1] || a[2].localeCompare(b[2]));
  return pr.sha256Hex(JSON.stringify(identities));
}

function upsert(r: ReturnType<typeof record>, v = vector(0), generation?: string) {
  return pr.personalReflectionUpsert(PRINCIPAL, r, operationKey(r, generation), v, generation);
}

function assertCode(code: string, fn: () => unknown) {
  assert.throws(fn, (error: unknown) => error instanceof pr.PersonalReflectionError && error.code === code);
}

describe('Personal Reflection scoped retrieval contract v1.0', () => {
  test('reports the exact content-free contract capability status', () => {
    assert.deepEqual(pr.personalReflectionScopeStatus(PRINCIPAL, 'personal-reflection'), {
      scope: 'personal-reflection', contract_version: '1.0', pre_rank_scope_enforced: true,
      capability_filter_enforced: true, sensitivity_filter_enforced: true,
      cross_topic_requires_authorized_representation: true, unique_canonical_identity: true,
      idempotent_lifecycle: true, atomic_generation_swap: true,
    });
  });

  test('rejects unauthorized principal, wrong scope, consumer, and sensitivity before search', () => {
    assertCode('unauthorized', () => pr.personalReflectionScopeStatus('agent:unauthorized', 'personal-reflection'));
    assertCode('invalid_scope', () => pr.personalReflectionRecall(PRINCIPAL, 'other', vector(0), 5, 'personal-reflection', 'private'));
    assertCode('unauthorized', () => pr.personalReflectionRecall(PRINCIPAL, 'personal-reflection', vector(0), 5, 'other-consumer', 'private'));
    assertCode('unauthorized', () => pr.personalReflectionRecall(PRINCIPAL, 'personal-reflection', vector(0), 5, 'personal-reflection', 'restricted'));
  });

  test('rejects malformed identity, digest, operation key, vector, and limits', () => {
    const malformed = { ...record('synthetic'), canonical_id: 'not-a-uuid' };
    assertCode('invalid_request', () => upsert(malformed));
    const wrongDigest = { ...record('synthetic'), payload_digest: '0'.repeat(64) };
    assertCode('invalid_request', () => upsert(wrongDigest));
    const oversizedUtf8 = record('é'.repeat(10_001));
    assertCode('invalid_request', () => upsert(oversizedUtf8));
    const r = record('synthetic');
    assertCode('invalid_request', () => pr.personalReflectionUpsert(PRINCIPAL, r, '0'.repeat(64), vector(0)));
    assertCode('unavailable', () => pr.personalReflectionRecall(PRINCIPAL, 'personal-reflection', new Float32Array(2), 5, 'personal-reflection', 'private'));
    assertCode('invalid_request', () => pr.personalReflectionRecall(PRINCIPAL, 'personal-reflection', vector(0), 51, 'personal-reflection', 'private'));
  });

  test('keeps scoped candidates separate before semantic ranking and limit', () => {
    const id = randomUUID();
    const scoped = record('synthetic scoped statement', id);
    upsert(scoped, vector(1));

    const db = getDatabase();
    const entityId = randomUUID();
    const observationId = randomUUID();
    db.prepare('INSERT INTO entities(id, name, type) VALUES (?, ?, ?)').run(entityId, `synthetic-global-${entityId}`, 'test');
    db.prepare('INSERT INTO observations(id, entity_id, content) VALUES (?, ?, ?)').run(observationId, entityId, 'synthetic global candidate');
    db.prepare('INSERT INTO embeddings(id, entity_id, observation_id, vector, text_content) VALUES (?, ?, ?, ?, ?)')
      .run(randomUUID(), entityId, observationId, Buffer.from(vector(0).buffer), 'synthetic global candidate');

    let scopedCandidates: readonly string[] = [];
    const recall = pr.personalReflectionRecall(PRINCIPAL, 'personal-reflection', vector(0), 1, 'personal-reflection', 'private', (ids) => { scopedCandidates = ids; });
    assert.deepEqual(scopedCandidates, [id], 'acceptance trace callback observes only scoped SQL candidates before ranking');
    assert.deepEqual(recall.matches, [{ canonical_id: id, canonical_version: 1 }]);
    assert.deepEqual(Object.keys(recall.matches[0]).sort(), ['canonical_id', 'canonical_version']);
    const genericMatch = db.prepare('SELECT observation_id FROM embeddings WHERE observation_id = ?').get(observationId);
    const scopedInGeneric = db.prepare('SELECT observation_id FROM embeddings WHERE text_content = ?').get(scoped.content);
    assert.ok(genericMatch);
    assert.equal(scopedInGeneric, undefined);
    let legacyCandidates: readonly string[] = [];
    assert.deepEqual(semanticSearchWithVector(vector(0), { limit: 1 }, (ids) => { legacyCandidates = ids; }).map((row) => row.observation_id), [observationId]);
    assert.deepEqual(legacyCandidates, [observationId], 'legacy trace callback observes its SQL candidate set before cosine ranking');
    assertCode('invalid_scope', () => pr.personalReflectionRecall(PRINCIPAL, 'global', vector(0), 1, 'personal-reflection', 'private'));
  });

  test('stable canonical identity supports idempotent retry and rejects same-version digest conflicts', () => {
    const id = randomUUID();
    const first = record('synthetic canonical statement', id, 1);
    const created = upsert(first);
    const unchanged = upsert(first, vector(2));
    assert.equal(created.status, 'created');
    assert.equal(unchanged.status, 'created');
    assert.deepEqual(unchanged, created, 'transport retry replays the exact content-free receipt without inserting another row');
    assertCode('conflict', () => upsert(record('different synthetic statement', id, 1)));
    const count = getDatabase().prepare('SELECT count(*) AS n FROM personal_reflection_records WHERE canonical_id = ?').get(id) as { n: number };
    assert.equal(count.n, 1);
  });

  test('newer version atomically replaces content and stale update is rejected', () => {
    const id = randomUUID();
    upsert(record('synthetic version one', id, 2));
    assertCode('conflict', () => upsert(record('synthetic stale version', id, 1)));
    const update = record('synthetic version two', id, 3);
    assert.equal(upsert(update).status, 'updated');
    const readback = pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', id);
    assert.equal(readback.found, true);
    if (readback.found) assert.deepEqual(readback.record, update);
  });

  test('stale delete preserves newer version; delete retry and exact read-back are idempotent', () => {
    const id = randomUUID();
    const current = record('synthetic current record', id, 4);
    upsert(current);
    const key = pr.sha256Hex(`personal-reflection:delete:${id}:3`);
    assertCode('conflict', () => pr.personalReflectionDelete(PRINCIPAL, 'personal-reflection', id, 3, key));
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', id), { scope: 'personal-reflection', found: true, record: current });
    const deleteKey = pr.sha256Hex(`personal-reflection:delete:${id}:4`);
    const first = pr.personalReflectionDelete(PRINCIPAL, 'personal-reflection', id, 4, deleteKey);
    const retry = pr.personalReflectionDelete(PRINCIPAL, 'personal-reflection', id, 4, deleteKey);
    assert.deepEqual(retry, first);
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', id), { scope: 'personal-reflection', found: false });
    const embeddingsLeft = getDatabase().prepare('SELECT count(*) AS n FROM personal_reflection_embeddings WHERE canonical_id = ?').get(id) as { n: number };
    assert.equal(embeddingsLeft.n, 0, 'forget removes the scoped vector with its projection');
  });

  test('delete of a missing identity is idempotent and returns exact absence on read-back', () => {
    const id = randomUUID();
    const key = pr.sha256Hex(`personal-reflection:delete:${id}:1`);
    assert.equal((pr.personalReflectionDelete(PRINCIPAL, 'personal-reflection', id, 1, key) as { deleted: boolean }).deleted, true);
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', id), { scope: 'personal-reflection', found: false });
  });

  test('staged generation is invisible until exact count and manifest activate atomically', () => {
    const oldId = randomUUID();
    const old = record('synthetic old active generation', oldId);
    upsert(old, vector(0));
    const staged = [record('synthetic rebuild one'), record('synthetic rebuild two')];
    const generation = randomUUID();
    const digest = manifest(staged);
    pr.personalReflectionRebuildBegin(PRINCIPAL, 'personal-reflection', generation, staged.length, digest);
    staged.forEach((item, i) => upsert(item, vector(i + 1), generation));

    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', oldId), { scope: 'personal-reflection', found: true, record: old });
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', staged[0].canonical_id), { scope: 'personal-reflection', found: false });
    assertCode('conflict', () => pr.personalReflectionRebuildActivate(PRINCIPAL, 'personal-reflection', generation, staged.length + 1, digest));
    assertCode('conflict', () => pr.personalReflectionRebuildActivate(PRINCIPAL, 'personal-reflection', generation, staged.length, '0'.repeat(64)));
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', oldId), { scope: 'personal-reflection', found: true, record: old });

    const activated = pr.personalReflectionRebuildActivate(PRINCIPAL, 'personal-reflection', generation, staged.length, digest);
    assert.equal((activated as { active: boolean }).active, true);
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', oldId), { scope: 'personal-reflection', found: false });
    for (const item of staged) {
      assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', item.canonical_id), { scope: 'personal-reflection', found: true, record: item });
    }
    const activeCount = getDatabase().prepare(`SELECT count(*) AS n
      FROM personal_reflection_records r JOIN personal_reflection_generations g
        ON g.generation_id = r.generation_id AND g.scope = r.scope
      WHERE r.canonical_id IN (?, ?) AND g.status = 'active'`)
      .get(staged[0].canonical_id, staged[1].canonical_id) as { n: number };
    assert.equal(activeCount.n, staged.length, 'there is one active projection per canonical identity after the swap');
    assert.deepEqual(pr.personalReflectionRebuildActivate(PRINCIPAL, 'personal-reflection', generation, staged.length, digest), activated);
  });

  test('abort is idempotent for missing/inactive generations and cannot abort active data', () => {
    const id = randomUUID();
    assert.deepEqual(pr.personalReflectionRebuildAbort(PRINCIPAL, 'personal-reflection', id), { scope: 'personal-reflection', generation: id, aborted: true });
    const staged = record('synthetic abort candidate');
    const generation = randomUUID();
    const digest = manifest([staged]);
    pr.personalReflectionRebuildBegin(PRINCIPAL, 'personal-reflection', generation, 1, digest);
    upsert(staged, vector(0), generation);
    assert.deepEqual(pr.personalReflectionRebuildAbort(PRINCIPAL, 'personal-reflection', generation), { scope: 'personal-reflection', generation, aborted: true });
    assert.deepEqual(pr.personalReflectionRebuildAbort(PRINCIPAL, 'personal-reflection', generation), { scope: 'personal-reflection', generation, aborted: true });
    assert.deepEqual(pr.personalReflectionGet(PRINCIPAL, 'personal-reflection', staged.canonical_id), { scope: 'personal-reflection', found: false });
    const abortedRows = getDatabase().prepare('SELECT count(*) AS n FROM personal_reflection_records WHERE generation_id = ?').get(generation) as { n: number };
    assert.equal(abortedRows.n, 0);
    const active = record('synthetic active candidate');
    upsert(active);
    const activeGeneration = getDatabase().prepare("SELECT active_generation_id FROM personal_reflection_scope_state WHERE scope = 'personal-reflection'").get() as { active_generation_id: string };
    assertCode('conflict', () => pr.personalReflectionRebuildAbort(PRINCIPAL, 'personal-reflection', activeGeneration.active_generation_id));
  });
});
