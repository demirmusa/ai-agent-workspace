// Angular in the agent chat: ng and nx build, serve, test (with an IDE-style test explorer), generate, lint and update commands get
// their own rows and cards; edits and reads of Angular files surface components, signals, inputs/outputs, template control flow, routes,
// DI and HTTP calls; and a panel above the chat follows bundle size, budgets, tests and application structure.

const EN = {
  'Angular derlemesi': 'Angular build', 'Geliştirme sunucusu': 'Dev server', 'Angular testleri': 'Angular tests', 'E2E testleri': 'E2E tests', 'Şablon üretimi': 'Generate', 'Kod denetimi': 'Lint', 'Angular güncellemesi': 'Angular update', 'Paket ekleme': 'Add package', 'Nx komutu': 'Nx command', 'Çıkarım': 'Extract i18n',
  'Derleniyor': 'Building', 'Sunucu başlatılıyor': 'Starting the server', 'Testler çalışıyor': 'Running tests', 'Dosyalar üretiliyor': 'Generating files', 'Kod denetleniyor': 'Linting', 'Güncelleniyor': 'Updating', 'Paket ekleniyor': 'Adding a package', 'Nx çalışıyor': 'Running Nx',
  'geçti': 'passed', 'kaldı': 'failed', 'atlandı': 'skipped', 'hata': 'errors', 'uyarı': 'warnings', 'dosya': 'files', 'önbellek': 'cached', 'rota': 'routes', 'Başarılı': 'Succeeded', 'Başarısız': 'Failed',
  'Proje': 'Project', 'Yapılandırma': 'Configuration', 'Şablon': 'Schematic', 'Ad': 'Name', 'Toplam boyut': 'Total size', 'Aktarım boyutu': 'Transfer size', 'Süre': 'Duration', 'Paketler': 'Bundles', 'Bütçe uyarıları': 'Budget warnings', 'Adres': 'Address', 'Oluşturulan': 'Created', 'Güncellenen': 'Updated', 'Başarısız testler': 'Failed tests', 'Etkilenen projeler': 'Affected projects', 'Tarayıcı': 'Browser', 'Kod yapısı': 'Code structure',
  'bileşen': 'component', 'şablon': 'template', 'stil': 'style', 'servis': 'service', 'modül': 'module', 'yönerge': 'directive', 'pipe': 'pipe', 'guard': 'guard', 'interceptor': 'interceptor', 'durum yönetimi': 'state store', 'test': 'test', 'proje ayarı': 'workspace config',
  'angular.json veya tsconfig değişti: çalışan ng serve yeniden başlatılmalı.': 'angular.json or tsconfig changed: a running ng serve needs a restart.', 'package.json değişti: npm install gerekebilir.': 'package.json changed: npm install may be needed.',
  'Son derleme': 'Last build', 'Son testler': 'Last tests', 'Henüz yok': 'None yet', 'Son komutlar': 'Recent commands', 'Çalışıyor': 'Running',
};
const VERBS = { b: 'build', build: 'build', s: 'serve', serve: 'serve', dev: 'serve', t: 'test', test: 'test', e: 'e2e', e2e: 'e2e', g: 'generate', generate: 'generate', lint: 'lint', update: 'update', add: 'add', 'extract-i18n': 'i18n' };
const VIEWS = { build: ['Angular derlemesi', 'Derleniyor'], serve: ['Geliştirme sunucusu', 'Sunucu başlatılıyor'], test: ['Angular testleri', 'Testler çalışıyor'], e2e: ['E2E testleri', 'Testler çalışıyor'], generate: ['Şablon üretimi', 'Dosyalar üretiliyor'], lint: ['Kod denetimi', 'Kod denetleniyor'], update: ['Angular güncellemesi', 'Güncelleniyor'], add: ['Paket ekleme', 'Paket ekleniyor'], i18n: ['Çıkarım', 'Derleniyor'], nx: ['Nx komutu', 'Nx çalışıyor'] };
/** The Angular verb of a command: ng directly, or an Nx target such as `nx test web`, `nx run web:build` and `nx affected -t lint`. */
function verbOf(node) {
  if (node.program === 'ng') return VERBS[String(node.args[0] || '').toLowerCase()] || null;
  if (node.program === 'karma') return 'test';
  if (node.program !== 'nx') return null;
  const first = String(node.args[0] || '').toLowerCase();
  if (first === 'run') return VERBS[String(node.args[1] || '').split(':')[1]] || 'nx';
  if (['affected', 'run-many'].includes(first)) { const index = node.args.findIndex(arg => ['-t', '--target', '--targets'].includes(arg)); return VERBS[String(node.args[index + 1] || '').split(',')[0]] || 'nx'; }
  return VERBS[first] || 'nx';
}
const toKilobytes = size => { const match = String(size || '').match(/([\d.]+)\s*(bytes|[kMG]?B)/i); if (!match) return 0; const unit = match[2].toLowerCase(); return Number(match[1]) * (unit === 'bytes' || unit === 'b' ? 0.001 : unit === 'mb' ? 1024 : unit === 'gb' ? 1048576 : 1); };
/** The chunk table and totals of `ng build`, with proportional size share and initial/lazy kind. */
function bundleTable(text) {
  const lazyIndex = text.search(/Lazy chunk files/i);
  const rawChunks = [...text.matchAll(/^\s*([\w.@/-]+\.(?:js|css))\s*\|\s*([^|\n]*?)\s*\|\s*([\d.]+ (?:[kKMG]?B|bytes))\s*(?:\|\s*([\d.]+ (?:[kKMG]?B|bytes))\s*\|?)?/gm)].map(match => ({ file: match[1], name: match[2].trim(), raw: match[3], transfer: match[4] || '', kb: toKilobytes(match[3]), lazy: lazyIndex >= 0 && match.index > lazyIndex }));
  const maxKb = Math.max(...rawChunks.map(chunk => chunk.kb), 1);
  const chunks = rawChunks.map(chunk => ({ ...chunk, share: Math.max(4, Math.round((chunk.kb / maxKb) * 100)) }));
  const total = text.match(/Initial(?: chunk files)? [Tt]otal\s*\|\s*(?:\|\s*)?([\d.]+ (?:[kKMG]?B|bytes))\s*(?:\|\s*([\d.]+ (?:[kKMG]?B|bytes)))?/);
  const seconds = text.match(/bundle generation complete\. \[([\d.]+) seconds?\]/)?.[1], time = text.match(/\bTime: (\d+)ms/)?.[1];
  const prerendered = Number(text.match(/Prerendered (\d+) static routes?/i)?.[1] || 0);
  return { chunks, total: total?.[1] || '', transfer: total?.[2] || '', duration: seconds ? `${seconds} s` : time ? `${(Number(time) / 1000).toFixed(1)} s` : '', prerendered };
}
const budgets = text => [...new Set([...text.matchAll(/(?:\[WARNING\]\s*|Warning:\s*)(.*(?:budget|exceeded maximum)[^\n]*)/gi)].map(match => match[1].trim()))].slice(0, 10);
/** Compiler errors in both builder formats: "✘ [ERROR] TS2322: text\n\n    src/a.ts:10:5:" and "Error: src/a.ts:10:5 - error TS2322: text". */
function buildProblems(text, parse) {
  const found = parse.diagnostics(text.replace(/^(?:Error|Warning): (?=\S+:\d+)/gm, '')), items = [...found.items];
  for (const match of text.matchAll(/[✘▲X]\s*\[(ERROR|WARNING)\]\s*(?:(\w+\d+):\s*)?([^\n]*?)(?:\s*\[plugin [^\]]*\])?\s*\n\s*\n\s*(\S+?):(\d+):(\d+):/g)) {
    if (/budget/i.test(match[3])) continue;
    items.push({ severity: match[1] === 'ERROR' ? 'error' : 'warning', file: match[4], line: Number(match[5]), column: Number(match[6]), ...(match[2] ? { code: match[2] } : {}), message: match[3].trim() });
  }
  return { items, errors: items.filter(item => item.severity === 'error').length, warnings: items.filter(item => item.severity === 'warning').length };
}
const generated = text => ({ created: [...text.matchAll(/^\s*CREATE\s+(\S+)/gm)].map(match => match[1]), updated: [...text.matchAll(/^\s*UPDATE\s+(\S+)/gm)].map(match => match[1]) });
const serveUrl = text => text.match(/Local:\s*(https?:\/\/\S+)/)?.[1] || text.match(/listening on (https?:\/\/\S+)/i)?.[1] || '';
const lintResult = text => { const match = text.match(/✖ \d+ problems? \((\d+) errors?, (\d+) warnings?\)/); return match ? { errors: Number(match[1]), warnings: Number(match[2]) } : /All files pass linting/.test(text) ? { errors: 0, warnings: 0 } : null; };
const affected = text => [...new Set([...text.matchAll(/^\s*(?:✔|✖|√|×|-)\s+nx run ([\w@/.-]+):/gm)].map(match => match[1]))].slice(0, 20);
const nxCachedCount = text => Number(text.match(/read the output from the cache instead of running the command for (\d+) out of \d+ tasks/i)?.[1] || 0);

const PARTS = [[/\.component\.ts$/, 'bileşen'], [/\.component\.html$/, 'şablon'], [/\.component\.(?:s?css|less)$/, 'stil'], [/\.service\.ts$/, 'servis'], [/\.module\.ts$/, 'modül'], [/\.routes?\.ts$|-routing\.module\.ts$/, 'rota'], [/\.directive\.ts$/, 'yönerge'], [/\.pipe\.ts$/, 'pipe'], [/\.guard\.ts$/, 'guard'], [/\.interceptor\.ts$/, 'interceptor'], [/\.(?:store|state|effects|reducer)\.ts$/, 'durum yönetimi'], [/\.spec\.ts$/, 'test'], [/(?:^|[\\/])(?:angular\.json|nx\.json|project\.json|tsconfig[^\\/]*\.json)$/, 'proje ayarı']];
const partOf = path => PARTS.find(([pattern]) => pattern.test(String(path || '')))?.[1] || '';

/** Extracts Angular decorators, signals, inputs/outputs, DI, HttpClient calls, template control flow, forms and routes. */
function analyzeAngularCode(files, t) {
  const parts = new Set(), items = [];
  for (const file of files) {
    const part = partOf(file.path); if (part) parts.add(part);
    const source = file.addedText || file.text || '';
    if (!source) continue;
    for (const match of source.matchAll(/@Component\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      parts.add('bileşen');
      const selector = match[1].match(/selector\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || '';
      const flags = [/standalone\s*:\s*true/.test(match[1]) ? 'standalone' : '', /ChangeDetectionStrategy\.OnPush/.test(match[1]) ? 'OnPush' : ''].filter(Boolean).join(' · ');
      items.push({ badge: t('bileşen'), tone: 'accent', name: selector || '@Component', detail: flags, file: file.path });
    }
    for (const match of source.matchAll(/@(Directive|Pipe)\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) {
      const kind = match[1] === 'Directive' ? 'yönerge' : 'pipe'; parts.add(kind);
      const name = match[2].match(/(?:selector|name)\s*:\s*['"`]([^'"`]+)['"`]/)?.[1] || `@${match[1]}`;
      items.push({ badge: t(kind), tone: 'accent', name, file: file.path });
    }
    for (const match of source.matchAll(/@Injectable\s*\([^)]*\)[\s\S]{0,120}?\bexport\s+class\s+(\w+)/g)) {
      parts.add('servis');
      items.push({ badge: t('servis'), tone: 'done', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(?:readonly\s+)?(\w+)\s*=\s*(signal|computed|linkedSignal|resource|rxResource)\s*(?:<[^>]+>)?\s*\(/g)) {
      items.push({ badge: 'Signal', tone: 'running', name: `${match[1]} = ${match[2]}()`, file: file.path });
    }
    for (const match of source.matchAll(/\b(?:readonly\s+)?(\w+)\s*=\s*(input(?:\.required)?|output|model|viewChild(?:\.required)?|contentChild(?:\.required)?)\s*(?:<[^>]+>)?\s*\(/g)) {
      const badge = match[2].startsWith('output') ? 'Output' : match[2].startsWith('input') || match[2] === 'model' ? 'Input' : 'Query';
      items.push({ badge, tone: 'accent', name: `${match[1]} = ${match[2]}()`, file: file.path });
    }
    for (const match of source.matchAll(/\binject\s*\(\s*([A-Z]\w+)\s*\)/g)) {
      items.push({ badge: 'DI', tone: 'done', name: `inject(${match[1]})`, file: file.path });
    }
    for (const match of source.matchAll(/\bhttp\.(get|post|put|delete|patch)\s*(?:<[^>]+>)?\s*\(\s*[`'"]([^`'"]+)[`'"]/g)) {
      items.push({ badge: 'HTTP', tone: 'accent', name: `${match[1].toUpperCase()} ${match[2]}`, file: file.path });
    }
    for (const match of source.matchAll(/@(if|for|switch|defer)\s*\(((?:[^()\n]|\([^()\n]*\)){1,80})\)/g)) {
      parts.add('şablon');
      items.push({ badge: t('şablon'), tone: 'running', name: `@${match[1]} (${match[2].trim()})`, file: file.path });
    }
    for (const match of source.matchAll(/(?:\[formGroup\]|formControlName|\[\(ngModel\)\]|\(ngSubmit\))="([^"]+)"/g)) {
      items.push({ badge: 'Form', tone: 'done', name: match[0], file: file.path });
    }
    for (const match of source.matchAll(/\bpath\s*:\s*['"]([^'"]+)['"](?:[^}\n]*?\b(loadComponent|loadChildren|component|canActivate|canMatch)\b)?/g)) {
      parts.add('rota');
      items.push({ badge: t('rota'), tone: 'accent', name: `/${match[1]}`, detail: match[2] || '', file: file.path });
    }
  }
  return { parts: [...parts], items };
}

export function activate(aiws) {
  aiws.i18n.add({ en: EN });
  const t = aiws.i18n.t, { html, raw } = aiws.ui, { parse, ui } = aiws.conversation, { flagValue, operands, sourceFiles } = parse;
  const read = node => parse.stripAnsi(node.output);
  const isAngular = node => Boolean(verbOf(node));

  aiws.conversation.addToolView({
    id: 'angular-commands', order: 10,
    match: node => node.kind === 'tool' && isAngular(node),
    summary(node) {
      const verb = verbOf(node), [title, activity] = VIEWS[verb], text = read(node), done = node.status !== 'running', project = verb === 'generate' ? '' : operands(node.args)[0] || flagValue(node.args, '--project');
      const base = { pin: ['build', 'test', 'e2e'].includes(verb), icon: 'NG', title: t(title), activity: t(activity), subject: verb === 'generate' ? operands(node.args).join(' ') : [project, flagValue(node.args, '-c', '--configuration')].filter(Boolean).join(' · ') };
      if (!done) return base;
      if (verb === 'test' || verb === 'e2e') {
        const report = parse.testReport(text);
        return { ...base, tone: report?.failed || node.status === 'failed' ? 'failed' : report ? 'done' : undefined, chips: report ? [report.passed ? { text: `${report.passed} ${t('geçti')}`, tone: 'done' } : null, report.failed ? { text: `${report.failed} ${t('kaldı')}`, tone: 'failed' } : null, report.skipped ? { text: `${report.skipped} ${t('atlandı')}`, tone: 'idle' } : null, report.duration ? { text: report.duration } : null] : [] };
      }
      if (verb === 'build' || verb === 'serve' || verb === 'i18n') {
        const table = bundleTable(text), problems = buildProblems(text, parse), limits = budgets(text), url = serveUrl(text);
        return { ...base, tone: problems.errors || node.status === 'failed' ? 'failed' : verb === 'build' ? limits.length ? 'needs' : 'done' : undefined, chips: [problems.errors ? { text: `${problems.errors} ${t('hata')}`, tone: 'failed' } : null, problems.warnings + limits.length ? { text: `${problems.warnings + limits.length} ${t('uyarı')}`, tone: 'needs' } : null, table.total ? { text: table.total } : null, table.prerendered ? { text: `${table.prerendered} SSR` } : null, table.duration ? { text: table.duration } : null, url ? { text: url, tone: 'running' } : null] };
      }
      if (verb === 'generate') { const files = generated(text); return { ...base, tone: node.status === 'failed' ? 'failed' : 'done', chips: files.created.length + files.updated.length ? [{ text: `${files.created.length + files.updated.length} ${t('dosya')}` }] : [] }; }
      if (verb === 'lint') { const result = lintResult(text); return { ...base, tone: result?.errors || node.status === 'failed' ? 'failed' : 'done', chips: result ? [result.errors ? { text: `${result.errors} ${t('hata')}`, tone: 'failed' } : null, result.warnings ? { text: `${result.warnings} ${t('uyarı')}`, tone: 'needs' } : null] : [] }; }
      if (verb === 'nx') { const cached = nxCachedCount(text); return { ...base, tone: node.status === 'failed' ? 'failed' : 'done', chips: cached ? [{ text: `${cached} ${t('önbellek')}`, tone: 'done' }] : [] }; }
      return { ...base, tone: node.status === 'failed' ? 'failed' : undefined };
    },
    inline(node) {
      if (node.status === 'running') return undefined;
      const verb = verbOf(node), text = read(node);
      if (verb === 'test' || verb === 'e2e') { const report = parse.testReport(text); return report ? ui.testExplorer(report, { compact: true }) : undefined; }
      if (verb === 'build' || verb === 'serve') { const errors = buildProblems(text, parse).items.filter(item => item.severity === 'error'); return errors.length ? ui.diagnostics(errors, 5) : undefined; }
      return undefined;
    },
    detail(node) {
      const verb = verbOf(node), text = read(node), settings = [{ label: t('Proje'), value: verb === 'generate' ? '' : operands(node.args)[0] || flagValue(node.args, '--project') }, { label: t('Yapılandırma'), value: flagValue(node.args, '-c', '--configuration') }];
      if (verb === 'test' || verb === 'e2e') {
        const report = parse.testReport(text);
        return report ? `${ui.stats([...settings, { label: t('Tarayıcı'), value: report.environment }])}${ui.testExplorer(report)}` : undefined;
      }
      if (verb === 'generate') {
        const files = generated(text), [schematic, name] = operands(node.args);
        return `${ui.stats([{ label: t('Şablon'), value: schematic }, { label: t('Ad'), value: name }])}${files.created.length ? html`<h4 class="cv-section-title ng-title">${t('Oluşturulan')}</h4><div class="cv-file-rows ng-rows">${raw(files.created.map(path => ui.fileName(path)).join(''))}</div>` : ''}${files.updated.length ? html`<h4 class="cv-section-title ng-title">${t('Güncellenen')}</h4><div class="cv-file-rows ng-rows">${raw(files.updated.map(path => ui.fileName(path)).join(''))}</div>` : ''}`;
      }
      if (verb === 'build' || verb === 'serve' || verb === 'i18n') {
        const table = bundleTable(text), problems = buildProblems(text, parse), limits = budgets(text), url = serveUrl(text);
        const rows = table.chunks.length ? html`<h4 class="cv-section-title ng-title">${t('Paketler')}</h4><div class="ng-bundles">${raw(table.chunks.map(chunk => html`<div><code>${chunk.file}</code><small>${chunk.name}${chunk.lazy ? ' · lazy' : ''}</small><i class="ng-bar"><b style="width:${chunk.share}%"></b></i><span>${chunk.raw}</span><span>${chunk.transfer}</span></div>`).join(''))}</div>` : '';
        return `${ui.stats([...settings, { label: t('Toplam boyut'), value: table.total }, { label: t('Aktarım boyutu'), value: table.transfer }, { label: t('Süre'), value: table.duration }, { label: t('Adres'), value: url }])}${problems.items.length ? ui.diagnostics(problems.items) : ''}${limits.length ? html`<h4 class="cv-section-title ng-title">${t('Bütçe uyarıları')}</h4><ul class="ng-budgets">${raw(limits.map(limit => html`<li>${limit}</li>`).join(''))}</ul>` : ''}${rows}`;
      }
      if (verb === 'lint') { const problems = parse.diagnostics(text); return problems.items.length ? ui.diagnostics(problems.items) : undefined; }
      if (verb === 'nx') { const projects = affected(text); return projects.length ? html`<h4 class="cv-section-title ng-title">${t('Etkilenen projeler')}</h4><p>${raw(ui.chips(projects.map(name => ({ text: name }))))}</p>` : undefined; }
      return undefined;
    },
  });

  // Which part of the Angular app an edit or read touches, and what components, signals, bindings or routes it defines.
  aiws.conversation.addToolView({
    id: 'angular-files', order: 20,
    match: node => {
      const files = sourceFiles(node);
      return files.some(file => partOf(file.path) || /@(?:Component|Directive|Pipe|Injectable|NgModule)\b/.test(file.text));
    },
    summary(node) {
      const { parts, items } = analyzeAngularCode(sourceFiles(node), t);
      return { chips: [...parts.slice(0, 4).map(part => ({ text: t(part), tone: part === 'proje ayarı' ? 'needs' : 'accent' }))] };
    },
    inline(node) {
      const { parts } = analyzeAngularCode(sourceFiles(node), t);
      const hint = parts.includes('proje ayarı') && node.kind === 'files' ? html`<p class="cv-hint ng-hint">${t('angular.json veya tsconfig değişti: çalışan ng serve yeniden başlatılmalı.')}</p>` : '';
      return hint || undefined;
    },
    detail(node) {
      const { items } = analyzeAngularCode(sourceFiles(node), t);
      return items.length ? html`<h4 class="cv-section-title ng-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(items, 20))}` : undefined;
    },
  });

  const latest = (nodes, verbs) => [...nodes].reverse().find(node => verbs.includes(verbOf(node)) && node.status !== 'running');
  aiws.conversation.addPanel({
    id: 'angular-summary', title: 'Angular', icon: 'NG', order: 10,
    visible: ctx => ctx.nodes.some(node => isAngular(node) || sourceFiles(node).some(file => partOf(file.path))),
    summary(ctx) {
      const build = latest(ctx.nodes, ['build']), tests = latest(ctx.nodes, ['test', 'e2e']), report = tests && parse.testReport(read(tests)), problems = build && buildProblems(read(build), parse), table = build && bundleTable(read(build));
      return [build ? { text: problems.errors || build.status === 'failed' ? t('Başarısız') : table.total || t('Başarılı'), tone: problems.errors || build.status === 'failed' ? 'failed' : 'done', title: t('Son derleme') } : null, report ? { text: `${report.passed}/${report.total}`, tone: report.failed ? 'failed' : 'done', title: t('Son testler') } : null, ctx.nodes.some(node => isAngular(node) && node.status === 'running') ? { text: t('Çalışıyor'), tone: 'running' } : null];
    },
    render(container, ctx) {
      const paint = next => {
        const build = latest(next.nodes, ['build']), tests = latest(next.nodes, ['test', 'e2e']), report = tests && parse.testReport(read(tests)), problems = build && buildProblems(read(build), parse), table = build && bundleTable(read(build)), limits = build ? budgets(read(build)) : [], recent = next.nodes.filter(isAngular).slice(-6).reverse();
        const codeItems = next.nodes.flatMap(node => analyzeAngularCode(sourceFiles(node), t).items);
        container.innerHTML = `${ui.stats([{ label: t('Son derleme'), value: build ? `${problems.errors} ${t('hata')} · ${problems.warnings + limits.length} ${t('uyarı')}` : t('Henüz yok'), tone: build ? problems.errors || build.status === 'failed' ? 'failed' : 'done' : undefined }, { label: t('Toplam boyut'), value: table?.total }, { label: t('Son testler'), value: report ? `${report.passed} ${t('geçti')} · ${report.failed} ${t('kaldı')} (${report.passRate}%)` : t('Henüz yok'), tone: report ? report.failed ? 'failed' : 'done' : undefined }])}${report ? ui.testExplorer(report, { limit: 8 }) : ''}${codeItems.length ? html`<h4 class="cv-section-title ng-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(codeItems, 8))}` : ''}${recent.length ? html`<h4 class="cv-section-title ng-title">${t('Son komutlar')}</h4>${raw(ui.steps(recent.map(node => ({ text: node.commandLine, state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'done' }))))}` : ''}`;
      };
      paint(ctx);
      return { update: paint };
    },
  });
}
