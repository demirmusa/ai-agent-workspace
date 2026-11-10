import { EventEmitter } from 'node:events';
import { isAbsolute, join, relative } from 'node:path';
import { isPathInside } from '../shared/core/paths.js';
import { AgentGraph } from './agent-graph.js';
import { aiProviders } from './ai-providers/index.js';
import type { ProviderUsage } from './ai-providers/usage.js';
import { Attachments } from './attachments.js';
import { ControlCatalog, SKILL_LIMITS } from './catalog.js';
import { ContextWindows } from './context-window.js';
import { ControlGitHub, type GitHubAuthStatus } from './github.js';
import { HistoryTaskImporter } from './history-import.js';
import { SessionHistory, type HistoryOptions } from './history.js';
import { LiveSessions, type LiveSessionOptions } from './live-sessions.js';
import { openAbsolutePath, openProjectPath } from './project-files.js';
import { ProjectTerminals, type ProjectTerminal } from './project-terminals.js';
import { ProviderModels, type ProviderModelOptions } from './provider-models.js';
import type { GitChanges, GitMergeResult, GitOverview } from './repository-git.js';
import { RunScriptMemory } from './run-script-memory.js';
import { TaskDraftMemory } from './task-draft.js';
import { ScheduleCatalog } from './schedules.js';
import { readTextHead } from './source-files.js';
import { SkillDiscovery, parseSkillFrontmatter, type SkillDiscoveryOptions } from './skill-discovery.js';
import { ControlStore } from './store.js';
import { DEFAULT_CONTROL_URL } from '../shared/core/control-endpoint.js';
import { ControlError, type ContextWindowResult, type ControlSettings, type ControlState, type DefaultProvider, type Project, type ProviderModelCatalog, type Question, type Run, type SkillDefinition, type Task, type TaskMessage, type TaskOrganization, type TaskSearchResult, type TaskSession, type TerminalPrompt } from './types.js';
import { jsonObject } from './validation.js';
import { warmPowerShellHost } from './windows-launch.js';
import { WorkflowCatalog } from './workflows.js';
import { AssistantRequests } from './service/assistant-requests.js';
import { StateBroadcaster } from './service/broadcaster.js';
import { ExecutionCapacityError, GENERAL_WORKSPACE_ID, now, runEnded } from './service/common.js';
import { ConnectionWatch } from './service/connection-watch.js';
import { ControlContext } from './service/context.js';
import { Conversations } from './service/conversations.js';
import { TaskDelivery } from './service/delivery.js';
import { ExecutionResolver } from './service/execution.js';
import { GitHubBridge } from './service/github-bridge.js';
import { Journal } from './service/journal.js';
import { MilestoneManager } from './service/milestones.js';
import { ProjectManager } from './service/projects.js';
import { ProviderSessions } from './service/provider-sessions.js';
import { Questions } from './service/questions.js';
import { ReadyQueueDispatcher } from './service/ready-queue.js';
import { RepositoryOperations } from './service/repository.js';
import { RunCompletion } from './service/run-completion.js';
import { RunControls, RunSignals } from './service/run-controls.js';
import { RunLauncher } from './service/run-launcher.js';
import { RunOutput } from './service/run-output.js';
import { RESTART_CONTINUE_MESSAGE, RunPromptBuilder, type PluginPrompt } from './service/run-prompt.js';
import { RunReports } from './service/run-reports.js';
import { SettingsManager } from './service/settings.js';
import { stateView } from './service/state-view.js';
import { TaskFieldValidator } from './service/task-fields.js';
import { TaskManager } from './service/tasks.js';
import { serviceTiming } from './service/timing.js';
import { UsageTriggers } from './service/usage-triggers.js';

export { GENERAL_WORKSPACE_ID, readyQueue } from './service/common.js';

export interface ControlServiceOptions { dataDir?: string; githubToken?: string; maxConcurrent?: number; token?: string; controlUrl?: string; history?: HistoryOptions; liveSessions?: LiveSessionOptions; skills?: SkillDiscoveryOptions; providerModels?: ProviderModelOptions }

/**
 * The control service: the public API of AI Agent Workspace over its state. Each domain
 * lives in a collaborator under `service/`; this class wires them together and keeps
 * the API that the server, CLI and plugins use.
 */
export class ControlService extends EventEmitter {
  readonly projectTerminals: ProjectTerminals;
  readonly store: ControlStore;
  readonly runScriptMemory: RunScriptMemory;
  readonly taskDraft: TaskDraftMemory;
  readonly attachments: Attachments;
  readonly catalog: ControlCatalog;
  readonly workflows: WorkflowCatalog;
  readonly schedules: ScheduleCatalog;
  readonly history: SessionHistory;
  readonly agentGraph: AgentGraph;
  readonly contextWindows = new ContextWindows();
  readonly liveSessions: LiveSessions;
  readonly historyImporter: HistoryTaskImporter;
  readonly skillDiscovery: SkillDiscovery;
  readonly providerModels: ProviderModels;
  /** Server plugins add task context to agent prompts through this hook (PluginManager.promptContributions). */
  pluginPrompt: PluginPrompt | undefined;

  private readonly ctx: ControlContext;
  private readonly broadcaster: StateBroadcaster;
  private readonly github: ControlGitHub;
  private readonly settings: SettingsManager;
  private readonly projects: ProjectManager;
  private readonly milestones: MilestoneManager;
  private readonly tasks: TaskManager;
  private readonly execution: ExecutionResolver;
  private readonly signals = new RunSignals();
  private readonly output: RunOutput;
  private readonly promptBuilder: RunPromptBuilder;
  private readonly launcher: RunLauncher;
  private readonly completion: RunCompletion;
  private readonly controls: RunControls;
  private readonly reports: RunReports;
  private readonly questions: Questions;
  private readonly conversations: Conversations;
  private readonly sessions: ProviderSessions;
  private readonly delivery: TaskDelivery;
  private readonly repository: RepositoryOperations;
  private readonly githubBridge: GitHubBridge;
  private readonly assistant: AssistantRequests;
  private readonly usageTriggers: UsageTriggers;
  private readonly connectionWatch: ConnectionWatch;
  private readonly readyQueue: ReadyQueueDispatcher;
  private readonly timer: NodeJS.Timeout;
  private url: string;
  private token: string | undefined;

  static async open(options: ControlServiceOptions = {}): Promise<ControlService> { return new ControlService(options); }
  /** Whether `url` is the real listening address; terminals restored before that find the service through its lock. */
  private connected = false;
  constructor(options: ControlServiceOptions = {}) {
    super();
    this.store = new ControlStore(options.dataDir); this.runScriptMemory = new RunScriptMemory(this.store); this.taskDraft = new TaskDraftMemory(this.store);
    const store = this.store;
    this.projectTerminals = new ProjectTerminals((runId, offset, data) => this.broadcaster.terminal(runId, offset, data), (projectId) => this.emit('shells', { projectId }), () => store.state.settings,
      { get terminals() { return store.state.terminals; }, appendTerminal: (run, data) => store.appendTerminal(run, data), terminalOutput: (run) => store.terminalOutput(run), scheduleSave: () => store.scheduleSave() }, () => this.connected ? { url: process.env.AIWS_CONTROL_AGENT_URL ?? this.url, ...(this.token ? { token: this.token } : {}) } : undefined);
    this.url = options.controlUrl ?? DEFAULT_CONTROL_URL; this.token = options.token;
    const ctx = this.ctx = new ControlContext(this.store, new Journal(this.store, () => this.token), (change) => this.broadcaster.changed(change));
    const changed = (): void => ctx.changed();
    const connection = (): { url: string; token: string | undefined } => ({ url: this.url, token: this.token });
    this.broadcaster = new StateBroadcaster(this.store, (event, ...args) => this.emit(event, ...args), (includeJournal) => this.view(includeJournal));
    this.attachments = new Attachments(this.store.directory, options.githubToken ?? process.env.AIWS_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN, fetch, () => this.store.state.projects.map((project) => project.repositoryPath));
    this.history = new SessionHistory(options.history);
    this.agentGraph = new AgentGraph(this.history);
    this.liveSessions = new LiveSessions(this.history, options.liveSessions, () => this.store.state);
    this.historyImporter = new HistoryTaskImporter(this.history, this.store, changed, (project, provider, sessionId) => this.liveSessions.activity(project, provider, sessionId));
    this.catalog = new ControlCatalog(this.store, changed);
    this.skillDiscovery = new SkillDiscovery({ ...(options.history?.claudeHome ? { claudeHome: options.history.claudeHome } : {}), ...(options.history?.codexHome ? { codexHome: options.history.codexHome } : {}), ...options.skills });
    this.workflows = new WorkflowCatalog(this.store, changed);
    this.providerModels = new ProviderModels(options.providerModels);
    this.github = new ControlGitHub(options.githubToken);

    this.assistant = new AssistantRequests(ctx, { catalog: this.catalog, emit: (event, payload) => this.emit(event, payload), createTask: (input) => this.createTask(input), launchProviderArgs: (projectId) => this.execution.launchProviderArgs(projectId), connection });
    this.execution = new ExecutionResolver(ctx, this.catalog, this.assistant.planningAgents);
    this.settings = new SettingsManager(ctx, () => this.tasks.refreshInheritedProviders());
    this.delivery = new TaskDelivery(ctx, { github: this.github, autoMerge: (task) => this.execution.autoMerge(task), continuing: (taskId) => this.conversations.continuing(taskId), createTask: (input) => this.createTask(input) });
    this.reports = new RunReports(ctx, { usageSource: () => this.usageTriggers.source, clearPrompt: (runId) => this.output.clearPrompt(runId), typeIntoTerminal: (runId, message) => this.controls.typeIntoTerminal(runId, message),
      launch: (run) => this.launcher.launch(run), sendTaskMessage: (taskId, input, author) => this.sendTaskMessage(taskId, input, author), restartTask: (taskId) => this.restartTask(taskId) });
    this.questions = new Questions(ctx, { launch: (run) => this.launcher.launch(run), postIssueComment: (project, task, body, runId) => this.githubBridge.postIssueComment(project, task, body, runId) });
    this.output = new RunOutput(ctx, { broadcaster: this.broadcaster, ask: (runId, input, prompt) => this.ask(runId, input, prompt), detectUsageLimit: (run, text) => this.reports.detectUsageLimit(run, text),
      recordSession: (run, sessionId, source) => this.reports.recordSession(run, sessionId, source), pendingQuestion: (runId) => this.questions.pending(runId), usageLimitWaiting: (runId) => this.reports.waitingForReset(runId), dialogClosed: (question) => this.questions.dialogClosed(question) });
    this.completion = new RunCompletion(ctx, { history: this.history, signals: this.signals, autoMerge: (task) => this.execution.autoMerge(task), hasMergeTarget: (task) => this.delivery.hasMergeTarget(task), mergeIfDue: (task) => this.delivery.mergeIfDue(task), recheckGitHubRemote: (task) => this.delivery.recheckGitHubRemote(task),
      cancelQuestions: (runId) => this.questions.cancel(runId), takeUsage: (runId) => this.output.takeUsage(runId), reply: (runId, input) => this.reply(runId, input), postRunReply: (task, run, status, summary) => this.githubBridge.postRunReply(task, run, status, summary) });
    this.promptBuilder = new RunPromptBuilder(ctx, () => this.pluginPrompt);
    this.launcher = new RunLauncher(ctx, { history: this.history, attachments: this.attachments, execution: this.execution, prompt: this.promptBuilder, output: this.output, signals: this.signals,
      planningAgents: this.assistant.planningAgents, connection, draining: (taskId) => this.settings.draining(taskId), continuing: (taskId) => this.conversations.continuing(taskId),
      assertDeliveryIdle: (task) => this.delivery.assertDeliveryIdle(task), dependencySatisfied: (task) => this.delivery.dependencySatisfied(task), hasMergeTarget: (task) => this.delivery.hasMergeTarget(task), mergeIfDue: (task) => this.delivery.mergeIfDue(task), recheckGitHubRemote: (task) => this.delivery.recheckGitHubRemote(task),
      finish: (run, status, code, message) => this.completion.finish(run, status, code, message), recordSession: (run, sessionId, source) => this.reports.recordSession(run, sessionId, source),
      pendingQuestion: (runId) => this.questions.pending(runId), usageLimitWaiting: (runId) => this.reports.waitingForReset(runId), cancelQuestions: (runId, source) => this.questions.cancel(runId, source) });
    this.controls = new RunControls(ctx, { signals: this.signals, broadcaster: this.broadcaster, questions: this.questions, launch: (run) => this.launcher.launch(run),
      finish: (run, status, code, message) => this.completion.finish(run, status, code, message), clearPrompt: (runId) => this.output.clearPrompt(runId),
      usageLimitWaiting: (runId) => this.reports.waitingForReset(runId), clearUsageWait: (runId) => this.reports.clearWait(runId) });
    this.conversations = new Conversations(ctx, { typeIntoSessionTerminal: (projectId, sessionIds, message) => this.projectTerminals.typeIntoSession(projectId, sessionIds, message), history: this.history, liveSessions: this.liveSessions, catalog: this.catalog, signals: this.signals, startTask: (taskId) => this.startTask(taskId), sendTaskMessage: (taskId, input, author) => this.sendTaskMessage(taskId, input, author), postMessage: (taskId, input) => this.postMessage(taskId, input),
      startRun: (taskId, restarting, mergeRecovery) => this.launcher.start(taskId, restarting, mergeRecovery), createTask: (input) => this.createTask(input), answer: (questionId, input) => this.answer(questionId, input), command: (runId, input) => this.command(runId, input),
      finish: (run, status, code, message) => this.completion.finish(run, status, code, message), isSettling: (runId) => this.completion.isSettling(runId), release: (run) => this.completion.release(run), assertDeliveryIdle: (task) => this.delivery.assertDeliveryIdle(task),
      capacityError: (task) => this.launcher.capacityError(task) });
    this.sessions = new ProviderSessions(ctx, { history: this.history, liveSessions: this.liveSessions, historyImporter: this.historyImporter, projectTerminals: this.projectTerminals, conversations: this.conversations, createTask: (input) => this.createTask(input),
      sendTaskMessage: (taskId, input) => this.sendTaskMessage(taskId, input), resumeTaskSession: (taskId, input) => this.resumeTaskSession(taskId, input) });
    this.milestones = new MilestoneManager(ctx);
    this.githubBridge = new GitHubBridge(ctx, this.github, { attachments: this.attachments, learnLabels: (projectId, tags) => this.projects.learnLabels(projectId, tags), applyMilestones: (project, before, result) => this.milestones.applySync(project, before, result), dependencySatisfied: (task) => this.delivery.dependencySatisfied(task), hasMergeTarget: (task) => this.delivery.hasMergeTarget(task),
      answer: (questionId, input) => this.answer(questionId, input), postMessage: (taskId, input) => this.postMessage(taskId, input), sendTaskMessage: (taskId, input) => this.sendTaskMessage(taskId, input),
      updateProject: (projectId, input) => this.updateProject(projectId, input), importLabels: (projectId, input) => this.importGitHubLabels(projectId, input), exportLabels: (projectId) => this.exportGitHubLabels(projectId) });
    this.repository = new RepositoryOperations(ctx, this.github, this.delivery);
    const fields = new TaskFieldValidator(ctx, this.catalog, this.workflows);
    this.tasks = new TaskManager(ctx, { fields, github: this.github, learnLabels: (projectId, tags) => this.projects.learnLabels(projectId, tags), syncing: (projectId) => this.githubBridge.syncing(projectId), releaseForDone: (task) => this.completion.releaseForDone(task), releaseForCancel: (task) => this.completion.releaseForCancel(task),
      assertDeliveryIdle: (task) => this.delivery.assertDeliveryIdle(task), hasMergeTarget: (task) => this.delivery.hasMergeTarget(task), usesPullRequests: (task) => this.delivery.usesPullRequests(task), recheckGitHubRemote: (task) => this.delivery.recheckGitHubRemote(task),
      requestMerge: (task) => this.ctx.background(this.delivery.autoMerge(task, true)), mergeLocalTask: (task) => this.delivery.mergeLocalTask(task),
      createTask: (input, extra) => this.createTask(input, extra), updateTask: (taskId, input) => this.updateTask(taskId, input), forget: (taskIds) => { this.delivery.forget(taskIds); this.launcher.forget(taskIds); } });
    this.schedules = new ScheduleCatalog(this.store, {
      template: (projectId, input, previous) => fields.scheduleTemplate(projectId, input, previous),
      createTask: (schedule, occurrence) => this.tasks.createScheduled(schedule, occurrence),
      projectExists: (projectId) => this.store.state.projects.some((project) => project.id === projectId) || projectId === GENERAL_WORKSPACE_ID,
      systemEnabled: () => this.store.state.settings.systemEnabled,
      event: (taskId, type, message, data) => ctx.event(null, taskId, type, message, data),
      changed,
    });
    this.projects = new ProjectManager(ctx, { github: this.github, openTerminals: (projectId) => this.projectTerminals.list(projectId).length, syncing: (projectId) => this.githubBridge.syncing(projectId),
      deleteTasks: (projectId) => this.tasks.deleteProjectTasks(projectId), refreshInheritedProviders: (projectId) => this.tasks.refreshInheritedProviders(projectId),
      forget: (projectId) => { this.schedules.deleteProject(projectId); this.githubBridge.forget(projectId); this.assistant.forget(projectId); } });
    this.usageTriggers = new UsageTriggers(ctx);
    this.connectionWatch = new ConnectionWatch(ctx, { screen: (runId) => this.output.screen(runId), isSettling: (runId) => this.completion.isSettling(runId), pendingQuestion: (runId) => this.questions.pending(runId),
      usageLimitWaiting: (runId) => this.reports.waitingForReset(runId), finish: (run, status, code, message) => this.completion.finish(run, status, code, message), typeIntoTerminal: (runId, message) => this.controls.typeIntoTerminal(runId, message) });
    this.readyQueue = new ReadyQueueDispatcher(ctx, { startTask: (taskId) => this.startTask(taskId), startQueuedTask: (taskId) => this.startQueuedTask(taskId), publish: () => this.broadcaster.flush(), continuing: (taskId) => this.conversations.continuing(taskId),
      usageWaiting: (task, current) => this.usageTriggers.waiting(task, current), retryAt: (taskId) => this.launcher.retryAt(taskId), runtimeError: (error) => this.emit('runtimeError', error) });

    const state = this.store.state;
    if (options.maxConcurrent !== undefined) state.settings.maxConcurrent = options.maxConcurrent;
    const mode = process.env.AIWS_CONTROL_EXECUTION_MODE;
    if (mode === 'native' || mode === 'docker') state.settings.executionMode = mode;
    if (process.env.AIWS_CONTROL_DOCKER_IMAGE) state.settings.dockerImage = process.env.AIWS_CONTROL_DOCKER_IMAGE;
    // A run with a known provider session continues by itself below; one without is left for the user to restart.
    const interruptedTasks: string[] = [];
    for (const run of state.runs.filter((item) => !runEnded(item))) {
      run.status = 'interrupted'; run.finishedAt = now();
      const task = state.tasks.find((item) => item.id === run.taskId);
      const waitingLimit = Boolean(task?.handoffRequest?.runId === run.id && task.handoffRequest.resumeAt);
      const resumable = Boolean(task && !task.archivedAt && run.sessionId && aiProviders.isHistoryProvider(run.provider) && state.settings.executionMode === 'native' && !waitingLimit);
      if (task) { task.status = waitingLimit ? 'waiting' : 'failed'; task.updatedAt = now(); if (resumable) interruptedTasks.push(task.id); }
      this.questions.cancel(run.id);
      ctx.event(run.id, run.taskId, 'interrupted', waitingLimit ? `Service restarted. Previous execution is interrupted; waiting until ${task!.handoffRequest!.resumeAt} to continue.` : resumable ? 'Service restarted. Previous execution is interrupted; the agent resumes its session and continues.' : 'Service restarted. Previous execution is interrupted; inspect the workspace before retrying.');
    }
    for (const task of state.tasks) {
      if (task.status === 'done' && !this.delivery.dependencySatisfied(task)) { task.status = 'completing'; if (task.worktree) task.worktree.mergeRequested = true; if (task.pullRequest) task.pullRequest.mergeRequested = true; }
    }
    this.projects.ensureGeneralWorkspace();
    this.store.save();
    const resuming = new Set(state.tasks.filter((task) => task.historyResume && task.status === 'ready').map((task) => task.projectId));
    for (const project of state.projects) if (resuming.has(project.id)) void this.history.list(project).catch(() => {});
    ctx.background(this.delivery.warmGitHubRemotes());
    // Tasks the shutdown interrupted carry on: the agent resumes its session and is told what happened. A session that cannot be resumed continues in a new conversation with the saved history.
    for (const taskId of interruptedTasks) ctx.background(this.conversations.sendTaskMessage(taskId, { text: RESTART_CONTINUE_MESSAGE, continueSession: true, allowHistoryFallback: true }, 'system')
      .catch((error: unknown) => ctx.event(null, taskId, 'interrupted', `The interrupted session could not be resumed: ${error instanceof Error ? error.message : String(error)}`)));
    // Terminals of the previous service run come back where the user left them.
    void this.projectTerminals.restore((projectId) => { try { return ctx.project(projectId); } catch { return undefined; } }).catch((error: unknown) => this.emit('runtimeError', error));
    warmPowerShellHost(); this.broadcaster.markPublished();
    this.timer = setInterval(() => { this.tick(); }, 1_000); this.timer.unref();
  }

  static get terminalSubmitDelayMs(): number { return serviceTiming.terminalSubmitDelayMs; }
  static set terminalSubmitDelayMs(value: number) { serviceTiming.terminalSubmitDelayMs = value; }
  /** Quiet period after which a completed native TUI has finished its last turn. */
  static get completionQuietMs(): number { return serviceTiming.completionQuietMs; }
  static set completionQuietMs(value: number) { serviceTiming.completionQuietMs = value; }
  /** Quiet period after which a TUI showing a connection error has stopped its turn. */
  static get connectionQuietMs(): number { return serviceTiming.connectionQuietMs; }
  static set connectionQuietMs(value: number) { serviceTiming.connectionQuietMs = value; }
  static get connectionRecoveryAttempts(): number { return serviceTiming.connectionRecoveryAttempts; }
  static set connectionRecoveryAttempts(value: number) { serviceTiming.connectionRecoveryAttempts = value; }
  /** Failures further apart than this count as separate incidents. */
  static get connectionRecoveryWindowMs(): number { return serviceTiming.connectionRecoveryWindowMs; }
  static set connectionRecoveryWindowMs(value: number) { serviceTiming.connectionRecoveryWindowMs = value; }
  static get connectivityRetryMs(): number { return serviceTiming.connectivityRetryMs; }
  static set connectivityRetryMs(value: number) { serviceTiming.connectivityRetryMs = value; }
  static get connectivityProbe(): (provider: string) => Promise<boolean> { return serviceTiming.connectivityProbe; }
  static set connectivityProbe(value: (provider: string) => Promise<boolean>) { serviceTiming.connectivityProbe = value; }
  /** Extra wait after a quota reset timestamp before continuing the CLI (+1 minute by default). */
  static get usageLimitGraceMs(): number { return serviceTiming.usageLimitGraceMs; }
  static set usageLimitGraceMs(value: number) { serviceTiming.usageLimitGraceMs = value; }

  /** Supplies provider quota windows for usage-triggered tasks; set by the server. */
  get usageSource(): (() => Promise<ProviderUsage[]>) | undefined { return this.usageTriggers.source; }
  set usageSource(source: (() => Promise<ProviderUsage[]>) | undefined) { if (source) this.usageTriggers.source = source; else delete this.usageTriggers.source; }
  setConnection(url: string, token?: string): void { this.url = url; this.token = token; this.connected = true; }

  // State
  snapshot(): ControlState { return structuredClone(this.view()); }
  /** The state served to a newly connected client; read-only and shared with the live state. */
  publicState(includeJournal = true): ControlState { return this.view(includeJournal); }
  /** Orders the copies of the state a client receives over separate connections (state reads and the event stream). */
  stateRevision(): number { return this.broadcaster.revision; }
  project(projectId: string): Project { return this.ctx.project(projectId); }
  task(taskId: string): Task { return this.ctx.task(taskId); }
  run(runId: string): Run { return this.ctx.run(runId); }
  /** A finished run may point at a task worktree that was cleaned up after merging; reads then fall back to the project folder. */
  runProject(run: Run): Project { return this.ctx.runProject(run); }
  updateSettings(input: unknown): ControlSettings { return this.settings.update(input); }

  // Projects
  createProject(input: unknown): Project { return this.projects.create(input); }
  updateProject(projectId: string, input: unknown): Project { return this.projects.update(projectId, input); }
  deleteProject(projectId: string): void { this.projects.delete(projectId); }
  /** Stores the projects in the given order; projects missing from the list keep their relative order after it. */
  reorderProjects(input: unknown): Project[] { return this.projects.reorder(input); }
  repositoryBranches(input: unknown): ReturnType<ProjectManager['repositoryBranches']> { return this.projects.repositoryBranches(input); }
  setProjectLabels(projectId: string, input: unknown): Project { return this.projects.setLabels(projectId, input); }
  importGitHubLabels(projectId: string, input: unknown = {}): Promise<{ project: Project; added: string[]; updated: string[] }> { return this.projects.importGitHubLabels(projectId, input); }
  exportGitHubLabels(projectId: string): Promise<{ created: string[]; updated: string[] }> { return this.projects.exportGitHubLabels(projectId); }
  createMilestone(projectId: string, input: unknown): Project { return this.milestones.create(projectId, input); }
  updateMilestone(projectId: string, milestoneId: string, input: unknown): Project { return this.milestones.update(projectId, milestoneId, input); }
  deleteMilestone(projectId: string, milestoneId: string): Project { return this.milestones.delete(projectId, milestoneId); }
  setCurrentMilestone(projectId: string, input: unknown): Project { return this.milestones.setCurrent(projectId, input); }
  assignMilestone(projectId: string, input: unknown): { moved: number } { return this.milestones.assign(projectId, input); }
  /** Task images go to the project's `.aiws` folder; uploads without a project use the control data directory. */
  async uploadAttachment(input: unknown): Promise<{ id: string; url: string; path: string }> {
    const projectId = (input as { projectId?: unknown } | null)?.projectId;
    if (projectId !== undefined && projectId !== null && typeof projectId !== 'string') throw new ControlError('projectId must be text.');
    return this.attachments.upload(input, projectId ? this.project(projectId).repositoryPath : undefined);
  }
  /** Reads the models a provider offers now and keeps them for model pickers until the next refresh. */
  async refreshProviderModels(provider: string): Promise<ProviderModelCatalog> {
    if (!aiProviders.has(provider)) throw new ControlError('Unknown provider.', 404);
    const catalog = await this.providerModels.list(provider as DefaultProvider);
    this.store.state.providerModels = { ...this.store.state.providerModels, [provider]: catalog };
    this.ctx.changed(); return structuredClone(catalog);
  }
  /** Copies a discovered provider skill into the AIWS catalog with the regular import limits. */
  async importDiscoveredSkill(input: unknown): Promise<SkillDefinition> {
    const skill = await this.skillDiscovery.resolve(this.store.state.projects, jsonObject(input).id);
    const head = parseSkillFrontmatter(await readTextHead(join(skill.real, 'SKILL.md'), SKILL_LIMITS.fileBytes));
    return this.catalog.importSkill({ directory: skill.real, name: (head.name || skill.key).slice(0, 200), description: (head.description ?? '').slice(0, 20_000) });
  }

  // Tasks
  createTask(input: unknown, extra: Pick<Task, 'scheduleId' | 'scheduledFor'> = {}): Task { return this.tasks.create(input, extra); }
  updateTask(taskId: string, input: unknown): Task { return this.tasks.update(taskId, input); }
  saveTask(input: unknown, taskId?: string): Promise<Task> { return this.tasks.save(input, taskId); }
  deleteTask(taskId: string): void { this.tasks.delete(taskId); }
  /** Deletes the task together with its GitHub issue. */
  deleteTaskWithIssue(taskId: string): Promise<void> { return this.tasks.deleteWithIssue(taskId); }
  searchTasks(input: { projectId: string; q: string; excludeTaskId?: string; limit?: number; cursor?: string }): Promise<TaskSearchResult> { return this.tasks.search(input); }
  setTasksArchived(input: unknown): Task[] { return this.tasks.setArchived(input); }
  /** Reorders a project's ready queue; the given tasks take the queue slots they already occupy, in the given order. */
  reorderReadyTasks(input: unknown): Task[] { return this.tasks.reorderReady(input); }

  // Runs
  startTask(taskId: string): Run { return this.launcher.start(taskId); }
  /** Board start requests wait in Ready when global or project capacity is full. */
  async startTaskOrQueue(taskId: string, input: unknown = {}): Promise<Run | { queued: true; task: Task }> {
    try { return await this.startQueuedTask(taskId, input); }
    catch (error) {
      if (!(error instanceof ExecutionCapacityError)) throw error;
      this.updateTask(taskId, { status: 'ready' });
      const task = this.task(taskId); task.queueReason = error.message; this.ctx.changed();
      return { queued: true, task: structuredClone(task) };
    }
  }
  startQueuedTask(taskId: string, input: unknown = {}): Promise<Run> { return this.conversations.startQueuedTask(taskId, input); }
  restartTask(taskId: string): Run { return this.launcher.restart(taskId); }
  pause(runId: string): Promise<Run> { return this.controls.pause(runId); }
  resume(runId: string): Promise<Run> { return this.controls.resume(runId); }
  stop(runId: string): Promise<Run> { return this.controls.stop(runId); }
  command(runId: string, input: unknown): Run { return this.controls.command(runId, input); }
  /** Cuts the running provider turn so queued instructions continue the session right away. */
  deliverNow(runId: string): Run { return this.controls.deliverNow(runId); }
  /** Esc in the console: stops what the AI is doing without closing the run, which then waits for a message. */
  interrupt(runId: string): Run { return this.controls.interrupt(runId); }
  terminal(runId: string): ReturnType<RunControls['terminal']> { return this.controls.terminal(runId); }
  input(runId: string, input: unknown): void { this.controls.input(runId, input); }
  resize(runId: string, input: unknown): void { this.controls.resize(runId, input); }
  clearTerminal(runId: string): void { this.run(runId); this.controls.clear(runId); }
  complete(runId: string, input: unknown): Run { return this.completion.complete(runId, input); }
  reply(runId: string, input: unknown): Run { return this.reports.reply(runId, input); }
  /** An agent records the provider session it works in, so follow-ups and merge recovery resume it. */
  reportSession(runId: string, input: unknown): TaskSession { return this.reports.reportSession(runId, input); }
  dismissHandoff(taskId: string): Task { return this.reports.dismissHandoff(taskId); }
  /** `prompt` is only set internally from a parsed native dialog, never from request bodies. */
  ask(runId: string, input: unknown, prompt?: TerminalPrompt): Question { return this.questions.ask(runId, input, prompt); }
  answer(questionId: string, input: unknown): Question { return this.questions.answer(questionId, input); }
  /** A run's context window, or one of its subagents', read from the provider's session transcript. */
  async runContext(runId: string, agentId?: string): Promise<ContextWindowResult> {
    const run = this.run(runId);
    if (!aiProviders.isHistoryProvider(run.provider)) return { agents: [], agentId: '', snapshot: null, warnings: [] };
    const context = { run, events: this.store.state.events.filter((event) => event.runId === run.id) };
    const source = await this.agentGraph.source(this.runProject(run), context, agentId);
    const snapshot = source.pointer ? await this.contextWindows.read(source.pointer.path, aiProviders.require(source.node.provider)).catch(() => null) : null;
    return { agents: source.result.agentTree.agents, agentId: source.node.id, snapshot, warnings: source.result.warnings };
  }
  /**
   * Opens a file referenced in a run's context window with the operating system's default program. A finished task's worktree may be
   * gone, so its paths also resolve against the repository. A path outside the project (user memory, an earlier run's input image)
   * opens only when the transcript itself records it in this context window.
   */
  async openRunContextFile(runId: string, input: unknown): Promise<{ ok: true }> {
    const run = this.run(runId), value = jsonObject(input), path = value.path ?? value.file, action = value.action ?? 'open';
    const roots = [...new Set([this.runProject(run).repositoryPath, this.project(this.task(run.taskId).projectId).repositoryPath, ...(run.inputDirectory ? [run.inputDirectory] : [])])];
    const absolute = typeof path === 'string' && isAbsolute(path);
    const inRoots = absolute && run.workspacePath && isPathInside(run.workspacePath, path) ? relative(run.workspacePath, path) : path;
    let lastError: unknown;
    for (const root of roots) {
      try { return await openProjectPath(root, { path: inRoots, action }); } catch (error) { lastError = error; }
    }
    if (absolute) {
      const { snapshot } = await this.runContext(runId, typeof value.agent === 'string' && value.agent ? value.agent : undefined);
      if (snapshot?.blocks.some((block) => block.path === path)) return openAbsolutePath(path, action);
    }
    throw lastError instanceof Error ? lastError : new ControlError('Selected project path is unavailable.', 404);
  }

  // Conversations and provider sessions
  postMessage(taskId: string, input: unknown): TaskMessage { return this.conversations.postMessage(taskId, input); }
  sendTaskMessage(taskId: string, input: unknown, author: 'user' | 'system' = 'user'): Promise<TaskMessage | null> { return this.conversations.sendTaskMessage(taskId, input, author); }
  resumeTaskSession(taskId: string, input: unknown = {}): Promise<{ task: Task; run?: Run }> { return this.conversations.resumeTaskSession(taskId, input); }
  forkTask(taskId: string, input: unknown): Promise<Task> { return this.conversations.forkTask(taskId, input); }
  transferTaskSession(taskId: string, input: unknown): Promise<{ task: Task; run?: Run; warnings: string[] }> { return this.conversations.transferTaskSession(taskId, input); }
  handoffTask(taskId: string, input: unknown): Promise<{ task: Task; run: Run }> { return this.conversations.handoffTask(taskId, input); }
  importSessions(projectId: string): ReturnType<HistoryTaskImporter['import']> { return this.historyImporter.import(this.project(projectId)); }
  importSession(projectId: string, sourceId: string): ReturnType<HistoryTaskImporter['importSession']> { return this.historyImporter.importSession(this.project(projectId), sourceId); }
  taskHistoryContext(taskId: string): { project: Project; sourceId: string } { return this.sessions.taskHistoryContext(taskId); }
  liveSessionsPage(): ReturnType<ProviderSessions['liveSessionsPage']> { return this.sessions.liveSessionsPage(); }
  resumeSession(projectId: string, sourceId: string, input: unknown): Promise<{ task: Task; run?: Run }> { return this.sessions.resumeSession(projectId, sourceId, input); }
  /** Continues an agent terminal's conversation as a running task: the terminal closes and AIWS resumes the same provider session. */
  convertTerminalToTask(projectId: string, terminalId: string): Promise<{ task: Task; run?: Run }> { return this.sessions.convertTerminalToTask(projectId, terminalId); }
  openRunSessionTerminal(runId: string): Promise<ProjectTerminal> { return this.sessions.openRunSessionTerminal(runId); }

  // Planning assistant
  plan(projectId: string, input: unknown): Promise<{ reply: string; tasks: Task[] }> { return this.assistant.plan(projectId, input); }
  draft(projectId: string, input: unknown): ReturnType<AssistantRequests['draft']> { return this.assistant.draft(projectId, input); }
  /** Stops only the named draft request, so a late cancel never interrupts a newer planning turn. */
  cancelDraft(projectId: string, input: unknown): { cancelled: boolean } { return this.assistant.cancelDraft(projectId, input); }
  organize(projectId: string, input: unknown = {}): TaskOrganization { return this.assistant.organize(projectId, input); }
  cancelOrganize(projectId: string, input: unknown = {}): { cancelled: boolean } { return this.assistant.cancelOrganize(projectId, input); }

  // GitHub
  detectRepository(input: unknown): Promise<unknown> { return this.githubBridge.detectRepository(input); }
  connectProject(projectId: string, input: unknown): Promise<Project> { return this.githubBridge.connectProject(projectId, input); }
  githubAuth(): Promise<GitHubAuthStatus> { return this.githubBridge.authStatus(); }
  /** Open the GitHub CLI device login on this computer, requesting repository and Projects access. */
  authorizeGitHub(): Promise<{ launched: boolean; command: string; message: string }> { return this.githubBridge.authorize(); }
  sync(projectId: string): Promise<Project> { return this.githubBridge.sync(projectId); }
  /** Imports the repository issues the project has no task for; works without a GitHub Project connection. */
  downloadIssues(projectId: string): Promise<{ imported: number; repository: string }> { return this.githubBridge.downloadIssues(projectId); }

  // Git
  branches(projectId: string): ReturnType<RepositoryOperations['branches']> { return this.repository.branches(projectId); }
  gitOverview(projectId: string): Promise<GitOverview> { return this.repository.overview(projectId); }
  gitChanges(projectId: string, worktree?: string): Promise<GitChanges> { return this.repository.changes(projectId, worktree); }
  /** A task's changes against main; `changes` is null once its branch is gone. */
  taskChanges(taskId: string): Promise<{ changes: GitChanges | null }> { return this.repository.taskChanges(taskId); }
  /** One file of a changes list: its patch, or (with `open`) opened in the default program / revealed in the file manager. */
  changeFile(scope: { projectId: string; worktree?: string | undefined } | { taskId: string }, file: unknown, open?: unknown): Promise<{ path: string; diff: string; truncated: boolean } | { ok: true }> { return this.repository.changeFile(scope, file, open); }
  gitCommand(projectId: string, command: string, input: unknown): Promise<{ message: string }> { return this.repository.command(projectId, command, input); }
  /** Opens a managed task folder in the file manager. */
  openGitFolder(projectId: string, input: unknown): Promise<{ ok: true }> { return this.repository.openFolder(projectId, input); }
  /** Deletes managed task folders (one `path`, or every idle folder with `all`); branches are never touched and working tasks are skipped. */
  deleteGitFolders(projectId: string, input: unknown): Promise<{ removed: string[]; errors: Array<{ path: string; error: string }> }> { return this.repository.deleteFolders(projectId, input); }
  /** Deletes a worktree, a branch (with its worktree) or both, without merging. */
  deleteGitTarget(projectId: string, input: unknown): Promise<{ message: string; warnings: string[] }> { return this.repository.deleteWorktreeOrBranch(projectId, input); }
  /** "Merge into main and delete": task branches use the task merge with agent conflict recovery; other branches get a resolver task on conflict. */
  mergeRepositoryBranch(projectId: string, input: unknown): Promise<GitMergeResult> { return this.repository.mergeBranch(projectId, input); }

  async close(): Promise<void> {
    const ctx = this.ctx;
    ctx.closing = true; clearInterval(this.timer); this.broadcaster.close();
    await this.projectTerminals.close();
    this.assistant.close(); this.completion.close();
    for (const run of this.store.state.runs.filter((item) => !runEnded(item))) this.completion.finish(run, 'interrupted', 130, 'Control service stopped. Start a new run to continue.');
    await Promise.allSettled([...ctx.handles.values()].map((handle) => handle.stop()));
    // Let background Git work finish so no child process keeps the repositories busy.
    await ctx.settle(15_000);
    this.store.close(); this.removeAllListeners();
  }
  private view(includeJournal = true): ControlState {
    return stateView(this.store.state, { handles: this.ctx.handles, planningAgents: this.assistant.planningAgents, organizations: this.assistant.organizations, draining: () => this.hasDrainingWork() }, includeJournal);
  }
  private hasDrainingWork(): boolean {
    const state = this.store.state;
    return state.tasks.some((task) => task.status === 'completing') || this.assistant.busy() || this.ctx.handles.size > 0 || state.runs.some((run) => !runEnded(run)) || this.settings.workflowDraining();
  }
  private tick(): void {
    if (this.ctx.closing) return;
    const current = Date.now();
    this.schedules.tick(current);
    this.usageTriggers.tick(current);
    this.reports.tick(current);
    this.readyQueue.tick(current);
    this.connectionWatch.tick(current);
    this.delivery.tick();
    this.githubBridge.tick(current);
  }
}
