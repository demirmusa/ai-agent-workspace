import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { EDITABLE_FILE_BYTES, createProjectFile, listProjectFiles, openProjectPath, readProjectFile, searchProjectFiles, writeProjectFile } from '../project-files.js';
import { startControlServer, type RunningControlServer } from '../server.js';
const roots: string[] = [], servers: RunningControlServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.close())); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
function setup() {
  const path = mkdtempSync(join(tmpdir(), 'aiws-project-files-')); roots.push(path);
  execFileSync('git', ['-C', path, 'init', '-b', 'main'], { stdio: 'pipe' });
  for (const folder of ['src/control-ui', 'docs', 'dist', 'node_modules/pkg']) mkdirSync(join(path, folder), { recursive: true });
  for (const file of ['README.md', 'b10.txt', 'b2.txt', 'src/control-ui/app.js', 'src/control-ui/files.js', 'docs/guide.md', 'dist/app.js', 'node_modules/pkg/index.js']) writeFileSync(join(path, file), '');
  writeFileSync(join(path, '.gitignore'), 'dist/\nnode_modules/\n');
  return path;
}
describe('project file explorer', () => {
  it('lists one level with folders first, natural order, hidden .git and flagged ignored folders', async () => {
    const path = setup();
    const root = await listProjectFiles(path, '');
    expect(root.items.map((item) => item.name)).toEqual(['dist', 'docs', 'node_modules', 'src', '.gitignore', 'b2.txt', 'b10.txt', 'README.md']);
    expect(root.items.find((item) => item.name === 'dist')).toMatchObject({ type: 'directory', ignored: true, path: 'dist' });
    expect(root.items.find((item) => item.name === 'src')?.ignored).toBeUndefined();
    const nested = await listProjectFiles(path, 'src/control-ui');
    expect(nested.items).toMatchObject([{ name: 'app.js', path: 'src/control-ui/app.js', type: 'file', absolutePath: join(path, 'src', 'control-ui', 'app.js') }, { name: 'files.js' }]);
  });
  it('rejects paths outside the project folder', async () => {
    const path = setup();
    await expect(listProjectFiles(path, '../')).rejects.toThrow(/inside the project/);
    await expect(listProjectFiles(path, 'src/../../x')).rejects.toThrow(/inside the project/);
    await expect(listProjectFiles(path, tmpdir())).rejects.toThrow();
    await expect(listProjectFiles(path, 'README.md')).rejects.toThrow(/not a folder/);
    await expect(openProjectPath(path, { path: '../x', action: 'open' })).rejects.toThrow(/inside the project/);
    await expect(openProjectPath(path, { path: 'src', action: 'open' })).rejects.toThrow(/only be revealed/);
    await expect(openProjectPath(path, { path: 'README.md', action: 'run' })).rejects.toThrow(/open or reveal/);
  });
  it('searches unignored files and ranks file name matches first', async () => {
    const path = setup();
    const result = await searchProjectFiles(path, 'app');
    expect(result.items.map((item) => item.path)).toEqual(['src/control-ui/app.js']);
    expect((await searchProjectFiles(path, 'cuifil')).items[0]?.path).toBe('src/control-ui/files.js');
    expect((await searchProjectFiles(path, 'ui/files')).items[0]?.path).toBe('src/control-ui/files.js');
    expect((await searchProjectFiles(path, 'zzz')).items).toEqual([]);
    await expect(searchProjectFiles(path, 'a', 500)).rejects.toThrow(/limit/);
  });
  it('searches folders at every depth and lists a folder\'s contents after "folder/"', async () => {
    const path = setup();
    mkdirSync(join(path, 'src', 'deep', 'er'), { recursive: true }); writeFileSync(join(path, 'src', 'deep', 'er', 'leaf.ts'), '');
    expect((await searchProjectFiles(path, 'leaf')).items).toMatchObject([{ path: 'src/deep/er/leaf.ts', type: 'file' }]);
    expect((await searchProjectFiles(path, 'control-ui')).items[0]).toMatchObject({ path: 'src/control-ui', name: 'control-ui', type: 'directory', absolutePath: join(path, 'src', 'control-ui') });
    const inside = (await searchProjectFiles(path, 'src/deep/')).items.map((item) => item.path);
    expect(inside).toEqual(['src/deep/er', 'src/deep/er/leaf.ts']);
    expect((await searchProjectFiles(path, '', 200)).items.map((item) => item.path)).toEqual(expect.arrayContaining(['src', 'src/deep/er/leaf.ts']));
  });
  it('treats an untracked nested repository listed as "folder/" as a folder', async () => {
    const path = setup();
    mkdirSync(join(path, 'vendor', 'lib'), { recursive: true }); writeFileSync(join(path, 'vendor', 'lib', 'x.txt'), '');
    execFileSync('git', ['-C', join(path, 'vendor', 'lib'), 'init'], { stdio: 'pipe' });
    const items = (await searchProjectFiles(path, 'lib')).items;
    expect(items).toContainEqual(expect.objectContaining({ path: 'vendor/lib', type: 'directory' }));
    expect(items.every((item) => item.name)).toBe(true);
  });
});

describe('project file editor', () => {
  it('reads a text file with its version and saves an edit to the same file', async () => {
    const path = setup(); writeFileSync(join(path, 'src', 'control-ui', 'app.js'), 'const a = 1;\r\n');
    const opened = await readProjectFile(path, 'src/control-ui/app.js');
    expect(opened).toMatchObject({ path: 'src/control-ui/app.js', absolutePath: join(path, 'src', 'control-ui', 'app.js'), content: 'const a = 1;\r\n', size: 14, limit: EDITABLE_FILE_BYTES });
    expect(opened.version).toMatch(/^[0-9a-f]{64}$/);
    const saved = await writeProjectFile(path, { path: 'src/control-ui/app.js', content: 'const a = 2;\r\n', version: opened.version });
    expect(readFileSync(join(path, 'src', 'control-ui', 'app.js'), 'utf8')).toBe('const a = 2;\r\n');
    expect(saved.version).not.toBe(opened.version);
    expect((await readProjectFile(path, 'src/control-ui/app.js')).version).toBe(saved.version);
    // A shorter text leaves nothing of the longer one behind.
    await writeProjectFile(path, { path: 'src/control-ui/app.js', content: 'x', version: saved.version });
    expect(readFileSync(join(path, 'src', 'control-ui', 'app.js'), 'utf8')).toBe('x');
    expect(readFileSync(join(path, 'src', 'control-ui', 'files.js'), 'utf8')).toBe('');
  });
  it('refuses to save over a file that changed on disk unless the user chose to overwrite', async () => {
    const path = setup(), file = join(path, 'README.md'); writeFileSync(file, 'first');
    const opened = await readProjectFile(path, 'README.md');
    writeFileSync(file, 'written by an agent');
    await expect(writeProjectFile(path, { path: 'README.md', content: 'mine', version: opened.version })).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed on disk/) });
    expect(readFileSync(file, 'utf8')).toBe('written by an agent');
    await expect(writeProjectFile(path, { path: 'README.md', content: 'mine' })).rejects.toThrow(/version is required/);
    await writeProjectFile(path, { path: 'README.md', content: 'mine', overwrite: true });
    expect(readFileSync(file, 'utf8')).toBe('mine');
  });
  it('keeps a byte order mark and reports binary and oversized files without content', async () => {
    const path = setup();
    writeFileSync(join(path, 'bom.txt'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('şğ')]));
    const bom = await readProjectFile(path, 'bom.txt'); expect(bom.content).toBe('şğ');
    await writeProjectFile(path, { path: 'bom.txt', content: 'öç', version: bom.version });
    expect([...readFileSync(join(path, 'bom.txt'))]).toEqual([0xef, 0xbb, 0xbf, ...Buffer.from('öç')]);
    writeFileSync(join(path, 'data.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    expect(await readProjectFile(path, 'data.bin')).toMatchObject({ unavailable: 'binary', size: 8 });
    writeFileSync(join(path, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect((await readProjectFile(path, 'latin1.txt')).unavailable).toBe('binary');
    writeFileSync(join(path, 'big.log'), Buffer.alloc(EDITABLE_FILE_BYTES + 1, 0x61));
    const big = await readProjectFile(path, 'big.log'); expect(big).toMatchObject({ unavailable: 'large', size: EDITABLE_FILE_BYTES + 1 }); expect(big.content).toBeUndefined();
    await expect(writeProjectFile(path, { path: 'README.md', content: 'a'.repeat(EDITABLE_FILE_BYTES + 1), overwrite: true })).rejects.toMatchObject({ statusCode: 413 });
    await expect(writeProjectFile(path, { path: 'big.log', content: 'small', overwrite: true })).rejects.toMatchObject({ statusCode: 409 });
  });
  it('returns pictures as data URLs for the preview and opens SVG as text', async () => {
    const path = setup();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    writeFileSync(join(path, 'Logo.PNG'), bytes);
    const image = await readProjectFile(path, 'Logo.PNG');
    expect(image).toMatchObject({ size: 8, image: `data:image/png;base64,${bytes.toString('base64')}` });
    expect(image.version).toBeTruthy(); expect(image.content).toBeUndefined();
    writeFileSync(join(path, 'icon.svg'), '<svg/>');
    expect(await readProjectFile(path, 'icon.svg')).toMatchObject({ content: '<svg/>' });
  });
  it('creates an empty file with its extension in a chosen folder and never replaces one', async () => {
    const path = setup();
    expect(await createProjectFile(path, { folder: 'docs', name: 'notes.md' })).toMatchObject({ name: 'notes.md', path: 'docs/notes.md', type: 'file', absolutePath: join(path, 'docs', 'notes.md') });
    expect(readFileSync(join(path, 'docs', 'notes.md'), 'utf8')).toBe('');
    expect((await createProjectFile(path, { name: 'root.txt' })).path).toBe('root.txt');
    await expect(createProjectFile(path, { folder: 'docs', name: 'notes.md' })).rejects.toMatchObject({ statusCode: 409 });
    await expect(createProjectFile(path, { folder: 'docs', name: 'guide.md' })).rejects.toMatchObject({ statusCode: 409 });
    for (const name of ['', '..', 'a/b.txt', 'a\\b.txt', 'bad?.txt']) await expect(createProjectFile(path, { folder: '', name })).rejects.toThrow(/valid file name/);
    await expect(createProjectFile(path, { folder: '../', name: 'x.txt' })).rejects.toThrow(/inside the project/);
    await expect(createProjectFile(path, { folder: 'missing', name: 'x.txt' })).rejects.toThrow();
    await expect(createProjectFile(path, { folder: 'README.md', name: 'x.txt' })).rejects.toThrow(/not a folder/);
  });
  it('reads and writes only existing files inside the project folder, also through links', async () => {
    const path = setup(), outside = mkdtempSync(join(tmpdir(), 'aiws-project-files-outside-')); roots.push(outside);
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    await expect(readProjectFile(path, '../secret.txt')).rejects.toThrow(/inside the project/);
    await expect(readProjectFile(path, join(outside, 'secret.txt'))).rejects.toThrow(/inside the project/);
    await expect(writeProjectFile(path, { path: join(outside, 'secret.txt'), content: 'x', overwrite: true })).rejects.toThrow(/inside the project/);
    await expect(writeProjectFile(path, { path: 'src/../../secret.txt', content: 'x', overwrite: true })).rejects.toThrow(/inside the project/);
    await expect(readProjectFile(path, 'src')).rejects.toThrow(/not a file/);
    await expect(writeProjectFile(path, { path: 'new-file.txt', content: 'x', overwrite: true })).rejects.toMatchObject({ statusCode: 404 });
    // A folder link that leaves the project is refused; one that stays inside reaches the real file.
    symlinkSync(outside, join(path, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(join(path, 'docs'), join(path, 'inside'), process.platform === 'win32' ? 'junction' : 'dir');
    await expect(readProjectFile(path, 'escape/secret.txt')).rejects.toThrow(/inside the project/);
    await expect(writeProjectFile(path, { path: 'escape/secret.txt', content: 'x', overwrite: true })).rejects.toThrow(/inside the project/);
    expect(readFileSync(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    await writeProjectFile(path, { path: 'inside/guide.md', content: 'linked', overwrite: true });
    expect(readFileSync(join(path, 'docs', 'guide.md'), 'utf8')).toBe('linked');
  });
  it('serves the project folder by default and a task worktree only for a task of that project', async () => {
    const path = setup(), worktree = setup(), data = mkdtempSync(join(tmpdir(), 'aiws-project-files-data-')); roots.push(data);
    writeFileSync(join(path, 'README.md'), 'main'); writeFileSync(join(worktree, 'README.md'), 'task');
    const server = await startControlServer({ host: '127.0.0.1', port: 0, dataDir: data }); servers.push(server);
    const project = server.service.createProject({ name: 'Files', repositoryPath: path }), other = server.service.createProject({ name: 'Other', repositoryPath: worktree });
    const task = server.service.createTask({ projectId: project.id, title: 'Edit', provider: 'codex' }), plain = server.service.createTask({ projectId: project.id, title: 'No worktree', provider: 'codex' });
    server.service.task(task.id).worktree = { path: worktree, repositoryPath: path, branch: 'task', mainBranch: 'main' };
    const call = async (url: string, body?: unknown) => { const response = await fetch(`${server.url}/api/${url}`, body === undefined ? {} : { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any }; };
    const main = await call(`projects/${project.id}/files/content?path=README.md`), inTask = await call(`projects/${project.id}/files/content?path=README.md&task=${task.id}`);
    expect(main.body.content).toBe('main'); expect(inTask.body.content).toBe('task');
    expect((await call(`projects/${project.id}/files/content?task=${task.id}`, { path: 'README.md', content: 'task edit', version: inTask.body.version })).status).toBe(200);
    expect(readFileSync(join(worktree, 'README.md'), 'utf8')).toBe('task edit'); expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('main');
    // The stale version of the other root does not write, and another project cannot reach this task's worktree.
    const stale = await call(`projects/${project.id}/files/content`, { path: 'README.md', content: 'wrong root', version: inTask.body.version });
    expect(stale.status).toBe(409); expect(stale.body.error).toMatch(/changed on disk/); expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('main');
    expect((await call(`projects/${other.id}/files/content?path=README.md&task=${task.id}`)).status).toBe(404);
    expect((await call(`projects/${project.id}/files/content?path=README.md&task=${plain.id}`)).status).toBe(404);
    expect((await call(`projects/${project.id}/files/content?path=..%2Fx`)).status).toBe(403);
  });
});