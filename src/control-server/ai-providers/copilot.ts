import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Task } from '../types.js';
import { AIProvider } from './base.js';
import { MODEL_FAMILIES } from './model-profiles.js';
import { countFiles, DIRECT_PROMPT_LIMIT, hasOption, uniqueModels } from './support.js';
import type { LaunchContext, ModelContext, ModelListing, ProviderInvocation, StreamEventInfo } from './types.js';
import { requestUsage, savedBuckets, usageWindow, type RecordData, type UsageBucket, type UsageSource, type UsageWindows } from './usage.js';

/** Copilot quotas reset monthly. */
const MONTH_MINUTES = 30 * 24 * 60;
const QUOTA_LABELS: Record<string, string> = { premium_interactions: 'Premium requests', chat: 'Chat', completions: 'Code completions' };
const TOKEN_ENV = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/** Quota snapshots of the GitHub Copilot user endpoint, or the shape saved in the shared cache. */
function normalize(value: RecordData): UsageWindows {
  let buckets: UsageBucket[];
  if (value.quota_snapshots && typeof value.quota_snapshots === 'object') {
    const reset = value.quota_reset_date_utc ?? value.quota_reset_date ?? null;
    buckets = Object.entries(value.quota_snapshots as RecordData)
      .filter(([, quota]) => quota && typeof quota === 'object' && !quota.unlimited && typeof quota.percent_remaining === 'number')
      .map(([id, quota]) => ({ id, label: QUOTA_LABELS[id] ?? id, window: usageWindow(100 - quota.percent_remaining, reset, MONTH_MINUTES) }));
  } else {
    buckets = savedBuckets(value, MONTH_MINUTES);
  }
  const monthly = buckets.find((bucket) => bucket.id === 'premium_interactions') ?? buckets[0];
  return { short: usageWindow(null, null, 300), weekly: monthly ? monthly.window : usageWindow(null, null, MONTH_MINUTES), ...(buckets.length ? { buckets } : {}) };
}

const usage: UsageSource = {
  name: 'GitHub Copilot', defaultAccount: 'GitHub Copilot',
  async auth(context) {
    const name = TOKEN_ENV.find((key) => context.env[key]);
    if (name) return { token: context.env[name] };
    if (!context.allowApi) return {};
    const token = await context.githubToken?.();
    return token ? { token } : {};
  },
  // Copilot writes no usage file; the quota comes only from GitHub.
  async local() { return { value: {}, timestamp: null }; },
  normalize,
  async remote(context, auth) {
    if (typeof auth.token !== 'string' || !auth.token) return undefined;
    const value = await requestUsage(context, 'https://api.github.com/copilot_internal/user', { headers: { Authorization: `token ${auth.token}`, Accept: 'application/json', 'User-Agent': 'aiws-token-viewer' } });
    return value ? { windows: normalize(value), ...(typeof value.login === 'string' ? { account: value.login } : {}) } : undefined;
  },
  serialize: (windows) => ({ ...(windows.buckets ? { buckets: windows.buckets } : {}) }),
};

export class CopilotProvider extends AIProvider {
  readonly id = 'copilot' as const;
  readonly name = 'GitHub Copilot';
  override readonly icon = '/icons/copilot.svg';
  readonly executable = 'copilot';
  override readonly reasoningEfforts = ['low', 'medium', 'high', 'xhigh'];
  override readonly reasoningFlag = '--reasoning-effort';
  override readonly fallbackModels = ['auto', 'claude-sonnet-5.5', 'claude-opus-5.5', 'claude-haiku-5.5', 'gpt-6.1-sol', 'gpt-5.5', 'gemini-4-argon'];
  protected override readonly modelFamilies = MODEL_FAMILIES;
  override readonly credentialEnv = ['COPILOT_GITHUB_TOKEN'];
  override readonly homeEnv = 'COPILOT_HOME';
  override readonly apiHost = 'api.githubcopilot.com';
  override readonly assignsSessionId = true;
  readonly args = {
    values: new Set(['--model', '--reasoning-effort', '--agent', '--mode', '--context', '--auto-tier', '--add-dir', '--allow-tool', '--deny-tool', '--available-tools', '--excluded-tools', '--allow-url', '--deny-url', '--additional-mcp-config', '--disable-mcp-server', '--enable-mcp-server', '--plugin-dir', '--max-autopilot-continues', '--max-ai-credits', '--log-level']),
    reserved: new Set(['--resume', '-r', '--continue', '--session-id', '--connect', '-n', '--name', '-C', '--prompt', '-p', '--interactive', '-i', '--output-format', '--share', '--share-gist', '--acp', '--remote', '--help', '-h', '--version', '-v']),
    permission: new Set(['--allow-all', '--allow-all-tools', '--allow-all-paths', '--allow-all-urls', '--yolo', '--allow-tool', '--deny-tool', '--allow-url', '--deny-url', '--autopilot', '--plan', '--mode', '--additional-mcp-config', '--plugin-dir']),
  };
  readonly autoMode = { args: ['--allow-all'], overrides: ['--allow-all-tools', '--allow-all', '--yolo'], label: '--allow-all' };
  protected override readonly usage = usage;

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string { return env.COPILOT_HOME ?? join(home, '.copilot'); }
  override countSessions(home: string): Promise<number | null> { return countFiles(join(home, 'session-state'), (name) => name === 'events.jsonl', 1); }

  async getModels(context: ModelContext): Promise<ModelListing> {
    // The CLI documents its selectable model IDs as a quoted bullet list under the `model` setting.
    const output = await context.run(this.executable, ['help', 'config']);
    const section = output.split(/\r?\n/).reduce<{ active: boolean; ids: string[] }>((state, line) => {
      if (/^\s*`model`:/.test(line)) return { active: true, ids: state.ids };
      if (/^\s*`\w[^`]*`:/.test(line)) return { active: false, ids: state.ids };
      const id = state.active ? /^\s*-\s*"([\w.:-]+)"\s*$/.exec(line)?.[1] : undefined;
      return id ? { active: state.active, ids: [...state.ids, id] } : state;
    }, { active: false, ids: [] });
    return { models: uniqueModels(section.ids.map((id) => ({ id }))), source: 'copilot help config' };
  }

  // Prompt mode requires --allow-all-tools; deny rules override it, and reading needs no approval. The built-in
  // GitHub MCP server is disabled for read-only work so the agent cannot change issues or pull requests.
  headlessInvocation(task: Task, prompt: string, readOnly: boolean): ProviderInvocation {
    return { executable: 'copilot', args: ['--output-format', 'json', ...(readOnly ? ['--allow-all-tools', '--deny-tool=shell', '--deny-tool=write', '--disable-builtin-mcps'] : ['--allow-all']), ...(task.model ? ['--model', task.model] : []), '-p', prompt], input: '' };
  }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation {
    return { executable: 'copilot', args: ['--allow-all', ...(model ? ['--model', model] : []), '-i', nativePrompt], input: '' };
  }
  terminalResumeArgs(sessionId: string): string[] { return ['--resume', sessionId]; }
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation {
    const args = ['--resume', sessionId, '--allow-all'];
    return context.run.terminalMode === 'pty'
      ? { executable: 'copilot', args: [...args, ...(message.length ? ['-i', message[0]!] : [])], input: '' }
      : { executable: 'copilot', args: ['--output-format', 'json', ...args, '-p', context.prompt], input: '' };
  }
  override prepareSession(invocation: ProviderInvocation, context: LaunchContext): ProviderInvocation {
    const { run } = context;
    if (run.historyResume) return invocation;
    let args = [...invocation.args];
    // The prompt is an argument; a long one would exceed the Windows command line, so it reads prompt.md.
    const promptFile = run.inputDirectory && join(run.inputDirectory, 'prompt.md');
    if (run.terminalMode !== 'pty' && context.prompt.length > DIRECT_PROMPT_LIMIT && promptFile && existsSync(promptFile)) args[args.length - 1] = `Read and follow the task instructions in ${run.executionMode === 'docker' ? '/run/aiws/input/prompt.md' : promptFile}. Perform the work in the current project.`;
    // Like Claude, a fresh session gets its ID up front.
    if (run.sessionId && !context.readOnly) args = [...args.slice(0, -2), '--session-id', run.sessionId, ...args.slice(-2)];
    return { ...invocation, args };
  }
  override mergeArgs(args: string[], extraArgs: string[], context: LaunchContext): string[] {
    // A configured permission choice replaces the default --allow-all; read-only denials always stay.
    const base = !context.readOnly && hasOption(this, extraArgs, ['--allow-all', '--allow-all-tools', '--yolo', '--allow-tool', '--deny-tool', '--allow-url', '--deny-url', '--allow-all-paths', '--allow-all-urls']) ? args.filter((argument) => argument !== '--allow-all') : args;
    return base.at(-2) === '-p' || base.at(-2) === '-i' ? [...base.slice(0, -2), ...extraArgs, ...base.slice(-2)] : super.mergeArgs(base, extraArgs, context);
  }
  override readStreamEvent(message: Record<string, unknown>): StreamEventInfo {
    const data = message.data as { model?: unknown; message?: unknown; content?: unknown; parentToolCallId?: unknown } | undefined;
    return {
      ...(message.type === 'session.tools_updated' ? { model: data?.model } : {}),
      ...(message.type === 'result' && typeof message.sessionId === 'string' ? { sessionId: message.sessionId } : {}),
      failed: message.type === 'session.error' || (message.type === 'result' && typeof message.exitCode === 'number' && message.exitCode !== 0),
      ...(typeof data?.message === 'string' ? { errorDetail: data.message } : {}),
      // The main agent's messages only; a subagent's carry the tool call that started it.
      ...(message.type === 'assistant.message' && typeof data?.content === 'string' && !data.parentToolCallId ? { text: data.content } : {}),
    };
  }
}
