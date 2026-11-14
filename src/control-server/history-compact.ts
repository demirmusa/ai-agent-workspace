import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseJsonOrNull } from '../shared/core/json.js';
import { aiProviders, DIRECT_PROMPT_LIMIT, type ProviderInvocation } from './ai-providers/index.js';
import { streamOutputText } from './history-transfer.js';
import { ControlError, type Task } from './types.js';
import { killWindowsProcessTree, windowsLauncher } from './windows-launch.js';

/** Characters of conversation one summarizing call reads (about 60k tokens), so small models fit it in their context. */
export const COMPACT_CHUNK = 240_000;
const MAX_OUTPUT = 32 * 1024 * 1024, TIMEOUT = 15 * 60_000;

/** Runs one bounded provider invocation in a folder and returns its stdout. */
export type CompactRunner = (invocation: ProviderInvocation, cwd: string, env: NodeJS.ProcessEnv) => Promise<string>;

export interface CompactOptions {
  provider: string; model?: string; workspacePath: string; transcript: string;
  /** Replaces spawning the provider CLI (tests). */
  runner?: CompactRunner;
}

const INSTRUCTIONS = 'You compact the conversation history of a coding agent so a new agent can continue the same task without reading the whole conversation. Do not use tools, do not change files and do not run commands; only write the summary. Write it in English, in Markdown, with these sections: Task (the goal and the user\'s requirements and preferences), Decisions (with the reasons), Completed work (files, commands, results, commits), Current state and open problems, Next steps, Important details (paths, names, commands, IDs, error messages that must not be lost). Keep every fact the next agent needs and drop greetings, repetition, tool noise and outdated attempts. Output only the summary.';

/** Splits the transcript at line breaks into pieces of at most `size` characters. */
export function compactChunks(transcript: string, size = COMPACT_CHUNK): string[] {
  const chunks: string[] = [];
  let rest = transcript.trim();
  while (rest.length > size) {
    const cut = rest.lastIndexOf('\n', size);
    const at = cut > size / 2 ? cut : size;
    chunks.push(rest.slice(0, at)); rest = rest.slice(at).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** The final answer a headless provider printed: the last agent text of its stream output, or the plain output when it printed no JSON. */
export function finalAgentText(stdout: string): string {
  let last = '', json = false;
  for (const line of stdout.split(/\r?\n/)) {
    const row = parseJsonOrNull(line);
    if (!row || typeof row !== 'object') continue;
    json = true;
    const parts = streamOutputText(row).split(/\n(?=\[)/).filter(part => part.startsWith('[agent] '));
    if (parts.length) last = parts.map(part => part.slice('[agent] '.length)).join('\n');
  }
  return (json ? last : stdout).trim();
}

const spawnRunner: CompactRunner = (invocation, cwd, env) => new Promise((resolve, reject) => {
  const command = windowsLauncher(invocation.executable, invocation.args, env);
  const startedAt = Date.now();
  const child = spawn(command.executable, command.args, { cwd, env: command.env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const kill = (): void => { if (process.platform === 'win32' && child.pid) void killWindowsProcessTree(child.pid, startedAt); else child.kill(); };
  let stdout = '', stderr = '';
  const timer = setTimeout(() => { kill(); reject(new ControlError('The summarizing model did not finish in time.', 504)); }, TIMEOUT);
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > MAX_OUTPUT) { clearTimeout(timer); kill(); reject(new ControlError('The summarizing model printed too much output.')); } });
  child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-2000); });
  child.once('error', (error) => { clearTimeout(timer); reject(new ControlError(`The summarizing model could not start: ${error.message}`)); });
  child.once('close', (code) => { clearTimeout(timer); if (code === 0) resolve(stdout); else reject(new ControlError(`The summarizing model exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)); });
  child.stdin?.on('error', () => { /* A CLI that reads its prompt from the command line may close stdin early. */ });
  child.stdin?.end(invocation.input);
});

/**
 * Compacts a long conversation with a (usually smaller, cheaper) model: the transcript is read in
 * pieces, each call folding the next piece into the running summary, and the final summary is returned.
 */
export async function compactConversation(options: CompactOptions): Promise<string> {
  if (options.provider === 'command') throw new ControlError('A custom command cannot summarize a conversation; choose an AI provider.');
  const provider = aiProviders.require(options.provider);
  const run = options.runner ?? spawnRunner;
  const env: NodeJS.ProcessEnv = { ...process.env, ...provider.runEnv(true) };
  for (const name of ['AIWS_CONTROL_TOKEN', 'AIWS_CONTROL_URL', 'AIWS_RUN_ID', 'AIWS_TASK_ID']) delete env[name];
  const chunks = compactChunks(options.transcript);
  if (!chunks.length) throw new ControlError('The conversation has no history to compact.', 409);
  const folder = await mkdtemp(join(tmpdir(), 'aiws-compact-'));
  try {
    let summary = '';
    for (const [index, chunk] of chunks.entries()) {
      const part = chunks.length > 1 ? ` (part ${index + 1} of ${chunks.length})` : '';
      let prompt = [INSTRUCTIONS,
        summary ? `Summary of the earlier parts of the conversation:\n<summary>\n${summary}\n</summary>\nUpdate this summary with the next part below and output the whole updated summary.` : '',
        `Conversation${part}:\n<conversation>\n${chunk}\n</conversation>`].filter(Boolean).join('\n\n');
      let invocation = provider.headlessInvocation({ model: options.model } as Task, prompt, true);
      if (prompt.length > DIRECT_PROMPT_LIMIT && invocation.args.includes(prompt)) {
        // A CLI that takes its prompt on the command line would exceed the Windows limit; it reads the prompt from a file instead.
        const file = join(folder, `part-${index + 1}.md`);
        await writeFile(file, prompt, 'utf8');
        prompt = `Read the file ${file} completely and follow the instructions in it. Output only the summary it asks for.`;
        invocation = provider.headlessInvocation({ model: options.model } as Task, prompt, true);
      }
      const text = finalAgentText(await run(invocation, options.workspacePath, env));
      if (!text) throw new ControlError('The summarizing model returned no summary.');
      summary = text;
    }
    return summary;
  } finally { await rm(folder, { recursive: true, force: true }).catch(() => undefined); }
}
