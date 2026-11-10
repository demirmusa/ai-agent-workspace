import { describe, expect, it } from 'vitest';
import { parsePlanOutput, validatePlan, validateIntakeDraft, validateWorkspaceDrafts, planningActivity } from '../assistant.js';
import type { AgentDefinition, Project, Task, SkillDefinition, WorkflowDefinition } from '../types.js';
const agent: AgentDefinition = { id: 'agent_frontend', name: 'Frontend', provider: 'codex', description: '', instructions: '', context: '', skillIds: [], enabled: true, revision: 1, createdAt: '', updatedAt: '' };
const workflow: WorkflowDefinition = { id: 'workflow_release', name: 'Release', description: '', projectId: 'project_a', enabled: true, trigger: 'always', steps: [{ id: 'implementation', name: 'Frontend', agentId: agent.id, instructions: 'Private stage instructions', condition: 'always' }, { id: 'deploy', name: 'Deployment', agentId: 'agent_deploy', instructions: 'Private deployment instructions', condition: 'deploy_requested' }], revision: 1, createdAt: '', updatedAt: '' };
const options = { agents: [agent], workflows: [workflow] };
describe('Planning provider output validation', () => {
  it('extracts real provider final messages and preserves semantic workflow intent and dependency order', () => {
    const value = { reply: 'İki görev oluşturuyorum.', executionRequested: true, requestedActions: ['deploy'], tasks: [{ title: 'Prepare implementation', description: 'Implement and test the change.', status: 'ready', agentId: agent.id, workflowId: workflow.id }, { title: 'Follow-up', description: 'Verify the preceding work.', status: 'backlog', dependsOn: [0], workflowId: workflow.id }] };
    const stream = [JSON.stringify({ type: 'thread.started', thread_id: 'session' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(value) } })].join('\n');
    expect(parsePlanOutput(stream, options, 'project_a')).toMatchObject({ requestedActions: ['deploy'], tasks: [{ workflowId: workflow.id, requestedActions: ['deploy'], status: 'ready' }, { dependsOn: [0] }] });
    expect(parsePlanOutput(JSON.stringify({ type: 'result', result: `\`\`\`json\n${JSON.stringify(value)}\n\`\`\`` }), options, 'project_a').tasks).toHaveLength(2);
  });
  it('finds the JSON object when the provider wraps it in prose', () => {
    const value = { reply: 'Hazır {süslü} yanıt.', tasks: [] };
    const stream = JSON.stringify({ type: 'result', result: `Tamam, işte plan:
${JSON.stringify(value)}
Başka bir şey lazım mı?` });
    expect(parsePlanOutput(stream, options, 'project_a')).toMatchObject({ reply: value.reply, tasks: [] });
  });
  it('rejects invented colleagues, inaccessible workflows, forward dependencies and malformed output before task creation', () => {
    const base = { reply: 'Plan', tasks: [{ title: 'Task', description: 'Detailed instructions', agentId: agent.id, workflowId: workflow.id }] };
    expect(() => validatePlan({ ...base, tasks: [{ ...base.tasks[0], agentId: 'invented' }] }, options, 'project_a')).toThrow('unknown or disabled agent');
    expect(() => validatePlan(base, options, 'different_project')).toThrow('unavailable workflow');
    expect(() => validatePlan({ ...base, tasks: [{ ...base.tasks[0], dependsOn: [1] }] }, options, 'project_a')).toThrow('earlier task indexes');
    expect(() => parsePlanOutput('Here is a plan without JSON', options, 'project_a')).toThrow('No tasks were created');
  });
  it('keeps deployment requests blocked when no configured deployment stage exists', () => {
    const result = validatePlan({ reply: 'Deployment configuration is missing.', requestedActions: ['deploy'], tasks: [{ title: 'Implement', description: 'Work and then deploy.', status: 'ready', agentId: agent.id }] }, { agents: [agent], workflows: [] }, 'project_a');
    expect(result.tasks[0]).toMatchObject({ status: 'backlog', requestedActions: ['deploy'], workflowId: null });
  });
  it('reads the GitHub Copilot main agent final message, ignores subagent messages and surfaces session errors', () => {
    const value = { reply: 'Bir görev.', tasks: [{ title: 'Implement', description: 'Do the work.', status: 'backlog', agentId: agent.id }] };
    const line = (type: string, data: Record<string, unknown>) => JSON.stringify({ type, data, id: type, timestamp: '2026-10-20T10:00:00Z' });
    const stream = [line('session.tools_updated', { model: 'claude-sonnet-5.5' }), line('assistant.message', { messageId: 'm1', content: '', toolRequests: [{ toolCallId: 't1' }] }), line('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: { command: 'git status' } }),
      line('assistant.message', { messageId: 'sub', content: '{"reply":"subagent"}', parentToolCallId: 't9' }), line('assistant.message', { messageId: 'm2', content: JSON.stringify(value) }), JSON.stringify({ type: 'result', sessionId: 'c1296dcf-ba51-4a2f-9dda-98e25d0308d0', exitCode: 0 })].join('\n');
    expect(parsePlanOutput(stream, options, 'project_a')).toMatchObject({ reply: 'Bir görev.', tasks: [{ title: 'Implement' }] });
    expect(planningActivity(line('tool.execution_start', { toolCallId: 't1', toolName: 'bash', arguments: { command: 'git status' } }))).toBe('$ git status');
    expect(planningActivity(line('tool.execution_start', { toolCallId: 't2', toolName: 'view', arguments: { path: 'src/app.ts' } }))).toBe('view src/app.ts');
    expect(() => parsePlanOutput(line('session.error', { errorType: 'quota', message: 'You have exceeded your monthly quota' }), options, 'project_a')).toThrow('exceeded your monthly quota');
  });
  it('surfaces structured provider errors and accepts clarification conversations without tasks', () => {
    expect(() => parsePlanOutput(JSON.stringify({ type: 'error', error: { data: { message: 'Token refresh failed: 401' } } }), options, 'project_a')).toThrow('Token refresh failed: 401');
    expect(validatePlan({ reply: 'Which environment should I use?', tasks: [] }, options, 'project_a').tasks).toEqual([]);
    expect(validatePlan({ reply: 'Created a draft.', tasks: [{ title: 'Draft', description: 'Do the work later.', status: 'ready' }] }, options, 'project_a').tasks[0]?.status).toBe('backlog');
  });
});

describe('Read-only intake draft validation', () => {
  const project: Project = { id: 'project_a', name: 'Project', description: '', repositoryPath: '.', github: { repository: 'owner/repo', owner: 'owner', number: 1 }, createdAt: '', updatedAt: '' };
  const existing = { id: 'task_blocker', projectId: project.id } as Task;
  const skill = { id: 'skill_review' } as SkillDefinition;
  const intakeOptions = { ...options, existingTasks: [existing], skillsCatalog: [skill] };
  const value = { reply: 'Formdaki taslağı hazırladım; kaydetmeden görev oluşmaz.', draft: { title: 'Search accessibility', description: 'Improve keyboard navigation and verify focus order.', status: 'ready', agentId: agent.id, workflowId: workflow.id, skillIds: [skill.id], priority: 100, dependsOn: [existing.id], dependencyRefs: ['#123'], terminalMode: 'pty', requestedActions: ['deploy'], autoMerge: true } };
  it('fills visible advanced fields while discarding execution authorization and preserving current edits', () => {
    const result = validateIntakeDraft(value, { ...intakeOptions, currentDraft: { model: 'chosen-model', tags: ['accessibility'], id: 'never-an-existing-id' } }, project);
    expect(result.draft).toMatchObject({ title: value.draft.title, status: 'backlog', priority: 100, skillIds: [skill.id], dependsOn: [existing.id], dependencyRefs: ['#123'], agentId: agent.id, workflowId: workflow.id, autoMerge: true, model: 'chosen-model', tags: ['accessibility'] });
    expect(result.draft).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('executionRequested');
  });
  it('rejects invented references and executable fields instead of turning them into actions', () => {
    const invalid = (fields: Record<string, unknown>) => () => validateIntakeDraft({ ...value, draft: { ...value.draft, ...fields } }, intakeOptions, project);
    expect(invalid({ dependsOn: ['invented'] })).toThrow('existing tasks');
    expect(invalid({ skillIds: ['invented'] })).toThrow('unknown skill');
    expect(invalid({ dependencyRefs: ['https://github.com/elsewhere/repo/issues/123'] })).toThrow('#issue-number');
    expect(invalid({ status: 'running' })).toThrow('active or completed');
    expect(invalid({ priority: Number.POSITIVE_INFINITY })).toThrow('priority');
    expect(invalid({ command: { executable: 'sh' } })).toThrow('Unsupported intake draft field');
    expect(invalid({ provider: 'command', agentId: null })).toThrow('configured command agent');
    expect(() => validateIntakeDraft(value, intakeOptions, { ...project, github: null })).toThrow('linked repository');
  });
  it('can ask for clarification without returning a draft or a task creation payload', () => {
    expect(validateIntakeDraft({ reply: 'Hangi sayfayı değiştirelim?', draft: null }, intakeOptions, project)).toEqual({ reply: 'Hangi sayfayı değiştirelim?', draft: null });
    expect(() => validateIntakeDraft({ reply: 'Done', tasks: [] }, intakeOptions, project)).toThrow('draft or null');
  });
});

describe('Read-only workspace draft validation', () => {
  const project: Project = { id: 'project_a', name: 'Project', description: '', repositoryPath: '.', github: null, createdAt: '', updatedAt: '' };
  const existing = { id: 'task_blocker', projectId: project.id } as Task;
  const workspaceOptions = { ...options, existingTasks: [existing], skillsCatalog: [] };
  it('keeps stable keys, forces backlog and only accepts dependencies on earlier drafts', () => {
    const result = validateWorkspaceDrafts({ reply: 'Üç görev öneriyorum.', drafts: [
      { key: 'api', title: 'Build API', description: 'Implement the endpoint.', status: 'ready', dependsOn: [existing.id], dependsOnDrafts: ['ui'] },
      { key: 'ui', title: 'Build UI', description: 'Use the endpoint.', priority: 3, dependsOnDrafts: ['api', 'api', 'missing', 'ui'] },
      { key: 'api', title: 'Duplicate key', description: 'Gets a fresh key.', dependsOnDrafts: ['api', 'ui'] },
    ] }, workspaceOptions, project);
    expect(result.drafts.map((draft) => draft.status)).toEqual(['backlog', 'backlog', 'backlog']);
    expect(result.drafts[0]).toMatchObject({ key: 'api', dependsOn: [existing.id], dependsOnDrafts: [] });
    expect(result.drafts[1]).toMatchObject({ key: 'ui', priority: 3, dependsOnDrafts: ['api'] });
    expect(result.drafts[2]!.key).toMatch(/^draft-/);expect(result.drafts[2]!.dependsOnDrafts).toEqual(['api', 'ui']);
    expect(validateWorkspaceDrafts({ reply: 'Hangi sayfa?', drafts: [] }, workspaceOptions, project)).toEqual({ reply: 'Hangi sayfa?', drafts: [] });
  });
  it('spells proposed tags like the project labels', () => {
    const labelled: Project = { ...project, labels: [{ name: 'Frontend', color: '1d76db', description: '' }] };
    expect(validateWorkspaceDrafts({ reply: 'Tek görev.', drafts: [{ key: 'one', title: 'T', description: 'D', tags: ['frontend', 'FRONTEND', 'docs'] }] }, workspaceOptions, labelled).drafts[0]!.tags).toEqual(['Frontend', 'docs']);
  });
  it('rejects malformed replies and invented references like single intake drafts', () => {
    expect(() => validateWorkspaceDrafts({ reply: 'Done', draft: null }, workspaceOptions, project)).toThrow('at most 30 drafts');
    expect(() => validateWorkspaceDrafts({ reply: 'Done', drafts: [{ key: 'a', title: 'T', description: 'D', command: { executable: 'sh' } }] }, workspaceOptions, project)).toThrow('Unsupported intake draft field');
    expect(() => validateWorkspaceDrafts({ reply: 'Done', drafts: [{ key: 'a', title: 'T', description: 'D', agentId: 'invented' }] }, workspaceOptions, project)).toThrow('unknown or disabled agent');
    expect(() => validateWorkspaceDrafts({ reply: 'Done', drafts: [{ key: 'a', title: 'T', description: 'D', dependsOn: ['invented'] }] }, workspaceOptions, project)).toThrow('existing tasks');
  });
  it('summarizes provider progress lines without exposing raw protocol output', () => {
    expect(planningActivity(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '**Reading the router**\n\nLooking at routes.' } }))).toBe('Reading the router Looking at routes.');
    expect(planningActivity(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'rg draft src' } }))).toBe('$ rg draft src');
    expect(planningActivity(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'src/app.js' } }] } }))).toBe('Read src/app.js');
    expect(planningActivity(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '{"reply":"x"}' } }))).toBeNull();
    expect(planningActivity('not json')).toBeNull();
  });
});
