import { GitHubApi } from './github-api.js';
import { GitHubImages } from './github-images.js';
import { deleteIssue, exportLabels, issueComments, lookupIssue, postComment, reactToComment, repositoryIssues, repositoryLabels, withoutTaskMarker, type IssueComment } from './github-issues.js';
import { connectRepository, createRepository, detectRepository, validateConnectOptions, type ConnectOptions, type CreateRepositoryOptions, type GitHubDiscovery } from './github-projects.js';
import { createTaskPullRequest, deleteRemoteBranch, mergePullRequest, pullRequestChanges, type PullRequestMerge } from './github-pulls.js';
import { remoteChangeMark, syncProject, type SyncOptions, type SyncResult } from './github-sync.js';
import type { ImageStore } from './attachments.js';
import type { GitChanges } from './repository-git.js';
import type { ControlProject, ControlTask, DefaultProvider, GitHubConnection, ProjectLabel } from './types.js';

export { REQUIRED_SCOPES, MissingGitHubRemote, githubRepositoryFromRemote, ghAuthToken, type GitHubAuthStatus } from './github-api.js';
export { ATTACHMENT_BRANCH, githubImageUrl } from './github-images.js';
export { COMMENT_MARKER, trustedAuthor, triggeredRequest, type IssueComment } from './github-issues.js';
export type { DiscoveredGitHubProject, GitHubDiscovery } from './github-projects.js';
export { PullRequestConflict } from './github-pulls.js';
export type { SyncOptions, SyncResult } from './github-sync.js';

/**
 * The control service's one GitHub client. Each job lives in its own module (issues, images, projects, pull requests,
 * sync); calls between them go through these methods so one place can observe or replace them.
 */
export class ControlGitHub extends GitHubApi {
  private readonly images = new GitHubImages(this);

  lookupIssue(project: ControlProject, number: number): ReturnType<typeof lookupIssue> { return lookupIssue(this, project, number); }
  deleteIssue(project: ControlProject, issue: { issueNumber: number; issueId?: string }): Promise<void> { return deleteIssue(this, project, issue); }
  /** Commits one content-addressed image to the attachment branch unless it is already there. */
  publishImage(repository: string, id: string, data: Buffer): Promise<string> { return this.images.publish(repository, id, data); }
  /** The project's repository: the connected one, else the github.com remote of its folder. */
  async issueRepository(project: ControlProject): Promise<string> { return project.github?.repository ?? await this.repositorySlug(project.repositoryPath); }
  issues(repository: string): Promise<any[]> { return repositoryIssues(this, repository); }
  /** An issue body as a task description: without AIWS task markers and with its images stored locally. */
  issueDescription(repository: string, body: string, images?: ImageStore): Promise<string> { return this.images.toLocal(repository, withoutTaskMarker(body), images); }
  labels(project: ControlProject): Promise<ProjectLabel[]> { return repositoryLabels(this, project); }
  async exportLabels(project: ControlProject, labels: ProjectLabel[]): Promise<{ created: string[]; updated: string[] }> { return exportLabels(this, project, labels, await this.labels(project)); }
  createRepository(repositoryPath: string, options: CreateRepositoryOptions = {}): ReturnType<typeof createRepository> { return createRepository(this, repositoryPath, options); }
  /** Posts a comment; local AIWS images in the body are published to GitHub first so the issue can show them. */
  async comment(project: ControlProject, issueNumber: number, body: string, images?: ImageStore): Promise<{ id: number; url: string }> {
    return postComment(this, project, issueNumber, project.github ? await this.images.toRemote(project.github.repository, body, images) : body);
  }
  react(project: ControlProject, commentId: number, content: 'eyes' | 'confused'): Promise<void> { return reactToComment(this, project, commentId, content); }
  comments(project: ControlProject, since: string): Promise<IssueComment[]> { return issueComments(this, project, since); }
  detect(repositoryPath: string): Promise<GitHubDiscovery> { return detectRepository(this, repositoryPath); }
  async connect(repositoryPath: string, options: ConnectOptions = {}): Promise<GitHubConnection> {
    validateConnectOptions(options);
    return connectRepository(this, await this.detect(repositoryPath), options);
  }
  deleteBranch(project: ControlProject, branch: string): Promise<boolean> { return deleteRemoteBranch(this, project, branch); }
  createTaskPullRequest(project: ControlProject, task: ControlTask): Promise<NonNullable<ControlTask['pullRequest']>> { return createTaskPullRequest(this, project, task); }
  pullRequestChanges(project: ControlProject, task: ControlTask): Promise<GitChanges> { return pullRequestChanges(this, project, task); }
  mergePullRequest(project: ControlProject, task: ControlTask): Promise<PullRequestMerge> { return mergePullRequest(this, project, task); }
  sync(project: ControlProject, tasks: ControlTask[], defaultProvider: DefaultProvider = 'codex', options: SyncOptions = {}): Promise<SyncResult> {
    return syncProject(this, this.images, project, tasks, defaultProvider, options);
  }
  /** A value that changes whenever the project's board, issues or milestones change on GitHub; null when it cannot be read. */
  changeMark(project: ControlProject): Promise<string | null> { return remoteChangeMark(this, project); }
}
