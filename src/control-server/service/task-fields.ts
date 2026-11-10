import { aiProviders, isAccountId } from '../ai-providers/index.js';
import type { ControlCatalog } from '../catalog.js';
import { canonicalTags } from '../labels.js';
import { currentMilestone } from '../milestones.js';
import { mergeTaskPluginData } from '../plugins.js';
import { validateScheduledAt } from '../schedules.js';
import { ControlError, type DefaultProvider, type Provider, type ScheduleTaskTemplate, type Task, type TaskStatus } from '../types.js';
import { validateUsageTrigger } from '../usage-trigger.js';
import { jsonObject } from '../validation.js';
import type { WorkflowCatalog } from '../workflows.js';
import { validateBranch } from '../workspace.js';
import { TASK_STATUSES, has, text, validAttachedFile } from './common.js';
import type { ControlContext } from './context.js';

export type TaskFields = Omit<Task, 'id' | 'createdAt' | 'updatedAt' | 'currentRunId' | 'github'>;
const isProvider = (value: unknown): value is Provider => value === 'command' || aiProviders.has(value);

/** Validates task input, and schedule templates that create tasks, into stored task fields. */
export class TaskFieldValidator {
  constructor(private readonly ctx: ControlContext, private readonly catalog: ControlCatalog, private readonly workflows: WorkflowCatalog) {}

  validate(input: Record<string, unknown>, previous?: Task): TaskFields {
    const projectId = text(input.projectId, 'projectId', 200, previous?.projectId); const project = this.ctx.project(projectId);
    const description = text(input.description, 'description', 100_000, previous?.description ?? '');
    const title = text(input.title, 'title', 500, previous?.title ?? '').trim(); if (!title && !description.trim()) throw new ControlError('Task title is required unless a description is given.');
    const status = input.status ?? previous?.status ?? 'backlog';
    if (!TASK_STATUSES.includes(status as TaskStatus)) throw new ControlError('Invalid task status.');
    const agentId = has(input, 'agentId') ? input.agentId : previous?.agentId ?? null;
    if (agentId !== null && typeof agentId !== 'string') throw new ControlError('agentId must be an agent ID or null.');
    const agent = agentId ? this.catalog.agent(agentId as string) : undefined;
    const changedAgent = agentId !== (previous?.agentId ?? null);
    const providerSettings = this.ctx.providerSettings(projectId);
    const providerInput = has(input, 'providerOverride') ? input.providerOverride : has(input, 'provider') ? input.provider : undefined;
    const providerOverride = has(input, 'providerOverride') || has(input, 'provider') ? providerInput === null ? undefined : providerInput : changedAgent ? undefined : previous?.providerOverride;
    const provider = providerOverride ?? agent?.provider ?? (has(input, 'provider') || has(input, 'providerOverride') || changedAgent ? providerSettings.defaultProvider : previous?.provider ?? providerSettings.defaultProvider);
    if (!isProvider(provider)) throw new ControlError('Invalid provider.');
    if (providerOverride !== undefined && providerOverride !== previous?.providerOverride && providerSettings.disabledProviders.includes(providerOverride as DefaultProvider)) throw new ControlError(`${String(providerOverride)} is disabled in work settings. Enable it or choose another provider.`);
    const priority = input.priority ?? previous?.priority ?? 0;
    if (typeof priority !== 'number' || !Number.isFinite(priority) || Math.abs(priority) > 10_000) throw new ControlError('priority must be a number between -10000 and 10000.');
    const dependsOn = input.dependsOn ?? previous?.dependsOn ?? [];
    if (!Array.isArray(dependsOn) || dependsOn.some((value) => typeof value !== 'string') || dependsOn.length > 200) throw new ControlError('dependsOn must be an array of task IDs.');
    this.checkDependencies(projectId, dependsOn as string[], previous?.id);
    const autoStart = input.autoStart ?? previous?.autoStart ?? false;
    if (typeof autoStart !== 'boolean') throw new ControlError('autoStart must be a boolean.');
    const preferNativeTerminal = input.preferNativeTerminal ?? previous?.preferNativeTerminal ?? false;
    if (typeof preferNativeTerminal !== 'boolean') throw new ControlError('preferNativeTerminal must be a boolean.');
    const modelInput = has(input, 'modelOverride') ? input.modelOverride : has(input, 'model') ? input.model : undefined;
    const modelOverride = has(input, 'modelOverride') || has(input, 'model') ? modelInput === null ? undefined : modelInput : changedAgent ? undefined : previous?.modelOverride;
    const model = agent ? modelOverride ?? agent.model : input.model === null ? undefined : input.model ?? previous?.model;
    if (model !== undefined && (typeof model !== 'string' || model.length > 200)) throw new ControlError('model must be text.');
    // A level chosen for another provider is dropped when the provider changes; an explicit choice must fit the provider.
    const effortInput = has(input, 'reasoningEffort') ? input.reasoningEffort === null || input.reasoningEffort === '' ? undefined : input.reasoningEffort : previous?.reasoningEffort;
    const efforts = provider === 'command' ? [] : aiProviders.require(provider).reasoningEfforts;
    if (has(input, 'reasoningEffort') && effortInput !== undefined && (typeof effortInput !== 'string' || !efforts.includes(effortInput))) throw new ControlError(efforts.length ? `reasoningEffort must be one of ${efforts.join(', ')}.` : 'The selected provider has no reasoning levels.');
    const reasoningEffort = typeof effortInput === 'string' && efforts.includes(effortInput) ? effortInput : undefined;
    // An account belongs to the provider it was chosen for, so a provider change drops it unless a new one is given.
    const account = has(input, 'account') ? input.account === null || input.account === '' ? undefined : input.account : provider === previous?.provider ? previous?.account : undefined;
    if (account !== undefined && !isAccountId(account)) throw new ControlError('account must be an account ID or null.');
    if (account !== undefined && (provider === 'command' || !aiProviders.require(provider).accounts)) throw new ControlError('The selected provider has no accounts to choose from.');
    const command = input.command === null ? undefined : input.command ?? previous?.command;
    if (command !== undefined) {
      const value = jsonObject(command);
      if (typeof value.executable !== 'string' || !value.executable.trim() || value.executable.length > 4_096 || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string' || arg.length > 100_000) || value.args.length > 200) throw new ControlError('command requires an executable and string args array.');
    }
    if (provider === 'command' && !(command ?? agent?.command)) throw new ControlError('Command provider requires command.executable and command.args.');
    const terminalMode = has(input, 'terminalMode') && input.terminalMode === null ? undefined : input.terminalMode ?? previous?.terminalMode;
    if (terminalMode !== undefined && !['stream', 'pty'].includes(String(terminalMode))) throw new ControlError('terminalMode must be stream or pty.');
    const tags = input.tags ?? previous?.tags ?? []; const requestedActions = input.requestedActions ?? previous?.requestedActions ?? [];
    for (const [label, values] of [['tags', tags], ['requestedActions', requestedActions]] as const) if (!Array.isArray(values) || values.length > 32 || values.some((value) => typeof value !== 'string' || value.length > 100)) throw new ControlError(`${label} must be a string array, at most 32 items.`);
    const attachedFiles = input.attachedFiles ?? previous?.attachedFiles ?? [];
    if (!Array.isArray(attachedFiles) || attachedFiles.length > 50 || attachedFiles.some((value) => typeof value !== 'string' || !validAttachedFile(value))) throw new ControlError('attachedFiles must be at most 50 project-relative paths.');
    const workflowId = has(input, 'workflowId') ? input.workflowId : previous?.workflowId ?? null;
    if (workflowId !== null && typeof workflowId !== 'string') throw new ControlError('workflowId must be an ID or null.');
    if (workflowId) this.workflows.workflow(workflowId as string);
    const workflowRequested = input.workflowRequested ?? previous?.workflowRequested ?? false; if (typeof workflowRequested !== 'boolean') throw new ControlError('workflowRequested must be boolean.');
    const autoMerge = has(input, 'autoMerge') ? input.autoMerge : previous?.autoMerge ?? null; if (autoMerge !== null && typeof autoMerge !== 'boolean') throw new ControlError('autoMerge must be boolean or null.');
    const baseBranch = validateBranch(text(input.baseBranch, 'baseBranch', 250, previous?.baseBranch ?? project.defaultBranch ?? 'main'));
    if (previous?.taskBranch && (baseBranch !== previous.baseBranch || projectId !== previous.projectId)) throw new ControlError('The source branch cannot change after a task branch has been created.', 409);
    const scheduledAt = has(input, 'scheduledAt') ? validateScheduledAt(input.scheduledAt) : previous?.scheduledAt;
    const usageTrigger = has(input, 'usageTrigger') ? validateUsageTrigger(input.usageTrigger) : previous?.usageTrigger;
    const pluginData = has(input, 'pluginData') ? input.pluginData === null ? undefined : mergeTaskPluginData(previous?.pluginData, input.pluginData) : previous?.pluginData;
    // New tasks join the project's current milestone unless they name one; a task moved to another project leaves its milestone.
    const milestoneInput = has(input, 'milestoneId') ? input.milestoneId : previous ? previous.projectId === projectId ? previous.milestoneId : undefined : currentMilestone(project)?.id;
    if (milestoneInput !== undefined && milestoneInput !== null && (typeof milestoneInput !== 'string' || !project.milestones?.some((milestone) => milestone.id === milestoneInput))) throw new ControlError('milestoneId must be a milestone of the task project or null.');
    const milestoneId = typeof milestoneInput === 'string' ? milestoneInput : undefined;
    const pullRequest = has(input, 'pullRequest') ? input.pullRequest : previous?.pullRequest;
    if (pullRequest !== undefined && pullRequest !== null) { const pr = jsonObject(pullRequest); if (!Number.isInteger(pr.number) || Number(pr.number) < 1) throw new ControlError('pullRequest.number must be positive.'); }
    return { baseBranch, projectId, title, description, status: status as TaskStatus,
      provider: provider as Task['provider'], priority, dependsOn: [...new Set(dependsOn as string[])], autoStart, preferNativeTerminal, agentId: agentId as string | null,
      skillIds: this.catalog.skillIds(input.skillIds ?? previous?.skillIds ?? []),
      tags: canonicalTags(tags as string[], project.labels ?? []), requestedActions: requestedActions as string[], workflowRequested, workflowId: workflowId as string | null, autoMerge,
      ...(pullRequest ? { pullRequest: structuredClone(pullRequest as Task['pullRequest'] & {}) } : {}),
      ...(scheduledAt ? { scheduledAt } : {}),
      ...(milestoneId ? { milestoneId } : {}),
      ...(usageTrigger ? { usageTrigger } : {}),
      ...(pluginData ? { pluginData } : {}),
      ...(attachedFiles.length ? { attachedFiles: [...new Set(attachedFiles as string[])] } : {}),
      ...(terminalMode === undefined ? {} : { terminalMode: terminalMode as 'stream' | 'pty' }),
      ...(providerOverride !== undefined ? { providerOverride: providerOverride as Task['provider'] } : {}),
      ...(agent && modelOverride !== undefined ? { modelOverride: modelOverride as string } : {}),
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }), ...(account === undefined ? {} : { account: account as string }),
      ...(model === undefined ? {} : { model: model as string }), ...(command === undefined ? {} : { command: command as Task['command'] & {} }) };
  }
  /** Validates a schedule template exactly as the task it creates; agent and provider stay references resolved at each run. */
  scheduleTemplate(projectId: string, input: Record<string, unknown>, previous?: ScheduleTaskTemplate): ScheduleTaskTemplate {
    const pick = (key: string, fallback: unknown): unknown => has(input, key) ? input[key] : fallback;
    const merged: Record<string, unknown> = { title: pick('title', previous?.title), description: pick('description', previous?.description ?? ''), agentId: pick('agentId', previous?.agentId ?? null), provider: pick('provider', previous?.provider ?? null), model: pick('model', previous?.model ?? null), reasoningEffort: pick('reasoningEffort', previous?.reasoningEffort ?? null),
      command: pick('command', previous?.command ?? null), skillIds: pick('skillIds', previous?.skillIds ?? []), tags: pick('tags', previous?.tags ?? []), priority: pick('priority', previous?.priority ?? 2), terminalMode: pick('terminalMode', previous?.terminalMode ?? null),
      preferNativeTerminal: pick('preferNativeTerminal', previous?.preferNativeTerminal ?? false), workflowId: pick('workflowId', previous?.workflowId ?? null), autoMerge: pick('autoMerge', previous?.autoMerge ?? null), baseBranch: pick('baseBranch', previous?.baseBranch) };
    for (const key of ['provider', 'model', 'reasoningEffort', 'command', 'terminalMode', 'agentId', 'workflowId']) if (merged[key] === '') merged[key] = null;
    if (typeof merged.baseBranch !== 'string' || !merged.baseBranch) delete merged.baseBranch;
    const fields = this.validate({ projectId, status: 'ready', autoStart: true, ...merged });
    return { title: fields.title, description: fields.description, agentId: fields.agentId ?? null, skillIds: fields.skillIds ?? [], tags: fields.tags ?? [], priority: fields.priority, workflowId: fields.workflowId ?? null, autoMerge: fields.autoMerge ?? null,
      ...(merged.provider ? { provider: merged.provider as NonNullable<ScheduleTaskTemplate['provider']> } : {}), ...(merged.model ? { model: String(merged.model) } : {}), ...(fields.reasoningEffort ? { reasoningEffort: fields.reasoningEffort } : {}), ...(fields.command ? { command: fields.command } : {}),
      ...(fields.terminalMode ? { terminalMode: fields.terminalMode } : {}), ...(fields.preferNativeTerminal ? { preferNativeTerminal: true } : {}), ...(typeof merged.baseBranch === 'string' ? { baseBranch: fields.baseBranch! } : {}) };
  }
  /** Task fields of a schedule template, in the form the task API accepts. */
  templateInput(projectId: string, template: ScheduleTaskTemplate): Record<string, unknown> {
    return { projectId, status: 'ready', autoStart: true, title: template.title, description: template.description, agentId: template.agentId, provider: template.provider ?? null, model: template.model ?? null, reasoningEffort: template.reasoningEffort ?? null,
      command: template.command ?? null, skillIds: template.skillIds, tags: template.tags, priority: template.priority, terminalMode: template.terminalMode ?? null, preferNativeTerminal: template.preferNativeTerminal ?? false,
      workflowId: template.workflowId, autoMerge: template.autoMerge, ...(template.baseBranch ? { baseBranch: template.baseBranch } : {}) };
  }
  /** Dependencies must be other tasks of the same project, and must not lead back to the task. */
  private checkDependencies(projectId: string, dependsOn: string[], taskId: string | undefined): void {
    const seen = new Set<string>();
    const visit = (id: string): void => {
      if (id === taskId) throw new ControlError('Task dependencies must not contain a cycle.');
      if (seen.has(id)) return; seen.add(id); for (const next of this.ctx.task(id).dependsOn) visit(next);
    };
    for (const dependency of dependsOn) {
      if (dependency === taskId || this.ctx.task(dependency).projectId !== projectId) throw new ControlError('Dependencies must be other tasks in the same project.');
      visit(dependency);
    }
  }
}
