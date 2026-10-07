import { createHash } from 'node:crypto';

export type PrincipalKind = 'agent' | 'legacy' | 'oauth';
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

export function validateAcceptanceTarget(raw: string): URL {
  const target = new URL(raw);
  const localHttp = target.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(target.hostname);
  if ((target.protocol !== 'https:' && !localHttp) || target.pathname !== '/mcp' || target.username || target.password || target.search || target.hash) {
    throw new Error('target must be HTTPS (or loopback HTTP) without embedded credentials, query, or fragment');
  }
  return target;
}

export function requireSyntheticAcceptanceMode(env: NodeJS.ProcessEnv): void {
  if (env.HIPPO_ACCEPTANCE_MODE !== 'synthetic-only') throw new Error('HIPPO_ACCEPTANCE_MODE must be exactly synthetic-only');
  if (!env.HIPPO_ACCEPTANCE_TARGET_URL) throw new Error('HIPPO_ACCEPTANCE_TARGET_URL is required');
  if (!env.HIPPO_ACCEPTANCE_BEARER_TOKEN) throw new Error('HIPPO_ACCEPTANCE_BEARER_TOKEN is required');
  if (!['agent', 'legacy', 'oauth'].includes(env.HIPPO_ACCEPTANCE_AUTH_KIND ?? '')) {
    throw new Error('HIPPO_ACCEPTANCE_AUTH_KIND must be agent, legacy, or oauth');
  }
}
