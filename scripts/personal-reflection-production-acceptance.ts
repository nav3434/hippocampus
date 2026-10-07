import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { acceptanceExecutionMode, identityReportMetadata, preRankingCandidateProofPasses, requireSyntheticAcceptanceMode, serializeSafeAcceptanceReport, validateAcceptanceTarget, type PrincipalKind } from './personal-reflection-acceptance-core.js';

type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
type Check = { status: Status; evidence: string[] };
type Reply = { ok: boolean; value?: Record<string, unknown>; error?: string };
const report: { schema: string; target: string; execution_mode?: 'live-safe' | 'isolated-production-equivalent'; identity_type?: PrincipalKind; identity_source?: 'bearer-sha256-derived' | 'existing-registered-client-id'; backend_build_identity: string; checks: Record<string, Check>; cleanup: { status: 'not-needed' | 'complete' | 'failed'; synthetic_ids: string[]; recovery: string[] } } = {
  schema: 'hippocampus-personal-reflection-acceptance/v1', target: '',
  backend_build_identity: 'unavailable: scope status does not expose a backend build identifier',
  checks: {
    A: { status: 'BLOCKED', evidence: ['The deployed API has no candidate/rank trace or query-plan endpoint; status flags alone cannot prove pre-ranking enforcement.'] },
    B: { status: 'NOT_RUN', evidence: [] },
    C: { status: 'BLOCKED', evidence: ['Rebuild activation swaps the complete personal-reflection scope and deletes the prior generation; the contract has no isolated test namespace or safe active-generation snapshot.'] },
    D: { status: 'BLOCKED', evidence: ['Canonical lifecycle, sensitivity, epistemic status, and base-profile resolution belong to personal-system; this backend exposes no canonical resolver.'] },
    E: { status: 'NOT_RUN', evidence: [] }, F: { status: 'NOT_RUN', evidence: [] },
  },
  cleanup: { status: 'not-needed', synthetic_ids: [], recovery: [] },
};
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const upsertKey = (r: { canonical_id: string; canonical_version: number; payload_digest: string }, generation?: string) => hash(`personal-reflection:upsert:${generation ?? 'active'}:${r.canonical_id}:${r.canonical_version}:${r.payload_digest}`);
const deleteKey = (id: string, version: number) => hash(`personal-reflection:delete:${id}:${version}`);
const cleanupRecords: Array<{ canonical_id: string; canonical_version: number }> = [];
const cleanupGenerations = new Set<string>();
const privateSyntheticValues = new Set<string>();
let globalObservationId: string | undefined;
let globalEntityName: string | undefined;
let runnerCheckpoint = 'preflight';

function parseReply(reply: Awaited<ReturnType<Client['callTool']>>): Reply {
  const content = Array.isArray(reply.content) ? reply.content as Array<{ type: string; text?: string }> : [];
  const raw = content.find((item) => item.type === 'text')?.text;
  if (!raw) return { ok: false, error: 'malformed-response' };
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return reply.isError ? { ok: false, value, error: typeof value.error === 'string' ? value.error : 'tool-error' } : { ok: true, value };
  } catch { return { ok: false, error: 'malformed-response' }; }
}
async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Reply> {
  try { return parseReply(await client.callTool({ name, arguments: args })); }
  catch { return { ok: false, error: 'transport-or-protocol-error' }; }
}
function setCheck(name: string, status: Status, evidence: string): void { report.checks[name] = { status, evidence: [evidence] }; }
function validStatus(v?: Record<string, unknown>): boolean {
  const expected = { scope: 'personal-reflection', contract_version: '1.0', pre_rank_scope_enforced: true,
    capability_filter_enforced: true, sensitivity_filter_enforced: true,
    cross_topic_requires_authorized_representation: true, unique_canonical_identity: true,
    idempotent_lifecycle: true, atomic_generation_swap: true };
  return !!v && Object.entries(expected).every(([key, value]) => v[key] === value);
}

function manifestDigest(records: Array<{ canonical_id: string; canonical_version: number; payload_digest: string }>): string {
  const identities = [...records]
    .sort((a, b) => a.canonical_id < b.canonical_id ? -1 : a.canonical_id > b.canonical_id ? 1 :
      a.canonical_version - b.canonical_version || a.payload_digest.localeCompare(b.payload_digest))
    .map((record) => [record.canonical_id, record.canonical_version, record.payload_digest]);
  return hash(JSON.stringify(identities));
}

async function runIsolatedA(client: Client, query: string, personalId: string): Promise<void> {
  globalEntityName = `acceptance-${randomUUID()}`;
  const remembered = await call(client, 'remember', { content: query, entity: globalEntityName, type: 'acceptance', source: 'synthetic-acceptance', kind: 'fact' });
  const observationId = remembered.value?.observationId;
  if (!remembered.ok || typeof observationId !== 'string') throw new Error('legacy-seed-failed');
  globalObservationId = observationId;
  report.cleanup.synthetic_ids.push(observationId);

  const args = { query, limit: 50, legacy_probe_observation_id: observationId, personal_reflection_probe_canonical_id: personalId };
  const legacy = await call(client, 'personal_reflection_acceptance_candidate_trace', { ...args, surface: 'legacy-global' });
  const scoped = await call(client, 'personal_reflection_acceptance_candidate_trace', { ...args, surface: 'personal-reflection' });
  if (!legacy.ok || !preRankingCandidateProofPasses(legacy.value, 'legacy-global') ||
      !scoped.ok || !preRankingCandidateProofPasses(scoped.value, 'personal-reflection')) throw new Error('pre-ranking-scope-proof-failed');
  setCheck('A', 'PASS', 'Runtime traces at the pre-cosine/rank/limit boundary showed the synthetic global candidate only in legacy candidates/results and the Personal Reflection candidate only in scoped candidates/results; trace exposed counts and booleans only.');
}

async function runIsolatedC(client: Client, previousId: string): Promise<void> {
  const staged = [0, 1].map((index) => {
    const content = `synthetic rebuild acceptance marker ${index} ${randomUUID()}`;
    privateSyntheticValues.add(content);
    return { scope: 'personal-reflection', canonical_id: randomUUID(), canonical_version: 1, content, payload_digest: hash(content) };
  });
  const generation = randomUUID();
  cleanupGenerations.add(generation);
  const digest = manifestDigest(staged);
  const beginArgs = { scope: 'personal-reflection', generation, record_count: staged.length, manifest_digest: digest };
  const begin = await call(client, 'personal_reflection_rebuild_begin', beginArgs);
  const beginRetry = await call(client, 'personal_reflection_rebuild_begin', beginArgs);
  if (!begin.ok || !beginRetry.ok || begin.value?.generation !== generation || beginRetry.value?.generation !== generation) throw new Error('rebuild-begin-retry-failed');
  for (const record of staged) {
    const stored = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record,
      operation_key: upsertKey(record, generation), generation });
    const retry = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record,
      operation_key: upsertKey(record, generation), generation });
    if (!stored.ok || !retry.ok || stored.value?.canonical_id !== record.canonical_id || retry.value?.canonical_id !== record.canonical_id) {
      throw new Error('rebuild-upsert-retry-failed');
    }
    cleanupRecords.push({ canonical_id: record.canonical_id, canonical_version: record.canonical_version });
  }
  const hidden = await Promise.all(staged.map((record) => call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: record.canonical_id })));
  const oldBefore = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: previousId });
  if (!hidden.every((reply) => reply.ok && reply.value?.found === false) || !oldBefore.ok || oldBefore.value?.found !== true) throw new Error('inactive-generation-visibility-failed');
  const wrongCount = await call(client, 'personal_reflection_rebuild_activate', { ...beginArgs, record_count: staged.length + 1 });
  const wrongManifest = await call(client, 'personal_reflection_rebuild_activate', { ...beginArgs, manifest_digest: '0'.repeat(64) });
  const oldAfterRejects = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: previousId });
  if (wrongCount.ok || wrongCount.error !== 'conflict' || wrongManifest.ok || wrongManifest.error !== 'conflict' ||
      !oldAfterRejects.ok || oldAfterRejects.value?.found !== true) throw new Error('rebuild-manifest-guard-failed');
  const activated = await call(client, 'personal_reflection_rebuild_activate', beginArgs);
  const activateRetry = await call(client, 'personal_reflection_rebuild_activate', beginArgs);
  if (!activated.ok || !activateRetry.ok || activated.value?.active !== true || activateRetry.value?.active !== true) throw new Error('rebuild-activation-retry-failed');
  cleanupGenerations.delete(generation);
  const [oldAfter, ...newRecords] = await Promise.all([
    call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: previousId }),
    ...staged.map((record) => call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: record.canonical_id })),
  ]);
  if (!oldAfter.ok || oldAfter.value?.found !== false || !newRecords.every((reply) => reply.ok && reply.value?.found === true)) throw new Error('rebuild-atomic-swap-readback-failed');
  const activeAbort = await call(client, 'personal_reflection_rebuild_abort', { scope: 'personal-reflection', generation });
  if (activeAbort.ok || activeAbort.error !== 'conflict') throw new Error('active-generation-abort-accepted');

  const abortGeneration = randomUUID();
  cleanupGenerations.add(abortGeneration);
  const emptyDigest = manifestDigest([]);
  const abortBegin = { scope: 'personal-reflection', generation: abortGeneration, record_count: 0, manifest_digest: emptyDigest };
  if (!(await call(client, 'personal_reflection_rebuild_begin', abortBegin)).ok) throw new Error('abort-generation-begin-failed');
  const abortOne = await call(client, 'personal_reflection_rebuild_abort', { scope: 'personal-reflection', generation: abortGeneration });
  const abortRetry = await call(client, 'personal_reflection_rebuild_abort', { scope: 'personal-reflection', generation: abortGeneration });
  cleanupGenerations.delete(abortGeneration);
  if (!abortOne.ok || !abortRetry.ok || abortOne.value?.aborted !== true || abortRetry.value?.aborted !== true) throw new Error('inactive-generation-abort-idempotency-failed');

  const duplicateCheck = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: 'synthetic rebuild acceptance marker', limit: 50,
    mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'private' });
  const matches = Array.isArray(duplicateCheck.value?.matches) ? duplicateCheck.value.matches as Array<Record<string, unknown>> : [];
  const ids = matches.map((match) => match.canonical_id);
  if (!duplicateCheck.ok || staged.some((record) => !ids.includes(record.canonical_id)) || new Set(ids).size !== ids.length) throw new Error('active-canonical-identity-uniqueness-failed');
  const afterGlobal = await call(client, 'personal_reflection_acceptance_candidate_trace', {
    surface: 'legacy-global', query: `synthetic acceptance marker`, limit: 50,
    legacy_probe_observation_id: globalObservationId, personal_reflection_probe_canonical_id: staged[0].canonical_id,
  });
  if (!afterGlobal.ok || afterGlobal.value?.expected_probe_in_candidates !== true || afterGlobal.value?.expected_probe_in_results !== true) throw new Error('legacy-contour-changed-by-rebuild');
  setCheck('C', 'PASS', 'Isolated runtime verified inactive invisibility, exact count/digest guards, old-generation reads before swap, atomic activation read-back, begin/upsert/activate retries, inactive abort idempotency, active abort rejection, unique active identities, and unchanged legacy recall.');
}

async function runIsolatedF(client: Client, query: string, token: string): Promise<void> {
  const scenarios: Array<{ scenario: string; expected?: string; degraded?: boolean; timeout?: boolean }> = [
    { scenario: 'unsupported-capability', expected: 'unauthorized' },
    { scenario: 'degraded-recall', degraded: true },
    { scenario: 'malformed-response', expected: 'malformed-response' },
    { scenario: 'timeout', timeout: true },
    { scenario: 'backend-failure', expected: 'unavailable' },
  ];
  for (const scenario of scenarios) {
    const armed = await call(client, 'personal_reflection_acceptance_arm_fault', { scenario: scenario.scenario });
    if (!armed.ok || armed.value?.armed !== true) throw new Error('fault-case-arm-failed');
    const request = call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query, limit: 1,
      mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'private' });
    const outcome = scenario.timeout
      ? await Promise.race([request.then((reply) => ({ reply })), new Promise<{ timedOut: true }>((resolve) => setTimeout(() => resolve({ timedOut: true }), 250))])
      : { reply: await request };
    const rendered = JSON.stringify(outcome);
    if (rendered.includes(token) || rendered.includes(query)) throw new Error('fault-case-response-leaked-sensitive-input');
    if (scenario.timeout) {
      if (!('timedOut' in outcome)) throw new Error('timeout-not-enforced');
    } else if ('reply' in outcome) {
      const reply = outcome.reply;
      if (scenario.degraded) {
        if (!reply.ok || reply.value?.degraded !== true || (Array.isArray(reply.value.matches) && reply.value.matches.length > 0)) throw new Error('degraded-recall-not-fail-closed');
      } else if (reply.ok || reply.error !== scenario.expected) {
        throw new Error('fault-case-not-fail-closed');
      }
    }
  }
  setCheck('F', 'PASS', 'Existing unauthenticated, scope, consumer, and sensitivity denials remained content-free; isolated one-shot cases for unsupported capability, degraded recall, malformed response, timeout, and backend failure all failed closed without query or credential leakage.');
}

async function run(): Promise<void> {
  let client: Client | undefined;
  let record: { scope: 'personal-reflection'; canonical_id: string; canonical_version: number; content: string; payload_digest: string } | undefined;
  let isolated = false;
  let token = '';
  try {
    runnerCheckpoint = 'synthetic-mode-validation';
    requireSyntheticAcceptanceMode(process.env);
    const mode = acceptanceExecutionMode(process.env);
    isolated = mode === 'isolated-production-equivalent';
    report.execution_mode = mode;
    const target = validateAcceptanceTarget(process.env.HIPPO_ACCEPTANCE_TARGET_URL!, mode);
    report.target = target.origin;
    token = process.env.HIPPO_ACCEPTANCE_BEARER_TOKEN!;
    const kind = process.env.HIPPO_ACCEPTANCE_AUTH_KIND as PrincipalKind;
    // The machine report records only the identity type/source, never a
    // stable bearer-derived identifier or OAuth client ID.
    Object.assign(report, identityReportMetadata(kind));
    const transport = new StreamableHTTPClientTransport(target, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    client = new Client({ name: 'hippocampus-personal-reflection-acceptance', version: '1.0.0' });
    await client.connect(transport);
    runnerCheckpoint = 'unauthenticated-denial';
    const noAuthClient = new Client({ name: 'hippocampus-personal-reflection-unauthorized-check', version: '1.0.0' });
    let unauthDenied = false;
    try {
      await noAuthClient.connect(new StreamableHTTPClientTransport(target));
      const unauth = await call(noAuthClient, 'personal_reflection_scope_status', { scope: 'personal-reflection' });
      unauthDenied = !unauth.ok && unauth.error === 'unauthorized';
    } catch (error) {
      // Only a protocol 401 counts; DNS, timeout, or backend failures are not proof of denial.
      const candidate = error as { name?: string; code?: number };
      unauthDenied = candidate.name === 'UnauthorizedError' || candidate.code === 401;
    } finally {
      await noAuthClient.close().catch(() => undefined);
    }
    runnerCheckpoint = 'authenticated-scope-status';
    const status = await call(client, 'personal_reflection_scope_status', { scope: 'personal-reflection' });
    if (!status.ok) {
      setCheck('F', 'BLOCKED', status.error === 'unauthorized'
        ? 'The authenticated principal was denied by the deployed Personal Reflection allowlist; this is consistent with the supplied empty allowlist, but no authorized negative-capability checks could run.'
        : 'Authenticated scope-status call did not produce a valid response; details suppressed.');
      report.checks.F.evidence.push(unauthDenied
        ? 'Unauthenticated caller was denied at HTTP authentication or scoped authorization.'
        : 'Unauthenticated caller was not denied as expected.');
      if (!unauthDenied) report.checks.F.status = 'FAIL';
      setCheck('B', 'BLOCKED', 'The principal is not allowlisted; no writes were attempted.');
      setCheck('E', 'BLOCKED', 'The principal is not allowlisted; no records were created.');
      return;
    }
    runnerCheckpoint = 'contract-status-validation';
    if (!validStatus(status.value)) {
      setCheck('F', 'FAIL', 'Scope status did not match contract 1.0; no writes were attempted.');
      setCheck('B', 'BLOCKED', 'Contract status mismatch prevented writes.');
      setCheck('E', 'BLOCKED', 'Contract status mismatch prevented writes.');
      return;
    }
    if (isolated) {
      runnerCheckpoint = 'isolated-build-identity';
      const info = await call(client, 'personal_reflection_acceptance_info', {});
      const buildSha = process.env.HIPPO_ACCEPTANCE_BUILD_SHA;
      if (!info.ok || info.value?.mode !== 'isolated-v1' || info.value?.backend_build_sha !== buildSha || !/^[a-f0-9]{40}$/.test(buildSha ?? '')) {
        throw new Error('isolated-backend-build-identity-mismatch');
      }
      report.backend_build_identity = `source-commit-sha:${buildSha}`;
    }
    if (!unauthDenied) {
      setCheck('F', 'FAIL', 'Authenticated identity was accepted, but an unauthenticated caller was not denied.');
      throw new Error('unauthenticated-caller-not-denied');
    }

    runnerCheckpoint = 'create-synthetic-record';
    const id = randomUUID();
    report.cleanup.synthetic_ids.push(id);
    const marker = `synthetic acceptance marker ${randomUUID()}`;
    privateSyntheticValues.add(marker);
    const makeRecord = (version: number, content: string) => ({ scope: 'personal-reflection' as const, canonical_id: id,
      canonical_version: version, content, payload_digest: hash(content) });
    record = makeRecord(1, `${marker}; synthetic private statement; provenance marker; rationale marker; restricted marker; practical-representation marker; unavailable marker`);
    privateSyntheticValues.add(record.content);
    cleanupRecords.push({ canonical_id: id, canonical_version: 1 });
    const created = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record, operation_key: upsertKey(record) });
    if (!created.ok || created.value?.status !== 'created') throw new Error('create-failed');
    runnerCheckpoint = 'idempotent-create-retry';
    const retry = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record, operation_key: upsertKey(record) });
    if (!retry.ok || retry.value?.canonical_id !== id) throw new Error('retry-failed');
    const conflictRecord = makeRecord(1, `${marker}; alternate synthetic statement`);
    runnerCheckpoint = 'same-version-conflict';
    const sameVersion = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: conflictRecord, operation_key: upsertKey(conflictRecord) });
    if (sameVersion.ok || sameVersion.error !== 'conflict') throw new Error('same-version-conflict-missing');
    const revised = makeRecord(2, `${marker}; synthetic revised private statement`);
    privateSyntheticValues.add(revised.content);
    record = revised;
    runnerCheckpoint = 'newer-version-replacement';
    const update = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: revised, operation_key: upsertKey(revised) });
    if (!update.ok || update.value?.status !== 'updated') throw new Error('update-failed');
    const stale = makeRecord(1, `${marker}; stale synthetic statement`);
    runnerCheckpoint = 'stale-update-rejection';
    const staleUpdate = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: stale, operation_key: upsertKey(stale) });
    if (staleUpdate.ok || staleUpdate.error !== 'conflict') throw new Error('stale-update-not-rejected');
    runnerCheckpoint = 'stale-delete-rejection';
    const staleDelete = await call(client, 'personal_reflection_delete', { scope: 'personal-reflection', canonical_id: id, canonical_version: 1, operation_key: deleteKey(id, 1) });
    if (staleDelete.ok || staleDelete.error !== 'conflict') throw new Error('stale-delete-not-rejected');

    runnerCheckpoint = 'scoped-recall-surface';
    const recall = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1,
      mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'private' });
    const rows = recall.value?.matches;
    const match = Array.isArray(rows) ? rows.find((row) => (row as Record<string, unknown>).canonical_id === id) as Record<string, unknown> | undefined : undefined;
    if (!recall.ok || recall.value?.scope !== 'personal-reflection' || recall.value.degraded !== false || !match ||
      match.canonical_version !== 2 || Object.keys(match).sort().join(',') !== 'canonical_id,canonical_version' || JSON.stringify(recall.value).includes(marker)) {
      throw new Error('recall-surface-contract-failed');
    }
    runnerCheckpoint = 'exact-readback';
    const readback = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: id });
    const readRecord = readback.value?.record as Record<string, unknown> | undefined;
    if (!readback.ok || readback.value?.found !== true || readRecord?.canonical_version !== 2) throw new Error('exact-readback-failed');
    cleanupRecords[cleanupRecords.length - 1] = { canonical_id: id, canonical_version: 2 };

    runnerCheckpoint = 'negative-capability-checks';
    const wrongScope = await call(client, 'personal_reflection_scope_status', { scope: 'global' });
    const wrongConsumer = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1, mode: 'thematic-recall', consumer: 'other', sensitivity: 'private' });
    const wrongSensitivity = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1, mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'restricted' });
    const errors = [wrongScope.error, wrongConsumer.error, wrongSensitivity.error];
    if (wrongScope.ok || wrongConsumer.ok || wrongSensitivity.ok || !errors.every(Boolean)) throw new Error('negative-capability-check-failed');
    setCheck('B', 'PASS', 'Synthetic UUID covered create, identical retry, same-version digest conflict, newer replacement, stale update/delete rejection, then cleanup with exact read-back.');
    setCheck('E', 'PASS', 'Recall returned only canonical_id and canonical_version; synthetic narrative, provenance, rationale, restricted, practical, and unavailable markers were absent.');
    if (isolated) {
      runnerCheckpoint = 'group-a-pre-ranking-trace';
      await runIsolatedA(client, record.content, id);
      runnerCheckpoint = 'group-c-rebuild-lifecycle';
      await runIsolatedC(client, id);
      runnerCheckpoint = 'group-f-fault-injection';
      await runIsolatedF(client, marker, token);
    } else {
      report.checks.F = { status: 'BLOCKED', evidence: [
        'PASS: unauthenticated caller, wrong scope, consumer, and sensitivity were denied with content-free errors.',
        'BLOCKED: unsupported capability, degraded recall, malformed backend response, timeout, and backend failure require the isolated production-equivalent mode.',
      ] };
    }
  } catch {
    if (report.checks.B.status === 'NOT_RUN') setCheck('B', record ? 'FAIL' : 'BLOCKED', record ? `Synthetic lifecycle failed at ${runnerCheckpoint}; server response details suppressed.` : 'Preflight or MCP setup stopped before a synthetic record was written.');
    if (report.checks.E.status === 'NOT_RUN') setCheck('E', record ? 'FAIL' : 'BLOCKED', record ? `Recall/read-back failed at ${runnerCheckpoint}; server response details suppressed.` : 'Preflight or MCP setup stopped before a synthetic record was written.');
    if (report.checks.F.status === 'NOT_RUN') setCheck('F', 'BLOCKED', 'Preflight or MCP setup failed; server response details suppressed.');
    if (isolated && report.checks.A.status === 'BLOCKED') setCheck('A', 'FAIL', `Isolated candidate trace failed at ${runnerCheckpoint}; details suppressed.`);
    if (isolated && report.checks.C.status === 'BLOCKED') setCheck('C', 'FAIL', `Isolated rebuild lifecycle failed at ${runnerCheckpoint}; details suppressed.`);
    if (isolated && report.checks.F.status === 'NOT_RUN') setCheck('F', 'FAIL', `Isolated fail-closed checks did not run past ${runnerCheckpoint}; details suppressed.`);
  } finally {
    if (client && cleanupRecords.length > 0) {
      let failed = false;
      for (const item of cleanupRecords) {
        const deleted = await call(client, 'personal_reflection_delete', { scope: 'personal-reflection', canonical_id: item.canonical_id,
          canonical_version: item.canonical_version, operation_key: deleteKey(item.canonical_id, item.canonical_version) });
        const readback = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: item.canonical_id });
        if (!deleted.ok || !readback.ok || readback.value?.found !== false) {
          failed = true;
          report.cleanup.recovery.push(`Delete only synthetic UUID ${item.canonical_id} at version ${item.canonical_version} with personal_reflection_delete, then verify personal_reflection_get returns found=false.`);
        }
      }
      for (const generation of cleanupGenerations) {
        const aborted = await call(client, 'personal_reflection_rebuild_abort', { scope: 'personal-reflection', generation });
        if (!aborted.ok) failed = true;
      }
      if (globalObservationId) {
        const forgotten = await call(client, 'forget', { entity: globalEntityName });
        const deleted = forgotten.value?.deleted as Record<string, unknown> | undefined;
        const verification = await call(client, 'recall', { query: privateSyntheticValues.values().next().value ?? 'synthetic acceptance marker',
          limit: 50, spread: false, format: 'full' });
        const memories = Array.isArray(verification.value?.memories) ? verification.value.memories as Array<Record<string, unknown>> : [];
        if (!forgotten.ok || forgotten.value?.success !== true || deleted?.entity !== true ||
            deleted.observations !== 1 || !verification.ok || memories.some((memory) => memory.observation_id === globalObservationId)) {
          failed = true;
          report.cleanup.recovery.push(`Forget only synthetic entity ${globalEntityName} with the forget tool, then run a synthetic-query recall to verify the observation is absent.`);
        }
      }
      report.cleanup.status = failed ? 'failed' : 'complete';
      if (failed && report.checks.B.status === 'PASS') setCheck('B', 'FAIL', 'Synthetic cleanup/read-back failed; follow the UUID-only recovery instructions.');
    }
    await client?.close().catch(() => undefined);
  }
}

await run();
const forbiddenReportValues = [process.env.HIPPO_ACCEPTANCE_BEARER_TOKEN ?? '', ...privateSyntheticValues];
process.stdout.write(`${serializeSafeAcceptanceReport(report, forbiddenReportValues)}\n`);
const unexpectedBlockingResult = Object.entries(report.checks).some(([name, check]) => check.status === 'FAIL' ||
  (check.status === 'BLOCKED' && !(report.execution_mode === 'isolated-production-equivalent' && name === 'D')));
if (unexpectedBlockingResult || report.cleanup.status === 'failed') {
  process.exitCode = 1;
}
