import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';
import { launchRuntime } from '../runner.js';
import { providerUsageResetAt, USAGE_LIMIT_CONTINUE_MESSAGE, usageLimitReason, usageLimitResetAt } from '../agent-handoff.js';
import { terminalTranscript } from '../service/common.js';

vi.mock('../runner.js', async importOriginal => ({ ...await importOriginal<typeof import('../runner.js')>(), launchRuntime: vi.fn((_project, _task, _run, _prompt, _options, io) => ({ pid: undefined, stop: async () => io.close(130), pause: async () => 'checkpoint', resume: async () => {}, input: vi.fn() })) }));
const roots: string[] = [], services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map(service => service.close())); vi.clearAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(terminalMode: 'stream' | 'pty' = 'stream') {
  const root = mkdtempSync(join(tmpdir(), 'aiws-handoff-')); roots.push(root);
  const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const service = await ControlService.open({ dataDir: join(root, 'data'), history: { codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }, liveSessions: { evidence: async () => ({ processes: [], owners: {} }) } }); services.push(service);
  const project = service.createProject({ name: 'Handoff', repositoryPath: workspace });
  const task = service.createTask({ projectId: project.id, title: 'Build feature', description: 'Implement the feature end to end', provider: 'claude', terminalMode });
  return { service, task, project };
}
const callbacks = (runId: string) => vi.mocked(launchRuntime).mock.calls.find(call => call[2].id === runId)![5];

describe('agent handoff after a usage limit', () => {
  it('recognizes provider usage-limit notices but not ordinary rate limits', () => {
    expect(usageLimitReason('Claude AI usage limit reached|1760000000')).toContain('usage limit reached');
    expect(usageLimitReason("■ You've hit your usage limit. Upgrade to Pro or try again in 2 hours.")).toContain('hit your usage limit');
    expect(usageLimitReason('You have exceeded your monthly quota (Request ID: 2885:30E838)')).toContain('exceeded your monthly quota');
    expect(usageLimitReason('│ 5-hour limit reached ∙ resets 3pm │')).toBe('5-hour limit reached ∙ resets 3pm');
    expect(usageLimitReason('{"code":"insufficient_quota"}')).toBeTruthy();
    expect(usageLimitReason('API retry after rate limit: 429')).toBeUndefined();
    expect(usageLimitReason('All tests passed')).toBeUndefined();
  });
  it('asks who continues when a stream agent runs out of tokens', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id);
    const io = callbacks(run.id);
    io.output('stdout', `${JSON.stringify({ type: 'result', is_error: true, result: 'Claude AI usage limit reached|1760000000' })}\n`);
    io.close(1);
    const stored = service.task(task.id);
    expect(stored.handoffRequest).toMatchObject({ runId: run.id, provider: 'claude', agentName: 'claude' });
    expect(service.publicState().messages.some(message => message.taskId === task.id && /ran out of tokens/.test(message.text))).toBe(true);
    service.dismissHandoff(task.id); expect(service.task(task.id).handoffRequest).toBeUndefined();
  });
  it('continues with a clean agent by default, giving it the task and the Git review brief', async () => {
    const { service, task, project } = await fixture(); const run = service.startTask(task.id);
    service.postMessage(task.id, { text: 'Implemented the API; UI still missing.', authorType: 'agent' });
    const io = callbacks(run.id); io.output('stderr', "You've hit your usage limit. Try again later.\n"); io.close(1);
    expect(project.agentHandoffMode ?? 'fresh').toBe('fresh');
    const { run: next } = await service.handoffTask(task.id, { provider: 'codex' });
    expect(next).toMatchObject({ provider: 'codex', handoff: { fromRunId: run.id, fromProvider: 'claude', mode: 'fresh' } });
    expect(next.executionSnapshot?.task.description).toBe('Implement the feature end to end');
    expect(next.executionSnapshot?.context).toContain('AGENT HANDOFF');
    expect(next.executionSnapshot?.context).toContain('git status');
    expect(next.executionSnapshot?.context).toContain('UI still missing');
    expect(next.workspacePath).toBe(service.run(run.id).workspacePath);
    expect(service.task(task.id)).toMatchObject({ currentRunId: next.id, provider: 'codex' });
    expect(service.task(task.id).handoffRequest).toBeUndefined();
  });
  it('copies the whole conversation when the project prefers transcript handoffs, stopping a still open terminal', async () => {
    const { service, task, project } = await fixture('pty');
    service.updateProject(project.id, { agentHandoffMode: 'transcript' });
    expect(() => service.updateProject(project.id, { agentHandoffMode: 'sometimes' })).toThrow('agentHandoffMode');
    const run = service.startTask(task.id);
    service.postMessage(task.id, { text: 'EARLY_DETAIL from the first agent', authorType: 'agent' });
    callbacks(run.id).output('terminal', '\x1b[2J\x1b[H╭────╮\r\n│ 5-hour limit reached ∙ resets 3pm │\r\n');
    expect(service.task(task.id).handoffRequest?.reason).toContain('5-hour limit reached');
    const { run: next } = await service.handoffTask(task.id, { provider: 'codex' });
    expect(service.run(run.id).status).toBe('cancelled');
    expect(next.handoff?.mode).toBe('transcript');
    expect(next.executionSnapshot?.context).toContain('<previous-conversation>');
    expect(next.executionSnapshot?.context).toContain('EARLY_DETAIL');
  });
  it('rejects an unknown or disabled target', async () => {
    const { service, task } = await fixture(); const run = service.startTask(task.id); callbacks(run.id).close(1);
    await expect(service.handoffTask(task.id, { provider: 'nobody' })).rejects.toThrow('Select an agent or a provider');
    await expect(service.handoffTask(task.id, { provider: 'codex', mode: 'copy' })).rejects.toThrow('mode must be fresh or transcript');
  });
  it('parses quota reset timestamps from CLI output and provider usage windows', () => {
    const base = Date.parse('2026-11-05T13:00:00.000Z');
    expect(usageLimitResetAt('Individual quota reached. Resets in 87h23m28s.', base)).toBe(base + ((87 * 60 + 23) * 60 + 28) * 1000);
    expect(usageLimitResetAt('Claude AI usage limit reached|1793887200', base)).toBe(1793887200 * 1000);
    expect(usageLimitResetAt("You've hit your usage limit. Try again in 2 hours 15 minutes.", base)).toBe(base + (2 * 60 + 15) * 60_000);
    expect(usageLimitResetAt('│ 5-hour limit reached ∙ resets 3pm (UTC) │', base)).toBe(Date.parse('2026-11-05T15:00:00.000Z'));
    expect(usageLimitResetAt('│ Weekly limit reached ∙ resets Nov 6 at 9:30am (UTC) │', base)).toBe(Date.parse('2026-11-06T09:30:00.000Z'));
    expect(providerUsageResetAt('claude', undefined, '5-hour limit reached', [{
      key: 'claude', name: 'Claude Code', account: 'Claude', source: 'local', updatedAt: null, active: true, retryAt: null,
      short: { usedPercent: 100, resetsAt: '2026-11-05T15:00:00.000Z', windowMinutes: 300 },
      weekly: { usedPercent: 40, resetsAt: '2026-11-10T00:00:00.000Z', windowMinutes: 10080 },
    }], base)).toBe(Date.parse('2026-11-05T15:00:00.000Z'));
  });
  it('switches to waiting mode on token exhaustion and sends a continue request to the CLI 1 minute after the reset time', async () => {
    const previousDelay = ControlService.terminalSubmitDelayMs;
    ControlService.terminalSubmitDelayMs = 10;
    try {
      const { service, task } = await fixture('pty');
      const run = service.startTask(task.id);
      const resetSec = Math.floor(Date.now() / 1000) + 300;
      const resetMs = resetSec * 1000;
      const resumeMs = resetMs + ControlService.usageLimitGraceMs;
      expect(ControlService.usageLimitGraceMs).toBe(60_000);
      callbacks(run.id).output('terminal', `Claude AI usage limit reached|${resetSec}\r\n`);
      expect(service.run(run.id).status).toBe('waiting');
      expect(service.task(task.id).status).toBe('waiting');
      expect(service.task(task.id).handoffRequest).toMatchObject({
        runId: run.id,
        resetsAt: new Date(resetMs).toISOString(),
        resumeAt: new Date(resumeMs).toISOString(),
      });
      const handle = (service as unknown as { ctx: { handles: Map<string, { input: ReturnType<typeof vi.fn> }> } }).ctx.handles.get(run.id)!;
      // Dismissing the handoff banner ("Şimdilik bekle") keeps the automatic wait and resume active.
      service.dismissHandoff(task.id);
      expect(service.task(task.id).handoffRequest).toBeUndefined();
      (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resetMs);
      (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resumeMs - 1);
      expect(handle.input).not.toHaveBeenCalled();
      expect(service.run(run.id).status).toBe('waiting');
      (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resumeMs);
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(handle.input).toHaveBeenCalledWith(USAGE_LIMIT_CONTINUE_MESSAGE);
      expect(handle.input).toHaveBeenCalledWith('\r');
      expect(service.run(run.id).status).toBe('running');
      expect(service.task(task.id).status).toBe('running');
    } finally {
      ControlService.terminalSubmitDelayMs = previousDelay;
    }
  });
  it('cancels automatic continuation when the user stops a quota-waiting run', async () => {
    const { service, task } = await fixture('pty');
    const run = service.startTask(task.id);
    callbacks(run.id).output('terminal', 'Individual quota reached. Resets in 1h.\r\n');
    const resumeAt = Date.parse(service.task(task.id).handoffRequest!.resumeAt!);
    await service.stop(run.id);
    (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resumeAt);
    expect(service.run(run.id).status).toBe('cancelled');
    expect(service.task(task.id).handoffRequest).toBeUndefined();
    expect(vi.mocked(launchRuntime)).toHaveBeenCalledTimes(1);
  });
  it('resolves the reset time from provider usage windows and relaunches a waiting run after +1 minute when the process exited', async () => {
    const { service, task } = await fixture('stream');
    const resetMs = Date.now() + 600_000;
    const resumeMs = resetMs + 60_000;
    service.usageSource = async () => [{
      key: 'claude', name: 'Claude Code', account: 'Claude', source: 'local', updatedAt: null, active: true, retryAt: null,
      short: { usedPercent: 100, resetsAt: new Date(resetMs).toISOString(), windowMinutes: 300 },
      weekly: { usedPercent: 25, resetsAt: null, windowMinutes: 10080 },
    }];
    const run = service.startTask(task.id);
    const io = callbacks(run.id);
    io.output('stderr', "You've hit your usage limit.\n");
    io.close(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(service.run(run.id).status).toBe('waiting');
    expect(service.task(task.id).status).toBe('waiting');
    expect(service.task(task.id).handoffRequest?.resumeAt).toBe(new Date(resumeMs).toISOString());
    (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resumeMs - 1);
    expect(vi.mocked(launchRuntime)).toHaveBeenCalledTimes(1);
    (service as unknown as { reports: { tick(now: number): void } }).reports.tick(resumeMs);
    expect(vi.mocked(launchRuntime)).toHaveBeenCalledTimes(2);
    expect(service.run(run.id).status).toBe('running');
    expect(service.run(run.id).continuation).toBe(1);
    expect(vi.mocked(launchRuntime).mock.calls[1]![3]).toContain(USAGE_LIMIT_CONTINUE_MESSAGE);
  });
  it('renders TUI cursor positioning and erase sequences cleanly in terminalTranscript without spinner garbage', () => {
    const raw = [
      '\x1b[2J\x1b[H',
      '\x1b[1;1H⠋  Reading file...',
      '\x1b[1;1H⠙  Reading file...',
      '\x1b[1;1H⠹  Reading file...',
      '\x1b[1;1H\x1b[2K● Read src/app.ts\r\n',
      '\x1b[2;1H⣻  Running tests...\x1b[2;1H\x1b[19X✓ All tests passed\r\n',
    ].join('');
    const rendered = terminalTranscript(raw, 60_000);
    expect(rendered).toContain('● Read src/app.ts');
    expect(rendered).toContain('✓ All tests passed');
    expect(rendered).not.toContain('Reading file');
    expect(rendered).not.toContain('Running tests');
  });
  it('reads Antigravity brain transcript (including checkpoint summaries and tool calls) instead of collapsed TUI output on transcript handoff', async () => {
    const previousAgyHome = process.env.AGY_HOME;
    const { service, project } = await fixture('pty');
    const agyHome = join(roots.at(-1)!, 'agy-home');
    process.env.AGY_HOME = agyHome;
    try {
      const agyTask = service.createTask({ projectId: project.id, title: 'Agy feature', description: 'Start work in Antigravity', provider: 'agy', terminalMode: 'pty' });
      const run = service.startTask(agyTask.id);
      const sessionId = '867df1fe-50a2-4eef-9d44-d6bf1400fde2';
      service.reportSession(run.id, { sessionId, model: 'gemini-4-argon-medium' });
      const logsDir = join(agyHome, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs');
      mkdirSync(logsDir, { recursive: true });
      const compactRows = [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: `<USER_REQUEST>\nRead and follow the task instructions in ${join(run.inputDirectory ?? '', 'prompt.md')}. Perform the work in the current project.\n</USER_REQUEST>` },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'SECRET_EARLY_THINKING', tool_calls: [{ id: 'c1', name: 'read_file', args: { Path: JSON.stringify('C:/repo/old.ts') } }] },
        { step_index: 2, source: 'TOOL', type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-07T18:00:00Z\nCompleted At: 2026-11-07T18:00:01Z\nShowing lines 1-50 of 50\nOLD_FILE_BODY' },
        { step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: 'truncated', truncated_fields: ['content'] },
        { step_index: 4, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<ADDITIONAL_METADATA>\nThe current local time is: 2026-11-07\n</ADDITIONAL_METADATA>\n\n<USER_REQUEST>\nAlso support dark mode tokens\n</USER_REQUEST>' },
        { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', thinking: 'SECRET_LATE_THINKING', content: 'I updated the theme tokens and started wiring the component.', tool_calls: [
          { id: 'c2', name: 'read_file', args: { Path: JSON.stringify('C:/repo/src/styles.css') } },
          { id: 'c3', name: 'edit_file', args: { Path: JSON.stringify('C:/repo/src/styles.css'), Target: JSON.stringify(':root {}'), Replacement: JSON.stringify(':root { --bg: #000; }') } },
        ] },
        { step_index: 6, source: 'TOOL', type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-07T18:05:00Z\nCompleted At: 2026-11-07T18:05:01Z\nShowing lines 1-120 of 120\nHUGE_CSS_FILE_CONTENT_THAT_SHOULD_NOT_BE_DUMPED' },
        { step_index: 7, source: 'TOOL', type: 'GENERIC', status: 'DONE', content: 'Created At: 2026-11-07T18:05:01Z\nCompleted At: 2026-11-07T18:05:02Z\nMade 1 replacement in C:/repo/src/styles.css starting at line 1 (+1/-1 lines).' },
      ];
      const fullRows = compactRows.map((row) => row.step_index === 3
        ? { step_index: 3, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', content: '<summary>\n1. Completed initial architecture review and refactored `src/old.ts`.\n</summary>\n# Conversation Logs\nBoilerplate' }
        : row);
      writeFileSync(join(logsDir, 'transcript.jsonl'), compactRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      writeFileSync(join(logsDir, 'transcript_full.jsonl'), fullRows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      callbacks(run.id).output('terminal', '\x1b[2J\x1b[H… 119 more actions (73 reads, 38 edits) …\r\nIndividual quota reached. Resets in 2h.\r\n');
      const { run: next } = await service.handoffTask(agyTask.id, { provider: 'claude', mode: 'transcript' });
      const context = next.executionSnapshot?.context ?? '';
      expect(context).toContain('Completed initial architecture review and refactored `src/old.ts`.');
      expect(context).toContain('[user] Also support dark mode tokens');
      expect(context).toContain('[agent] I updated the theme tokens and started wiring the component.');
      expect(context).toContain('C:/repo/src/styles.css');
      expect(context).toContain('Showing lines 1-120 of 120');
      expect(context).toContain('Made 1 replacement in C:/repo/src/styles.css');
      expect(context).not.toContain('HUGE_CSS_FILE_CONTENT_THAT_SHOULD_NOT_BE_DUMPED');
      expect(context).not.toContain('SECRET_EARLY_THINKING');
      expect(context).not.toContain('SECRET_LATE_THINKING');
      expect(context).not.toContain('119 more actions');
    } finally {
      if (previousAgyHome === undefined) delete process.env.AGY_HOME;
      else process.env.AGY_HOME = previousAgyHome;
    }
  });
});
