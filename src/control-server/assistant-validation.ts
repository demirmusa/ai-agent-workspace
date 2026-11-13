import { randomUUID } from 'node:crypto';
import { canonicalTags } from './labels.js';
import { aiProviders } from './ai-providers/index.js';
import { parsePlanningJson } from './assistant-output.js';
import { ControlError, type AgentDefinition, type Project, type Provider, type SkillDefinition, type Task, type TerminalMode, type WorkflowDefinition } from './types.js';

/** Checks what a planning provider proposes against the configured agents, workflows, skills and tasks; nothing invalid reaches the board. */

export interface TaskDraft {
  title: string; description: string; status: 'backlog' | 'ready'; agentId?: string | null;
  workflowId?: string | null; requestedActions?: string[]; dependsOn?: number[];
}
export interface PlanResult { reply: string; tasks: TaskDraft[]; requestedActions: string[]; executionRequested?: boolean }
export interface IntakeDraft {
  title: string; description: string; status: 'backlog'; dependsOn: string[];
  agentId?: string | null; skillIds?: string[]; priority?: number; provider?: Provider | null;
  model?: string | null; terminalMode?: TerminalMode | null; tags?: string[];
  autoMerge?: boolean | null; workflowId?: string | null; workflowRequested?: boolean;
  requestedActions?: string[]; dependencyRefs?: string[];
}
export interface IntakeResult { reply: string; draft: IntakeDraft | null }
/** One proposal in the AI preparation workspace; `dependsOnDrafts` names earlier drafts of the same reply. */
export interface WorkspaceDraft extends IntakeDraft { key: string; dependsOnDrafts: string[] }
export interface WorkspaceDraftResult { reply: string; drafts: WorkspaceDraft[] }
/** What a proposal is checked against. */
export interface PlanContext {
  agents: AgentDefinition[]; workflows: WorkflowDefinition[];
  currentDraft?: Record<string, unknown>; existingTasks?: Task[]; skillsCatalog?: SkillDefinition[];
}
function plain(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ControlError('Planning provider must return a JSON object.', 502); return value as Record<string, unknown>;
}
function actionList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10 || value.some((entry) => typeof entry !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(entry))) throw new ControlError('Planning provider returned invalid requestedActions.', 502);
  return [...new Set(value as string[])];
}

export function validatePlan(value: unknown, options: Pick<PlanContext, 'agents' | 'workflows'>, projectId: string): PlanResult {
  const result = plain(value);
  if (typeof result.reply !== 'string' || result.reply.length > 30_000 || !Array.isArray(result.tasks) || result.tasks.length > 30) throw new ControlError('Planning reply must contain reply text and at most 30 tasks.', 502);
  const requestedActions = actionList(result.requestedActions);
  if (result.executionRequested !== undefined && typeof result.executionRequested !== 'boolean') throw new ControlError('Planning executionRequested must be boolean.', 502);
  const executionRequested = result.executionRequested === true;
  const tasks: TaskDraft[] = result.tasks.map((raw, index) => {
    const task = plain(raw);
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 500 || typeof task.description !== 'string' || !task.description.trim() || task.description.length > 100_000) throw new ControlError(`Planning task ${index + 1} requires a title and detailed instructions.`, 502);
    const agentId = task.agentId === undefined ? null : task.agentId;
    if (agentId !== null && (typeof agentId !== 'string' || !options.agents.some((agent) => agent.id === agentId && agent.enabled))) throw new ControlError('Planning provider selected an unknown or disabled agent.', 502);
    const workflowId = task.workflowId === undefined ? null : task.workflowId;
    if (workflowId !== null && (typeof workflowId !== 'string' || !options.workflows.some((workflow) => workflow.id === workflowId && workflow.enabled && (workflow.projectId === null || workflow.projectId === projectId)))) throw new ControlError('Planning provider selected an unavailable workflow.', 502);
    const status = task.status ?? 'backlog'; if (status !== 'backlog' && status !== 'ready') throw new ControlError('Planning tasks must start in backlog or ready.', 502);
    const dependsOn = task.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((dependency) => !Number.isSafeInteger(dependency) || dependency < 0 || dependency >= index)) throw new ControlError('Planning dependencies must refer to earlier task indexes.', 502);
    const actions = [...new Set([...requestedActions, ...actionList(task.requestedActions)])];
    if (actions.includes('deploy')) {
      const workflow = options.workflows.find((entry) => entry.id === workflowId);
      if (!workflow?.steps.some((step) => step.condition === 'deploy_requested')) {
        // Preserve the requested action, but require configuration rather than claiming a deployment can happen.
        return { title: task.title.trim(), description: task.description, status: 'backlog', agentId, workflowId, requestedActions: actions, dependsOn: [...new Set(dependsOn as number[])] };
      }
    }
    return { title: task.title.trim(), description: task.description, status: status === 'ready' && !executionRequested ? 'backlog' : status, agentId, workflowId, requestedActions: actions, dependsOn: [...new Set(dependsOn as number[])] };
  });
  return { reply: result.reply, tasks, requestedActions, executionRequested };
}

export function parsePlanOutput(stdout: string, options: Pick<PlanContext, 'agents' | 'workflows'>, projectId: string): PlanResult {
  return validatePlan(parsePlanningJson(stdout), options, projectId);
}

export function validateWorkspaceDrafts(value: unknown, options: PlanContext, project: Project): WorkspaceDraftResult {
  const result = plain(value);
  if (typeof result.reply !== 'string' || result.reply.length > 30_000 || !Array.isArray(result.drafts) || result.drafts.length > 30) throw new ControlError('Draft workspace reply must contain reply text and at most 30 drafts.', 502);
  const keys = new Set<string>(); const drafts: WorkspaceDraft[] = [];
  for (const raw of result.drafts) {
    const { key: rawKey, dependsOnDrafts: rawDependencies, ...fields } = plain(raw);
    // Field values are validated exactly like a single intake draft; the client merges them with user edits.
    const draft = validateIntakeDraft({ reply: result.reply, draft: fields }, { ...options, currentDraft: {} }, project).draft!;
    const key = typeof rawKey === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(rawKey) && !keys.has(rawKey) ? rawKey : `draft-${randomUUID().slice(0, 8)}`;
    // Only earlier drafts can block a later one, which keeps the proposal acyclic; anything else is dropped.
    const dependsOnDrafts = Array.isArray(rawDependencies) ? [...new Set(rawDependencies.filter((reference): reference is string => typeof reference === 'string' && keys.has(reference)))] : [];
    // Label names follow the project's spelling so cards and created tasks show the configured label.
    if (draft.tags) draft.tags = canonicalTags(draft.tags, project.labels ?? []);
    keys.add(key); drafts.push({ ...draft, key, dependsOnDrafts });
  }
  return { reply: result.reply, drafts };
}

export function validateIntakeDraft(value: unknown, options: PlanContext, project: Project): IntakeResult {
  const result = plain(value);
  if (typeof result.reply !== 'string' || result.reply.length > 30_000 || !Object.prototype.hasOwnProperty.call(result, 'draft')) throw new ControlError('Intake provider must return reply text and a draft or null.', 502);
  if (result.draft === null) return { reply: result.reply, draft: null };
  const allowed = new Set(['title', 'description', 'status', 'dependsOn', 'dependencyRefs', 'agentId', 'skillIds', 'priority', 'provider', 'model', 'terminalMode', 'tags', 'autoMerge', 'workflowId', 'workflowRequested', 'requestedActions']);
  const proposed = plain(result.draft);
  for (const field of Object.keys(proposed)) if (!allowed.has(field)) throw new ControlError(`Unsupported intake draft field: ${field}.`, 502);
  const raw = { ...Object.fromEntries(Object.entries(options.currentDraft ?? {}).filter(([field]) => allowed.has(field))), ...proposed };
  if (raw.status !== undefined && !['backlog', 'ready'].includes(String(raw.status))) throw new ControlError('Intake draft cannot start in an active or completed status.', 502);
  const normalized = validatePlan({ reply: result.reply, tasks: [{ ...raw, status: 'backlog', dependsOn: [] }] }, options, project.id).tasks[0]!;
  const draft: IntakeDraft = { title: normalized.title, description: normalized.description, status: 'backlog', dependsOn: [], agentId: normalized.agentId ?? null, workflowId: normalized.workflowId ?? null, requestedActions: normalized.requestedActions ?? [] };
  const strings = (value: unknown, name: string, max = 200): string[] => {
    if (!Array.isArray(value) || value.length > max || value.some((entry) => typeof entry !== 'string' || !entry || entry.length > 200 || entry.includes('\0'))) throw new ControlError(`Intake ${name} must be an array of valid references.`, 502);
    return [...new Set(value as string[])];
  };
  if (raw.dependsOn !== undefined) {
    draft.dependsOn = strings(raw.dependsOn, 'dependsOn');
    if (draft.dependsOn.some((id) => !options.existingTasks?.some((task) => task.id === id && task.projectId === project.id))) throw new ControlError('Intake dependencies must reference existing tasks in this project.', 502);
  }
  if (raw.dependencyRefs !== undefined) {
    draft.dependencyRefs = strings(raw.dependencyRefs, 'dependencyRefs');
    if (draft.dependencyRefs.some((ref) => !/^#[1-9]\d{0,9}$/.test(ref)) || (draft.dependencyRefs.length && !project.github)) throw new ControlError('Intake issue references require a linked repository and #issue-number syntax.', 502);
  }
  if (raw.skillIds !== undefined) {
    draft.skillIds = strings(raw.skillIds, 'skillIds');
    if (draft.skillIds.some((id) => !options.skillsCatalog?.some((skill) => skill.id === id))) throw new ControlError('Intake selected an unknown skill.', 502);
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority) || Math.abs(raw.priority) > 10_000) throw new ControlError('Intake priority must be between -10000 and 10000.', 502);
    draft.priority = raw.priority;
  }
  if (raw.provider !== undefined) {
    if (raw.provider !== null && raw.provider !== 'command' && !aiProviders.has(raw.provider)) throw new ControlError('Intake provider is invalid.', 502);
    if (raw.provider === 'command' && !options.agents.some((entry) => entry.id === draft.agentId && entry.provider === 'command')) throw new ControlError('Intake command execution requires a configured command agent.', 502);
    draft.provider = raw.provider as Provider | null;
  }
  if (raw.model !== undefined) {
    if (raw.model !== null && (typeof raw.model !== 'string' || raw.model.length > 200 || raw.model.includes('\0'))) throw new ControlError('Intake model is invalid.', 502);
    draft.model = raw.model as string | null;
  }
  if (raw.terminalMode !== undefined) {
    if (raw.terminalMode !== null && raw.terminalMode !== 'stream' && raw.terminalMode !== 'pty') throw new ControlError('Intake terminalMode is invalid.', 502);
    draft.terminalMode = raw.terminalMode;
  }
  if (raw.tags !== undefined) draft.tags = strings(raw.tags, 'tags', 32);
  if (raw.autoMerge !== undefined) {
    if (raw.autoMerge !== null && typeof raw.autoMerge !== 'boolean') throw new ControlError('Intake autoMerge must be boolean or null.', 502);
    draft.autoMerge = raw.autoMerge;
  }
  if (raw.workflowRequested !== undefined) {
    if (typeof raw.workflowRequested !== 'boolean') throw new ControlError('Intake workflowRequested must be boolean.', 502);
    draft.workflowRequested = raw.workflowRequested;
  }
  return { reply: result.reply, draft };
}
