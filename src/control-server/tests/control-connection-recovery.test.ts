import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONNECTION_CONTINUE_MESSAGE, connectionErrorReason, rejectedRequestReason } from '../connection-recovery.js';
import { ControlService } from '../service.js';
import type { RuntimeCallbacks } from '../runner.js';

const runtime = vi.hoisted(() => ({ callbacks: null as RuntimeCallbacks | null, input: vi.fn(), stop: vi.fn(async () => {}) }));
vi.mock('../runner.js', () => ({ launchRuntime: (_p: unknown, _t: unknown, _r: unknown, _prompt: unknown, _options: unknown, callbacks: RuntimeCallbacks) => {
  runtime.callbacks = callbacks;
  return { input: runtime.input, stop: runtime.stop, pause: async () => 'suspended', resume: async () => {} };
} }));
const defaults = { quiet: ControlService.connectionQuietMs, attempts: ControlService.connectionRecoveryAttempts, probe: ControlService.connectivityProbe, delay: ControlService.terminalSubmitDelayMs };
let root: string, service: ControlService;
afterEach(async () => {
  if (service) await service.close(); if (root) rmSync(root, { recursive: true, force: true });
  runtime.input.mockReset(); runtime.stop.mockClear();
  ControlService.connectionQuietMs = defaults.quiet; ControlService.connectionRecoveryAttempts = defaults.attempts; ControlService.connectivityProbe = defaults.probe; ControlService.terminalSubmitDelayMs = defaults.delay;
});

const CUT = '\r\n● API Error: Connection lost mid-response. The response above may be incomplete.\r\n\r\n✻ Churned for 6m 56s · done 9:56 AM\r\n\r\n> ';
const REJECTED_MODEL = `■ {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`;
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
async function start() {
  ControlService.connectionQuietMs = 0; ControlService.terminalSubmitDelayMs = 0;
  root = mkdtempSync(join(tmpdir(), 'aiws-connection-')); service = await ControlService.open({ dataDir: join(root, 'data') });
  const project = service.createProject({ name: 'Connection', repositoryPath: root });
  const task = service.createTask({ projectId: project.id, title: 'Flaky network', provider: 'claude', terminalMode: 'pty' });
  const run = service.startTask(task.id);
  const tick = async () => { (service as any).tick(); await flush(); };
  const typed = () => runtime.input.mock.calls.map(([data]) => data);
  return { task, run, tick, typed, state: () => service.snapshot() };
}

describe('connection recovery', () => {
  it('recognizes provider connection errors but not usage limits, rejected requests or quoted text', () => {
    expect(connectionErrorReason(CUT)).toBe('API Error: Connection lost mid-response. The response above may be incomplete.');
    expect(connectionErrorReason('  ⎿  API Error: Request timed out.')).toBeTruthy();
    expect(connectionErrorReason('⏺ API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}')).toBeTruthy();
    expect(connectionErrorReason('■ stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)')).toBeTruthy();
    expect(connectionErrorReason('● API Error: 400 {"type":"invalid_request_error","message":"prompt is too long"}')).toBeUndefined();
    expect(connectionErrorReason('● API Error: Claude AI usage limit reached|1760000000')).toBeUndefined();
    expect(connectionErrorReason('● The run failed with "API Error: Connection lost" so I added a retry.')).toBeUndefined();
    expect(connectionErrorReason('All tests passed')).toBeUndefined();
    expect(rejectedRequestReason(REJECTED_MODEL)).toBe('Provider rejected the request (400): The \'gpt-6.1-sol\' model is not supported when using Codex with a ChatGPT account.');
    expect(rejectedRequestReason('● The API returned {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"quoted"}}')).toBeUndefined();
  });

  it('fails an interactive run when the provider rejects its configured model', async () => {
    const { run, task, tick, typed, state } = await start();
    runtime.callbacks!.output('terminal', `${REJECTED_MODEL}\r\n`);
    await tick();
    expect(typed()).toEqual([]);
    expect(state().runs.find((item) => item.id === run.id)).toMatchObject({ status: 'failed', exitCode: 1 });
    expect(state().tasks.find((item) => item.id === task.id)?.status).toBe('failed');
    expect(state().messages.some((message) => message.runId === run.id && message.text.includes('model is not supported'))).toBe(true);
    expect(runtime.stop).toHaveBeenCalled();
  });

  it('continues an interactive run whose turn a dropped connection cut off', async () => {
    ControlService.connectivityProbe = async () => true;
    const { run, tick, typed, state } = await start();
    runtime.callbacks!.output('terminal', CUT);
    await tick();
    expect(typed()).toEqual([CONNECTION_CONTINUE_MESSAGE, '\r']);
    expect(state().runs.find((item) => item.id === run.id)?.status).toBe('running');
    expect(state().events.some((event) => event.type === 'connection.resume')).toBe(true);
    // The typed Enter cleared the screen buffer, so the same notice is not resumed twice.
    await tick();
    expect(typed()).toHaveLength(2);
  });

  it('waits for the internet connection before continuing', async () => {
    let online = false; ControlService.connectivityProbe = async () => online;
    const { run, task, tick, typed, state } = await start();
    runtime.callbacks!.output('terminal', CUT);
    await tick();
    expect(typed()).toEqual([]);
    expect(state().runs.find((item) => item.id === run.id)?.status).toBe('waiting');
    expect(state().tasks.find((item) => item.id === task.id)?.status).toBe('waiting');
    expect(state().messages.some((message) => message.taskId === task.id && /internet connection is back/.test(message.text))).toBe(true);
    online = true;
    (service as any).connectionWatch.recoveries.get(run.id).nextAt = 0;
    await tick();
    expect(typed()).toEqual([CONNECTION_CONTINUE_MESSAGE, '\r']);
    expect(state().runs.find((item) => item.id === run.id)?.status).toBe('running');
  });

  it('leaves a busy terminal alone and fails the run after repeated connection losses', async () => {
    ControlService.connectivityProbe = async () => true; ControlService.connectionRecoveryAttempts = 1;
    const { run, tick, typed, state } = await start();
    ControlService.connectionQuietMs = 60_000;
    runtime.callbacks!.output('terminal', CUT);
    await tick();
    expect(typed()).toEqual([]);
    ControlService.connectionQuietMs = 0;
    await tick();
    expect(typed()).toHaveLength(2);
    runtime.callbacks!.output('terminal', CUT);
    (service as any).connectionWatch.recoveries.get(run.id).nextAt = 0;
    await tick();
    expect(typed()).toHaveLength(2);
    expect(state().runs.find((item) => item.id === run.id)?.status).toBe('failed');
    expect(runtime.stop).toHaveBeenCalled();
  });
});
