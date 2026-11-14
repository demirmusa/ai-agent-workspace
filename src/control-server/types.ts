import type { HistoryTaskSource } from './history-import.js';
import type { AIProviderInfo } from './ai-providers/types.js';
import type { UsageKey } from './ai-providers/usage.js';
export type TaskStatus = 'backlog' | 'ready' | 'running' | 'waiting' | 'paused' | 'review' | 'completing' | 'done' | 'failed' | 'cancelled';
export type Provider = 'codex' | 'claude' | 'opencode' | 'agy' | 'copilot' | 'command';
export type DefaultProvider = Exclude<Provider, 'command'>;
export type ProviderArgs = Record<Exclude<Provider, 'command'>, string[]>;
export type RunStatus = 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
export type TerminalMode = 'stream' | 'pty';
export const TASK_PRIORITY = { high: 3, medium: 2, low: 1 } as const;
export interface TaskSearchItem { id: string | null; reference: string; code: string; title: string; status: TaskStatus; projectId: string; issueNumber?: number; issueUrl?: string; remote: boolean }
export interface TaskSearchResult { items: TaskSearchItem[]; nextCursor: string | null }
export type HistoryProvider = 'codex' | 'claude';
export type AgentExecutionStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'interrupted' | 'stopped' | 'pending' | 'unknown';
export interface AgentExecutionNode { id: string; parentId: string | null; provider: DefaultProvider; sessionId?: string; toolUseId?: string; name: string; role?: string; status: AgentExecutionStatus; startedAt?: string; updatedAt?: string; finishedAt?: string; sourceId?: string; transcriptAvailable: boolean; readOnly: true; aliases?: string[]; parentKnown?: boolean; model?: string; activity?: AgentActivity; kind?: 'workflow'; phase?: string; description?: string; phases?: Array<{ title: string; detail?: string }> }
/** The latest tool call an agent made, with its arguments trimmed to the strings a one-line summary needs. */
export interface AgentActivity { tool: string; input: Record<string, unknown>; at?: string }
export interface AgentExecutionTree { rootId: string; agents: AgentExecutionNode[] }
export interface AgentGraphResult { agentTree: AgentExecutionTree; warnings: string[]; sourceAvailable: boolean }
/** What a piece of an agent's context window holds; the interface names and colours each kind. */
export type ContextKind = 'system' | 'tools' | 'memory' | 'chat' | 'reasoning' | 'file' | 'search' | 'shell' | 'tool' | 'agent' | 'summary';
/** Content of one kind and source in a context window; `label` is a file or tool name, absent for the kind's own name. `merged` gathers the kind's smaller sources. */
export interface ContextBlock { id: string; kind: ContextKind; label?: string; path?: string; tokens: number; count: number; merged?: boolean }
/**
 * An agent's context window read from its session transcript. `used` is what the provider last reported (when `measured`)
 * plus content added since; block sizes are estimated from text length and scaled to that report.
 */
export interface ContextWindowSnapshot { provider: HistoryProvider; model?: string; window: number | null; used: number; measured: boolean; blocks: ContextBlock[]; compactions: number; updatedAt?: string }
export interface ContextWindowResult { agents: AgentExecutionNode[]; agentId: string; snapshot: ContextWindowSnapshot | null; warnings: string[] }
export interface AgentTranscript { runs: Run[]; events: ControlEvent[]; messages: TaskMessage[]; questions: Question[]; nextCursor: string | null; truncated: boolean; warnings: string[] }
export interface HistoricalSession { id: string; provider: HistoryProvider; sessionId: string; title: string; firstUserMessage?: string; status?: AgentExecutionStatus; cwd: string; createdAt: string; updatedAt: string; canResume: boolean; /** Provider subagent sessions this root session spawned, listed on demand from its agent tree. */ subagentCount?: number }
export type SessionActivity = 'working' | 'idle' | 'unknown';
export interface LiveSession extends HistoricalSession { projectId: string | null; projectName: string; processId: number; active: true; activity: SessionActivity; external: true; readOnly: true }
export interface LiveSessionPage { items: LiveSession[]; managedTitles: Record<string, string>; warnings: string[] }
export type SessionHistorySort = 'recent' | 'oldest' | 'created';
export interface SessionHistoryPage { items: HistoricalSession[]; nextCursor: string | null; total: number; counts: Record<HistoryProvider, number>; warnings: string[] }
export interface SessionHistoryDetail { session: HistoricalSession; events: ControlEvent[]; messages: TaskMessage[]; nextCursor: string | null; truncated: boolean; warnings: string[] }
export interface HistoryResume { sourceId: string; sessionId: string; provider: DefaultProvider; initialMessage: string;
  /** The session ID was recorded from the agent or its provider; no readable history file backs it. */
  recorded?: boolean }
/** A provider session that worked on a task; the latest one is resumed for follow-up work. */
export interface TaskSession { runId: string; provider: DefaultProvider; sessionId: string; agentId: string | null; agentName: string; model?: string; source: 'agent' | 'provider' | 'assigned'; recordedAt: string }
export interface WorkflowStep { id: string; name: string; agentId: string; instructions: string; condition: 'always' | 'deploy_requested' }
export interface WorkflowDefinition { id: string; name: string; description: string; projectId: string | null; enabled: boolean; trigger: 'always' | 'requested'; steps: WorkflowStep[]; revision: number; createdAt: string; updatedAt: string }
export interface TaskMessage { id: string; taskId: string; runId: string | null; agentId: string | null; authorType: 'user' | 'agent' | 'system'; authorName: string; text: string; createdAt: string }
export interface PlannerMessage { id: string; projectId: string; role: 'user' | 'assistant' | 'system'; text: string; createdAt: string; taskIds?: string[] }
export interface SkillFile { path: string; content: string; encoding?: 'utf8' | 'base64'; executable?: boolean }
export interface SkillDefinition {
  id: string; name: string; description: string; content: string; files: SkillFile[];
  revision: number; createdAt: string; updatedAt: string;
}
export interface AgentTemplateSource { templateId: string; url: string; repository: string; revision: string; license: string }
export interface AgentTemplate {
  id: string; name: string; description: string; provider: Provider; category: string;
  source: { title: string; url: string; repository: string; revision: string }; license: string;
  instructions: string; context: string; capabilities: string[]; skillIds: string[]; sourceSha256: string;
}
export interface AgentTemplateCatalog { schemaVersion: 1; notice: string; officialReference: string; items: AgentTemplate[] }
export interface AgentDefinition {
  id: string; name: string; description: string; provider: Provider; model?: string; reasoningEffort?: string;
  command?: { executable: string; args: string[] };
  instructions: string; context: string; skillIds: string[]; enabled: boolean;
  capabilities?: string[]; terminalMode?: TerminalMode;
  templateSource?: AgentTemplateSource;
  revision: number; createdAt: string; updatedAt: string;
}
export interface ExecutionSnapshot {
  agent: AgentDefinition | null; skills: SkillDefinition[]; provider: Provider; model?: string; reasoningEffort?: string;
  /** Provider account the run uses; absent for the default login. */
  account?: string;
  command?: { executable: string; args: string[] }; instructions: string; context: string;
  task: { title: string; description: string }; createdAt: string;
  terminalMode?: TerminalMode; directory?: Array<Pick<AgentDefinition, 'id' | 'name' | 'provider' | 'description' | 'capabilities'>>;
}
export interface GitHubConnection {
  repository: string;
  owner: string;
  number: number;
  ownerType?: 'user' | 'organization';
  statusField?: string;
  statuses?: Partial<Record<TaskStatus, string>>;
}
/** A project label; the fields and limits match GitHub issue labels so they round-trip unchanged. */
export interface ProjectLabel { name: string; color: string; description: string }
export type MilestoneState = 'open' | 'closed';
/** The fields a project milestone shares with a GitHub milestone. `dueOn` is a calendar date (YYYY-MM-DD) or null. */
export interface MilestoneFields { title: string; description: string; dueOn: string | null; state: MilestoneState }
/**
 * A project milestone, as on GitHub: a titled, optionally dated goal that groups tasks and can be closed.
 * `github` links it to the repository milestone; `baseline` holds the values both sides agreed on at the last sync.
 */
export interface ProjectMilestone extends MilestoneFields {
  id: string; createdAt: string; updatedAt: string; closedAt?: string;
  github?: { number: number; url?: string; baseline: MilestoneFields };
}
/** A script of the project that can be started from the header's Run button. `path` is relative to the repository, with forward slashes. With `npmScript`, `path` is a package.json and the script is `npm run <npmScript>`. */
/** A project run script: a script file or npm script inside the repository (`path`), or a custom shell `command` run in the project folder. */
export interface RunScript { id: string; name: string; path?: string; npmScript?: string; command?: string; args?: string; askArgs?: boolean }
/** The provider-owned subset of global settings that projects may override. */
export type ProviderSettings = Partial<Omit<Pick<ControlSettings, 'defaultProvider' | 'providerArgs' | 'disabledProviders' | 'defaultModels' | 'disabledModels' | 'autoModeProviders' | 'customProviders' | 'modelAutoMerge'>, 'providerArgs'>> & { providerArgs?: Partial<ProviderArgs> };
export type TaskMergeMode = 'branch' | 'pull-request';
export const DEFAULT_TASK_MERGE_MODE: TaskMergeMode = 'pull-request';
export interface Project {
  taskMergeMode?: TaskMergeMode | null;
  providerSettings?: ProviderSettings | undefined;
  id: string; name: string; description: string; repositoryPath: string;
  github: GitHubConnection | null; createdAt: string; updatedAt: string;
  autoMerge?: boolean; defaultBranch?: string;
  /** Instructions prepended to the prompt of every task run in this project. */
  systemPrompt?: string;
  useWorktree?: boolean; mainBranch?: string;
  /** Most agents this project may run at once; absent means only the global limit applies. */
  maxConcurrent?: number;
  /** Labels tasks of this project can carry; task `tags` hold their names. */
  labels?: ProjectLabel[];
  /** Milestones tasks of this project can belong to; task `milestoneId` holds the id. */
  milestones?: ProjectMilestone[];
  /** The open milestone new tasks join unless they name another; null means the user chose none. */
  currentMilestoneId?: string | null;
  /** Numbers of linked GitHub milestones deleted here; the next sync deletes them on GitHub. */
  milestoneDeletions?: number[];
  runScripts?: RunScript[];
  /** How a task continues with another agent when its agent runs out of tokens; absent means 'fresh'. */
  agentHandoffMode?: AgentHandoffMode;
  /** The built-in general workspace: a plain folder of the control service, not tied to a repository or Git. */
  general?: true;
}
/** Starts automatically from a schedule; ready tasks with a future `scheduledAt` wait until then. */
export type ScheduleRecurrence =
  | { kind: 'once'; at: string }
  | { kind: 'interval'; every: number; unit: 'minutes' | 'hours' | 'days' | 'weeks' }
  /** Every day, or only the listed weekdays (0 = Sunday … 6 = Saturday), at each HH:MM time. */
  | { kind: 'daily'; times: string[]; weekdays: number[] }
  /** The listed days of the month (1 … 31, -1 = last day) at each HH:MM time. */
  | { kind: 'monthly'; times: string[]; days: number[] }
  /** Five-field cron expression: minute hour day-of-month month day-of-week. */
  | { kind: 'cron'; expression: string };
/** The task a schedule creates at each occurrence. */
export interface ScheduleTaskTemplate {
  title: string; description: string; agentId: string | null; provider?: Provider; model?: string; reasoningEffort?: string;
  command?: { executable: string; args: string[] };
  skillIds: string[]; tags: string[]; priority: number; terminalMode?: TerminalMode; preferNativeTerminal?: boolean;
  workflowId: string | null; autoMerge: boolean | null; baseBranch?: string;
}
export interface ScheduleOutcome { at: string; status: 'created' | 'skipped' | 'failed'; message: string; taskId?: string; occurrence?: string }
export interface TaskSchedule {
  id: string; projectId: string; name: string; description: string; enabled: boolean;
  recurrence: ScheduleRecurrence;
  /** IANA time zone the wall-clock times are read in. */
  timezone: string;
  /** No occurrence before this time; interval schedules count from it. */
  startAt: string; endAt: string | null; maxRuns: number | null;
  /** What happens when an occurrence arrives while the previous task of this schedule is still open. */
  overlap: 'skip' | 'allow';
  /** Occurrences missed while the service was closed or stopped: run once as soon as possible, or skip them. */
  catchUp: 'once' | 'skip';
  task: ScheduleTaskTemplate;
  nextRunAt: string | null; lastRunAt: string | null; lastTaskId: string | null; runCount: number;
  lastOutcome?: ScheduleOutcome;
  revision: number; createdAt: string; updatedAt: string;
}
/** 'transcript' copies the whole previous conversation into the new agent; 'fresh' starts a clean agent that inspects the Git changes. */
export type AgentHandoffMode = 'fresh' | 'transcript' | 'summary';
/** An agent of the task hit its provider's usage limit; AIWS waits until `resumeAt` (`resetsAt` + 1 minute) to continue or lets the user hand off earlier. */
export interface HandoffRequest { runId: string; provider: Provider; agentName: string; reason: string; detectedAt: string; resetsAt?: string; resumeAt?: string }
export interface Task {
  id: string; projectId: string; title: string; description: string; status: TaskStatus;
  archivedAt?: string;
  /** Set only after main verification and all task branch/worktree cleanup succeeds. */
  deliveryVerifiedAt?: string;
  /** Manual position in the project's ready queue; lower runs first. Cleared once the task leaves ready. */
  queueOrder?: number;
  priority: number; provider: Provider; model?: string;
  baseBranch?: string; taskBranch?: string;
  command?: { executable: string; args: string[] };
  agentId?: string | null; skillIds?: string[]; providerOverride?: Provider; modelOverride?: string;
  /** Reasoning level chosen for the task; one of the effective provider's reasoning levels. */
  reasoningEffort?: string;
  /** Provider account the task runs as (see ProviderAccounts); absent runs with the default login. */
  account?: string;
  /** Project-relative paths dropped onto the task card; the agent receives them as context. */
  attachedFiles?: string[];
  terminalMode?: TerminalMode; tags?: string[];
  /** The project milestone the task belongs to. */
  milestoneId?: string;
  autoMerge?: boolean | null; workflowId?: string | null; workflowRequested?: boolean; requestedActions?: string[];
  workflowProgress?: { definition: WorkflowDefinition; stepIndex: number; status: 'running' | 'completed' | 'failed' };
  pullRequest?: { number: number; url?: string; headSha?: string; merged?: boolean; mergeRequested?: boolean; mergeStatus?: string };
  worktree?: { path: string; branch: string; mainBranch: string; repositoryPath: string; gitDirectory?: string; gitCommonDirectory?: string; mergedSha?: string; mergeError?: string; mergeRequested?: boolean; cleanedAt?: string; cleanupError?: string; cleanupWarning?: string;
    /** A plain branch this task integrates into main; it is deleted once the task's merge lands. */
    sourceBranch?: string };
  queueReason?: string;
  /** A cancelled task returned to ready: its next run starts over from the latest base branch, not from earlier sessions. */
  freshStart?: boolean;
  queuedContinuation?: { instruction: string; confirmationRequired: boolean; mergeRecovery?: boolean;
    /** When the continuation was queued; continuations take free slots first-in, first-out. */
    queuedAt?: string;
    /** It waits only for a free execution slot, so it holds the next one ahead of other ready tasks. */
    awaitingSlot?: boolean;
    allowHistoryFallback?: boolean;
    /** Reopens the session without a new turn. */
    openSession?: boolean };
  externalDependency?: boolean;
  preferNativeTerminal?: boolean;
  historyResume?: HistoryResume;
  handoffRequest?: HandoffRequest;
  /** Provider sessions that worked on this task, oldest first. */
  sessions?: TaskSession[];
  /** Created by continuing a provider session from its history; kept off the board. */
  sessionContinuation?: boolean;
  historyTransfer?: { sourceTaskId: string; transcript: string; warnings: string[] };
  conversationContext?: string;
  forkedFromTaskId?: string;
  externalHistory?: HistoryTaskSource;
  dependsOn: string[]; autoStart: boolean; currentRunId: string | null;
  /** A ready task does not start before this time; past times start at once (also after a restart). */
  scheduledAt?: string;
  /** A ready task waits until shortly before reset, or for the saved renewal when mode is reset. */
  usageTrigger?: { provider: DefaultProvider; window: string; windowMinutes: number; withinMinutes: number; mode?: 'reset'; resetsAt?: string };
  /** Data plugins keep on the task, one JSON object per plugin id (see control-server/plugins.ts). */
  pluginData?: Record<string, Record<string, unknown>>;
  /** The schedule that created this task, and the occurrence it was created for. */
  scheduleId?: string; scheduledFor?: string;
  /** Requests from GitHub comments waiting for the task's first run. */
  githubInstructions?: string[];
  github?: {
    issueNumber: number; issueUrl?: string; url?: string; issueId?: string; itemId?: string;
    updatedAt?: string; lastSyncedAt?: string; syncedTitle?: string; syncedDescription?: string;
    syncedStatus?: TaskStatus; baseline?: { title: string; description: string; status: TaskStatus; labels?: string[]; milestone?: number | null };
  };
  createdAt: string; updatedAt: string;
}
export interface RunExecutionInfo { model?: string; reasoningEffort?: string; modelSource?: 'configured' | 'reported'; branch?: string; detached?: boolean; worktreePath?: string; cwd?: string }
/** Token counts of one provider run; cache tokens are counted separately where the provider reports them. */
export interface TokenCounts { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; totalTokens: number }
/** Tokens and cost recorded when a run ends. The cost is only what the provider's client reported (null when it reports none); it is never estimated. */
export interface RunUsage extends TokenCounts { costUsd: number | null; recordedAt: string }
export interface Run {
  executionInfo?: RunExecutionInfo;
  id: string; taskId: string; status: RunStatus; provider: Provider;
  startedAt: string; finishedAt: string | null; exitCode: number | null;
  workspacePath?: string;
  executionMode: 'native' | 'docker'; sessionId?: string; pid?: number;
  pendingCommands: string[]; continuation: number;
  historyResume?: HistoryResume;
  executionSnapshot?: ExecutionSnapshot; skillsDirectory?: string;
  terminalMode?: TerminalMode; inputDirectory?: string; cols?: number; rows?: number;
  /** In-memory replay (persisted as terminal chunks in control.db, never in state broadcasts). */
  terminalOutput?: string;
  /** Characters ever written to this terminal; live chunks carry their offset in this stream. */
  terminalLength?: number;
  /** PTY size changes by stream offset, so a finished run's replay redraws each frame at the size it was drawn for. */
  terminalResizes?: { offset: number; cols: number; rows: number }[];
  activeMs?: number; lastResumedAt?: string; lastActivityAt?: string; stageIndex?: number; workflowId?: string;
  /** Final answer an agent left with `aiws control reply`; posted to the linked GitHub issue when the run ends. */
  reply?: string;
  /** Tokens and reported cost of this run, recorded when it finished. */
  usage?: RunUsage;
  /** The pull request this run's work was delivered through; `Task.pullRequest` only holds the latest one. */
  pullRequest?: { number: number; url?: string };
  /** This run continues the task after another agent's run was handed off. */
  handoff?: { fromRunId: string; fromProvider: Provider; fromAgentName: string; mode: AgentHandoffMode; reason?: string; summaryModel?: string };
}
/** A native CLI dialog read from the terminal screen: what it asks, about which command, and its choices. */
export interface TerminalPrompt {
  title?: string; question: string; context: string[]; command?: string;
  options: Array<{ label: string; selected: boolean }>;
}
export interface Question {
  kind?: 'question' | 'approval'; source?: 'agent' | 'terminal';
  id: string; runId: string; taskId: string; text: string; answer: string | null;
  status: 'pending' | 'answered' | 'cancelled'; createdAt: string; answeredAt: string | null;
  prompt?: TerminalPrompt;
}
export interface ControlEvent {
  id: string; runId: string | null; taskId: string | null; type: string;
  message: string; data?: unknown; createdAt: string;
}
export interface ControlSettings {
  taskMergeMode?: TaskMergeMode;
  modelAutoMerge?: Partial<Record<DefaultProvider, Record<string, boolean>>> | undefined;
  systemEnabled: boolean;
  defaultProvider: DefaultProvider;
  maxConcurrent: number; executionMode: 'native' | 'docker'; dockerImage: string; autoSyncSeconds: number;
  providerArgs: ProviderArgs;
  /** Built-in providers turned off in work settings: never the default, never chosen for new tasks or automatic agent selection. */
  disabledProviders: DefaultProvider[];
  /** Model each built-in provider uses when a task names none. */
  defaultModels: Partial<Record<DefaultProvider, string>>;
  /** Models hidden from task and agent pickers, per built-in provider. */
  disabledModels: Partial<Record<DefaultProvider, string[]>>;
  /** Built-in providers launched in their no-approval auto mode (codex --yolo, claude --permission-mode auto, …). */
  autoModeProviders: DefaultProvider[];
  /** User-defined command presets, launched like the `command` provider (prompt on stdin). */
  customProviders: CustomProvider[];
  /** Word that addresses the agent in GitHub issue comments and new issue bodies. */
  githubTrigger: string;
  /** Prompt added to every task run, ahead of the project system prompt. */
  systemPrompt: string;
  /** Provider whose speech-to-text dictation uses in every text field. */
  voiceProvider: DefaultProvider;
  /** Footer usage pills: quota rows pinned per provider (row keys) and providers hidden from the footer. */
  usageFooter?: UsageFooterSettings;
}
/** Footer usage choices per usage card: a provider, or one of its accounts as `<provider>@<account id>`. */
export interface UsageFooterSettings { pins: Partial<Record<UsageKey, string[]>>; hidden: UsageKey[] }
export interface CustomProvider { id: string; name: string; executable: string; args: string[]; enabled: boolean }
export interface GitHubWatch { connectedAt: string; issuesSince: string; commentsSince: string; seenComments: number[] }
/**
 * A user terminal of a project: a login shell, an agent CLI's own interactive TUI (optionally as one of the provider's accounts),
 * one of the project's run scripts, or the provider CLI signing a new account in. An agent terminal may reopen an existing session (resumeSessionId) in that session's workspace.
 * Terminals are stored with the state, so a restarted service opens them again where the user left them.
 */
export interface ProjectTerminal extends Run { projectId: string; terminalKind: 'shell' | 'agent' | 'script' | 'login'; title: string; scriptId?: string; scriptArgs?: string; account?: string; resumeSessionId?: string }
export interface ControlState {
  resolvedProviderSettings?: Record<string, ControlSettings>;
  systemStatus?: 'running' | 'draining' | 'stopped';
  schemaVersion: 1; projects: Project[]; tasks: Task[]; runs: Run[];
  questions: Question[]; events: ControlEvent[]; settings: ControlSettings;
  /** Open and exited project terminals; their replays are terminal chunks like a run's. */
  terminals: ProjectTerminal[];
  ignoredGitHubIssues?: Record<string, number[]>;
  githubWatch?: Record<string, GitHubWatch>;
  agents: AgentDefinition[]; skills: SkillDefinition[];
  workflows: WorkflowDefinition[]; messages: TaskMessage[]; plannerMessages: PlannerMessage[];
  /** Scheduled and recurring task definitions of projects and the general workspace. */
  schedules: TaskSchedule[];
  /** The general workspace; kept apart from `projects` because it is no user project. */
  generalWorkspace?: Project;
  agentAvailability?: Record<string, { available: boolean; runId: string | null; status: string }>;
  /** Models last read from each provider, refreshed on request from the settings page. */
  providerModels?: Partial<Record<DefaultProvider, ProviderModelCatalog>>;
  /** Registered AI providers as the interface lists them; computed, never persisted. */
  aiProviders?: AIProviderInfo[];
  /** Latest AI task-queue organization per project; in memory only, never persisted. */
  organizations?: Record<string, TaskOrganization>;
}
/** Relative 1–5 tiers of a model family: higher speed answers sooner, higher quality takes on harder work, higher cost spends more. */
export interface ModelProfile { speed: number; quality: number; cost: number }
/** A model a provider offers; `profile` is present when the provider knows the model's family. */
/** One selectable model; `efforts` lists the reasoning levels it accepts when the provider reports them (absent: the provider's levels, empty: none). */
export interface ProviderModel { id: string; name?: string; profile?: ModelProfile; efforts?: string[] }
export interface ProviderModelCatalog { models: ProviderModel[]; refreshedAt: string; source: string }
export interface TaskOrganization {
  requestId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; provider: Provider;
  startedAt: string; finishedAt?: string; report?: string; error?: string;
}
export type ControlProject = Project;
export type ControlTask = Task;
export class ControlError extends Error {
  constructor(message: string, public statusCode = 400) { super(message); this.name = 'ControlError'; }
}
