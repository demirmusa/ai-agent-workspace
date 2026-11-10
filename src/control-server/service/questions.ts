import { ControlError, type Project, type Question, type Run, type Task, type TerminalPrompt } from '../types.js';
import { jsonObject } from '../validation.js';
import { newId, now, runEnded, text } from './common.js';
import type { ControlContext } from './context.js';

export interface QuestionDependencies {
  launch(run: Run): void;
  postIssueComment(project: Project, task: Task, body: string, runId?: string | null): void;
}

/** Questions and approval requests of agents, and the user's answers that continue the run. */
export class Questions {
  /** Native dialogs that received a number key, until they settle. */
  private terminalChoices = new Set<string>();
  constructor(private readonly ctx: ControlContext, private readonly deps: QuestionDependencies) {}

  /** `prompt` is only set internally from a parsed native dialog, never from request bodies. */
  ask(runId: string, input: unknown, prompt?: TerminalPrompt): Question {
    const run = this.ctx.run(runId); if (runEnded(run)) throw new ControlError('Cannot ask a question on a finished run.', 409);
    const fields = jsonObject(input);
    const questionText = text(fields.text, 'text', 20_000).trim(); if (!questionText) throw new ControlError('Question text is required.');
    if (fields.kind !== undefined && !['question', 'approval'].includes(String(fields.kind))) throw new ControlError('Invalid question kind.');
    const question: Question = { id: newId('question'), runId, taskId: run.taskId, text: questionText, kind: fields.kind === 'approval' ? 'approval' : 'question', source: fields.source === 'terminal' ? 'terminal' : 'agent', answer: null, status: 'pending', createdAt: now(), answeredAt: null };
    if (prompt) question.prompt = structuredClone(prompt);
    this.ctx.state.questions.push(question);
    const task = this.ctx.task(run.taskId);
    if (run.status !== 'paused') { run.status = 'waiting'; task.status = 'waiting'; }
    this.ctx.event(runId, run.taskId, 'question', questionText, { questionId: question.id }); this.ctx.changed();
    const project = this.ctx.project(task.projectId);
    if (question.source === 'agent' && project.github && task.github?.issueNumber && !task.externalDependency) this.deps.postIssueComment(project, task, `❓ **AIWS ${question.kind === 'approval' ? 'needs approval' : 'question'}**\n\n${questionText}\n\n_Reply with a comment on this issue to answer._`, runId);
    return structuredClone(question);
  }
  answer(questionId: string, input: unknown): Question {
    const question = this.ctx.state.questions.find((item) => item.id === questionId);
    if (!question) throw new ControlError('Question not found.', 404);
    if (question.status !== 'pending') throw new ControlError('Question is no longer pending.', 409);
    if (question.source === 'terminal') throw new ControlError('Respond to this request in the native terminal.', 409);
    const run = this.ctx.run(question.runId); if (runEnded(run)) throw new ControlError('The question belongs to a finished run.', 409);
    const answer = text(jsonObject(input).answer, 'answer', 20_000).trim(); if (!answer) throw new ControlError('Answer text is required.');
    question.answer = answer; question.status = 'answered'; question.answeredAt = now();
    this.ctx.event(run.id, run.taskId, 'answer', answer, { questionId });
    if (!this.pending(run.id) && run.status === 'waiting') {
      run.status = 'running'; this.ctx.task(run.taskId).status = 'running';
      if (!this.ctx.handles.has(run.id)) { run.pendingCommands.push(`Answer to "${question.text}": ${answer}`); run.continuation++; this.deps.launch(run); }
    }
    this.ctx.changed(); return structuredClone(question);
  }
  /** A number typed into a native dialog selects that option; the dialog may close on it without an Enter. */
  chooseInTerminal(runId: string, digit: number): void {
    const question = this.nativePrompt(runId), options = question?.prompt?.options;
    if (!question || !options?.[digit - 1]) return;
    options.forEach((option, index) => { option.selected = index === digit - 1; });
    this.terminalChoices.add(question.id);
  }
  /** Enter in the terminal answered the run's native dialog with the option under the cursor; a dialog without parsed options is answered with no text. */
  answerInTerminal(runId: string): boolean {
    const question = this.nativePrompt(runId); if (!question) return false;
    this.settleAnswered(question); return true;
  }
  /** A native dialog left the screen: a number typed into it was its answer, otherwise it closed unanswered. */
  dialogClosed(question: Question): void {
    if (this.terminalChoices.has(question.id)) this.settleAnswered(question);
    else question.status = 'cancelled';
  }
  private nativePrompt(runId: string): Question | undefined { return this.ctx.state.questions.find((question) => question.runId === runId && question.status === 'pending' && question.source === 'terminal'); }
  private settleAnswered(question: Question): void {
    const choice = question.prompt?.options.find((option) => option.selected)?.label ?? null;
    this.terminalChoices.delete(question.id);
    question.status = 'answered'; question.answer = choice; question.answeredAt = now();
    if (choice) this.ctx.event(question.runId, question.taskId, 'answer', choice, { questionId: question.id });
  }
  /** The run has an unanswered question or native prompt. */
  pending(runId: string): boolean { return this.ctx.state.questions.some((question) => question.runId === runId && question.status === 'pending'); }
  /** Cancels the run's pending questions; `source` limits it to one kind. */
  cancel(runId: string, source?: Question['source']): boolean {
    let cancelled = false;
    for (const question of this.ctx.state.questions) if (question.runId === runId && question.status === 'pending' && (!source || question.source === source)) { question.status = 'cancelled'; cancelled = true; }
    return cancelled;
  }
}
