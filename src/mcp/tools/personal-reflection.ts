import { z } from 'zod';
import { generateEmbedding } from '../../embeddings/embedder.js';
import { config } from '../../config.js';
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
import { recall as legacyRecall } from './recall.js';

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

type AcceptanceFault = 'unsupported-capability' | 'degraded-recall' | 'malformed-response' | 'timeout' | 'backend-failure';
const nextAcceptanceFault = new Map<string, AcceptanceFault>();
const acceptanceModeEnabled = () => config.personalReflectionAcceptanceMode === 'isolated-v1';

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
        if (acceptanceModeEnabled()) {
          const fault = nextAcceptanceFault.get(principalId);
          nextAcceptanceFault.delete(principalId);
          if (fault === 'unsupported-capability') throw new PersonalReflectionError('unauthorized');
          if (fault === 'degraded-recall') return result({ scope: PERSONAL_REFLECTION_SCOPE, degraded: true, matches: [] });
          if (fault === 'malformed-response') return { content: [{ type: 'text' as const, text: '{' }] };
          if (fault === 'timeout') await new Promise((resolve) => setTimeout(resolve, 1_000));
          if (fault === 'backend-failure') throw new PersonalReflectionError('unavailable');
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

  // These content-free controls exist only in an explicitly guarded, disposable
  // acceptance deployment. Normal production does not register the tools.
  if (acceptanceModeEnabled()) {
    server.tool('personal_reflection_acceptance_info',
      'Return isolated acceptance build identity metadata.',
      {},
      async () => {
        try {
          personalReflectionScopeStatus(principalId, PERSONAL_REFLECTION_SCOPE);
          return result({ mode: 'isolated-v1', backend_build_sha: process.env.HIPPO_BUILD_SHA });
        } catch (error) { return failure(error); }
      });

    server.tool('personal_reflection_acceptance_candidate_trace',
      'Return content-free pre-ranking candidate evidence for an isolated synthetic probe.',
      {
        surface: z.enum(['legacy-global', 'personal-reflection']),
        query: z.string().min(1).max(1024),
        limit: z.number().int().min(1).max(50).default(10),
        legacy_probe_observation_id: z.string().uuid(),
        personal_reflection_probe_canonical_id: z.string().uuid(),
      },
      async ({ surface, query, limit, legacy_probe_observation_id, personal_reflection_probe_canonical_id }) => {
        try {
          personalReflectionScopeStatus(principalId, PERSONAL_REFLECTION_SCOPE);
          if (!query.trim() || Buffer.byteLength(query, 'utf8') > 1024) throw new PersonalReflectionError('invalid_request');
          let candidateIds: readonly string[] = [];
          let returnedIds: readonly string[] = [];
          if (surface === 'legacy-global') {
            const legacy = await legacyRecall({ query, limit, spread: false, format: 'full' }, (ids) => { candidateIds = ids; });
            returnedIds = ('memories' in legacy && Array.isArray(legacy.memories))
              ? legacy.memories.map((memory) => memory.observation_id)
              : [];
          } else {
            const vector = await generateEmbedding(query);
            const scoped = personalReflectionRecall(principalId, PERSONAL_REFLECTION_SCOPE, vector, limit,
              'personal-reflection', 'private', (ids) => { candidateIds = ids; });
            returnedIds = scoped.matches.map((match) => match.canonical_id);
          }
          const expected = surface === 'legacy-global' ? legacy_probe_observation_id : personal_reflection_probe_canonical_id;
          const forbidden = surface === 'legacy-global' ? personal_reflection_probe_canonical_id : legacy_probe_observation_id;
          return result({
            surface,
            candidate_stage: 'before-cosine-ranking-limit',
            candidate_count: candidateIds.length,
            expected_probe_in_candidates: candidateIds.includes(expected),
            forbidden_scope_in_candidates: candidateIds.includes(forbidden),
            expected_probe_in_results: returnedIds.includes(expected),
            forbidden_scope_in_results: returnedIds.includes(forbidden),
          });
        } catch (error) { return failure(error); }
      });

    server.tool('personal_reflection_acceptance_arm_fault',
      'Arm one enumerated fail-closed test case for the next scoped recall only.',
      { scenario: z.enum(['unsupported-capability', 'degraded-recall', 'malformed-response', 'timeout', 'backend-failure']) },
      async ({ scenario }) => {
        try {
          personalReflectionScopeStatus(principalId, PERSONAL_REFLECTION_SCOPE);
          nextAcceptanceFault.set(principalId, scenario);
          return result({ armed: true });
        } catch (error) { return failure(error); }
      });
  }
}
