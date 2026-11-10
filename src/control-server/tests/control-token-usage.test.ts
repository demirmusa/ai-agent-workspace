import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startControlServer } from '../server.js';
import { TokenUsageMonitor, usageTimestamp, usageWindow } from '../token-usage.js';

describe('token usage monitor', () => {
  let home: string;
  const now = new Date('2026-10-16T12:00:00Z').getTime();
  const stamp = (offset = 0) => new Date(now + offset).toISOString();
  async function json(path: string, value: unknown) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(value)); }
  const monitor = (request = vi.fn()) => new TokenUsageMonitor({ home, codexDir: join(home, '.codex'), claudeDir: join(home, '.claude'), now: () => now, fetch: request as typeof fetch });
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'aiws-usage-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });
  it('normalizes timestamps and clamps percentages without inventing unknown data', () => {
    expect(usageTimestamp(now/1000)).toBe(now); expect(usageTimestamp(now)).toBe(now); expect(usageTimestamp(stamp())).toBe(now);
    expect(usageTimestamp('garbage')).toBeNull(); expect(usageWindow(null, null).usedPercent).toBeNull();
    expect(usageWindow('', null).usedPercent).toBeNull(); expect(usageWindow(300, now).usedPercent).toBe(100); expect(usageWindow(-5, now).usedPercent).toBe(0);
  });
  it('shows unavailable providers with no credentials and makes no network requests', async () => {
    const request = vi.fn(); const data = await monitor(request).scan(true);
    expect(data.providers.map(p => [p.key, p.source])).toEqual([['codex', 'unavailable'], ['claude', 'unavailable'], ['agy', 'unavailable'], ['copilot', 'unavailable']]);
    expect(data.providers.every(p => p.short.usedPercent === null)).toBe(true); expect(request).not.toHaveBeenCalled();
  });
  it('lists skipped providers by name without looking them up', async () => {
    const request = vi.fn(), command = vi.fn();
    const service = new TokenUsageMonitor({ home, now: () => now, fetch: request as typeof fetch, agyCommand: command });
    const data = await service.scan(true, ['agy', 'copilot']);
    expect(data.providers.map(p => [p.key, p.source])).toEqual([['codex', 'unavailable'], ['claude', 'unavailable'], ['agy', 'unavailable'], ['copilot', 'unavailable']]);
    expect(data.providers.find(p => p.key === 'agy')!.name).toBeTruthy(); expect(command).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  });
  it('uses fresh Claude local windows and newest Codex event across files, skipping broken lines', async () => {
    await json(join(home, '.claude', 'usage-cache.json'), { updated_at: stamp(-30000), rate_limits: { five_hour: { used_percentage: 25, resets_at: stamp(3600000) }, seven_day: { used_percentage: 70, resets_at: stamp(86400000) } } });
    const date = new Date(now); const directory = join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0'));
    await mkdir(directory, { recursive: true });
    const event = (offset: number, percent: number) => JSON.stringify({ timestamp: stamp(offset), payload: { rate_limits: { primary: { used_percent: percent, resets_at: (now+3600000)/1000, window_minutes: 300 }, secondary: { used_percent: 40, resets_at: (now+86400000)/1000 } } } });
    await writeFile(join(directory, 'newest-event.jsonl'), `${event(-1000, 42)}\n{"rate_limits":broken}\n`);
    await writeFile(join(directory, 'newest-file.jsonl'), `${event(-60000, 99)}\n`); await utimes(join(directory,'newest-file.jsonl'),new Date(now+5000),new Date(now+5000));
    const request = vi.fn(); const data = await monitor(request).scan(true);
    expect(data.providers.find((p: { key: string }) => p.key === 'claude')!).toMatchObject({ source: 'local', active: true, short: { usedPercent: 25 }, weekly: { usedPercent: 70 } });
    expect(data.providers.find((p: { key: string }) => p.key === 'codex')!).toMatchObject({ source: 'local', short: { usedPercent: 42 }, weekly: { usedPercent: 40 } }); expect(request).not.toHaveBeenCalled();
  });
  it('classifies Codex windows by length when a plan reports only a weekly or monthly primary window', async () => {
    const date = new Date(now); const directory = join(home, '.codex', 'sessions', String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0'));
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'weekly.jsonl'), `${JSON.stringify({ timestamp: stamp(-1000), payload: { rate_limits: { primary: { used_percent: 6, window_minutes: 10080, resets_at: (now+86400000)/1000 }, secondary: null, plan_type: 'prolite' } } })}\n`);
    const weekly = (await monitor().scan()).providers.find((p: { key: string }) => p.key === 'codex')!;
    expect(weekly).toMatchObject({ source: 'local', short: { usedPercent: null }, weekly: { usedPercent: 6, windowMinutes: 10080 } });
    await json(join(home,'.codex-monthly','auth.json'),{tokens:{access_token:'SECRET'}});
    const request = vi.fn(async () => new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 2592000, reset_after_seconds: 3600 }, secondary_window: null } })));
    const monthly = (await new TokenUsageMonitor({ home: join(home, 'monthly'), codexDir: join(home, '.codex-monthly'), now: () => now, fetch: request as typeof fetch }).scan(true)).providers.find((p: { key: string }) => p.key === 'codex')!;
    expect(monthly).toMatchObject({ source: 'api', short: { usedPercent: null }, weekly: { usedPercent: 12, windowMinutes: 43200, resetsAt: stamp(3600000) } });
  });
  it('shows every Claude quota the API reports and keeps them beside fresh local windows', async () => {
    await json(join(home,'.claude','.credentials.json'),{claudeAiOauth:{accessToken:'SECRET'}});
    const limits=[{kind:'session',group:'session',percent:4,resets_at:stamp(3600000),scope:null},{kind:'weekly_all',group:'weekly',percent:27,resets_at:stamp(86400000),scope:null},
      {kind:'weekly_scoped',group:'weekly',percent:30,resets_at:stamp(86400000),scope:{model:{id:null,display_name:'Fable'},surface:null}}];
    const request=vi.fn().mockResolvedValue({ok:true,status:200,json:async()=>({five_hour:{utilization:4,resets_at:stamp(3600000)},seven_day:{utilization:27,resets_at:stamp(86400000)},seven_day_opus:null,limits})});
    const fable={id:'weekly_scoped:fable',label:'Weekly (Fable)',scope:'Fable',window:{usedPercent:30,resetsAt:stamp(86400000),windowMinutes:10080}};
    expect((await monitor(request).scan(true)).providers.find((p: { key: string }) => p.key === 'claude')!).toMatchObject({source:'api',short:{usedPercent:4},weekly:{usedPercent:27},buckets:[fable]});
    await json(join(home,'.claude','usage-cache.json'),{updated_at:stamp(10000),rate_limits:{five_hour:{used_percentage:6,resets_at:stamp(3600000)},seven_day:{used_percentage:28,resets_at:stamp(86400000)}}});
    expect((await new TokenUsageMonitor({ home, codexDir: join(home, '.codex'), claudeDir: join(home, '.claude'), now: () => now + 20000 }).scan(false)).providers.find((p: { key: string }) => p.key === 'claude')!).toMatchObject({source:'local',short:{usedPercent:6},buckets:[fable]});
  });
  it('asks the Claude API for per-model quotas while the statusline keeps local windows fresh, at most every five minutes', async () => {
    let clock = now; const clockNow = () => clock;
    await json(join(home,'.claude','.credentials.json'),{claudeAiOauth:{accessToken:'SECRET'}});
    await json(join(home,'.claude','usage-cache.json'),{updated_at:stamp(-5000),rate_limits:{five_hour:{used_percentage:6,resets_at:stamp(3600000)},seven_day:{used_percentage:28,resets_at:stamp(86400000)}}});
    const limits=[{kind:'weekly_scoped',group:'weekly',percent:30,resets_at:stamp(86400000),scope:{model:{id:null,display_name:'Fable'},surface:null}}];
    const request=vi.fn().mockImplementation(async()=>({ok:true,status:200,json:async()=>({five_hour:{utilization:6,resets_at:stamp(3600000)},seven_day:{utilization:28,resets_at:stamp(86400000)},limits})}));
    const service=new TokenUsageMonitor({ home, codexDir: join(home, '.codex'), claudeDir: join(home, '.claude'), now: clockNow, fetch: request as typeof fetch });
    const claude=async(...args: Parameters<TokenUsageMonitor['scan']>)=>(await service.scan(...args)).providers.find((p: { key: string }) => p.key === 'claude')!;
    expect(await claude(false)).toMatchObject({source:'local'}); expect(request).not.toHaveBeenCalled();
    expect(await claude(true)).toMatchObject({source:'api',buckets:[{label:'Weekly (Fable)'}]}); expect(request).toHaveBeenCalledTimes(1);
    // Within five minutes an automatic check reuses the saved snapshot; a manual refresh asks again.
    clock = now + 200000; await json(join(home,'.claude','usage-cache.json'),{updated_at:new Date(clock).toISOString(),rate_limits:{five_hour:{used_percentage:7}}});
    expect(await claude(true)).toMatchObject({source:'local',buckets:[{label:'Weekly (Fable)'}]}); expect(request).toHaveBeenCalledTimes(1);
    expect(await claude(true, [], { force: true })).toMatchObject({source:'api'}); expect(request).toHaveBeenCalledTimes(2);
  });
  it('scans a single provider with its accounts when asked', async () => {
    const data = await monitor().scan(false, [], { provider: 'copilot' });
    expect(data.providers.map(p => p.key)).toEqual(['copilot']);
  });
  it('imports newer legacy snapshots and preserves them on API failures', async () => {
    await json(join(home,'.claude','usage-cache.json'),{updated_at:stamp(-900000),rate_limits:{five_hour:{used_percentage:5}}});
    await json(join(home,'.windows-ai-token-viewer','usage-cache.json'),{claude:{updated_at:stamp(-300000),value:{five_hour:{utilization:55,resets_at:stamp(60000)},seven_day:{utilization:80}}}});
    await json(join(home,'.claude','.credentials.json'),{claudeAiOauth:{accessToken:'SECRET'}});
    const request=vi.fn().mockRejectedValue(new Error('offline')); const service=monitor(request);
    const data=await service.scan(true); expect(data.providers.find((p: { key: string }) => p.key === 'claude')!).toMatchObject({source:'cache',short:{usedPercent:55},weekly:{usedPercent:80}});
    expect(JSON.stringify(data)).not.toContain('SECRET'); await service.scan(true); expect(request).toHaveBeenCalledTimes(1);
  });
  it('fetches and persists sanitized provider data, deduplicates refresh and uses cache after restart', async () => {
    await json(join(home,'.codex','auth.json'),{tokens:{access_token:'SECRET',account_id:'ACCOUNT'}});
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({email:'me@example.com',secret:'DO NOT SAVE',rate_limit:{primary_window:{used_percent:30,reset_at:(now+3600000)/1000,limit_window_seconds:18000},secondary_window:{used_percent:60,reset_at:(now+86400000)/1000}}})));
    const service=monitor(request); const data=await service.scan(true); await Promise.all([service.scan(true),service.scan(true)]);
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0]?.[1].headers).toMatchObject({Authorization:'Bearer SECRET','ChatGPT-Account-Id':'ACCOUNT'});
    expect(data.providers.find((p: { key: string }) => p.key === 'codex')!).toMatchObject({source:'api',account:'me@example.com',short:{usedPercent:30,windowMinutes:300},weekly:{usedPercent:60}});
    const saved=await readFile(join(home,'.aiws','token-usage-cache.json'),'utf8');expect(saved).not.toMatch(/SECRET|DO NOT SAVE|ACCOUNT|me@example/);
    expect((await monitor().scan()).providers.find((p: { key: string }) => p.key === 'codex')!).toMatchObject({source:'cache',short:{usedPercent:30},weekly:{usedPercent:60}});
  });
  it('normalizes Antigravity quota groups from agy CLI /usage or Cloud Code API', async () => {
    await json(join(home, '.gemini', 'google_accounts.json'), { active: 'dev@example.com' });
    const agyCommand = vi.fn().mockResolvedValue(JSON.stringify({
      command: {
        data: {
          groups: [
            { name: 'Gemini Models', buckets: [{ id: 'gemini-5h', name: '5h', window: '5h', remaining_fraction: 0.85, reset_time: stamp(3600000) }, { id: 'gemini-weekly', name: 'Weekly', window: 'weekly', remaining_fraction: 0.9, reset_time: stamp(86400000) }] },
            { name: 'Claude and GPT models', buckets: [{ id: 'claude-5h', name: '5h', window: '5h', remaining_fraction: 0.75, reset_time: stamp(3600000) }] },
          ],
        },
      },
    }));
    const service = new TokenUsageMonitor({ home, codexDir: join(home, '.codex'), claudeDir: join(home, '.claude'), agyDir: join(home, '.gemini'), now: () => now, agyCommand });
    const data = await service.scan(true);
    expect(agyCommand).toHaveBeenCalledWith(['--output-format', 'json', '--print', '/usage']);
    expect(data.providers.find((p: { key: string }) => p.key === 'agy')!).toMatchObject({
      key: 'agy',
      name: 'Antigravity',
      account: 'dev@example.com',
      source: 'api',
      short: { usedPercent: 15, windowMinutes: 300 },
      weekly: { usedPercent: 10, windowMinutes: 10080 },
    });
    expect(data.providers.find((p: { key: string }) => p.key === 'agy')!?.buckets).toHaveLength(3);
  });
  it('serves authenticated usage, refreshes Claude via OAuth and never returns credentials', async () => {
    await json(join(home,'.claude','.credentials.json'),{claudeAiOauth:{accessToken:'PRIVATE_OAUTH'}});
    const request=vi.fn().mockResolvedValue(new Response(JSON.stringify({five_hour:{utilization:12,resets_at:stamp(3600000)},seven_day:{utilization:48,resets_at:stamp(86400000)}})));
    const server=await startControlServer({port:0,dataDir:join(home,'control'),token:'CONTROL_SECRET',tokenUsage:{home,codexDir:join(home,'.codex'),claudeDir:join(home,'.claude'),now:()=>now,fetch:request as typeof fetch}});
    try {
      expect((await fetch(`${server.url}/api/token-usage`)).status).toBe(401);
      const headers={Authorization:'Bearer CONTROL_SECRET'};
      const local=await fetch(`${server.url}/api/token-usage`,{headers});expect(local.status).toBe(200);expect(request).not.toHaveBeenCalled();
      const response=await fetch(`${server.url}/api/token-usage?refresh=1`,{headers});const body=await response.json();
      expect(body.providers.find((p: { key: string }) => p.key === 'claude')!).toMatchObject({source:'api',short:{usedPercent:12},weekly:{usedPercent:48}});
      expect(request.mock.calls[0]?.[0]).toBe('https://api.anthropic.com/api/oauth/usage');
      expect(request.mock.calls[0]?.[1].headers).toMatchObject({Authorization:'Bearer PRIVATE_OAUTH','anthropic-beta':'oauth-2025-04-20'});
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE_OAUTH|CONTROL_SECRET/);
    } finally {await server.close();}
  });
  it('honors HTTP 429 Retry-After without replacing cached data', async () => {
    await json(join(home,'.claude','.credentials.json'),{claudeAiOauth:{accessToken:'SECRET'}});
    const request=vi.fn().mockResolvedValue(new Response('',{status:429,headers:{'Retry-After':'900'}})); const service=monitor(request);
    const data=await service.scan(true);expect(data.providers.find((p: { key: string }) => p.key === 'claude')!?.retryAt).toBe(stamp(900000));await service.scan(true);expect(request).toHaveBeenCalledTimes(1);
  });
});
