import { spawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';
import type { Attachments } from '../attachments.js';
import type { MilestoneSync } from '../github-milestones.js';
import { COMMENT_MARKER, MissingGitHubRemote, REQUIRED_SCOPES, trustedAuthor, triggeredRequest, type ControlGitHub, type GitHubAuthStatus, type IssueComment } from '../github.js';
import { remoteLabels, taskMarker } from '../github-issues.js';
import { mergeLabels } from '../labels.js';
import { ControlError, type ControlState, type Project, type ProjectLabel, type ProjectMilestone, type Question, type Run, type Task, type TaskMessage } from '../types.js';
import { jsonObject } from '../validation.js';
import { newId, now, runEnded, text } from './common.js';
import type { ControlContext } from './context.js';

export interface GitHubBridgeDependencies {
  attachments: Attachments;
  learnLabels(projectId: string, tags: string[]): void;
  /** Applies the milestones a sync returned; `before` are the project's milestones when the sync started. */
  applyMilestones(project: Project, before: ProjectMilestone[], result: MilestoneSync): void;
  dependencySatisfied(task: Task): boolean;
  hasMergeTarget(task: Task): boolean;
  answer(questionId: string, input: unknown): Question;
  /** Answers a native CLI dialog of a terminal run by typing into it. */
  answerNativePrompt(question: Question, reply: string): void;
  postMessage(taskId: string, input: unknown): TaskMessage;
  sendTaskMessage(taskId: string, input: unknown): Promise<TaskMessage | null>;
  updateProject(projectId: string, input: unknown): Project;
  importLabels(projectId: string, input: unknown): Promise<unknown>;
  exportLabels(projectId: string): Promise<unknown>;
}

type GitHubWatch = NonNullable<ControlState['githubWatch']>[string];
/** What the last successful sync left behind, so a poll can tell whether anything moved since. */
interface SyncMark { remote: string | null; since: string; tasks: number; dirty: boolean; at: number }
/** Changes the cheap probe cannot see (deleted issues or milestones, external blockers) still arrive within this time. */
export const FULL_SYNC_MS = 5 * 60_000;

/**
 * Connects projects to GitHub: repository detection and sign-in, issue synchronization,
 * issue comments that answer agents or start requests, and run outcomes posted back.
 */
export class GitHubBridge {
  private syncingProjects = new Set<string>();
  private polling = new Set<string>();
  private lastCheck = new Map<string, number>();
  private marks = new Map<string, SyncMark>();
  constructor(private readonly ctx: ControlContext, private readonly github: ControlGitHub, private readonly deps: GitHubBridgeDependencies) {}

  syncing(projectId: string): boolean { return this.syncingProjects.has(projectId); }
  forget(projectId: string): void { this.lastCheck.delete(projectId); this.marks.delete(projectId); }
  /** Checks linked projects every `autoSyncSeconds` and synchronizes those that changed on GitHub or locally. */
  tick(current: number): void {
    const seconds = this.ctx.state.settings.autoSyncSeconds;
    if (seconds) for (const project of this.ctx.state.projects) {
      if (project.github && !this.syncingProjects.has(project.id) && !this.polling.has(project.id) && current - (this.lastCheck.get(project.id) ?? 0) >= seconds * 1_000) void this.poll(project.id);
    }
  }
  /** One cheap GitHub query decides whether the full sync runs; local edits and the periodic full sync always run it. */
  private async poll(projectId: string): Promise<void> {
    this.polling.add(projectId);
    try {
      const project = this.ctx.project(projectId), mark = this.marks.get(projectId);
      const remote = await this.github.changeMark(project).catch(() => null);
      if (this.ctx.closing || !this.ctx.state.projects.includes(project) || !project.github || this.syncingProjects.has(projectId)) return;
      if (mark && remote !== null && remote === mark.remote && !this.localChanged(project, mark) && Date.now() - mark.at < FULL_SYNC_MS) return;
      await this.sync(projectId, remote);
    } catch { /* sync() records the error event. */ }
    finally { this.polling.delete(projectId); this.lastCheck.set(projectId, Date.now()); }
  }
  private localChanged(project: Project, mark: SyncMark): boolean {
    const tasks = this.ctx.state.tasks.filter((task) => task.projectId === project.id);
    return mark.dirty || tasks.length !== mark.tasks || project.updatedAt > mark.since || tasks.some((task) => task.updatedAt > mark.since);
  }
  async detectRepository(input: unknown): Promise<unknown> {
    const path = text(jsonObject(input).path, 'path', 4096); if (!isAbsolute(path)) throw new ControlError('Path must be absolute.');
    try { return await this.github.detect(path); }
    catch (error) { if (error instanceof MissingGitHubRemote) return { repository: null, canCreateRepository: true, suggestedName: basename(path), warning: error.message }; throw error; }
  }
  async connectProject(projectId: string, input: unknown): Promise<Project> {
    const project = this.ctx.project(projectId);
    if (project.general) throw new ControlError('The general workspace cannot connect to GitHub.', 409); const { createRepository, repositoryName, repositoryOwner, repositoryPrivate, importLabels, exportLabels, ...options } = jsonObject(input);
    if (createRepository !== undefined && typeof createRepository !== 'boolean') throw new ControlError('createRepository must be boolean.');
    if ((importLabels !== undefined && typeof importLabels !== 'boolean') || (exportLabels !== undefined && typeof exportLabels !== 'boolean')) throw new ControlError('importLabels and exportLabels must be boolean.');
    if (createRepository) {
      const created = await this.github.createRepository(project.repositoryPath, { ...(repositoryName === undefined ? {} : { name: repositoryName as string }), ...(repositoryOwner === undefined ? {} : { owner: repositoryOwner as string }), ...(repositoryPrivate === undefined ? {} : { private: repositoryPrivate as boolean }), description: project.description });
      this.ctx.event(null, null, 'github.repository', `Created GitHub repository ${created.repository}.${created.warning ? ` ${created.warning}` : ''}`, { projectId, url: created.url, pushed: created.pushed });
      if (options.projectNumber === undefined) { options.createProject = true; options.projectTitle ??= project.name; }
      if (repositoryOwner !== undefined) { options.projectOwner ??= repositoryOwner; options.projectOwnerType ??= 'organization'; }
    }
    const connection = await this.github.connect(project.repositoryPath, options); const connected = this.deps.updateProject(projectId, { github: connection });
    // The connection is saved first; a label failure is reported without undoing it.
    try {
      if (importLabels) await this.deps.importLabels(projectId, { overwrite: false });
      if (exportLabels) await this.deps.exportLabels(projectId);
    } catch (error) { this.ctx.event(null, null, 'github.error', `Labels: ${(error as Error).message}`, { projectId }); this.ctx.changed(); }
    return importLabels || exportLabels ? structuredClone(this.ctx.project(projectId)) : connected;
  }
  async authStatus(): Promise<GitHubAuthStatus> { return await this.github.authStatus(); }
  /** Open the GitHub CLI device login on this computer, requesting repository and Projects access. */
  async authorize(): Promise<{ launched: boolean; command: string; message: string }> {
    const status = await this.github.authStatus();
    if (status.source === 'environment' || status.source === 'service') return { launched: false, command: '', message: 'GitHub access comes from a configured token. Grant it repo and project access, or remove it to use gh auth.' };
    const scopes = REQUIRED_SCOPES.join(',');
    const command = status.authenticated ? `gh auth refresh -h github.com -s ${scopes}` : `gh auth login -h github.com -w -s ${scopes}`;
    const spawnDetached = (executable: string, args: string[]) => new Promise<boolean>((done) => {
      try { const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false }); child.once('error', () => done(false)); child.once('spawn', () => { child.unref(); done(true); }); } catch { done(false); }
    });
    let launched = false;
    if (process.platform === 'win32') launched = await spawnDetached('powershell.exe', ['-NoProfile', '-Command', `Start-Process cmd.exe -ArgumentList '/k', '${command} && echo. && echo GitHub access updated. You can close this window.'`]);
    else if (process.platform === 'darwin') launched = await spawnDetached('osascript', ['-e', `tell application "Terminal" to do script "${command}"`, '-e', 'tell application "Terminal" to activate']);
    this.github.resetCredential();
    return { launched, command, message: launched ? 'Complete the GitHub sign-in in the opened window, then check the status again.' : `Run this command in a terminal on the control-center computer: ${command}` };
  }
  /** `remoteMark` is the change mark read just before this sync; without one the next poll synchronizes again. */
  async sync(projectId: string, remoteMark: string | null = null): Promise<Project> {
    const { ctx } = this, state = ctx.state;
    const project = ctx.project(projectId); if (!project.github) throw new ControlError('Project is not connected to GitHub.');
    if (this.syncingProjects.has(projectId)) throw new ControlError('Project sync is already running.', 409);
    this.syncingProjects.add(projectId);
    const before = state.tasks.filter((task) => task.projectId === projectId).map((task) => structuredClone(task)), milestonesBefore = structuredClone(project.milestones ?? []);
    const projectUpdatedAt = project.updatedAt; let dirty = false;
    const started = new Date(Date.now() - 60_000).toISOString();
    state.githubWatch ??= {};
    const watch = state.githubWatch[projectId] ??= { connectedAt: now(), issuesSince: now(), commentsSince: now(), seenComments: [] };
    try {
      const result = await this.github.sync(structuredClone(project), before, ctx.providerSettings(projectId).defaultProvider, { intakeSince: watch.issuesSince, connectedAt: watch.connectedAt, trigger: state.settings.githubTrigger, ignored: state.ignoredGitHubIssues?.[projectId] ?? [], images: this.deps.attachments });
      if (ctx.closing) return structuredClone(project);
      // Preserve edits that arrived while network requests were in flight, but retain remote IDs.
      const previous = new Map(before.map((task) => [task.id, task]));
      for (const remote of result.tasks) {
        if (remote.github && state.ignoredGitHubIssues?.[projectId]?.includes(remote.github.issueNumber)) continue;
        const current = state.tasks.find((task) => task.id === remote.id || (remote.github && task.projectId === projectId && task.github?.issueNumber === remote.github.issueNumber));
        if (current) {
          const original = previous.get(current.id);
          if (original && current.updatedAt !== original.updatedAt) { dirty = true; if (remote.github) current.github = remote.github; }
          else {
            const active = ctx.running(current);
            const deliveryPending = !!current.currentRunId && ['review', 'completing', 'failed'].includes(current.status) && this.deps.hasMergeTarget(current) && !this.deps.dependencySatisfied(current);
            const activeStatus = current.status; Object.assign(current, remote); if (active || deliveryPending) current.status = activeStatus;
            if (!remote.milestoneId) delete current.milestoneId;
          }
        } else state.tasks.push({ ...remote, projectId });
      }
      if (result.milestones) this.deps.applyMilestones(project, milestonesBefore, result.milestones);
      const learned = mergeLabels(project.labels ?? [], result.labels ?? []);
      if (learned.added.length) project.labels = learned.labels;
      const tags = state.tasks.filter((item) => item.projectId === projectId && item.tags?.length).flatMap((task) => task.tags!);
      if (tags.length) this.deps.learnLabels(projectId, [...new Set(tags)]);
      // Edits that arrived during the sync were kept locally, so they still have to be pushed.
      if (project.updatedAt !== projectUpdatedAt) dirty = true;
      project.updatedAt = now(); this.lastCheck.set(projectId, Date.now());
      this.marks.set(projectId, { remote: remoteMark, since: project.updatedAt, tasks: state.tasks.filter((task) => task.projectId === projectId).length, dirty, at: Date.now() });
      if (started > watch.issuesSince) watch.issuesSince = started;
      try {
        const comments = await this.github.comments(project, watch.commentsSince);
        if (ctx.closing) return structuredClone(project);
        await this.processComments(project, comments, watch);
        if (started > watch.commentsSince) watch.commentsSince = started;
      } catch (error) { if (!ctx.closing) ctx.event(null, null, 'github.comments.error', (error as Error).message, { projectId }); }
      ctx.event(null, null, 'github.sync', `Synchronized ${project.name}.`, { projectId }); ctx.changed(); return structuredClone(project);
    } catch (error) { if (!ctx.closing) { this.lastCheck.set(projectId, Date.now()); ctx.event(null, null, 'github.error', (error as Error).message, { projectId }); ctx.changed(); } throw error; }
    finally { this.syncingProjects.delete(projectId); }
  }
  /**
   * Imports every repository issue (open and closed) that no task of the project holds yet. It needs no GitHub Project:
   * the repository comes from the connection or the folder's github.com remote, and nothing is written to GitHub.
   */
  async downloadIssues(projectId: string): Promise<{ imported: number; repository: string }> {
    const { ctx } = this, state = ctx.state, project = ctx.project(projectId);
    if (project.general) throw new ControlError('The general workspace has no GitHub repository.', 409);
    if (this.syncingProjects.has(projectId)) throw new ControlError('Project sync is already running.', 409);
    this.syncingProjects.add(projectId);
    try {
      const repository = await this.github.issueRepository(project), issues = await this.github.issues(repository);
      if (ctx.closing) return { imported: 0, repository };
      const tasks = state.tasks.filter((task) => task.projectId === projectId);
      const known = new Set(tasks.flatMap((task) => task.github?.issueNumber ? [task.github.issueNumber] : []));
      const markers = tasks.map((task) => taskMarker(task.id));
      const defaultProvider = ctx.providerSettings(projectId).defaultProvider, seen: ProjectLabel[] = [], imported: Task[] = [];
      for (const issue of issues) {
        if (!Number.isSafeInteger(issue.number) || known.has(issue.number) || markers.some((marker) => String(issue.body ?? '').includes(marker))) continue;
        const timestamp = now(), title = String(issue.title ?? ''), description = await this.github.issueDescription(repository, String(issue.body ?? ''), this.deps.attachments);
        const status = issue.state === 'closed' ? (issue.state_reason === 'not_planned' ? 'cancelled' : 'done') : 'backlog';
        const labels = remoteLabels(issue.labels), tags = labels.map((label) => label.name); seen.push(...labels);
        const milestoneNumber = Number.isSafeInteger(issue.milestone?.number) ? issue.milestone.number as number : null;
        const milestoneId = milestoneNumber === null ? undefined : project.milestones?.find((milestone) => milestone.github?.number === milestoneNumber)?.id;
        imported.push({ id: newId('task'), projectId, title, description, status, provider: defaultProvider, priority: 0, tags, ...(milestoneId ? { milestoneId } : {}), dependsOn: [], autoStart: false, currentRunId: null, createdAt: timestamp, updatedAt: timestamp,
          github: { issueNumber: issue.number, issueUrl: String(issue.html_url ?? ''), ...(issue.node_id ? { issueId: String(issue.node_id) } : {}), updatedAt: timestamp, lastSyncedAt: timestamp, baseline: { title, description, status, labels: tags, milestone: milestoneNumber } } });
        known.add(issue.number);
      }
      if (ctx.closing) return { imported: 0, repository };
      state.tasks.push(...imported);
      // Downloading an issue again also brings back one whose task was deleted earlier.
      const ignored = state.ignoredGitHubIssues?.[projectId];
      if (ignored) state.ignoredGitHubIssues![projectId] = ignored.filter((number) => !imported.some((task) => task.github?.issueNumber === number));
      const learned = mergeLabels(project.labels ?? [], seen);
      if (learned.added.length) { project.labels = learned.labels; project.updatedAt = now(); }
      ctx.event(null, null, 'github.issues', `Downloaded ${imported.length} issue(s) from ${repository}.`, { projectId, repository, imported: imported.length });
      ctx.changed(); return { imported: imported.length, repository };
    } finally { this.syncingProjects.delete(projectId); }
  }
  /** Mirror the outcome of a run on its GitHub issue: the explicit reply, else the agent's last message. */
  postRunReply(task: Task, run: Run, status: Run['status'], summary?: string): void {
    const project = this.ctx.state.projects.find((item) => item.id === task.projectId);
    if (!project?.github || !task.github?.issueNumber || task.externalDependency) return;
    const messages = this.ctx.state.messages; let last: string | undefined;
    for (let index = messages.length - 1; index >= 0 && last === undefined; index--) if (messages[index]!.runId === run.id && messages[index]!.authorType === 'agent') last = messages[index]!.text;
    const body = run.reply?.trim() || last?.trim() || summary?.trim() || '';
    const agent = run.executionSnapshot?.agent?.name ?? run.provider;
    const heading = status === 'completed' ? `✅ **AIWS · ${agent}** finished${task.status === 'review' ? ' — ready for review' : ''}.` : `❌ **AIWS · ${agent}** failed.`;
    this.postIssueComment(project, task, `${heading}\n\n${body}`.trim(), run.id);
  }
  /** Comments go to a possibly public issue, so they carry no secrets the agent may have printed. */
  postIssueComment(project: Project, task: Task, body: string, runId: string | null = null): void {
    const issueNumber = task.github?.issueNumber; if (!issueNumber) return;
    void this.github.comment(project, issueNumber, this.ctx.journal.redact(body), this.deps.attachments).then((comment) => {
      if (this.ctx.closing) return; this.ctx.event(runId, task.id, 'github.comment', `Posted a comment on issue #${issueNumber}.`, { url: comment.url }); this.ctx.changed();
    }).catch((error) => { if (!this.ctx.closing && this.ctx.state.tasks.includes(task)) { this.ctx.event(runId, task.id, 'github.comment.error', (error as Error).message); this.ctx.changed(); } });
  }
  /** Turn trusted issue comments into answers for pending agent questions, or into new agent requests when they use the trigger. */
  private async processComments(project: Project, comments: IssueComment[], watch: GitHubWatch): Promise<void> {
    const { ctx } = this, trigger = ctx.state.settings.githubTrigger;
    for (const comment of comments) {
      if (ctx.closing) return;
      if (watch.seenComments.includes(comment.id)) continue;
      watch.seenComments = [...watch.seenComments, comment.id].slice(-1000);
      if (comment.body.includes(COMMENT_MARKER) || comment.createdAt < watch.connectedAt) continue;
      const task = ctx.state.tasks.find((item) => item.projectId === project.id && !item.externalDependency && !item.archivedAt && item.github?.issueNumber === comment.issueNumber);
      if (!task) continue;
      const request = triggeredRequest(comment.body, trigger);
      const pending = ctx.state.questions.find((question) => question.taskId === task.id && question.status === 'pending');
      if ((pending || request !== null) && !trustedAuthor(comment.association)) {
        ctx.event(null, task.id, 'github.comment.ignored', `Ignored a request from @${comment.author} (${comment.association}); only owners, members and collaborators may direct agents.`, { url: comment.url });
        continue;
      }
      try {
        if (pending) {
          const answer = (request ?? comment.body).trim() || comment.body.trim();
          if (pending.source === 'terminal') this.deps.answerNativePrompt(pending, answer); else this.deps.answer(pending.id, { answer });
          ctx.event(null, task.id, 'github.answer', `@${comment.author} answered from GitHub.`, { url: comment.url });
        } else if (request !== null) await this.request(task, request, comment);
        else continue;
        void this.github.react(project, comment.id, 'eyes').catch(() => {});
      } catch (error) {
        const message = (error as Error).message.replace(/^HISTORY_FALLBACK_CONFIRMATION:\s*/, '');
        ctx.event(null, task.id, 'github.request.error', message, { url: comment.url });
        void this.github.react(project, comment.id, 'confused').catch(() => {});
        this.postIssueComment(project, task, `⚠️ **AIWS could not start this request:** ${message}`);
      }
    }
  }
  private async request(task: Task, request: string, comment: IssueComment): Promise<void> {
    const { ctx } = this;
    const instruction = `Request from @${comment.author} on GitHub issue #${comment.issueNumber} (${comment.url}):\n${request || 'Report the current status of this task.'}\n\nAnswer it; record your answer with aiws control reply so it is posted back to the issue.`;
    const previous = ctx.lastRun(task);
    ctx.event(null, task.id, 'github.request', `@${comment.author}: ${request}`, { url: comment.url });
    if (previous && !runEnded(previous)) { this.deps.postMessage(task.id, { text: instruction, authorType: 'user' }); return; }
    if (previous) { await this.deps.sendTaskMessage(task.id, { text: instruction, continueSession: true, allowHistoryFallback: true }); return; }
    // Never-run tasks keep the request for their first run and join the queue.
    task.githubInstructions = [...(task.githubInstructions ?? []), instruction].slice(-20);
    ctx.addMessage(task.id, 'user', instruction);
    if (!['ready', 'running', 'waiting', 'paused'].includes(task.status)) task.status = 'ready';
    task.updatedAt = now(); ctx.changed();
  }
}
