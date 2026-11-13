// Opt-in genuine provider intake: no task or workspace mutation until explicit human Save.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startControlServer } from '../../dist/control-server/server.js';

const directory = await mkdtemp(join(tmpdir(), 'aiws-draft-proof-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const canary = '# Isolated intake proof\nProject files must remain unchanged.\n';
await writeFile(join(workspace, 'README.md'), canary);
const provider = process.env.AIWS_SMOKE_PROVIDER ?? 'codex';
const started = Date.now(); let server;
try {
  const token = randomUUID();
  server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'), token });
  const service = server.service; service.updateSettings({ executionMode: 'native', autoSyncSeconds: 0 });
  const project = service.createProject({ name: 'Isolated AI intake', repositoryPath: workspace });
  const planner = service.catalog.createAgent({ name: 'Read-only draft assistant', provider, instructions: 'Only fill the task draft. Do not execute code, change files, create tasks or call any control endpoint.' });
  const before = service.snapshot();
  const persistedBefore = await readFile(service.store.path, 'utf8');
  const response = await fetch(`${server.url}/api/projects/${project.id}/draft`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ agentId: planner.id, draft: { priority: 2, tags: ['accessibility'] }, messages: [{ role: 'user', text: 'Arama kutusuna klavyeyle erişebilmek için bir görev taslağı hazırlamak istiyorum.' }], message: 'Başlık ve açıklamayı Türkçe doldur; açıklamada Tab ile odaklanma ve Enter ile arama kabul ölçütleri bulunsun. Öncelik High olsun. Henüz kaydetme, başlatma veya dosya değiştirme; yalnız formu doldur.' }),
  });
  const result = await response.json(); assert.equal(response.ok, true, result.error);
  assert.ok(result.draft.title.trim()); assert.ok(result.draft.description.trim());
  assert.equal(result.draft.status, 'backlog'); assert.equal(result.draft.priority, 3);
  const afterDraft = service.snapshot();
  for (const name of ['tasks', 'runs', 'plannerMessages', 'messages', 'questions', 'events']) assert.equal(afterDraft[name].length, before[name].length, `${name} mutated during intake`);
  assert.deepEqual(afterDraft, before); assert.equal(await readFile(service.store.path, 'utf8'), persistedBefore);
  assert.deepEqual(await readdir(workspace), ['README.md']); assert.equal(await readFile(join(workspace, 'README.md'), 'utf8'), canary);
  const title = `${result.draft.title} — kullanıcı düzenlemesi`;
  const description = `${result.draft.description}\n\nKullanıcı ek kabul ölçütü: Escape odağı arama kutusuna döndürür.`;
  const saved = await fetch(`${server.url}/api/tasks`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...result.draft, projectId: project.id, title, description }) });
  const task = await saved.json(); assert.equal(saved.status, 201, task.error); assert.equal(task.title, title); assert.equal(task.description, description); assert.equal(service.snapshot().tasks.length, before.tasks.length + 1); assert.equal(service.snapshot().runs.length, before.runs.length);
  const deleted = await fetch(`${server.url}/api/tasks/${task.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
  assert.equal(deleted.status, 200); assert.equal(service.snapshot().tasks.length, before.tasks.length);
  console.log(JSON.stringify({ provider, genuineReadOnlyDraft: true, noTasksOrRunsBeforeSave: true, noPersistentConversation: true, persistentStateUnchanged: true, workspaceUnchanged: true, editedTitleAndDescriptionSaveVerified: true, taskDeletionVerified: true, elapsedSeconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
