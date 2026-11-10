import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlService } from '../service.js';

const roots: string[] = []; const services: ControlService[] = [];
afterEach(async () => { await Promise.all(services.splice(0).map((service) => service.close())); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); });

describe('conversation reply to an open question', () => {
  it('answers the pending question and clears the waiting state', () => {
    const root = mkdtempSync(join(tmpdir(), 'aiws-message-answer-')); roots.push(root); const workspace = join(root, 'workspace'); mkdirSync(workspace);
    const service = new ControlService({ dataDir: join(root, 'data') }); services.push(service);
    const project = service.createProject({ name: 'Phone', repositoryPath: workspace });
    const task = service.createTask({ projectId: project.id, title: 'Ask', provider: 'command', command: { executable: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] } });
    const run = service.startTask(task.id);
    const question = service.ask(run.id, { text: 'Which database?' });
    expect(service.run(run.id).status).toBe('waiting');
    service.postMessage(task.id, { text: 'Postgres', authorType: 'user' });
    expect(service.store.state.questions.find((item) => item.id === question.id)).toMatchObject({ status: 'answered', answer: 'Postgres' });
    expect(service.run(run.id).status).toBe('running');
    expect(service.task(task.id).status).toBe('running');
  });
});
