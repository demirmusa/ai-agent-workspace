import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { buildDefaultRepoConfig, buildDefaultInstallationState } from '../../dist/shared/config/defaults.js';
import { materializeRuntime } from '../../dist/runtime/materialize.js';
import { writeRuntimeSecrets } from '../../dist/runtime/secrets.js';

const runner = 'aiws-validation-runner:local';
const agent = 'aiws-validation-agent:local';
const directory = await mkdtemp(join(tmpdir(), 'aiws-docker-smoke-'));
const volume = `aiws-smoke-auth-${process.pid}-${Date.now()}`;
const oldHome = process.env.AIWS_HOME;
const docker = (args, expected = 0) => {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 600_000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, expected, `${args.slice(0, 5).join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
};
try {
  if (process.env.AIWS_TEST_SKIP_BUILD !== '1') {
    for (const [file, tag] of [['Dockerfile.runner', runner], ['Dockerfile.agent', agent]]) {
      console.log(`Building ${file}...`);
      docker(['build', '--quiet', '-f', `assets/runtime/${file}`, '-t', tag, 'assets/runtime']);
    }
  }
  const config = buildDefaultRepoConfig('owner/repo');
  config.orchestration.maxConcurrent = 10;
  config.agents.profiles.push({ id: 'free', provider: 'opencode', model: 'opencode/example-free', effort: 'medium', triggerLabel: 'agent:free' });
  await writeFile(join(directory, 'config.json'), JSON.stringify(config));
  await writeFile(join(directory, 'invalid.json'), JSON.stringify({ ...config, orchestration: { enabled: true, maxConcurrent: 0 } }));
  const legacy = structuredClone(config);
  delete legacy.orchestration; delete legacy.organization; delete legacy.review;
  await writeFile(join(directory, 'legacy.json'), JSON.stringify(legacy));
  const mount = ['--mount', `type=bind,source=${directory},target=/fixtures,readonly`];
  for (const file of ['config.json', 'legacy.json']) {
    const output = docker(['run', '--rm', ...mount, '-e', 'AIWS_REPOSITORY=owner/repo', '--entrypoint', 'bash', runner, '/opt/aiws/bin/load-config.sh', `/fixtures/${file}`]);
    assert.equal(JSON.parse(output).valid, true);
  }
  docker(['run', '--rm', ...mount, '-e', 'AIWS_REPOSITORY=owner/repo', '--entrypoint', 'bash', runner, '/opt/aiws/bin/load-config.sh', '/fixtures/invalid.json'], 2);
  docker(['run', '--rm', '--entrypoint', 'bash', runner, '-c', 'set -e; for f in /opt/aiws/bin/*.sh; do bash -n "$f"; done; python3 -B /opt/aiws/bin/scheduler.py --help >/dev/null']);
  const profile = docker(['run', '--rm', ...mount, '-e', 'AIWS_REPOSITORY=owner/repo', '--entrypoint', 'bash', runner, '/opt/aiws/bin/resolve-provider.sh', '/fixtures/config.json', '["agent:free"]']);
  assert.equal(JSON.parse(profile).provider, 'opencode');
  docker(['run', '--rm', '--mount', `type=bind,source=${resolve('runtime/tests')},target=/tests,readonly`, '--entrypoint', 'bash', runner, '/tests/runtime-smoke.sh']);
  for (const args of [['codex', 'exec', '--ignore-user-config', '--help'], ['codex', 'login', '--help'], ['claude', '--version'], ['opencode', '--version'], ['opencode', 'run', '--help'], ['opencode', 'auth', 'login', '--help']]) {
    docker(['run', '--rm', agent, ...args]);
  }
  // Verify volume ownership and persistence without using real credentials.
  docker(['run', '--rm', '-v', `${volume}:/home/agent/.local/share/opencode`, agent, 'bash', '-c', 'umask 077; printf persistent > /home/agent/.local/share/opencode/aiws-smoke']);
  assert.equal(docker(['run', '--rm', '-v', `${volume}:/home/agent/.local/share/opencode`, agent, 'cat', '/home/agent/.local/share/opencode/aiws-smoke']).trim(), 'persistent');
  process.env.AIWS_HOME = join(directory, 'control');
  const installation = buildDefaultInstallationState(config);
  const runtime = await materializeRuntime(config, installation, resolve('assets'), { dockerGid: 0 });
  await writeRuntimeSecrets(runtime, { runnerToken: 'validation-only-not-real', automationToken: 'validation-only-not-real' });
  const compose = JSON.parse(docker(['compose', '-f', join(runtime, 'compose.yaml'), 'config', '--format', 'json']));
  assert.equal(Object.keys(compose.services).filter((name) => /^runner(?:-\d+)?$/.test(name)).length, 10);
  const workspaces = Object.values(compose.services).filter((service) => service.environment?.AIWS_WORKSPACE_VOLUME).map((service) => service.environment.AIWS_WORKSPACE_VOLUME);
  assert.equal(new Set(workspaces).size, 10);
  assert.ok(compose.services['queue-poller']);
  assert.equal(compose.services['runner-10'].environment.AIWS_OPENCODE_AUTH_VOLUME, installation.names.volumes.opencodeAuth);
  console.log('Docker smoke passed: all providers start, configs validate, auth volume persists, 10 isolated workers render.');
} finally {
  spawnSync('docker', ['volume', 'rm', volume], { encoding: 'utf8' });
  if (oldHome === undefined) delete process.env.AIWS_HOME; else process.env.AIWS_HOME = oldHome;
  await rm(directory, { recursive: true, force: true });
}
