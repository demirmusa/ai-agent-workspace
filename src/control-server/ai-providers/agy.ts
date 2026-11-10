import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { parseJsonOrNull } from '../../shared/core/json.js';
import { isUnlinkedFile, readJsonWindow } from '../source-files.js';
import type { Run, Task } from '../types.js';
import { AIProvider } from './base.js';
import { serializeFiveHourAndWeekly } from './claude.js';
import { MODEL_FAMILIES } from './model-profiles.js';
import { countFiles, hasOption, SESSION_CAP, uniqueModels, withoutOptions } from './support.js';
import type { LaunchContext, ModelContext, ModelListing, ProviderInvocation, SessionConversation, ConversationEntry, StreamEventInfo } from './types.js';
import { readJson, requestUsage, savedBuckets, usageTimestamp, usageWindow, type RecordData, type UsageBucket, type UsageSource, type UsageWindows } from './usage.js';

const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

function clipText(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function extractUserRequest(content: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(content);
  const text = (match ? match[1]! : content)
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '')
    .trim();
  if (/^(?:Read and follow the task instructions in [^\n]*prompt\.md\b|Yukar[ıi]daki g[öo]revi mevcut projede uygula\b)/i.test(text)) return '';
  if (/\bAIWS run run_[0-9a-f-]+, task task_[0-9a-f-]+\./.test(text)) return '';
  return text;
}

function extractCheckpointSummary(content: string): string {
  const match = /<summary>\s*([\s\S]*?)\s*<\/summary>/i.exec(content);
  if (match?.[1]) return match[1].trim();
  return content.replace(/# Conversation Logs[\s\S]*$/i, '').trim();
}

function summarizeToolArgs(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>).slice(0, 12)) {
    const parsed = typeof value === 'string' && /^[[{"]/.test(value.trim()) ? (parseJsonOrNull(value) ?? value) : value;
    if (typeof parsed === 'string') result[key] = clipText(parsed, 400);
    else if (typeof parsed === 'number' || typeof parsed === 'boolean' || parsed === null) result[key] = parsed;
    else result[key] = clipText(JSON.stringify(parsed), 400);
  }
  return result;
}

function summarizeToolOutput(name: string, content: string, isError: boolean): string {
  const body = content.replace(/^(?:Created At:[^\n]*\n)?(?:Completed At:[^\n]*\n)?\n*/, '').trim();
  if (!body) return '';
  if (name === 'read_file' && !isError) {
    const firstLine = body.split('\n')[0]?.trim() ?? '';
    return clipText(firstLine, 300);
  }
  return clipText(body, 2_000);
}

/** The conversation of an Antigravity transcript; only the latest checkpoint's summary stands in for the steps before it. */
function agyConversation(rows: Record<string, unknown>[]): ConversationEntry[] {
  let lastCheckpoint = -1;
  for (let index = 0; index < rows.length; index++) {
    if (rows[index]?.source === 'SYSTEM' && rows[index]?.type === 'CHECKPOINT' && typeof rows[index]?.content === 'string') lastCheckpoint = index;
  }
  const entries: ConversationEntry[] = [];
  let fallbackAt = '';
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const id = `agy_${typeof row.step_index === 'number' ? row.step_index : `row${index}`}`;
    const at = typeof row.created_at === 'string' && row.created_at ? row.created_at : fallbackAt;
    fallbackAt = at;
    if (row.type === 'USER_INPUT' && typeof row.content === 'string') {
      const text = extractUserRequest(row.content);
      if (text) entries.push({ id, at, kind: 'user', text: clipText(text, 16_000) });
    } else if (index === lastCheckpoint && row.source === 'SYSTEM' && row.type === 'CHECKPOINT' && typeof row.content === 'string') {
      const summary = extractCheckpointSummary(row.content);
      if (summary) entries.push({ id, at, kind: 'summary', text: clipText(summary, 32_000) });
    } else if (index > lastCheckpoint && row.source === 'SYSTEM' && row.type === 'SYSTEM_MESSAGE' && typeof row.content === 'string') {
      const text = row.content.replace(/<\/?SYSTEM_MESSAGE>/gi, '').trim();
      if (text) entries.push({ id, at, kind: 'notice', text: clipText(text, 2_000) });
    } else if (row.source === 'MODEL' && row.type === 'PLANNER_RESPONSE') {
      if (typeof row.content === 'string' && row.content.trim()) entries.push({ id, at, kind: 'agent', text: clipText(row.content.trim(), 16_000) });
      if (index > lastCheckpoint && Array.isArray(row.tool_calls)) {
        const toolRows: Record<string, unknown>[] = [];
        for (let k = index + 1; k < rows.length && rows[k]?.source === 'TOOL' && rows[k]?.type === 'GENERIC'; k++) toolRows.push(rows[k]!);
        const calls = row.tool_calls as Array<Record<string, unknown>>;
        for (let callIndex = 0; callIndex < calls.length; callIndex++) {
          const call = calls[callIndex]!;
          const name = typeof call.name === 'string' ? call.name : 'tool';
          const callId = `${id}_call${callIndex}`;
          entries.push({ id: callId, at, kind: 'tool_use', callId, name, input: summarizeToolArgs(call.args) });
          const toolRow = toolRows[callIndex];
          if (toolRow && typeof toolRow.content === 'string') {
            const output = summarizeToolOutput(name, toolRow.content, toolRow.status === 'ERROR');
            if (output) entries.push({ id: `${callId}_result`, at: typeof toolRow.created_at === 'string' ? toolRow.created_at : at, kind: 'tool_result', callId, text: output, isError: toolRow.status === 'ERROR' });
          }
        }
      }
    }
  }
  return entries;
}

function formatAgyTranscript(entries: ConversationEntry[]): string {
  return entries.map((entry) => {
    switch (entry.kind) {
      case 'user': return `[user] ${entry.text}`;
      case 'agent': return `[agent] ${entry.text}`;
      case 'summary': return `[summary]\n${entry.text}`;
      case 'notice': case 'tool_result': return `[tool result] ${entry.text}`;
      case 'tool_use': return `[tool call] ${JSON.stringify({ name: entry.name, input: entry.input })}`;
    }
  }).join('\n\n');
}

/** Quota groups from `agy /usage` or the Cloud Code API, or the five-hour/weekly shape of saved snapshots. */
function normalize(value: RecordData): UsageWindows {
  const rawGroups = Array.isArray(value.groups) ? value.groups : Array.isArray(value.command?.data?.groups) ? value.command.data.groups : null;
  if (rawGroups) {
    const buckets: UsageBucket[] = [];
    for (const group of rawGroups) {
      const groupName = String(group?.name ?? group?.displayName ?? '').trim();
      for (const b of Array.isArray(group?.buckets) ? group.buckets : []) {
        const id = String(b?.id ?? b?.bucketId ?? '').trim();
        const windowType = String(b?.window ?? (id.endsWith('weekly') ? 'weekly' : '5h')).toLowerCase();
        const minutes = windowType === 'weekly' ? 10080 : 300;
        const rem = b?.remaining_fraction ?? b?.remainingFraction;
        const used = typeof rem === 'number' && Number.isFinite(rem) ? Math.round((1 - rem) * 10000) / 100 : (b?.used_percent ?? b?.used_percentage ?? b?.utilization);
        const reset = b?.reset_time ?? b?.resetTime ?? b?.resets_at ?? b?.reset_at;
        const bucketName = String(b?.name ?? b?.displayName ?? windowType).trim();
        const label = groupName && !bucketName.toLowerCase().includes(groupName.toLowerCase()) ? `${groupName} · ${bucketName}` : (bucketName || groupName || id);
        buckets.push({ id: id || label, label, window: usageWindow(used, reset, minutes) });
      }
    }
    const shortBucket = buckets.find((b) => b.id === 'gemini-5h') ?? buckets.find((b) => b.window.windowMinutes <= 300);
    const weeklyBucket = buckets.find((b) => b.id === 'gemini-weekly') ?? buckets.find((b) => b.window.windowMinutes > 300);
    return {
      short: shortBucket ? shortBucket.window : usageWindow(null, null, 300),
      weekly: weeklyBucket ? weeklyBucket.window : usageWindow(null, null, 10080),
      ...(buckets.length ? { buckets } : {}),
    };
  }
  const saved = savedBuckets(value, 300);
  const short = value.five_hour ?? value.primary ?? {};
  const weekly = value.seven_day ?? value.secondary ?? {};
  return {
    short: usageWindow(short.used_percent ?? short.used_percentage ?? short.utilization, short.resets_at ?? short.reset_at, short.window_minutes ?? 300),
    weekly: usageWindow(weekly.used_percent ?? weekly.used_percentage ?? weekly.utilization, weekly.resets_at ?? weekly.reset_at, 10080),
    ...(saved.length ? { buckets: saved } : {}),
  };
}

const usage: UsageSource = {
  name: 'Antigravity', defaultAccount: 'Antigravity / Google',
  auth: (context) => readJson(join(context.dir, 'oauth_creds.json')),
  account: (context) => readJson(join(context.dir, 'google_accounts.json')),
  async local(context) {
    const cache = await readJson(join(context.dir, 'usage-cache.json'));
    return { value: cache.rate_limits ?? cache, timestamp: usageTimestamp(cache.updated_at) };
  },
  normalize,
  weeklyFromSnapshots: true,
  // The local CLI is cheap, so it also fills an empty display without an explicit refresh.
  remoteWithoutApi: (context, source) => Boolean(context.command) && source === 'unavailable',
  async remote(context, auth) {
    if (context.command) {
      context.markChecked();
      try {
        const windows = normalize(JSON.parse(await context.command(['--output-format', 'json', '--print', '/usage'])) as RecordData);
        if (windows.short.usedPercent !== null || windows.weekly.usedPercent !== null) return { windows };
      } catch { /* agy CLI not available or unauthenticated. */ }
    }
    const accessToken = auth.access_token ?? auth.tokens?.access_token;
    if (!context.allowApi || typeof accessToken !== 'string' || !accessToken) return undefined;
    const value = await requestUsage(context, 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary', {
      method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': 'aiws-token-viewer' }, body: '{}',
    });
    return value ? { windows: normalize(value) } : undefined;
  },
  serialize: serializeFiveHourAndWeekly,
};

export class AntigravityProvider extends AIProvider {
  readonly id = 'agy' as const;
  readonly name = 'Antigravity';
  override readonly icon = '/icons/agy.svg';
  readonly executable = 'agy';
  override readonly reasoningEfforts = ['low', 'medium', 'high'];
  override readonly reasoningFlag = '--effort';
  override readonly reasoningInModelId = true;
  override readonly fallbackModels = ['gemini-4-argon-medium', 'gemini-4-argon-high', 'gemini-4-argon-low', 'gemini-3.8-flash-high', 'gemini-3.8-flash-medium', 'gemini-3.8-flash-low', 'claude-opus-5-5-high', 'claude-opus-5-5-medium', 'claude-opus-5-5-low', 'claude-sonnet-5-5-high', 'claude-sonnet-5-5-medium', 'claude-sonnet-5-5-low', 'gpt-oss-120b-medium'];
  protected override readonly modelFamilies = MODEL_FAMILIES;
  override readonly credentialEnv = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  override readonly homeEnv = 'AGY_HOME';
  override readonly apiHost = 'generativelanguage.googleapis.com';
  readonly args = {
    values: new Set(['--model', '--mode', '--effort', '--max-turns', '--system-prompt', '--append-system-prompt', '--allowed-tools', '--disallowed-tools', '--add-dir', '--mcp-config', '--agents', '--agent', '--settings']),
    reserved: new Set(['--resume', '-r', '--continue', '-c', '--fork-session', '--branch-session', '--cwd', '--worktree', '--print', '-p', '--prompt-interactive', '-i', '--output-format', '--input-format', '--help', '-h', '--version', '-v']),
    permission: new Set(['--dangerously-skip-permissions', '--mode', '--allowed-tools', '--disallowed-tools', '--mcp-config', '--settings']),
  };
  readonly autoMode = { args: ['--mode', 'auto', '--dangerously-skip-permissions'], overrides: ['--mode', '--dangerously-skip-permissions'], label: '--mode auto --dangerously-skip-permissions' };
  protected override readonly usage = usage;
  override readonly sessionConversation = true;

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string { return env.AGY_HOME ?? join(home, '.gemini'); }
  override async countSessions(home: string): Promise<number | null> {
    const conversation = (name: string): boolean => /\.(?:db|pb)$/i.test(name);
    const budget = { left: SESSION_CAP };
    return await countFiles(join(home, 'antigravity-cli', 'conversations'), conversation, 0, budget) + await countFiles(join(home, 'antigravity', 'conversations'), conversation, 0, budget);
  }

  async getModels(context: ModelContext): Promise<ModelListing> {
    // Lines are "<id>\t<display name>"; progress text has no tab.
    const output = await context.run(this.executable, ['models']);
    const models = output.split(/\r?\n/).map((line) => line.trim().split('\t')).filter(([id, name]) => id && name !== undefined && /^[\w.:-]+$/.test(id)).map(([id, name]) => ({ id: id!, ...(name?.trim() ? { name: name.trim() } : {}) }));
    return { models: uniqueModels(models), source: 'agy models' };
  }

  headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation {
    return { executable: 'agy', args: ['--output-format', 'stream-json', '--mode', readOnly ? 'plan' : 'auto', ...(readOnly ? [] : ['--dangerously-skip-permissions']), ...(task.model ? ['--model', task.model] : []), '--print', prompt], input: prompt };
  }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation {
    return { executable: 'agy', args: ['--mode', 'auto', '--dangerously-skip-permissions', ...(model ? ['--model', model] : []), '--prompt-interactive', nativePrompt], input: '' };
  }
  terminalResumeArgs(sessionId: string): string[] { return ['--conversation', sessionId]; }
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation {
    const args = ['--conversation', sessionId, '--mode', 'auto', '--dangerously-skip-permissions', ...this.trustedWorkspaceArgs(context)];
    return context.run.terminalMode === 'pty'
      ? { executable: 'agy', args: [...args, ...(message.length ? ['--prompt-interactive', message[0]!] : [])], input: '' }
      : { executable: 'agy', args: ['--output-format', 'stream-json', ...args, '--print', context.prompt], input: context.prompt };
  }
  override prepareSession(invocation: ProviderInvocation, context: LaunchContext): ProviderInvocation {
    if (context.run.historyResume) return invocation;
    return { ...invocation, args: this.mergeArgs(invocation.args, this.trustedWorkspaceArgs(context), context) };
  }
  /** Trusts the run's workspace for this session so Antigravity does not block on its folder-trust prompt in fresh task worktrees. */
  private trustedWorkspaceArgs(context: LaunchContext): string[] {
    const workspace = context.run.executionMode === 'docker' ? '/workspace' : context.project.repositoryPath;
    return ['--settings', JSON.stringify({ trustedWorkspaces: [workspace] })];
  }
  override mergeArgs(args: string[], extraArgs: string[], context: LaunchContext): string[] {
    const replaced = [
      ...(hasOption(this, extraArgs, ['--mode']) ? ['--mode'] : []),
      ...(hasOption(this, extraArgs, ['--dangerously-skip-permissions']) ? ['--dangerously-skip-permissions'] : []),
      ...(hasOption(this, extraArgs, ['--settings']) ? ['--settings'] : []),
    ];
    const base = withoutOptions(args, replaced, ['--dangerously-skip-permissions']);
    // The prompt stays last, after the prompt option.
    return base.at(-2) === '--print' || base.at(-2) === '--prompt-interactive' ? [...base.slice(0, -2), ...extraArgs, ...base.slice(-2)] : super.mergeArgs(base, extraArgs, context);
  }
  override readStreamEvent(message: Record<string, unknown>): StreamEventInfo {
    return {
      model: (message.init as { model?: unknown } | undefined)?.model ?? (message.result as { model?: unknown } | undefined)?.model ?? message.model,
      failed: (message.event === 'result' && (message.result as { status?: unknown } | undefined)?.status === 'ERROR') || message.event === 'error' || message.type === 'error',
    };
  }
  override async readSessionTranscript(run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, home?: string): Promise<string | undefined> {
    const conversation = await this.readSessionConversation(run, home);
    return conversation ? formatAgyTranscript(conversation.entries) || undefined : undefined;
  }
  override async readSessionConversation(run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, home?: string): Promise<SessionConversation | undefined> {
    const root = home ?? this.homeDirectory(process.env, homedir());
    const logsDir = await this.locateTranscriptDir(run, root);
    if (!logsDir) return undefined;
    const compactPath = join(logsDir, 'transcript.jsonl');
    if (!await isUnlinkedFile(compactPath, root)) return undefined;
    let rows: Record<string, unknown>[];
    try {
      const statInfo = await stat(compactPath);
      if (statInfo.size <= 0 || statInfo.size > MAX_TRANSCRIPT_BYTES) return undefined;
      rows = await readJsonWindow(compactPath, MAX_TRANSCRIPT_BYTES, 'head');
    } catch { return undefined; }
    const needsFull = rows.some((row) => (row.type === 'USER_INPUT' || row.type === 'CHECKPOINT' || row.type === 'PLANNER_RESPONSE') && Array.isArray(row.truncated_fields) && row.truncated_fields.length > 0);
    if (needsFull) {
      const fullPath = join(logsDir, 'transcript_full.jsonl');
      if (await isUnlinkedFile(fullPath, root)) {
        try {
          const fullStat = await stat(fullPath);
          if (fullStat.size > 0 && fullStat.size <= MAX_TRANSCRIPT_BYTES) {
            const fullRows: Record<string, unknown>[] = await readJsonWindow(fullPath, MAX_TRANSCRIPT_BYTES, 'head');
            const byStep = new Map<number, Record<string, unknown>>();
            for (const row of fullRows) if (typeof row.step_index === 'number') byStep.set(row.step_index, row);
            rows = rows.map((row, index) => (Array.isArray(row.truncated_fields) && row.truncated_fields.length > 0 ? (typeof row.step_index === 'number' ? byStep.get(row.step_index) : undefined) ?? fullRows[index] ?? row : row));
          }
        } catch { /* Fall back to compact transcript rows. */ }
      }
    }
    const entries = agyConversation(rows);
    return entries.length ? { sessionId: basename(dirname(dirname(logsDir))), entries } : undefined;
  }
  private async locateTranscriptDir(run: Pick<Run, 'id' | 'sessionId' | 'inputDirectory' | 'startedAt'>, root: string): Promise<string | undefined> {
    const brains = [join(root, 'antigravity-cli', 'brain'), join(root, 'antigravity', 'brain')];
    if (run.sessionId && this.sessionIdPattern.test(run.sessionId)) {
      for (const brain of brains) {
        const logsDir = join(brain, run.sessionId, '.system_generated', 'logs');
        const path = join(logsDir, 'transcript.jsonl');
        if (await isUnlinkedFile(path, root)) {
          try { if ((await stat(path)).size > 0) return logsDir; } catch { /* Missing file. */ }
        }
      }
    }
    if (!run.inputDirectory) return undefined;
    const promptPath = join(run.inputDirectory, 'prompt.md');
    const markers = [promptPath, promptPath.replace(/\\/g, '/'), run.id].filter(Boolean);
    const startedMs = Date.parse(run.startedAt) || 0;
    const candidates: Array<{ logsDir: string; path: string; mtimeMs: number }> = [];
    for (const brain of brains) {
      let entries;
      try { entries = await readdir(brain, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || !this.sessionIdPattern.test(entry.name)) continue;
        const logsDir = join(brain, entry.name, '.system_generated', 'logs');
        const path = join(logsDir, 'transcript.jsonl');
        try {
          const info = await stat(path);
          if (info.isFile() && info.size > 0 && (startedMs <= 0 || info.mtimeMs >= startedMs - 5_000)) candidates.push({ logsDir, path, mtimeMs: info.mtimeMs });
        } catch { /* Missing transcript file. */ }
      }
    }
    candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
    const matches: string[] = [];
    for (const candidate of candidates.slice(0, 32)) {
      if (!await isUnlinkedFile(candidate.path, root)) continue;
      try {
        const headRows = await readJsonWindow(candidate.path, 65_536, 'head');
        if (headRows.some((row: Record<string, unknown>) => row.type === 'USER_INPUT' && typeof row.content === 'string' && markers.some((marker) => (row.content as string).includes(marker)))) {
          matches.push(candidate.logsDir);
          if (matches.length > 1) return undefined;
        }
      } catch { /* Unreadable candidate. */ }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }
}
