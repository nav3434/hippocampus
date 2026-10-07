import { z } from 'zod';
import { generateEmbedding } from '../../embeddings/embedder.js';
import {
  PersonalReflectionError,
  personalReflectionDelete,
  personalReflectionGet,
  personalReflectionRebuildAbort,
  personalReflectionRebuildActivate,
  personalReflectionRebuildBegin,
  personalReflectionRecall,
  personalReflectionScopeStatus,
  personalReflectionUpsert,
  validatePersonalReflectionRecord,
  PERSONAL_REFLECTION_SCOPE,
} from '../../db/personal-reflection.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const uuidSchema = z.string().uuid();

function result(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] };
}

function failure(error: unknown) {
  // Do not include input, content, SQL details, or model errors in MCP responses.
  const code = error instanceof PersonalReflectionError ? error.code : 'unavailable';
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: code }) }], isError: true };
}

export function registerPersonalReflectionTools(server: McpServer, principalId: string): void {
  server.tool('personal_reflection_scope_status',
    'Report content-free status for the Personal Reflection private scope.',
    { scope: z.string() },
    async ({ scope }) => {
      try { return result(personalReflectionScopeStatus(principalId, scope)); }
      catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_upsert',
    'Store one strictly projected private Personal Reflection statement. The caller must be allowlisted by authenticated principal.',
    {
      scope: z.string(),
      operation_key: digestSchema,
      generation: uuidSchema.optional(),
      record: z.object({
        scope: z.literal(PERSONAL_REFLECTION_SCOPE),
        canonical_id: uuidSchema,
        canonical_version: z.number().int().positive().safe(),
        content: z.string().min(1).max(20_000),
        payload_digest: digestSchema,
      }).strict(),
    },
    async ({ scope, operation_key, generation, record }) => {
      try {
        personalReflectionScopeStatus(principalId, scope);
        if (record.scope !== scope) throw new PersonalReflectionError('invalid_scope');
        validatePersonalReflectionRecord(record);
        const vector = await generateEmbedding(record.content);
        return result(personalReflectionUpsert(principalId, record, operation_key, vector, generation));
      } catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_get',
    'Read a Personal Reflection record by canonical identity within the private scope.',
    { scope: z.string(), canonical_id: uuidSchema },
    async ({ scope, canonical_id }) => {
      try { return result(personalReflectionGet(principalId, scope, canonical_id)); }
      catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_delete',
    'Idempotently delete a Personal Reflection record at the supplied canonical version.',
    {
      scope: z.string(),
      canonical_id: uuidSchema,
      canonical_version: z.number().int().positive().safe(),
      operation_key: digestSchema,
    },
    async ({ scope, canonical_id, canonical_version, operation_key }) => {
      try { return result(personalReflectionDelete(principalId, scope, canonical_id, canonical_version, operation_key)); }
      catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_recall',
    'Search only active private Personal Reflection records. Returns canonical IDs and versions, never record text.',
    {
      scope: z.string(),
      query: z.string().min(1).max(1024),
      limit: z.number().int().min(1).max(50).default(10),
      mode: z.literal('thematic-recall').default('thematic-recall'),
      consumer: z.literal('personal-reflection').default('personal-reflection'),
      sensitivity: z.literal('private').default('private'),
    },
    async ({ scope, query, limit, consumer, sensitivity }) => {
      try {
        // Authorize before loading or running the embedding model.
        personalReflectionScopeStatus(principalId, scope);
        if (!query.trim() || Buffer.byteLength(query, 'utf8') > 1024) {
          throw new PersonalReflectionError('invalid_request');
        }
        const queryVector = await generateEmbedding(query);
        return result(personalReflectionRecall(principalId, scope, queryVector, limit, consumer, sensitivity));
      } catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_rebuild_begin',
    'Begin a staged generation rebuild for the private Personal Reflection scope.',
    {
      scope: z.string(), generation: uuidSchema,
      record_count: z.number().int().min(0).max(5_000).safe(), manifest_digest: digestSchema,
    },
    async ({ scope, generation, record_count, manifest_digest }) => {
      try { return result(personalReflectionRebuildBegin(principalId, scope, generation, record_count, manifest_digest)); }
      catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_rebuild_activate',
    'Atomically activate a complete Personal Reflection generation after manifest verification.',
    {
      scope: z.string(), generation: uuidSchema,
      record_count: z.number().int().min(0).max(5_000).safe(), manifest_digest: digestSchema,
    },
    async ({ scope, generation, record_count, manifest_digest }) => {
      try { return result(personalReflectionRebuildActivate(principalId, scope, generation, record_count, manifest_digest)); }
      catch (error) { return failure(error); }
    });

  server.tool('personal_reflection_rebuild_abort',
    'Abort an inactive staged Personal Reflection generation.',
    { scope: z.string(), generation: uuidSchema },
    async ({ scope, generation }) => {
      try { return result(personalReflectionRebuildAbort(principalId, scope, generation)); }
      catch (error) { return failure(error); }
    });
}
