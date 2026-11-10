// .NET in the agent chat: dotnet test (with an IDE-style test explorer), build, publish, pack, run, restore, package and EF Core
// commands get their own rows and cards; edits and reads of C#, Razor, XAML and MSBuild files surface endpoints, DI registrations,
// EF Core entities, xUnit/NUnit/MSTest cases and NuGet packages; and a panel above the chat follows builds, tests and code structure.

const EN = {
  'Testler çalışıyor': 'Running tests', 'Derleniyor': 'Building', 'Yayımlanıyor': 'Publishing', 'Paketleniyor': 'Packing', 'Uygulama başlatılıyor': 'Starting the app', 'Paketler geri yükleniyor': 'Restoring packages', 'Paket ekleniyor': 'Adding a package', 'Paketler listeleniyor': 'Listing packages', 'Migration oluşturuluyor': 'Creating a migration', 'Veritabanı güncelleniyor': 'Updating the database', 'Kod biçimlendiriliyor': 'Formatting code', 'dotnet çalışıyor': 'Running dotnet',
  'Testler': 'Tests', 'Derleme': 'Build', 'Yayımlama': 'Publish', 'Paketleme': 'Pack', 'Uygulama': 'App', 'Paket geri yükleme': 'Package restore', 'Paket ekleme': 'Add package', 'Paket kaldırma': 'Remove package', 'Paket listesi': 'Package list', 'Yeni migration': 'New migration', 'Veritabanı güncelleme': 'Database update', 'Migration listesi': 'Migrations', 'EF Core': 'EF Core', 'Kod biçimlendirme': 'Code format',
  'geçti': 'passed', 'kaldı': 'failed', 'atlandı': 'skipped', 'hata': 'errors', 'uyarı': 'warnings', 'Başarılı': 'Succeeded', 'Başarısız': 'Failed', 'Çıktılar': 'Outputs', 'Süre': 'Duration', 'Yapılandırma': 'Configuration', 'Hedef': 'Target', 'Filtre': 'Filter', 'Proje': 'Project', 'Kapsama': 'Coverage', 'Test projeleri': 'Test projects', 'Başarısız testler': 'Failed tests', 'En sık uyarılar': 'Most frequent warnings', 'Adresler': 'Addresses', 'Ortam': 'Environment', "Uygulanan migration'lar": 'Applied migrations', 'Veritabanı güncel': 'Database is up to date', 'Paket': 'Package', 'Sürüm': 'Version', 'Paketler': 'Packages', 'proje geri yüklendi': 'projects restored',
  'Son test': 'Last test run', 'Son derleme': 'Last build', 'Kod yapısı': 'Code structure', 'Henüz yok': 'None yet', 'proje dosyası': 'project file', 'migration': 'migration', 'yapılandırma': 'configuration', 'API uç noktası': 'API endpoint', 'servis': 'service', 'veri katmanı': 'data layer', 'test sınıfı': 'test class', 'Blazor bileşeni': 'Blazor component', 'XAML görünümü': 'XAML view', 'uygulama başlangıcı': 'app startup', 'C# kodu': 'C# code', 'Test': 'Test',
  'Bu değişiklik paket geri yüklemesi gerektirebilir.': 'This change may need a package restore.', 'Migration dosyası değişti; veritabanını güncellemeyi unutma.': 'A migration file changed; remember to update the database.', 'Son komutlar': 'Recent commands', 'Çalışıyor': 'Running',
};
const SUBCOMMANDS = {
  test: ['Testler', 'Testler çalışıyor'], vstest: ['Testler', 'Testler çalışıyor'], build: ['Derleme', 'Derleniyor'], publish: ['Yayımlama', 'Yayımlanıyor'], pack: ['Paketleme', 'Paketleniyor'], run: ['Uygulama', 'Uygulama başlatılıyor'], watch: ['Uygulama', 'Uygulama başlatılıyor'], restore: ['Paket geri yükleme', 'Paketler geri yükleniyor'], list: ['Paket listesi', 'Paketler listeleniyor'], format: ['Kod biçimlendirme', 'Kod biçimlendiriliyor'], msbuild: ['Derleme', 'Derleniyor'],
};
const isDotnet = node => ['dotnet', 'msbuild', 'vstest', 'nuget'].includes(node.program);

/** `dotnet ef ...` subcommands as `{ action, target, context }`; null for other commands. */
function efCommand(args, flagValue) {
  if (String(args[0]).toLowerCase() !== 'ef') return null;
  const [group, verb, name] = args.slice(1).map(String), context = flagValue(args, '-c', '--context');
  if (group === 'migrations' && verb === 'add') return { action: 'migration', target: name, context };
  if (group === 'migrations' && verb === 'list') return { action: 'list', target: context || '', context };
  if (group === 'database' && verb === 'update') return { action: 'update', target: name && !name.startsWith('-') ? name : '', context };
  return { action: 'other', target: [group, verb].filter(Boolean).join(' '), context };
}
const outputs = text => [...text.matchAll(/^\s*(\S+)\s+->\s+(.+?\.(?:dll|exe|nupkg))\s*$/gim)].map(match => ({ project: match[1], path: match[2].trim() })).slice(0, 30);
const packedNupkgs = text => [...new Set([...text.matchAll(/Successfully created package '([^']+\.nupkg)'/gi)].map(match => match[1]))];
const listening = text => [...new Set([...text.matchAll(/Now listening on:\s*(\S+)/g)].map(match => match[1]))];
const hostingEnv = text => text.match(/Hosting environment:\s*(\S+)/)?.[1] || '';
const restoredCount = text => { const match = text.match(/Restored\s+(\d+)\s+of\s+(\d+)\s+projects/i) || text.match(/(\d+)\s+of\s+(\d+)\s+projects\s+are\s+up-to-date/i); return match ? Number(match[1]) : 0; };
const coverageRate = text => text.match(/\|\s*Total\s*\|\s*([\d.]+%)\s*\|/i)?.[1] || text.match(/Line coverage:\s*([\d.]+%)/i)?.[1] || '';
const listedPackages = text => [...text.matchAll(/^\s*>\s+(\S+)\s+(?:(\S+)\s+)?(\S+)(?:\s+(\S+))?\s*$/gm)].map(match => ({ name: match[1], requested: match[2] || '', resolved: match[3], latest: match[4] || '' })).slice(0, 25);

const FILE_ROLES = [
  [/\.(?:cs|fs|vb)proj$|\.slnx?$|Directory\.(?:Build|Packages)\.(?:props|targets)$|global\.json$|NuGet\.config$/i, 'proje dosyası'],
  [/[\\/]Migrations[\\/]/i, 'migration'],
  [/(?:Tests?|Specs?)\.cs$|[\\/](?:Tests?|Specs?)[\\/].*\.cs$/i, 'test sınıfı'],
  [/(?:Controller|Endpoints?)\.cs$/i, 'API uç noktası'],
  [/(?:DbContext|Repository)\.cs$/i, 'veri katmanı'],
  [/(?:Service|Handler|UseCase|Manager)\.cs$/i, 'servis'],
  [/\.razor$/i, 'Blazor bileşeni'],
  [/\.xaml(?:\.cs)?$/i, 'XAML görünümü'],
  [/(?:^|[\\/])(?:Program|Startup)\.cs$/i, 'uygulama başlangıcı'],
  [/appsettings[^\\/]*\.json$|launchSettings\.json$/i, 'yapılandırma'],
  [/\.(?:cs|fs)$/i, 'C# kodu'],
];
const fileRole = path => FILE_ROLES.find(([pattern]) => pattern.test(String(path || '')))?.[1] || '';

/** Extracts C#, ASP.NET Core, EF Core, Blazor, xUnit/NUnit/MSTest and MSBuild constructs from edited or read files. */
function analyzeDotnetCode(files, t, baseName) {
  const tags = new Set(), items = [];
  for (const file of files) {
    const role = fileRole(file.path); if (role) tags.add(role);
    const source = file.addedText || file.text || '';
    if (!source) continue;
    const baseRoute = (file.text.match(/\[Route\(\s*"([^"]+)"\s*\)\]/)?.[1] || '').replace(/\[controller\]/gi, baseName(file.path).replace(/Controller\.cs$/i, '').toLowerCase());
    for (const match of source.matchAll(/\[Http(Get|Post|Put|Delete|Patch)(?:\(\s*"([^"]*)"\s*\))?\][\s\S]{0,220}?\b(?:public|internal)\s+(?:async\s+)?(?:Task(?:<[^>]+>)?|IActionResult|ActionResult(?:<[^>]+>)?|IResult|[\w<>?]+)\s+(\w+)\s*\(/g)) {
      const verb = match[1].toUpperCase(), subRoute = match[2] || '', fullRoute = [baseRoute, subRoute].filter(Boolean).join('/').replace(/\/+/g, '/');
      tags.add('API uç noktası');
      items.push({ badge: 'Endpoint', tone: 'accent', name: `${verb} /${fullRoute}`.replace(/\/+$/, '') || verb, detail: `${match[3]}()`, file: file.path });
    }
    for (const match of source.matchAll(/\b(?:app|group|endpoints|routes)\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g)) {
      tags.add('API uç noktası');
      items.push({ badge: 'Endpoint', tone: 'accent', name: `${match[1].toUpperCase()} ${match[2]}`, file: file.path });
    }
    for (const match of source.matchAll(/\bMap(Hub|GrpcService)<\s*([\w.]+)\s*>\s*\(\s*(?:"([^"]+)")?\s*\)/g)) {
      items.push({ badge: match[1] === 'Hub' ? 'SignalR' : 'gRPC', tone: 'running', name: match[3] || match[2], detail: match[3] ? match[2] : '', file: file.path });
    }
    for (const match of source.matchAll(/\b(?:services|Services)\.Add(Scoped|Singleton|Transient|DbContext|HostedService|HttpClient)\s*<\s*([^>]+?)>\s*\(/g)) {
      const parts = match[2].split(',').map(part => part.trim());
      items.push({ badge: 'DI', tone: 'done', name: parts.join(' → '), detail: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\bDbSet<\s*([\w.]+)\s*>\s+(\w+)/g)) {
      tags.add('veri katmanı');
      items.push({ badge: 'EF Core', tone: 'accent', name: `DbSet<${match[1]}> ${match[2]}`, file: file.path });
    }
    for (const match of source.matchAll(/\bmigrationBuilder\.(CreateTable|AddColumn|DropTable|DropColumn|CreateIndex|AddForeignKey|RenameColumn)\s*(?:<[^>]+>)?\s*\(\s*(?:name:\s*)?"([^"]+)"/g)) {
      tags.add('migration');
      items.push({ badge: 'Migration', tone: 'needs', name: `${match[1]}("${match[2]}")`, file: file.path });
    }
    for (const match of source.matchAll(/\[(?:Fact|Theory|Test|TestMethod|TestCase[^\]]*)\][\s\S]{0,180}?\b(?:public|internal)\s+(?:async\s+)?(?:Task(?:<[^>]+>)?|void)\s+(\w+)\s*\(/g)) {
      tags.add('test sınıfı');
      items.push({ badge: t('Test'), tone: 'done', name: `${match[1]}()`, file: file.path });
    }
    for (const match of source.matchAll(/\b(?:public|internal)\s+(?:(?:sealed|abstract|static|partial|readonly)\s+)*(class|record(?:\s+struct)?|interface|struct|enum)\s+(\w+)(?:\s*:\s*([^\n{]+))?/g)) {
      items.push({ badge: match[1].replace(/\s+/g, ' '), tone: 'idle', name: match[2], detail: match[3]?.trim().slice(0, 60) || '', file: file.path });
    }
    for (const match of source.matchAll(/@page\s+"([^"]+)"/g)) {
      tags.add('Blazor bileşeni');
      items.push({ badge: 'Blazor', tone: 'accent', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/<Package(?:Reference|Version)\s+Include="([^"]+)"(?:\s+Version="([^"]+)")?/gi)) {
      items.push({ badge: 'NuGet', tone: 'accent', name: match[1], detail: match[2] || '', file: file.path });
    }
    for (const match of source.matchAll(/<TargetFrameworks?>([^<]+)<\/TargetFrameworks?>/gi)) {
      items.push({ badge: 'Target', tone: 'running', name: match[1].trim(), file: file.path });
    }
  }
  return { tags: [...tags], items };
}

export function activate(aiws) {
  aiws.i18n.add({ en: EN });
  const t = aiws.i18n.t, { html, raw } = aiws.ui, { parse, ui } = aiws.conversation, { baseName, flagValue, sourceFiles } = parse;
  const read = node => parse.stripAnsi(node.output);
  const elapsed = text => text.match(/Time Elapsed\s+([\d:.]+)/)?.[1]?.replace(/^00:/, '') || '';

  aiws.conversation.addToolView({
    id: 'dotnet-commands', order: 10,
    match: node => node.kind === 'tool' && isDotnet(node),
    summary(node) {
      const sub = String(node.program === 'msbuild' ? 'msbuild' : node.program === 'vstest' ? 'test' : node.args[0] || '').toLowerCase(), ef = efCommand(node.args, flagValue), done = node.status !== 'running', text = read(node);
      const options = [flagValue(node.args, '-c', '--configuration'), flagValue(node.args, '-f', '--framework')].filter(Boolean).map(value => ({ text: value }));
      if (ef) {
        const applied = [...text.matchAll(/Applying migration '([^']+)'/g)].length;
        const title = ef.action === 'migration' ? 'Yeni migration' : ef.action === 'update' ? 'Veritabanı güncelleme' : ef.action === 'list' ? 'Migration listesi' : 'EF Core';
        return { pin: true, icon: 'EF', title: t(title), subject: [ef.target, ef.context].filter(Boolean).join(' · '), activity: t(ef.action === 'migration' ? 'Migration oluşturuluyor' : ef.action === 'update' ? 'Veritabanı güncelleniyor' : 'dotnet çalışıyor'), tone: done ? node.status === 'failed' ? 'failed' : 'done' : undefined, chips: applied ? [{ text: `${applied} migration`, tone: 'done' }] : [] };
      }
      if (sub === 'add' || sub === 'remove') {
        const isPackage = node.args.includes('package'), name = node.args[node.args.indexOf('package') + 1], version = flagValue(node.args, '-v', '--version');
        return isPackage ? { pin: false, icon: '⬇', title: t(sub === 'add' ? 'Paket ekleme' : 'Paket kaldırma'), subject: name, activity: t('Paket ekleniyor'), tone: done ? node.status === 'failed' ? 'failed' : 'done' : undefined, chips: version ? [{ text: version }] : [] } : { icon: '#', activity: t('dotnet çalışıyor') };
      }
      const [title, activity] = SUBCOMMANDS[sub] || [`dotnet ${sub}`.trim(), 'dotnet çalışıyor'];
      const project = node.args.slice(1).find(arg => /\.(?:cs|fs|vb)proj$|\.slnx?$/i.test(arg)) || flagValue(node.args, '--project', '-p');
      const subject = [project && baseName(project), flagValue(node.args, '--filter')].filter(Boolean).join(' · ');
      const base = { pin: ['test', 'vstest', 'build', 'publish', 'pack', 'msbuild'].includes(sub), icon: '#', title: t(title), subject, activity: t(activity) };
      if (!done) return { ...base, chips: options };
      if (sub === 'test' || sub === 'vstest') {
        const report = parse.testReport(text); if (!report) return { ...base, tone: node.status === 'failed' ? 'failed' : undefined, chips: options };
        const cov = coverageRate(text);
        return { ...base, tone: report.failed ? 'failed' : 'done', chips: [report.passed ? { text: `${report.passed} ${t('geçti')}`, tone: 'done' } : null, report.failed ? { text: `${report.failed} ${t('kaldı')}`, tone: 'failed' } : null, report.skipped ? { text: `${report.skipped} ${t('atlandı')}`, tone: 'idle' } : null, cov ? { text: cov, tone: 'accent' } : null, report.duration ? { text: report.duration } : null] };
      }
      if (sub === 'restore') { const count = restoredCount(text); return { ...base, tone: node.status === 'failed' ? 'failed' : 'done', chips: count ? [{ text: `${count} ${t('proje geri yüklendi')}`, tone: 'done' }] : [] }; }
      if (sub === 'list') { const pkgs = listedPackages(text); return { ...base, tone: node.status === 'failed' ? 'failed' : 'done', chips: pkgs.length ? [{ text: `${pkgs.length} NuGet`, tone: 'accent' }] : [] }; }
      if (sub === 'run' || sub === 'watch') { const urls = listening(text), env = hostingEnv(text); return { ...base, chips: [...urls.slice(0, 2).map(url => ({ text: url, tone: 'running' })), env ? { text: env } : null] }; }
      const found = parse.diagnostics(text), nupkgs = packedNupkgs(text);
      return { ...base, tone: found.errors || node.status === 'failed' ? 'failed' : 'done', chips: [found.errors ? { text: `${found.errors} ${t('hata')}`, tone: 'failed' } : null, found.warnings ? { text: `${found.warnings} ${t('uyarı')}`, tone: 'needs' } : null, nupkgs.length ? { text: baseName(nupkgs[0]), tone: 'done' } : null, elapsed(text) ? { text: elapsed(text) } : null, ...options] };
    },
    inline(node) {
      if (node.status === 'running') return undefined;
      const sub = String(node.program === 'vstest' ? 'test' : node.args[0] || '').toLowerCase(), text = read(node);
      if (sub === 'test') { const report = parse.testReport(text); return report ? ui.testExplorer(report, { compact: true }) : undefined; }
      if (['build', 'publish', 'pack', 'msbuild'].includes(sub)) { const errors = parse.diagnostics(text).items.filter(item => item.severity === 'error'); return errors.length ? ui.diagnostics(errors, 5) : undefined; }
      return undefined;
    },
    detail(node) {
      const sub = String(node.program === 'vstest' ? 'test' : node.args[0] || '').toLowerCase(), text = read(node), ef = efCommand(node.args, flagValue);
      const projectArg = node.args.slice(1).find(arg => /\.(?:cs|fs|vb)proj$|\.slnx?$/i.test(arg)) || flagValue(node.args, '--project', '-p');
      const settings = ui.stats([{ label: t('Yapılandırma'), value: flagValue(node.args, '-c', '--configuration') }, { label: t('Hedef'), value: flagValue(node.args, '-f', '--framework') || flagValue(node.args, '-r', '--runtime') }, { label: t('Filtre'), value: flagValue(node.args, '--filter') }, { label: t('Proje'), value: baseName(projectArg) }, { label: t('Kapsama'), value: coverageRate(text) }]);
      if (ef) {
        const applied = [...text.matchAll(/Applying migration '([^']+)'/g)].map(match => ({ text: match[1], state: 'done' }));
        if (applied.length) return html`<h4 class="cv-section-title dn-title">${t("Uygulanan migration'lar")}</h4>${raw(ui.steps(applied))}`;
        if (/No migrations were applied/i.test(text)) return html`<p class="cv-hint dn-hint">${t('Veritabanı güncel')}</p>`;
        return undefined;
      }
      if (sub === 'test') {
        const report = parse.testReport(text);
        return `${settings}${report ? ui.testExplorer(report) : ''}`;
      }
      if (sub === 'list') {
        const pkgs = listedPackages(text);
        return pkgs.length ? html`<h4 class="cv-section-title dn-title">${t('Paketler')}</h4>${raw(ui.codeMap(pkgs.map(pkg => ({ badge: 'NuGet', tone: pkg.latest ? 'needs' : 'done', name: pkg.name, detail: pkg.latest ? `${pkg.resolved} → ${pkg.latest}` : pkg.resolved }))))}` : settings;
      }
      if (sub === 'run' || sub === 'watch') {
        const urls = listening(text), env = hostingEnv(text);
        return urls.length || env ? `${ui.stats([{ label: t('Ortam'), value: env }, { label: t('Proje'), value: baseName(projectArg) }])}${urls.length ? html`<h4 class="cv-section-title dn-title">${t('Adresler')}</h4><ul class="dn-links">${raw(urls.map(url => html`<li><code>${url}</code></li>`).join(''))}</ul>` : ''}` : settings;
      }
      const found = parse.diagnostics(text), built = [...outputs(text), ...packedNupkgs(text).map(path => ({ project: 'NuGet', path }))], counts = new Map();
      for (const item of found.items) if (item.severity === 'warning' && item.code) counts.set(item.code, (counts.get(item.code) || 0) + 1);
      const frequent = [...counts].sort((left, right) => right[1] - left[1]).slice(0, 6);
      return `${settings}${found.items.length ? ui.diagnostics(found.items) : ''}${frequent.length > 1 ? html`<h4 class="cv-section-title dn-title">${t('En sık uyarılar')}</h4><p>${raw(ui.chips(frequent.map(([code, count]) => ({ text: `${code} ×${count}`, tone: 'needs' }))))}</p>` : ''}${built.length ? html`<h4 class="cv-section-title dn-title">${t('Çıktılar')}</h4><div class="dn-outputs">${raw(built.map(item => `<div>${html`<b>${item.project}</b>`}${ui.fileName(item.path)}</div>`).join(''))}</div>` : ''}`;
    },
  });

  // Edits and reads of .NET & C# files surface endpoints, DI services, EF Core entities, tests and project references.
  aiws.conversation.addToolView({
    id: 'dotnet-files', order: 20,
    match: node => sourceFiles(node).some(file => fileRole(file.path)),
    summary(node) {
      const { tags, items } = analyzeDotnetCode(sourceFiles(node), t, baseName);
      return { chips: [...tags.slice(0, 3).map(tag => ({ text: t(tag), tone: tag === 'migration' || tag === 'proje dosyası' ? 'needs' : 'accent' }))] };
    },
    inline(node) {
      const { tags } = analyzeDotnetCode(sourceFiles(node), t, baseName);
      const hint = tags.includes('migration') ? html`<p class="cv-hint dn-hint">${t('Migration dosyası değişti; veritabanını güncellemeyi unutma.')}</p>` : tags.includes('proje dosyası') && node.kind === 'files' ? html`<p class="cv-hint dn-hint">${t('Bu değişiklik paket geri yüklemesi gerektirebilir.')}</p>` : '';
      return hint || undefined;
    },
    detail(node) {
      const { items } = analyzeDotnetCode(sourceFiles(node), t, baseName);
      return items.length ? html`<h4 class="cv-section-title dn-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(items, 20))}` : undefined;
    },
  });

  const latest = (nodes, sub) => [...nodes].reverse().find(node => isDotnet(node) && String(node.program === 'vstest' ? 'test' : node.args[0]).toLowerCase() === sub && node.status !== 'running');
  aiws.conversation.addPanel({
    id: 'dotnet-summary', title: '.NET', icon: '#', order: 10,
    visible: ctx => ctx.nodes.some(node => isDotnet(node) || sourceFiles(node).some(file => fileRole(file.path))),
    summary(ctx) {
      const test = latest(ctx.nodes, 'test'), build = latest(ctx.nodes, 'build'), report = test && parse.testReport(read(test)), found = build && parse.diagnostics(read(build)), running = ctx.nodes.find(node => isDotnet(node) && node.status === 'running');
      return [report ? { text: `${report.passed}/${report.total}`, tone: report.failed ? 'failed' : 'done', title: t('Son test') } : null, build ? { text: t(build.status === 'failed' || found?.errors ? 'Başarısız' : 'Başarılı'), tone: build.status === 'failed' || found?.errors ? 'failed' : 'done', title: t('Son derleme') } : null, running ? { text: t('Çalışıyor'), tone: 'running' } : null];
    },
    render(container, ctx) {
      const paint = next => {
        const test = latest(next.nodes, 'test'), build = latest(next.nodes, 'build'), report = test && parse.testReport(read(test)), found = build && parse.diagnostics(read(build)), recent = next.nodes.filter(isDotnet).slice(-6).reverse();
        const codeItems = next.nodes.flatMap(node => analyzeDotnetCode(sourceFiles(node), t, baseName).items);
        container.innerHTML = `${ui.stats([{ label: t('Son test'), value: report ? `${report.passed} ${t('geçti')} · ${report.failed} ${t('kaldı')} (${report.passRate}%)` : t('Henüz yok'), tone: report ? report.failed ? 'failed' : 'done' : undefined }, { label: t('Son derleme'), value: build ? `${found.errors} ${t('hata')} · ${found.warnings} ${t('uyarı')}` : t('Henüz yok'), tone: build ? found.errors || build.status === 'failed' ? 'failed' : 'done' : undefined }])}${report ? ui.testExplorer(report, { limit: 8 }) : ''}${codeItems.length ? html`<h4 class="cv-section-title dn-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(codeItems, 8))}` : ''}${recent.length ? html`<h4 class="cv-section-title dn-title">${t('Son komutlar')}</h4>${raw(ui.steps(recent.map(node => ({ text: node.commandLine, state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'done' }))))}` : ''}`;
      };
      paint(ctx);
      return { update: paint };
    },
  });
}
