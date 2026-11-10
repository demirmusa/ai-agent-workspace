import { randomUUID } from 'node:crypto';
import type { ControlStore } from './store.js';
import { jsonObject, jsonText } from './validation.js';
import { ControlError, type Project, type Task, type WorkflowDefinition, type WorkflowStep } from './types.js';

/** Named stages retain their exact order and agent identities across restart and hand-off. */
export class WorkflowCatalog {
  constructor(private readonly store: ControlStore, private readonly changed: () => void) {}
  workflow(workflowId: string): WorkflowDefinition {
    const value = this.store.state.workflows.find((entry) => entry.id === workflowId);
    if (!value) throw new ControlError('Workflow not found.', 404); return value;
  }
  private fields(input: unknown, previous?: WorkflowDefinition): Omit<WorkflowDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'> {
    const value = jsonObject(input, 'Workflow');
    const name = jsonText(value.name, 'Workflow name', previous?.name, 200).trim();
    if (!name) throw new ControlError('Workflow name is required.');
    const projectId = value.projectId === undefined ? previous?.projectId ?? null : value.projectId;
    if (projectId !== null && (typeof projectId !== 'string' || !this.store.state.projects.some((project) => project.id === projectId))) throw new ControlError('Workflow project must be an existing project or null.');
    const enabled = value.enabled ?? previous?.enabled ?? true;
    if (typeof enabled !== 'boolean') throw new ControlError('Workflow enabled must be a boolean.');
    const trigger = value.trigger ?? previous?.trigger ?? 'always';
    if (trigger !== 'always' && trigger !== 'requested') throw new ControlError('Workflow trigger must be always or requested.');
    const rawSteps = value.steps ?? previous?.steps;
    if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > 20) throw new ControlError('A workflow requires 1 to 20 ordered steps.');
    const seen = new Set<string>();
    const steps: WorkflowStep[] = rawSteps.map((raw, index) => {
      const step = jsonObject(raw, 'Workflow');
      const stepId = jsonText(step.id, 'Step ID', `step_${randomUUID()}`, 200);
      if (!stepId || seen.has(stepId)) throw new ControlError('Workflow step IDs must be unique.'); seen.add(stepId);
      const agentId = jsonText(step.agentId, 'Step agent', '', 200);
      if (!this.store.state.agents.some((agent) => agent.id === agentId)) throw new ControlError(`Workflow step ${index + 1} requires a configured named agent.`);
      const name = jsonText(step.name, 'Step name', '', 200).trim();
      if (!name) throw new ControlError(`Workflow step ${index + 1} requires a name.`);
      const condition = step.condition ?? 'always';
      if (condition !== 'always' && condition !== 'deploy_requested') throw new ControlError('Step condition must be always or deploy_requested.');
      return { id: stepId, name, agentId, instructions: jsonText(step.instructions, 'Step instructions'), condition };
    });
    if (!steps.some((step) => step.condition === 'always')) throw new ControlError('A workflow requires at least one unconditional work step.');
    return { name, description: jsonText(value.description, 'Workflow description', previous?.description), projectId: projectId as string | null, enabled, trigger, steps };
  }
  create(input: unknown): WorkflowDefinition {
    if (this.store.state.workflows.length >= 200) throw new ControlError('Workflow library limit is 200.');
    const timestamp = new Date().toISOString();
    const result = { id: `workflow_${randomUUID()}`, ...this.fields(input), revision: 1, createdAt: timestamp, updatedAt: timestamp };
    this.store.state.workflows.push(result); this.changed(); return structuredClone(result);
  }
  update(workflowId: string, input: unknown): WorkflowDefinition {
    const previous = this.workflow(workflowId);
    Object.assign(previous, this.fields(input, previous), { revision: previous.revision + 1, updatedAt: new Date().toISOString() });
    this.changed(); return structuredClone(previous);
  }
  delete(workflowId: string): void {
    this.workflow(workflowId);
    if (this.store.state.tasks.some((task) => task.workflowId === workflowId || (task.workflowProgress?.definition.id === workflowId && task.workflowProgress.status === 'running'))) throw new ControlError('Workflow is assigned to tasks. Remove those assignments or finish its runs first.', 409);
    this.store.state.workflows = this.store.state.workflows.filter((workflow) => workflow.id !== workflowId); this.changed();
  }
}

export function selectWorkflow(task: Task, project: Project, workflows: WorkflowDefinition[]): WorkflowDefinition | undefined {
  const scope = workflows.filter((workflow) => workflow.enabled && (workflow.projectId === null || workflow.projectId === project.id));
  if (task.workflowId) {
    const explicit = scope.find((workflow) => workflow.id === task.workflowId);
    if (!explicit) throw new ControlError('The assigned workflow is disabled, missing or belongs to another project.', 409);
    return explicit;
  }
  const requested = task.workflowRequested || task.requestedActions?.includes('deploy');
  let candidates = scope.filter((workflow) => workflow.trigger === 'always' || requested);
  if (task.requestedActions?.includes('deploy')) {
    const deployment = candidates.filter((workflow) => workflow.steps.some((step) => step.condition === 'deploy_requested'));
    if (deployment.length) candidates = deployment;
  }
  const projectSpecific = candidates.filter((workflow) => workflow.projectId === project.id);
  if (projectSpecific.length) candidates = projectSpecific;
  if (candidates.length > 1) throw new ControlError('Several workflows match this task. Choose its workflow explicitly.', 409);
  return candidates[0];
}

export function snapshotWorkflow(workflow: WorkflowDefinition, _task?: Task): WorkflowDefinition { return structuredClone(workflow); }
export function workflowStepApplies(step: WorkflowStep, task: Pick<Task, 'requestedActions'>): boolean { return step.condition === 'always' || !!task.requestedActions?.includes('deploy'); }
export function nextWorkflowStep(workflow: WorkflowDefinition, completedIndex: number, task: Pick<Task, 'requestedActions'>): number | null {
  for (let index = completedIndex + 1; index < workflow.steps.length; index++) if (workflowStepApplies(workflow.steps[index]!, task)) return index;
  return null;
}
