import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchRuntime, type RuntimeHandle } from './runner.js';
import { materializeRunSkills } from './catalog.js';
import { parsePlanningJson, providerFinalText } from './assistant-output.js';
import { organizePrompt, planningPrompt, type PlanningMode } from './assistant-prompts.js';
import { parsePlanOutput, validateIntakeDraft, validateWorkspaceDrafts, type IntakeResult, type PlanContext, type PlanResult, type WorkspaceDraftResult } from './assistant-validation.js';
import { ControlError, type AgentDefinition, type DefaultProvider, type ExecutionSnapshot, type PlannerMessage, type Project, type Provider, type ProviderArgs, type Run, type SkillDefinition, type Task } from './types.js';

/** Bounded, non-interactive provider turns for planning, task intake, workspace drafting and queue organization. */
export { planningActivity } from './assistant-output.js';
export { organizePrompt } from './assistant-prompts.js';
export { parsePlanOutput, validatePlan, validateIntakeDraft, validateWorkspaceDrafts } from './assistant-validation.js';
export type { TaskDraft, PlanResult, IntakeDraft, IntakeResult, WorkspaceDraft, WorkspaceDraftResult } from './assistant-validation.js';
export interface PlanOptions extends PlanContext {
  defaultProvider?: DefaultProvider;
  defaultModels?: Partial<Record<DefaultProvider, string>>;
  timeoutMs?: number;
  executionMode?: 'native' | 'docker'; image?: string; controlUrl?: string; token?: string;
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void; signal?: AbortSignal;
  dataDir?: string;
  providerArgs?: ProviderArgs;
  /** The provider, model and reasoning level the human picked for this turn; empty fields fall back to the agent and settings. */
  choice?: { provider?: Provider; model?: string; reasoningEffort?: string };
  currentDrafts?: Record<string, unknown>[];
}
/** A genuine, bounded provider turn. Only the explicit legacy plan endpoint commits its result. */
export async function planTasks(project: Project, agent: AgentDefinition | null, skills: SkillDefinition[], messages: PlannerMessage[], options: PlanOptions): Promise<PlanResult> {
  return parsePlanOutput(await planningTurn(project, agent, skills, messages, options), options, project.id);
}

/** Intake never persists tasks, messages or execution authorization. Saving belongs to the caller. */
export async function draftTask(project: Project, agent: AgentDefinition | null, skills: SkillDefinition[], messages: PlannerMessage[], options: PlanOptions): Promise<IntakeResult> {
  return validateIntakeDraft(parsePlanningJson(await planningTurn(project, agent, skills, messages, options, 'intake')), options, project);
}

/** Workspace drafting proposes several editable tasks at once and, like intake, never persists anything. */
export async function draftTasks(project: Project, agent: AgentDefinition | null, skills: SkillDefinition[], messages: PlannerMessage[], options: PlanOptions): Promise<WorkspaceDraftResult> {
  return validateWorkspaceDrafts(parsePlanningJson(await planningTurn(project, agent, skills, messages, options, 'workspace')), options, project);
}

async function planningTurn(project: Project, agent: AgentDefinition | null, skills: SkillDefinition[], messages: PlannerMessage[], options: PlanOptions, mode: PlanningMode = 'plan'): Promise<string> {
  if (agent && !agent.enabled) throw new ControlError('Planning agent is disabled.', 409);
  if (options.executionMode === 'docker' && process.env.AIWS_CONTROL_SKILLS_VOLUME && !options.dataDir && skills.length) throw new ControlError('Docker planning skills require the control data directory.');
  const directory = options.dataDir ?? await mkdtemp(join(tmpdir(), 'aiws-planning-'));
  const timestamp = new Date().toISOString(); const runId = `planner_${randomUUID()}`;
  const provider = options.choice?.provider ?? agent?.provider ?? options.defaultProvider ?? 'codex';
  const model = (options.choice?.provider || options.choice?.model ? options.choice.model : agent?.model) ?? (provider !== 'command' ? options.defaultModels?.[provider] : undefined);
  const reasoningEffort = options.choice?.provider || options.choice?.reasoningEffort ? options.choice.reasoningEffort : agent?.reasoningEffort;
  const snapshot: ExecutionSnapshot = { agent, skills: structuredClone(skills), provider,
    ...(model ? { model } : {}), ...(reasoningEffort ? { reasoningEffort } : {}), ...(agent?.command ? { command: agent.command } : {}),
    instructions: agent?.instructions ?? '', context: agent?.context ?? '', task: { title: 'Project planning conversation', description: '' }, createdAt: timestamp, terminalMode: 'stream' };
  const run: Run = { id: runId, taskId: runId, provider, status: 'running', startedAt: timestamp, finishedAt: null, exitCode: null, executionMode: options.executionMode ?? 'native', pendingCommands: [], continuation: 0, executionSnapshot: snapshot, terminalMode: 'stream' };
  const root = materializeRunSkills(directory, run.id, snapshot); if (root) run.skillsDirectory = root;
  const task: Task = { id: runId, projectId: project.id, title: snapshot.task.title, description: '', provider, status: 'backlog', priority: 0, dependsOn: [], autoStart: false, currentRunId: runId, createdAt: timestamp, updatedAt: timestamp };
  const selectedPrompt = planningPrompt(mode, project, agent, skills, messages, options, run.executionMode === 'docker' ? '/run/aiws/skills' : root);
  return await providerTurn(project, task, run, selectedPrompt, options, { readOnly: true, controlUrl: '' }, { subject: 'Planning', timeoutNote: ' No tasks were created.', cleanup: options.dataDir ? join(directory, 'runs', run.id) : directory });
}

/** One bounded, non-interactive provider process; its stdout is returned once it exits successfully. */
async function providerTurn(project: Project, task: Task, run: Run, prompt: string, options: Pick<PlanOptions, 'timeoutMs' | 'signal' | 'image' | 'providerArgs' | 'onOutput'>, access: { readOnly: boolean; controlUrl: string; token?: string }, labels: { subject: string; timeoutNote: string; cleanup: string }, defaultTimeoutMs = 180_000): Promise<string> {
  const { subject } = labels;
  let handle: RuntimeHandle | undefined;
  try {
    const output = await new Promise<string>((resolve, reject) => {
      let stdout = ''; let stderr = ''; let settled = false;
      const finish = (error?: Error): void => { if (settled) return; settled = true; clearTimeout(timer); options.signal?.removeEventListener('abort', abort); if (error) reject(error); else resolve(stdout); };
      const abort = (): void => { void handle?.stop(); finish(new ControlError(`${subject} request was cancelled.`, 409)); };
      const timer = setTimeout(() => { void handle?.stop(); finish(new ControlError(`${subject} provider timed out.${labels.timeoutNote}`, 504)); }, options.timeoutMs ?? defaultTimeoutMs);
      if (options.signal?.aborted) { abort(); return; }
      options.signal?.addEventListener('abort', abort, { once: true });
      try {
        handle = launchRuntime(project, task, run, prompt, { readOnly: access.readOnly, image: options.image ?? 'aiws-control-worker:local', controlUrl: access.controlUrl, ...(access.token ? { token: access.token } : {}), ...(options.providerArgs ? { providerArgs: options.providerArgs } : {}) }, {
          output: (stream, text) => { options.onOutput?.(stream === 'terminal' ? 'stdout' : stream, text); if (stream !== 'stderr') stdout += text; else stderr = `${stderr}${text}`.slice(-8_000); if (stdout.length > 4_000_000) { void handle?.stop(); finish(new ControlError(`${subject} output exceeded the size limit.`, 502)); } },
          close: (code, error) => finish(code === 0 ? undefined : new ControlError(`${subject} provider exited ${code}: ${error ?? stderr.slice(-2_000)}`, 502)),
        });
      } catch (error) { finish(error as Error); }
    });
    return output;
  } finally { await handle?.stop(); await rm(labels.cleanup, { recursive: true, force: true }); }
}

export interface OrganizeOptions extends Pick<PlanOptions, 'defaultProvider' | 'timeoutMs' | 'executionMode' | 'image' | 'onOutput' | 'signal' | 'dataDir' | 'providerArgs' | 'defaultModels'> {
  controlUrl: string; token?: string;
  /** Every task of the project; only backlog tasks may be changed by the organizer. */
  tasks: Task[];
}

/**
 * Runs the organizer like a normal task agent in the project directory, but without a board task:
 * it can reach the control API (to update tasks through the aiws CLI) and returns its final report.
 */
export async function organizeTasks(project: Project, options: OrganizeOptions): Promise<string> {
  const directory = options.dataDir ?? await mkdtemp(join(tmpdir(), 'aiws-organize-'));
  const timestamp = new Date().toISOString(); const runId = `organizer_${randomUUID()}`;
  const provider = options.defaultProvider ?? 'codex';
  const snapshot: ExecutionSnapshot = { agent: null, skills: [], provider, ...(options.defaultModels?.[provider] ? { model: options.defaultModels[provider] } : {}), instructions: '', context: '', task: { title: 'Task queue organization', description: '' }, createdAt: timestamp, terminalMode: 'stream' };
  const run: Run = { id: runId, taskId: runId, provider, status: 'running', startedAt: timestamp, finishedAt: null, exitCode: null, executionMode: options.executionMode ?? 'native', pendingCommands: [], continuation: 0, executionSnapshot: snapshot, terminalMode: 'stream' };
  const task: Task = { id: runId, projectId: project.id, title: snapshot.task.title, description: '', provider, status: 'backlog', priority: 0, dependsOn: [], autoStart: false, currentRunId: runId, createdAt: timestamp, updatedAt: timestamp };
  const stdout = await providerTurn(project, task, run, organizePrompt(project, options.tasks), options, { readOnly: false, controlUrl: options.controlUrl, ...(options.token ? { token: options.token } : {}) },
    { subject: 'Task organizer', timeoutNote: ' Changes already made to tasks are kept.', cleanup: options.dataDir ? join(directory, 'runs', run.id) : directory }, 900_000);
  return providerFinalText(stdout, 'Task organizer').slice(0, 30_000);
}
