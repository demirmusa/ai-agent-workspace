import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startControlServer, type RunningControlServer } from '../server.js';
import { listAgentTemplates } from '../agent-templates.js';
import type { AgentDefinition, AgentTemplate, Task } from '../types.js';

const roots: string[] = []; const servers: RunningControlServer[] = [];
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'aiws-template-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace);
  const server = await startControlServer({ port: 0, dataDir: join(root, 'data'), token: 'template-test' }); servers.push(server);
  const request = (path: string, method = 'GET', input?: unknown) => fetch(`${server.url}/api/${path}`, { method, headers: { authorization: 'Bearer template-test', 'content-type': 'application/json' }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
  return { root, workspace, server, request };
}
function attribution(template: AgentTemplate) { return { templateId: template.id, ...template.source, license: template.license }; }
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

describe('opt-in bundled community agent templates', () => {
  it('serves a pinned licensed library offline with attribution and does not seed or overwrite profiles', async () => {
    const { server, root, request } = await setup();
    const custom = server.service.catalog.createAgent({ name: 'Existing private profile', instructions: 'Keep my instructions.', provider: 'codex', enabled: false });
    await server.service.store.flush(); const before = server.service.store.persistedSnapshot();
    expect((await fetch(`${server.url}/api/agent-templates`)).status).toBe(401);
    const response = await request('agent-templates'); expect(response.status).toBe(200);
    const library = await response.json(); expect(library.items).toHaveLength(163);
    expect(library.notice).toMatch(/not Anthropic built-in/); expect(library.officialReference).toMatch(/^https:\/\/code\.claude\.com/);
    for (const name of ['backend-developer', 'frontend-developer', 'csharp-developer', 'dotnet-core-expert', 'dotnet-framework-4.8-expert', 'deployment-engineer']) expect(library.items.some((item: AgentTemplate) => item.name === name)).toBe(true);
    for (const item of library.items as AgentTemplate[]) {
      expect(item.license).toBe('MIT'); expect(item.source.revision).toBe('408d3c9eee2d0c75c12a3abb5de29e53c2ca6b9e');
      expect(item.source.url).toContain(`/blob/${item.source.revision}/categories/`); expect(item.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(item.instructions.length).toBeGreaterThan(100); expect(item.instructions.length).toBeLessThanOrEqual(100_000);
      expect(item.context).toContain('grants no permissions'); expect(item.skillIds).toEqual([]); expect(item).not.toHaveProperty('model'); expect(item).not.toHaveProperty('command');
    }
    expect(readFileSync(join(process.cwd(), 'assets', 'agent-templates', 'LICENSE'), 'utf8')).toContain('Copyright (c) 2025 VoltAgent');
    expect(server.service.snapshot().agents).toEqual([custom]); await server.service.store.flush(); expect(server.service.store.persistedSnapshot()).toBe(before);
    library.items[0].instructions = 'Client edit'; expect((await listAgentTemplates()).items[0]?.instructions).not.toBe('Client edit');
  });

  it('creates independent editable Codex/Claude copies without upstream model aliases and preserves source metadata', async () => {
    const { root, request, server } = await setup(); const template = (await listAgentTemplates()).items.find((item) => item.name === 'dotnet-core-expert')!;
    const first = await request('agents', 'POST', { ...template, name: 'My .NET developer', provider: 'codex', templateSource: attribution(template) }).then((response) => response.json()) as AgentDefinition;
    const second = await request('agents', 'POST', { ...template, name: 'My Claude .NET', templateSource: attribution(template) }).then((response) => response.json()) as AgentDefinition;
    expect(first.id).not.toBe(second.id); expect(first.provider).toBe('codex'); expect(second.provider).toBe('claude'); expect(first.model).toBeUndefined(); expect(second.model).toBeUndefined(); expect(first.enabled).toBe(true);
    expect(first.templateSource).toMatchObject({ templateId: template.id, revision: template.source.revision, license: 'MIT' });
    const modified = await request(`agents/${first.id}`, 'PATCH', { instructions: 'My tailored .NET standards.', enabled: false }).then((response) => response.json()) as AgentDefinition;
    expect(modified.templateSource).toEqual(first.templateSource); expect(server.service.catalog.agent(second.id).instructions).toBe(template.instructions);
    expect((await listAgentTemplates()).items.find((item) => item.id === template.id)?.instructions).toBe(template.instructions);
    await server.service.store.flush(); expect(server.service.store.readPersisted().agents.find((item: AgentDefinition) => item.id === first.id)).toMatchObject({ instructions: 'My tailored .NET standards.', templateSource: first.templateSource });
    expect((await request('agents', 'POST', { name: 'Bad provenance', templateSource: { ...attribution(template), url: 'javascript:alert(1)' } })).status).toBe(400);
    const cleared = await request(`agents/${first.id}`, 'PATCH', { templateSource: null }).then((response) => response.json()) as AgentDefinition; expect(cleared.templateSource).toBeUndefined();
  });

  it('delivers the copied specialist instructions and adaptation context to a real child and freezes provenance per run', async () => {
    const { root, workspace, server, request } = await setup(); const template = (await listAgentTemplates()).items.find((item) => item.name === 'backend-developer')!;
    const agent = await request('agents', 'POST', { ...template, provider: 'codex', templateSource: attribution(template) }).then((response) => response.json()) as AgentDefinition;
    const project = server.service.createProject({ name: 'Template execution', repositoryPath: workspace }); const output = join(root, 'received-prompt.txt');
    const task = await request('tasks', 'POST', { projectId: project.id, title: 'Verify selected specialist input', agentId: agent.id, provider: 'command', terminalMode: 'stream', command: { executable: process.execPath, args: ['-e', "let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>require('node:fs').writeFileSync(process.argv[1],input))", output] } }).then((response) => response.json()) as Task;
    const run = server.service.startTask(task.id); const end = Date.now() + 10_000;
    while (server.service.run(run.id).status === 'running' && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 30));
    expect(server.service.run(run.id).status).toBe('completed'); expect(readFileSync(output, 'utf8')).toContain(template.instructions); expect(readFileSync(output, 'utf8')).toContain(template.context);
    await request(`agents/${agent.id}`, 'PATCH', { instructions: 'Later edit' });
    expect(server.service.run(run.id).executionSnapshot?.agent?.instructions).toBe(template.instructions);
    expect(server.service.run(run.id).executionSnapshot?.agent?.templateSource).toEqual(agent.templateSource);
  });
});
