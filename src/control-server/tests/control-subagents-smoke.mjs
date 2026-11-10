// Opt-in real Codex native TUI + actual subagent-source proof. Uses existing login.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../../dist/control-server/server.js';
const root = await mkdtemp(join(tmpdir(), 'aiws-real-subagents-')); const workspace = join(root, 'workspace'); await mkdir(workspace);
const nonce = randomUUID(); const markers = [`CHILD_A_${nonce}`, `CHILD_B_${nonce}`], rootOnly = `ROOT_ONLY_${randomUUID()}`;
const fixture = `Read-only test fixture ${nonce}.`; await writeFile(join(workspace, 'fixture.txt'), fixture);
let server, run; let trustAnswered = false, sawChildrenWhileParentActive = false, sawWorkingChild = false, sawNative = false; let previousOutput = '';
const began = Date.now();
const strip = text => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
try {
  const token = randomUUID(); server = await startControlServer({ host: '127.0.0.1', port: 0, token, dataDir: join(root, 'data') });
  const service = server.service; service.updateSettings({ autoSyncSeconds: 0, executionMode: 'native' });
  const project = service.createProject({ name: 'Real native subagent proof', repositoryPath: workspace });
  const task = service.createTask({ projectId: project.id, provider: 'codex', terminalMode: 'pty', title: 'Delegate two actual read-only native subagents and wait for both',
    description: `Use the provider's actual native spawn_agent tool to create exactly TWO independent explorer/read-only subagents. Both may only read fixture.txt in this temporary workspace; no files may be changed. Tell the first child to return exactly ${markers[0]} after reading the fixture; tell the second to return exactly ${markers[1]}. Do not pass this root-only marker to either child: ${rootOnly}. Explicitly tell both children NEVER to call aiws or any AIWS run controls. They only return results to you. Do not simulate delegation or answer on their behalf. Wait for BOTH actual children to finish, verify both markers, then explicitly complete THIS ROOT run with aiws control complete --run $AIWS_RUN_ID --summary Completed (use your shell's environment syntax). Do not complete before both children finish. No deployment, no other files, no account/config changes.` });
  run = service.startTask(task.id); const deadline = Date.now() + Number(process.env.AIWS_SMOKE_TIMEOUT_MS ?? 180000);
  const api = async path => { const response = await fetch(`${server.url}/api/${path}`, { headers: { authorization: `Bearer ${token}` } }); if (!response.ok) throw new Error(`Subagent API returned ${response.status}.`); return response.json(); };
  let graph;
  while (Date.now() < deadline) {
    const current = service.run(run.id); const output = service.terminal(run.id); sawNative ||= output.interactive && output.output.length > 100;
    const recent = output.output.startsWith(previousOutput) ? output.output.slice(previousOutput.length) : output.output; previousOutput = output.output;
    // Real xterm clients answer these queries automatically; emulate only terminal capabilities.
    if (recent.includes('\x1b[6n')) service.input(run.id, { data: '\x1b[1;1R' });
    if (/\x1b\]11;\?/.test(recent)) service.input(run.id, { data: '\x1b]11;rgb:0000/0000/0000\x1b\\' });
    if (/\x1b\]10;\?/.test(recent)) service.input(run.id, { data: '\x1b]10;rgb:ffff/ffff/ffff\x1b\\' });
    const clean = strip(output.output);
    if (!trustAnswered && /trust.{0,80}(?:folder|directory|workspace)|(?:folder|directory).{0,80}trust/is.test(clean) && /enter.{0,12}confirm/i.test(clean)) { service.input(run.id, { data: '\r' }); trustAnswered = true; }
    if (/usage limit reached|you.ve hit your session limit|out of extra usage/i.test(clean)) throw new Error('Provider account usage limit; no extra credits or automatic retry requested.');
    graph = await api(`runs/${run.id}/agents`); const children = graph.agentTree.agents.filter(node => node.parentId !== null);
    if (current.status === 'running' && children.length >= 2) { sawChildrenWhileParentActive = true; sawWorkingChild ||= children.some(node => ['running', 'pending', 'waiting'].includes(node.status)); }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) break;
    await new Promise(done => setTimeout(done, 1000));
  }
  const current = service.run(run.id); assert.equal(current.status, 'completed', `Real native parent did not explicitly complete (${current.status}).`);
  graph = await api(`runs/${run.id}/agents`); const children = graph.agentTree.agents.filter(node => node.parentId !== null);
  assert.equal(sawNative, true, 'Missing real native terminal output'); assert.equal(graph.sourceAvailable, true, 'Fresh native bootstrap marker did not bind a source');
  assert.equal(sawChildrenWhileParentActive, true, 'Children were not observable while their parent was active'); assert.equal(sawWorkingChild, true, 'No actual working child was observed');
  assert.equal(children.length, 2, 'Expected exactly two actual provider children'); assert.ok(children.every(node => ['completed', 'stopped'].includes(node.status)), 'Parent completed before children reported completion');
  const transcripts = [];
  for (const child of children) {
    const data = await api(`runs/${run.id}/agents/${encodeURIComponent(child.id)}/transcript`); const publicOutput = JSON.stringify({ events: data.events, messages: data.messages });
    assert.equal(child.readOnly, true); assert.ok(data.events.length > 0, 'Missing lazy child transcript'); assert.ok(!publicOutput.includes(rootOnly), 'Forked parent history leaked into selected child transcript'); transcripts.push(publicOutput);
  }
  for (const marker of markers) assert.ok(transcripts.some(output => output.includes(marker)), 'Missing actual child public result marker');
  assert.equal(await readFile(join(workspace, 'fixture.txt'), 'utf8'), fixture);
  console.log(JSON.stringify({ provider: 'codex', genuineNativeTui: true, uniqueBootstrapBinding: true, actualChildren: children.length, observedChildrenWhileParentActive: sawChildrenWhileParentActive, observedWorkingChild: sawWorkingChild, lazyChildPublicTranscripts: true, parentContextExcluded: true, allChildrenFinishedBeforeRootCompletion: true, elapsedSeconds: Math.round((Date.now() - began) / 1000) }, null, 2));
} catch (error) {
  if (server && run) console.error(JSON.stringify({ status: server.service.run(run.id).status, terminalBytes: server.service.run(run.id).terminalOutput?.length ?? 0, providerSessionKnown: Boolean(server.service.run(run.id).sessionId), observedChildrenWhileParentActive: sawChildrenWhileParentActive, observedWorkingChild: sawWorkingChild }));
  throw error;
} finally { if (server) await server.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
