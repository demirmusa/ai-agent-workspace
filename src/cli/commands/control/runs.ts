import type { Command } from 'commander';
import { print, request, segment } from './client.js';

/** Streams a PTY run to this terminal until Ctrl+] detaches or the run stops being interactive. */
async function attachRun(command: Command, id: string): Promise<void> {
  const path = `/api/runs/${segment(id)}`;
  let detached = false; let previous = ''; let error: unknown;
  const initial = await request(command, `${path}/terminal`);
  if (initial.mode !== 'pty') throw new Error('This run uses structured stream output. Choose --terminal pty for a native interactive terminal.');
  const raw = process.stdin.isTTY && process.stdin.isRaw;
  const input = (chunk: string) => { if (chunk.includes('\x1d')) { detached = true; return; } void request(command, `${path}/input`, 'POST', { data: chunk }).catch((failure) => { error = failure; detached = true; }); };
  const resize = () => { void request(command, `${path}/resize`, 'POST', { cols: Math.max(10, Math.min(500, process.stdout.columns ?? 100)), rows: Math.max(3, Math.min(300, process.stdout.rows ?? 30)) }).catch(() => {}); };
  const interrupt = () => { detached = true; };
  process.stdin.setEncoding('utf8'); if (process.stdin.isTTY) process.stdin.setRawMode(true);
  process.stdin.on('data', input); process.stdout.on('resize', resize); process.once('SIGTERM', interrupt); process.stdin.resume(); resize();
  try {
    while (!detached) {
      const state = await request(command, `${path}/terminal`); const output: string = state.output ?? '';
      if (output.startsWith(previous)) process.stdout.write(output.slice(previous.length)); else process.stdout.write(`\x1b[2J\x1b[H${output}`);
      previous = output;
      if (!state.interactive) break;
      await new Promise((done) => setTimeout(done, 200));
    }
    if (error) throw error;
  } finally { process.stdin.off('data', input); process.stdout.off('resize', resize); process.off('SIGTERM', interrupt); if (process.stdin.isTTY) process.stdin.setRawMode(Boolean(raw)); process.stdin.pause(); }
}

const completion = (options: Record<string, any>) => ({ success: !options.failed, ...(options.summary ? { summary: options.summary } : {}), ...(options.reply ? { reply: options.reply } : {}) });
const requireRun = (options: Record<string, any>): string => { if (!options.run) throw new Error('Use --run or AIWS_RUN_ID.'); return options.run; };

/** Observing and steering runs, plus the commands an agent uses from inside its own run. */
export function registerRunCommands(control: Command): void {
  const runs = control.command('runs').description('Observe and control a particular agent run.');
  runs.command('show <id>').action(async (id, _options, command) => print(await request(command, `/api/runs/${segment(id)}`)));
  runs.command('list').option('--project <id>').option('--task <id>').option('--status <status>').action(async (options, command) => {
    const state = await request(command, '/api/state');
    const taskIds = new Set(state.tasks.filter((task: any) => task.projectId === options.project).map((task: any) => task.id));
    print(state.runs.filter((run: any) => (!options.project || taskIds.has(run.taskId)) && (!options.task || run.taskId === options.task) && (!options.status || run.status === options.status)));
  });
  runs.command('events <id>').action(async (id, _options, command) => print(await request(command, `/api/runs/${segment(id)}/events`)));
  runs.command('terminal <id>').action(async (id, _options, command) => print(await request(command, `/api/runs/${segment(id)}/terminal`)));
  runs.command('input <id> <data>').option('--enter', 'append carriage return', false).action(async (id, data, options, command) => print(await request(command, `/api/runs/${segment(id)}/input`, 'POST', { data: `${data}${options.enter ? '\r' : ''}` })));
  runs.command('resize <id> <cols> <rows>').action(async (id, cols, rows, _options, command) => print(await request(command, `/api/runs/${segment(id)}/resize`, 'POST', { cols: Number(cols), rows: Number(rows) })));
  runs.command('attach <id>').description('Attach stdin/stdout to the real PTY; Ctrl+] detaches without stopping the agent.')
    .action(async (id, _options, command) => attachRun(command, id));
  runs.command('complete <id>').option('--summary <text>').option('--reply <text>', 'final answer for the requester; posted to a linked GitHub issue').option('--failed', 'mark the work failed', false).action(async (id, options, command) => print(await request(command, `/api/runs/${segment(id)}/complete`, 'POST', completion(options))));
  for (const action of ['pause', 'resume', 'stop']) runs.command(`${action} <id>`).action(async (id, _options, command) => print(await request(command, `/api/runs/${segment(id)}/${action}`, 'POST', {})));
  runs.command('send <id> <message>').action(async (id, message, _options, command) => print(await request(command, `/api/runs/${segment(id)}/command`, 'POST', { message })));

  control.command('complete').description('Explicitly complete the current native TUI task.').option('--run <id>', 'run ID', process.env.AIWS_RUN_ID).option('--summary <text>').option('--reply <text>', 'final answer for the requester; posted to a linked GitHub issue').option('--failed', 'mark failed', false)
    .action(async (options, command) => { const run = requireRun(options); print(await request(command, `/api/runs/${segment(run)}/complete`, 'POST', completion(options))); });
  control.command('reply <text>').description('Leave the final answer of the current run; a linked GitHub issue receives it as a comment when the run ends.').option('--run <id>', 'run ID', process.env.AIWS_RUN_ID)
    .action(async (text, options, command) => { const run = requireRun(options); print(await request(command, `/api/runs/${segment(run)}/reply`, 'POST', { text })); });
  control.command('session [sessionId]').description('Record the provider session of the current run on its task, so follow-ups and merge recovery resume it. Detects Claude Code and Codex sessions automatically.').option('--run <id>', 'run ID', process.env.AIWS_RUN_ID).option('--model <id>', 'model ID the agent is running with')
    .action(async (sessionId, options, command) => {
      const run = requireRun(options);
      const detected = sessionId ?? process.env.CLAUDE_CODE_SESSION_ID ?? process.env.CODEX_THREAD_ID ?? process.env.CODEX_SESSION_ID;
      if (!detected) throw new Error('No provider session ID was detected. Pass it as an argument: aiws control session <sessionId>.');
      print(await request(command, `/api/runs/${segment(run)}/session`, 'POST', { sessionId: detected, ...(options.model ? { model: options.model } : {}) }));
    });
}
