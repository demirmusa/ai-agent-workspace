import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectInputRequest } from '../input-request.js';
import { ControlService } from '../service.js';
import type { RuntimeCallbacks } from '../runner.js';

const runtime = vi.hoisted(() => ({ callbacks: null as RuntimeCallbacks | null, input: vi.fn() }));
vi.mock('../runner.js', () => ({ launchRuntime: (_p: unknown, _t: unknown, _r: unknown, _prompt: unknown, _options: unknown, callbacks: RuntimeCallbacks) => {
  runtime.callbacks = callbacks;
  return { input: runtime.input, resize: () => {}, stop: async () => {}, pause: async () => 'suspended', resume: async () => {} };
} }));
let root: string, service: ControlService;
afterEach(async () => { if (service) await service.close(); if (root) rmSync(root, { recursive: true, force: true }); runtime.input.mockReset(); });

describe('AI input requests', () => {
  it('recognizes native approval choices and explicit input waits without treating normal prose as a question', () => {
    expect(detectInputRequest('\x1b[33mWould you like to run the following command?\x1b[0m\n1. Yes, proceed\n2. No')).toMatchObject({kind:'approval'});
    expect(detectInputRequest('Which environment?\nWaiting for your answer')).toMatchObject({kind:'question'});
    expect(detectInputRequest('Which environment?\n1. Local\n2. Staging\nEnter to select · Tab/Arrow keys to navigate · Esc to cancel')).toMatchObject({kind:'question'});
    expect(detectInputRequest('What is next? I will run the tests.')).toBeNull();
    expect(detectInputRequest('Do you want to update?')).toBeNull();
    expect(detectInputRequest('Would you like to run?\n1. Yes, proceed\n' + 'working\n'.repeat(30))).toBeNull();
  });
  it('reads a repainted Claude Code permission dialog into its command, question and choices', () => {
    const erase = (count: number) => '\x1b[2K\x1b[1A'.repeat(count) + '\x1b[2K\x1b[G';
    const cmd = String.raw`$sp="C:\Users\dev\AppData\Local\Temp\claude\C--Users-dev--aiws-control-worktrees-project-c2428490-8921-4f02"; python -I "$sp\splice.py" app.js "$sp\organizer.js"; git diff --stat`;
    const always = `Yes, and don't ask again for: ${cmd}`;
    // Ink cuts long tokens at the 100 column width and word-wraps prose; both must be rejoined.
    const cut = (text: string, first: string, next: string) => { const rows = [first + text.slice(0, 100 - first.length)]; for (let at = 100 - first.length; at < text.length; at += 100 - next.length) rows.push(next + text.slice(at, at + 100 - next.length)); return rows; };
    const rest = cmd.slice(98);
    const dialog = ['─'.repeat(100), ' PowerShell command', '', ' Splice organizer block into app.js', '╌'.repeat(100), `│ ${cmd.slice(0, 98)}`, `│ ${rest.slice(0, -' --stat'.length)}`, '│ --stat', '╌'.repeat(100),
      ' Command contains expandable strings with embedded expressions', '', ' Do you want to proceed?', ' ❯ 1. Yes', ...cut(always, '   2. ', '      '), '   3. No', '', ' Esc to cancel · Tab to amend'];
    const output = '\x1b[>4;2m\x1b[?25l● Writing file\r\n⎿ $ splice\r\n' + erase(2) + '\x1b[38;5;2m●\x1b[39m Writing file\r\n' + erase(1) + '\x1b[?2026h' + dialog.join('\r\n') + '\x1b[?2026l';
    const request = detectInputRequest(output, { cols: 100, rows: 30 })!;
    expect(request.kind).toBe('approval');
    expect(request.prompt).toEqual({
      title: 'PowerShell command', question: 'Do you want to proceed?',
      context: ['Splice organizer block into app.js', 'Command contains expandable strings with embedded expressions'],
      command: cmd,
      options: [{ label: 'Yes', selected: true }, { label: always, selected: false }, { label: 'No', selected: false }],
    });
    expect(request.text).toMatch(/^\*\*Do you want to proceed\?\*\*\n\nPowerShell command/);
    expect(request.text).not.toMatch(/●|4;2m|Esc to cancel/);
  });
  it('reads a Codex approval with the question above the command', () => {
    const output = '\x1b[2J\x1b[HWould you like to run the following command?\r\n\r\n  Reason: run the tests\r\n\r\n  $ npm test\r\n\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)\r\n\r\n  Press enter to confirm or esc to cancel';
    expect(detectInputRequest(output)?.prompt).toEqual({ question: 'Would you like to run the following command?', context: ['Reason: run the tests'], command: 'npm test',
      options: [{ label: 'Yes, proceed (y)', selected: true }, { label: 'No, and tell Codex what to do differently (esc)', selected: false }] });
  });
  it('reads a ConPTY dialog that wraps at the width and quotes a warning under its command', () => {
    const pad = (text: string) => text.padEnd(60);
    const output = '\x1b[2J\x1b[H' + '─'.repeat(60) + '\x1b[2;2HBash command\x1b[3;2HRemove the worktrees\r\n' + '╌'.repeat(60) + '\x1b[5;2H│\x1b[1Crm\x1b[1C-rf\x1b[1C"$B/$w"\r\n' + '╌'.repeat(60)
      + '\x1b[7;2H│ Dangerous rm operation\x1b[8;2H⚠ Auto-deny in 1:59\x1b[10;1H' + pad(' Do you want to proceed?') + '❯\x1b[1C1. Yes\r\n   2. No\x1b[13;2HEsc to cancel · Tab to amend';
    expect(detectInputRequest(output, { cols: 60, rows: 14 })?.prompt).toEqual({ title: 'Bash command', question: 'Do you want to proceed?', context: ['Remove the worktrees', 'Dangerous rm operation', '⚠ Auto-deny in 1:59'],
      command: 'rm -rf "$B/$w"', options: [{ label: 'Yes', selected: true }, { label: 'No', selected: false }] });
  });
  it('never reads a dialog above the agent input box: that is text on screen, such as a file preview', () => {
    const rule = '─'.repeat(100), preview = ['  Do you want to proceed?', '  ❯ 1. Yes', '    2. No', '  Esc to cancel · Tab to amend'];
    expect(detectInputRequest([...preview, rule, '❯ ', rule, ' Opus 5.5 | ctx 61% left'], { cols: 100, rows: 30 })).toBeNull();
    expect(detectInputRequest([...preview, rule, '❯ yazılan mesaj', rule, ' Opus 5.5 | ctx 61% left'], { cols: 100, rows: 30 })).toBeNull();
    expect(detectInputRequest(preview, { cols: 100, rows: 30 })).toMatchObject({ kind: 'approval' });
  });
  it('ignores dialog wording quoted in transcript lines', () => {
    expect(detectInputRequest('● Which environment?\n● Waiting for your answer\n❯ Waiting for your input')).toBeNull();
  });
  it('drops a pending native request once the dialog leaves the screen', async () => {
    root = mkdtempSync(join(tmpdir(),'aiws-input-')); service = await ControlService.open({dataDir:join(root,'data')});
    const project = service.createProject({name:'Input',repositoryPath:root});
    const task = service.createTask({projectId:project.id,title:'Stale',terminalMode:'pty'});
    const run = service.startTask(task.id);
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[HWhich env?\r\n1. Local\r\n2. Staging\r\nEnter to select · Esc to cancel');
    expect(service.run(run.id).status).toBe('waiting');
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[H● Working on it');
    expect(service.run(run.id).status).toBe('running');
    expect(service.snapshot().questions[0]!.status).toBe('cancelled');
  });
  it('keeps a pending native request while the TUI repaints it after a resize', async () => {
    root = mkdtempSync(join(tmpdir(),'aiws-input-')); service = await ControlService.open({dataDir:join(root,'data')});
    const project = service.createProject({name:'Input',repositoryPath:root});
    const task = service.createTask({projectId:project.id,title:'Resize',terminalMode:'pty'});
    const run = service.startTask(task.id);
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[HWhich env?\r\n1. Local\r\n2. Staging\r\nEnter to select · Esc to cancel');
    const text = service.snapshot().questions[0]!.text;
    // Showing the request in the console resizes the PTY; the repaint lands on rows drawn at the old size.
    service.resize(run.id,{cols:90,rows:24});
    runtime.callbacks!.output('terminal','\x1b[3A\x1b[2K1. Local Staging\r\n\x1b[2KEnter to select · Esc to cancel');
    runtime.callbacks!.output('terminal','\x1b[2K\x1b[1A\x1b[2K\x1b[G● Working');
    expect(service.snapshot().questions[0]).toMatchObject({text,status:'pending'});
    // Once the buffer holds only the new size's output, the screen is trusted again.
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[H' + 'x'.repeat(8000) + '\x1b[2J\x1b[H● Working on it');
    expect(service.snapshot().questions[0]!.status).toBe('cancelled');
  });
  it('reads cell updates of a dialog against the screen drawn before them', async () => {
    root = mkdtempSync(join(tmpdir(),'aiws-input-')); service = await ControlService.open({dataDir:join(root,'data')});
    const project = service.createProject({name:'Input',repositoryPath:root});
    const task = service.createTask({projectId:project.id,title:'Countdown',terminalMode:'pty'});
    service.startTask(task.id);
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[H Deny in 1:59\x1b[3;1H Do you want to proceed?\r\n ❯ 1. Yes\r\n   2. No\r\n Esc to cancel');
    const text = service.snapshot().questions[0]!.text;
    // A countdown tick redraws only the changed digits, long after the dialog scrolled out of any recent-output window.
    for (let tick = 0; tick < 400; tick++) runtime.callbacks!.output('terminal',`\x1b[1;10H${tick % 2}\x1b[1C${String(tick % 60).padStart(2, '0')}\x1b[6;1H`);
    expect(service.snapshot().questions).toHaveLength(1);
    expect(service.snapshot().questions[0]!).toMatchObject({status:'pending',prompt:{question:'Do you want to proceed?',options:[{label:'Yes',selected:true},{label:'No',selected:false}]}});
    expect(service.snapshot().questions[0]!.text).toBe(text);
  });
  it('deduplicates chunked native requests, routes users to the TUI, and clears waiting on terminal response', async () => {
    root = mkdtempSync(join(tmpdir(),'aiws-input-')); service = await ControlService.open({dataDir:join(root,'data')});
    const project = service.createProject({name:'Input',repositoryPath:root});
    const task = service.createTask({projectId:project.id,title:'Native',terminalMode:'pty'});
    const run = service.startTask(task.id);
    runtime.callbacks!.output('terminal','Would you like to run the following command?\n');
    expect(service.snapshot().questions).toHaveLength(0);
    runtime.callbacks!.output('terminal','1. Yes, proceed\n2. No');
    runtime.callbacks!.output('terminal','\x1b[0m');
    const question = service.snapshot().questions[0]!;
    expect(service.snapshot().questions).toHaveLength(1); expect(question).toMatchObject({kind:'approval',source:'terminal',status:'pending'});
    expect(service.run(run.id).status).toBe('waiting');
    expect(() => service.answer(question.id,{answer:'yes'})).toThrow(/native terminal/);
    service.input(run.id,{data:'\x1b[B'}); expect(service.run(run.id).status).toBe('waiting');
    service.input(run.id,{data:'\r'}); expect(runtime.input).toHaveBeenLastCalledWith('\r');
    expect(service.run(run.id).status).toBe('running'); expect(service.snapshot().questions[0]).toMatchObject({status:'answered',answer:null});
    expect(service.terminal(run.id).output).toContain('Would you like');
    expect(() => service.answer(question.id,{answer:'late'})).toThrow(/no longer pending/);
    runtime.callbacks!.output('terminal','Waiting for your input');
    runtime.callbacks!.close(0);
    expect(service.run(run.id).status).toBe('completed');
    expect(service.snapshot().questions[1]!.status).toBe('cancelled');
  });
  it('reads the folder trust dialogs of Claude Code and the menu Codex opens with', () => {
    const claude = ['─'.repeat(100), ' Accessing workspace:', '', ' C:\\work\\project', '', ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a', " well-known open source project, or work from your team). If not, take a moment to review what's in", ' this folder first.', '', " Claude Code'll be able to read, edit, and execute files here.", '', ' ❯ No, exit', '   Yes, I trust this folder', '', ' Enter to confirm · Esc to cancel'];
    const trust = detectInputRequest(claude, { cols: 100, rows: 30 })!;
    expect(trust.kind).toBe('approval');
    expect(trust.prompt?.question).toBe("Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.");
    expect(trust.prompt?.options).toEqual([{ label: 'No, exit', selected: true }, { label: 'Yes, I trust this folder', selected: false }]);
    expect(detectInputRequest(['Do you trust the contents of this directory?', '', '› 1. Yes, continue', '  2. No, quit', '', '  Press enter to continue'])).toMatchObject({ kind: 'approval' });
    expect(detectInputRequest(['  Update available · 0.164.0 → 0.166.0', '› 1. Update now', '  2. Skip', '  enter continue · esc skip'])?.prompt?.options).toHaveLength(2);
    // Words alone are not a menu: no cursor, no dialog.
    expect(detectInputRequest(['Press enter to continue when you are ready.'])).toBeNull();
  });
  it('records what was chosen in the terminal instead of calling an answered dialog cancelled', async () => {
    root = mkdtempSync(join(tmpdir(),'aiws-input-')); service = await ControlService.open({dataDir:join(root,'data')});
    const project = service.createProject({name:'Input',repositoryPath:root});
    const task = service.createTask({projectId:project.id,title:'Trust',terminalMode:'pty'});
    const run = service.startTask(task.id);
    const dialog = (first: string, second: string) => `\x1b[2J\x1b[H Is this a project you created or one you trust?\r\n\r\n ${first} No, exit\r\n ${second} Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel`;
    runtime.callbacks!.output('terminal',dialog('❯',' '));
    expect(service.snapshot().questions[0]).toMatchObject({kind:'approval',status:'pending'});
    // The arrow moved the cursor, and the repaint moved the selection the Enter then confirms.
    runtime.callbacks!.output('terminal',dialog(' ','❯'));
    service.input(run.id,{data:'\r'});
    expect(service.snapshot().questions[0]).toMatchObject({status:'answered',answer:'Yes, I trust this folder'});
    expect(service.snapshot().events.some(event=>event.type==='answer'&&event.message==='Yes, I trust this folder')).toBe(true);
    // A number key answers a numbered dialog without an Enter; the dialog simply closes.
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[H● Working');
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[HDo you want to proceed?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel');
    service.input(run.id,{data:'2'});
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[H● Working');
    expect(service.snapshot().questions[1]).toMatchObject({status:'answered',answer:'No'});
    // Esc dismisses a dialog without choosing anything.
    runtime.callbacks!.output('terminal','\x1b[2J\x1b[HDo you want to run it?\r\n❯ 1. Yes\r\n  2. No\r\nEsc to cancel');
    service.input(run.id,{data:'\x1b'});
    expect(service.snapshot().questions[2]).toMatchObject({status:'cancelled',answer:null});
  });
});

describe('terminal screen', () => {
  it('keeps hostile cursor movements on the visible screen', async () => {
    const { renderTerminalScreen } = await import('../terminal-screen.js');
    const started = Date.now();
    const screen = renderTerminalScreen(`top${'\x1b[99999999B\x1b[99999999Cx'.repeat(2000)}`, 10);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(screen.length).toBeLessThanOrEqual(10);
    expect(Math.max(...screen.map((line) => line.length))).toBeLessThanOrEqual(1001);
  });
});
