import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, symlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { startControlServer, type RunningControlServer } from '../server.js';
import { seedCodexAgentFamily, historyJsonl } from './helpers/agent-history-fixture.js';
import type { Run } from '../types.js';
const servers: RunningControlServer[] = [], roots: string[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-graph-')); roots.push(root); const workspace = join(root, 'workspace'), worktree = join(root, 'worktree'), codexHome = join(root, 'codex'), claudeHome = join(root, 'claude');
  for (const path of [workspace, worktree, codexHome, claudeHome]) mkdirSync(path);
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'graph-test', history: { codexHome, claudeHome } }); servers.push(server);
  const project = server.service.createProject({ name: 'Graph', repositoryPath: workspace });
  const request = (path: string) => fetch(`${server.url}/api/${path}`, { headers: { authorization: 'Bearer graph-test' } });
  return { root, workspace, worktree, codexHome, claudeHome, server, project, request };
}
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('actual provider subagent graph and lazy transcripts', () => {
  it('shows five actual nested Codex children, related worktrees and statuses without flat history spam or public-data mixing', async () => {
    const { server, project, request, workspace, worktree, codexHome } = await setup(); const family = seedCodexAgentFamily(codexHome, workspace, worktree); const unrelated = seedCodexAgentFamily(codexHome, worktree);
    const list = await server.service.history.list(project); expect(list.items.map((item) => item.sessionId)).toEqual([family.rootId]);
    const source = list.items[0]!; const before = readFileSync(server.service.store.path, 'utf8'); const originals = family.children.map((entry) => readFileSync(entry.path, 'utf8'));
    const response = await request(`projects/${project.id}/sessions/${source.id}/agents`); expect(response.status).toBe(200); const graph = await response.json();
    expect(graph.agentTree.agents).toHaveLength(6); expect(graph.agentTree.rootId).toBe(`codex:${family.rootId}`); expect(graph.sourceAvailable).toBe(true);
    const child = (index: number) => graph.agentTree.agents.find((agent: any) => agent.id === `codex:${family.childIds[index]}`);
    expect(child(4).parentId).toBe(`codex:${family.childIds[0]}`); expect(family.childIds.map((_, index) => child(index).status)).toEqual(['running', 'waiting', 'completed', 'failed', 'interrupted']);
    expect(JSON.stringify(graph)).not.toMatch(/PRIVATE_|CHILD_PUBLIC_|FORKED_PARENT/);
    const detail = await request(`projects/${project.id}/sessions/${source.id}/agents/${encodeURIComponent(child(0).id)}/transcript`).then((r) => r.json());
    expect(JSON.stringify(detail)).toContain('CHILD_PUBLIC_1'); expect(JSON.stringify(detail)).not.toMatch(/ROOT_PUBLIC_ONLY|CHILD_PUBLIC_2|FORKED_PARENT|PRIVATE_/); expect(detail.questions).toEqual([]);
    expect(graph.agentTree.agents.every((agent: any) => agent.readOnly === true)).toBe(true);
    expect((await request(`projects/${project.id}/sessions/${source.id}/agents/${encodeURIComponent(`codex:${unrelated.childIds[0]}`)}/transcript`)).status).toBe(404);
    expect(readFileSync(server.service.store.path, 'utf8')).toBe(before); expect(family.children.map((entry) => readFileSync(entry.path, 'utf8'))).toEqual(originals);
    appendFileSync(family.children[0]!.path, historyJsonl([{ ordinal: 20, timestamp: family.at(10), type: 'event_msg', payload: { type: 'task_complete' } }, { ordinal: 21, timestamp: family.at(10), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'CHILD_LIVE_APPEND' }] } }]));
    const updated = await request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json()); expect(updated.agentTree.agents.find((node: any) => node.id === child(0).id).status).toBe('completed');
    const appended = await request(`projects/${project.id}/sessions/${source.id}/agents/${encodeURIComponent(child(0).id)}/transcript`).then((r) => r.json()); expect(JSON.stringify(appended)).toContain('CHILD_LIVE_APPEND');
  });

  it('resolves Claude native tool aliases, nested agents and resumed generations while excluding bash and hidden sidechain context', async () => {
    const { server, project, request, workspace, claudeHome } = await setup(); const sessionId = randomUUID(); const folder = join(claudeHome, 'projects', 'encoded'); const children = join(folder, sessionId, 'subagents'); mkdirSync(children, { recursive: true });
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString(); const rows: any[] = [{ type: 'user', sessionId, cwd: workspace, timestamp: at(0), message: { content: 'Root public request' } }];
    for (let index = 0; index < 5; index++) {
      if (index < 4) rows.push({ type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: `tool_${index}`, name: 'Agent', input: { description: `Claude child ${index}`, subagent_type: 'reviewer' } }] } }, { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: `tool_${index}`, content: 'launched' }] }, toolUseResult: { agentId: `agent_${index}`, status: 'async_launched', prompt: 'PRIVATE_PROMPT', outputFile: 'PRIVATE_PATH' } });
      writeFileSync(join(children, `agent-agent_${index}.jsonl`), historyJsonl([{ type: 'user', sessionId, cwd: workspace, agentId: `agent_${index}`, isSidechain: true, isMeta: true, message: { content: 'PRIVATE_INTERNAL_CONTEXT' } }, { type: 'assistant', sessionId, cwd: workspace, agentId: `agent_${index}`, isSidechain: true, timestamp: at(3), message: { id: `reply_${index}`, stop_reason: 'end_turn', content: [{ type: 'text', text: `CLAUDE_CHILD_${index}` }, { type: 'thinking', thinking: 'PRIVATE_THINKING' }] } }]));
    }
    rows.push({ type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: 'bash_job', tool_use_id: 'bash_tool', timestamp: at(4) }, { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'agent_0', run_id: 'old-generation', tool_use_id: 'tool_0', timestamp: at(4) }, { type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'agent_0', run_id: 'new-generation', tool_use_id: 'tool_resumed', timestamp: at(5) }, { type: 'system', subtype: 'task_notification', task_id: 'agent_0', run_id: 'old-generation', status: 'completed', timestamp: at(6) });
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl(rows));
    appendFileSync(join(children, 'agent-agent_0.jsonl'), historyJsonl([{ type: 'user', sessionId, agentId: 'agent_0', isSidechain: true, timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'nested_tool', content: 'launched nested' }] }, toolUseResult: { agentId: 'agent_4', status: 'async_launched' } }]));
    const source = (await server.service.history.list(project)).items[0]!; const graph = await request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json());
    expect(graph.agentTree.agents).toHaveLength(6); const first = graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:agent_0'); expect(first.aliases).toEqual(expect.arrayContaining(['claude:tool:tool_0', 'claude:tool:tool_resumed'])); expect(first.status).toBe('running');
    expect(graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:agent_4').parentId).toBe('claude:agent:agent_0'); expect(JSON.stringify(graph)).not.toMatch(/bash_job|PRIVATE_/);
    const detail = await request(`projects/${project.id}/sessions/${source.id}/agents/${encodeURIComponent('claude:tool:tool_1')}/transcript`).then((r) => r.json()); expect(JSON.stringify(detail)).toContain('CLAUDE_CHILD_1'); expect(JSON.stringify(detail)).not.toMatch(/CLAUDE_CHILD_0|Root public|PRIVATE_/);
  });

  it('names Claude subagents from their meta file when the launching tool call is outside the root window', async () => {
    const { server, project, request, workspace, claudeHome } = await setup(); const sessionId = randomUUID(); const folder = join(claudeHome, 'projects', 'encoded'); const children = join(folder, sessionId, 'subagents'); mkdirSync(children, { recursive: true });
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([{ type: 'user', sessionId, cwd: workspace, timestamp: new Date().toISOString(), message: { content: 'Root public request' } }]));
    writeFileSync(join(children, 'agent-named_1.jsonl'), historyJsonl([{ type: 'assistant', sessionId, cwd: workspace, agentId: 'named_1', isSidechain: true, message: { id: 'reply', stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } }]));
    writeFileSync(join(children, 'agent-named_1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Installing dependencies with npm ci', toolUseId: 'toolu_named', spawnDepth: 1 }));
    writeFileSync(join(children, 'agent-plain_2.jsonl'), historyJsonl([{ type: 'assistant', sessionId, cwd: workspace, agentId: 'plain_2', isSidechain: true, message: { id: 'reply', content: [{ type: 'text', text: 'working' }] } }]));
    const source = (await server.service.history.list(project)).items[0]!; const graph = await request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json());
    const named = graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:named_1');
    expect(named).toMatchObject({ name: 'Installing dependencies with npm ci', role: 'general-purpose', toolUseId: 'toolu_named', parentId: `claude:session:${sessionId}`, parentKnown: true });
    expect(graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:plain_2')).toMatchObject({ name: 'Claude subagent plain_2', parentKnown: false });
  });

  it('gives each Claude subagent its model and its latest tool call with only short string arguments', async () => {
    const { server, project, request, workspace, claudeHome } = await setup(); const sessionId = randomUUID(); const folder = join(claudeHome, 'projects', 'encoded'); const children = join(folder, sessionId, 'subagents'); mkdirSync(children, { recursive: true });
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([{ type: 'user', sessionId, cwd: workspace, timestamp: at(0), message: { content: 'Root public request' } }, { type: 'assistant', sessionId, timestamp: at(1), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'root_read', name: 'Read', input: { file_path: 'ROOT_ONLY.ts' } }] } }]));
    writeFileSync(join(children, 'agent-worker_1.jsonl'), historyJsonl([
      { type: 'assistant', sessionId, cwd: workspace, agentId: 'worker_1', isSidechain: true, timestamp: at(2), message: { id: 'a', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't1', name: 'Grep', input: { pattern: 'IdentityConst' } }] } },
      { type: 'assistant', sessionId, cwd: workspace, agentId: 'worker_1', isSidechain: true, timestamp: at(3), message: { id: 'b', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'src/AuthenticationService.cs', limit: 60, nested: { secret: 'NESTED' } } }] } },
    ]));
    writeFileSync(join(children, 'agent-worker_1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Auth flow', spawnDepth: 1 }));
    const source = (await server.service.history.list(project)).items[0]!; const graph = await request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json());
    const worker = graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:worker_1');
    expect(worker).toMatchObject({ model: 'claude-haiku-5-5', activity: { tool: 'Read', at: expect.any(String) } });
    expect(worker.activity.input).toEqual({ file_path: 'src/AuthenticationService.cs' });
    const root = graph.agentTree.agents.find((node: any) => node.id === graph.agentTree.rootId); expect(root.activity).toBeUndefined(); expect(JSON.stringify(graph)).not.toMatch(/ROOT_ONLY|NESTED/);
  });

  it('reads a large finished worker past its discovery probe, skips its handback and trusts the finished flag', async () => {
    const { server, project, request, workspace, claudeHome } = await setup(); const sessionId = randomUUID(); const folder = join(claudeHome, 'projects', 'encoded'); const children = join(folder, sessionId, 'subagents'); mkdirSync(children, { recursive: true });
    const at = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString(), padding = (size: number) => ({ type: 'attachment', sessionId, agentId: 'big_1', isSidechain: true, attachment: { content: 'x'.repeat(size) } });
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([{ type: 'user', sessionId, cwd: workspace, timestamp: at(0), message: { content: 'Root public request' } }]));
    writeFileSync(join(children, 'agent-big_1.jsonl'), historyJsonl([
      { type: 'user', sessionId, cwd: workspace, agentId: 'big_1', isSidechain: true, timestamp: at(1), message: { content: 'Run it' } }, padding(120 * 1024),
      { type: 'assistant', sessionId, agentId: 'big_1', isSidechain: true, timestamp: at(2), message: { id: 'a', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo MIDDLE' } }] } }, padding(120 * 1024),
      { type: 'assistant', sessionId, agentId: 'big_1', isSidechain: true, timestamp: at(3), message: { id: 'b', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't2', name: 'SubagentHandback', input: { message: 'done' } }] } },
    ]));
    writeFileSync(join(children, 'agent-big_1.meta.json'), JSON.stringify({ agentType: 'general-purpose', description: 'Big worker', spawnDepth: 1, model: 'haiku', finished: true }));
    const source = (await server.service.history.list(project)).items[0]!; const graph = await request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json());
    expect(graph.agentTree.agents.find((node: any) => node.id === 'claude:agent:big_1')).toMatchObject({ status: 'completed', model: 'haiku', activity: { tool: 'Bash', input: { command: 'echo MIDDLE' } } });
  });

  it('uses exact bootstrap markers for fresh native runs and refuses ambiguous or absent provider identities', async () => {
    const { server, project, request, workspace, codexHome, root } = await setup(); const family = seedCodexAgentFamily(codexHome, workspace); const task = server.service.createTask({ projectId: project.id, title: 'Managed native terminal', provider: 'codex' });
    const run: Run = { id: 'run_exact_marker', taskId: task.id, provider: 'codex', status: 'running', startedAt: family.at(-1), finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', inputDirectory: join(root, 'managed-input') }; server.service.store.state.runs.push(run);
    appendFileSync(family.children[0]!.path, historyJsonl([{ ordinal: 1, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Inherited ${join(run.inputDirectory!, 'prompt.md')}` }] } }]));
    const initial = await request(`runs/${run.id}/agents`).then((r) => r.json()); expect(initial.sourceAvailable).toBe(false); expect(initial.agentTree.agents).toHaveLength(1); expect(initial.warnings.join(' ')).toMatch(/deterministic/);
    appendFileSync(family.rootPath, historyJsonl([{ type: 'event_msg', payload: { type: 'token_count', info: 'internal-padding'.repeat(9000) } }, { timestamp: family.at(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read and follow ${join(run.inputDirectory!, 'prompt.md')}.` }] } }]));
    // New instance avoids the deliberate two-second source-index refresh cooldown.
    const { SessionHistory } = await import('../history.js'); const { AgentGraph } = await import('../agent-graph.js');
    const history = new SessionHistory({ codexHome, claudeHome: join(root, 'claude') }); const markerLookup = vi.spyOn(history, 'findBootstrap'); const graph = new AgentGraph(history);
    const bound = await graph.tree(project, { run }); expect(bound.agentTree.rootId).toBe(`codex:${family.rootId}`); expect(bound.agentTree.agents).toHaveLength(6);
    expect((await graph.tree(project, { run })).agentTree.rootId).toBe(`codex:${family.rootId}`); expect(markerLookup).toHaveBeenCalledTimes(1);
    const second = seedCodexAgentFamily(codexHome, workspace); appendFileSync(second.rootPath, historyJsonl([{ timestamp: second.at(), type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Read and follow ${join(run.inputDirectory!, 'prompt.md')}.` }] } }]));
    const ambiguous = await new AgentGraph(new SessionHistory({ codexHome, claudeHome: join(root, 'claude') })).tree(project, { run }); expect(ambiguous.sourceAvailable).toBe(false); expect(ambiguous.agentTree.agents).toHaveLength(1); expect(ambiguous.warnings.join(' ')).toMatch(/ambiguous/);
  });

  it('serves the context window of a run from its session transcript and follows it as it grows', async () => {
    const { server, project, request, root, claudeHome } = await setup(); const worktree = join(root, 'context-worktree'), sessionId = randomUUID(); mkdirSync(worktree);
    const task = server.service.createTask({ projectId: project.id, title: 'Context', provider: 'claude' }); const startedAt = new Date(Date.now() - 60_000).toISOString();
    const run: Run = { id: 'run_context', taskId: task.id, provider: 'claude', sessionId, status: 'running', startedAt, finishedAt: null, exitCode: null, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', workspacePath: worktree }; server.service.store.state.runs.push(run);
    const folder = join(claudeHome, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(folder, { recursive: true }); const path = join(folder, `${sessionId}.jsonl`);
    writeFileSync(path, historyJsonl([
      { type: 'user', sessionId, cwd: worktree, timestamp: startedAt, message: { role: 'user', content: 'Fix checkout' } },
      { type: 'assistant', sessionId, cwd: worktree, timestamp: startedAt, message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: join(worktree, 'payment.ts') } }], usage: { input_tokens: 5, cache_read_input_tokens: 12000, cache_creation_input_tokens: 0, output_tokens: 20 } } },
    ]));
    const first = await request(`runs/${run.id}/context`).then((r) => r.json());
    expect(first.agentId).toBe(`claude:session:${sessionId}`); expect(first.snapshot).toMatchObject({ provider: 'claude', model: 'claude-opus-5-5', window: 200_000, measured: true });
    appendFileSync(path, historyJsonl([{ type: 'user', sessionId, cwd: worktree, timestamp: startedAt, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'export const pay = 1;\n'.repeat(400) }] } }]));
    const second = await request(`runs/${run.id}/context`).then((r) => r.json());
    expect(second.snapshot.blocks.find((block: any) => block.id === 'file:payment.ts').tokens).toBeGreaterThan(first.snapshot.blocks.find((block: any) => block.id === 'file:payment.ts').tokens);
    expect(second.snapshot.used).toBeGreaterThan(first.snapshot.used);
    expect((await request(`runs/${run.id}/context?agent=missing`)).status).toBe(404);
  });

  it('reads a managed Claude terminal transcript after its worktree is removed, including turns after a cd into a subfolder', async () => {
    const { server, project, request, root, claudeHome } = await setup(); const worktree = join(root, 'task-worktree'), sessionId = randomUUID(); mkdirSync(join(worktree, 'src'), { recursive: true });
    const task = server.service.createTask({ projectId: project.id, title: 'Removed worktree', provider: 'claude' }); const startedAt = new Date(Date.now() - 60_000).toISOString(); const at = (seconds: number) => new Date(Date.parse(startedAt) + seconds * 1000).toISOString();
    const run: Run = { id: 'run_removed_worktree', taskId: task.id, provider: 'claude', status: 'completed', startedAt, finishedAt: at(30), exitCode: 0, executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', inputDirectory: join(root, 'removed-input'), workspacePath: worktree }; server.service.store.state.runs.push(run);
    const folder = join(claudeHome, 'projects', worktree.replace(/[^a-zA-Z0-9]/g, '-')); mkdirSync(folder, { recursive: true }); const nested = join(worktree, 'src');
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([
      { type: 'user', sessionId, cwd: worktree, timestamp: at(1), message: { role: 'user', content: `Read and follow ${join(run.inputDirectory!, 'prompt.md')}.` } },
      { type: 'assistant', sessionId, cwd: worktree, timestamp: at(2), message: { id: 'msg_1', content: [{ type: 'text', text: 'FIRST_REPLY' }, { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'cd src && ls' } }] } },
      { type: 'user', sessionId, cwd: nested, timestamp: at(3), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'NESTED_TOOL_OUTPUT' }] } },
      { type: 'assistant', sessionId, cwd: nested, timestamp: at(4), message: { id: 'msg_2', content: [{ type: 'text', text: 'AFTER_CD_REPLY' }] } },
    ]));
    rmSync(worktree, { recursive: true, force: true });
    const graph = await request(`runs/${run.id}/agents`).then((r) => r.json()); expect(graph.sourceAvailable).toBe(true); expect(graph.agentTree.rootId).toBe(`claude:session:${sessionId}`);
    const transcript = await request(`runs/${run.id}/agents/${encodeURIComponent(graph.agentTree.rootId)}/transcript?limit=200`).then((r) => r.json()); const text = JSON.stringify(transcript);
    for (const value of ['FIRST_REPLY', 'NESTED_TOOL_OUTPUT', 'AFTER_CD_REPLY']) expect(text).toContain(value);
    expect(transcript.messages.map((message: any) => message.text)).toEqual([`Read and follow ${join(run.inputDirectory!, 'prompt.md')}.`]); expect(transcript.nextCursor).toBeNull();
  });

  it('serves a run prompt file so the console can show what the agent was given', async () => {
    const { server, project, request, root } = await setup(); const task = server.service.createTask({ projectId: project.id, title: 'Prompt viewer', provider: 'claude' });
    const run: Run = { id: 'run_prompt_view', taskId: task.id, provider: 'claude', status: 'completed', startedAt: new Date().toISOString(), executionMode: 'native', pendingCommands: [], continuation: 0, terminalMode: 'pty', inputDirectory: join(root, 'prompt-input') }; server.service.store.state.runs.push(run);
    expect((await request(`runs/${run.id}/prompt`)).status).toBe(404);
    mkdirSync(run.inputDirectory!); writeFileSync(join(run.inputDirectory!, 'prompt.md'), 'Task:\nPROMPT_BODY');
    const prompt = await request(`runs/${run.id}/prompt`).then((r) => r.json()); expect(prompt).toEqual({ runId: run.id, path: join(run.inputDirectory!, 'prompt.md'), text: 'Task:\nPROMPT_BODY' });
    expect((await fetch(`${server.url}/api/runs/${run.id}/prompt`)).status).toBe(401); expect((await request('runs/run_missing/prompt')).status).toBe(404);
  });

  it('honors managed root identity and ignores symlink sources; Command still terminates in the default PTY', async () => {
    const { server, project, request, workspace, codexHome } = await setup(); const family = seedCodexAgentFamily(codexHome, workspace);
    symlinkSync(family.directory, join(codexHome, 'sessions', 'linked-workers'), 'junction');
    const task = server.service.createTask({ projectId: project.id, title: 'Command should not hang', provider: 'command', preferNativeTerminal: true, command: { executable: process.execPath, args: ['-e', 'console.log("command complete")'] } });
    const run = server.service.startTask(task.id); expect(run.terminalMode).toBe('pty'); const end = Date.now() + 5000; while (server.service.run(run.id).status === 'running' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 25)); expect(server.service.run(run.id).status).toBe('completed');
    const rootTask = server.service.createTask({ projectId: project.id, title: 'Original provider run', provider: 'codex' }); const managed: Run = { ...run, id: 'run_provider_source', taskId: rootTask.id, provider: 'codex', status: 'running', sessionId: family.rootId }; server.service.store.state.runs.push(managed);
    const graph = await request(`runs/${managed.id}/agents`).then((r) => r.json()); expect(graph.agentTree.rootId).toBe(`codex:${family.rootId}`); expect(graph.agentTree.agents).toHaveLength(6); expect(graph.agentTree.agents[0].status).toBe('running');
    const data = await request(`runs/${managed.id}/agents/${encodeURIComponent(`codex:${family.childIds[2]}`)}/transcript`).then((r) => r.json()); expect(JSON.stringify(data)).toContain('CHILD_PUBLIC_3');
    expect((await fetch(`${server.url}/api/runs/${managed.id}/agents`)).status).toBe(401);
  });

  it('preserves native child web content-block results and call IDs while excluding inherited and non-public blocks', async () => {
    const { server, project, request, workspace, codexHome } = await setup(); const family = seedCodexAgentFamily(codexHome, workspace);
    const child = family.children[0]!, originalMeta = JSON.parse(readFileSync(child.path, 'utf8').split('\n')[0]!);
    const script = 'const result = await tools.web__run({search_query:[{q:"public provider docs"}],open:[{ref_id:"https://example.com/docs"}]}); text(result);';
    const firstOutput = 'Search result: public provider documentation\nhttps://example.com/docs\nOpen result: visible page excerpt.';
    const largeOutput = 'PUBLIC_LONG_WEB_RESULT '.repeat(900);
    writeFileSync(child.path, historyJsonl([
      originalMeta,
      { ordinal: 1, type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'inherited-call', input: 'PRIVATE_INHERITED_WEB_REQUEST' } },
      { ordinal: 2, type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'inherited-call', output: [{ type: 'input_text', text: 'PRIVATE_INHERITED_WEB_RESULT' }] } },
      { ordinal: 10, timestamp: family.at(), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Child starts with this public progress update.' }] } },
      { ordinal: 11, timestamp: family.at(1), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'child-web-call', input: script, internal_chat_message_metadata_passthrough: 'PRIVATE_PROVIDER_METADATA' } },
      { ordinal: 12, timestamp: family.at(2), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'child-web-call', output: [
        { type: 'input_text', text: 'Wall time: 5.6 seconds' }, { type: 'input_text', text: firstOutput },
        { type: 'image', image_url: 'PRIVATE_BINARY' }, { type: 'reasoning', text: 'PRIVATE_REASONING' }, { type: 'system', text: 'PRIVATE_SYSTEM' }, { type: 'developer', text: 'PRIVATE_DEVELOPER' },
      ] } },
      { ordinal: 13, timestamp: family.at(3), type: 'response_item', payload: { type: 'function_call', name: 'web.run', call_id: 'child-direct-web', arguments: '{"open":[{"ref_id":"https://example.com/guide"}]}' } },
      { ordinal: 14, timestamp: family.at(4), type: 'response_item', payload: { type: 'function_call_output', call_id: 'child-direct-web', output: [{ type: 'text', text: 'Public direct web result.' }, { type: 'output_text', text: 'Second public text block.' }] } },
      { ordinal: 15, timestamp: family.at(5), type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'child-long-web', input: script } },
      { ordinal: 16, timestamp: family.at(6), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'child-long-web', output: [{ type: 'input_text', text: largeOutput }, { type: 'reasoning', text: 'PRIVATE_LONG_REASONING' }] } },
      { ordinal: 17, timestamp: family.at(7), type: 'response_item', payload: { type: 'function_call_output', call_id: 'legacy-string-result', output: 'Original ordinary string output.' } },
    ]));
    const source = (await server.service.history.list(project)).items[0]!; const diskBefore = readFileSync(server.service.store.path, 'utf8'), sourceBefore = readFileSync(child.path, 'utf8');
    const detail = await request(`projects/${project.id}/sessions/${source.id}/agents/${encodeURIComponent(`codex:${child.id}`)}/transcript`).then((r) => r.json());
    const rows = detail.events.map((event: any) => JSON.parse(event.message)); const parts = rows.flatMap((row: any) => row.message?.content ?? []);
    const call = parts.find((part: any) => part.type === 'tool_use' && part.id === 'child-web-call');
    expect(call).toMatchObject({ name: 'exec', input: { input: script } });
    expect(parts.find((part: any) => part.type === 'tool_result' && part.tool_use_id === call.id).content).toBe(`Wall time: 5.6 seconds\n${firstOutput}`);
    expect(parts.find((part: any) => part.tool_use_id === 'child-direct-web').content).toBe('Public direct web result.\nSecond public text block.');
    expect(parts.find((part: any) => part.tool_use_id === 'child-long-web')).toMatchObject({ content: largeOutput.slice(0, 16000), truncated: true, original_characters: largeOutput.length, retained_characters: 16000 });
    expect(parts.find((part: any) => part.tool_use_id === 'legacy-string-result').content).toBe('Original ordinary string output.');
    expect(detail).toMatchObject({ truncated: true, nextCursor: null }); expect(detail.warnings.join(' ')).toContain('16000');
    expect(JSON.stringify(detail)).toContain('Child starts with this public progress update.'); expect(JSON.stringify(detail)).not.toMatch(/PRIVATE_|\[object Object\]|inherited-call/);
    expect(readFileSync(server.service.store.path, 'utf8')).toBe(diskBefore); expect(readFileSync(child.path, 'utf8')).toBe(sourceBefore);
  });

  it('shows a Claude Workflow run with its steps and agents, and reads each agent like a subagent', async () => {
    const { server, project, request, workspace, claudeHome } = await setup(); const sessionId = randomUUID(), folder = join(claudeHome, 'projects', 'encoded'), runId = 'wf_abc-123', run = join(folder, sessionId, 'subagents', 'workflows', runId), scripts = join(folder, sessionId, 'workflows', 'scripts'); mkdirSync(run, { recursive: true }); mkdirSync(scripts, { recursive: true });
    const at = (seconds: number) => new Date(Date.now() - 3600_000 + seconds * 1000).toISOString();
    writeFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([{ type: 'user', sessionId, cwd: workspace, timestamp: at(0), message: { content: 'Root request' } }, { type: 'assistant', timestamp: at(1), message: { content: [{ type: 'tool_use', id: 'wf_tool', name: 'Workflow', input: { script: 'x' } }] } }, { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'wf_tool', content: 'launched' }] }, toolUseResult: { status: 'async_launched', taskId: 'task1', taskType: 'local_workflow', workflowName: 'launch-name', runId, summary: 'launch summary' } }]));
    writeFileSync(join(scripts, `build-${runId}.js`), "export const meta = {\n  name: 'build',\n  description: 'Builds it\\'s parts',\n  phases: [\n    { title: 'Temel', detail: 'First' },\n    { title: 'Son' },\n  ],\n}\nawait agent('x', { name: 'not-meta' })\n");
    writeFileSync(join(run, 'journal.jsonl'), historyJsonl([{ type: 'launched' }, { type: 'started', key: 'k1', agentId: 'a1', label: 'one', phase: 'Temel' }, { type: 'result', key: 'k1', agentId: 'a1', result: { ok: true } }, { type: 'started', key: 'k2', agentId: 'a2', label: 'two', phase: 'Son' }]));
    for (const [id, label, phase] of [['a1', 'one', 'Temel'], ['a2', 'two', 'Son']] as const) {
      writeFileSync(join(run, `agent-${id}.meta.json`), JSON.stringify({ agentType: 'workflow-subagent', description: label, workflowPhase: phase, spawnDepth: 1 }));
      writeFileSync(join(run, `agent-${id}.jsonl`), historyJsonl([{ type: 'user', sessionId, agentId: id, isSidechain: true, cwd: workspace, timestamp: at(3), message: { content: `AGENT_${id}_PROMPT` } }, { type: 'assistant', sessionId, agentId: id, isSidechain: true, timestamp: at(4), message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: `${id}_t`, name: 'Bash', input: { command: 'npm test' } }] } }]));
    }
    const source = (await server.service.history.list(project)).items[0]!, read = () => request(`projects/${project.id}/sessions/${source.id}/agents`).then((r) => r.json());
    expect((await read()).agentTree.agents.find((agent: any) => agent.id === 'claude:agent:a2').status).toBe('running');
    const past = new Date(Date.now() - 3600_000); utimesSync(join(folder, `${sessionId}.jsonl`), past, past);
    const graph = await read(), find = (data: any, id: string) => data.agentTree.agents.find((agent: any) => agent.id === id), nodeId = `claude:workflow:${runId}`, workflow = find(graph, nodeId);
    expect(workflow).toMatchObject({ kind: 'workflow', parentId: graph.agentTree.rootId, name: 'build', description: "Builds it's parts", phases: [{ title: 'Temel', detail: 'First' }, { title: 'Son' }], status: 'interrupted', transcriptAvailable: false }); expect(workflow.aliases).toContain('claude:tool:wf_tool');
    expect(find(graph, 'claude:agent:a1')).toMatchObject({ parentId: nodeId, phase: 'Temel', role: 'Temel', name: 'one', status: 'completed', model: 'claude-opus-5-5', transcriptAvailable: true }); expect(find(graph, 'claude:agent:a1').activity.tool).toBe('Bash');
    expect(find(graph, 'claude:agent:a2')).toMatchObject({ parentId: nodeId, phase: 'Son', status: 'interrupted' });
    const detail = await request(`projects/${project.id}/sessions/${source.id}/agents/claude%3Aagent%3Aa2/transcript`).then((r) => r.json()); expect(JSON.stringify(detail)).toContain('AGENT_a2_PROMPT'); expect(JSON.stringify(detail)).not.toContain('AGENT_a1_PROMPT');
    appendFileSync(join(folder, `${sessionId}.jsonl`), historyJsonl([{ type: 'user', timestamp: at(9), message: { content: '<task-notification>\n<task-id>task1</task-id>\n<status>completed</status>\n</task-notification>' } }]));
    expect(find(await read(), nodeId).status).toBe('completed');
  });
});

describe('provider conversations read from their own session storage', () => {
  it('shows an Antigravity terminal run conversation in the chat stream form', async () => {
    const { AgentGraph } = await import('../agent-graph.js'); const { SessionHistory } = await import('../history.js');
    const root = mkdtempSync(join(tmpdir(), 'aiws-agy-graph-')); roots.push(root); const previous = process.env.AGY_HOME; process.env.AGY_HOME = root;
    try {
      const sessionId = randomUUID(); const logs = join(root, 'antigravity-cli', 'brain', sessionId, '.system_generated', 'logs'); mkdirSync(logs, { recursive: true });
      writeFileSync(join(logs, 'transcript.jsonl'), [
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', created_at: '2026-11-07T15:55:00Z', content: '<USER_REQUEST>\nAGY_USER_ASK\n</USER_REQUEST>' },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', created_at: '2026-11-07T15:55:05Z', content: 'AGY_AGENT_REPLY', tool_calls: [{ name: 'run_command', args: { CommandLine: 'git status' } }] },
        { step_index: 2, source: 'TOOL', type: 'GENERIC', status: 'DONE', created_at: '2026-11-07T15:55:06Z', content: 'AGY_TOOL_OUTPUT' },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');
      const run = { id: 'run_agy', taskId: 'task_agy', provider: 'agy', sessionId, status: 'running', terminalMode: 'pty', startedAt: '2026-11-07T15:54:00Z' } as unknown as Run;
      const project = { id: 'p', name: 'P', repositoryPath: root } as any; const graph = new AgentGraph(new SessionHistory({ codexHome: join(root, 'codex'), claudeHome: join(root, 'claude') }));
      const tree = await graph.tree(project, { run }); const rootNode = tree.agentTree.agents[0]!;
      expect(tree.sourceAvailable).toBe(true); expect(rootNode).toMatchObject({ id: 'run:run_agy', provider: 'agy', sessionId, transcriptAvailable: true });
      const transcript = await graph.transcript(project, { run }, rootNode.id, {});
      expect(transcript.messages.map((message) => message.text)).toEqual(['AGY_USER_ASK']);
      const records = transcript.events.map((event) => JSON.parse(event.message));
      expect(records.map((record) => record.message.content[0].type)).toEqual(['text', 'tool_use', 'tool_result']);
      expect(JSON.stringify(records)).toContain('AGY_AGENT_REPLY'); expect(JSON.stringify(records)).toContain('AGY_TOOL_OUTPUT');
      expect(records[1].message.content[0].id).toBe(records[2].message.content[0].tool_use_id);
    } finally { if (previous === undefined) delete process.env.AGY_HOME; else process.env.AGY_HOME = previous; }
  });
});
