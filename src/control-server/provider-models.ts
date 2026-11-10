import { homedir } from 'node:os';
import { findExecutable } from '../shared/core/command.js';
import { aiProviders, describeModel } from './ai-providers/index.js';
import { execCli } from './windows-launch.js';
import { ControlError, type DefaultProvider, type ProviderModelCatalog } from './types.js';

export interface ProviderModelOptions {
  home?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; now?: () => Date;
  /** Replaces running `<provider> models` for tests. */
  run?: (executable: string, args: string[]) => Promise<string>;
  request?: typeof fetch;
}

async function runCli(path: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  const running = execCli(path, args, { env, timeout, maxBuffer: 4 * 1024 * 1024 });
  if (!running) throw new ControlError('The provider executable path cannot be run safely.');
  const { error, stdout, stderr } = await running;
  if (error) throw new ControlError(`${args.join(' ')} failed: ${(stderr.trim() || error.message).split('\n')[0]}`, 502);
  return stdout;
}

/** Reads the models a provider currently offers; each provider knows where its own list comes from and which families it knows. */
export class ProviderModels {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly request: typeof fetch;
  private readonly run: (executable: string, args: string[]) => Promise<string>;

  constructor(options: ProviderModelOptions = {}) {
    this.home = options.home ?? homedir(); this.env = options.env ?? process.env; this.timeoutMs = options.timeoutMs ?? 60_000;
    this.now = options.now ?? (() => new Date()); this.request = options.request ?? fetch;
    this.run = options.run ?? (async (executable, args) => {
      const path = await findExecutable(executable, this.env);
      if (!path) throw new ControlError(`${executable} was not found on PATH.`, 404);
      return runCli(path, args, this.env, this.timeoutMs);
    });
  }

  async list(provider: DefaultProvider): Promise<ProviderModelCatalog> {
    const registered = aiProviders.require(provider);
    const { models, source } = await registered.getModels({ home: this.home, env: this.env, request: this.request, run: this.run });
    if (!models.length) throw new ControlError(`${source} did not list any models.`, 502);
    return { models: models.map((model) => describeModel(registered, model)), refreshedAt: this.now().toISOString(), source };
  }
}
