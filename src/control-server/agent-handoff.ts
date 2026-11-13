import { stripVTControlCharacters } from 'node:util';
import { usageTimestamp, type ProviderUsage } from './ai-providers/usage.js';
import { gitAsync } from './git.js';
import { hostTimezone, validateTimezone, wall, zonedTime } from './schedules.js';
import { ControlError, type AgentHandoffMode, type TaskMessage } from './types.js';

/** The instruction sent to the CLI once its usage quota resets so it continues where it left off. */
export const USAGE_LIMIT_CONTINUE_MESSAGE = 'Continue from where you left off: check what was already done (git status, git diff), finish the remaining work without repeating completed steps, verify the result, and follow the AIWS instructions for this run.';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Messages providers print when an account's usage or token quota is used up (not a transient rate limit). */
const USAGE_LIMIT_PATTERNS = [
  /\bindividual quota reached\b/i,
  /\busage limit (?:reached|exceeded|hit)\b/i,
  /\byou(?:'|’)ve (?:hit|reached) your (?:usage |session |weekly |daily |monthly )?limit\b/i,
  /\b(?:5-hour|five-hour|weekly|session|daily|opus|sonnet) (?:usage )?limit reached\b/i,
  /\busage_limit_reached\b|\binsufficient_quota\b|\bRESOURCE_EXHAUSTED\b/,
  /\bquota (?:exceeded|exhausted)\b|\bexceeded your (?:current |daily |weekly |monthly )?quota\b|\bquota_exceeded\b|\bexhausted your (?:daily )?(?:capacity|quota)\b/i,
  /\bout of (?:extra )?usage\b|\bcredit balance is too low\b/i,
];

/** The provider line reporting that its usage limit was reached, if the text contains one. */
export function usageLimitReason(text: string): string | undefined {
  for (const line of stripVTControlCharacters(text).split(/\r?\n/)) {
    if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(line))) return line.replace(/[│┃|╭╮╰╯─]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  return undefined;
}

/** When the provider's usage limit resets (epoch ms), parsed from the CLI's limit notice if it states a time or duration. */
export function usageLimitResetAt(text: string, current = Date.now()): number | undefined {
  for (const raw of stripVTControlCharacters(text).split(/\r?\n/)) {
    if (!USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(raw))) continue;
    const pipe = /\|(\d{10,13})\b/.exec(raw);
    if (pipe) { const ts = usageTimestamp(Number(pipe[1])); if (ts !== null) return ts; }
    const jsonReset = /"(?:resets?_at|retry_after_at)"\s*:\s*(?:"([^"]+)"|(\d{10,13})\b)/i.exec(raw);
    if (jsonReset) { const ts = usageTimestamp(jsonReset[1] ?? Number(jsonReset[2])); if (ts !== null) return ts; }
    const jsonAfter = /"(?:reset_after_seconds|retry_after|reset_seconds)"\s*:\s*(\d+(?:\.\d+)?)/i.exec(raw);
    if (jsonAfter) { const seconds = Number(jsonAfter[1]); if (seconds > 0) return current + Math.ceil(seconds * 1000); }
    const clean = raw.replace(/[│┃|╭╮╰╯─]+/g, ' ').replace(/\s+/g, ' ').trim();
    const iso = /\b(?:resets?(?:_at)?|try again|available|until)\s+(?:at\s+)?(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i.exec(clean);
    if (iso) { const ts = usageTimestamp(iso[1]); if (ts !== null) return ts; }
    const relative = /\b(?:try again|resets?|available|retry)\s+in\s+((?:\d+\s*(?:d(?:ays?)?|h(?:(?:ou)?rs?)?|m(?:in(?:ute)?s?)?|s(?:ec(?:ond)?s?)?)(?:[\s,]+(?:and\s+)?)?)+)/i.exec(clean);
    if (relative) {
      let duration = 0;
      for (const part of relative[1]!.matchAll(/(\d+)\s*(d|h|m|s)/gi)) {
        const amount = Number(part[1]), unit = part[2]!.toLowerCase();
        duration += amount * (unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000);
      }
      if (duration > 0) return current + duration;
    }
    const clock = /\b(?:resets?|try again|available)\s+(?:on\s+)?(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(?:at\s+)?|\s+at\s+|\s+))?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)\))?/i.exec(clean);
    if (clock && (clock[4] !== undefined || clock[5] !== undefined)) {
      let hour = Number(clock[3]); const minute = Number(clock[4] ?? 0), meridiem = clock[5]?.toLowerCase();
      if (minute < 0 || minute > 59 || (meridiem ? hour < 1 || hour > 12 : hour < 0 || hour > 23)) continue;
      if (meridiem) hour = meridiem === 'pm' ? (hour % 12) + 12 : hour % 12;
      let tz = hostTimezone();
      if (clock[6]) try { tz = validateTimezone(clock[6]); } catch { /* Keep host time zone when unknown. */ }
      const nowWall = wall(current, tz);
      if (clock[1] && clock[2]) {
        const month = MONTHS.indexOf(clock[1].slice(0, 3).toLowerCase()) + 1, day = Number(clock[2]);
        let candidate = zonedTime(nowWall.year, month, day, hour, minute, tz);
        if (candidate <= current) candidate = zonedTime(nowWall.year + 1, month, day, hour, minute, tz);
        return candidate;
      }
      let candidate = zonedTime(nowWall.year, nowWall.month, nowWall.day, hour, minute, tz);
      if (candidate <= current) candidate = zonedTime(nowWall.year, nowWall.month, nowWall.day + 1, hour, minute, tz);
      return candidate;
    }
  }
  return undefined;
}

/** When the provider's quota resets according to its usage windows (`TokenUsageMonitor`). */
export function providerUsageResetAt(provider: string, account: string | undefined, reason: string | undefined, usage: readonly ProviderUsage[], current = Date.now()): number | undefined {
  const card = (account ? usage.find((item) => item.key === `${provider}@${account}`) : undefined) ?? usage.find((item) => item.key === provider);
  if (!card) return undefined;
  const windows = [card.short, card.weekly, ...(card.buckets ?? []).map((bucket) => bucket.window)];
  const exhausted = windows.filter((window) => window.usedPercent !== null && window.usedPercent >= 100)
    .map((window) => usageTimestamp(window.resetsAt)).filter((time): time is number => time !== null && time > current);
  if (exhausted.length) return Math.max(...exhausted);
  if (reason && /\b(?:weekly|7-day|seven-day)\b/i.test(reason)) {
    const weekly = usageTimestamp(card.weekly.resetsAt);
    if (weekly !== null && weekly > current) return weekly;
  }
  if (reason && /\b(?:5-hour|five-hour|session)\b/i.test(reason)) {
    const short = usageTimestamp(card.short.resetsAt);
    if (short !== null && short > current) return short;
  }
  const candidates = [...windows.map((window) => usageTimestamp(window.resetsAt)), usageTimestamp(card.retryAt)]
    .filter((time): time is number => time !== null && time > current);
  return candidates.length ? Math.min(...candidates) : undefined;
}

export function validateHandoffMode(value: unknown, field = 'agentHandoffMode'): AgentHandoffMode {
  if (value !== 'fresh' && value !== 'transcript') throw new ControlError(`${field} must be fresh or transcript.`);
  return value;
}

const limited = (value: string, characters: number): string => value.length > characters ? `${value.slice(0, characters)}\n… (truncated)` : value;

export interface HandoffBriefInput {
  previousAgent: string; previousProvider: string; previousRunId: string; reason?: string;
  workspacePath: string; mainBranch?: string; messages: TaskMessage[];
}
/**
 * Context for a clean agent continuing someone else's work: who worked before, where,
 * what it last said and the Git state it left, so it reviews the changes instead of starting over.
 */
export async function handoffBrief(input: HandoffBriefInput): Promise<string> {
  // Read-only queries off the event loop; a failing one (no repository, unknown ref) reads as empty.
  const query = (args: string[]): Promise<string> => gitAsync(input.workspacePath, args, 5000).catch(() => '');
  const [branch, mainExists, statusText] = await Promise.all([query(['rev-parse', '--abbrev-ref', 'HEAD']), input.mainBranch ? query(['rev-parse', '--verify', '--quiet', input.mainBranch]) : '', query(['status', '--short'])]);
  const base = input.mainBranch && input.mainBranch !== branch && mainExists ? input.mainBranch : '';
  const status = limited(statusText, 4000);
  const [commitsText, diffText] = base ? await Promise.all([query(['log', '--oneline', '--no-decorate', '-n', '30', `${base}..HEAD`]), query(['diff', '--stat', `${base}...HEAD`])]) : ['', ''];
  const commits = limited(commitsText, 3000), diffStat = limited(diffText, 3000);
  const agentMessages = input.messages.filter((message) => message.authorType === 'agent' && message.text.trim()).slice(-6);
  const notes = limited(agentMessages.map((message) => message.text.trim()).join('\n\n---\n\n'), 8000);
  const range = base ? `${base}...HEAD` : 'HEAD';
  return [
    `AGENT HANDOFF: Another agent (${input.previousAgent}, provider ${input.previousProvider}) already worked on this task in run ${input.previousRunId} and stopped${input.reason ? ` (${input.reason})` : ''}. You are a new, clean agent continuing the same task in the same workspace${branch && branch !== 'HEAD' ? ` on branch ${branch}` : ''}: ${input.workspacePath}. Its conversation is not included.`,
    `Before changing anything, inspect what was already done: run git status, git diff, ${base ? `git log ${base}..HEAD and git diff ${range}` : 'git log'}. Then complete what is missing for the task, verify the result, and do not redo or revert finished work unless it is wrong.`,
    status ? `Uncommitted changes at handoff (git status --short):\n${status}` : 'No uncommitted changes at handoff.',
    commits ? `Commits on this branch since ${base}:\n${commits}` : '',
    diffStat ? `Changed files since ${base} (git diff --stat):\n${diffStat}` : '',
    notes ? `Last messages of the previous agent (reference only; its run IDs and control commands are obsolete):\n<previous-agent-notes>\n${notes}\n</previous-agent-notes>` : '',
  ].filter(Boolean).join('\n\n');
}

/** Introduces the copied conversation of the previous agent for a handoff in transcript mode. */
export function handoffTranscript(previousAgent: string, previousProvider: string, reason: string | undefined, history: string): string {
  const body = history.replace(/^Previous conversation\.[^\n]*\n/, '');
  return `AGENT HANDOFF: Another agent (${previousAgent}, provider ${previousProvider}) worked on this task and stopped${reason ? ` (${reason})` : ''}. Its whole conversation is copied below. Continue the task from where it left off in the same workspace and branch; check git status and git diff first, do not repeat finished work. Old run IDs and completion commands in the transcript are obsolete; use only the current AIWS run's commands.\n<previous-conversation>\n${body}\n</previous-conversation>`;
}
