import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDatabase } from '../../db/index.js';
import { findOrCreateEntity, findEntityById } from '../../db/entities.js';
import { createObservation } from '../../db/observations.js';
import { generateEmbedding, storeEmbedding } from '../../embeddings/embedder.js';

const identitySchema = z.object({
  record_id: z.string().regex(/^rec-[a-zA-Z0-9_-]+$/),
  entity: z.string().regex(/^project:[a-zA-Z0-9_-]+$/),
  source: z.string().regex(/^snapshots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+\.md$/).max(200),
  type: z.literal('project'), kind: z.literal('decision'),
}).strict();
type Identity = z.infer<typeof identitySchema>;
type Row = { observation_id: string; entity: string; type: string | null;
  kind: string | null; source: string | null; content: string; version_hash: string | null };

export function authorizeDecision(principal: string): void {
  const allowed = (process.env.HIPPO_MEMORY_SYNC_PRINCIPALS ?? '').split(',').filter(Boolean);
  if (!/^(agent|legacy):[a-f0-9]{64}$/.test(principal) || !allowed.includes(principal))
    throw new Error('unauthorized_memory_sync');
}

export function decisionInventory(principal: string, input: Identity) {
  authorizeDecision(principal);
  const identity = identitySchema.parse(input);
  const db = getDatabase();
  return db.transaction(() => {
    // No search ranking, pagination, entity limit, or embedding dependency.
    // Scan canonical and legacy observations before claiming absence.
    const rows = db.prepare(`SELECT o.id AS observation_id, e.name AS entity,
      e.type, o.kind, o.source, o.content, e.version_hash
      FROM observations o JOIN entities e ON e.id=o.entity_id`).all() as Row[];
    const total = (db.prepare('SELECT count(*) AS n FROM observations').get() as { n: number }).n;
    if (rows.length !== total) throw new Error('incomplete_inventory');
    const candidates = rows.filter(row => row.content.includes(identity.record_id)
      || row.source === identity.source
      || row.content.split(/\r?\n/).includes(`snapshot_path=${identity.source}`));
    return { contract: 'memory-sync-decision-v1', complete: true, degraded: false,
      truncated: false, scanned_count: total, observation_count: candidates.length,
      observations: candidates };
  })();
}

export function exactDecision(row: Row, input: Identity): boolean {
  const lines = row.content.split(/\r?\n/);
  const one = (key: string, value: string) =>
    lines.filter(line => line.startsWith(key + '=')).length === 1 && lines.includes(`${key}=${value}`);
  return row.entity === input.entity && row.type === input.type && row.kind === input.kind
    && (row.source === null || row.source === input.source)
    && one('record_id', input.record_id) && one('entity', input.entity)
    && one('snapshot_path', input.source)
    && (!lines.some(line => line.startsWith('kind=')) || one('kind', input.kind))
    && (!lines.some(line => line.startsWith('type=')) || one('type', input.type));
}

export async function appendDecision(principal: string, args: Identity & { content: string; importance?: number }) {
  authorizeDecision(principal);
  const { content, importance, ...identity } = args;
  identitySchema.parse(identity);
  if (!content || content.length > 50000 || /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)
    || !exactDecision({ ...identity, content, observation_id: '', version_hash: null }, identity))
    throw new Error('invalid_identity');
  // Do not hold a transaction across model/network awaits. Recheck under the
  // write transaction after embedding to close concurrent/crash retry races.
  const before = decisionInventory(principal, identity);
  if (before.observations.length && (before.observations.length !== 1 || !exactDecision(before.observations[0], identity)))
    throw new Error('identity_conflict');
  const vector = before.observations.length ? null : await generateEmbedding(content);
  return getDatabase().transaction(() => {
    const inventory = decisionInventory(principal, identity);
    if (inventory.observations.length) {
      if (inventory.observations.length !== 1 || !exactDecision(inventory.observations[0], identity))
        throw new Error('identity_conflict');
      return { success: true, observationId: inventory.observations[0].observation_id,
        reused: true, deduplicated: false, replaced: false };
    }
    if (!vector) throw new Error('inventory_changed');
    const entity = findOrCreateEntity(identity.entity, identity.type);
    if (entity.type !== identity.type) throw new Error('entity_type_conflict');
    const observation = createObservation(entity.id, content, identity.source, importance ?? 1, identity.kind);
    storeEmbedding(entity.id, observation.id, vector, content);
    return { success: true, observationId: observation.id, reused: false,
      version_hash: findEntityById(entity.id)?.version_hash, deduplicated: false, replaced: false };
  }).immediate();
}

export function registerMemorySyncDecisionTools(server: McpServer, principal: string) {
  const wrap = async (fn: () => unknown) => {
    try { return { content: [{ type: 'text' as const, text: JSON.stringify(await fn()) }] }; }
    catch { return { isError: true, content: [{ type: 'text' as const,
      text: JSON.stringify({ error: 'memory_sync_decision_unavailable' }) }] }; }
  };
  server.tool('memory_sync_decision_inventory', 'Complete authenticated canonical and legacy decision identity inventory.',
    identitySchema.shape, args => wrap(() => decisionInventory(principal, args)));
  server.tool('memory_sync_decision_append', 'Authenticated non-destructive canonical decision append.',
    { ...identitySchema.shape, content: z.string().min(1).max(50000), importance: z.number().min(0).max(2).optional() },
    args => wrap(() => appendDecision(principal, args)));
}
