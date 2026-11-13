import type { DefaultProvider, ModelProfile, Run, Task } from '../types.js';
import { describeModel, familyProfile, type ModelFamily } from './model-profiles.js';
import { hasOption } from './support.js';
import type { AIProviderInfo, IAIProvider, LaunchContext, ModelContext, ModelListing, ParsedArgument, ProviderAccounts, ProviderArgumentPolicy, ProviderInvocation, SessionConversation, StreamEventInfo } from './types.js';
import type { VoiceSource } from './voice.js';
import type { UsageReading } from '../run-usage.js';
import type { ContextReading } from '../context-window.js';
import { collectUsage, type ProviderUsage, type UsageContext, type UsageSource } from './usage.js';

/** Shared defaults; a provider overrides only what its CLI does differently. */
export abstract class AIProvider implements IAIProvider {
  abstract readonly id: DefaultProvider;
  abstract readonly name: string;
  abstract readonly executable: string;
  abstract readonly args: ProviderArgumentPolicy;
  abstract readonly autoMode: { args: readonly string[]; overrides: readonly string[]; label: string };
  readonly icon: string | null = null;
  readonly reasoningEfforts: readonly string[] = [];
  readonly reasoningFlag: string | null = null;
  readonly reasoningInModelId: boolean = false;
  readonly fallbackModels: readonly string[] = [];
  readonly credentialEnv: readonly string[] = [];
  readonly homeEnv: string | null = null;
  readonly nativeTerminal: boolean = true;
  readonly history: boolean = false;
  readonly sessionConversation: boolean = false;
  readonly assignsSessionId: boolean = false;
  readonly sessionIdPattern: RegExp = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
  readonly voice: VoiceSource | null = null;
  readonly apiHost: string | null = null;
  readonly nativeProcess: { name: RegExp; command: RegExp } | null = null;
  readonly accounts: ProviderAccounts | null = null;
  /** Where the provider reports its remaining quota; absent when it reports none. */
  protected readonly usage?: UsageSource;
  /** Model families the provider lists, most specific first; with none, no model has a profile. */
  protected readonly modelFamilies: readonly ModelFamily[] = [];

  abstract homeDirectory(env: NodeJS.ProcessEnv, home: string): string;
  abstract getModels(context: ModelContext): Promise<ModelListing>;
  abstract headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation;
  abstract terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation;
  abstract resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation;

  async countSessions(_home: string): Promise<number | null> { return null; }
  modelProfile(id: string): ModelProfile | null { return familyProfile(this.modelFamilies, id); }

  async getRemainingTokensAllDetailed(context: UsageContext): Promise<ProviderUsage | null> {
    return this.usage ? collectUsage(this.id, this.usage, context) : null;
  }
  async getRemainingTokens(context: UsageContext): Promise<ProviderUsage | null> {
    const usage = await this.getRemainingTokensAllDetailed(context);
    if (!usage) return null;
    const { buckets: _buckets, ...summary } = usage;
    return summary;
  }

  prepareSession(invocation: ProviderInvocation, _context: LaunchContext): ProviderInvocation { return invocation; }

  /** User options go before a `--` delimiter when there is one, otherwise at the end. */
  mergeArgs(args: string[], extraArgs: string[], _context: LaunchContext): string[] {
    const separator = args.indexOf('--');
    return separator < 0 ? [...args, ...extraArgs] : [...args.slice(0, separator), ...extraArgs, ...args.slice(separator)];
  }

  readStreamEvent(_message: Record<string, unknown>): StreamEventInfo { return {}; }
  readStreamUsage(_message: Record<string, unknown>): UsageReading | undefined { return undefined; }
  readTranscriptUsage(_message: Record<string, unknown>): UsageReading | undefined { return undefined; }
  readSessionCost(_sessionId: string): Promise<number | undefined> { return Promise.resolve(undefined); }
  readSessionTranscript(_run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, _home?: string): Promise<string | undefined> { return Promise.resolve(undefined); }
  readSessionConversation(_run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, _home?: string): Promise<SessionConversation | undefined> { return Promise.resolve(undefined); }
  readTranscriptContext(_message: Record<string, unknown>): ContextReading | undefined { return undefined; }
  contextWindow(_model: string | undefined, _used: number): number | null { return null; }
  runEnv(_readOnly: boolean): Record<string, string> { return {}; }
  terminalEnv(_autoMode: boolean): Record<string, string> { return {}; }
  terminalSessionArgs(_sessionId: string): string[] { return []; }
  abstract terminalResumeArgs(sessionId: string): string[];

  checkArgument(_argument: ParsedArgument): void { /* Every option is accepted unless a provider says otherwise. */ }
  isPermissionArgument(argument: ParsedArgument): boolean { return this.args.permission.has(argument.flag); }
  overridesAutoMode(args: string[]): boolean { return hasOption(this, args, this.autoMode.overrides); }
  reasoningEffortOf(argument: ParsedArgument): string | undefined { return this.reasoningFlag && argument.flag === this.reasoningFlag ? argument.value : undefined; }
  reasoningArgs(effort: string): string[] { return this.reasoningFlag ? [this.reasoningFlag, effort] : []; }
  modelOf(argument: ParsedArgument): string | undefined { return ['--model', '-m'].includes(argument.flag) ? argument.value : undefined; }

  info(): AIProviderInfo {
    return { id: this.id, name: this.name, icon: this.icon, executable: this.executable, resumeArgs: this.terminalResumeArgs('{sessionId}'), reasoningEfforts: [...this.reasoningEfforts], reasoningFlag: this.reasoningFlag, reasoningInModelId: this.reasoningInModelId,
      fallbackModels: this.fallbackModels.map((id) => describeModel(this, { id })), autoModeLabel: this.autoMode.label, nativeTerminal: this.nativeTerminal, usage: Boolean(this.usage), history: this.history, transcript: this.history || this.sessionConversation, voice: this.voice !== null, accounts: this.accounts !== null };
  }
}
