import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { validateHandoffMode } from '../agent-handoff.js';
import type { ControlGitHub } from '../github.js';
import { canonicalTags, labelKey, mergeLabels, validateLabel, validateLabels } from '../labels.js';
import { unlinkMilestones } from '../milestones.js';
import { validateProjectProviderSettings } from '../provider-settings.js';
import { validateRunScripts } from '../run-scripts.js';
import { ControlError, type Project, type ProjectLabel } from '../types.js';
import { jsonObject } from '../validation.js';
import { validateBranch } from '../workspace.js';
import { repositoryBranches, validateMainBranch } from '../worktrees.js';
import { isRepository } from '../workspace.js';
import { GENERAL_WORKSPACE_ID, newId, now, text } from './common.js';
import type { ControlContext } from './context.js';
import { isTaskMergeMode } from './settings.js';

export interface ProjectDependencies {
  github: ControlGitHub;
  /** Project terminals still open; a project with any cannot be deleted. */
  openTerminals(projectId: string): number;
  /** A GitHub synchronization of the project is running. */
  syncing(projectId: string): boolean;
  /** Validates and deletes every task of a project, or throws without deleting any. */
  deleteTasks(projectId: string): void;
  /** Removes the project's schedules and other records kept by other parts of the service. */
  forget(projectId: string): void;
  refreshInheritedProviders(projectId: string): void;
}

/** Projects and the general workspace: their settings, order and labels. */
export class ProjectManager {
  constructor(private readonly ctx: ControlContext, private readonly deps: ProjectDependencies) {}

  /**
   * The general workspace is a folder in the control data directory: no repository, no Git,
   * no GitHub. It follows the data directory if that moves.
   */
  ensureGeneralWorkspace(): void {
    const repositoryPath = join(this.ctx.store.directory, 'workspace');
    mkdirSync(repositoryPath, { recursive: true, mode: 0o700 });
    const existing = this.ctx.state.generalWorkspace, timestamp = now();
    if (existing) { if (existing.repositoryPath !== repositoryPath) { existing.repositoryPath = repositoryPath; existing.updatedAt = timestamp; } return; }
    this.ctx.state.generalWorkspace = { id: GENERAL_WORKSPACE_ID, name: 'Genel çalışma alanı', description: 'Projelerden bağımsız, zamanlanmış ve tekrarlanan işler için ortak çalışma alanı.', repositoryPath, github: null, general: true,
      defaultBranch: 'main', useWorktree: false, mainBranch: 'main', labels: [], runScripts: [], systemPrompt: '', autoMerge: false, createdAt: timestamp, updatedAt: timestamp };
  }
  create(input: unknown): Project {
    const project = { id: newId('project'), ...this.validate(jsonObject(input)), createdAt: now(), updatedAt: now() };
    this.ctx.state.projects.push(project); this.ctx.changed(); return structuredClone(project);
  }
  update(projectId: string, input: unknown): Project {
    const project = this.ctx.project(projectId);
    const value = this.validate(jsonObject(input), project);
    if (value.repositoryPath !== project.repositoryPath && this.ctx.state.tasks.some((task) => task.projectId === projectId && this.ctx.running(task))) throw new ControlError('Stop project runs before changing its repository path.', 409);
    const disconnected = JSON.stringify(project.github) !== JSON.stringify(value.github);
    if (disconnected && this.deps.syncing(projectId)) throw new ControlError('Wait for synchronization before changing the GitHub connection.', 409);
    Object.assign(project, value, { updatedAt: now() });
    if (value.maxConcurrent === undefined) delete project.maxConcurrent;
    this.deps.refreshInheritedProviders(projectId);
    if (disconnected) {
      for (const task of this.ctx.state.tasks.filter((item) => item.projectId === projectId)) delete task.github;
      unlinkMilestones(project);
      if (this.ctx.state.ignoredGitHubIssues) delete this.ctx.state.ignoredGitHubIssues[projectId];
      if (this.ctx.state.githubWatch) delete this.ctx.state.githubWatch[projectId];
    }
    this.ctx.changed(); return structuredClone(project);
  }
  /** Stores the projects in the given order; projects missing from the list keep their relative order after it. */
  reorder(input: unknown): Project[] {
    const value = jsonObject(input);
    if (!Array.isArray(value.projectIds) || value.projectIds.length > 1000 || value.projectIds.some((id) => typeof id !== 'string')) throw new ControlError('projectIds must be a list of project IDs.');
    const ids = [...new Set(value.projectIds as string[])], projects = this.ctx.state.projects, known = new Set(projects.map((project) => project.id));
    if (ids.some((id) => !known.has(id))) throw new ControlError('Unknown project in projectIds.', 404);
    const rank = new Map(ids.map((id, index) => [id, index]));
    projects.sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
    this.ctx.changed(); return structuredClone(projects);
  }
  delete(projectId: string): void {
    if (this.ctx.project(projectId).general) throw new ControlError('The general workspace cannot be deleted.', 409);
    if (this.deps.openTerminals(projectId)) throw new ControlError('Close project terminals before deleting the project.', 409);
    if (this.deps.syncing(projectId)) throw new ControlError('Wait for project synchronization before deleting it.', 409);
    this.deps.deleteTasks(projectId);
    const state = this.ctx.state;
    state.projects = state.projects.filter((project) => project.id !== projectId);
    state.workflows = state.workflows.filter((workflow) => workflow.projectId !== projectId);
    state.plannerMessages = state.plannerMessages.filter((message) => message.projectId !== projectId);
    if (state.ignoredGitHubIssues) delete state.ignoredGitHubIssues[projectId];
    if (state.githubWatch) delete state.githubWatch[projectId];
    this.deps.forget(projectId);
    this.ctx.changed({ full: true });
  }
  /**
   * Replaces a project's labels. `previousName` renames a label; tasks follow renames
   * and lose labels that were removed. GitHub repository labels change only on export.
   */
  setLabels(projectId: string, input: unknown): Project {
    const project = this.ctx.project(projectId), value = jsonObject(input);
    if (!Array.isArray(value.labels)) throw new ControlError('labels must be an array.');
    const renames = new Map<string, string>();
    for (const entry of value.labels) {
      const previousName = entry && typeof entry === 'object' ? (entry as Record<string, unknown>).previousName : undefined;
      if (previousName !== undefined && (typeof previousName !== 'string' || previousName.length > 100)) throw new ControlError('previousName must be text.');
      if (previousName) renames.set(labelKey(previousName), validateLabel(entry).name);
    }
    const labels = validateLabels(value.labels.map((entry: unknown) => { const { previousName: _previous, ...label } = jsonObject(entry); return label; }));
    const kept = new Set(labels.map((label) => labelKey(label.name))), known = new Set((project.labels ?? []).map((label) => labelKey(label.name)));
    for (const task of this.ctx.state.tasks.filter((item) => item.projectId === projectId && item.tags?.length)) {
      const tags = canonicalTags(task.tags!.map((tag) => renames.get(labelKey(tag)) ?? tag).filter((tag) => kept.has(labelKey(tag)) || !known.has(labelKey(tag))), labels);
      if (JSON.stringify(tags) !== JSON.stringify(task.tags)) { task.tags = tags; task.updatedAt = now(); }
    }
    project.labels = labels; project.updatedAt = now(); this.ctx.changed(); return structuredClone(project);
  }
  /** Adds the repository's labels to the project; with `overwrite`, existing labels take GitHub's color and description. */
  async importGitHubLabels(projectId: string, input: unknown = {}): Promise<{ project: Project; added: string[]; updated: string[] }> {
    const project = this.ctx.project(projectId), overwrite = jsonObject(input).overwrite ?? true;
    if (typeof overwrite !== 'boolean') throw new ControlError('overwrite must be boolean.');
    if (!project.github) throw new ControlError('Project is not connected to GitHub.');
    const remote = await this.deps.github.labels(project);
    const merged = mergeLabels(project.labels ?? [], remote, overwrite);
    project.labels = merged.labels; project.updatedAt = now();
    this.ctx.event(null, null, 'github.labels', `Imported ${merged.added.length} new and ${merged.updated.length} updated labels from GitHub.`, { projectId });
    this.ctx.changed(); return { project: structuredClone(project), added: merged.added, updated: merged.updated };
  }
  /** Creates or updates the project's labels in the linked repository. */
  async exportGitHubLabels(projectId: string): Promise<{ created: string[]; updated: string[] }> {
    const project = this.ctx.project(projectId);
    if (!project.github) throw new ControlError('Project is not connected to GitHub.');
    const result = await this.deps.github.exportLabels(project, project.labels ?? []);
    this.ctx.event(null, null, 'github.labels', `Exported labels to GitHub: ${result.created.length} created, ${result.updated.length} updated.`, { projectId });
    this.ctx.changed(); return result;
  }
  /** Task tags that are not project labels yet become labels, so every tag can be colored and synchronized. */
  learnLabels(projectId: string, tags: string[]): void {
    const project = this.ctx.project(projectId), incoming: ProjectLabel[] = [];
    for (const tag of tags) { try { incoming.push(validateLabel({ name: tag })); } catch { /* Tags that GitHub cannot hold stay plain tags. */ } }
    const merged = mergeLabels(project.labels ?? [], incoming);
    if (merged.added.length) { project.labels = merged.labels; project.updatedAt = now(); }
  }
  repositoryBranches(input: unknown): ReturnType<typeof repositoryBranches> {
    const path = text(jsonObject(input).path, 'path', 4_096);
    if (!isAbsolute(path)) throw new ControlError('path must be an absolute directory path.');
    return repositoryBranches(path);
  }
  private validate(input: Record<string, unknown>, previous?: Project): Omit<Project, 'id' | 'createdAt' | 'updatedAt'> {
    const settings = this.ctx.state.settings;
    if (previous?.general) {
      // Only the descriptive fields of the general workspace can change; its folder and Git settings are fixed.
      for (const key of ['repositoryPath', 'github', 'useWorktree', 'mainBranch', 'defaultBranch', 'autoMerge', 'runScripts']) {
        if (input[key] !== undefined && JSON.stringify(input[key]) !== JSON.stringify((previous as unknown as Record<string, unknown>)[key])) throw new ControlError('The general workspace has a fixed folder and no Git or GitHub settings.', 409);
      }
      const { id: _id, createdAt: _created, updatedAt: _updated, ...fixed } = previous;
      const name = text(input.name, 'name', 200, previous.name).trim(); if (!name) throw new ControlError('Project name is required.');
      return { ...fixed, providerSettings: input.providerSettings === undefined ? previous.providerSettings : validateProjectProviderSettings(input.providerSettings, settings), name, description: text(input.description, 'description', 100_000, previous.description), systemPrompt: text(input.systemPrompt, 'systemPrompt', 100_000, previous.systemPrompt ?? ''), labels: input.labels === undefined ? previous.labels ?? [] : validateLabels(input.labels) };
    }
    const name = text(input.name, 'name', 200, previous?.name).trim();
    if (!name) throw new ControlError('Project name is required.');
    const repositoryPath = text(input.repositoryPath, 'repositoryPath', 4_096, previous?.repositoryPath);
    if (!isAbsolute(repositoryPath)) throw new ControlError('repositoryPath must be an absolute directory path.');
    try { if (!statSync(repositoryPath).isDirectory()) throw new Error(); } catch { throw new ControlError('repositoryPath must be an existing directory accessible to the service.'); }
    const github = input.github === undefined ? previous?.github ?? null : input.github;
    if (github !== null) {
      const connection = jsonObject(github);
      if (typeof connection.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(connection.repository)) throw new ControlError('GitHub repository must be owner/repo.');
      if (typeof connection.owner !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(connection.owner) || !Number.isInteger(connection.number) || Number(connection.number) < 1) throw new ControlError('GitHub owner and positive project number are required.');
      if (connection.ownerType !== undefined && !['user', 'organization'].includes(String(connection.ownerType))) throw new ControlError('Invalid GitHub ownerType.');
    }
    const taskMergeMode = input.taskMergeMode === undefined ? previous?.taskMergeMode ?? null : input.taskMergeMode;
    if (taskMergeMode !== null && !isTaskMergeMode(taskMergeMode)) throw new ControlError('Invalid taskMergeMode.');
    const autoMerge = input.autoMerge ?? previous?.autoMerge ?? false; if (typeof autoMerge !== 'boolean') throw new ControlError('autoMerge must be a boolean.');
    const mainBranch = validateMainBranch(input.mainBranch ?? previous?.mainBranch ?? 'main');
    // New projects isolate tasks in worktrees whenever the repository has the main branch.
    const useWorktree = input.useWorktree ?? previous?.useWorktree ?? (isRepository(repositoryPath) && repositoryBranches(repositoryPath).branches.includes(mainBranch));
    if (typeof useWorktree !== 'boolean') throw new ControlError('useWorktree must be boolean.');
    if ((useWorktree || input.mainBranch !== undefined) && !repositoryBranches(repositoryPath).branches.includes(mainBranch)) throw new ControlError('mainBranch must be an existing local branch.', 409);
    const maxConcurrent = input.maxConcurrent === undefined ? previous?.maxConcurrent : input.maxConcurrent === null || input.maxConcurrent === '' ? undefined : input.maxConcurrent;
    if (maxConcurrent !== undefined && (!Number.isInteger(maxConcurrent) || (maxConcurrent as number) < 1 || (maxConcurrent as number) > 50)) throw new ControlError('Project maxConcurrent must be between 1 and 50.');
    const defaultBranch = validateBranch(text(input.defaultBranch, 'defaultBranch', 250, previous?.defaultBranch ?? 'main'));
    const repository = realpathSync.native(resolve(repositoryPath));
    const runScripts = input.runScripts === undefined ? (previous?.runScripts ?? []) : validateRunScripts(input.runScripts, repository, previous?.runScripts);
    const labels = input.labels === undefined ? previous?.labels ?? [] : validateLabels(input.labels);
    const agentHandoffMode = input.agentHandoffMode === undefined ? previous?.agentHandoffMode ?? 'fresh' : validateHandoffMode(input.agentHandoffMode);
    return { taskMergeMode: taskMergeMode as NonNullable<Project['taskMergeMode']> | null, providerSettings: input.providerSettings === undefined ? previous?.providerSettings : validateProjectProviderSettings(input.providerSettings, settings), defaultBranch, useWorktree, mainBranch, agentHandoffMode, ...(maxConcurrent === undefined ? {} : { maxConcurrent: maxConcurrent as number }), runScripts, labels, name, description: text(input.description, 'description', 100_000, previous?.description ?? ''), systemPrompt: text(input.systemPrompt, 'systemPrompt', 100_000, previous?.systemPrompt ?? ''), repositoryPath: repository, github: github as Project['github'], autoMerge };
  }
}
