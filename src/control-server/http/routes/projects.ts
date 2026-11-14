import { resolve } from 'node:path';
import { ControlError } from '../../types.js';
import { findScriptCandidates, powerShellScriptParameters } from '../../run-scripts.js';
import { EDITABLE_FILE_BYTES, createProjectFile, listProjectFiles, openProjectPath, readProjectFile, searchProjectFiles, writeProjectFile } from '../../project-files.js';
import { MAX_ATTACHMENT_BODY, PROJECT_ATTACHMENTS } from '../../attachments.js';
import type { RouteContext, RouteHandler } from './context.js';

/** Project API: projects and their terminals, files, Git panel, provider sessions, labels, milestones and planning. */
async function terminals(c: RouteContext, projectId: string): Promise<boolean> {
  const { service } = c, project = service.project(projectId), terminalId = c.parts[4], step = c.parts[5], shells = service.projectTerminals;
  if (!terminalId && c.method === 'GET') return c.send(200, shells.list(projectId));
  if (!terminalId && c.method === 'POST') return c.send(201, await shells.create(project, await c.body()));
  if (!terminalId) return false;
  if (!step && c.method === 'PATCH') return c.send(200, shells.rename(projectId, terminalId, await c.body()));
  if (step === 'task' && c.method === 'POST') { await c.body(); return c.send(201, await service.convertTerminalToTask(projectId, terminalId)); }
  if (step === 'restart' && c.method === 'POST') { await c.body(); return c.send(200, await shells.restart(projectId, terminalId)); }
  if (!step && c.method === 'GET') return c.send(200, shells.list(projectId).find((run) => run.id === terminalId) ?? shells.get(projectId, terminalId).run);
  if (step === 'terminal' && c.method === 'GET') return c.send(200, shells.terminal(projectId, terminalId));
  if (!step && c.method === 'DELETE') { await shells.remove(projectId, terminalId); return c.ok(); }
  if (step === 'input' && c.method === 'POST') { shells.input(projectId, terminalId, await c.body()); return c.ok(); }
  if (step === 'images' && c.method === 'POST') {
    if (shells.get(projectId, terminalId).run.status !== 'running') throw new ControlError('Terminal has exited.', 409);
    // Project shells share the repository, so pasted images go to its ignored `.aiws` work folder.
    const image = await service.attachments.upload(await c.body(MAX_ATTACHMENT_BODY), project.repositoryPath);
    return c.send(201, { ...image, path: resolve(project.repositoryPath, PROJECT_ATTACHMENTS, image.id) });
  }
  if (step === 'clear' && c.method === 'POST') { shells.clear(projectId, terminalId); return c.ok(); }
  if (step === 'resize' && c.method === 'POST') { shells.resize(projectId, terminalId, await c.body()); return c.ok(); }
  return false;
}

/** The folder file requests work in: the project folder, or with `?task=` that task's worktree. The client names ids, never a root path. */
function filesRoot(c: RouteContext, projectId: string): string {
  const project = c.service.project(projectId), taskId = c.query.get('task');
  if (!taskId) return project.repositoryPath;
  const task = c.service.task(taskId);
  if (task.projectId !== projectId || !task.worktree?.path || task.worktree.cleanedAt) throw new ControlError('This task has no worktree.', 404);
  return task.worktree.path;
}

async function files(c: RouteContext, repositoryPath: string): Promise<boolean> {
  const step = c.parts[4];
  if (step === 'content' && !c.parts[5]) {
    if (c.method === 'GET') return c.send(200, await readProjectFile(repositoryPath, c.query.get('path') ?? ''));
    // JSON escaping makes the body larger than the file it carries.
    if (c.method === 'PUT') return c.send(200, await writeProjectFile(repositoryPath, await c.body(EDITABLE_FILE_BYTES * 3)));
    return false;
  }
  if (!step && c.method === 'GET') return c.send(200, await listProjectFiles(repositoryPath, c.query.get('path') ?? ''));
  if (step === 'search' && !c.parts[5] && c.method === 'GET') return c.send(200, await searchProjectFiles(repositoryPath, c.query.get('q') ?? '', c.query.get('limit') ?? undefined));
  if (step === 'open' && !c.parts[5] && c.method === 'POST') return c.send(200, await openProjectPath(repositoryPath, await c.body()));
  if (step === 'create' && !c.parts[5] && c.method === 'POST') return c.send(201, await createProjectFile(repositoryPath, await c.body()));
  return false;
}

async function git(c: RouteContext, projectId: string): Promise<boolean> {
  const { service } = c, step = c.parts[4], worktree = c.query.get('worktree') ?? undefined;
  if (!step && c.method === 'GET') return c.send(200, await service.gitOverview(projectId));
  if (step === 'changes' && !c.parts[5]) {
    if (c.method === 'GET' && c.query.has('file')) return c.send(200, await service.changeFile({ projectId, worktree }, c.query.get('file')));
    if (c.method === 'POST') { const input = await c.body() as { file?: unknown; action?: unknown }; return c.send(200, await service.changeFile({ projectId, worktree }, input?.file, input?.action)); }
    if (c.method === 'GET') return c.send(200, await service.gitChanges(projectId, worktree));
  }
  if (step === 'merge' && !c.parts[5] && c.method === 'POST') return c.send(200, await service.mergeRepositoryBranch(projectId, await c.body()));
  if (step === 'delete' && !c.parts[5] && c.method === 'POST') return c.send(200, await service.deleteGitTarget(projectId, await c.body()));
  if (step === 'folders' && c.parts[5] === 'open' && !c.parts[6] && c.method === 'POST') return c.send(200, await service.openGitFolder(projectId, await c.body()));
  if (step === 'folders' && c.parts[5] === 'delete' && !c.parts[6] && c.method === 'POST') return c.send(200, await service.deleteGitFolders(projectId, await c.body()));
  if (step && !c.parts[5] && c.method === 'POST') return c.send(200, await service.gitCommand(projectId, step, await c.body()));
  return false;
}

async function sessions(c: RouteContext, projectId: string): Promise<boolean> {
  const { service } = c, project = service.project(projectId), sourceId = c.parts[4], step = c.parts[5];
  if (sourceId === 'import' && c.method === 'POST') { await c.body(); return c.send(200, await service.importSessions(projectId)); }
  if (sourceId && step === 'import' && !c.parts[6] && c.method === 'POST') { await c.body(); return c.send(200, await service.importSession(projectId, sourceId)); }
  if (sourceId && step === 'agents' && c.method === 'GET') {
    if (!c.parts[6]) return c.send(200, await service.agentGraph.tree(project, { sourceId }));
    if (c.parts[7] === 'transcript') return c.send(200, await service.agentGraph.transcript(project, { sourceId }, c.parts[6], c.params()));
  }
  if (!sourceId && c.method === 'GET') { const page = await service.history.list(project, c.params()); await service.historyImporter.reconcile(project, page.items); return c.send(200, page); }
  if (sourceId && !step && c.method === 'GET') return c.send(200, await service.history.detail(project, sourceId, c.params()));
  if (sourceId && step === 'resume' && c.method === 'POST') return c.send(201, await service.resumeSession(projectId, sourceId, await c.body()));
  if (sourceId && step === 'compact' && c.method === 'POST') return c.send(201, await service.compactSession(projectId, sourceId, await c.body()));
  return false;
}

export const projectRoutes: Record<string, RouteHandler> = {
  async projects(c) {
    const { service } = c, id = c.id, action = c.action, step = c.parts[4];
    if (!id) {
      if (c.method === 'GET') return c.send(200, service.publicState(false).projects);
      if (c.method === 'POST') return c.send(201, service.createProject(await c.body()));
      return false;
    }
    if (id === 'reorder' && !action && c.method === 'POST') return c.send(200, service.reorderProjects(await c.body()));
    switch (action) {
      case undefined:
        if (c.method === 'GET') return c.send(200, service.project(id));
        if (c.method === 'PATCH') return c.send(200, service.updateProject(id, await c.body()));
        if (c.method === 'DELETE') { service.deleteProject(id); return c.ok(); }
        return false;
      case 'script-candidates': return c.method === 'GET' && c.send(200, await findScriptCandidates(service.project(id).repositoryPath));
      case 'script-parameters': return c.method === 'GET' && c.send(200, { parameters: await powerShellScriptParameters(service.project(id).repositoryPath, c.query.get('path') ?? '') });
      case 'run-script-history':
        if (!step) return false;
        service.project(id);
        if (c.method === 'GET') return c.send(200, { history: service.runScriptMemory.history(id, step) });
        if (c.method === 'PUT') return c.send(200, { history: service.runScriptMemory.save(id, step, (await c.body() as { history?: unknown }).history) });
        return false;
      case 'terminals': return terminals(c, id);
      case 'files': return files(c, filesRoot(c, id));
      case 'branches': return c.method === 'GET' && c.send(200, await service.branches(id));
      case 'git': return git(c, id);
      case 'sessions': return sessions(c, id);
      case 'sync': return c.method === 'POST' && c.send(200, await service.sync(id));
      case 'issues':
        if (step === 'download' && !c.parts[5] && c.method === 'POST') { await c.body(); return c.send(200, await service.downloadIssues(id)); }
        return false;
      case 'plan': return c.method === 'POST' && c.send(200, await service.plan(id, await c.body()));
      case 'draft':
        if (step === 'cancel' && c.method === 'POST') return c.send(200, service.cancelDraft(id, await c.body()));
        return !step && c.method === 'POST' && c.send(200, await service.draft(id, await c.body()));
      case 'organize':
        if (step === 'cancel' && c.method === 'POST') return c.send(200, service.cancelOrganize(id, await c.body()));
        return !step && c.method === 'POST' && c.send(202, service.organize(id, await c.body()));
      case 'labels':
        if (!step && c.method === 'PUT') return c.send(200, service.setProjectLabels(id, await c.body()));
        if (step === 'import' && c.method === 'POST') return c.send(200, await service.importGitHubLabels(id, await c.body()));
        if (step === 'export' && c.method === 'POST') { await c.body(); return c.send(200, await service.exportGitHubLabels(id)); }
        return false;
      case 'milestones':
        if (!step && c.method === 'POST') return c.send(201, service.createMilestone(id, await c.body()));
        if (step === 'current' && !c.parts[5] && c.method === 'PUT') return c.send(200, service.setCurrentMilestone(id, await c.body()));
        if (step === 'assign' && !c.parts[5] && c.method === 'POST') return c.send(200, service.assignMilestone(id, await c.body()));
        if (step && !c.parts[5] && c.method === 'PATCH') return c.send(200, service.updateMilestone(id, step, await c.body()));
        if (step && !c.parts[5] && c.method === 'DELETE') return c.send(200, service.deleteMilestone(id, step));
        return false;
      case 'connect': return c.method === 'POST' && c.send(200, await service.connectProject(id, await c.body()));
      default: return false;
    }
  },
};
