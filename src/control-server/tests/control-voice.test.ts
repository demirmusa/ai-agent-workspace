import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { startControlServer, type RunningControlServer } from '../server.js';
import { aiProviders } from '../ai-providers/index.js';
import type { VoiceHandlers, VoiceSource } from '../ai-providers/voice.js';

const roots: string[] = [], servers: RunningControlServer[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(servers.splice(0).map((server) => server.close()));
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
async function boot(token?: string): Promise<RunningControlServer> {
  const directory = mkdtempSync(join(tmpdir(), 'aiws-voice-')); roots.push(directory);
  const server = await startControlServer({ port: 0, dataDir: join(directory, 'data'), staticDir: directory, ...(token ? { token } : {}) }); servers.push(server);
  return server;
}
const messages = (socket: WebSocket): Promise<Record<string, unknown>[]> => new Promise((resolve, reject) => {
  const received: Record<string, unknown>[] = [];
  socket.on('message', (data) => { received.push(JSON.parse(String(data)) as Record<string, unknown>); });
  socket.on('close', () => { resolve(received); });
  socket.on('error', reject);
});

describe('voice dictation', () => {
  it('lists which providers can dictate and defaults to Claude', async () => {
    const server = await boot();
    expect(aiProviders.info().filter((provider) => provider.voice).map((provider) => provider.id)).toEqual(['codex', 'claude']);
    expect(server.service.store.state.settings.voiceProvider).toBe('claude');
    expect(() => server.service.updateSettings({ voiceProvider: 'opencode' })).toThrow('voiceProvider');
    expect(server.service.updateSettings({ voiceProvider: 'codex' }).voiceProvider).toBe('codex');
    expect(server.service.updateSettings({ voiceProvider: 'claude' }).voiceProvider).toBe('claude');
  });

  it('stores the footer usage pins and hidden providers in the settings', async () => {
    const server = await boot();
    expect(server.service.store.state.settings.usageFooter).toEqual({ pins: {}, hidden: [] });
    const saved = server.service.updateSettings({ usageFooter: { pins: { claude: ['short', 'weekly'], codex: [] }, hidden: ['copilot', 'copilot'] } }).usageFooter;
    expect(saved).toEqual({ pins: { claude: ['short', 'weekly'] }, hidden: ['copilot'] });
    expect(server.service.updateSettings({ voiceProvider: 'claude' }).usageFooter).toEqual(saved);
    expect(() => server.service.updateSettings({ usageFooter: { pins: { nope: ['short'] }, hidden: [] } })).toThrow('usageFooter');
  });

  it('transcribes Codex audio with the signed-in ChatGPT account in auth.json', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'aiws-codex-voice-')); roots.push(directory);
    writeFileSync(join(directory, 'auth.json'), JSON.stringify({ tokens: { access_token: 'chatgpt-token', account_id: 'acct-123' } }));
    let calledUrl = '', calledHeaders: Record<string, string> = {}, wavHeader = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      calledUrl = String(input);
      calledHeaders = (init?.headers ?? {}) as Record<string, string>;
      const form = init?.body as FormData;
      const file = form.get('file') as Blob;
      wavHeader = Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString('ascii');
      expect(form.get('language')).toBe('tr');
      return new Response(JSON.stringify({ text: 'merhaba codex' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const transcripts: Array<{ text: string; final: boolean }> = [];
    await new Promise<void>((resolve, reject) => {
      aiProviders.require('codex').voice!.open({ home: directory, dir: directory, env: {} }, { language: 'tr' }, {
        onReady() {},
        onTranscript(text, final) { transcripts.push({ text, final }); },
        onError(message) { reject(new Error(message)); },
        onClose() { resolve(); },
      }).then((connection) => {
        connection.send(Buffer.from([1, 0, 2, 0]));
        connection.finish();
      }, reject);
    });
    expect(calledUrl).toBe('https://chatgpt.com/backend-api/transcribe');
    expect(calledHeaders).toMatchObject({ Authorization: 'Bearer chatgpt-token', 'ChatGPT-Account-Id': 'acct-123', originator: 'codex_vscode' });
    expect(wavHeader).toBe('RIFF');
    expect(transcripts).toEqual([{ text: 'merhaba codex', final: true }]);
  });

  it('relays audio to the provider and its transcripts back to the browser', async () => {
    const server = await boot();
    const audio: Buffer[] = []; let finished = false, language = '';
    const source: VoiceSource = {
      async open(_context, options, handlers: VoiceHandlers) {
        language = options.language; queueMicrotask(() => handlers.onReady());
        return {
          send: (pcm) => { audio.push(pcm); handlers.onTranscript('merhaba', false); },
          finish: () => { finished = true; handlers.onTranscript('merhaba dünya', true); handlers.onClose(); },
          close: () => {},
        };
      },
    };
    vi.spyOn(aiProviders.require('claude'), 'voice', 'get').mockReturnValue(source);
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/api/voice?provider=claude&language=tr`);
    const result = messages(socket);
    await new Promise((resolve) => socket.once('open', resolve));
    socket.send(Buffer.from([1, 2, 3, 4])); socket.send(JSON.stringify({ type: 'finish' }));
    const received = await result;
    expect(received).toContainEqual({ type: 'ready' });
    expect(received).toContainEqual({ type: 'transcript', text: 'merhaba dünya', final: true });
    expect(received.at(-1)).toEqual({ type: 'closed' });
    expect(audio).toEqual([Buffer.from([1, 2, 3, 4])]); expect(finished).toBe(true); expect(language).toBe('tr');
  });

  it('reports a start failure and refuses providers without voice, bad tokens and foreign origins', async () => {
    const server = await boot('secret');
    const base = server.url.replace('http', 'ws');
    const rejected = (url: string, origin?: string): Promise<number> => new Promise((resolve) => {
      const socket = new WebSocket(url, origin ? { origin } : undefined);
      socket.on('unexpected-response', (_request, response) => { resolve(response.statusCode ?? 0); });
      socket.on('open', () => { resolve(101); });
    });
    expect(await rejected(`${base}/api/voice?provider=claude`)).toBe(401);
    expect(await rejected(`${base}/api/voice?provider=opencode&token=secret`)).toBe(404);
    expect(await rejected(`${base}/api/voice?provider=claude&token=secret`, 'https://evil.example')).toBe(403);
    vi.spyOn(aiProviders.require('claude'), 'voice', 'get').mockReturnValue({ open: () => Promise.reject(new Error('Sign in first.')) });
    const socket = new WebSocket(`${base}/api/voice?provider=claude&token=secret`);
    expect(await messages(socket)).toEqual([{ type: 'error', message: 'Sign in first.' }]);
  });
});
