import { redactSecrets } from '../../shared/core/redact.js';
import { aiProviders } from '../ai-providers/index.js';
import type { ControlStore } from '../store.js';
import type { ControlEvent, Run, TaskMessage } from '../types.js';
import { newId, now } from './common.js';

const MAX_EVENTS = 20_000, MAX_EVENT_BYTES = 8_000_000, MAX_MESSAGES = 10_000;
const GITHUB_TOKEN_ENV = ['AIWS_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];

/**
 * Writes the event journal and task conversations. Every entry is redacted of the
 * control token and the credentials in the environment, and both logs stay bounded.
 */
export class Journal {
  private source: ControlEvent[] | undefined;
  private bytes = 0;
  constructor(private readonly store: ControlStore, private readonly token: () => string | undefined) {}

  /** Secret values that must never reach the journal, a conversation or GitHub. */
  private secrets(): string[] {
    return [this.token(), ...GITHUB_TOKEN_ENV.map((name) => process.env[name]), ...aiProviders.list().flatMap((provider) => provider.credentialEnv.map((name) => process.env[name]))]
      .filter((secret): secret is string => Boolean(secret && secret.length >= 8));
  }
  redact<T>(value: T): T {
    const secrets = this.secrets();
    // Output lines are journaled often; most contain no secret at all.
    if (!secrets.length || (typeof value === 'string' && !secrets.some((secret) => value.includes(secret)))) return value;
    return redactSecrets(value, { secrets, replacement: '[redacted]', sensitiveKeyPattern: /$^/ });
  }
  event(runId: string | null, taskId: string | null, type: string, message: string, data?: unknown): ControlEvent {
    const events = this.store.state.events;
    if (this.source !== events) { this.source = events; this.bytes = events.reduce((sum, entry) => sum + entry.message.length, 0); }
    const entry: ControlEvent = { id: newId('event'), runId, taskId, type, message: this.redact(message).slice(0, 16_000), ...(data === undefined ? {} : { data: this.redact(data) }), createdAt: now() };
    events.push(entry); this.bytes += entry.message.length;
    // Keep the event journal bounded by both count and text size, even for noisy tools.
    let remove = 0;
    while (remove < events.length - 1 && (this.bytes > MAX_EVENT_BYTES || events.length - remove > MAX_EVENTS)) this.bytes -= events[remove++]!.message.length;
    if (remove) events.splice(0, remove);
    return entry;
  }
  message(taskId: string, authorType: TaskMessage['authorType'], text: string, run?: Run): TaskMessage {
    const agent = run?.executionSnapshot?.agent;
    const value: TaskMessage = { id: newId('message'), taskId, runId: run?.id ?? null, agentId: agent?.id ?? null, authorType, authorName: authorType === 'user' ? 'You' : authorType === 'system' ? 'System' : agent?.name ?? run?.provider ?? 'Agent', text: this.redact(text).slice(0, 30000), createdAt: now() };
    const messages = this.store.state.messages;
    messages.push(value); if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    return value;
  }
}
