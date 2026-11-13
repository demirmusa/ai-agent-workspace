import type { DefaultProvider, ModelProfile, Project, ProviderModel, Run, Task } from '../types.js';
import type { UsageReading } from '../run-usage.js';
import type { ContextReading } from '../context-window.js';
import type { ProviderUsage, UsageContext, UsageWindow } from './usage.js';
import type { VoiceSource } from './voice.js';

export interface ProviderInvocation { executable: string; args: string[]; input: string }

/** Everything a provider needs to build the command line of one run. */
export interface LaunchContext {
  project: Project; run: Run;
  /** The task with the run's execution snapshot applied. */
  task: Task;
  prompt: string;
  /** Short instruction for interactive terminals that points the agent at prompt.md. */
  nativePrompt: string;
  readOnly: boolean;
}

/** Options a provider CLI accepts from work settings, and which of them change its permissions. */
export interface ProviderArgumentPolicy {
  /** Options that take a separate value. */
  values: ReadonlySet<string>;
  /** Options the application manages itself; users cannot set them. */
  reserved: ReadonlySet<string>;
  /** Options dropped for read-only planning. */
  permission: ReadonlySet<string>;
}

export interface ParsedArgument { flag: string; parts: string[]; value?: string }

/** What one JSON line of a provider's stream output says beyond the shared formats. */
export interface StreamEventInfo { model?: unknown; sessionId?: string; failed?: boolean; errorDetail?: string; text?: string }

export interface ModelContext {
  home: string; env: NodeJS.ProcessEnv; request: typeof fetch;
  /** Runs the provider CLI found on PATH and returns its standard output. */
  run(executable: string, args: string[]): Promise<string>;
}
export interface ModelListing { models: ProviderModel[]; source: string }

/** One signed-in account of a provider that can run several accounts side by side. */
export interface ProviderAccount {
  /** Stable reference stored on tasks (the account manager's slot number). */
  id: string; email: string; label: string; alias?: string; organization?: string;
  /** The account the provider's default login uses; it runs without a separate profile. */
  active: boolean; disabled: boolean;
  /** The account manager's usage state: ok, token_expired, relogin_required, unavailable… */
  status: string;
  short: UsageWindow; weekly: UsageWindow; updatedAt: string | null; loginExpiresAt?: string;
}
export interface ProviderAccountsStatus {
  /** The external account manager the provider drives. */
  tool: { name: string; command: string; url: string; installed: boolean; path?: string; installer: string | null };
  accounts: ProviderAccount[]; checkedAt: string; error?: string;
}
/** A terminal that signs a new account in; `ready` reports the login finished, `finish` registers it and cleans up. */
export interface ProviderAccountLogin {
  executable: string; args: string[]; env: Record<string, string>;
  /** Shown in the terminal before the CLI starts. */
  intro: string;
  ready(): Promise<boolean>;
  finish(): Promise<{ added: boolean; message: string }>;
}
/** Several accounts of one provider, kept by an external account manager that AIWS installs and drives. */
export interface ProviderAccounts {
  /** Environment variables that would override the chosen account; they are removed from account launches. */
  readonly overrideEnv: readonly string[];
  /** The accounts, listed again when the last listing is older than `maxAgeMs`; with `background` an older listing is returned while the new one loads. */
  status(maxAgeMs?: number, background?: boolean): Promise<ProviderAccountsStatus>;
  install(): Promise<ProviderAccountsStatus>;
  /** Adds the account the provider's default login uses. */
  addCurrent(): Promise<ProviderAccountsStatus>;
  remove(id: string): Promise<ProviderAccountsStatus>;
  login(): Promise<ProviderAccountLogin>;
  /** Environment that makes the provider CLI run as the account; empty for the default login's account. */
  launchEnv(id: string): Promise<Record<string, string>>;
}

/** What the interface needs to show and choose a provider; sent to the browser as is. */
export interface AIProviderInfo {
  id: DefaultProvider; name: string; icon: string | null; executable: string;
  /** Arguments that resume a session in the provider's own CLI; `{sessionId}` stands for the session ID. */
  resumeArgs: string[];
  reasoningEfforts: string[]; reasoningFlag: string | null; reasoningInModelId: boolean;
  /** Suggested models, each with the profile the provider knows for it. */
  fallbackModels: ProviderModel[];
  autoModeLabel: string; nativeTerminal: boolean; usage: boolean; history: boolean; voice: boolean;
  /** Its run conversations can be read back from its own session storage (history providers, or readSessionConversation). */
  transcript: boolean;
  /** Runs several accounts side by side (see ProviderAccounts). */
  accounts: boolean;
}

/**
 * One built-in AI coding agent. Every place that lists, launches, detects or measures a provider reads it
 * from AIProvidersService, so a new provider is a new implementation registered there.
 */
export interface IAIProvider {
  readonly id: DefaultProvider;
  readonly name: string;
  /** Icon served by the control UI, or null for a text badge. */
  readonly icon: string | null;
  /** Command looked up on PATH. */
  readonly executable: string;
  /** Reasoning levels the CLI accepts, lowest first. */
  readonly reasoningEfforts: readonly string[];
  /** The CLI option that selects the reasoning level, when it has one. */
  readonly reasoningFlag: string | null;
  /** The reasoning level is the last part of each model ID ("gemini-4-argon-high"), so choosing a level chooses a model. */
  readonly reasoningInModelId: boolean;
  /** Suggested model IDs until the provider's own list is refreshed. */
  readonly fallbackModels: readonly string[];
  /** API keys passed through to Docker workers. */
  readonly credentialEnv: readonly string[];
  /** Environment variable that relocates the provider's home folder. */
  readonly homeEnv: string | null;
  readonly args: ProviderArgumentPolicy;
  /** Options added in auto mode, and options whose presence means the user already chose a permission mode. */
  readonly autoMode: { args: readonly string[]; overrides: readonly string[]; label: string };
  /** Has an interactive TUI that can run a task in a real terminal. */
  readonly nativeTerminal: boolean;
  /** Its local session history can be browsed, imported and resumed (see HistoryProvider). */
  readonly history: boolean;
  /** Not a history provider, but readSessionConversation can read a run's conversation from its own session storage. */
  readonly sessionConversation: boolean;
  /** A fresh run gets its session ID up front, so follow-up work can resume it. */
  readonly assignsSessionId: boolean;
  /** Session IDs accepted when resuming from history. */
  readonly sessionIdPattern: RegExp;
  /** The provider's own speech-to-text for dictation, or null when it has none. */
  readonly voice: VoiceSource | null;
  /** Host of the provider's API, probed to tell a network outage from a provider failure; null probes a general host. */
  readonly apiHost: string | null;
  /** How a running CLI process of this provider is recognized by process name or command line; null when it is not. */
  readonly nativeProcess: { name: RegExp; command: RegExp } | null;
  /** Several accounts that runs and terminals can choose from, or null when the provider has one login. */
  readonly accounts: ProviderAccounts | null;

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string;
  /** Sessions in the provider's local history, or null when counting them is not cheap. */
  countSessions(home: string): Promise<number | null>;
  getModels(context: ModelContext): Promise<ModelListing>;
  /** Relative speed, quality and cost of a model family the provider lists, by model ID; null for models it does not know. */
  modelProfile(id: string): ModelProfile | null;
  /** Remaining quota with one short and one long window, or null when the provider reports none. */
  getRemainingTokens(context: UsageContext): Promise<ProviderUsage | null>;
  /** Remaining quota with every bucket the provider reports, for the usage popup. */
  getRemainingTokensAllDetailed(context: UsageContext): Promise<ProviderUsage | null>;

  /** Bounded, non-interactive run (stream output). */
  headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation;
  /** Task run in the CLI's interactive TUI. */
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation;
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation;
  /** Adjusts a fresh run, e.g. to give it its session ID. */
  prepareSession(invocation: ProviderInvocation, context: LaunchContext): ProviderInvocation;
  /** Places the user's work-setting options into the generated command line. */
  mergeArgs(args: string[], extraArgs: string[], context: LaunchContext): string[];
  /** Reads the provider-specific parts of one stream-output JSON line. */
  readStreamEvent(message: Record<string, unknown>): StreamEventInfo;
  /** Tokens (and the cost, if the client prints one) one stream-output JSON line reports; each reading is added to the run. */
  readStreamUsage(message: Record<string, unknown>): UsageReading | undefined;
  /** Tokens one JSON line of the provider's own session transcript reports; used when the run had no stream output (native terminal). */
  readTranscriptUsage(message: Record<string, unknown>): UsageReading | undefined;
  /** The USD cost the client itself recorded for a session (what its own cost/usage command shows); undefined when it records none. AIWS never prices tokens itself. */
  readSessionCost(sessionId: string): Promise<number | undefined>;
  /** Readable conversation transcript from the provider's own session storage when it is not managed by SessionHistory. */
  readSessionTranscript(run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, home?: string): Promise<string | undefined>;
  /** A run's conversation as provider-neutral entries, from the provider's own session storage (see sessionConversation). */
  readSessionConversation(run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, home?: string): Promise<SessionConversation | undefined>;
  /** What one JSON line of the provider's own session transcript puts into the model's context window (see context-window.ts). */
  readTranscriptContext(message: Record<string, unknown>): ContextReading | undefined;
  /** Context window of a model, for transcripts that do not report one; null when unknown. */
  contextWindow(model: string | undefined, used: number): number | null;
  /** Environment of a task run. */
  runEnv(readOnly: boolean): Record<string, string>;
  /** Environment of the provider's own terminal tab. */
  terminalEnv(autoMode: boolean): Record<string, string>;
  /** Options that give the provider's own terminal tab a known session ID, so it can later continue as a task; empty when the CLI cannot be told one. */
  terminalSessionArgs(sessionId: string): string[];
  /** Options that reopen an existing session in the provider's own terminal tab, so the user can talk to it directly. */
  terminalResumeArgs(sessionId: string): string[];

  /** Rejects option values the application must control. */
  checkArgument(argument: ParsedArgument): void;
  /** True when the option changes permissions and must be dropped for read-only planning. */
  isPermissionArgument(argument: ParsedArgument): boolean;
  /** True when the user already chose a permission mode, so auto mode adds nothing. */
  overridesAutoMode(args: string[]): boolean;
  /** Reasoning level an option selects, if any. */
  reasoningEffortOf(argument: ParsedArgument): string | undefined;
  /** Options that select a reasoning level; empty when the CLI has none. */
  reasoningArgs(effort: string): string[];
  /** Model an option selects, if any. */
  modelOf(argument: ParsedArgument): string | undefined;

  info(): AIProviderInfo;
}

/** One record of a conversation read from a provider's own session storage; `id` is stable across reads. */
export type ConversationEntry = { id: string; at: string } & (
  | { kind: 'user' | 'agent' | 'summary' | 'notice'; text: string }
  | { kind: 'tool_use'; callId: string; name: string; input: Record<string, unknown> }
  | { kind: 'tool_result'; callId: string; text: string; isError: boolean });
export interface SessionConversation { sessionId: string; entries: ConversationEntry[] }
