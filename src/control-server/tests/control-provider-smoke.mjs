// Opt-in genuine provider check. Uses the current account and may consume provider usage.
// All task files, skills and control data live in a fresh OS temporary directory.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../../dist/control-server/server.js';

const provider = process.env.AIWS_SMOKE_PROVIDER ?? 'codex';
if (!['codex', 'claude', 'opencode'].includes(provider)) throw new Error('AIWS_SMOKE_PROVIDER must be codex, claude or opencode.');
const timeoutMs = Number(process.env.AIWS_SMOKE_TIMEOUT_MS ?? 180_000);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('AIWS_SMOKE_TIMEOUT_MS must be a positive number.');
const directory = await mkdtemp(join(tmpdir(), 'aiws-provider-proof-'));
const workspace = join(directory, 'workspace');
const source = join(directory, 'source-skill');
let server;
const started = Date.now();
const expected = { context_marker: `context_${randomUUID()}`, skill_marker: `skill_${randomUUID()}`, resource_marker: `resource_${randomUUID()}` };
try {
  await mkdir(workspace); await mkdir(join(source, 'resources'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), `---\nname: provider-proof\ndescription: Verify instruction and resource delivery.\n---\n\n# Provider proof\n\nThe skill_marker for the proof is ${expected.skill_marker}.\nRead resources/proof.json from this installed skill directory to obtain resource_marker. Read the actual file; never invent a value.\n`);
  await writeFile(join(source, 'resources', 'proof.json'), JSON.stringify({ resource_marker: expected.resource_marker }));
  const token = randomUUID();
  server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'), token });
  const post = async (path, value) => {
    const response = await fetch(`${server.url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(value) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error ?? `HTTP ${response.status}`); return result;
  };
  const service = server.service;
  service.updateSettings({ executionMode: 'native', autoSyncSeconds: 0 });
  const project = await post('/api/projects', { name: 'Isolated provider proof', repositoryPath: workspace });
  const skill = await post('/api/skills/import', { directory: source });
  const agent = await post('/api/agents', { name: 'Provider proof agent', provider,
    ...(process.env.AIWS_SMOKE_MODEL ? { model: process.env.AIWS_SMOKE_MODEL } : {}),
    instructions: 'Perform only the requested proof. Write proof.json in the current workspace. It must be a JSON object containing context_marker, skill_marker and resource_marker. Obtain their exact values from the assigned background context, assigned skill instructions and its supporting resource file, respectively. Actually read the resource file. Do not change other files or call external APIs. Report completion briefly.',
    context: `The context_marker for this run is ${expected.context_marker}.`, skillIds: [skill.id], enabled: true });
  const task = await post('/api/tasks', { projectId: project.id, title: 'Verify the assigned agent and skill context', description: 'Follow the assigned agent instructions and skill. Create the proof artifact in this workspace.', agentId: agent.id, provider: null, model: null });
  const run = await post(`/api/tasks/${task.id}/run`, {});
  const limit = Date.now() + timeoutMs;
  let current;
  while (Date.now() < limit) {
    current = service.snapshot().runs.find((item) => item.id === run.id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current?.status)) break;
    await new Promise((done) => setTimeout(done, 300));
  }
  assert.equal(current?.status, 'completed', `Provider run ${run.id} ended with ${current?.status ?? 'missing'}. Check provider authentication, model availability and the native CLI.`);
  const snapshot = current.executionSnapshot;
  assert.equal(snapshot.agent.id, agent.id);
  assert.equal(snapshot.context, agent.context);
  assert.equal(snapshot.skills[0].id, skill.id);
  assert.equal(snapshot.skills[0].files.some((file) => file.path === 'resources/proof.json'), true);
  const proof = JSON.parse(await readFile(join(workspace, 'proof.json'), 'utf8'));
  assert.deepEqual(proof, expected, 'The genuine model did not reproduce all three isolated instruction/resource values.');
  console.log(JSON.stringify({ provider, genuineProviderRun: true, profileContextVerified: true, skillInstructionsVerified: true, supportingResourceVerified: true, executionSnapshotVerified: true, taskStatus: service.task(task.id).status, elapsedSeconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} catch (error) {
  const secrets = Object.entries(process.env).filter(([name, value]) => /TOKEN|KEY|PASSWORD|SECRET/i.test(name) && value && value.length >= 4).map(([, value]) => value);
  const redact = (value) => secrets.reduce((message, secret) => message.split(secret).join('[redacted]'), value).replace(/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{25,})\b/g, '[redacted]');
  const diagnostics = server?.service.snapshot().events.filter((event) => ['stdout', 'stderr', 'failed', 'interrupted'].includes(event.type)).slice(-4).map((event) => ({ type: event.type, message: redact(event.message).slice(0, 1400) }));
  console.error(JSON.stringify({ provider, genuineProviderRun: false, diagnostics }, null, 2));
  throw error;
} finally {
  if (server) await server.close();
  await rm(directory, { recursive: true, force: true });
}
