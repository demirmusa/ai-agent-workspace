import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { ControlStore } from '../store.js';
import { WorkflowCatalog, selectWorkflow, snapshotWorkflow, nextWorkflowStep } from '../workflows.js';
import type { AgentDefinition, Project, Task } from '../types.js';
const project: Project = { id: 'project_a', name: 'Project', description: '', repositoryPath: '.', github: null, createdAt: '', updatedAt: '' };
const agent: AgentDefinition = { id: 'frontend', name: 'Frontend', provider: 'command', command: { executable: 'node', args: [] }, description: '', instructions: '', context: '', skillIds: [], enabled: true, revision: 1, createdAt: '', updatedAt: '' };
const task: Task = { id: 'task_a', projectId: project.id, title: 'Task', description: '', status: 'backlog', provider: 'command', priority: 0, autoStart: false, dependsOn: [], currentRunId: null, createdAt: '', updatedAt: '' };
describe('Ordered workflow definitions', () => {
  it('persists named stages, freezes an ordered snapshot and gates optional deployment semantically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-workflow-library-')); let store = new ControlStore(directory);
    try {
      store.state.projects.push(project); store.state.agents.push(agent, { ...agent, id: 'deploy', name: 'Build and deploy' });
      const catalog = new WorkflowCatalog(store, () => store.save());
      const definition = catalog.create({ name: 'Frontend to deployment', projectId: project.id, steps: [{ name: 'Frontend', agentId: 'frontend' }, { name: 'Build and deploy', agentId: 'deploy', condition: 'deploy_requested' }] });
      expect(selectWorkflow(task, project, [definition])?.id).toBe(definition.id);
      const snapshot = snapshotWorkflow(definition, task);
      expect(nextWorkflowStep(snapshot, -1, task)).toBe(0);
      expect(nextWorkflowStep(snapshot, 0, task)).toBeNull();
      expect(nextWorkflowStep(snapshot, 0, { requestedActions: ['deploy'] })).toBe(1);
      catalog.update(definition.id, { steps: [{ name: 'Changed', agentId: 'deploy' }] });
      expect(snapshot.steps.map((step) => step.agentId)).toEqual(['frontend', 'deploy']);
      store.close(); store = new ControlStore(directory); expect(store.state.workflows[0]?.revision).toBe(2);
      expect(store.state.workflows[0]?.steps[0]?.name).toBe('Changed');
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('rejects unknown named agents and ambiguous automatic workflows', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'aiws-workflow-rules-')); const store = new ControlStore(directory);
    try {
      store.state.projects.push(project); store.state.agents.push(agent); const catalog = new WorkflowCatalog(store, () => store.save());
      expect(() => catalog.create({ name: 'Broken', steps: [{ name: 'Unknown', agentId: 'invented' }] })).toThrow('configured named agent');
      const first = catalog.create({ name: 'One', steps: [{ name: 'Frontend', agentId: agent.id }] });
      const second = catalog.create({ name: 'Two', steps: [{ name: 'Frontend', agentId: agent.id }] });
      expect(() => selectWorkflow(task, project, [first, second])).toThrow('Choose its workflow explicitly');
      expect(selectWorkflow({ ...task, workflowId: second.id }, project, [first, second])?.id).toBe(second.id);
    } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
