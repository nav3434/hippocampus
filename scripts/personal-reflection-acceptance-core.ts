import { createHash } from 'node:crypto';

export type PrincipalKind = 'agent' | 'legacy' | 'oauth';
export type AcceptanceExecutionMode = 'live-safe' | 'isolated-production-equivalent';
export type IdentityReportMetadata = { identity_type: PrincipalKind; identity_source: 'bearer-sha256-derived' | 'existing-registered-client-id' };

export function identityReportMetadata(kind: PrincipalKind): IdentityReportMetadata {
  return { identity_type: kind, identity_source: kind === 'oauth' ? 'existing-registered-client-id' : 'bearer-sha256-derived' };
}

export function derivePrincipal(kind: PrincipalKind, bearerToken: string, oauthClientId?: string): string {
  if (!bearerToken) throw new Error('bearer token is required');
  if (kind === 'oauth') {
    if (!oauthClientId?.trim()) throw new Error('OAuth client ID is required');
    return `oauth:${oauthClientId.trim()}`;
  }
  return `${kind}:${createHash('sha256').update(bearerToken).digest('hex')}`;
}

export function acceptanceExecutionMode(env: NodeJS.ProcessEnv): AcceptanceExecutionMode {
  const mode = env.HIPPO_ACCEPTANCE_EXECUTION_MODE;
  if (mode === undefined) throw new Error('HIPPO_ACCEPTANCE_EXECUTION_MODE must be explicitly set');
  if (mode !== 'live-safe' && mode !== 'isolated-production-equivalent') {
    throw new Error('HIPPO_ACCEPTANCE_EXECUTION_MODE must be live-safe or isolated-production-equivalent');
  }
  return mode;
}

export function validateAcceptanceTarget(raw: string, mode: AcceptanceExecutionMode = 'live-safe'): URL {
  const target = new URL(raw);
  const localHttp = target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  const isolatedService = mode === 'isolated-production-equivalent' && target.protocol === 'http:' &&
    target.hostname === 'hippocampus-acceptance' && target.port === '3000';
  const validModeTarget = mode === 'isolated-production-equivalent' ? isolatedService : (target.protocol === 'https:' || localHttp);
  if (!validModeTarget || target.pathname !== '/mcp' || target.username || target.password || target.search || target.hash) {
    throw new Error('target must be HTTPS (or loopback HTTP) without embedded credentials, query, or fragment');
  }
  return target;
}

export function serializeSafeAcceptanceReport(report: unknown, forbiddenValues: readonly string[]): string {
  const rendered = JSON.stringify(report, null, 2);
  if (forbiddenValues.some((value) => value.length > 0 && rendered.includes(value))) {
    throw new Error('acceptance report contains a forbidden credential or synthetic content value');
  }
  return rendered;
}

export function preRankingCandidateProofPasses(
  trace: Record<string, unknown> | undefined,
  surface: 'legacy-global' | 'personal-reflection'
): boolean {
  return !!trace && trace.surface === surface && trace.candidate_stage === 'before-cosine-ranking-limit' &&
    Number.isSafeInteger(trace.candidate_count) && (trace.candidate_count as number) > 0 &&
    trace.expected_probe_in_candidates === true && trace.forbidden_scope_in_candidates === false &&
    trace.expected_probe_in_results === true && trace.forbidden_scope_in_results === false;
}

export function requireSyntheticAcceptanceMode(env: NodeJS.ProcessEnv): void {
  if (env.HIPPO_ACCEPTANCE_MODE !== 'synthetic-only') throw new Error('HIPPO_ACCEPTANCE_MODE must be exactly synthetic-only');
  if (!env.HIPPO_ACCEPTANCE_TARGET_URL) throw new Error('HIPPO_ACCEPTANCE_TARGET_URL is required');
  if (!env.HIPPO_ACCEPTANCE_BEARER_TOKEN) throw new Error('HIPPO_ACCEPTANCE_BEARER_TOKEN is required');
  if (!['agent', 'legacy', 'oauth'].includes(env.HIPPO_ACCEPTANCE_AUTH_KIND ?? '')) {
    throw new Error('HIPPO_ACCEPTANCE_AUTH_KIND must be agent, legacy, or oauth');
  }
  const mode = acceptanceExecutionMode(env);
  if (mode === 'isolated-production-equivalent') {
    if (env.HIPPO_ACCEPTANCE_TARGET_URL !== 'http://hippocampus-acceptance:3000/mcp' ||
        !/^pr-acceptance-[a-f0-9]{12}_acceptance-data$/.test(env.HIPPO_ACCEPTANCE_VOLUME_NAME ?? '') ||
        !/^[a-f0-9]{40}$/.test(env.HIPPO_ACCEPTANCE_BUILD_SHA ?? '')) {
      throw new Error('isolated mode requires the fixed Compose endpoint, fresh project-scoped volume, and immutable build SHA');
    }
  }
}
