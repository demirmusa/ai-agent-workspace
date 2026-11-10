import { aiProviders } from '../ai-providers/index.js';
import { validateAutoModeProviders, validateCustomProviders, validateDisabledProviders, validateModelPreferences, validateProviderArgs, validateUsageFooter } from '../provider-args.js';
import { validateModelAutoMerge } from '../provider-settings.js';
import { ControlError, DEFAULT_TASK_MERGE_MODE, type ControlSettings, type Project } from '../types.js';
import { jsonObject } from '../validation.js';
import type { ControlContext } from './context.js';

export const isTaskMergeMode = (value: unknown): value is NonNullable<Project['taskMergeMode']> => value === 'branch' || value === 'pull-request';

/** Global control settings, and the tasks a stopped system lets finish their current work. */
export class SettingsManager {
  /** Tasks that were working when the system stopped; their workflow may still advance. */
  private drainingTasks = new Set<string>();
  constructor(private readonly ctx: ControlContext, private readonly refreshInheritedProviders: () => void) {}

  draining(taskId: string): boolean { return this.drainingTasks.has(taskId); }
  /** Some stopped-system task still finishes its workflow. */
  workflowDraining(): boolean { return this.ctx.state.tasks.some((task) => this.drainingTasks.has(task.id) && task.workflowProgress?.status === 'running'); }
  update(input: unknown): ControlSettings {
    const current = this.ctx.state.settings, value = jsonObject(input); const settings = { ...current, ...value };
    if (typeof settings.systemEnabled !== 'boolean') throw new ControlError('systemEnabled must be a boolean.');
    if (!aiProviders.has(settings.defaultProvider)) throw new ControlError(`Invalid defaultProvider. Choose ${aiProviders.names('or', 'id')}.`);
    if (!Number.isInteger(settings.maxConcurrent) || settings.maxConcurrent < 1 || settings.maxConcurrent > 50) throw new ControlError('maxConcurrent must be between 1 and 50.');
    if (!['native', 'docker'].includes(settings.executionMode)) throw new ControlError('Invalid executionMode.');
    if (typeof settings.dockerImage !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(settings.dockerImage)) throw new ControlError('Invalid Docker image.');
    if (!Number.isInteger(settings.autoSyncSeconds) || settings.autoSyncSeconds < 0 || settings.autoSyncSeconds > 3600) throw new ControlError('autoSyncSeconds must be 0 to 3600.');
    if (settings.autoSyncSeconds > 0 && settings.autoSyncSeconds < 10) throw new ControlError('Automatic sync must be at least 10 seconds apart.');
    if ('useWorktree' in value || 'mainBranch' in value) throw new ControlError('Worktree settings belong to a project.');
    if (settings.taskMergeMode !== undefined && !isTaskMergeMode(settings.taskMergeMode)) throw new ControlError('Invalid taskMergeMode.');
    const providerArgs = validateProviderArgs(value.providerArgs, current.providerArgs);
    const disabledProviders = validateDisabledProviders(settings.disabledProviders ?? []);
    const autoModeProviders = validateAutoModeProviders(settings.autoModeProviders ?? []);
    const customProviders = validateCustomProviders(settings.customProviders ?? []);
    const modelPreferences = validateModelPreferences(value, current);
    const modelAutoMerge = validateModelAutoMerge(settings.modelAutoMerge ?? {});
    if (disabledProviders.includes(settings.defaultProvider)) throw new ControlError(`The default provider ${settings.defaultProvider} cannot be disabled. Choose another default provider first.`);
    if (typeof settings.githubTrigger !== 'string' || !/^\S{2,40}$/.test(settings.githubTrigger)) throw new ControlError('githubTrigger must be 2 to 40 characters without spaces, for example /ai.');
    if (typeof settings.systemPrompt !== 'string' || settings.systemPrompt.length > 100_000) throw new ControlError('systemPrompt must be text of at most 100000 characters.');
    if (!aiProviders.has(settings.voiceProvider) || !aiProviders.require(settings.voiceProvider).voice) throw new ControlError(`Invalid voiceProvider. Choose ${aiProviders.list().filter((provider) => provider.voice).map((provider) => provider.id).join(', ')}.`);
    if (current.systemEnabled && !settings.systemEnabled) this.drainingTasks = new Set(this.ctx.state.runs.filter((run) => this.ctx.busy(run)).map((run) => run.taskId));
    else if (settings.systemEnabled) this.drainingTasks.clear();
    this.ctx.state.settings = { taskMergeMode: settings.taskMergeMode ?? DEFAULT_TASK_MERGE_MODE, systemEnabled: settings.systemEnabled, defaultProvider: settings.defaultProvider, maxConcurrent: settings.maxConcurrent, executionMode: settings.executionMode, dockerImage: settings.dockerImage, autoSyncSeconds: settings.autoSyncSeconds, providerArgs, disabledProviders, autoModeProviders, customProviders, ...modelPreferences, modelAutoMerge, githubTrigger: settings.githubTrigger, systemPrompt: settings.systemPrompt.trim(), voiceProvider: settings.voiceProvider, usageFooter: validateUsageFooter(settings.usageFooter) };
    this.refreshInheritedProviders();
    this.ctx.changed(); return structuredClone(this.ctx.state.settings);
  }
}
