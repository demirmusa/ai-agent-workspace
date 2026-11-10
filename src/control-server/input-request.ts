import type { TerminalPrompt } from './types.js';
import { renderTerminalScreen } from './terminal-screen.js';

const approvalPattern = /(?:would you like to (?:run|proceed)|do you (?:want to|trust)|one you trust|allow (?:this|once)|requires? (?:your )?approval|izin ver|onaylıyor musun)/i;
const choicePattern = /(?:\[y\/n\]|\(y\/n\)|yes,? (?:proceed|allow)|1[.)]\s*(?:yes|allow)|enter to confirm)/i;
const questionPattern = /(?:waiting for (?:your (?:answer|response|input)|user input)|(?:press )?enter to (?:submit|answer)|enter to select[^\n]*esc to cancel)/i;
const optionPattern = /^\s*([❯›>▶]\s*)?(\d{1,2})[.)]\s+(.+)$/;
// A cursor row of a menu whose choices carry no numbers, such as Claude Code's folder trust dialog.
const cursorPattern = /^\s*[❯›▶]\s*\S/;
// A menu's own footer: with a cursor on one of its choices this is a dialog whatever it asks.
const menuFooterPattern = /(?:enter (?:to )?(?:continue|confirm|select)|esc (?:to )?skip)/i;
const footerPattern = /(?:esc (?:to )?(?:cancel|interrupt|exit|skip)|enter (?:to )?(?:confirm|select|submit|continue)|tab to amend|to navigate|press enter)/i;
const rulePattern = /^\s*[─━═]{8,}\s*$/;
// Dashed rules and rounded corners frame a command box inside the dialog.
const boxEdgePattern = /^\s*(?:[╭╰┌└]|[╌┄┈╍┅-]{8,}\s*$)/;
const boxLinePattern = /^\s*[│┃]\s?(.*?)\s*[│┃]?\s*$/;
// Earlier transcript entries (tool calls, assistant text) start with a bullet; a dialog never reaches past one.
const transcriptPattern = /^\s*[●⏺•✻✶✳✢·]\s/;

/** Conservative native CLI prompt recognition. Ordinary questions in logs are not requests. */
export function detectInputRequest(output: string | string[], size: { cols?: number; rows?: number } = {}): { text: string; kind: 'question' | 'approval'; prompt?: TerminalPrompt } | null {
  const screen = Array.isArray(output) ? output : renderTerminalScreen(output, size.rows, size.cols);
  // A TUI shows its own input box only when no dialog is open; dialog wording above it is text the agent printed or a tool preview.
  if (inputBoxVisible(screen)) return null;
  // Transcript lines (bullets, echoed prompts) may quote dialog wording; they are never the dialog itself.
  const tail = screen.map(line => line.trim()).filter(line => line && !transcriptPattern.test(line) && !/^[❯›]\s*\S/.test(line) || optionPattern.test(line)).slice(-18).join('\n');
  const named = approvalPattern.test(tail) && choicePattern.test(tail) ? 'approval' : questionPattern.test(tail) ? 'question' : null;
  if (!named && !menuFooterPattern.test(tail)) return null;
  const prompt = parseTerminalPrompt(screen, size.cols);
  const kind = named ?? (prompt && prompt.options.length > 1 && prompt.options.some((option) => option.selected) ? 'question' : null);
  if (!kind) return null;
  return prompt ? { text: promptMarkdown(prompt).slice(0, 6000), kind, prompt } : { text: tail.slice(-6000), kind };
}

/** The agent's input box near the bottom of the screen: a prompt row framed by a solid rule on both sides, as Claude Code draws it. */
function inputBoxVisible(screen: string[]): boolean {
  const rows = screen.filter((line) => line.trim()).slice(-10);
  return rows.some((line, index) => /^\s*[❯›>]/.test(line) && !optionPattern.test(line) && rulePattern.test(rows[index - 1] ?? '') && rulePattern.test(rows[index + 1] ?? ''));
}

type Block = { kind: 'text' | 'command'; lines: string[]; lengths: number[] };

/** Splits a rendered native dialog into its question, context, command and choices. */
export function parseTerminalPrompt(screen: string[], cols?: number): TerminalPrompt | null {
  const nonEmpty = screen.map((line, index) => line.trim() ? index : -1).filter(index => index >= 0).slice(-18);
  const last = [...nonEmpty].reverse().find(index => optionPattern.test(screen[index]!));
  const options: Array<TerminalPrompt['options'][number] & { rows: string[]; lengths: number[] }> = [];
  let first: number, end: number;
  if (last === undefined) {
    const menu = cursorMenu(screen, nonEmpty); if (!menu) return null;
    first = menu[0]!; end = menu.at(-1)!;
    for (const index of menu) options.push({ label: '', selected: cursorPattern.test(screen[index]!), rows: [screen[index]!.replace(/^\s*[❯›▶]\s*/, '').trim()], lengths: [screen[index]!.length] });
  } else {
    first = last;
    for (let index = last; index >= Math.max(0, last - 40); index--) {
      const match = optionPattern.exec(screen[index]!);
      if (match?.[2] === '1') { first = index; break; }
    }
    // Wrapped option labels continue on indented lines below their number.
    end = last;
    while (end + 1 < screen.length && /^\s{3,}\S/.test(screen[end + 1]!) && !optionPattern.test(screen[end + 1]!) && !footerPattern.test(screen[end + 1]!)) end++;
    for (let index = first; index <= end; index++) {
      const line = screen[index]!, match = optionPattern.exec(line);
      if (match) options.push({ label: '', selected: Boolean(match[1]), rows: [match[3]!.trim()], lengths: [line.length] });
      else if (line.trim() && options.length && !footerPattern.test(line)) { options.at(-1)!.rows.push(line.trim()); options.at(-1)!.lengths.push(line.length); }
    }
  }
  let question = -1;
  for (let index = first - 1; index >= Math.max(0, first - 40); index--) {
    const line = screen[index]!.trim();
    if (!line) continue;
    if (approvalPattern.test(line) || line.endsWith('?')) { question = index; break; }
    if (rulePattern.test(line) || transcriptPattern.test(line)) break;
  }
  // The dialog opens below a solid rule; without one only the question and what follows it are trusted.
  let start = question >= 0 ? question : first;
  for (let index = start - 1; index >= Math.max(0, start - 40) && !transcriptPattern.test(screen[index]!); index--) {
    if (rulePattern.test(screen[index]!)) { start = index; break; }
  }
  // Without the PTY width the widest dialog line (rules span the terminal) stands in for it.
  const width = cols ?? Math.max(...screen.slice(start, end + 1).map(line => line.length));
  // A question long enough to wrap continues on the rows below it, up to the next blank row.
  let questionEnd = question;
  while (question >= 0 && questionEnd + 1 < first && screen[questionEnd]!.length >= width * 0.6 && screen[questionEnd + 1]!.trim() && !rulePattern.test(screen[questionEnd + 1]!)) questionEnd++;
  const region = [...screen.slice(start, question >= 0 ? question : first), ...(question >= 0 ? screen.slice(questionEnd + 1, first) : [])];
  const blocks = toBlocks(region, width);
  // The first box holds the command; a later one (a warning quoted under it) reads as context.
  const commandBlock = blocks.find(block => block.kind === 'command'), texts = blocks.filter(block => block !== commandBlock);
  // A short unpunctuated first line under the dialog's rule names the request, e.g. "Bash command".
  const heading = blocks[0]?.kind === 'text' && rulePattern.test(screen[start] ?? '') ? blocks[0].lines[0] : undefined;
  const title = heading && heading.length <= 60 && !/[.!?:]$/.test(heading) ? heading : undefined;
  if (title) blocks[0]!.lines.shift();
  const context = texts.flatMap(block => block.lines);
  const command = commandBlock?.lines.join('\n').slice(0, 8000);
  return {
    ...(title ? { title } : {}),
    question: question >= 0 ? screen.slice(question, questionEnd + 1).map((line) => line.trim()).join(' ').replace(/^[│┃]\s*/, '') : '',
    context: context.slice(0, 12).map(text => text.slice(0, 2000)),
    ...(command ? { command } : {}),
    options: options.slice(0, 9).map(option => ({ label: unwrap(option.rows, option.lengths, width).join(' ').slice(0, 2000), selected: option.selected })),
  };
}

/** The rows of a numberless menu: the block right above its footer, with the cursor on one of at least two rows. */
function cursorMenu(screen: string[], nonEmpty: number[]): number[] | null {
  const footer = [...nonEmpty].reverse().find((index) => footerPattern.test(screen[index]!));
  if (footer === undefined) return null;
  const rows: number[] = [];
  for (let index = footer - 1; index >= 0 && rows.length < 10; index--) {
    if (screen[index]!.trim()) rows.unshift(index); else if (rows.length) break;
  }
  return rows.length >= 2 && rows.length <= 9 && rows.some((index) => cursorPattern.test(screen[index]!)) ? rows : null;
}

function toBlocks(region: string[], width: number): Block[] {
  const blocks: Block[] = [];
  let current = null as Block | null;
  const close = () => { if (current?.lines.length) blocks.push({ ...current, lines: unwrap(current.lines, current.lengths, width) }); current = null; };
  for (const line of region) {
    if (!line.trim() || rulePattern.test(line) || boxEdgePattern.test(line) || footerPattern.test(line)) { close(); continue; }
    const box = boxLinePattern.exec(line), dollar = /^\s*\$\s+(.+)$/.exec(line);
    const kind: Block['kind'] = box || dollar ? 'command' : 'text';
    const content = box ? box[1]! : dollar ? dollar[1]! : line.trim();
    if (current?.kind !== kind) { close(); current = { kind, lines: [], lengths: [] }; }
    current!.lines.push(content); current!.lengths.push(line.length);
  }
  close();
  return blocks;
}

/**
 * Rejoins lines a TUI wrapped at its width. A line that filled the width was cut mid-token and joins
 * directly; a fairly long one was word-wrapped and joins with a space; a short one ends its own line.
 */
function unwrap(rows: string[], lengths: number[], width: number): string[] {
  const result: string[] = [];
  rows.forEach((row, index) => {
    const previous = lengths[index - 1] ?? 0;
    if (!index || !result.length) { result.push(row); return; }
    if (previous >= width - 2) result[result.length - 1] += row;
    else if (previous >= width * 0.6) result[result.length - 1] += ` ${row}`;
    else result.push(row);
  });
  return result;
}

/** Readable markdown for timelines, toasts and notifications that do not render the structured prompt. */
export function promptMarkdown(prompt: TerminalPrompt): string {
  const fence = prompt.command?.includes('```') ? '~~~' : '```';
  return [
    prompt.question ? `**${prompt.question}**` : '',
    prompt.title ?? '',
    ...prompt.context,
    prompt.command ? `${fence}\n${prompt.command}\n${fence}` : '',
    prompt.options.map((option, index) => `${index + 1}. ${option.label}`).join('\n'),
  ].filter(Boolean).join('\n\n');
}
