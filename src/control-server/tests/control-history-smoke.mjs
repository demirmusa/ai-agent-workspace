// Opt-in actual Codex history/resume proof. Uses the current login without copying auth.
// Codex keeps the two turns in its normal session history; project and API data are temporary.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../../dist/control-server/server.js';

const directory = await mkdtemp(join(tmpdir(), 'aiws-history-proof-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const marker = `history_${randomUUID()}`; const started = Date.now(); let server;
async function waitForTask(service, taskId) {
  const deadline = Date.now() + Number(process.env.AIWS_SMOKE_TIMEOUT_MS ?? 120_000);
  while (Date.now() < deadline) {
    const task = service.task(taskId);
    if (['review', 'done', 'failed', 'cancelled'].includes(task.status)) { assert.ok(['review', 'done'].includes(task.status), `Provider task ended ${task.status}`); return task; }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Bounded Codex session proof timed out.');
}
try {
  const token = randomUUID(); server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'), token });
  const service = server.service; service.updateSettings({ executionMode: 'native', autoSyncSeconds: 0 });
  const project = service.createProject({ name: 'Isolated original-session resume', repositoryPath: workspace });
  const seed = service.createTask({ projectId: project.id, title: 'Remember a harmless history proof nonce', provider: 'codex', description: `Remember this proof nonce for our next conversation turn: ${marker}. Reply only SEED_REMEMBERED. Do not write files, run tools, ask questions or create tasks.` });
  const initialRun = service.startTask(seed.id); await waitForTask(service, seed.id);
  const originalSessionId = service.run(initialRun.id).sessionId; assert.ok(originalSessionId, 'Codex did not report its original session UUID.');
  // Remove the API seed record so the new turn cannot obtain the nonce from control state.
  service.deleteTask(seed.id);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`${server.url}/api${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.equal(response.ok, true, result.error); return result;
  };
  const before = service.snapshot(); const diskBefore = await readFile(service.store.path, 'utf8');
  const list = await request(`/projects/${project.id}/sessions?provider=codex&refresh=1&limit=50`);
  const historical = list.items.find((session) => session.sessionId === originalSessionId);
  assert.ok(historical, 'The project history did not discover the actual original Codex session.');
  const detail = await request(`/projects/${project.id}/sessions/${historical.id}`);
  assert.equal(detail.session.sessionId, originalSessionId); assert.equal(detail.session.provider, 'codex');
  assert.ok(detail.messages.length || detail.events.length, 'The historical transcript was empty.');
  assert.deepEqual(service.snapshot(), before); assert.equal(await readFile(service.store.path, 'utf8'), diskBefore);
  const resumed = await request(`/projects/${project.id}/sessions/${historical.id}/resume`, 'POST', { terminalMode: 'stream', message: 'Continue our original conversation. Write the proof nonce remembered in the preceding turn into resumed.txt, exactly, with no other text. The nonce is intentionally absent from this new instruction and from control state. Use the retained conversation context. Do not create tasks or access the control API. Do not change other files.' });
  const finalTask = await waitForTask(service, resumed.task.id); const finalRun = service.run(finalTask.currentRunId);
  assert.equal(finalRun.provider, 'codex'); assert.equal(finalRun.sessionId, originalSessionId); assert.equal(finalRun.historyResume.sessionId, originalSessionId);
  assert.equal((await readFile(join(workspace, 'resumed.txt'), 'utf8')).trim(), marker);
  console.log(JSON.stringify({ provider: 'codex', discoveredOwnProjectSession: true, readTranscriptWithoutMutation: true, originalSessionUuidPreserved: true, rememberedPriorTurnNonce: true, explicitContinueVerified: true, elapsedSeconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
