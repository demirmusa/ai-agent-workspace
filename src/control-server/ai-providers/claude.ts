import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAccounts } from './claude-accounts.js';
import { ControlError, type ProviderModel, type Task } from '../types.js';
import { AIProvider } from './base.js';
import { UUID } from '../source-files.js';
import { CLAUDE_FAMILIES } from './model-profiles.js';
import { readTokenCounts, type UsageReading } from '../run-usage.js';
import { fileLabel, filePath, textLength, type ContextPart, type ContextReading } from '../context-window.js';
import type { ContextKind } from '../types.js';
import { countFiles, hasOption, uniqueModels, withoutOptions } from './support.js';
import type { LaunchContext, ModelContext, ModelListing, ProviderInvocation, StreamEventInfo } from './types.js';
import { WebSocket } from 'ws';
import { VOICE_SAMPLE_RATE, type VoiceSource } from './voice.js';
import { readJson, requestUsage, savedBuckets, usageTimestamp, usageWindow, type RecordData, type UsageBucket, type UsageSource, type UsageWindows } from './usage.js';

const CLAUDE_TOKEN_FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cache_read_input_tokens', cacheWrite: 'cache_creation_input_tokens' };
const tools = 'Bash,Read,Edit,Write,Glob,Grep';
// Attachments that list tools, skills, agents or MCP servers belong with the tool definitions; the rest are system reminders.
const TOOL_ATTACHMENTS = new Set(['skill_listing', 'deferred_tools_delta', 'agent_listing_delta', 'mcp_instructions_delta']);
const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'NotebookRead']);
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'LS']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'KillBash', 'Monitor']);
/** An image costs about as much as 1.5k tokens of text. */
const IMAGE_CHARS = 6000;
/** The context block a tool call and its result fill. */
function claudeTool(name: string, input: Record<string, unknown>): { kind: ContextKind; label?: string; path?: string } {
  if (FILE_TOOLS.has(name)) { const raw = input.file_path ?? input.notebook_path; const label = fileLabel(raw), path = filePath(raw); return { kind: 'file', ...(label ? { label } : {}), ...(path ? { path } : {}) }; }
  if (SEARCH_TOOLS.has(name)) return { kind: 'search' };
  if (SHELL_TOOLS.has(name)) return { kind: 'shell' };
  if (name === 'Task' || name === 'Agent') return { kind: 'agent' };
  return { kind: 'tool', label: (/^mcp__(.+?)__/.exec(name)?.[1] ?? name).slice(0, 120) };
}
/** System reminders and command echoes the client adds to user turns. */
const claudeTextKind = (text: string): ContextKind => /^\s*<(?:system-reminder|local-command|command-)/.test(text) ? 'system' : 'chat';
const READ_ONLY_ARGS = ['--tools', 'Read,Glob,Grep', '--strict-mcp-config', '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,Agent,Task,ExitPlanMode,Skill'];

/** Minutes of a `limits` entry's window group in Claude's usage response. */
const LIMIT_GROUP_MINUTES: Record<string, number> = { session: 300, daily: 1440, weekly: 10080, monthly: 43200 };
/** Kinds of `limits` entries that repeat the five-hour and seven-day windows. */
const MAIN_LIMITS = new Set(['session', 'weekly_all']);
/** Older per-model weekly windows, used when the response has no `limits` list. */
const LEGACY_SCOPED: Record<string, string> = { seven_day_opus: 'Opus', seven_day_sonnet: 'Sonnet' };

/** Claude's other quotas (e.g. the weekly window of one model): its `limits` list, older per-model keys or saved buckets. */
function claudeBuckets(value: RecordData): UsageBucket[] {
  if (!Array.isArray(value.limits)) {
    const legacy = Object.entries(LEGACY_SCOPED).flatMap(([key, scope]): UsageBucket[] => {
      const raw = value[key];
      return raw && typeof raw === 'object' ? [{ id: key, label: `Weekly (${scope})`, scope, window: usageWindow(raw.utilization, raw.resets_at, 10080) }] : [];
    });
    return [...legacy, ...savedBuckets(value, 10080)].filter((bucket) => bucket.window.usedPercent !== null);
  }
  return value.limits.filter((limit: any) => limit && typeof limit === 'object' && !MAIN_LIMITS.has(limit.kind)).map((limit: RecordData): UsageBucket => {
    const group = String(limit.group ?? ''), minutes = LIMIT_GROUP_MINUTES[group] ?? 10080;
    const scope = String(limit.scope?.model?.display_name ?? limit.scope?.model?.id ?? limit.scope?.surface?.display_name ?? limit.scope?.surface ?? '').trim();
    const name = group ? group.charAt(0).toUpperCase() + group.slice(1) : String(limit.kind ?? 'Limit');
    return { id: [limit.kind, scope.toLowerCase()].filter(Boolean).join(':'), label: scope ? `${name} (${scope})` : name, ...(scope ? { scope } : {}),
      window: usageWindow(limit.percent ?? limit.utilization, limit.resets_at, minutes) };
  }).filter((bucket: UsageBucket) => bucket.window.usedPercent !== null);
}

/** Claude Code's five-hour and seven-day windows plus its other quotas; Antigravity's saved snapshots use the same shape. */
export function fiveHourAndWeekly(value: RecordData, now: number): UsageWindows {
  const window = (raw: RecordData, minutes: number) => usageWindow(raw.used_percent ?? raw.used_percentage ?? raw.utilization,
    raw.resets_at ?? raw.reset_at ?? (typeof raw.reset_after_seconds === 'number' ? now + raw.reset_after_seconds * 1000 : null),
    raw.window_minutes ?? (raw.limit_window_seconds ? raw.limit_window_seconds / 60 : minutes));
  const buckets = claudeBuckets(value);
  return { short: window(value.five_hour ?? {}, 300), weekly: window(value.seven_day ?? {}, 10080), ...(buckets.length ? { buckets } : {}) };
}
export const serializeFiveHourAndWeekly = (windows: UsageWindows): RecordData => ({ five_hour: { utilization: windows.short.usedPercent, resets_at: windows.short.resetsAt }, seven_day: { utilization: windows.weekly.usedPercent, resets_at: windows.weekly.resetsAt }, ...(windows.buckets?.length ? { buckets: windows.buckets } : {}) });

const usage: UsageSource = {
  name: 'Claude Code', defaultAccount: 'Claude Account',
  auth: (context) => readJson(join(context.dir, '.credentials.json')),
  account: (context) => readJson(join(context.home, '.claude.json')),
  async local(context) {
    const cache = await readJson(join(context.dir, 'usage-cache.json'));
    return { value: cache.rate_limits ?? cache, timestamp: usageTimestamp(cache.updated_at) };
  },
  normalize: fiveHourAndWeekly,
  weeklyFromSnapshots: true,
  // The statusline's usage-cache.json has only the five-hour and seven-day windows, never the per-model ones (e.g. Fable).
  localPartial: true,
  async remote(context, auth) {
    const accessToken = auth.claudeAiOauth?.accessToken;
    if (typeof accessToken !== 'string' || !accessToken) return undefined;
    const value = await requestUsage(context, 'https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'aiws-token-viewer', 'anthropic-beta': 'oauth-2025-04-20' } });
    return value ? { windows: fiveHourAndWeekly(value, context.now()), ...(typeof value.email === 'string' ? { account: value.email } : {}) } : undefined;
  },
  serialize: serializeFiveHourAndWeekly,
};

/**
 * Claude Code's /voice service: a WebSocket to Anthropic's speech-to-text, signed in with the Claude.ai login
 * Claude Code keeps in its home folder. The token stays on the server; audio goes up as binary frames and
 * transcripts come back as JSON.
 */
const voice: VoiceSource = {
  async open(context, options, handlers) {
    const auth = await readJson(join(context.dir, '.credentials.json'));
    const token = auth.claudeAiOauth?.accessToken, expiresAt = Number(auth.claudeAiOauth?.expiresAt);
    if (typeof token !== 'string' || !token) throw new ControlError('Claude Code voice needs a Claude.ai login. Run `claude` and sign in with /login.', 401);
    if (Number.isFinite(expiresAt) && expiresAt < Date.now()) throw new ControlError('The Claude Code login has expired. Open `claude` once to renew it.', 401);
    const query = new URLSearchParams({ encoding: 'linear16', sample_rate: String(VOICE_SAMPLE_RATE), channels: '1', endpointing_ms: '300', utterance_end_ms: '1000', language: options.language, use_conversation_engine: 'true' });
    const socket = new WebSocket(`wss://api.anthropic.com/api/ws/speech_to_text/voice_stream?${query}`, { headers: { Authorization: `Bearer ${token}`, 'User-Agent': 'aiws-voice', 'x-app': 'cli' } });
    let interim = '', lastFlushed = '', finishing = false, connected = false;
    const flush = (): void => {
      if (!interim) return;
      const text = interim; interim = '';
      if (text !== lastFlushed) { lastFlushed = text; handlers.onTranscript(text, true); }
    };
    const fail = (message: string): void => { flush(); if (!finishing) handlers.onError(message); };
    const keepAlive = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('{"type":"KeepAlive"}'); }, 8000); keepAlive.unref();
    socket.on('open', () => { connected = true; socket.send('{"type":"KeepAlive"}'); handlers.onReady(); });
    socket.on('message', (raw) => {
      let message: Record<string, unknown>;
      try { message = JSON.parse(String(raw)) as Record<string, unknown>; } catch { return; }
      if (message.type === 'TranscriptInterim' || message.type === 'TranscriptText') {
        if (typeof message.data === 'string' && message.data && message.data !== lastFlushed) { interim = message.data; handlers.onTranscript(interim, false); }
      } else if (message.type === 'TranscriptEndpoint') {
        flush();
        if (finishing) socket.close();
      } else if (message.type === 'TranscriptError') fail(String(message.description ?? message.error_code ?? 'Transcription failed.'));
      else if (message.type === 'error') fail(String(message.message ?? 'Transcription failed.'));
    });
    socket.on('unexpected-response', (_request, response) => { response.resume(); fail(`Claude voice was rejected (HTTP ${response.statusCode ?? 0}). Sign in to Claude Code with a Claude.ai account.`); });
    socket.on('error', (error) => { if (connected) fail(error.message); else if (!finishing) handlers.onError(error.message); });
    socket.on('close', (code) => {
      clearInterval(keepAlive); flush();
      if (!finishing && connected && code !== 1000 && code !== 1005) handlers.onError(`Claude voice connection closed (${code}).`);
      handlers.onClose();
    });
    return {
      send: (pcm) => { if (socket.readyState === WebSocket.OPEN && !finishing) socket.send(pcm); },
      finish: () => {
        if (finishing) return;
        finishing = true;
        if (socket.readyState === WebSocket.OPEN) { socket.send('{"type":"CloseStream"}'); setTimeout(() => socket.close(), 5000).unref(); } else socket.terminate();
      },
      close: () => { finishing = true; socket.terminate(); },
    };
  },
};

export class ClaudeProvider extends AIProvider {
  readonly id = 'claude' as const;
  readonly name = 'Claude Code';
  override readonly icon = '/icons/claude.png';
  override readonly history = true;
  readonly executable = 'claude';
  override readonly reasoningEfforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  override readonly reasoningFlag = '--effort';
  // Sources: code.claude.com/docs/en/model-config.
  override readonly fallbackModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
  protected override readonly modelFamilies = CLAUDE_FAMILIES;
  override readonly credentialEnv = ['ANTHROPIC_API_KEY'];
  override readonly homeEnv = 'CLAUDE_CONFIG_DIR';
  override readonly apiHost = 'api.anthropic.com';
  override readonly nativeProcess = { name: /^claude(?:\.exe)?$/i, command: /[/\\]@anthropic-ai[/\\]claude-code[/\\]/ };
  override readonly assignsSessionId = true;
  override readonly voice = voice;
  override readonly sessionIdPattern = UUID;
  readonly args = {
    values: new Set(['--model', '--fallback-model', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir', '--agent', '--agents', '--append-system-prompt', '--system-prompt', '--max-turns', '--max-budget-usd', '--effort', '--betas', '--mcp-config', '--plugin-dir', '--settings', '--setting-sources']),
    reserved: new Set(['--resume', '-r', '--continue', '-c', '--session-id', '--fork-session', '--resume-session-at', '--cwd', '--worktree', '-w', '--print', '-p', '--output-format', '--input-format', '--replay-user-messages', '--help', '-h', '--version', '-v']),
    permission: new Set(['--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--permission-mode', '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--mcp-config', '--settings', '--setting-sources', '--plugin-dir']),
  };
  readonly autoMode = { args: ['--permission-mode', 'auto'], overrides: ['--permission-mode', '--dangerously-skip-permissions'], label: '--permission-mode auto' };
  protected override readonly usage = usage;
  // Account sessions share the default history folder, where AIWS reads transcripts.
  override readonly accounts = new ClaudeAccounts({ historyHome: () => this.homeDirectory(process.env, homedir()) });

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string { return env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'); }
  override countSessions(home: string): Promise<number | null> { return countFiles(join(home, 'projects'), (name) => name.endsWith('.jsonl'), 1); }

  /** Claude Code keeps the account's model catalog per surface; `cc` is the terminal CLI. */
  async getModels(context: ModelContext): Promise<ModelListing> {
    const directory = join(this.homeDirectory(context.env, context.home), 'cache', 'model-catalog');
    let newest: { fetchedAt: number; models: ProviderModel[] } | undefined;
    for (const name of await readdir(directory).catch(() => [] as string[])) {
      if (!name.endsWith('-cc.json')) continue;
      try {
        const value = JSON.parse(await readFile(join(directory, name), 'utf8')) as { fetchedAt?: number; catalog?: { config?: { models?: Array<{ id?: unknown; name?: unknown }> } } };
        const models = (value.catalog?.config?.models ?? []).filter((model) => typeof model.id === 'string').map((model) => ({ id: String(model.id), ...(typeof model.name === 'string' ? { name: model.name } : {}) }));
        if (models.length && (!newest || (value.fetchedAt ?? 0) > newest.fetchedAt)) newest = { fetchedAt: value.fetchedAt ?? 0, models };
      } catch { /* Partially written cache files are skipped. */ }
    }
    if (newest) return { models: uniqueModels(newest.models), source: 'Claude Code model catalog' };
    const key = context.env.ANTHROPIC_API_KEY;
    if (!key) throw new ControlError('Claude Code has not cached its model catalog yet. Start Claude Code once while signed in, or set ANTHROPIC_API_KEY, then refresh again.', 404);
    const response = await context.request('https://api.anthropic.com/v1/models?limit=100', { signal: AbortSignal.timeout(30_000), headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
    const value = await response.json().catch(() => undefined) as { data?: Array<{ id?: unknown; display_name?: unknown }>; error?: { message?: string } } | undefined;
    if (!response.ok) throw new ControlError(`Anthropic API: ${value?.error?.message ?? response.status}`, 502);
    return { models: uniqueModels((value?.data ?? []).filter((model) => typeof model.id === 'string').map((model) => ({ id: String(model.id), ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}) }))), source: 'Anthropic API' };
  }

  headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation {
    return { executable: 'claude', args: ['--print', '--output-format', 'stream-json', '--verbose', '--permission-mode', readOnly ? 'plan' : 'acceptEdits', '--allowedTools', readOnly ? 'Read,Glob,Grep' : tools, ...(readOnly ? READ_ONLY_ARGS : []), ...(task.model ? ['--model', task.model] : [])], input: prompt };
  }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation {
    return { executable: 'claude', args: ['--permission-mode', 'acceptEdits', '--allowedTools', tools, ...(model ? ['--model', model] : []), '--', nativePrompt], input: '' };
  }
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation {
    const args = ['--resume', sessionId, '--permission-mode', 'acceptEdits', '--allowedTools', tools];
    return context.run.terminalMode === 'pty'
      ? { executable: 'claude', args: [...args, '--', ...message], input: '' }
      : { executable: 'claude', args: ['--print', '--output-format', 'stream-json', '--verbose', ...args], input: context.prompt };
  }
  /** A fresh session gets its ID up front, so follow-up work can resume it without searching history. */
  override prepareSession(invocation: ProviderInvocation, context: LaunchContext): ProviderInvocation {
    if (!context.run.sessionId || context.run.historyResume || context.readOnly) return invocation;
    const separator = invocation.args.indexOf('--');
    return { ...invocation, args: separator < 0 ? [...invocation.args, '--session-id', context.run.sessionId] : [...invocation.args.slice(0, separator), '--session-id', context.run.sessionId, ...invocation.args.slice(separator)] };
  }
  override terminalSessionArgs(sessionId: string): string[] { return ['--session-id', sessionId]; }
  terminalResumeArgs(sessionId: string): string[] { return ['--resume', sessionId]; }
  override mergeArgs(args: string[], extraArgs: string[], context: LaunchContext): string[] {
    const replaced = [
      ...(hasOption(this, extraArgs, ['--permission-mode', '--dangerously-skip-permissions']) ? ['--permission-mode'] : []),
      ...(hasOption(this, extraArgs, ['--allowedTools', '--allowed-tools']) ? ['--allowedTools'] : []),
    ];
    return super.mergeArgs(withoutOptions(args, replaced), extraArgs, context);
  }
  override readStreamEvent(message: Record<string, unknown>): StreamEventInfo {
    return {
      model: message.type === 'system' ? message.model : message.type === 'assistant' ? (message.message as { model?: unknown } | undefined)?.model : undefined,
      failed: message.type === 'result' && message.is_error === true,
    };
  }
  /** The final `result` line carries the whole invocation's tokens and the cost Claude Code computed. */
  override readStreamUsage(message: Record<string, unknown>): UsageReading | undefined {
    if (message.type !== 'result') return undefined;
    const tokens = readTokenCounts(message.usage, CLAUDE_TOKEN_FIELDS); const cost = message.total_cost_usd;
    return tokens ? { tokens, ...(typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}) } : undefined;
  }
  /** Transcripts hold one usage block per assistant message (repeated for each streamed part) and no cost. */
  override readTranscriptUsage(message: Record<string, unknown>): UsageReading | undefined {
    if (message.type !== 'assistant') return undefined;
    const inner = message.message as { id?: unknown; usage?: unknown } | undefined; const tokens = readTokenCounts(inner?.usage, CLAUDE_TOKEN_FIELDS);
    return tokens ? { tokens, ...(typeof inner?.id === 'string' ? { id: inner.id } : {}) } : undefined;
  }
  /** Claude Code keeps the cost `/cost` shows for each project's last session in .claude.json (inside CLAUDE_CONFIG_DIR when set). */
  override async readSessionCost(sessionId: string): Promise<number | undefined> {
    const dir = process.env.CLAUDE_CONFIG_DIR;
    const config = await readJson(dir ? join(dir, '.claude.json') : join(homedir(), '.claude.json'));
    const projects = config.projects && typeof config.projects === 'object' ? Object.values(config.projects as Record<string, RecordData>) : [];
    const cost = projects.find((project) => project?.lastSessionId === sessionId)?.lastCost;
    return typeof cost === 'number' && Number.isFinite(cost) && cost >= 0 ? cost : undefined;
  }
  /** Newer clients record the exact system prompt and tool list (api-request-shape); attachments carry CLAUDE.md and reminders. */
  override readTranscriptContext(message: Record<string, unknown>): ContextReading | undefined {
    const at = typeof message.timestamp === 'string' ? message.timestamp : undefined; const sidechain = typeof message.isSidechain === 'boolean' ? message.isSidechain : undefined;
    const reading = (parts: ContextPart[], extra: Partial<ContextReading> = {}): ContextReading => ({ parts, ...(sidechain !== undefined ? { sidechain } : {}), ...(at ? { at } : {}), ...extra });
    if (message.type === 'api-request-shape') {
      const shape = message.shape as { system?: unknown; tools?: unknown } | undefined; if (!shape || typeof shape !== 'object') return undefined;
      return reading([{ kind: 'system', chars: textLength(shape.system), replace: true }, { kind: 'tools', chars: textLength(shape.tools ?? []), replace: true }]);
    }
    if (message.type === 'attachment') {
      const attachment = message.attachment as { type?: unknown; files?: unknown } | undefined; if (!attachment || typeof attachment !== 'object') return undefined;
      if (attachment.type === 'instructions' && Array.isArray(attachment.files)) return reading(attachment.files.flatMap((file): ContextPart[] => {
        const label = fileLabel(file?.path), path = filePath(file?.path); return typeof file?.content === 'string' ? [{ kind: 'memory', ...(label ? { label } : {}), ...(path ? { path } : {}), chars: file.content.length, replace: true }] : [];
      }));
      return reading([{ kind: TOOL_ATTACHMENTS.has(String(attachment.type)) ? 'tools' : 'system', chars: textLength(attachment) }]);
    }
    if (message.type === 'system' && message.subtype === 'compact_boundary') return reading([], { compacted: true });
    const inner = message.message as { content?: unknown; usage?: Record<string, unknown>; model?: unknown } | undefined;
    if (message.type === 'user') {
      const content = inner?.content;
      if (typeof content === 'string') return reading([{ kind: message.isCompactSummary ? 'summary' : claudeTextKind(content), chars: content.length }]);
      if (!Array.isArray(content)) return undefined;
      return reading(content.flatMap((part): ContextPart[] => {
        if (part?.type === 'text' && typeof part.text === 'string') return [{ kind: message.isCompactSummary ? 'summary' : claudeTextKind(part.text), chars: part.text.length }];
        if (part?.type === 'tool_result') return [{ kind: 'tool', resultOf: String(part.tool_use_id ?? ''), chars: Array.isArray(part.content) ? part.content.reduce((sum: number, item: { type?: unknown }) => sum + (item?.type === 'image' ? IMAGE_CHARS : textLength([item])), 0) : textLength(part.content) }];
        if (part?.type === 'image') return [{ kind: 'chat', chars: IMAGE_CHARS }];
        return [];
      }));
    }
    if (message.type !== 'assistant' || !Array.isArray(inner?.content)) return undefined;
    const parts = inner.content.flatMap((part): ContextPart[] => {
      if (part?.type === 'text' && typeof part.text === 'string') return [{ kind: 'chat', chars: part.text.length }];
      if (part?.type === 'thinking') return [{ kind: 'reasoning', chars: textLength(part.thinking) }];
      if (part?.type === 'redacted_thinking') return [{ kind: 'reasoning', chars: textLength(part.data) }];
      if (part?.type === 'tool_use' && typeof part.name === 'string') { const input = part.input && typeof part.input === 'object' ? part.input : {}; return [{ ...claudeTool(part.name, input), call: String(part.id ?? ''), chars: textLength(input) }]; }
      return [];
    });
    const tokens = readTokenCounts(inner.usage, CLAUDE_TOKEN_FIELDS);
    return reading(parts, { ...(tokens ? { used: tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens + tokens.outputTokens } : {}), ...(typeof inner.model === 'string' && !inner.model.startsWith('<') ? { model: inner.model } : {}) });
  }
  /** 200k unless the model is a 1M variant or the session already holds more. */
  override contextWindow(model: string | undefined, used: number): number | null { return /\[1m\]|-1m\b/i.test(model ?? '') || used > 200_000 ? 1_000_000 : 200_000; }
}
