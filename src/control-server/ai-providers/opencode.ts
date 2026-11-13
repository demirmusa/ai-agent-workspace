import { join } from 'node:path';
import type { Task } from '../types.js';
import { AIProvider } from './base.js';
import { MODEL_FAMILIES } from './model-profiles.js';
import { uniqueModels } from './support.js';
import type { LaunchContext, ModelContext, ModelListing, ProviderInvocation, StreamEventInfo } from './types.js';

/** OpenCode has no auto-mode flag; its permissions come from the environment. */
export const OPENCODE_AUTO_PERMISSION = '{"*":"allow","question":"deny"}';
const READ_ONLY_PERMISSION = '{"*":"deny","read":"allow","list":"allow","glob":"allow","grep":"allow"}';

export class OpenCodeProvider extends AIProvider {
  readonly id = 'opencode' as const;
  readonly name = 'OpenCode';
  readonly executable = 'opencode';
  override readonly reasoningEfforts = ['minimal', 'low', 'medium', 'high', 'max'];
  override readonly reasoningFlag = '--variant';
  // Sources: opencode.ai/docs/models (OpenCode IDs include the upstream provider).
  override readonly fallbackModels = ['openai/gpt-5', 'anthropic/claude-sonnet-4-5-20250929'];
  protected override readonly modelFamilies = MODEL_FAMILIES;
  override readonly credentialEnv = ['OPENCODE_API_KEY'];
  override readonly nativeTerminal = false;
  readonly args = {
    values: new Set(['-m', '--model', '--agent', '--variant', '--port', '--hostname', '--title', '-f', '--file', '--log-level']),
    reserved: new Set(['--session', '-s', '--continue', '-c', '--fork', '--dir', '--cwd', '--attach', '--format', '--prompt', '--help', '-h', '--version', '-v']),
    permission: new Set<string>(),
  };
  readonly autoMode = { args: [], overrides: [], label: 'OPENCODE_PERMISSION={"*":"allow"}' };

  homeDirectory(env: NodeJS.ProcessEnv, home: string): string { return join(env.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'opencode'); }
  // Sessions live in a database; reading it is not cheap enough for detection.

  async getModels(context: ModelContext): Promise<ModelListing> {
    const output = await context.run(this.executable, ['models']);
    return { models: uniqueModels(output.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^[\w.@-]+\/\S+$/.test(line)).map((id) => ({ id }))), source: 'opencode models' };
  }

  headlessInvocation(task: Task, prompt: string): ProviderInvocation {
    return { executable: 'opencode', args: ['run', '--format', 'json', ...(task.model ? ['--model', task.model] : [])], input: prompt };
  }
  terminalInvocation(model: string | undefined, nativePrompt: string): ProviderInvocation {
    return { executable: 'opencode', args: ['--prompt', nativePrompt, ...(model ? ['--model', model] : [])], input: '' };
  }
  terminalResumeArgs(sessionId: string): string[] { return ['--session', sessionId]; }
  resumeInvocation(sessionId: string, message: string[], context: LaunchContext): ProviderInvocation {
    return context.run.terminalMode === 'pty'
      ? { executable: 'opencode', args: ['--session', sessionId, ...(message.length ? ['--prompt', message[0]!] : [])], input: '' }
      : { executable: 'opencode', args: ['run', '--format', 'json', '--session', sessionId], input: context.prompt };
  }
  override runEnv(readOnly: boolean): Record<string, string> { return { OPENCODE_PERMISSION: readOnly ? READ_ONLY_PERMISSION : OPENCODE_AUTO_PERMISSION, OPENCODE_AUTO_SHARE: 'false' }; }
  override terminalEnv(autoMode: boolean): Record<string, string> { return autoMode ? { OPENCODE_PERMISSION: OPENCODE_AUTO_PERMISSION } : {}; }
  override readStreamEvent(message: Record<string, unknown>): StreamEventInfo {
    return { ...(typeof message.sessionID === 'string' ? { sessionId: message.sessionID } : {}), failed: message.type === 'error' };
  }
}
