import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { readFileSync } from 'node:fs';
import { uiScriptSource } from './ui-sources.js';

const source = await uiScriptSource(path => ['translations-en.js', 'i18n.js', 'ui-common.js', 'plugins.js'].includes(path) || path.startsWith('ui/') || path.startsWith('conversation/') || path.startsWith('plugin-host/'));
const windows: Window[] = [];
function fixture(language = 'tr') {
  const window = new Window({ url: 'http://localhost' }) as any; windows.push(window); window.localStorage.setItem('aiws.language', language); window.eval(source);
  const host = window.document.createElement('div'); window.document.body.append(host);
  return { window, host, kit: window.AIWSConversationKit, api: window.AIWSAgentConsole };
}
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });

const run = { id: 'run-1', taskId: 'task-1', provider: 'claude', status: 'completed', startedAt: '2026-10-16T12:00:00Z' };
let serial = 0;
const line = (value: unknown, second = 10) => ({ id: `event-${++serial}`, taskId: 'task-1', runId: 'run-1', type: 'stdout', message: `${JSON.stringify(value)}\n`, createdAt: `2026-10-16T12:00:${String(second).padStart(2, '0')}Z` });
/** A tool call and its result, as a provider transcript records them. */
function toolEvents(name: string, input: unknown, output?: string, extra: Record<string, unknown> = {}) {
  const id = `tool-${++serial}`;
  return [line({ type: 'assistant', message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] } }), ...(output === undefined ? [] : [line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: output, ...extra }] } }, 11)])];
}
const bash = (command: string, output?: string, extra: Record<string, unknown> = {}) => toolEvents('Bash', { command, description: 'Runs it' }, output, extra);
const data = (events: unknown[], more = {}) => ({ taskId: 'task-1', runs: [run], events, ...more });
const pluginEntry = (window: any, folder: string) => window.eval(`(function(){const __entry={};${readFileSync(new URL(`../../assets/plugins/${folder}/plugin.js`, import.meta.url), 'utf8').replace('export function activate(aiws)', '__entry.activate = function activate(aiws)')};return __entry;})()`);

describe('understanding commands', () => {
  it('sees through shells, launchers and a leading cd', () => {
    const { kit } = fixture();
    const cases: Array<[string, string, string]> = [
      ['cd src && npx vitest run control-ui/tests', 'test', 'vitest'], ['npm run typecheck', 'build', 'npm'], ['pwsh -Command "dotnet test App.sln -c Release"', 'test', 'dotnet'], ['$env:CI=1; ./gradlew.bat assembleDebug', 'build', 'gradlew'],
      ['rg -n "useState" src | head -20', 'search', 'rg'], ['Get-Content C:\\a\\b.txt -TotalCount 5', 'read', 'get-content'], ['git commit -m "Fix it"', 'git', 'git'], ['npm ci', 'install', 'npm'], ['echo hi > out.txt', 'write', 'echo'], ['ls -la', 'list', 'ls'], ['curl https://example.com', 'network', 'curl'], ['docker compose up -d', 'docker', 'docker'], ['npm run build && npm test', 'test', 'npm'], ['somethingelse --flag', 'shell', 'somethingelse'],
    ];
    for (const [command, kind, program] of cases) { const insight = kit.commandInsight(command); if (kind !== 'write') { expect(insight, command).toMatchObject({ kind, program }); } else expect(insight.kind, command).toBe('shell'); }
    expect(kit.commandInsight('rg -n -i "use State" src/ui -g "*.ts"').search).toEqual({ pattern: 'use State', paths: ['src/ui'], flags: ['-i', '*.ts'] });
    expect(kit.commandInsight('git commit -m "Fix it"')).toMatchObject({ title: 'Commit', subject: 'Fix it' });
    expect(kit.commandInsight('aiws control complete --run run_1 --summary Done').title).toBe('Görevi tamamlama');
    expect(kit.commandInsight('cat "a && b.txt"').commands).toHaveLength(1);
  });
  it('reads results of the common test runners', () => {
    const { kit } = fixture();
    expect(kit.testSummary('\x1b[32m Test Files  1 failed | 3 passed (4)\x1b[0m\n      Tests  2 failed | 120 passed | 1 skipped (123)\n   Duration  3.21s')).toMatchObject({ passed: 120, failed: 2, skipped: 1, total: 123, duration: '3.21s' });
    expect(kit.testSummary('Tests:       1 failed, 5 passed, 6 total\n  ● Cart › adds an item')).toMatchObject({ passed: 5, failed: 1, total: 6, failures: ['Cart › adds an item'] });
    expect(kit.testSummary('===== 2 failed, 10 passed in 3.20s =====\nFAILED tests/a.py::test_b')).toMatchObject({ passed: 10, failed: 2, duration: '3.20s' });
    expect(kit.testSummary('Failed!  - Failed:     1, Passed:    11, Skipped:     2, Total:    14, Duration: 1 s - App.Tests.dll (net8.0)')).toMatchObject({ passed: 11, failed: 1, skipped: 2, total: 14 });
    expect(kit.testSummary('test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured')).toMatchObject({ passed: 3, failed: 0, skipped: 1 });
    expect(kit.testSummary('  12 passed (3.4s)\n  1 failed')).toMatchObject({ passed: 12, failed: 1, duration: '3.4s' });
    expect(kit.testSummary('ok   example.com/a 0.2s\nFAIL example.com/b 0.1s\n--- FAIL: TestB (0.0s)')?.failed).toBeGreaterThan(0);
    expect(kit.testSummary('nothing about checks here')).toBeNull();
  });
  it('reads compiler diagnostics once each and groups search matches by file', () => {
    const { kit } = fixture();
    const found = kit.diagnostics('C:\\src\\App\\Order.cs(10,5): error CS1002: ; expected [C:\\src\\App\\App.csproj]\nC:\\src\\App\\Order.cs(10,5): error CS1002: ; expected [C:\\src\\App\\App.csproj]\nsrc/a.ts(3,1): warning TS6133: unused\nsrc/b.ts:4:2 - error TS2322: wrong type\ne: file:///C:/app/Main.kt:10:5 Unresolved reference: foo');
    expect(found).toMatchObject({ errors: 3, warnings: 1 });
    expect(found.items[0]).toMatchObject({ severity: 'error', file: 'C:\\src\\App\\Order.cs', line: 10, column: 5, code: 'CS1002', message: '; expected' });
    expect(kit.searchResults('src/a.ts:3:const a\nsrc/a.ts:9:const b\nC:\\w\\b.ts:1:x\n').files.map((file: any) => [file.path, file.count])).toEqual([['src/a.ts', 2], ['C:\\w\\b.ts', 1]]);
    expect(kit.searchResults('Found 2 files\nsrc/a.ts\nsrc/b.ts').files.map((file: any) => file.path)).toEqual(['src/a.ts', 'src/b.ts']);
    expect(kit.searchResults('No matches found').empty).toBe(true);
  });
});

describe('tool views in the chat', () => {
  it('shows a code search as its query and matches per file, highlighting and escaping them', () => {
    const { api, host } = fixture();
    api.create(host, data(toolEvents('Grep', { pattern: 'use.tate', path: 'src', '-i': true, output_mode: 'content' }, 'src/a.ts:3:const <b> = useState()\nsrc/b.ts:7:useState', {})));
    const row = host.querySelector('article.cv-tool');
    expect(row.querySelector('summary strong').textContent).toBe('Kodda arama');
    expect(row.querySelector('.cv-search-pattern').textContent).toBe('use.tate');
    expect([...row.querySelectorAll('.cv-search-file b')].map((file: any) => file.textContent)).toEqual(['a.ts', 'b.ts']);
    expect(row.querySelector('mark').textContent).toBe('useState');
    expect(row.querySelector('.cv-search-file .cv-code-view span').innerHTML).toContain('&lt;b&gt;');
    expect(row.querySelector('.cv-tool-chips').textContent).toContain('2 eşleşme');
  });
  it('titles a command by what it does, or by the agent\'s words when nothing recognizes it', () => {
    const { api, host } = fixture();
    api.create(host, data([...bash('npx vitest run', ' Tests  1 failed | 2 passed (3)\n × adds up'), ...bash('frobnicate --all', 'done')]));
    const titles = [...host.querySelectorAll('article.cv-tool summary strong')].map((node: any) => node.textContent);
    expect(titles).toEqual(['Testleri çalıştırma', 'Runs it']);
    const test = host.querySelector('article.cv-tool');
    expect(test.querySelector('.cv-tool-inline .cv-result-bar')).not.toBeNull();
    expect(test.querySelector('.cv-tool-inline .cv-failures').textContent).toContain('adds up');
    expect(test.querySelector('.cv-tool-chips').textContent).toContain('2 geçti');
  });
  it('keeps test runs in sight when a long tool streak folds', () => {
    const { api, host } = fixture();
    const events = [...bash('npm test', 'Tests: 3 passed, 3 total'), ...Array.from({ length: 8 }, (_, index) => bash(`cat f${index}.txt`, 'x')).flat(), ...bash('ls', 'a')];
    api.create(host, data(events));
    expect(host.querySelector('.cv-tool-fold').textContent).toContain('önceki araç çağrısı');
    const test = [...host.querySelectorAll('article.cv-tool')].find((node: any) => node.textContent.includes('Testleri çalıştırma')) as any;
    expect(test.hidden).toBe(false);
  });
  it('shows an edit as a diff with its counts', () => {
    const { api, host } = fixture();
    api.create(host, data(toolEvents('Edit', { file_path: 'src/a.ts', old_string: 'one\ntwo\nthree', new_string: 'one\nTWO\nthree\nfour' }, 'ok')));
    const row = host.querySelector('article.cv-files');
    expect(row.querySelector('.cv-tool-chips').textContent).toContain('+2'); expect(row.querySelector('.cv-tool-chips').textContent).toContain('−1');
    expect(row.querySelector('[data-line=del]').textContent).toBe('-two');
    expect([...row.querySelectorAll('[data-line=add]')].map((node: any) => node.textContent)).toEqual(['+TWO', '+four']);
  });
  it('numbers the lines of a read and states its range', () => {
    const { api, host } = fixture();
    api.create(host, data(toolEvents('Read', { file_path: 'src/a.ts', offset: 10, limit: 2 }, '10\tconst a\n11\tconst b\n', { meta: { startLine: 10, numLines: 2, totalLines: 40 } })));
    const row = host.querySelector('article.cv-tool');
    expect(row.querySelector('.cv-code-view i').textContent).toBe('10');
    expect(row.querySelector('.cv-tool-chips').textContent).toContain('Satır 10–11 / 40');
  });
  it('shows a to-do list, a plan and the question tool with the chosen answer', () => {
    const { api, host } = fixture();
    const question = { question: 'Hangisi?', header: 'Seçim', options: [{ label: 'A', description: 'İlki' }, { label: 'B' }] };
    api.create(host, data([...toolEvents('TodoWrite', { todos: [{ content: 'Yaz', activeForm: 'Yazılıyor', status: 'in_progress' }, { content: 'Bitir', status: 'completed' }] }, 'ok'), ...toolEvents('AskUserQuestion', { questions: [question] }, 'answered', { meta: { answers: { 'Hangisi?': 'B' } } }), ...toolEvents('ExitPlanMode', { plan: '# Plan\n- adım' }, 'ok')]));
    expect(host.querySelector('.cv-steps li[data-state=running]').textContent).toContain('Yazılıyor');
    expect(host.querySelector('.cv-tool-questions li[data-selected]').textContent).toBe('B');
    expect(host.querySelector('.cv-tool-questions').closest('details').querySelector('.cv-output')).toBeNull();
    expect(host.querySelector('.cv-tool-plan h1, .cv-tool-plan h2, .cv-tool-plan h3')?.textContent).toBe('Plan');
  });
  it('says what the agent is doing right now', () => {
    const { api, host } = fixture();
    const view = api.create(host, data(bash('dotnet test App.sln'), { runs: [{ ...run, status: 'running' }] }));
    expect(host.querySelector('.cv-activity').hidden).toBe(false);
    expect(host.querySelector('.cv-activity strong').textContent).toBe('Testler çalışıyor');
    expect(host.querySelector('.cv-activity code').textContent).toContain('dotnet test');
    view.update(data(bash('dotnet test App.sln', 'ok'), { runs: [run] }));
    expect(host.querySelector('.cv-activity').hidden).toBe(true);
    view.destroy();
  });
  it('hides the exec wrapper once Codex recorded what it really ran', () => {
    const { api } = fixture();
    const wrapper = toolEvents('exec', { input: 'text(await tools.exec_command({cmd:"npm test"}));' }, 'Script completed\nWall time 1 seconds\nOutput:\nall good');
    const item = line({ type: 'item.completed', item: { type: 'command_execution', id: 'exec-1', command: ['pwsh.exe', '-Command', 'npm test'], aggregated_output: 'Tests: 1 passed, 1 total', exit_code: 0, duration_ms: 900 } }, 10);
    const nodes = api.normalize(data([...wrapper, item]))[0].nodes;
    expect(nodes.map((node: any) => node.id)).toEqual(['item:0:exec-1']);
    expect(nodes[0]).toMatchObject({ command: 'npm test', title: 'Testleri çalıştırma', durationMs: 900 });
    const alone = api.normalize(data(toolEvents('exec', { input: 'text(await tools.exec_command({cmd:"npm test"}));' }, 'Script completed\nWall time 1 seconds\nOutput:\nall good')))[0].nodes;
    expect(alone[0]).toMatchObject({ output: 'all good', command: 'npm test' });
  });
});

describe('what the human typed', () => {
  const queued = (op: string, text?: string, second = 10) => line({ type: 'queued_message', op, ...(text ? { text } : {}), at: `s${second}` }, second);
  it('shows a message typed in the terminal at once and marks it until the agent receives it', () => {
    const { api, host } = fixture();
    const waiting = [queued('enqueue', 'şunu da yap', 12)], running = { runs: [{ ...run, status: 'running' }] };
    expect(api.normalize(data(waiting, running))[0].nodes.filter((node: any) => node.kind === 'user')).toEqual([expect.objectContaining({ text: 'şunu da yap', queued: true })]);
    const view = api.create(host, data(waiting, running));
    expect(host.querySelector('article.cv-user .cv-message-tag').textContent).toBe('Sırada');
    const delivered = [...waiting, queued('deliver', 'şunu da yap', 40)];
    view.update(data(delivered, running));
    expect(host.querySelectorAll('article.cv-user')).toHaveLength(1); expect(host.querySelector('.cv-message-tag')).toBeNull();
    view.destroy();
  });
  it('drops a queued message the human pulled back, and keeps one message when several sources record it', () => {
    const { api } = fixture();
    expect(api.normalize(data([queued('enqueue', 'vazgeçtim', 12), queued('clear', undefined, 13)]))[0].nodes.filter((node: any) => node.kind === 'user')).toHaveLength(0);
    const message = { id: 'm1', taskId: 'task-1', runId: 'run-1', authorType: 'user', authorName: 'You', text: 'aynı metin', createdAt: '2026-10-16T12:00:05Z' };
    const late = { ...message, id: 'm2', createdAt: '2026-10-16T12:30:00Z' };
    const nodes = api.normalize(data([queued('enqueue', 'aynı metin', 6), queued('deliver', 'aynı metin', 50)], { messages: [message, late] }))[0].nodes.filter((node: any) => node.kind === 'user');
    expect(nodes).toHaveLength(1);
  });
  it('tells a dialog answered in the terminal from one that closed, and leaves the question tool to its own card', () => {
    const { api, host } = fixture();
    const question = (id: string, status: string, answer: string | null, second: number) => ({ id, taskId: 'task-1', runId: 'run-1', source: 'terminal', kind: 'approval', status, answer, text: 'Güveniyor musun?', createdAt: `2026-10-16T12:00:${second}Z` });
    const asked = (id: string, second: number) => ({ id: `q-${id}`, taskId: 'task-1', runId: 'run-1', type: 'question', message: 'Güveniyor musun?', data: { questionId: id }, createdAt: `2026-10-16T12:00:${second}Z` });
    api.create(host, data([asked('a', 20), asked('b', 30)], { questions: [question('a', 'answered', 'Yes, I trust this folder', 20), question('b', 'cancelled', null, 30)] }));
    const cards = [...host.querySelectorAll('article.cv-exchange')].map((node: any) => node.textContent);
    expect(cards[0]).toContain('Terminalde yanıtlandı'); expect(cards[0]).toContain('Yes, I trust this folder');
    expect(cards[1]).toContain('Terminalde kapandı'); expect(cards.join()).not.toContain('Soru iptal edildi');
    const covered = fixture();
    covered.api.create(covered.host, data([...toolEvents('AskUserQuestion', { questions: [{ question: 'Q?', options: [] }] }, 'ok'), asked('a', 10)], { questions: [question('a', 'answered', 'Yes', 10)] }));
    expect(covered.host.querySelector('article.cv-exchange').hidden).toBe(true); expect(covered.host.querySelector('.cv-questions .cv-question')).toBeNull();
  });
});

describe('plugins in the chat', () => {
  it('lets a plugin own a row and falls back to the core view when its code fails', async () => {
    const { window, api, host } = fixture();
    await window.AIWSPlugins.activate({ id: 'acme.chat' }, { activate(aiws: any) {
      aiws.conversation.addToolView({ id: 'boom', order: 1, match: (node: any) => node.program === 'boom', summary() { throw new Error('nope'); }, detail() { throw new Error('nope'); } });
      aiws.conversation.addToolView({ id: 'make', match: (node: any) => node.program === 'make', summary: () => ({ title: 'Benim derlemem', chips: [{ text: 'hazır', tone: 'done' }], activity: 'Derliyorum' }), inline: (node: any) => aiws.ui.html`<p class="mine">${node.commandLine}</p>`, detail: () => '<p class="mine-detail">detay</p>' });
    } });
    const before = window.AIWSPlugins.conversationRevision();
    const view = api.create(host, data([...bash('make all <x>', 'ok'), ...bash('boom now', 'ok')]));
    const [made, boom] = [...host.querySelectorAll('article.cv-tool')] as any[];
    expect(made.querySelector('summary strong').textContent).toBe('Benim derlemem');
    expect(made.querySelector('.cv-tool-chips').textContent).toBe('hazır');
    expect(made.querySelector('.mine').innerHTML).toContain('&lt;x&gt;');
    expect(made.querySelector('.mine-detail')).not.toBeNull();
    expect(boom.querySelector('summary strong').textContent).toBe('Runs it');
    expect(window.AIWSPlugins.list()[0].errors.length).toBeGreaterThan(0);
    // Turning the plugin off redraws the row in the core view.
    await window.AIWSPlugins.deactivate('acme.chat');
    expect(window.AIWSPlugins.conversationRevision()).toBeGreaterThan(before);
    view.update(data([...bash('make all <x>', 'ok'), ...bash('boom now', 'ok')]));
    expect(host.querySelector('.mine')).toBeNull();
    view.destroy();
  });
  it('mounts panels above the chat, closed until opened, and updates them', async () => {
    const { window, api, host } = fixture();
    await window.AIWSPlugins.activate({ id: 'acme.panel' }, { activate(aiws: any) {
      aiws.conversation.addPanel({ id: 'count', title: 'Sayaç', icon: 'N', visible: (ctx: any) => ctx.nodes.length > 0, summary: (ctx: any) => [{ text: `${ctx.nodes.length} araç` }],
        render(container: any, ctx: any) { const paint = (next: any) => { container.textContent = `${next.nodes.length} çağrı`; }; paint(ctx); return { update: paint }; } });
    } });
    const view = api.create(host, data([]));
    expect(host.querySelector('.cv-insights').hidden).toBe(true);
    view.update(data(bash('ls', 'a')));
    const head = host.querySelector('.cv-insight-head');
    expect(host.querySelector('.cv-insights').hidden).toBe(false); expect(head.textContent).toContain('1 araç'); expect(host.querySelector('.cv-insight-body').hidden).toBe(true);
    head.click();
    expect(host.querySelector('.cv-insight-body').textContent).toContain('1 çağrı');
    view.update(data([...bash('ls', 'a'), ...bash('ls -a', 'b')]));
    expect(host.querySelector('.cv-insight-body').textContent).toContain('2 çağrı');
    view.destroy();
  });
});

describe('technology plugins', () => {
  async function chat(folder: string, id: string, events: unknown[]) {
    const context = fixture(); await context.window.AIWSPlugins.activate({ id }, pluginEntry(context.window, folder));
    const view = context.api.create(context.host, data(events));
    expect(context.window.AIWSPlugins.list()[0].errors).toEqual([]);
    return { ...context, view, rows: [...context.host.querySelectorAll('article.cv-tool, article.cv-files')] as any[] };
  }
  it('.NET: tests, builds, migrations and project files', async () => {
    const failing = `  Failed App.Tests.OrderTests.Total_is_summed [12 ms]\n  Error Message:\n   Assert.Equal() Failure\nExpected: 3\n  Stack Trace:\n     at App.Tests.OrderTests.Total_is_summed() in C:\\src\\App.Tests\\OrderTests.cs:line 14\n\nFailed!  - Failed:     1, Passed:    11, Skipped:     0, Total:    12, Duration: 1 s - App.Tests.dll (net8.0)`;
    const build = 'C:\\src\\App\\Order.cs(10,5): error CS1002: ; expected [C:\\src\\App\\App.csproj]\nC:\\src\\App\\Old.cs(3,1): warning CS0618: obsolete [C:\\src\\App\\App.csproj]\n  Lib -> C:\\src\\Lib\\bin\\Lib.dll\nBuild FAILED.\nTime Elapsed 00:00:12.34';
    const { host, rows, view } = await chat('aiws-dotnet', 'aiws.dotnet', [...bash('cd src && dotnet test App.sln -c Release --filter Order', failing, { is_error: true }), ...bash('dotnet build', build), ...bash('dotnet ef migrations add AddOrders', 'Done.'), ...bash('dotnet ef database update', "Applying migration '2026_AddOrders'.\nDone."), ...bash('dotnet run --project Web', 'Now listening on: http://localhost:5000'), ...toolEvents('Edit', { file_path: 'src/App/App.csproj', old_string: 'a', new_string: 'b' }, 'ok')]);
    const [test, built, migration, update, app, edit] = rows;
    expect(test.querySelector('summary strong').textContent).toBe('Testler');
    expect(test.querySelector('.cv-tool-chips').textContent).toMatch(/11 geçti.*1 kaldı/);
    expect(test.querySelector('.dn-projects').textContent).toContain('App.Tests');
    expect(test.querySelector('.dn-failures summary code').textContent).toBe('Total_is_summed');
    expect(test.querySelector('.dn-message').textContent).toContain('Assert.Equal() Failure');
    expect(test.querySelector('.dn-at').textContent).toContain('OrderTests.cs:14');
    expect(test.querySelector('.cv-tool-inline .cv-failures').textContent).toContain('Total_is_summed');
    expect(test.textContent).toContain('Release');
    expect(built.querySelector('.cv-tool-chips').textContent).toMatch(/1 hata.*1 uyarı/);
    expect(built.querySelector('.cv-tool-inline .cv-diagnostic-code').textContent).toBe('CS1002');
    expect(built.querySelector('.dn-outputs').textContent).toContain('Lib.dll');
    expect(migration.querySelector('summary strong').textContent).toBe('Yeni migration'); expect(migration.querySelector('.cv-tool-preview').textContent).toBe('AddOrders');
    expect(update.querySelector('.cv-steps').textContent).toContain('2026_AddOrders');
    expect(app.querySelector('.cv-tool-chips').textContent).toContain('http://localhost:5000');
    expect(edit.querySelector('.dn-hint')).not.toBeNull();
    expect(host.querySelector('.cv-insight-head').textContent).toContain('.NET');
    view.destroy();
  });
  it('React Native: Gradle, Xcode, pods, devices, EAS and native edits', async () => {
    const gradle = "> Task :app:preBuild UP-TO-DATE\n> Task :app:compileDebugKotlin FAILED\ne: file:///C:/app/android/app/src/main/java/Main.kt:10:5 Unresolved reference: foo\n\nFAILURE: Build failed with an exception.\n\n* What went wrong:\nExecution failed for task ':app:compileDebugKotlin'.\n\n* Try:\nRun with --stacktrace\n\nBUILD FAILED in 12s\n23 actionable tasks: 5 executed, 18 up-to-date";
    const { rows, host, view } = await chat('aiws-react-native', 'aiws.react-native', [...bash('cd android && ./gradlew assembleDebug', gradle, { is_error: true }), ...bash('xcodebuild -workspace App.xcworkspace', '** BUILD SUCCEEDED **'), ...bash('pod install', 'Pod installation complete! There are 12 dependencies from the Podfile and 80 total pods installed.'), ...bash('adb devices', 'List of devices attached\nemulator-5554\tdevice product:sdk model:Pixel_8\n'), ...bash('npx eas build --platform ios --profile preview', 'See logs: https://expo.dev/accounts/me/projects/app/builds/abc'), ...bash('npx expo start', 'Metro waiting on exp://10.0.0.6:8081\nBundled 1234ms index.js (950 modules)'), ...toolEvents('Edit', { file_path: 'android/app/build.gradle', old_string: 'a', new_string: 'b' }, 'ok')]);
    const [android, ios, pods, adb, eas, metro, edit] = rows;
    expect(android.querySelector('summary strong').textContent).toBe('Android derlemesi');
    expect(android.querySelector('.cv-tool-chips').textContent).toMatch(/1 hata.*23 görev.*12s/); expect(android.querySelector('.cv-diagnostics').textContent).toContain('C:/app/android');
    expect(android.querySelector('.cv-failures').textContent).toContain(':app:compileDebugKotlin');
    expect(android.querySelector('.rn-block').textContent).toContain("Execution failed for task");
    expect(android.querySelector('.cv-diagnostics').textContent).toContain('Unresolved reference');
    expect(ios.querySelector('.cv-tool-chips').textContent).toContain('Başarılı');
    expect(pods.querySelector('.cv-tool-chips').textContent).toContain('80 pod');
    expect(adb.querySelector('.rn-devices').textContent).toContain('Pixel_8');
    expect(eas.querySelector('a').href).toContain('expo.dev'); expect(eas.textContent).toContain('preview');
    expect(metro.querySelector('.cv-tool-chips').textContent).toMatch(/950 modül.*1\.2 s.*exp:/);
    expect(edit.querySelector('.rn-hint').textContent).toContain('native derleme');
    expect(host.querySelector('.cv-insight-head').textContent).toContain('React Native');
    view.destroy();
  });
  it('Electron: packaging, rebuilds, processes and weakened security', async () => {
    const builder = '  • electron-builder  version=24.13.3 os=10.0.26200\n  • packaging       platform=win32 arch=x64 electron=30.0.0 appOutDir=dist\\win-unpacked\n  • building        target=nsis file=dist\\App-Setup-1.0.0.exe archs=x64';
    const { rows, host, view } = await chat('aiws-electron', 'aiws.electron', [...bash('npx electron-builder --win', builder), ...bash('npx electron-forge make', '✔ Packaging application\n✖ Making for target: squirrel', { is_error: true }), ...bash('npx electron-rebuild', 'Building module: better-sqlite3\n✔ Rebuild Complete'), ...toolEvents('Edit', { file_path: 'src/main/window.ts', old_string: 'contextIsolation: true', new_string: 'contextIsolation: false' }, 'ok'), ...toolEvents('Edit', { file_path: 'src/preload/index.ts', old_string: 'a', new_string: 'b' }, 'ok')]);
    const [packed, forge, rebuild, risky, preload] = rows;
    expect(packed.querySelector('summary strong').textContent).toBe('Electron paketleme');
    expect(packed.querySelector('.cv-tool-chips').textContent).toMatch(/Başarılı.*win32 x64.*electron 30\.0\.0/);
    expect(packed.querySelector('.cv-steps').textContent).toContain('building');
    expect(packed.querySelector('.el-rows').textContent).toContain('App-Setup-1.0.0.exe');
    expect(forge.querySelector('.cv-tool-inline .el-failed').textContent).toContain('squirrel');
    expect(rebuild.querySelector('.cv-steps').textContent).toContain('better-sqlite3');
    expect(risky.querySelector('.cv-tool-chips').textContent).toContain('güvenlik');
    expect(risky.querySelector('.el-failed').textContent).toContain('contextIsolation: false');
    expect(preload.querySelector('.el-hint').textContent).toContain('Preload');
    expect(host.querySelector('.cv-insight-head').textContent).toContain('Electron');
    view.destroy();
  });
  it('Angular: esbuild and webpack builds, budgets, Karma, generate and workspace edits', async () => {
    const esbuild = "Initial chunk files | Names  | Raw size | Estimated transfer size\nmain-ABC.js         | main   | 212.10 kB | 60.20 kB\nstyles-DEF.css      | styles | 1.20 kB | 300 bytes\nInitial total       |        | 213.30 kB | 60.50 kB\n\nApplication bundle generation complete. [3.214 seconds]\n\n▲ [WARNING] bundle initial exceeded maximum budget. Budget 200.00 kB was not met by 13.30 kB with a total of 213.30 kB.\n\n✘ [ERROR] TS2322: Type 'string' is not assignable to type 'number'. [plugin angular-compiler]\n\n    src/app/cart.component.ts:10:5:\n      10 │     total = '1';\n";
    const webpack = "Error: src/app/a.component.html:3:1 - error NG8001: 'app-x' is not a known element.\n";
    const karma = "Chrome 120.0 (Windows 10) ERROR\nChrome 120.0 (Windows 10) CartComponent adds up FAILED\nExecuted 23 of 23 (3 FAILED) (1.2 secs / 1 sec)\nTOTAL: 3 FAILED, 20 SUCCESS";
    const generate = 'CREATE src/app/cart/cart.component.ts (120 bytes)\nCREATE src/app/cart/cart.component.html (20 bytes)\nUPDATE src/app/app.module.ts (400 bytes)';
    const { rows, host, view } = await chat('aiws-angular', 'aiws.angular', [...bash('npx ng build shop -c production', esbuild, { is_error: true }), ...bash('ng build', webpack, { is_error: true }), ...bash('ng test --watch=false', karma, { is_error: true }), ...bash('ng g component cart', generate), ...bash('ng serve', 'Local: http://localhost:4200/\nCompiled successfully.'), ...bash('nx run shop:test', 'Tests: 2 passed, 2 total'), ...bash('nx affected -t lint', 'All files pass linting.'), ...toolEvents('Edit', { file_path: 'angular.json', old_string: 'a', new_string: 'b' }, 'ok'), ...toolEvents('Edit', { file_path: 'src/app/cart.component.html', old_string: 'a', new_string: 'b' }, 'ok')]);
    const [build, older, karmaRow, generated, serve, nxTest, nxLint, config, template] = rows;
    expect(build.querySelector('summary strong').textContent).toBe('Angular derlemesi');
    expect(build.querySelector('.cv-tool-preview').textContent).toBe('shop · production');
    expect(build.querySelector('.cv-tool-chips').textContent).toMatch(/1 hata.*1 uyarı.*213\.30 kB.*3\.214 s/);
    expect(build.querySelector('.cv-tool-inline .cv-diagnostic-code').textContent).toBe('TS2322');
    expect(build.querySelector('.ng-budgets').textContent).toContain('exceeded maximum budget');
    expect(build.querySelector('.ng-bundles').textContent).toContain('main-ABC.js');
    expect(older.querySelector('.cv-diagnostic-code').textContent).toBe('NG8001');
    expect(karmaRow.querySelector('.cv-tool-chips').textContent).toMatch(/20 geçti.*3 kaldı.*1\.2 s/);
    expect(karmaRow.querySelector('.cv-failures').textContent).toContain('CartComponent adds up');
    expect(generated.querySelector('.cv-tool-chips').textContent).toContain('3 dosya'); expect(generated.querySelector('.ng-rows').textContent).toContain('cart.component.ts');
    expect(serve.querySelector('.cv-tool-chips').textContent).toContain('http://localhost:4200/');
    expect(nxTest.querySelector('summary strong').textContent).toBe('Angular testleri'); expect(nxTest.querySelector('.cv-tool-chips').textContent).toContain('2 geçti');
    expect(nxLint.querySelector('summary strong').textContent).toBe('Kod denetimi');
    expect(config.querySelector('.ng-hint').textContent).toContain('angular.json'); expect(template.querySelector('.cv-tool-chips').textContent).toContain('şablon');
    expect(host.querySelector('.cv-insight-head').textContent).toContain('Angular');
    view.destroy();
  });
  it('speaks English when the interface does', async () => {
    const context = fixture('en'); await context.window.AIWSPlugins.activate({ id: 'aiws.dotnet' }, pluginEntry(context.window, 'aiws-dotnet'));
    context.api.create(context.host, data(bash('dotnet test', 'Passed!  - Failed:     0, Passed:    2, Skipped:     0, Total:    2')));
    expect(context.host.querySelector('summary strong').textContent).toBe('Tests');
    expect(context.host.querySelector('.cv-tool-chips').textContent).toContain('2 passed');
  });
  it('renders an IDE test explorer with suites, individual test cases and expected/actual diffs across runners', async () => {
    const dotnetVerbose = [
      '  Passed App.Tests.OrderTests.Empty_cart_is_zero [2 ms]',
      '  Skipped App.Tests.OrderTests.Pending_discount [1 ms]',
      '  Failed App.Tests.OrderTests.Total_is_summed [12 ms]',
      '  Error Message:',
      '   Assert.Equal() Failure: Values differ',
      '   Expected: 3',
      '   Actual:   5',
      '  Stack Trace:',
      '     at App.Tests.OrderTests.Total_is_summed() in C:\\src\\App.Tests\\OrderTests.cs:line 14',
      '',
      'Failed!  - Failed:     1, Passed:     1, Skipped:     1, Total:     3, Duration: 15 ms - App.Tests.dll (net8.0)',
    ].join('\n');
    const csharpEdit = [
      '[Route("api/[controller]")]',
      'public class OrdersController : ControllerBase {',
      '  [HttpPost("checkout")]',
      '  public async Task<IActionResult> Checkout() => Ok();',
      '}',
      'public static class Startup {',
      '  public static void Register(IServiceCollection services) {',
      '    services.AddScoped<IOrderService, OrderService>();',
      '  }',
      '}',
      'public class AppDbContext { public DbSet<Order> Orders { get; set; } }',
    ].join('\n');
    const { rows, host, view } = await chat('aiws-dotnet', 'aiws.dotnet', [
      ...bash('dotnet test', dotnetVerbose, { is_error: true }),
      ...toolEvents('Edit', { file_path: 'src/Api/OrdersController.cs', old_string: '// empty', new_string: csharpEdit }, 'ok'),
      ...toolEvents('Read', { file_path: 'src/App/App.csproj' }, '1\t<Project>\n2\t  <TargetFramework>net8.0</TargetFramework>\n3\t  <PackageReference Include="MediatR" Version="12.2.0" />\n4\t</Project>'),
    ]);
    const [testRow, editRow, readRow] = rows;
    expect(testRow.querySelector('.cv-test-explorer')).not.toBeNull();
    expect(testRow.querySelector('.cv-test-badge').textContent).toContain('33%');
    expect(testRow.querySelector('.cv-test-suite-name').textContent).toBe('App.Tests.OrderTests');
    expect(testRow.querySelector('.cv-test-case[data-tone=done] code').textContent).toBe('Empty_cart_is_zero');
    expect(testRow.querySelector('.cv-test-case[data-tone=idle] code').textContent).toBe('Pending_discount');
    expect(testRow.querySelector('.cv-test-assert').textContent).toMatch(/Beklenen.*3.*Gerçekleşen.*5/);
    expect(editRow.querySelector('.cv-code-map').textContent).toContain('POST /api/orders/checkout');
    expect(editRow.querySelector('.cv-code-map').textContent).toContain('IOrderService → OrderService');
    expect(editRow.querySelector('.cv-code-map').textContent).toContain('DbSet<Order> Orders');
    expect(readRow.querySelector('.cv-code-map').textContent).toContain('MediatR');
    expect(readRow.querySelector('.cv-code-map').textContent).toContain('net8.0');
    const panelHead = host.querySelector('.cv-insight-head') as any;
    panelHead.click();
    expect(host.querySelector('.cv-insight-body .cv-test-explorer')).not.toBeNull();
    expect(host.querySelector('.cv-insight-body .cv-code-map').textContent).toContain('POST /api/orders/checkout');
    view.destroy();
  });
  it('captures language-specific constructs for Angular, Electron and React Native edits and reads', async () => {
    const ngCode = "@Component({ selector: 'app-cart', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush })\nexport class CartComponent {\n  readonly items = signal<string[]>([]);\n  readonly total = computed(() => this.items().length);\n  readonly itemId = input.required<string>();\n  private http = inject(HttpClient);\n  load() { return this.http.get('/api/cart'); }\n}";
    const ngHtml = '@if (items().length) { @for (item of items(); track item) { <div [formGroup]="cartForm">{{ item }}</div> } }';
    const ngChat = await chat('aiws-angular', 'aiws.angular', [
      ...toolEvents('Edit', { file_path: 'src/app/cart.component.ts', old_string: '', new_string: ngCode }, 'ok'),
      ...toolEvents('Edit', { file_path: 'src/app/cart.component.html', old_string: '', new_string: ngHtml }, 'ok'),
    ]);
    expect(ngChat.rows[0].querySelector('.cv-tool-inline .cv-code-map')).toBeNull(); expect(ngChat.rows[0].querySelector('.cv-tool-details .cv-code-map')).not.toBeNull();
    expect(ngChat.rows[0].querySelector('.cv-tool-chips').textContent).not.toContain('app-cart'); expect(ngChat.rows[1].querySelector('.cv-code-kind').textContent).toBe('şablon');
    expect(ngChat.rows[0].querySelector('.cv-code-map').textContent).toContain('app-cart');
    expect(ngChat.rows[0].querySelector('.cv-code-map').textContent).toContain('standalone · OnPush');
    expect(ngChat.rows[0].querySelector('.cv-code-map').textContent).toContain('items = signal()');
    expect(ngChat.rows[0].querySelector('.cv-code-map').textContent).toContain('GET /api/cart');
    expect(ngChat.rows[1].querySelector('.cv-code-map').textContent).toContain('@for (item of items(); track item)');
    ngChat.view.destroy();

    const elMain = "ipcMain.handle('db:query', async () => []);\nconst win = new BrowserWindow({ webPreferences: { contextIsolation: true, sandbox: true } });";
    const elPreload = "contextBridge.exposeInMainWorld('electronAPI', { queryDb: () => ipcRenderer.invoke('db:query'), saveFile: () => {} });";
    const elChat = await chat('aiws-electron', 'aiws.electron', [
      ...toolEvents('Edit', { file_path: 'src/main/ipc.ts', old_string: '', new_string: elMain }, 'ok'),
      ...toolEvents('Edit', { file_path: 'src/preload/bridge.ts', old_string: '', new_string: elPreload }, 'ok'),
    ]);
    expect(elChat.rows[0].querySelector('.cv-code-map').textContent).toContain('db:query');
    expect(elChat.rows[0].querySelector('.cv-code-map').textContent).toContain('BrowserWindow');
    expect(elChat.rows[1].querySelector('.cv-code-map').textContent).toContain('window.electronAPI');
    expect(elChat.rows[1].querySelector('.cv-code-map').textContent).toContain('queryDb, saveFile');
    elChat.view.destroy();

    const rnCode = "const Biometrics = TurboModuleRegistry.getEnforcing('RTNBiometrics');\nexport function Screen() { const offset = useSharedValue(0); return <Stack.Screen name=\"Checkout\" />; }";
    const rnManifest = '<manifest><uses-permission android:name="android.permission.CAMERA" /></manifest>';
    const rnGradleTest = 'com.app.OrderTest > calculatesTotal PASSED (12ms)\ncom.app.OrderTest > rejectsNegative FAILED\n    java.lang.AssertionError: expected:<10> but was:<-1>\n        at com.app.OrderTest.rejectsNegative(OrderTest.kt:22)\n2 tests completed, 1 failed';
    const rnChat = await chat('aiws-react-native', 'aiws.react-native', [
      ...bash('./gradlew testDebugUnitTest', rnGradleTest, { is_error: true }),
      ...toolEvents('Edit', { file_path: 'src/screens/Checkout.tsx', old_string: '', new_string: rnCode }, 'ok'),
      ...toolEvents('Edit', { file_path: 'android/app/src/main/AndroidManifest.xml', old_string: '', new_string: rnManifest }, 'ok'),
    ]);
    expect(rnChat.rows[0].querySelector('.cv-test-explorer')).not.toBeNull();
    expect(rnChat.rows[0].querySelector('.cv-test-assert').textContent).toMatch(/Beklenen.*10.*Gerçekleşen.*-1/);
    expect(rnChat.rows[1].querySelector('.cv-code-map').textContent).toContain('RTNBiometrics');
    expect(rnChat.rows[1].querySelector('.cv-code-map').textContent).toContain('Checkout');
    expect(rnChat.rows[2].querySelector('.cv-code-map').textContent).toContain('CAMERA');
    rnChat.view.destroy();
  });
  it('handles compound sed-and-test commands, strips ANSI in raw output, and parses Jest multi-line diffs without duplicate suite failures', () => {
    const { api, host } = fixture();
    const vitestCmd = [
      "sed -i '18s/!state.projects.some(item=>item.id===id)/!state.projects.some(item=>item.id===id)\\&\\&!isGeneralProject(id)/' project-terminal-tab.js",
      'sed -n 18p project-terminal-tab.js | cut -c1-200; cd ../..; npx vitest run control-ui/tests -t "terminal" 2>&1 | tail -8',
    ].join('\n');
    const vitestOut = [
      ' \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m control center renderer with the real local API\x1b[2m > \x1b[22mopens a project shell, sends input, preserves it across tabs, and isolates and closes terminals \x1b[33m 4577\x1b[2mms\x1b[22m\x1b[39m',
      ' \x1b[33m\x1b[2m✓\x1b[22m\x1b[39m control center renderer with the real local API\x1b[2m > \x1b[22mrenders actual PTY output, accepts raw terminal input, and explicitly completes through the task UI \x1b[33m 3185\x1b[2mms\x1b[22m\x1b[39m',
      '',
      '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m5 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (6)\x1b[39m',
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m18 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m214 skipped\x1b[39m\x1b[90m (232)\x1b[39m',
      '\x1b[2m   Duration \x1b[22m 50.74s',
    ].join('\n');

    const jestCmd = 'cd "C:/work/mobile/src/screens" && sed -i "s/absorb({ ...page, items: \\[ ...durable \\] }, true);/absorb({ ...page, items: orderHomeItems(durable) }, true);/" DiscoverHome.tsx && cd ../.. && git diff --stat && npx jest src/__tests__/generationStatus.test.ts src/__tests__/discoverHomeRefresh.test.tsx src/__tests__/homeOutfitVersions.test.tsx src/__tests__/generationPausedCard.test.tsx 2>&1 | tail -40; npx tsc --noEmit 2>&1 | tail -5; cd ..';
    const jestOut = [
      ' mobile/src/__tests__/generationStatus.test.ts | 10 +++++++++-',
      ' mobile/src/generationStatus.ts                |  8 ++++++++',
      ' mobile/src/screens/DiscoverHome.tsx           |  4 ++--',
      ' 3 files changed, 19 insertions(+), 3 deletions(-)',
      'FAIL src/__tests__/discoverHomeRefresh.test.tsx (14.078 s)',
      '  ? sonucu belirsiz kisisel uretim korunur ve ayni is durum sorgusuyla tamamlanir',
      '',
      '    expect(received).toEqual(expected) // deep equality',
      '',
      '    - Expected  - 1',
      '    + Received  + 1',
      '',
      '      Array [',
      '    -   "first",',
      '        "second",',
      '    +   "first",',
      '      ]',
      '',
      '      at Object.toEqual (src/__tests__/discoverHomeRefresh.test.tsx:145:62)',
      '',
      'Test Suites: 1 failed, 3 passed, 4 total',
      'Tests:       1 failed, 50 passed, 51 total',
      'Time:        16.555 s',
      'Ran all test suites matching src/__tests__/generationStatus.test.ts|src/__tests__/discoverHomeRefresh.test.tsx|src/__tests__/homeOutfitVersions.test.tsx|src/__tests__/generationPausedCard.test.tsx.',
    ].join('\n');

    api.create(host, data([...bash(vitestCmd, vitestOut), ...bash(jestCmd, jestOut)]));
    const [vitestRow, jestRow] = [...host.querySelectorAll('article.cv-tool')] as any[];

    expect(vitestRow.querySelector('.cv-tool-preview').textContent).not.toContain('2>&1');
    expect(vitestRow.querySelector('.cv-test-badge').textContent).toContain('100%');
    expect(vitestRow.querySelector('.cv-output').textContent).not.toContain('\x1b[');
    expect(vitestRow.querySelector('.cv-files').textContent).toContain('project-terminal-tab.js');
    expect(vitestRow.querySelector('.cv-diff-view').textContent).toContain('+!state.projects.some(item=>item.id===id)&&!isGeneralProject(id)');

    expect(jestRow.querySelector('.cv-tool-icon').getAttribute('data-tone')).toBe('failed');
    expect(jestRow.querySelector('.cv-tool-icon').textContent).not.toBe('✓');
    expect(jestRow.querySelectorAll('.cv-tool-inline .cv-failures li')).toHaveLength(1);
    expect(jestRow.querySelector('.cv-test-suite-name').textContent).toBe('discoverHomeRefresh.test.tsx');
    expect(jestRow.querySelector('.cv-test-assert').textContent).toMatch(/Beklenen.*"first", "second".*Gerçekleşen.*"second", "first"/);
    expect(jestRow.querySelector('.cv-test-loc').textContent).toContain('discoverHomeRefresh.test.tsx:145');
    expect(jestRow.querySelector('.cv-files').textContent).toContain('mobile/src/screens/DiscoverHome.tsx');
  });
  it('groups test results by file, keeps files closed unless they failed, and never invents per-file counts', () => {
    const { api, host } = fixture();
    const jestVerbose = [
      'PASS src/__tests__/cart.test.ts (1.2 s)',
      '  Cart',
      '    ✓ adds an item (3 ms)',
      '    totals',
      '      ✓ sums prices',
      'FAIL src/__tests__/auth.test.ts',
      '  Auth',
      '    ✕ rejects a bad token (5 ms)',
      '    ✓ adds an item',
      '',
      '  ● Auth › rejects a bad token',
      '',
      '    expect(received).toBe(expected)',
      '',
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       1 failed, 3 passed, 4 total',
    ].join('\n');
    const jestQuiet = 'PASS src/a.test.ts\nPASS src/b.test.ts\n\nTest Suites: 2 passed, 2 total\nTests:       36 passed, 36 total\nRan all test suites matching a|b.';
    const vitestDefault = ' ✓ tests/a.test.ts (12 tests) 20ms\n ✓ tests/b.test.ts (3 tests | 1 skipped) 5ms\n\n Test Files  2 passed (2)\n      Tests  14 passed | 1 skipped (15)';
    api.create(host, data([...bash('npx jest --verbose', jestVerbose, { is_error: true }), ...bash('npx jest a b', jestQuiet), ...bash('npx vitest run', vitestDefault)]));
    const [verboseRow, quietRow, vitestRow] = [...host.querySelectorAll('article.cv-tool')] as any[];
    const suites = (row: any) => [...row.querySelectorAll('.cv-test-suite')] as any[];
    const [auth, cart] = suites(verboseRow);
    expect(auth.querySelector('.cv-test-suite-name').textContent).toBe('auth.test.ts');
    expect(auth.hasAttribute('open')).toBe(true);
    expect(auth.querySelector('.cv-test-suite-counts').textContent).toBe('1/2');
    expect(auth.querySelector('.cv-test-case.is-failed code').textContent).toBe('Auth › rejects a bad token');
    expect(auth.querySelectorAll('.cv-test-case')).toHaveLength(2);
    expect(cart.hasAttribute('open')).toBe(false);
    expect(cart.querySelector('.cv-test-suite-counts').textContent).toBe('2/2');
    expect([...cart.querySelectorAll('.cv-test-case code')].map((item: any) => item.textContent)).toEqual(['Cart › adds an item', 'Cart › totals › sums prices']);
    expect(suites(quietRow).map(suite => suite.querySelector('.cv-test-suite-name').textContent)).toEqual(['a.test.ts', 'b.test.ts']);
    expect(quietRow.querySelector('.cv-test-suite-counts')).toBeNull();
    expect(quietRow.querySelector('.cv-test-suite').hasAttribute('open')).toBe(false);
    expect(quietRow.querySelector('.cv-test-suite .is-summary').textContent).toContain('--verbose');
    expect(suites(vitestRow).map(suite => suite.querySelector('.cv-test-suite-counts').textContent)).toEqual(['12/12', '2/3']);
  });
});
