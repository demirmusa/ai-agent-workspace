import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { aiProviders } from '../ai-providers/index.js';
import { imageSources, type Attachments } from '../attachments.js';
import { materializeRunSkills } from '../catalog.js';
import { gitQuery } from '../git.js';
import type { SessionHistory } from '../history.js';
import { providerExecutionInfo } from '../provider-args.js';
import { DIRECT_PROMPT_LIMIT, launchRuntime } from '../runner.js';
import { ControlError, type Run, type Task, type TaskSession } from '../types.js';
import { nextWorkflowStep, selectWorkflow, snapshotWorkflow } from '../workflows.js';
import { isRepository, prepareTaskBranch } from '../workspace.js';
import { hasStaleMainInstall, linkWorktreeDependencies, refreshStaleMainInstalls, skippedDependencyReasons } from '../worktree-dependencies.js';
import { prepareTaskWorktree, worktreeNeedsRestore } from '../worktrees.js';
import { continuationOrder, ExecutionCapacityError, newId, now, restoreTask, runEnded } from './common.js';
import type { ControlContext } from './context.js';
import type { ExecutionResolver } from './execution.js';
import type { RunPromptBuilder } from './run-prompt.js';
import type { RunSignals } from './run-controls.js';
import type { RunOutput } from './run-output.js';

export interface RunLauncherDependencies {
  history: SessionHistory;
  attachments: Attachments;
  execution: ExecutionResolver;
  prompt: RunPromptBuilder;
  output: RunOutput;
  signals: RunSignals;
  /** Agent profiles held by a planning request. */
  planningAgents: ReadonlySet<string>;
  /** Where agents reach the control API. */
  connection(): { url: string; token: string | undefined };
  /** The task was working when the system stopped, so its workflow may still advance. */
  draining(taskId: string): boolean;
  /** A session operation (continuation, handoff, transfer) of the task is in progress. */
  continuing(taskId: string): boolean;
  assertDeliveryIdle(task: Task): void;
  dependencySatisfied(task: Task): boolean;
  hasMergeTarget(task: Task): boolean;
  mergeIfDue(task: Task): void;
  recheckGitHubRemote(task: Task): void;
  finish(run: Run, status: Run['status'], code: number, message?: string): void;
  recordSession(run: Run, sessionId: string, source: TaskSession['source']): void;
  pendingQuestion(runId: string): boolean;
  usageLimitWaiting(runId: string): boolean;
  cancelQuestions(runId: string, source: 'terminal'): void;
}

/** Starts task runs: capacity and workspace checks, the execution snapshot, the workspace, and the provider process. */
export class RunLauncher {
  /** Ready tasks whose workspace could not be prepared; the queue retries them with backoff. */
  private workspaceRetry = new Map<string, { at: number; count: number }>();
  constructor(private readonly ctx: ControlContext, private readonly deps: RunLauncherDependencies) {}

  /** When a ready task whose workspace failed may be tried again. */
  retryAt(taskId: string): number { return this.workspaceRetry.get(taskId)?.at ?? 0; }
  forget(taskIds: ReadonlySet<string>): void { for (const taskId of taskIds) this.workspaceRetry.delete(taskId); }
  restart(taskId: string): Run {
    const task = this.ctx.task(taskId);
    const previous = task.currentRunId ? this.ctx.run(task.currentRunId) : undefined;
    if (!previous || !['failed', 'interrupted', 'cancelled'].includes(previous.status)) throw new ControlError('Only failed, interrupted or cancelled executions can restart.', 409);
    if (this.ctx.handles.has(previous.id)) throw new ControlError('The previous process is still stopping. Retry shortly.', 409);
    const before = structuredClone(task);
    // Retry the failed workflow stage, keeping completed stages and their snapshot.
    if (task.workflowProgress?.status === 'failed') task.workflowProgress.status = 'running';
    try { return this.start(taskId, true); }
    catch (error) { restoreTask(task, before); throw error; }
  }
  start(taskId: string, restarting = false, mergeRecovery?: string): Run {
    const { ctx, deps } = this, state = ctx.state, task = ctx.task(taskId);
    if (task.archivedAt) throw new ControlError('Restore the archived task before starting it.', 409);
    if (task.queuedContinuation && !mergeRecovery && !deps.continuing(taskId)) throw new ControlError('Start the queued continuation to resume or confirm history fallback.', 409);
    const previous = task.freshStart ? undefined : state.runs.filter((run) => run.taskId === taskId).at(-1);
    const workflowNext = task.workflowProgress?.status === 'running' && previous?.workflowId === task.workflowProgress.definition.id && previous.stageIndex !== task.workflowProgress.stepIndex;
    if (!state.settings.systemEnabled && !(workflowNext && deps.draining(taskId))) throw new ControlError('System is stopped. Enable the system to start new tasks.', 409);
    if (previous && aiProviders.isHistoryProvider(previous.provider) && runEnded(previous) && !workflowNext && !restarting && !deps.continuing(taskId)) throw new ControlError('Send a new instruction from Agent Console to continue the original provider session.', 409);
    if (task.externalHistory && !mergeRecovery && !deps.continuing(taskId)) throw new ControlError('This task follows an original provider session. Open Agent Console and send a new instruction to continue it.', 409);
    if (task.externalDependency) throw new ControlError('This record only tracks an external GitHub dependency and cannot run an agent.', 409);
    if (ctx.running(task)) throw new ControlError('Task already has an active run.', 409);
    if (task.dependsOn.some((dependency) => !deps.dependencySatisfied(ctx.task(dependency)))) throw new ControlError('Task dependencies are not done.', 409);
    const capacity = this.capacity(task);
    if (capacity.global) throw capacity.global;
    deps.assertDeliveryIdle(task);
    deps.recheckGitHubRemote(task);
    const project = ctx.project(task.projectId);
    if (capacity.project) throw capacity.project;
    if (worktreeNeedsRestore(task)) task.worktree = prepareTaskWorktree(project, task, ctx.store.directory, task.worktree.mainBranch);
    if (task.historyResume && !mergeRecovery) {
      if (state.settings.executionMode !== 'native') throw new ControlError('Historical host sessions require native execution mode on the machine owning their provider history.', 409);
      if (!task.historyResume.recorded) deps.history.assertResume(ctx.taskWorkspace(task), task.historyResume.sourceId, task.historyResume.sessionId);
      if (task.terminalMode === 'stream' && !task.historyResume.initialMessage.trim()) throw new ControlError('Add a new message before resuming this session in stream mode, or use a native terminal.', 409);
    }
    // Scheduled tasks run unattended: a shared checkout left dirty by one occurrence would block every later one.
    const isolated = Boolean(task.worktree || (!project.general && !task.historyResume && !task.externalHistory && (project.useWorktree || (task.scheduleId && isRepository(project.repositoryPath)))));
    const workspacePath = task.worktree?.path ?? project.repositoryPath;
    // An earlier run of this same task that no longer has a process is a leftover record, not another agent.
    if (state.runs.some((run) => (ctx.handles.has(run.id) || !runEnded(run) && (run.taskId !== task.id || run.id === task.currentRunId)) && (isolated && !task.worktree ? run.taskId === task.id : ctx.runWorkspace(run) === workspacePath))) throw new ControlError('Another agent is using this workspace. Use a separate Git worktree for parallel work.', 409);
    const fresh = !mergeRecovery && !task.historyResume && !task.historyTransfer && !task.conversationContext;
    if (fresh && (!task.workflowProgress || task.workflowProgress.status !== 'running')) {
      const definition = selectWorkflow(task, project, state.workflows);
      if (definition) task.workflowProgress = { definition: snapshotWorkflow(definition, task), stepIndex: -1, status: 'running' };
    }
    if (task.workflowProgress?.status === 'running') {
      const progress = task.workflowProgress;
      if (progress.stepIndex < 0) progress.stepIndex = nextWorkflowStep(progress.definition, -1, task) ?? 0;
      const step = progress.definition.steps[progress.stepIndex]!;
      task.agentId = step.agentId; delete task.providerOverride; delete task.modelOverride; delete task.reasoningEffort; delete task.command;
    }
    if (fresh && !task.agentId && !task.command && state.agents.some((agent) => agent.provider === (task.providerOverride ?? task.provider))) {
      const candidate = deps.execution.chooseAgent(task); if (!candidate) throw new ControlError('No suitable agent is currently available.', 409); task.agentId = candidate.id;
    }
    if (task.agentId && (deps.planningAgents.has(task.agentId) || state.runs.some((run) => run.executionSnapshot?.agent?.id === task.agentId && ctx.busy(run)))) throw new ControlError('Assigned agent is currently busy.', 409);
    const executionSnapshot = mergeRecovery && previous?.executionSnapshot ? structuredClone(previous.executionSnapshot) : deps.execution.resolve(task);
    if (mergeRecovery) executionSnapshot.task = { title: task.title, description: `${mergeRecovery}\n\nOriginal task context:\n${task.description}` };
    task.provider = executionSnapshot.provider;
    if (executionSnapshot.model === undefined) delete task.model; else task.model = executionSnapshot.model;
    delete task.queueReason; delete task.handoffRequest; delete task.freshStart;
    const run: Run = { id: newId('run'), taskId, status: 'running', provider: executionSnapshot.provider, startedAt: now(), finishedAt: null,
      exitCode: null, executionMode: state.settings.executionMode, pendingCommands: [...(task.githubInstructions ?? [])], continuation: 0, executionSnapshot, terminalMode: executionSnapshot.terminalMode ?? 'pty', terminalOutput: '', cols: 100, rows: 30, activeMs: 0, lastResumedAt: now(), lastActivityAt: now(),
      ...(task.workflowProgress?.status === 'running' ? { workflowId: task.workflowProgress.definition.id, stageIndex: task.workflowProgress.stepIndex } : {}) };
    if (task.historyResume && !mergeRecovery) {
      run.historyResume = structuredClone(task.historyResume); run.sessionId = task.historyResume.sessionId;
      // The resumed session belongs to the agent that opened it.
      if (!executionSnapshot.agent && previous?.executionSnapshot?.agent) executionSnapshot.agent = structuredClone(previous.executionSnapshot.agent);
    } else if (run.provider !== 'command' && aiProviders.get(run.provider)?.assignsSessionId && run.executionMode === 'native') run.sessionId = randomUUID();
    if (isolated) task.worktree = this.prepareWorkspace(taskId, () => prepareTaskWorktree(project, task, ctx.store.directory, project.mainBranch ?? 'main'));
    run.workspacePath = task.worktree?.path ?? project.repositoryPath;
    if (!isolated && !task.worktree && !project.general && (!task.historyResume || task.taskBranch)) this.prepareWorkspace(taskId, () => prepareTaskBranch(project, task));
    this.workspaceRetry.delete(taskId);
    run.executionInfo = { ...providerExecutionInfo(run.provider, ctx.providerSettings(task.projectId).providerArgs, executionSnapshot.model, executionSnapshot.reasoningEffort), cwd: run.executionMode === 'docker' ? '/workspace' : run.workspacePath };
    // Non-Git projects can still run agents.
    const worktreePath = project.general ? '' : gitQuery(run.workspacePath, ['rev-parse', '--show-toplevel'], 3000);
    if (worktreePath) { const branch = gitQuery(run.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'], 3000); Object.assign(run.executionInfo, { worktreePath, branch, detached: branch === 'HEAD' }); }
    const skillsDirectory = materializeRunSkills(ctx.store.directory, run.id, executionSnapshot);
    if (skillsDirectory) run.skillsDirectory = skillsDirectory;
    run.inputDirectory = join(ctx.store.directory, 'runs', run.id, 'input'); mkdirSync(run.inputDirectory, { recursive: true, mode: 0o755 });
    task.currentRunId = run.id; task.status = 'running'; delete task.deliveryVerifiedAt; delete task.queuedContinuation; delete task.githubInstructions; task.updatedAt = now(); state.runs.push(run);
    if (run.sessionId) deps.recordSession(run, run.sessionId, run.historyResume ? 'provider' : 'assigned');
    ctx.event(run.id, taskId, 'started', `Starting ${run.provider} in ${run.executionMode} mode.${executionSnapshot.agent ? ` Agent: ${executionSnapshot.agent.name} revision ${executionSnapshot.agent.revision}.` : ''}`); ctx.changed(); this.launch(run); return structuredClone(run);
  }
  /** Starts a provider turn of the run: links dependencies, prepares attached images and the account, writes the prompt and spawns the process. */
  launch(run: Run): void {
    const task = this.ctx.task(run.taskId);
    // Docker runs would receive host-built native modules, so only native runs reuse the main checkout's install.
    const worktree = task.worktree && run.workspacePath === task.worktree.path && run.executionMode === 'native' ? task.worktree : undefined;
    const linkDependencies = (): void => {
      if (!worktree) return;
      const linked = linkWorktreeDependencies(worktree.repositoryPath, worktree.path);
      if (linked.length) this.ctx.event(run.id, run.taskId, 'workspace', `Linked installed dependencies from the main checkout: ${linked.join(', ')}.`);
      const skipped = skippedDependencyReasons(worktree.repositoryPath, worktree.path);
      if (skipped.length) this.ctx.event(run.id, run.taskId, 'workspace', `Dependencies were not linked, the agent has to install them: ${skipped.join('; ')}.`);
    };
    const description = run.executionSnapshot?.task.description ?? task.description;
    const images = Boolean(run.inputDirectory && imageSources(description).length), account = run.executionSnapshot?.account;
    const accounts = account && run.provider !== 'command' ? aiProviders.get(run.provider)?.accounts : undefined;
    const stale = worktree && hasStaleMainInstall(worktree.repositoryPath, worktree.path);
    if (!images && !accounts && !stale) { linkDependencies(); this.spawn(run); return; }
    const failed = (stage: string) => (error: unknown): never => { throw new Error(`${stage} failed: ${(error as Error).message}`); };
    const refreshed = stale ? (this.ctx.event(run.id, run.taskId, 'workspace', "The main checkout's install lags behind its lockfile; running npm install there so the task can share it."),
      refreshStaleMainInstalls(worktree.repositoryPath, worktree.path).then((lines) => { this.ctx.event(run.id, run.taskId, 'workspace', `${lines.join('; ')}.`); })) : Promise.resolve();
    void Promise.all([
      images ? this.deps.attachments.materialize(description, run.inputDirectory!, run.executionMode === 'docker').catch(failed('Image preparation')) : undefined,
      accounts ? accounts.launchEnv(account!).catch(failed('Account preparation')) : undefined,
      refreshed,
    ]).then(([rewritten, accountEnv]) => {
      if (this.ctx.closing || !['running', 'waiting'].includes(run.status)) return;
      linkDependencies(); this.spawn(run, rewritten, accountEnv);
    }).catch((error) => { if (!this.ctx.closing && !runEnded(run)) this.deps.finish(run, 'failed', 1, (error as Error).message); });
  }
  /** Why the task cannot take an execution slot now. */
  capacityError(task: Task): ExecutionCapacityError | undefined { const { global, project } = this.capacity(task); return global ?? project; }
  /** Continuations waiting for a slot hold the next free ones ahead of other ready tasks, in the order they were queued. */
  private capacity(task: Task): { global?: ExecutionCapacityError; project?: ExecutionCapacityError } {
    const { ctx } = this, occupied = this.occupiedTasks(task.id), counts = new Map<string, number>();
    for (const item of occupied) counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1);
    const room = (projectId: string): boolean => { const limit = ctx.project(projectId).maxConcurrent; return limit === undefined || (counts.get(projectId) ?? 0) < limit; };
    let total = occupied.length;
    const waiting = (item: Task): boolean => item.status === 'ready' && !item.archivedAt && Boolean(item.queuedContinuation?.awaitingSlot) && !item.queuedContinuation!.confirmationRequired;
    // A continuation whose project is full cannot use a free global slot, so it does not hold one.
    for (const item of ctx.state.tasks.filter((item) => item.id !== task.id && waiting(item) && (!waiting(task) || continuationOrder(item, task) < 0)).sort(continuationOrder)) {
      if (!room(item.projectId)) continue;
      counts.set(item.projectId, (counts.get(item.projectId) ?? 0) + 1); total++;
    }
    return { ...(total >= ctx.state.settings.maxConcurrent ? { global: new ExecutionCapacityError('All execution slots are occupied.', 409) } : {}),
      ...(!room(task.projectId) ? { project: new ExecutionCapacityError('All execution slots of this project are occupied.', 409) } : {}) };
  }
  /** Active processes always count; archived delivery records no longer reserve capacity. */
  private occupiedTasks(excludeTaskId: string): Task[] {
    const working = new Set(this.ctx.state.runs.filter((run) => this.ctx.busy(run)).map((run) => run.taskId));
    return this.ctx.state.tasks.filter((task) => task.id !== excludeTaskId && (working.has(task.id)
      || (!task.archivedAt && (task.status === 'completing' || task.queuedContinuation?.mergeRecovery || (task.status === 'review' && this.deps.hasMergeTarget(task))))));
  }
  private prepareWorkspace<T>(taskId: string, prepare: () => T): T {
    try { return prepare(); } catch (error) {
      const count = (this.workspaceRetry.get(taskId)?.count ?? 0) + 1;
      this.workspaceRetry.set(taskId, { at: Date.now() + Math.min(60_000, 5_000 * 2 ** (count - 1)), count });
      throw error;
    }
  }
  private spawn(run: Run, description?: string, accountEnv?: Record<string, string>): void {
    const { ctx, deps } = this;
    if (ctx.closing) return;
    const task = ctx.task(run.taskId); const base = ctx.project(task.projectId), project = { ...base, repositoryPath: run.workspacePath ?? base.repositoryPath };
    const prompt = deps.prompt.build(run, description); run.pendingCommands = []; run.status = 'running'; task.status = 'running'; delete task.deliveryVerifiedAt;
    if (run.inputDirectory) {
      if (!run.historyResume || prompt.length > DIRECT_PROMPT_LIMIT || run.executionMode === 'docker') writeFileSync(join(run.inputDirectory, 'prompt.md'), prompt, { mode: 0o644 });
      writeFileSync(join(run.inputDirectory, 'agents.json'), JSON.stringify(run.executionSnapshot?.directory ?? [], null, 2), { mode: 0o644 });
    }
    const reader = deps.output.reader(run, task), { url, token } = deps.connection();
    try {
      const handle = launchRuntime(project, task, run, prompt, { image: ctx.state.settings.dockerImage, providerArgs: deps.execution.launchProviderArgs(project.id),
        controlUrl: process.env.AIWS_CONTROL_AGENT_URL ?? url, ...(token ? { token } : {}), ...(accountEnv ? { accountEnv } : {}), ...(aiProviders.isHistoryProvider(run.historyResume?.provider) ? { providerHome: deps.history.home(run.historyResume.provider) } : {}) }, {
        output: (stream, value) => { if (!ctx.closing) reader.write(stream, value); },
        close: (code, error) => {
          ctx.handles.delete(run.id); delete run.pid;
          deps.output.closed(run.id);
          if (ctx.closing) return;
          reader.end();
          deps.cancelQuestions(run.id, 'terminal');
          const { signals } = deps;
          if (signals.pausing.has(run.id) || signals.checkpoint.has(run.id)) { signals.checkpoint.add(run.id); ctx.changed(); return; }
          const interrupted = signals.interrupting.delete(run.id);
          if (runEnded(run)) { ctx.changed(); deps.mergeIfDue(task); return; }
          if (deps.usageLimitWaiting(run.id)) {
            run.status = 'waiting'; task.status = 'waiting'; task.updatedAt = now();
            ctx.event(run.id, task.id, 'waiting', `Waiting for ${run.provider} quota reset to continue automatically.`);
            ctx.changed(); return;
          }
          if (reader.failure) { deps.finish(run, 'failed', code, reader.failure); return; }
          if (deps.pendingQuestion(run.id)) {
            run.status = 'waiting'; task.status = 'waiting'; ctx.event(run.id, task.id, 'waiting', 'Execution ended while awaiting an answer. Answer to continue.'); ctx.changed(); return;
          }
          if (interrupted && !run.pendingCommands.length) { signals.idle.add(run.id); ctx.event(run.id, task.id, 'interrupted.turn', 'Stopped by user. Waiting for the next instruction.'); ctx.changed(); return; }
          if (run.pendingCommands.length) { run.continuation++; ctx.event(run.id, task.id, 'continuation', 'Applying queued user instructions in a new provider turn.'); ctx.changed(); this.launch(run); return; }
          deps.finish(run, code === 0 && !reader.failure ? 'completed' : 'failed', code, reader.failure ?? error);
        },
      });
      ctx.handles.set(run.id, handle); if (handle.pid) run.pid = handle.pid; ctx.changed();
    } catch (error) { deps.finish(run, 'failed', 127, (error as Error).message); }
  }
}
