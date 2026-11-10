import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Attachments, MAX_IMAGE_BYTES, allowedImageUrl, imageSources } from '../attachments.js';
import { startControlServer, type RunningControlServer } from '../server.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=', 'base64');
let directory: string; let server: RunningControlServer | undefined;
afterEach(async () => { await server?.close(); server = undefined; if (directory) await rm(directory, { recursive: true, force: true, maxRetries: 5 }); });
async function setup() { directory = await mkdtemp(join(tmpdir(), 'aiws-images-')); return new Attachments(directory); }

describe('task images', () => {
  it('stores immutable raster images and rejects invalid uploads and paths', async () => {
    const files = await setup(); const image = await files.upload({ data: png.toString('base64') });
    expect(await files.save(png)).toEqual(image);
    expect((await files.read(image.id)).data).toEqual(png);
    await expect(files.upload({ data: 'bad!' })).rejects.toThrow('base64');
    await expect(files.save(Buffer.alloc(0))).rejects.toThrow('empty');
    // Non-images are stored as plain files and are served as downloads, never as markup.
    const svg = await files.save(Buffer.from('<svg onload="alert(1)"/>'), undefined, 'x.SVG');
    expect(svg.id).toMatch(/^[a-f0-9]{64}\.svg$/); expect((await files.read(svg.id)).type).toBe('application/octet-stream');
    expect((await files.save(Buffer.from('a'))).id).toMatch(/\.bin$/);
    // Uploads have no size limit.
    await expect(files.save(Buffer.alloc(MAX_IMAGE_BYTES + 1), undefined, 'big.zip')).resolves.toMatchObject({ id: expect.stringMatching(/\.zip$/) });
    await expect(files.read('../state.json')).rejects.toThrow('Invalid');
  });
  it('stores project images in the repository .aiws folder, ignored by Git, and finds them again', async () => {
    directory = await mkdtemp(join(tmpdir(), 'aiws-images-'));
    const repository = join(directory, 'repo'); await mkdir(repository);
    const files = new Attachments(join(directory, 'data'), undefined, fetch, () => [repository]);
    const image = await files.upload({ data: png.toString('base64') }, repository);
    expect(await readFile(join(repository, '.aiws', 'attachments', image.id))).toEqual(png);
    expect(await readFile(join(repository, '.aiws', '.gitignore'), 'utf8')).toMatch(/^\*$/m);
    await writeFile(join(repository, '.aiws', '.gitignore'), 'custom\n*\n'); await files.save(png, repository);
    expect(await readFile(join(repository, '.aiws', '.gitignore'), 'utf8')).toBe('custom\n*\n');
    expect((await files.read(image.id)).data).toEqual(png); expect(await files.exists(image.id)).toBe(true);
    expect(await files.materialize(`![x](${image.url})`, join(directory, 'input'), false)).toContain(image.id);
    expect(await new Attachments(join(directory, 'data')).exists(image.id)).toBe(false);
    const git = (...args: string[]) => promisify(execFile)('git', ['-C', repository, ...args]);
    await git('init'); expect((await git('status', '--porcelain', '--untracked-files=all')).stdout).toBe('');
  });
  it('routes project uploads from the API to that project', async () => {
    directory = await mkdtemp(join(tmpdir(), 'aiws-images-'));
    server = await startControlServer({ port: 0, dataDir: join(directory, 'data') });
    const project = server.service.createProject({ name: 'Images', repositoryPath: directory });
    const response = await fetch(server.url + '/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: png.toString('base64'), projectId: project.id }) });
    expect(response.status).toBe(201); const image = await response.json() as { id: string; url: string };
    expect(await readFile(join(directory, '.aiws', 'attachments', image.id))).toEqual(png);
    expect(Buffer.from(await (await fetch(server.url + image.url)).arrayBuffer())).toEqual(png);
    expect((await fetch(server.url + '/api/attachments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data: png.toString('base64'), projectId: 'missing' }) })).status).toBe(404);
  });
  it('accepts images AIWS published to the attachment branch', () => {
    const id = 'd'.repeat(64) + '.png';
    expect(imageSources(`![x](https://github.com/owner/repo/blob/aiws-attachments/.aiws/attachments/${id}?raw=true)`)).toHaveLength(1);
    expect(allowedImageUrl(new URL(`https://raw.githubusercontent.com/owner/repo/aiws-attachments/.aiws/attachments/${id}?token=x`))).toBe(true);
    expect(allowedImageUrl(new URL('https://github.com/owner/repo/blob/main/secrets.png?raw=true'))).toBe(false);
    expect(allowedImageUrl(new URL('https://raw.githubusercontent.com/owner/repo/main/a.png'))).toBe(false);
  });
  it('copies local images into the run and produces native and Docker paths', async () => {
    const files = await setup(); const image = await files.save(png); const input = join(directory, 'input');
    const description = `Screenshot: ![test](${image.url})\n${image.url}`;
    expect(imageSources(description)).toEqual([image.url]);
    expect(await files.materialize(description, input, false)).toContain(join(input, 'images', image.id));
    expect(await readFile(join(input, 'images', image.id))).toEqual(png);
    expect(await files.materialize(description, input, true)).toContain('/run/aiws/input/images/' + image.id);
    expect(await files.materialize(description, input, false)).toBe('Screenshot: ' + join(input, 'images', image.id) + '\n' + join(input, 'images', image.id));
    await expect(files.materialize('/api/attachments/' + 'a'.repeat(64) + '.png', input, false)).rejects.toThrow('not found');
  });
  it('downloads GitHub markdown and HTML images, limits redirects and never leaks credentials', async () => {
    await setup(); const request = vi.fn<typeof fetch>();
    request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'https://private-user-images.githubusercontent.com/1/signed.png' } }));
    request.mockResolvedValueOnce(new Response(png));
    const files = new Attachments(directory, 'secret', request);
    const context = await files.materialize('<img src="https://github.com/user-attachments/assets/abc">', join(directory, 'input'), true);
    expect(context).toContain('/run/aiws/input/images/');
    expect(request.mock.calls[0]?.[1]?.headers).toHaveProperty('authorization', 'Bearer secret');
    expect(request.mock.calls[1]?.[1]?.headers).not.toHaveProperty('authorization');
    request.mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }));
    await expect(files.download('https://github.com/user-attachments/assets/abc')).rejects.toThrow('Unsupported');
    expect(request).toHaveBeenCalledTimes(3);
    expect(imageSources('![x](http://localhost/a.png) ![y](https://evil.test/a.png)')).toEqual([]);
  });
  it('rejects remote failures and oversized streamed downloads', async () => {
    await setup(); const request = vi.fn<typeof fetch>(); const files = new Attachments(directory, undefined, request);
    request.mockResolvedValueOnce(new Response('no', { status: 404 }));
    await expect(files.download('https://user-images.githubusercontent.com/a.png')).rejects.toThrow('404');
    request.mockResolvedValueOnce(new Response(Buffer.alloc(MAX_IMAGE_BYTES + 1)));
    await expect(files.download('https://user-images.githubusercontent.com/a.png')).rejects.toThrow('10 MiB');
  });
  it('authenticates upload and preview and serves local editor assets', async () => {
    await setup(); server = await startControlServer({ port: 0, dataDir: directory, token: 'test' });
    const headers = { Authorization: 'Bearer test', 'Content-Type': 'application/json' };
    expect((await fetch(server.url + '/api/attachments', { method: 'POST', body: '{}' })).status).toBe(401);
    const response = await fetch(server.url + '/api/attachments', { method: 'POST', headers, body: JSON.stringify({ data: png.toString('base64') }) });
    expect(response.status).toBe(201); const image = await response.json() as { url: string };
    expect((await fetch(server.url + image.url)).status).toBe(401);
    const preview = await fetch(server.url + image.url, { headers });
    expect(preview.headers.get('content-type')).toBe('image/png');
    expect(preview.headers.get('content-security-policy')).toContain("img-src 'self' data: blob:");
    expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
    for (const asset of ['/vendor/easymde.js', '/vendor/easymde.css', '/vendor/purify.js', '/images/attachments.js']) expect((await fetch(server.url + asset)).status).toBe(200);
  });
  it('prepares images before a real agent process receives its prompt', async () => {
    await setup(); server = await startControlServer({ port: 0, dataDir: join(directory, 'data') });
    const project = server.service.createProject({ name: 'Image handoff', repositoryPath: directory });
    const image = await server.service.attachments.save(png);
    const task = server.service.createTask({ projectId: project.id, title: 'Read image', description: `![screenshot](${image.url})`, provider: 'command', terminalMode: 'stream', command: {
      executable: process.execPath, args: ['-e', "let text='';process.stdin.on('data',x=>text+=x);process.stdin.on('end',()=>{const path=text.match(/\\S*images\\S[a-f0-9]{64}\\.png/)[0];const b=require('fs').readFileSync(path);console.log(b.subarray(0,8).toString('hex')==='89504e470d0a1a0a'?'IMAGE_OK':'IMAGE_BAD')})"],
    } });
    const run = server.service.startTask(task.id);
    await vi.waitFor(() => expect(server!.service.run(run.id).status).toBe('completed'), { timeout: 10000 });
    expect(server.service.snapshot().events.some(event => event.runId === run.id && event.message.includes('IMAGE_OK'))).toBe(true);
    expect(await readFile(join(run.inputDirectory!, 'images', image.id))).toEqual(png);
  });
});
