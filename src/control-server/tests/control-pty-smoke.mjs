// Opt-in genuine native provider TUI check. Uses the current logged-in account.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../../dist/control-server/server.js';
const provider = process.env.AIWS_SMOKE_PROVIDER ?? 'codex';
if (!['codex', 'claude'].includes(provider)) throw new Error('Native TUI smoke supports codex or claude.');
const directory = await mkdtemp(join(tmpdir(), 'aiws-native-pty-proof-'));
const workspace = join(directory, 'workspace'); await mkdir(workspace);
const marker = `pty_${randomUUID()}`; const started = Date.now();
let server; let run; let trustAnswered = false; let sawInteractive = false;
const strip = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '');
try {
  server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: join(directory, 'data'), token: randomUUID() });
  const service = server.service; service.updateSettings({ autoSyncSeconds: 0, executionMode: 'native' });
  const project = service.createProject({ name: 'Genuine native TUI proof', repositoryPath: workspace });
  const agent = service.catalog.createAgent({ name: 'Native TUI proof agent', provider, terminalMode: 'pty',
    instructions: `Write proof.txt in the current workspace with exactly ${marker}. Then post a task message saying NATIVE_TUI_PROOF_FINISHED and explicitly complete this run using aiws control complete --run $AIWS_RUN_ID --summary "Native TUI proof completed". Use your shell's environment variable syntax correctly. Do not change other files. This task requires no user decision and no external task API.`, context: 'This is a small isolated temporary workspace for validating a real interactive terminal.' });
  const task = service.createTask({ projectId: project.id, title: 'Write the assigned native TUI proof artifact', description: 'Follow the configured agent instructions, then explicitly complete the work.', agentId: agent.id, provider: null, model: null, terminalMode: 'pty' });
  run = service.startTask(task.id);
  const limit = Date.now() + Number(process.env.AIWS_SMOKE_TIMEOUT_MS ?? 180_000);
  let current;
  while (Date.now() < limit) {
    current = service.snapshot().runs.find((entry) => entry.id === run.id);
    const terminal = service.terminal(run.id); sawInteractive ||= terminal.interactive;
    const clean = strip(terminal.output);
    if (/(?:usage limit reached|you.ve hit your session limit|out of extra usage)/i.test(clean)) throw new Error(`Native ${provider} reported an account usage limit; no additional credits or retry were requested.`);
    // Trust only the freshly generated, controlled temporary workspace when the native provider asks.
    if (!trustAnswered && /(?:trust.{0,80}(?:folder|directory)|(?:folder|directory).{0,80}trust|trust this workspace)/is.test(clean) && /enter.{0,12}confirm/i.test(clean)) {
      service.input(run.id, { data: provider === 'claude' ? '\x1b[B\r' : '\r' }); trustAnswered = true;
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current?.status)) break;
    await new Promise((done) => setTimeout(done, 400));
  }
  assert.equal(current?.status, 'completed', `Native ${provider} TUI did not explicitly complete (${current?.status}).`);
  assert.equal(sawInteractive, true); assert.equal(current.terminalMode, 'pty');
  assert.equal((await readFile(join(workspace, 'proof.txt'), 'utf8')).trim(), marker);
  assert.ok((current.terminalOutput ?? '').length > 100, 'Missing real terminal output');
  console.log(JSON.stringify({ provider, genuineNativeTui: true, ptyOutputBytes: current.terminalOutput.length, proofArtifactVerified: true, explicitCompletionVerified: true, elapsedSeconds: Math.round((Date.now() - started) / 1000) }, null, 2));
} catch (error) {
  const secrets = Object.entries(process.env).filter(([name, value]) => /TOKEN|KEY|PASSWORD|SECRET/i.test(name) && value && value.length >= 4).map(([, value]) => value);
  const redact = (text) => secrets.reduce((value, secret) => value.split(secret).join('[redacted]'), text).replace(/\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{25,})\b/g, '[redacted]');
  if (server && run) { const state = server.service.run(run.id); console.error(JSON.stringify({ provider, status: state.status, terminalTail: redact(strip(state.terminalOutput ?? '')).slice(-2500), eventErrors: server.service.snapshot().events.filter((event) => event.runId === run.id && ['failed', 'stderr'].includes(event.type)).slice(-3).map((event) => redact(event.message)) }, null, 2)); }
  throw error;
} finally { if (server) await server.close(); await rm(directory, { recursive: true, force: true }); }
