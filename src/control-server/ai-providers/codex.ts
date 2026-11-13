import { open, readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ControlError, type Task } from '../types.js';
import { AIProvider } from './base.js';
import { UUID } from '../source-files.js';
import { OPENAI_FAMILIES } from './model-profiles.js';
import { readTokenCounts, type UsageReading } from '../run-usage.js';
import { fileLabel, filePath, textLength, type ContextPart, type ContextReading } from '../context-window.js';
import type { ContextKind } from '../types.js';
import { countFiles, hasOption, parseProviderArguments, uniqueModels } from './support.js';
import type { LaunchContext, ModelContext, ModelListing, ParsedArgument, ProviderInvocation, StreamEventInfo } from './types.js';
import { readJson, requestUsage, usageTimestamp, usageWindow, type RecordData, type UsageContext, type UsageSource, type UsageWindows } from './usage.js';
import { VOICE_SAMPLE_RATE, type VoiceSource } from './voice.js';

const permissionConfig = /^(?:sandbox_mode|sandbox_workspace_write(?:\.|=)|approval_policy|approvals_reviewer)\b/;
const sandboxConfig = /^(?:sandbox_mode|sandbox_workspace_write\.network_access)=/;
const shellConfig = ['-c', 'sandbox_workspace_write.network_access=true', '-c', 'shell_environment_policy.inherit=all'];

/** Newest rate-limit event in today's and yesterday's session logs. */
async function localRateLimits(context: UsageContext): Promise<{ value: RecordData; timestamp: number | null }> {
  const files: { path: string; mtime: number }[] = [];
  for (const daysAgo of [0, 1]) {
    const day = new Date(context.now() - daysAgo * 86400000);
    const directory = join(context.dir, 'sessions', String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0'));
    try { for (const file of await readdir(directory)) if (file.endsWith('.jsonl')) {
      const path = join(directory, file); try { files.push({ path, mtime: (await stat(path)).mtimeMs }); } catch { /* Rotated file. */ }
    } } catch { /* Provider not installed. */ }
  }
  let latest = { value: {} as RecordData, timestamp: null as number | null };
  for (const file of files.sort((a, b) => b.mtime - a.mtime).slice(0, 10)) {
    try {
      const handle = await open(file.path, 'r'); let text: string;
      try { const size = (await handle.stat()).size; const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024)); const result = await handle.read(buffer, 0, buffer.length, Math.max(0, size - buffer.length)); text = buffer.subarray(0, result.bytesRead).toString('utf8'); } finally { await handle.close(); }
      for (const line of text.split(/\r?\n/).reverse()) {
        if (!line.includes('"rate_limits"')) continue;
        try { const event = JSON.parse(line); const limits = event.payload?.rate_limits; const timestamp = usageTimestamp(event.timestamp);
          if (limits?.primary && timestamp !== null && (latest.timestamp === null || timestamp > latest.timestamp)) latest = { value: limits, timestamp };
        } catch { /* Partial or malformed JSONL record must not hide older valid records. */ }
      }
    } catch { /* Concurrent rotation. */ }
  }
  return latest;
}

function normalize(value: RecordData, now: number): UsageWindows {
  const window = (raw: RecordData, minutes: number) => usageWindow(raw.used_percent ?? raw.used_percentage ?? raw.utilization,
    raw.resets_at ?? raw.reset_at ?? (typeof raw.reset_after_seconds === 'number' ? now + raw.reset_after_seconds * 1000 : null),
    raw.window_minutes ?? (raw.limit_window_seconds ? raw.limit_window_seconds / 60 : minutes));
  // Codex reports whichever limits apply to the plan as primary/secondary: a plan may have only a weekly or monthly
  // primary window, so classify by window length rather than by position.
  const windows = [[value.primary ?? value.rate_limit?.primary_window, 300], [value.secondary ?? value.rate_limit?.secondary_window, 10080]]
    .filter(([raw]) => raw && typeof raw === 'object').map(([raw, minutes]) => window(raw as RecordData, minutes as number)).filter((item) => item.usedPercent !== null);
  return { short: windows.find((item) => item.windowMinutes <= 1440) ?? usageWindow(null, null, 300),
    weekly: windows.find((item) => item.windowMinutes > 1440) ?? usageWindow(null, null, 10080) };
}

const CODEX_TOKEN_FIELDS = { input: 'input_tokens', output: 'output_tokens', cacheRead: 'cached_input_tokens', total: 'total_tokens', cacheInInput: true };
const usage: UsageSource = {
  name: 'OpenAI Codex', defaultAccount: 'ChatGPT / Codex',
  auth: (context) => readJson(join(context.dir, 'auth.json')),
  local: localRateLimits,
  normalize,
  async remote(context, auth) {
    const accessToken = auth.tokens?.access_token;
    if (typeof accessToken !== 'string' || !accessToken) return undefined;
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'aiws-token-viewer' };
    if (typeof auth.tokens?.account_id === 'string') headers['ChatGPT-Account-Id'] = auth.tokens.account_id;
    const value = await requestUsage(context, 'https://chatgpt.com/backend-api/wham/usage', { headers });
    return value ? { windows: normalize(value, context.now()), ...(typeof value.email === 'string' ? { account: value.email } : {}) } : undefined;
  },
  serialize: (windows) => ({ primary: { used_percent: windows.short.usedPercent, resets_at: windows.short.resetsAt, window_minutes: windows.short.windowMinutes }, secondary: { used_percent: windows.weekly.usedPercent, resets_at: windows.weekly.resetsAt, window_minutes: windows.weekly.windowMinutes } }),
};

/** Wraps 16 kHz mono 16-bit little-endian PCM in a standard 44-byte RIFF/WAVE header. */
function pcmToWav(pcm: Buffer): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(VOICE_SAMPLE_RATE, 24); header.writeUInt32LE(VOICE_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function pcmRms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / 2);
  if (!samples) return 0;
  let sum = 0;
  for (let index = 0; index < samples; index++) { const sample = pcm.readInt16LE(index * 2) / 32768; sum += sample * sample; }
  return Math.sqrt(sum / samples);
}

/**
 * Codex's voice transcription: posts WAV audio to ChatGPT's `/backend-api/transcribe` endpoint using the
 * signed-in ChatGPT OAuth token in `auth.json` (or to OpenAI's `/v1/audio/transcriptions` when authenticated
 * with `OPENAI_API_KEY`). Utterances are flushed on pause or when dictation finishes.
 */
const voice: VoiceSource = {
  async open(context, options, handlers) {
    const auth = await readJson(join(context.dir, 'auth.json'));
    const accessToken = typeof auth.tokens?.access_token === 'string' && auth.tokens.access_token ? auth.tokens.access_token : undefined;
    const accountId = typeof auth.tokens?.account_id === 'string' && auth.tokens.account_id ? auth.tokens.account_id : undefined;
    const apiKey = context.env.OPENAI_API_KEY || (typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY ? auth.OPENAI_API_KEY : undefined);
    if (!accessToken && !apiKey) throw new ControlError('Codex voice needs a ChatGPT login or OPENAI_API_KEY. Run `codex login` first.', 401);
    const controller = new AbortController();
    let chunks: Buffer[] = [], bytes = 0, silentBytes = 0, hadSpeech = false, finishing = false, closed = false;
    let queue = Promise.resolve();
    const MIN_SPEECH_BYTES = VOICE_SAMPLE_RATE * 2, SILENCE_FLUSH_BYTES = Math.floor(VOICE_SAMPLE_RATE * 2 * 0.8), SPEECH_RMS = 0.012;
    const transcribe = async (pcm: Buffer): Promise<void> => {
      if (!pcm.length || closed) return;
      const form = new FormData();
      form.set('file', new Blob([new Uint8Array(pcmToWav(pcm))], { type: 'audio/wav' }), 'codex.wav');
      if (options.language) form.set('language', options.language);
      const url = accessToken ? 'https://chatgpt.com/backend-api/transcribe' : 'https://api.openai.com/v1/audio/transcriptions';
      if (!accessToken) form.set('model', 'gpt-4o-mini-transcribe');
      const headers: Record<string, string> = accessToken
        ? { Authorization: `Bearer ${accessToken}`, 'User-Agent': 'aiws-voice', originator: 'codex_vscode', ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}) }
        : { Authorization: `Bearer ${apiKey!}`, 'User-Agent': 'aiws-voice' };
      const response = await fetch(url, { method: 'POST', headers, body: form, signal: controller.signal });
      const body = await response.json().catch(() => undefined) as { text?: unknown; detail?: unknown; error?: { message?: unknown } } | undefined;
      if (!response.ok) throw new Error(typeof body?.error?.message === 'string' ? body.error.message : typeof body?.detail === 'string' ? body.detail : `Codex voice failed (HTTP ${response.status}).`);
      const text = typeof body?.text === 'string' ? body.text.trim() : '';
      if (text && !closed) handlers.onTranscript(text, true);
    };
    const flushBuffer = (): void => {
      if (!chunks.length) return;
      const pcm = Buffer.concat(chunks);
      chunks = []; bytes = 0; silentBytes = 0; hadSpeech = false;
      queue = queue.then(() => transcribe(pcm)).catch((error: unknown) => {
        if (!closed && !controller.signal.aborted) handlers.onError(error instanceof Error ? error.message : 'Transcription failed.');
      });
    };
    queueMicrotask(() => { if (!closed) handlers.onReady(); });
    return {
      send: (pcm) => {
        if (finishing || closed || !pcm.length) return;
        chunks.push(pcm); bytes += pcm.length;
        if (pcmRms(pcm) >= SPEECH_RMS) { hadSpeech = true; silentBytes = 0; }
        else if (hadSpeech) silentBytes += pcm.length;
        if (hadSpeech && bytes >= MIN_SPEECH_BYTES && silentBytes >= SILENCE_FLUSH_BYTES) flushBuffer();
      },
      finish: () => {
        if (finishing || closed) return;
        finishing = true;
        if (chunks.length) flushBuffer();
        void queue.finally(() => { if (!closed) { closed = true; handlers.onClose(); } });
      },
      close: () => { closed = true; finishing = true; controller.abort(); },
    };
  },
};

export class CodexProvider extends AIProvider {
  readonly id = 'codex' as const;
  readonly name = 'Codex';
  override readonly icon = '/icons/codex.svg';
  override readonly history = true;
  readonly executable = 'codex';
  override readonly reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'xhigh'];
  // Sources: learn.chatgpt.com/docs/models.
  override readonly fallbackModels = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-sol'];
  protected override readonly modelFamilies = OPENAI_FAMILIES;
  override readonly credentialEnv = ['OPENAI_API_KEY'];
  override readonly homeEnv = 'CODEX_HOME';
  override readonly apiHost = 'chatgpt.com';
  override readonly nativeProcess = { name: /^codex(?:\.exe)?$/i, command: /[/\\]@openai[/\\]codex[/\\]/ };
  override readonly voice = voice;
  override readonly sessionIdPattern = UUID;
  readonly args = {
    values: new Set(['-c', '--config', '-m', '--model', '-p', '--profile', '-s', '--sandbox', '-a', '--ask-for-approval', '--enable', '--disable', '--local-provider', '--add-dir', '-i', '--image', '--output-schema', '--color', '--cyber-access-program']),
    reserved: new Set(['--cd', '-C', '--cwd', '--worktree', '--remote', '--remote-auth-token-env', '--last', '--all', '--ephemeral', '--json', '--thread-source', '--session-id', '--resume', '--help', '-h', '--version', '-V']),
    permission: new Set(['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust', '--full-auto', '--approve-for-me', '--sandbox', '-s', '--ask-for-approval', '-a']),
  };
  readonly autoMode = { args: ['--yolo'], overrides: [], label: '--yolo' };
  protected override readonly usage = usage;

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string { return env.CODEX_HOME ?? join(home, '.codex'); }
  override countSessions(home: string): Promise<number | null> { return countFiles(join(home, 'sessions'), (name) => name.endsWith('.jsonl'), 4); }

  /** Codex caches the catalog it fetched for the signed-in account. */
  async getModels(context: ModelContext): Promise<ModelListing> {
    const path = join(this.homeDirectory(context.env, context.home), 'models_cache.json');
    let cache: { models?: Array<{ slug?: unknown; display_name?: unknown; visibility?: unknown; priority?: unknown; supported_reasoning_levels?: unknown }> };
    try { cache = JSON.parse(await readFile(path, 'utf8')); } catch { throw new ControlError('Codex has not cached its model list yet. Start Codex once while signed in, then refresh again.', 404); }
    const listed = (cache.models ?? []).filter((model) => typeof model.slug === 'string' && model.visibility !== 'hide')
      .sort((a, b) => (Number(a.priority) || 0) - (Number(b.priority) || 0));
    // Each entry lists the reasoning levels that model accepts, as { effort } objects.
    const efforts = (levels: unknown): string[] | undefined => Array.isArray(levels) ? levels.map((level) => (level as { effort?: unknown } | null)?.effort).filter((effort): effort is string => typeof effort === 'string' && this.reasoningEfforts.includes(effort)) : undefined;
    return { models: uniqueModels(listed.map((model) => { const levels = efforts(model.supported_reasoning_levels); return { id: String(model.slug), ...(typeof model.display_name === 'string' ? { name: model.display_name } : {}), ...(levels ? { efforts: levels } : {}) }; })), source: 'Codex model cache' };
  }

  headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation {
    return { executable: 'codex', args: ['exec', '--json', '--skip-git-repo-check', '--sandbox', readOnly ? 'read-only' : 'workspace-write', ...(readOnly ? [] : ['-c', 'sandbox_workspace_write.network_access=true']), '-c', 'shell_environment_policy.inherit=all', ...(task.model ? ['--model', task.model] : []), '-'], input: prompt };
  }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation {
    return { executable: 'codex', args: ['--sandbox', 'workspace-write', ...shellConfig, ...(model ? ['--model', model] : []), nativePrompt], input: '' };
  }
  /** The resume subcommand comes first; the configured options follow it. */
  terminalResumeArgs(sessionId: string): string[] { return ['resume', sessionId]; }
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation {
    return context.run.terminalMode === 'pty'
      ? { executable: 'codex', args: ['resume', sessionId, '--cd', context.project.repositoryPath, '--sandbox', 'workspace-write', ...shellConfig, ...message], input: '' }
      : { executable: 'codex', args: ['exec', 'resume', '--json', '--skip-git-repo-check', '-c', 'sandbox_mode=workspace-write', ...shellConfig, sessionId, '-'], input: context.prompt };
  }
  override mergeArgs(args: string[], extraArgs: string[], context: LaunchContext): string[] {
    // Remove only generated defaults; user-provided mutually exclusive choices stay visible to the CLI's own validation.
    const base = this.hasPermissionOverride(extraArgs) ? args.filter((argument, index, original) => argument !== '--sandbox' && original[index - 1] !== '--sandbox'
      && !(argument === '-c' && sandboxConfig.test(original[index + 1] ?? '')) && !(original[index - 1] === '-c' && sandboxConfig.test(argument))) : args;
    // A delimiter prevents a variadic option such as --image from consuming the prompt or stdin marker.
    if (base.at(-1) === '-' || base.at(-1) === context.nativePrompt) return [...base.slice(0, -1), ...extraArgs, '--', base.at(-1)!];
    return super.mergeArgs(base, extraArgs, context);
  }

  override checkArgument(argument: ParsedArgument): void {
    if (['--config', '-c'].includes(argument.flag) && /^\s*(?:cwd|session_id|thread_id)\s*=/.test(argument.value ?? '')) throw new ControlError('Codex project and original session identity are managed by the application.');
  }
  override isPermissionArgument(argument: ParsedArgument): boolean {
    return super.isPermissionArgument(argument) || (['--config', '-c'].includes(argument.flag) && permissionConfig.test((argument.value ?? '').trim()));
  }
  /** Options that replace the generated sandbox. */
  hasPermissionOverride(args: string[]): boolean {
    return parseProviderArguments(this, args).some((arg) => ['--yolo', '--dangerously-bypass-approvals-and-sandbox', '--full-auto', '--approve-for-me', '--sandbox', '-s'].includes(arg.flag) || ['--config', '-c'].includes(arg.flag) && /^sandbox_mode\s*=/.test((arg.value ?? '').trim()));
  }
  override overridesAutoMode(args: string[]): boolean { return this.hasPermissionOverride(args) || hasOption(this, args, ['--ask-for-approval', '-a']); }
  override reasoningEffortOf(argument: ParsedArgument): string | undefined {
    return ['-c', '--config'].includes(argument.flag) ? /^model_reasoning_effort\s*=\s*["']?([a-z]+)["']?\s*$/.exec(argument.value ?? '')?.[1] : undefined;
  }
  override reasoningArgs(effort: string): string[] { return ['-c', `model_reasoning_effort="${effort}"`]; }
  override modelOf(argument: ParsedArgument): string | undefined {
    return super.modelOf(argument) ?? (['-c', '--config'].includes(argument.flag) ? /^model\s*=\s*["']([^"']+)["']\s*$/.exec(argument.value ?? '')?.[1] : undefined);
  }
  override readStreamEvent(message: Record<string, unknown>): StreamEventInfo { return { failed: message.type === 'turn.failed' || message.type === 'error' }; }
  /** Codex prints tokens per turn and no cost. */
  override readStreamUsage(message: Record<string, unknown>): UsageReading | undefined {
    const tokens = message.type === 'turn.completed' ? readTokenCounts(message.usage, CODEX_TOKEN_FIELDS) : undefined;
    return tokens ? { tokens } : undefined;
  }
  /** Rollouts repeat the session's running total in each token_count event. */
  override readTranscriptUsage(message: Record<string, unknown>): UsageReading | undefined {
    const payload = message.type === 'event_msg' ? message.payload as { type?: unknown; info?: { total_token_usage?: unknown } | null } | undefined : undefined;
    const tokens = payload?.type === 'token_count' ? readTokenCounts(payload.info?.total_token_usage, CODEX_TOKEN_FIELDS) : undefined;
    return tokens ? { tokens, total: true } : undefined;
  }
  /** Rollouts record the whole model input as response items and the input size of each request in token_count events. */
  override readTranscriptContext(message: Record<string, unknown>): ContextReading | undefined {
    const payload = message.payload as Record<string, any> | undefined; if (!payload || typeof payload !== 'object') return undefined;
    const at = typeof message.timestamp === 'string' ? { at: message.timestamp } : {};
    if (message.type === 'turn_context') return typeof payload.model === 'string' ? { model: payload.model, ...at } : undefined;
    if (message.type === 'compacted') return { compacted: true, parts: [{ kind: 'summary', chars: textLength(payload.message) + textLength(payload.replacement_history) }], ...at };
    if (message.type === 'event_msg') {
      const window = Number(payload.info?.model_context_window ?? payload.model_context_window) || undefined;
      const last = payload.type === 'token_count' ? readTokenCounts(payload.info?.last_token_usage, CODEX_TOKEN_FIELDS) : undefined;
      return window || last ? { ...(window ? { window } : {}), ...(last ? { used: last.inputTokens + last.outputTokens } : {}), ...at } : undefined;
    }
    if (message.type !== 'response_item') return undefined;
    const parts = ((): ContextPart[] => {
      switch (payload.type) {
        case 'additional_tools': return [{ kind: 'tools', chars: textLength(payload.tools), replace: true }];
        case 'message':
          if (payload.role === 'developer') return [{ kind: 'system', chars: textLength(payload.content) }];
          if (payload.role !== 'user') return [{ kind: 'chat', chars: textLength(payload.content) }];
          return (Array.isArray(payload.content) ? payload.content : [payload.content]).map((part: unknown): ContextPart => {
            const text = typeof part === 'string' ? part : String((part as { text?: unknown })?.text ?? ''); const chars = typeof part === 'string' ? part.length : textLength([part]);
            return /^\s*# AGENTS\.md instructions\b/.test(text) ? { kind: 'memory', label: 'AGENTS.md', path: 'AGENTS.md', chars, replace: true } : { kind: /^\s*<[a-z_ ]+>/i.test(text) ? 'system' : 'chat', chars };
          });
        // Encrypted reasoning is base64; three of its four characters carry content.
        case 'reasoning': return [{ kind: 'reasoning', chars: textLength(payload.summary) + Math.round(textLength(payload.encrypted_content) * 3 / 4) }];
        case 'function_call': case 'custom_tool_call': { const input = payload.arguments ?? payload.input; return [{ ...codexTool(String(payload.name ?? ''), input), call: String(payload.call_id ?? ''), chars: textLength(input) }]; }
        case 'function_call_output': case 'custom_tool_call_output': return [{ kind: 'tool', resultOf: String(payload.call_id ?? ''), chars: textLength(payload.output) }];
        case 'local_shell_call': return [{ kind: 'shell', call: String(payload.call_id ?? ''), chars: textLength(payload.action) }];
        case 'web_search_call': return [{ kind: 'search', chars: textLength(payload.action) }];
        default: return [];
      }
    })();
    return parts.length ? { parts, ...at } : undefined;
  }
}

/** The context block a tool call and its result fill; a patch is filed under the first file it changes. */
function codexTool(name: string, input: unknown): { kind: ContextKind; label?: string; path?: string } {
  if (name === 'apply_patch') { const raw = /\*\*\* (?:Update|Add|Delete) File: (.+)/.exec(String(input ?? ''))?.[1]; const label = fileLabel(raw), path = filePath(raw); return { kind: 'file', ...(label ? { label } : {}), ...(path ? { path } : {}) }; }
  if (name === 'view_image') {
    let raw: unknown;
    try { const parsed = typeof input === 'string' ? JSON.parse(input) : input; raw = (parsed as { path?: unknown; file_path?: unknown } | null)?.path ?? (parsed as { file_path?: unknown } | null)?.file_path; } catch { /* Non-JSON arguments. */ }
    const label = fileLabel(raw), path = filePath(raw); return { kind: 'file', ...(label ? { label } : {}), ...(path ? { path } : {}) };
  }
  if (/^(?:exec|exec_command|shell|shell_command|local_shell|write_stdin|wait)$/.test(name)) return { kind: 'shell' };
  if (/agent/.test(name)) return { kind: 'agent' };
  if (/search|fetch/.test(name)) return { kind: 'search' };
  return { kind: 'tool', label: name.slice(0, 120) || 'tool' };
}
