import { ControlError, type DefaultProvider, type HistoryProvider } from '../types.js';
import { AntigravityProvider } from './agy.js';
import { ClaudeProvider } from './claude.js';
import { CodexProvider } from './codex.js';
import { CopilotProvider } from './copilot.js';
import { OpenCodeProvider } from './opencode.js';
import type { AIProviderInfo, IAIProvider } from './types.js';

/**
 * The single list of built-in AI providers. Listing, validation, launching, model lists, detection and quota
 * all read from here; adding a provider means implementing IAIProvider and registering it.
 */
export class AIProvidersService {
  private readonly providers = new Map<DefaultProvider, IAIProvider>();

  /** Adds a provider; registering the same ID again replaces it in place. */
  register<TAIProvider extends IAIProvider>(provider: TAIProvider | (new () => TAIProvider)): this {
    const instance = typeof provider === 'function' ? new provider() : provider;
    this.providers.set(instance.id, instance);
    return this;
  }

  /** Providers in registration order. */
  list(): IAIProvider[] { return [...this.providers.values()]; }
  ids(): DefaultProvider[] { return [...this.providers.keys()]; }
  has(id: unknown): id is DefaultProvider { return typeof id === 'string' && this.providers.has(id as DefaultProvider); }
  /** Providers whose local session history AIWS reads, imports and resumes. */
  isHistoryProvider(id: unknown): id is HistoryProvider { return this.has(id) && this.providers.get(id)!.history; }
  get(id: string): IAIProvider | undefined { return this.providers.get(id as DefaultProvider); }
  require(id: string): IAIProvider {
    const provider = this.get(id);
    if (!provider) throw new ControlError(`Unknown provider: ${id}.`, 404);
    return provider;
  }
  /** Names joined for messages: "Codex, Claude Code or GitHub Copilot". */
  names(conjunction = 'or', key: 'name' | 'id' = 'name'): string {
    const names = this.list().map((provider) => provider[key]);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}` : names.join('');
  }
  info(): AIProviderInfo[] { return this.list().map((provider) => provider.info()); }
}

export const aiProviders = new AIProvidersService()
  .register(CodexProvider)
  .register(ClaudeProvider)
  .register(OpenCodeProvider)
  .register(AntigravityProvider)
  .register(CopilotProvider);
