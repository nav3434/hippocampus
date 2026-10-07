import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { acceptanceExecutionMode, derivePrincipal, identityReportMetadata, preRankingCandidateProofPasses, requireSyntheticAcceptanceMode, serializeSafeAcceptanceReport, validateAcceptanceTarget } from '../scripts/personal-reflection-acceptance-core.js';

test('principal derivation matches the production auth identity rules without returning the bearer', () => {
  const token = 'synthetic-only acceptance token';
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(derivePrincipal('agent', token), `agent:${hash}`);
  assert.equal(derivePrincipal('legacy', token), `legacy:${hash}`);
  assert.equal(derivePrincipal('oauth', token, 'registered-client'), 'oauth:registered-client');
  assert.deepEqual(identityReportMetadata('agent'), { identity_type: 'agent', identity_source: 'bearer-sha256-derived' });
  assert.deepEqual(identityReportMetadata('legacy'), { identity_type: 'legacy', identity_source: 'bearer-sha256-derived' });
  assert.deepEqual(identityReportMetadata('oauth'), { identity_type: 'oauth', identity_source: 'existing-registered-client-id' });
  assert.throws(() => derivePrincipal('oauth', token), /OAuth client ID/);
});

test('acceptance mode is explicit and target URL cannot carry credentials', () => {
  const env = { HIPPO_ACCEPTANCE_MODE: 'synthetic-only', HIPPO_ACCEPTANCE_EXECUTION_MODE: 'live-safe', HIPPO_ACCEPTANCE_TARGET_URL: 'https://hippo.example/mcp',
    HIPPO_ACCEPTANCE_BEARER_TOKEN: 'synthetic-token', HIPPO_ACCEPTANCE_AUTH_KIND: 'agent' } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => requireSyntheticAcceptanceMode(env));
  assert.equal(validateAcceptanceTarget(env.HIPPO_ACCEPTANCE_TARGET_URL!).origin, 'https://hippo.example');
  assert.throws(() => validateAcceptanceTarget('http://hippo.example/mcp'), /target must be HTTPS/);
  assert.throws(() => validateAcceptanceTarget('https://user:pass@hippo.example/mcp'), /target must be HTTPS/);
  assert.throws(() => validateAcceptanceTarget('https://hippo.example/not-mcp'), /target must be HTTPS/);
  assert.throws(() => requireSyntheticAcceptanceMode({ ...env, HIPPO_ACCEPTANCE_MODE: 'production' }), /synthetic-only/);
  assert.equal(acceptanceExecutionMode(env), 'live-safe');
});

test('isolated acceptance guard accepts only the fixed internal endpoint and fresh project volume identity', () => {
  const env = { HIPPO_ACCEPTANCE_MODE: 'synthetic-only', HIPPO_ACCEPTANCE_EXECUTION_MODE: 'isolated-production-equivalent',
    HIPPO_ACCEPTANCE_TARGET_URL: 'http://hippocampus-acceptance:3000/mcp',
    HIPPO_ACCEPTANCE_VOLUME_NAME: 'pr-acceptance-a1b2c3d4e5f6_acceptance-data',
    HIPPO_ACCEPTANCE_BUILD_SHA: 'a'.repeat(40), HIPPO_ACCEPTANCE_BEARER_TOKEN: 'synthetic-token',
    HIPPO_ACCEPTANCE_AUTH_KIND: 'legacy' } as NodeJS.ProcessEnv;
  requireSyntheticAcceptanceMode(env);
  assert.equal(acceptanceExecutionMode(env), 'isolated-production-equivalent');
  assert.equal(validateAcceptanceTarget(env.HIPPO_ACCEPTANCE_TARGET_URL!, 'isolated-production-equivalent').hostname, 'hippocampus-acceptance');
  assert.throws(() => validateAcceptanceTarget('https://production.example/mcp', 'isolated-production-equivalent'), /target must be HTTPS/);
  assert.throws(() => requireSyntheticAcceptanceMode({ ...env, HIPPO_ACCEPTANCE_VOLUME_NAME: 'hippo-data' }), /fresh project-scoped volume/);
  assert.throws(() => requireSyntheticAcceptanceMode({ ...env, HIPPO_ACCEPTANCE_TARGET_URL: 'http://127.0.0.1:3000/mcp' }), /fixed Compose endpoint/);
  assert.throws(() => acceptanceExecutionMode({ ...env, HIPPO_ACCEPTANCE_EXECUTION_MODE: 'isolated' } as NodeJS.ProcessEnv), /must be live-safe/);
});

test('machine report rejects bearer and synthetic content while keeping identity type/source only', () => {
  const report = { schema: 'hippocampus-personal-reflection-acceptance/v1', identity_type: 'agent',
    identity_source: 'bearer-sha256-derived', checks: { A: { status: 'PASS' } } };
  assert.equal(serializeSafeAcceptanceReport(report, ['raw-bearer', 'synthetic narrative']), JSON.stringify(report, null, 2));
  assert.throws(() => serializeSafeAcceptanceReport({ ...report, evidence: 'raw-bearer' }, ['raw-bearer']), /forbidden credential/);
  assert.throws(() => serializeSafeAcceptanceReport({ ...report, evidence: 'synthetic narrative' }, ['synthetic narrative']), /forbidden credential/);
  assert.doesNotMatch(serializeSafeAcceptanceReport(report, ['raw-bearer']), /authenticated_principal|client_id|raw-bearer/);
});

test('A cannot pass without a positive pre-ranking trace for each retrieval surface', () => {
  const valid = { surface: 'legacy-global', candidate_stage: 'before-cosine-ranking-limit', candidate_count: 1,
    expected_probe_in_candidates: true, forbidden_scope_in_candidates: false,
    expected_probe_in_results: true, forbidden_scope_in_results: false };
  assert.equal(preRankingCandidateProofPasses(valid, 'legacy-global'), true);
  assert.equal(preRankingCandidateProofPasses({ ...valid, candidate_stage: 'after-ranking' }, 'legacy-global'), false);
  assert.equal(preRankingCandidateProofPasses({ ...valid, expected_probe_in_candidates: false }, 'legacy-global'), false);
  assert.equal(preRankingCandidateProofPasses({ ...valid, forbidden_scope_in_candidates: true }, 'legacy-global'), false);
  assert.equal(preRankingCandidateProofPasses(undefined, 'legacy-global'), false);
  assert.equal(preRankingCandidateProofPasses(valid, 'personal-reflection'), false);
});
