import { createHash, randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { identityReportMetadata, requireSyntheticAcceptanceMode, validateAcceptanceTarget, type PrincipalKind } from './personal-reflection-acceptance-core.js';

type Status = 'PASS' | 'FAIL' | 'BLOCKED' | 'NOT_RUN';
type Check = { status: Status; evidence: string[] };
type Reply = { ok: boolean; value?: Record<string, unknown>; error?: string };
const report: { schema: string; target: string; identity_type?: PrincipalKind; identity_source?: 'bearer-sha256-derived' | 'existing-registered-client-id'; backend_build_identity: string; checks: Record<string, Check>; cleanup: { status: 'not-needed' | 'complete' | 'failed'; synthetic_ids: string[]; recovery: string[] } } = {
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
const upsertKey = (r: { canonical_id: string; canonical_version: number; payload_digest: string }) => hash(`personal-reflection:upsert:active:${r.canonical_id}:${r.canonical_version}:${r.payload_digest}`);
const deleteKey = (id: string, version: number) => hash(`personal-reflection:delete:${id}:${version}`);

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

async function run(): Promise<void> {
  let client: Client | undefined;
  let record: { scope: 'personal-reflection'; canonical_id: string; canonical_version: number; content: string; payload_digest: string } | undefined;
  let highestVersion = 0;
  try {
    requireSyntheticAcceptanceMode(process.env);
    const target = validateAcceptanceTarget(process.env.HIPPO_ACCEPTANCE_TARGET_URL!);
    report.target = target.origin;
    const token = process.env.HIPPO_ACCEPTANCE_BEARER_TOKEN!;
    const kind = process.env.HIPPO_ACCEPTANCE_AUTH_KIND as PrincipalKind;
    // The machine report records only the identity type/source, never a
    // stable bearer-derived identifier or OAuth client ID.
    Object.assign(report, identityReportMetadata(kind));
    const transport = new StreamableHTTPClientTransport(target, { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
    client = new Client({ name: 'hippocampus-personal-reflection-acceptance', version: '1.0.0' });
    await client.connect(transport);
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
    if (!validStatus(status.value)) {
      setCheck('F', 'FAIL', 'Scope status did not match contract 1.0; no writes were attempted.');
      setCheck('B', 'BLOCKED', 'Contract status mismatch prevented writes.');
      setCheck('E', 'BLOCKED', 'Contract status mismatch prevented writes.');
      return;
    }
    if (!unauthDenied) {
      setCheck('F', 'FAIL', 'Authenticated identity was accepted, but an unauthenticated caller was not denied.');
      throw new Error('unauthenticated-caller-not-denied');
    }

    const id = randomUUID();
    report.cleanup.synthetic_ids.push(id);
    const marker = `synthetic acceptance marker ${randomUUID()}`;
    const makeRecord = (version: number, content: string) => ({ scope: 'personal-reflection' as const, canonical_id: id,
      canonical_version: version, content, payload_digest: hash(content) });
    record = makeRecord(1, `${marker}; synthetic private statement; provenance marker; rationale marker; restricted marker; practical-representation marker; unavailable marker`);
    highestVersion = 1;
    const created = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record, operation_key: upsertKey(record) });
    if (!created.ok || created.value?.status !== 'created') throw new Error('create-failed');
    const retry = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record, operation_key: upsertKey(record) });
    if (!retry.ok || retry.value?.canonical_id !== id) throw new Error('retry-failed');
    const conflictRecord = makeRecord(1, `${marker}; alternate synthetic statement`);
    const sameVersion = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: conflictRecord, operation_key: upsertKey(conflictRecord) });
    if (sameVersion.ok || sameVersion.error !== 'conflict') throw new Error('same-version-conflict-missing');
    const revised = makeRecord(2, `${marker}; synthetic revised private statement`);
    record = revised;
    highestVersion = 2;
    const update = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: revised, operation_key: upsertKey(revised) });
    if (!update.ok || update.value?.status !== 'updated') throw new Error('update-failed');
    const stale = makeRecord(1, `${marker}; stale synthetic statement`);
    const staleUpdate = await call(client, 'personal_reflection_upsert', { scope: 'personal-reflection', record: stale, operation_key: upsertKey(stale) });
    if (staleUpdate.ok || staleUpdate.error !== 'conflict') throw new Error('stale-update-not-rejected');
    const staleDelete = await call(client, 'personal_reflection_delete', { scope: 'personal-reflection', canonical_id: id, canonical_version: 1, operation_key: deleteKey(id, 1) });
    if (staleDelete.ok || staleDelete.error !== 'conflict') throw new Error('stale-delete-not-rejected');

    const recall = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1,
      mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'private' });
    const rows = recall.value?.matches;
    const match = Array.isArray(rows) ? rows.find((row) => (row as Record<string, unknown>).canonical_id === id) as Record<string, unknown> | undefined : undefined;
    if (!recall.ok || recall.value?.scope !== 'personal-reflection' || recall.value.degraded !== false || !match ||
      match.canonical_version !== 2 || Object.keys(match).sort().join(',') !== 'canonical_id,canonical_version' || JSON.stringify(recall.value).includes(marker)) {
      throw new Error('recall-surface-contract-failed');
    }
    const readback = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: id });
    const readRecord = readback.value?.record as Record<string, unknown> | undefined;
    if (!readback.ok || readback.value?.found !== true || readRecord?.canonical_version !== 2) throw new Error('exact-readback-failed');

    const wrongScope = await call(client, 'personal_reflection_scope_status', { scope: 'global' });
    const wrongConsumer = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1, mode: 'thematic-recall', consumer: 'other', sensitivity: 'private' });
    const wrongSensitivity = await call(client, 'personal_reflection_recall', { scope: 'personal-reflection', query: marker, limit: 1, mode: 'thematic-recall', consumer: 'personal-reflection', sensitivity: 'restricted' });
    const errors = [wrongScope.error, wrongConsumer.error, wrongSensitivity.error];
    if (wrongScope.ok || wrongConsumer.ok || wrongSensitivity.ok || !errors.every(Boolean)) throw new Error('negative-capability-check-failed');
    setCheck('B', 'PASS', 'Synthetic UUID covered create, identical retry, same-version digest conflict, newer replacement, stale update/delete rejection, then cleanup with exact read-back.');
    setCheck('E', 'PASS', 'Recall returned only canonical_id and canonical_version; synthetic narrative, provenance, rationale, restricted, practical, and unavailable markers were absent.');
    report.checks.F = { status: 'BLOCKED', evidence: [
      'PASS: unauthenticated caller, wrong scope, consumer, and sensitivity were denied with content-free errors.',
      'BLOCKED: unsupported capability, degraded recall, malformed backend response, timeout, and backend failure require controlled fault injection and were not induced against production.',
    ] };
  } catch {
    if (report.checks.B.status === 'NOT_RUN') setCheck('B', record ? 'FAIL' : 'BLOCKED', record ? 'Synthetic lifecycle failed; server response details suppressed.' : 'Preflight or MCP setup stopped before a synthetic record was written.');
    if (report.checks.E.status === 'NOT_RUN') setCheck('E', record ? 'FAIL' : 'BLOCKED', record ? 'Recall surface failed; server response details suppressed.' : 'Preflight or MCP setup stopped before a synthetic record was written.');
    if (report.checks.F.status === 'NOT_RUN') setCheck('F', 'BLOCKED', 'Preflight or MCP setup failed; server response details suppressed.');
  } finally {
    if (client && record && highestVersion > 0) {
      const deleted = await call(client, 'personal_reflection_delete', { scope: 'personal-reflection', canonical_id: record.canonical_id,
        canonical_version: highestVersion, operation_key: deleteKey(record.canonical_id, highestVersion) });
      const readback = await call(client, 'personal_reflection_get', { scope: 'personal-reflection', canonical_id: record.canonical_id });
      if (!deleted.ok || !readback.ok || readback.value?.found !== false) {
        report.cleanup.status = 'failed';
        report.cleanup.recovery.push(`Delete only synthetic UUID ${record.canonical_id} at version ${highestVersion} with personal_reflection_delete, then verify personal_reflection_get returns found=false.`);
        if (report.checks.B.status === 'PASS') setCheck('B', 'FAIL', 'Synthetic lifecycle ran, but exact delete/read-back cleanup failed; follow the UUID/version-only recovery instructions.');
      } else {
        report.cleanup.status = 'complete';
      }
    }
    await client?.close().catch(() => undefined);
  }
}

await run();
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (Object.values(report.checks).some((check) => check.status === 'FAIL' || check.status === 'BLOCKED') || report.cleanup.status === 'failed') {
  process.exitCode = 1;
}
