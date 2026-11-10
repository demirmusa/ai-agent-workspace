// Opt-in genuine planning provider plus real, harmless named-agent workflow commands.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { startControlServer } from '../../dist/control-server/server.js';
const directory = await mkdtemp(join(tmpdir(), 'aiws-planning-proof-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const provider = process.env.AIWS_SMOKE_PROVIDER ?? 'codex'; const started = Date.now();
let server;
try {
  const token = randomUUID(); server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'), token });
  const service = server.service; service.updateSettings({ executionMode: 'native', autoSyncSeconds: 0 });
  const project = service.createProject({ name: 'Isolated planning and pipeline proof', description: 'All workflow stages are harmless local validation commands. No real server deployment must be claimed.', repositoryPath: workspace });
  const args = ['-e', 'const fs=require("fs");let prompt="";process.stdin.on("data",x=>prompt+=x);process.stdin.on("end",()=>{fs.appendFileSync("stages.jsonl",JSON.stringify({agentId:process.env.AIWS_AGENT_ID,directorySeen:prompt.includes("Configured agent directory")})+"\\n");console.log("LOCAL_WORKFLOW_STAGE_VERIFIED")})'];
  const first = service.catalog.createAgent({ name: 'Frontend implementation validator', provider: 'command', capabilities: ['frontend', 'implementation'], description: 'Harmless isolated validation command, not actual product implementation.', command: { executable: process.execPath, args } });
  const deploy = service.catalog.createAgent({ name: 'Build and deployment validator', provider: 'command', capabilities: ['build', 'deploy'], description: 'Harmless validation command. It records the handoff; never claims a real server deployment.', command: { executable: process.execPath, args } });
  const planner = service.catalog.createAgent({ name: 'Genuine planning assistant', provider, capabilities: ['planning'], instructions: 'Use the configured validation agents and workflow to create the one requested ready task. Interpret the requested follow-up semantically. Do not run task commands in this planning turn.' });
  const workflow = service.workflows.create({ name: 'Mandatory frontend then requested deployment validation', projectId: project.id, trigger: 'always', steps: [{ name: 'Frontend step', agentId: first.id, condition: 'always', instructions: 'Run only the configured harmless validation command.' }, { name: 'Requested build/deploy step', agentId: deploy.id, condition: 'deploy_requested', instructions: 'Record the validation handoff only; no real server deployment.' }] });
  const response = await fetch(`${server.url}/api/projects/${project.id}/plan`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agentId: planner.id, message: 'Bu yalıtılmış doğrulama projesinde arama düğmesi erişilebilirliği için tek bir görev oluştur ve hazır kuyruğuna al. İş bitince sonucu tanımlı build/dağıtım ajanına sunucuya gönderme adımı için devret. Buradaki ajanların yalnız yerel doğrulama komutları çalıştırdığını belirt; gerçek sunucuya deploy yapıldığını iddia etme. Mevcut zorunlu workflow kullanılsın.' }) });
  const result = await response.json(); assert.equal(response.ok, true, result.error);
  assert.equal(result.tasks.length, 1); const taskId = result.tasks[0].id;
  assert.equal(result.tasks[0].workflowId, workflow.id); assert.ok(result.tasks[0].requestedActions.includes('deploy'));
  const limit = Date.now() + 30_000; let task;
  while (Date.now() < limit) { task = service.task(taskId); if (['review', 'failed', 'cancelled'].includes(task.status)) break; await new Promise((done) => setTimeout(done, 200)); }
  assert.equal(task.status, 'review'); assert.equal(task.workflowProgress.status, 'completed');
  const stages = (await readFile(join(workspace, 'stages.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(stages.map((stage) => stage.agentId), [first.id, deploy.id]); assert.ok(stages.every((stage) => stage.directorySeen));
  assert.equal(service.snapshot().runs.filter((run) => run.taskId === taskId).length, 2);
  assert.equal(service.snapshot().plannerMessages.filter((message) => message.projectId === project.id && message.role === 'assistant')[0].taskIds[0], taskId);
  console.log(JSON.stringify({ provider, genuinePlanningProvider: true, realTaskCreated: true, semanticDeployIntent: true, orderedNamedAgentHandoff: true, readyAutoDispatch: true, noRealDeploymentClaimed: true, elapsedSeconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
