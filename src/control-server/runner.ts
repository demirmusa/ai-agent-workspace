import { spawn, type ChildProcess } from 'node:child_process';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, ProviderArgs, Run, Task } from './types.js';
import { ControlError } from './types.js';
import { effectiveProviderArgs } from './provider-args.js';
import { aiProviders, DIRECT_PROMPT_LIMIT, type LaunchContext, type ProviderInvocation } from './ai-providers/index.js';
import { killWindowsProcessTree, windowsLauncher } from './windows-launch.js';

// This independent process stays outside the provider's process group. A crashed
// control service therefore cannot leave even a SIGSTOP-ed provider orphaned.
const watchdogSource = String.raw`
const {spawn}=require('node:child_process');
const target=Number(process.env.AIWS_WATCH_PID);
const container=process.env.AIWS_WATCH_CONTAINER;
process.on('message', message=>{if(message==='done')process.exit(0)});
process.on('disconnect',()=>{
  if(container){const child=spawn('docker',['rm','--force',container],{stdio:'ignore',windowsHide:true});child.on('close',()=>process.exit(0));child.on('error',()=>process.exit(1));return}
  if(process.platform==='win32'){const child=spawn('taskkill.exe',['/PID',String(target),'/T','/F'],{stdio:'ignore',windowsHide:true});child.on('close',()=>process.exit(0));child.on('error',()=>process.exit(1));return}
  try{process.kill(-target,'SIGCONT');process.kill(-target,'SIGTERM')}catch{process.exit(0)}
  setTimeout(()=>{try{process.kill(-target,'SIGKILL')}catch{}process.exit(0)},3000);
});
`;

export function superviseProcess(pid: number, containerName = ''): ChildProcess {
  const watchdog = spawn(process.execPath, ['-e', watchdogSource], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AIWS_WATCH_PID: String(pid), AIWS_WATCH_CONTAINER: containerName },
  });
  watchdog.on('error', () => { /* The normal runtime lifecycle still supervises graceful shutdown. */ });
  watchdog.unref(); watchdog.channel?.unref(); return watchdog;
}

export interface RuntimeCallbacks {
  output(stream: 'stdout' | 'stderr' | 'terminal', text: string): void;
  close(code: number, error?: string): void;
}
export interface RuntimeHandle {
  pid: number | undefined;
  pause(): Promise<'suspended' | 'checkpoint'>;
  resume(): Promise<void>;
  stop(): Promise<void>;
  input?(data: string): void; resize?(cols: number, rows: number): void; clear?(): void;
}
export interface RuntimeOptions {
  image: string; controlUrl: string; token?: string;
  readOnly?: boolean;
  providerHome?: string;
  providerArgs?: ProviderArgs;
  /** Environment that runs the provider as the task's account (ProviderAccounts.launchEnv). */
  accountEnv?: Record<string, string>;
}

/** Longer resume messages are written to prompt.md, keeping the command line within Windows limits. */
export { DIRECT_PROMPT_LIMIT };

export function providerInvocation(task: Task, prompt: string, readOnly = false): ProviderInvocation {
  if (task.provider === 'command') {
    if (readOnly) throw new ControlError(`Read-only planning requires ${aiProviders.names()}; arbitrary commands cannot enforce this policy.`);
    if (!task.command) throw new ControlError('A command task requires command.executable and command.args.');
    return { executable: task.command.executable, args: task.command.args, input: prompt };
  }
  return aiProviders.require(task.provider).headlessInvocation(task, prompt, readOnly);
}

function spawnPortable(executable: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const command = windowsLauncher(executable, args, options?.env ?? process.env);
  return spawn(command.executable, command.args, { ...options, env: command.env });
}

async function dockerControl(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawnPortable('docker', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let stderr = ''; child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    child.once('error', reject); child.once('close', (code) => code === 0 ? resolve() : reject(new ControlError(stderr.trim() || 'Docker control failed.')));
  });
}

export function prepareRuntime(project: Project, task: Task, run: Run, prompt: string, options: RuntimeOptions): { executable: string; args: string[]; input: string; env: NodeJS.ProcessEnv } {
  if (options.readOnly && run.terminalMode === 'pty') throw new ControlError('Read-only planning uses the bounded provider interface, not an interactive terminal.');
  const effectiveTask = { ...task };
  if (run.executionSnapshot) {
    effectiveTask.provider = run.executionSnapshot.provider;
    delete effectiveTask.model; delete effectiveTask.reasoningEffort; delete effectiveTask.command;
    if (run.executionSnapshot.model !== undefined) effectiveTask.model = run.executionSnapshot.model;
    if (run.executionSnapshot.reasoningEffort !== undefined) effectiveTask.reasoningEffort = run.executionSnapshot.reasoningEffort;
    if (run.executionSnapshot.command !== undefined) effectiveTask.command = run.executionSnapshot.command;
  }
  let invocation = providerInvocation(effectiveTask, prompt, options.readOnly);
  const nativePrompt = `Read and follow the task instructions in ${run.executionMode === 'docker' ? '/run/aiws/input/prompt.md' : join(run.inputDirectory ?? '', 'prompt.md')}. Perform the work in the current project. When finished, run aiws control complete --run ${run.id} --summary Completed. If unsuccessful add --failed. This is a real interactive terminal.`;
  const provider = effectiveTask.provider === 'command' ? undefined : aiProviders.require(effectiveTask.provider);
  const context: LaunchContext = { project, run, task: effectiveTask, prompt, nativePrompt, readOnly: Boolean(options.readOnly) };
  if (provider) {
    if (run.terminalMode === 'pty') invocation = provider.terminalInvocation(effectiveTask.model, nativePrompt);
    invocation = provider.prepareSession(invocation, context);
  }
  if (run.historyResume) {
    if (!provider || !provider.sessionIdPattern.test(run.historyResume.sessionId) || run.historyResume.provider !== provider.id) throw new ControlError('Invalid historical provider session reference.');
    if (run.executionMode !== 'native') throw new ControlError('Historical provider sessions require native execution mode.');
    // The resumed session already knows the task, so the new message goes in directly instead of through prompt.md.
    const message = run.historyResume.initialMessage.trim() ? [prompt.length <= DIRECT_PROMPT_LIMIT ? prompt : nativePrompt] : [];
    invocation = provider.resumeInvocation(run.historyResume.sessionId, message, context);
  }
  const extraArgs = effectiveProviderArgs(effectiveTask.provider, options.providerArgs, effectiveTask.model, options.readOnly, effectiveTask.reasoningEffort);
  if (provider && extraArgs.length) invocation.args = provider.mergeArgs(invocation.args, extraArgs, context);
  const containerName = `aiws-control-${run.id}`;
  const skillsDirectory = run.executionMode === 'docker' ? '/run/aiws/skills' : run.skillsDirectory ?? '';
  const env = { ...process.env, AIWS_RUN_ID: run.id, AIWS_TASK_ID: task.id,
    AIWS_AGENT_ID: run.executionSnapshot?.agent?.id ?? '', AIWS_SKILLS_DIR: skillsDirectory,
    AIWS_AGENT_DIRECTORY_FILE: run.inputDirectory ? run.executionMode === 'docker' ? '/run/aiws/input/agents.json' : join(run.inputDirectory, 'agents.json') : '',
    AIWS_CONTROL_URL: options.controlUrl, ...(options.token ? { AIWS_CONTROL_TOKEN: options.token } : {}),
    ...provider?.runEnv(Boolean(options.readOnly)) };
  if (run.historyResume && options.providerHome) {
    // Pointing CLAUDE_CONFIG_DIR at the default ~/.claude moves Claude's config file
    // to ~/.claude/.claude.json and starts first-run onboarding, so only a custom home is passed.
    const resumed = aiProviders.require(run.historyResume.provider), key = resumed.homeEnv;
    const fallback = resumed.homeDirectory({}, homedir());
    const same = (a: string, b: string) => platform() === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b);
    if (key && (process.env[key] || !same(options.providerHome, fallback))) (env as NodeJS.ProcessEnv)[key] = options.providerHome;
  }
  if (options.accountEnv) {
    if (run.executionMode === 'docker') throw new ControlError('Provider accounts run only in native execution mode.');
    // An API key or token in the service environment would take precedence over the chosen account.
    for (const name of provider?.accounts?.overrideEnv ?? []) delete (env as NodeJS.ProcessEnv)[name];
    Object.assign(env, options.accountEnv);
  }
  if (options.readOnly) {
    delete (env as NodeJS.ProcessEnv).AIWS_CONTROL_TOKEN; delete (env as NodeJS.ProcessEnv).AIWS_CONTROL_URL;
    delete (env as NodeJS.ProcessEnv).AIWS_RUN_ID; delete (env as NodeJS.ProcessEnv).AIWS_TASK_ID;
  }
  let executable = invocation.executable;
  let args = invocation.args;
  if (run.executionMode === 'docker') {
    // `--mount` is a comma-separated list: a comma or quote in a host path would add or change mount options.
    for (const path of [project.repositoryPath, task.worktree?.gitCommonDirectory, task.worktree?.gitDirectory, run.skillsDirectory, run.inputDirectory, process.env.AIWS_CONTROL_SKILLS_VOLUME]) {
      if (path && /[,"\r\n]/.test(path)) throw new ControlError(`Docker execution cannot mount a path that contains a comma, quote or line break: ${path}`);
    }
    executable = 'docker';
    args = ['run', '--rm', '--init', '--name', containerName, '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', '512', '--memory', '4g', '--cpus', '2',
      '--mount', `type=bind,src=${project.repositoryPath},dst=/workspace${options.readOnly ? ',readonly' : ''}`, '--workdir', '/workspace',
      ...(task.worktree?.gitCommonDirectory && task.worktree.gitDirectory ? ['--mount', `type=bind,src=${task.worktree.gitCommonDirectory},dst=/run/aiws/git-common`, '--mount', `type=bind,src=${task.worktree.gitDirectory},dst=/run/aiws/git-worktree`, '--env', 'GIT_DIR=/run/aiws/git-worktree', '--env', 'GIT_COMMON_DIR=/run/aiws/git-common', '--env', 'GIT_WORK_TREE=/workspace'] : []),
      ...(run.skillsDirectory ? ['--mount', process.env.AIWS_CONTROL_SKILLS_VOLUME
        ? `type=volume,src=${process.env.AIWS_CONTROL_SKILLS_VOLUME},dst=/run/aiws/skills,volume-subpath=runs/${run.id}/skills,readonly`
        : `type=bind,src=${run.skillsDirectory},dst=/run/aiws/skills,readonly`] : []),
      ...(run.inputDirectory ? ['--mount', process.env.AIWS_CONTROL_SKILLS_VOLUME
        ? `type=volume,src=${process.env.AIWS_CONTROL_SKILLS_VOLUME},dst=/run/aiws/input,volume-subpath=runs/${run.id}/input,readonly`
        : `type=bind,src=${run.inputDirectory},dst=/run/aiws/input,readonly`] : []),
      '--add-host', 'host.docker.internal:host-gateway',
      ...(process.env.AIWS_CONTROL_DOCKER_NETWORK ? ['--network', process.env.AIWS_CONTROL_DOCKER_NETWORK] : []),
      '--env', `AIWS_RUN_ID=${run.id}`, '--env', `AIWS_TASK_ID=${task.id}`,
      '--env', `AIWS_AGENT_ID=${run.executionSnapshot?.agent?.id ?? ''}`, '--env', `AIWS_SKILLS_DIR=${skillsDirectory}`,
      '--env', 'AIWS_AGENT_DIRECTORY_FILE=/run/aiws/input/agents.json',
      '--env', `AIWS_CONTROL_URL=${options.controlUrl}`,
      ...Object.keys(provider?.runEnv(Boolean(options.readOnly)) ?? {}).flatMap((name) => ['--env', name]),
      ...(options.token ? ['--env', 'AIWS_CONTROL_TOKEN'] : []),
      ...aiProviders.list().flatMap((item) => item.credentialEnv).filter((name) => process.env[name]).flatMap((name) => ['--env', name]),
      '--interactive', ...(run.terminalMode === 'pty' ? ['--tty'] : []), options.image, invocation.executable, ...invocation.args];
  }
  return { executable, args, input: invocation.input, env };
}

export function launchRuntime(project: Project, task: Task, run: Run, prompt: string, options: RuntimeOptions, callbacks: RuntimeCallbacks): RuntimeHandle {
  const { executable, args, input, env } = prepareRuntime(project, task, run, prompt, options);
  if (run.terminalMode === 'pty') return launchPty(project, run, executable, args, env, callbacks);
  const containerName = `aiws-control-${run.id}`;
  const startedAt = Date.now();
  const child = spawnPortable(executable, args, { cwd: project.repositoryPath, env, windowsHide: true,
    detached: platform() !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
  const watchdog = child.pid ? superviseProcess(child.pid, run.executionMode === 'docker' ? containerName : '') : undefined;
  let closed = false;
  let killTimer: NodeJS.Timeout | undefined;
  child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (text: string) => callbacks.output('stdout', text));
  child.stderr?.on('data', (text: string) => callbacks.output('stderr', text));
  child.stdin?.on('error', () => { /* Early process exit reports through close. */ });
  child.stdin?.end(input);
  const finish = (code: number, error?: string): void => {
    if (closed) return; closed = true; if (killTimer) clearTimeout(killTimer);
    if (watchdog?.connected) watchdog.send('done', () => { try { watchdog.disconnect(); } catch { /* Already disconnected. */ } });
    callbacks.close(code, error);
  };
  child.once('error', (error) => finish(127, error.message));
  child.once('close', (code, signal) => finish(code ?? 1, signal ? `Process terminated by ${signal}` : undefined));
  const signal = (name: NodeJS.Signals): void => {
    if (closed || !child.pid) return;
    try { if (platform() === 'win32') child.kill(name); else process.kill(-child.pid, name); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  };
  const stop = async (): Promise<void> => {
    if (closed) return;
    if (run.executionMode === 'docker') { await dockerControl(['rm', '--force', containerName]); return; }
    if (platform() === 'win32' && child.pid) {
      await killWindowsProcessTree(child.pid, startedAt);
      if (!closed) child.kill();
    } else {
      signal('SIGCONT'); signal('SIGTERM');
      killTimer = setTimeout(() => signal('SIGKILL'), 5_000); killTimer.unref();
    }
  };
  return {
    pid: child.pid,
    pause: async () => {
      if (run.executionMode === 'docker') { await dockerControl(['pause', containerName]); return 'suspended'; }
      if (platform() !== 'win32') { signal('SIGSTOP'); return 'suspended'; }
      await stop(); return 'checkpoint';
    },
    resume: async () => {
      if (run.executionMode === 'docker') await dockerControl(['unpause', containerName]); else signal('SIGCONT');
    }, stop,
  };
}

/** Where a terminal starts when it is not a fresh one in the project folder. `cursor` is Windows only: the screen position ConPTY continues from. */
export interface PtyPlacement { cwd?: string; cursor?: { row: number; col: number } }

export function launchPty(project: Project, run: Run, executable: string, args: string[], env: NodeJS.ProcessEnv, callbacks: RuntimeCallbacks, placement: PtyPlacement = {}): RuntimeHandle {
  const helper = process.env.AIWS_CONTROL_PTY_HELPER ?? join(dirname(fileURLToPath(import.meta.url)), 'pty-host.js');
  const child = spawn(process.env.AIWS_NODE_BINARY ?? 'node', [helper], { cwd: project.repositoryPath, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const watchdog = child.pid ? superviseProcess(child.pid, run.executionMode === 'docker' ? `aiws-control-${run.id}` : '') : undefined;
  let resolveExit: (() => void) | undefined;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  let closed = false; let pauseResolve: ((mode: 'suspended' | 'checkpoint') => void) | undefined;
  const finish = (code: number, message?: string): void => { if (closed) return; closed = true; if (watchdog?.connected) watchdog.send('done', () => { try { watchdog.disconnect(); } catch { /* Already disconnected. */ } }); callbacks.close(code, message); };
  child.on('error', (error) => { resolveExit?.(); finish(127, error.message); }); child.once('exit', (code) => { resolveExit?.(); finish(code ?? 1); });
  child.stderr?.on('data', (data: Buffer) => callbacks.output('stderr', data.toString()));
  child.on('message', (raw: unknown) => {
    const message = raw as Record<string, any>;
    if (message.type === 'output') callbacks.output('terminal', message.data);
    if (message.type === 'exit') finish(message.code);
    if (message.type === 'error') { callbacks.output('stderr', message.message); finish(127, message.message); child.kill(); }
    if (message.type === 'paused') { pauseResolve?.(message.mode); pauseResolve = undefined; }
  });
  const send = (message: unknown): void => { if (!child.connected) throw new ControlError('Terminal process is not connected.', 409); child.send(message as any, (error) => { if (error) { callbacks.output('stderr', error.message); finish(127, error.message); } }); };
  send({ type: 'start', executable, args, env, cwd: placement.cwd ?? project.repositoryPath, cols: run.cols ?? 100, rows: run.rows ?? 30, cursor: placement.cursor });
  return { pid: child.pid, input: (data) => send({ type: 'input', data }), resize: (cols, rows) => send({ type: 'resize', cols, rows }), clear: () => send({ type: 'clear' }),
    stop: async () => {
      if (!closed) { if (run.executionMode === 'docker') await dockerControl(['rm', '--force', `aiws-control-${run.id}`]); else send({ type: 'stop' }); }
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => { child.kill(); resolve(); }, 5000);
        exited.then(() => { clearTimeout(timeout); resolve(); });
      });
    },
    pause: async () => {
      if (run.executionMode === 'docker') { await dockerControl(['pause', `aiws-control-${run.id}`]); return 'suspended'; }
      return await new Promise<'suspended' | 'checkpoint'>((resolve, reject) => { const timeout = setTimeout(() => { pauseResolve = undefined; reject(new ControlError('Terminal pause timed out.', 409)); }, 10000); pauseResolve = (mode) => { clearTimeout(timeout); resolve(mode); }; send({ type: 'pause' }); });
    }, resume: async () => { if (run.executionMode === 'docker') await dockerControl(['unpause', `aiws-control-${run.id}`]); else send({ type: 'resume' }); } };
}
