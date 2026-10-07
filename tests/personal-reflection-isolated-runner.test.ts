import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('isolated runner failure still removes its fresh Compose volume', { skip: process.platform === 'win32' || process.env.HIPPO_ACCEPTANCE_TEST_DOCKER_GUARD !== '1' }, () => {
  const repo = process.cwd();
  const temp = mkdtempSync(join(tmpdir(), 'hippo-acceptance-runner-'));
  try {
    const log = join(temp, 'docker.log');
    const mockDocker = join(temp, 'docker');
    writeFileSync(mockDocker, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$MOCK_DOCKER_LOG"\nif [[ "$1" == compose && "$2" == version ]]; then exit 0; fi\nif [[ "$1" == compose && " $* " == *" up "* ]]; then exit 23; fi\nif [[ "$1" == compose && " $* " == *" down "* ]]; then exit 0; fi\nif [[ "$1" == volume && "$2" == inspect ]]; then exit 1; fi\nexit 0\n`);
    chmodSync(mockDocker, 0o755);
    const result = spawnSync('bash', ['scripts/run-personal-reflection-isolated-acceptance.sh'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${temp}${delimiter}${process.env.PATH ?? ''}`, MOCK_DOCKER_LOG: log },
    });
    assert.equal(result.status, 23, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stdout, /ISOLATED_VOLUME_CLEANUP=PASS/);
    const dockerCalls = readFileSync(log, 'utf8');
    assert.match(dockerCalls, /down .*--volumes --remove-orphans/);
    assert.match(dockerCalls, /volume inspect pr-acceptance-[a-f0-9]{12}_acceptance-data/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}\n${dockerCalls}`, /hippo-data/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
