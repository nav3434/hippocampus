import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { derivePrincipal, requireSyntheticAcceptanceMode, validateAcceptanceTarget } from '../scripts/personal-reflection-acceptance-core.js';

test('principal derivation matches the production auth identity rules without returning the bearer', () => {
  const token = 'synthetic-only acceptance token';
  const hash = createHash('sha256').update(token).digest('hex');
  assert.equal(derivePrincipal('agent', token), `agent:${hash}`);
  assert.equal(derivePrincipal('legacy', token), `legacy:${hash}`);
  assert.equal(derivePrincipal('oauth', token, 'registered-client'), 'oauth:registered-client');
  assert.throws(() => derivePrincipal('oauth', token), /OAuth client ID/);
});

test('acceptance mode is explicit and target URL cannot carry credentials', () => {
  const env = { HIPPO_ACCEPTANCE_MODE: 'synthetic-only', HIPPO_ACCEPTANCE_TARGET_URL: 'https://hippo.example/mcp',
    HIPPO_ACCEPTANCE_BEARER_TOKEN: 'synthetic-token', HIPPO_ACCEPTANCE_AUTH_KIND: 'agent' } as NodeJS.ProcessEnv;
  assert.doesNotThrow(() => requireSyntheticAcceptanceMode(env));
  assert.equal(validateAcceptanceTarget(env.HIPPO_ACCEPTANCE_TARGET_URL!).origin, 'https://hippo.example');
  assert.throws(() => validateAcceptanceTarget('http://hippo.example/mcp'), /target must be HTTPS/);
  assert.throws(() => validateAcceptanceTarget('https://user:pass@hippo.example/mcp'), /target must be HTTPS/);
  assert.throws(() => validateAcceptanceTarget('https://hippo.example/not-mcp'), /target must be HTTPS/);
  assert.throws(() => requireSyntheticAcceptanceMode({ ...env, HIPPO_ACCEPTANCE_MODE: 'production' }), /synthetic-only/);
});
