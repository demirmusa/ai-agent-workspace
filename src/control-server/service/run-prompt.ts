import type { Run, Task } from '../types.js';
import { terminalTranscript } from './common.js';
import type { ControlContext } from './context.js';

/** Server plugins add task context to agent prompts through this hook (PluginManager.promptContributions). */
export type PluginPrompt = (task: Task, run: Run) => string;

const TRANSCRIPT_EVENTS = new Set(['stdout', 'stderr', 'command', 'answer']);
/** The instruction a continued session gets when the user resumes a task without writing a new message. */
export const CONTINUE_MESSAGE = 'Continue this task where it stopped. Do not wait for a new message: finish what the user asked earlier in this conversation without repeating work you already completed, verify the result, then follow the AIWS instructions below.';
/** The instruction an interrupted session gets when the service starts again. */
export const RESTART_CONTINUE_MESSAGE = 'AIWS restarted while you were working on this task: your previous process was stopped, and a command running at that moment did not finish. Check the state of the workspace, then continue where you left off without repeating work you already completed, verify the result, and follow the AIWS instructions below.';

/** The final-answer instruction; the reply is shown to the user, so the agent must not repeat it in its own output. */
const replyInstruction = (runId: string): string => `Final answer: aiws control reply --run ${runId} "Your answer". The user sees this reply, so do not repeat it in your console output; end your turn with at most one short line.`;

/** Builds the prompt a provider turn starts with: system prompts, agent profile, task, AIWS protocol and previous transcript. */
export class RunPromptBuilder {
  constructor(private readonly ctx: ControlContext, private readonly pluginPrompt: () => PluginPrompt | undefined) {}

  build(run: Run, description?: string): string {
    const task = this.ctx.task(run.taskId), project = this.ctx.project(task.projectId);
    const snapshot = run.executionSnapshot;
    if (run.historyResume) {
      // The resumed session holds the task and its history; it only needs the new message and this run's commands.
      const message = description ?? run.historyResume.initialMessage;
      return `${message}${run.pendingCommands.length ? `\n\n${run.pendingCommands.join('\n\n')}` : ''}\n\n[AIWS] Continuation of the same session. The current run is ${run.id} and task is ${task.id}; ignore earlier run IDs and completion commands. Ask the user: aiws control ask "Your question" --run ${run.id}. ${replyInstruction(run.id)} ${run.terminalMode === 'pty' ? `When done: aiws control complete --run ${run.id} --summary "Changes and tests" (add --failed on failure).` : ''}`.trim();
    }
    const state = this.ctx.state;
    const skillsRoot = run.executionMode === 'docker' ? '/run/aiws/skills' : run.skillsDirectory;
    const skillInstructions = snapshot?.skills.map((skill) => `\n## Skill: ${skill.name} (revision ${skill.revision})\nSkill root: ${skillsRoot}/${skill.id}\nRead resources relative to this skill root. SKILL.md: ${skillsRoot}/${skill.id}/SKILL.md\n${skill.content}\nResource files:\n${skill.files.map((file) => `${skillsRoot}/${skill.id}/${file.path}`).join('\n')}`).join('\n') ?? '';
    const systemPrompt = project.systemPrompt?.trim();
    const globalPrompt = state.settings.systemPrompt?.trim();
    const preamble = `${globalPrompt ? `General system prompt:\n${globalPrompt}\n\n` : ''}${systemPrompt ? `Project system prompt:\n${systemPrompt}\n\n` : ''}${snapshot?.instructions ? `Agent instructions:\n${snapshot.instructions}\n\n` : ''}${snapshot?.context ? `Agent background context:\n${snapshot.context}\n\n` : ''}${skillInstructions ? `Assigned skills (apply these instructions; support files exist at the paths shown):\n${skillInstructions}\n\n` : ''}`;
    const replay = run.terminalMode === 'pty' ? terminalTranscript(this.ctx.store.terminalOutput(run), 30_000) : '';
    const history = `${state.events.filter((event) => event.runId === run.id && TRANSCRIPT_EVENTS.has(event.type)).slice(-100).map((event) => `[${event.type}] ${event.message}`).join('\n')}${replay ? `\n[terminal] ${replay}` : ''}`.slice(-60_000).trim();
    const workflowDirectory = state.workflows.filter((workflow) => workflow.enabled && (!workflow.projectId || workflow.projectId === task.projectId)).map(({ id, name, description, trigger, steps }) => ({ id, name, description, trigger, steps: steps.map(({ name, agentId, condition }) => ({ name, agentId, condition })) }));
    const directory = snapshot?.directory ?? [];
    const deployable = workflowDirectory.some((workflow) => workflow.steps.some((step) => step.condition === 'deploy_requested'));
    const github = task.github && !task.externalDependency ? ` It is posted on GitHub issue #${task.github.issueNumber}; keep it concise.` : '';
    const schedule = task.scheduleId ? state.schedules.find((item) => item.id === task.scheduleId) : undefined;
    const lines = [
      `AIWS run ${run.id}, task ${task.id}. Verify before claiming success. Only you, not subagents, may run aiws control commands for this run.`,
      run.terminalMode === 'pty' ? `Ask the user with your own built-in question and approval prompts; AIWS notifies the user and shows them in the chat. To show the user images with a question, use aiws control ask "Your question" --run ${run.id} --image <path> (repeatable) instead.` : `Ask the user: aiws control ask "Your question" --run ${run.id} (add --approval for permission; --image <path> attaches a screenshot or other image, repeatable).`,
      `${replyInstruction(run.id)}${github}`,
      run.terminalMode === 'pty' ? `When done: aiws control complete --run ${run.id} --summary "Changes and tests" (add --failed on failure).` : '',
      run.provider !== 'command' ? `Before starting the work, record your provider session ID so follow-ups resume this conversation: aiws control session --run ${run.id} (pass the ID as an argument if it is not detected automatically) and your exact model ID: add --model <your-model-id>.` : '',
      directory.length ? `Configured agent directory (also in AIWS_AGENT_DIRECTORY_FILE; do not invent agents or credentials): ${JSON.stringify(directory)}` : '',
      workflowDirectory.length ? `Workflows: ${JSON.stringify(workflowDirectory)}` : '',
      deployable ? `If deployment is requested, run aiws control tasks update ${task.id} --requested-actions deploy. Never improvise deployment credentials.` : '',
      task.worktree && run.executionMode === 'native' ? 'A node_modules folder in this worktree may be a link to the main checkout\'s install, shared by other tasks. Before changing dependencies there, delete that link (not its contents) and install locally.' : '',
      project.general ? `You work in the AIWS general workspace (${run.executionMode === 'docker' ? '/workspace' : project.repositoryPath}): a plain folder shared by automations, not a Git repository or project. Keep files you need between runs there; do not create branches, commits or pull requests unless the task asks for it.` : '',
      task.scheduleId ? `This task was started by the ${schedule ? `schedule "${schedule.name}" (${schedule.id})` : `schedule ${task.scheduleId}`} for the occurrence ${task.scheduledFor ?? task.createdAt}${schedule?.timezone ? ` (time zone ${schedule.timezone})` : ''}. It runs unattended: finish without asking unless a decision is essential.` : '',
      this.pluginText(task, run),
    ].filter(Boolean).join('\n');
    return `${preamble}Task:\n${snapshot?.task.title ?? task.title}\n\n${description ?? snapshot?.task.description ?? task.description}\n\n${lines}\n${history ? `\nPrevious execution transcript (may be truncated):\n${history}\n` : ''}${run.pendingCommands.length ? `\nUser instructions:\n${run.pendingCommands.join('\n\n')}` : ''}`;
  }
  private pluginText(task: Task, run: Run): string {
    try { const text = this.pluginPrompt()?.(task, run).trim(); return text ? `Plugin context:\n${text}` : ''; } catch { return ''; }
  }
}
