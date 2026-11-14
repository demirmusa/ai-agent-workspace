import type { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { MAX_IMAGE_BYTES } from '../../../control-server/attachments.js';
import { print, request, segment } from './client.js';

const ENDED_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];
/** Image types GitHub issues can show; the server recognises them by content and names the attachment after it. */
const IMAGE_ATTACHMENT = /\.(?:png|jpg|gif|webp)$/;

/** Uploads one local image to the control server and returns it as Markdown for the question text. */
async function uploadImage(command: Command, path: string): Promise<string> {
  const file = resolve(path);
  const data = await readFile(file).catch((error: NodeJS.ErrnoException) => { throw new Error(`Cannot read image ${path} (${error.code ?? error.message}).`); });
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`Image ${path} exceeds ${MAX_IMAGE_BYTES / 1024 / 1024} MiB.`);
  const image = await request(command, '/api/attachments', 'POST', { data: data.toString('base64'), name: basename(file) });
  if (!IMAGE_ATTACHMENT.test(String(image.id))) throw new Error(`${path} is not a PNG, JPEG, GIF or WebP image.`);
  return `![${basename(file).replace(/[[\]]/g, '')}](${image.url})`;
}

/** Operator questions: answering them, and asking one from inside a run and waiting for the answer. */
export function registerQuestionCommands(control: Command): void {
  const questions = control.command('questions').description('Agent-specific questions and answers.');
  questions.command('list').action(async (_options, command) => print((await request(command, '/api/state')).questions));
  questions.command('answer <id> <answer>').action(async (id, answer, _options, command) => print(await request(command, `/api/questions/${segment(id)}/answer`, 'POST', { answer })));
  control.command('ask <text>').description('Ask the operator from a running agent and wait for its answer.')
    .option('--approval', 'mark this request as an explicit permission/approval decision')
    .option('--image <path>', 'attach a PNG, JPEG, GIF or WebP image (repeatable); it is shown in the UI and on the GitHub issue', (path: string, list: string[]) => [...list, path], [] as string[])
    .option('--run <id>', 'run ID', process.env.AIWS_RUN_ID).option('--no-wait', 'return the question immediately').option('--timeout <seconds>', 'maximum answer wait', '86400')
    .action(async (text, options, command) => {
      if (!options.run) throw new Error('Use --run or AIWS_RUN_ID when asking a question.');
      const timeout = Number(options.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be positive.');
      if (options.image.length > 20) throw new Error('At most 20 images can be attached to one question.');
      const images = await Promise.all((options.image as string[]).map((path) => uploadImage(command, path)));
      // Images on consecutive lines form one paragraph, which the UI shows as a gallery.
      const body = images.length ? `${text}\n\n${images.join('\n')}` : text;
      const value = await request(command, `/api/runs/${segment(options.run)}/questions`, 'POST', { text: body, kind: options.approval ? 'approval' : 'question' });
      const question = value.question ?? value;
      if (!options.wait) { print(question); return; }
      const end = Date.now() + timeout * 1000;
      while (Date.now() < end) {
        const current = await request(command, `/api/questions/${segment(question.id)}`);
        if (current?.answer !== undefined && current?.answer !== null) { process.stdout.write(`${current.answer}\n`); return; }
        if (current?.status && current.status !== 'pending') throw new Error(`Question ${question.id} was dismissed: the operator replied in the terminal or with a new instruction.`);
        const run = await request(command, `/api/runs/${segment(options.run)}`);
        if (ENDED_RUN_STATUSES.includes(run.status)) throw new Error(`Run ${options.run} ended before the question was answered.`);
        await new Promise((done) => setTimeout(done, 1000));
      }
      throw new Error(`Answer timed out; question ${question.id} remains available in the UI.`);
    });
}
