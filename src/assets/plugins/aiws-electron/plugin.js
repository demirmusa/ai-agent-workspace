// Electron in the agent chat: electron-builder, Forge, packager, rebuild, electron-vite and Playwright Electron commands get their own
// rows and cards with packaging steps, artifacts and an IDE test explorer; edits and reads surface IPC channels, preload contextBridge
// APIs, desktop window capabilities and weakened security settings; and a panel follows it all.

const EN = {
  'Electron paketleme': 'Electron packaging', 'Forge paketleme': 'Forge packaging', 'Forge dağıtım paketi': 'Forge make', 'Forge yayımlama': 'Forge publish', 'Native modül derleme': 'Native module rebuild', 'Electron uygulaması': 'Electron app', 'Electron geliştirme': 'Electron dev', 'Electron derlemesi': 'Electron build', 'ASAR arşivi': 'ASAR archive', 'Electron testleri': 'Electron tests', 'Masaüstü uygulaması': 'Desktop app',
  'Paketleniyor': 'Packaging', 'Yayımlanıyor': 'Publishing', 'Native modüller derleniyor': 'Rebuilding native modules', 'Uygulama açılıyor': 'Opening the app', 'Derleniyor': 'Building', 'Testler çalışıyor': 'Running tests', 'Arşiv işleniyor': 'Processing the archive',
  'Başarılı': 'Succeeded', 'Başarısız': 'Failed', 'geçti': 'passed', 'kaldı': 'failed', 'atlandı': 'skipped', 'hedef': 'targets', 'çıktı': 'outputs', 'Adımlar': 'Steps', 'Çıktılar': 'Outputs', 'Hedef platform': 'Target platform', 'Mimari': 'Architecture', 'Electron sürümü': 'Electron version', 'Uygulama süreci günlüğü': 'App process log', 'Hatalar': 'Errors', 'Hata': 'Error', 'Native modüller': 'Native modules', 'IPC ve süreç yapısı': 'IPC & process structure',
  'main süreci': 'main process', 'preload': 'preload', 'renderer': 'renderer', 'paketleme ayarı': 'packaging config', 'güvenlik': 'security', 'Güvenlik ayarı zayıfladı': 'A security setting was weakened', 'Main veya preload değişti: uygulamayı yeniden başlatmak gerekir.': 'Main or preload changed: the app needs a restart.', "Preload değişti: köprüye açılan API'yi gözden geçir.": 'Preload changed: review the API it exposes.',
  'Son paketleme': 'Last packaging', 'Son testler': 'Last tests', 'Değişen süreçler': 'Changed processes', 'Henüz yok': 'None yet', 'Son komutlar': 'Recent commands', 'Çalışıyor': 'Running', 'Güvenlik uyarıları': 'Security warnings',
};
const FORGE = { package: ['Forge paketleme', 'Paketleniyor'], make: ['Forge dağıtım paketi', 'Paketleniyor'], publish: ['Forge yayımlama', 'Yayımlanıyor'], start: ['Electron geliştirme', 'Uygulama açılıyor'] };
/** What a command does in an Electron project; null when it is not one of its tools. */
function commandOf(node) {
  const program = node.program, sub = String(node.args[0] || '').toLowerCase(), line = node.commandLine || '';
  if (program === 'electron-builder') return { key: 'builder', title: 'Electron paketleme', activity: 'Paketleniyor', pin: true };
  if (program === 'electron-packager') return { key: 'packager', title: 'Electron paketleme', activity: 'Paketleniyor', pin: true };
  if (program === 'electron-forge') { const [title, activity] = FORGE[sub] || ['Electron derlemesi', 'Derleniyor']; return { key: 'forge', title, activity, pin: sub !== 'start' }; }
  if (program === 'electron-rebuild' || (program === 'electron' && sub === 'rebuild')) return { key: 'rebuild', title: 'Native modül derleme', activity: 'Native modüller derleniyor', pin: true };
  if (program === 'electron-vite') return sub === 'build' ? { key: 'vite', title: 'Electron derlemesi', activity: 'Derleniyor', pin: true } : { key: 'app', title: 'Electron geliştirme', activity: 'Uygulama açılıyor' };
  if (program === 'asar') return { key: 'asar', title: 'ASAR arşivi', activity: 'Arşiv işleniyor' };
  if (program === 'electron') return { key: 'app', title: 'Electron uygulaması', activity: 'Uygulama açılıyor' };
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program) && /(?:desktop|electron)[\w:-]*/i.test(node.args.join(' '))) return /test/i.test(line) ? { key: 'tests', title: 'Electron testleri', activity: 'Testler çalışıyor', pin: true } : /build|pack|dist|make/i.test(line) ? { key: 'builder', title: 'Electron paketleme', activity: 'Paketleniyor', pin: true } : { key: 'app', title: 'Masaüstü uygulaması', activity: 'Uygulama açılıyor' };
  if (program === 'playwright' && /electron/i.test(line)) return { key: 'tests', title: 'Electron testleri', activity: 'Testler çalışıyor', pin: true };
  return null;
}
/** electron-builder's progress lines: "• packaging platform=win32 arch=x64 electron=30.0.0 appOutDir=dist\win-unpacked". */
function builderSteps(text) {
  return [...text.matchAll(/^\s*[•⨯]\s+(.+?)(?:\s{2,}|\s+(?=\w+=))(.*)$|^\s*[•⨯]\s+(.+)$/gm)].map(match => {
    const name = (match[1] || match[3]).trim(), fields = Object.fromEntries([...String(match[2] || '').matchAll(/([\w.]+)=("[^"]*"|\S+)/g)].map(field => [field[1], field[2].replace(/^"|"$/g, '')]));
    return { name, fields, failed: /^\s*⨯/.test(match[0]) };
  }).filter(step => step.name);
}
const forgeSteps = text => [...text.matchAll(/^\s*([✔✓✖×])\s+(.+?)\s*$/gm)].map(match => ({ name: match[2], failed: /[✖×]/.test(match[1]) }));
function packaging(text) {
  const steps = builderSteps(text), info = steps.find(step => step.fields.platform), artifacts = [...new Set([...steps.map(step => step.fields.file).filter(Boolean), ...[...text.matchAll(/\S+\.(?:exe|msi|dmg|pkg|AppImage|deb|rpm|nupkg|zip|snap)\b/g)].map(match => match[0])])].slice(0, 12), forge = forgeSteps(text);
  return { steps, forge, platform: info?.fields.platform || '', arch: info?.fields.arch || '', electron: info?.fields.electron || steps.find(step => step.fields.electron)?.fields.electron || '', targets: [...new Set(steps.map(step => step.fields.target).filter(Boolean))], artifacts, failed: steps.some(step => step.failed) || forge.some(step => step.failed) };
}
const rebuilt = text => [...new Set([...text.matchAll(/(?:Building module|rebuilding native dependency|preparing)\s*:?\s*(?:name=)?([@\w./-]+)/gi)].map(match => match[1]))];
const processLog = text => text.split('\n').filter(line => /\b(?:UnhandledPromiseRejection|Uncaught|TypeError|ReferenceError|Error:|ERR_[A-Z_]+|\[(?:main|renderer|preload)\])/.test(line)).slice(-30);
function processOf(path) {
  const value = String(path).replace(/\\/g, '/').toLowerCase();
  if (/(?:^|\/)preload[^/]*\.[cm]?[jt]s$|\/preload\//.test(value)) return 'preload';
  if (/(?:^|\/)(?:main|background|electron-main|ipc[-\w]*|tray|service-host|window[-\w]*)\.[cm]?[jt]s$|\/(?:main|electron|desktop-app)\//.test(value)) return 'main süreci';
  if (/(?:^|\/)(?:electron-builder\.(?:yml|yaml|json|js|cjs|mjs)|forge\.config\.[cm]?[jt]s|electron\.vite\.config\.[cm]?[jt]s)$/.test(value)) return 'paketleme ayarı';
  if (/\/(?:renderer|src\/renderer|ui|pages|components)\/|\.(?:html|css|tsx|jsx|vue|svelte)$/.test(value)) return 'renderer';
  return '';
}
// Settings that turn off Electron's process isolation; only lines an edit adds count.
const RISKS = [
  [/nodeIntegration\s*:\s*true/, 'nodeIntegration: true'],
  [/contextIsolation\s*:\s*false/, 'contextIsolation: false'],
  [/sandbox\s*:\s*false/, 'sandbox: false'],
  [/webSecurity\s*:\s*false/, 'webSecurity: false'],
  [/allowRunningInsecureContent\s*:\s*true/, 'allowRunningInsecureContent: true'],
  [/enableRemoteModule\s*:\s*true/, 'enableRemoteModule: true'],
  [/nodeIntegrationInWorker\s*:\s*true/, 'nodeIntegrationInWorker: true'],
  [/nodeIntegrationInSubFrames\s*:\s*true/, 'nodeIntegrationInSubFrames: true'],
  [/exposeInMainWorld\s*\([^,]+,\s*ipcRenderer\s*\)/, 'exposeInMainWorld(ipcRenderer)'],
];
function securityRisks(files) {
  const found = [];
  for (const file of files || []) for (const line of String(file.diff || '').split('\n')) if (line[0] === '+') for (const [pattern, label] of RISKS) if (pattern.test(line) && !found.some(item => item.label === label && item.path === file.path)) found.push({ label, path: file.path });
  return found;
}
/** Extracts IPC channels, preload contextBridge APIs, desktop window capabilities and security settings from edited or read files. */
function analyzeElectronCode(files, rawFiles, t) {
  const areas = new Set(), items = [], risks = securityRisks(rawFiles);
  for (const risk of risks) items.push({ badge: t('güvenlik'), tone: 'failed', name: risk.label, file: risk.path });
  for (const file of files) {
    const area = processOf(file.path); if (area) areas.add(area);
    const source = file.addedText || file.text || '';
    if (!source) continue;
    for (const match of source.matchAll(/\bipcMain\.(handle|on|once|removeHandler)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      areas.add('main süreci');
      items.push({ badge: 'IPC Main', tone: 'accent', name: match[2], detail: `ipcMain.${match[1]}`, file: file.path });
    }
    for (const match of source.matchAll(/\bipcRenderer\.(invoke|send|sendSync|on|once)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      items.push({ badge: 'IPC Renderer', tone: 'running', name: match[2], detail: `ipcRenderer.${match[1]}`, file: file.path });
    }
    for (const match of source.matchAll(/\bwebContents\.send\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      items.push({ badge: 'IPC Push', tone: 'running', name: match[1], detail: 'main → renderer', file: file.path });
    }
    for (const match of source.matchAll(/\bcontextBridge\.exposeInMainWorld\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
      areas.add('preload');
      const methods = [...match[2].matchAll(/(?:^|[,{\n])\s*([A-Za-z_$][\w$]*)\s*(?::|\()/g)].map(item => item[1]).slice(0, 6);
      items.push({ badge: 'ContextBridge', tone: 'done', name: `window.${match[1]}`, detail: methods.join(', '), file: file.path });
    }
    for (const match of source.matchAll(/\bnew\s+(BrowserWindow|BaseWindow|WebContentsView|BrowserView|Tray|Notification)\s*\(/g)) {
      areas.add('main süreci');
      items.push({ badge: 'Window', tone: 'accent', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(Menu\.buildFromTemplate|dialog\.show\w+|shell\.openExternal|shell\.showItemInFolder|autoUpdater\.\w+|globalShortcut\.register|protocol\.handle|safeStorage\.\w+|desktopCapturer\.\w+|powerMonitor\.\w+)\b/g)) {
      items.push({ badge: 'Native API', tone: 'idle', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(contextIsolation\s*:\s*true|sandbox\s*:\s*true|setWindowOpenHandler)\b/g)) {
      items.push({ badge: t('güvenlik'), tone: 'done', name: match[1].replace(/\s+/g, ' '), file: file.path });
    }
  }
  return { areas: [...areas], risks, items };
}

export function activate(aiws) {
  aiws.i18n.add({ en: EN });
  const t = aiws.i18n.t, { html, raw } = aiws.ui, { parse, ui } = aiws.conversation, { baseName, sourceFiles } = parse;
  const read = node => parse.stripAnsi(node.output);
  const isPackaging = node => ['builder', 'packager', 'forge', 'vite'].includes(commandOf(node)?.key);

  aiws.conversation.addToolView({
    id: 'electron-commands', order: 10,
    match: node => node.kind === 'tool' && Boolean(commandOf(node)),
    summary(node) {
      const command = commandOf(node), text = read(node), base = { pin: Boolean(command.pin), icon: 'E', title: t(command.title), activity: t(command.activity), subject: node.args.join(' ').slice(0, 140) };
      if (node.status === 'running') return base;
      if (command.key === 'tests') {
        const report = parse.testReport(text);
        return { ...base, tone: report?.failed || node.status === 'failed' ? 'failed' : 'done', chips: report ? [report.passed ? { text: `${report.passed} ${t('geçti')}`, tone: 'done' } : null, report.failed ? { text: `${report.failed} ${t('kaldı')}`, tone: 'failed' } : null, report.skipped ? { text: `${report.skipped} ${t('atlandı')}`, tone: 'idle' } : null, report.duration ? { text: report.duration } : null] : [] };
      }
      if (command.key === 'rebuild') { const modules = rebuilt(text); return { ...base, tone: node.status === 'failed' ? 'failed' : 'done', chips: modules.length ? [{ text: modules.slice(0, 3).join(', ') }] : [] }; }
      if (isPackaging(node)) { const result = packaging(text), failed = result.failed || node.status === 'failed'; return { ...base, tone: failed ? 'failed' : 'done', chips: [failed && node.status === 'failed' ? null : { text: t(failed ? 'Başarısız' : 'Başarılı'), tone: failed ? 'failed' : 'done' }, result.platform ? { text: [result.platform, result.arch].filter(Boolean).join(' ') } : null, result.electron ? { text: `electron ${result.electron}` } : null, result.artifacts.length ? { text: `${result.artifacts.length} ${t('çıktı')}` } : null] }; }
      return { ...base, tone: node.status === 'failed' ? 'failed' : undefined };
    },
    inline(node) {
      if (node.status === 'running') return undefined;
      const command = commandOf(node), text = read(node);
      if (command.key === 'tests') { const report = parse.testReport(text); return report ? ui.testExplorer(report, { compact: true }) : undefined; }
      if (isPackaging(node) && packaging(text).failed) { const failed = [...packaging(text).steps, ...packaging(text).forge].filter(step => step.failed)[0]; return failed ? html`<p class="el-failed">${failed.name}</p>` : undefined; }
      return undefined;
    },
    detail(node) {
      const command = commandOf(node), text = read(node);
      if (command.key === 'tests') { const report = parse.testReport(text); return report ? ui.testExplorer(report) : undefined; }
      if (command.key === 'rebuild') { const modules = rebuilt(text); return modules.length ? html`<h4 class="cv-section-title el-title">${t('Native modüller')}</h4>${raw(ui.steps(modules.map(name => ({ text: name, state: node.status === 'failed' ? 'failed' : 'done' }))))}` : undefined; }
      if (command.key === 'app') { const lines = processLog(text); return lines.length ? html`<h4 class="cv-section-title el-title">${t('Uygulama süreci günlüğü')}</h4><pre class="cv-code-block el-log">${lines.join('\n')}</pre>` : undefined; }
      if (isPackaging(node)) {
        const result = packaging(text), rows = result.steps.length ? result.steps.map(step => ({ text: step.name, detail: [step.fields.target, step.fields.arch, step.fields.file && baseName(step.fields.file)].filter(Boolean).join(' · '), state: step.failed ? 'failed' : 'done' })) : result.forge.map(step => ({ text: step.name, state: step.failed ? 'failed' : 'done' }));
        return `${ui.stats([{ label: t('Hedef platform'), value: result.platform }, { label: t('Mimari'), value: result.arch }, { label: t('Electron sürümü'), value: result.electron }, { label: t('hedef'), value: result.targets.join(', ') }])}${rows.length ? html`<h4 class="cv-section-title el-title">${t('Adımlar')}</h4>${raw(ui.steps(rows.slice(-20)))}` : ''}${result.artifacts.length ? html`<h4 class="cv-section-title el-title">${t('Çıktılar')}</h4><div class="cv-file-rows el-rows">${raw(result.artifacts.map(path => ui.fileName(path)).join(''))}</div>` : ''}`;
      }
      return undefined;
    },
  });

  // Which process an edit or read touches, which IPC channels or bridge APIs it defines, and whether it weakened isolation.
  aiws.conversation.addToolView({
    id: 'electron-files', order: 20,
    match: node => {
      const files = sourceFiles(node);
      if (!files.length) return false;
      const { areas, risks, items } = analyzeElectronCode(files, node.files, t);
      return risks.length > 0 || items.length > 0 || files.some(file => ['main süreci', 'preload', 'paketleme ayarı'].includes(processOf(file.path)) && (/\.[cm]?[jt]s$|\.(?:yml|yaml|json)$/.test(file.path)) && /main|preload|electron|desktop|ipc|forge/i.test(file.path)) || areas.includes('preload');
    },
    summary(node) {
      const { areas, risks, items } = analyzeElectronCode(sourceFiles(node), node.files, t);
      return { ...(risks.length ? { pin: true, tone: 'failed' } : {}), chips: [...areas.map(area => ({ text: t(area), tone: 'accent' })), risks.length ? { text: t('güvenlik'), tone: 'failed' } : null] };
    },
    inline(node) {
      const { areas, risks } = analyzeElectronCode(sourceFiles(node), node.files, t);
      if (risks.length) return html`<p class="el-failed">${t('Güvenlik ayarı zayıfladı')}: ${risks.map(risk => risk.label).join(', ')}</p>`;
      const hint = node.kind === 'files' && areas.includes('preload') ? html`<p class="cv-hint el-hint">${t("Preload değişti: köprüye açılan API'yi gözden geçir.")}</p>` : node.kind === 'files' && areas.includes('main süreci') ? html`<p class="cv-hint el-hint">${t('Main veya preload değişti: uygulamayı yeniden başlatmak gerekir.')}</p>` : '';
      return hint || undefined;
    },
    detail(node) {
      const { items } = analyzeElectronCode(sourceFiles(node), node.files, t);
      return items.length ? html`<h4 class="cv-section-title el-title">${t('IPC ve süreç yapısı')}</h4>${raw(ui.codeMap(items, 20))}` : undefined;
    },
  });

  const latest = (nodes, test) => [...nodes].reverse().find(node => test(node) && node.status !== 'running');
  aiws.conversation.addPanel({
    id: 'electron-summary', title: 'Electron', icon: 'E', order: 10,
    visible: ctx => ctx.nodes.some(node => commandOf(node) || securityRisks(node.files).length || analyzeElectronCode(sourceFiles(node), node.files, t).items.length),
    summary(ctx) {
      const build = latest(ctx.nodes, isPackaging), failed = build && (packaging(read(build)).failed || build.status === 'failed'), tests = latest(ctx.nodes, node => commandOf(node)?.key === 'tests'), report = tests && parse.testReport(read(tests)), risks = ctx.nodes.flatMap(node => securityRisks(node.files));
      return [build ? { text: t(failed ? 'Başarısız' : 'Başarılı'), tone: failed ? 'failed' : 'done', title: t('Son paketleme') } : null, report ? { text: `${report.passed}/${report.total}`, tone: report.failed ? 'failed' : 'done', title: t('Son testler') } : null, risks.length ? { text: t('güvenlik'), tone: 'failed' } : null, ctx.nodes.some(node => commandOf(node) && node.status === 'running') ? { text: t('Çalışıyor'), tone: 'running' } : null];
    },
    render(container, ctx) {
      const paint = next => {
        const build = latest(next.nodes, isPackaging), result = build && packaging(read(build)), tests = latest(next.nodes, node => commandOf(node)?.key === 'tests'), report = tests && parse.testReport(read(tests));
        const areas = new Map(); for (const node of next.nodes) for (const file of node.files || []) { const area = processOf(file.path); if (area) areas.set(area, (areas.get(area) || 0) + 1); }
        const risks = next.nodes.flatMap(node => securityRisks(node.files)), recent = next.nodes.filter(node => commandOf(node)).slice(-6).reverse();
        const codeItems = next.nodes.flatMap(node => analyzeElectronCode(sourceFiles(node), node.files, t).items.filter(item => item.badge !== t('güvenlik')));
        container.innerHTML = `${ui.stats([{ label: t('Son paketleme'), value: build ? t(result.failed || build.status === 'failed' ? 'Başarısız' : 'Başarılı') : t('Henüz yok'), tone: build ? result.failed || build.status === 'failed' ? 'failed' : 'done' : undefined }, { label: t('Son testler'), value: report ? `${report.passed} ${t('geçti')} · ${report.failed} ${t('kaldı')} (${report.passRate}%)` : t('Henüz yok'), tone: report ? report.failed ? 'failed' : 'done' : undefined }, { label: t('Değişen süreçler'), value: [...areas].map(([area, count]) => `${t(area)} ${count}`).join(' · ') || t('Henüz yok') }])}${report ? ui.testExplorer(report, { limit: 8 }) : ''}${risks.length ? html`<h4 class="cv-section-title el-title">${t('Güvenlik uyarıları')}</h4>${raw(ui.failures(risks.map(risk => `${risk.label} — ${risk.path}`)))}` : ''}${codeItems.length ? html`<h4 class="cv-section-title el-title">${t('IPC ve süreç yapısı')}</h4>${raw(ui.codeMap(codeItems, 8))}` : ''}${result?.artifacts.length ? html`<h4 class="cv-section-title el-title">${t('Çıktılar')}</h4><div class="cv-file-rows el-rows">${raw(result.artifacts.map(path => ui.fileName(path)).join(''))}</div>` : ''}${recent.length ? html`<h4 class="cv-section-title el-title">${t('Son komutlar')}</h4>${raw(ui.steps(recent.map(node => ({ text: node.commandLine, state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'done' }))))}` : ''}`;
      };
      paint(ctx);
      return { update: paint };
    },
  });
}
