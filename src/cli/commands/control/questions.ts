import type { Command } from 'commander';
import { print, request, segment } from './client.js';

const ENDED_RUN_STATUSES = ['completed', 'failed', 'cancelled', 'interrupted'];

/** Operator questions: answering them, and asking one from inside a run and waiting for the answer. */
export function registerQuestionCommands(control: Command): void {
  const questions = control.command('questions').description('Agent-specific questions and answers.');
  questions.command('list').action(async (_options, command) => print((await request(command, '/api/state')).questions));
  questions.command('answer <id> <answer>').action(async (id, answer, _options, command) => print(await request(command, `/api/questions/${segment(id)}/answer`, 'POST', { answer })));
  control.command('ask <text>').description('Ask the operator from a running agent and wait for its answer.')
    .option('--approval', 'mark this request as an explicit permission/approval decision')
    .option('--run <id>', 'run ID', process.env.AIWS_RUN_ID).option('--no-wait', 'return the question immediately').option('--timeout <seconds>', 'maximum answer wait', '86400')
    .action(async (text, options, command) => {
      if (!options.run) throw new Error('Use --run or AIWS_RUN_ID when asking a question.');
      const timeout = Number(options.timeout);
      if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('--timeout must be positive.');
      const value = await request(command, `/api/runs/${segment(options.run)}/questions`, 'POST', { text, kind: options.approval ? 'approval' : 'question' });
      const question = value.question ?? value;
      if (!options.wait) { print(question); return; }
      const end = Date.now() + timeout * 1000;
      while (Date.now() < end) {
        const current = await request(command, `/api/questions/${segment(question.id)}`);
        if (current?.answer !== undefined && current?.answer !== null) { process.stdout.write(`${current.answer}\n`); return; }
        const run = await request(command, `/api/runs/${segment(options.run)}`);
        if (ENDED_RUN_STATUSES.includes(run.status)) throw new Error(`Run ${options.run} ended before the question was answered.`);
        await new Promise((done) => setTimeout(done, 1000));
      }
      throw new Error(`Answer timed out; question ${question.id} remains available in the UI.`);
    });
}
