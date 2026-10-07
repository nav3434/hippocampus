import assert from 'node:assert/strict';
import test from 'node:test';

process.env.HIPPO_PASSPHRASE = 'synthetic-acceptance-config-test-passphrase';
const { isIsolatedPersonalReflectionAcceptanceConfigSafe } = await import('../src/config.js');

test('backend acceptance hooks require the fixed database path, fresh project volume, and immutable SHA', () => {
  assert.equal(isIsolatedPersonalReflectionAcceptanceConfigSafe(undefined, './data/hippocampus.db', '', ''), true);
  assert.equal(isIsolatedPersonalReflectionAcceptanceConfigSafe('isolated-v1', '/data/hippocampus.db',
    'pr-acceptance-a1b2c3d4e5f6_acceptance-data', 'a'.repeat(40)), true);
  assert.equal(isIsolatedPersonalReflectionAcceptanceConfigSafe('isolated-v1', '/prod/hippocampus.db',
    'pr-acceptance-a1b2c3d4e5f6_acceptance-data', 'a'.repeat(40)), false);
  assert.equal(isIsolatedPersonalReflectionAcceptanceConfigSafe('isolated-v1', '/data/hippocampus.db', 'hippocampus-data', 'a'.repeat(40)), false);
  assert.equal(isIsolatedPersonalReflectionAcceptanceConfigSafe('isolated-v1', '/data/hippocampus.db',
    'pr-acceptance-a1b2c3d4e5f6_acceptance-data', 'unknown'), false);
});
