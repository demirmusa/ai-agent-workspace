// React Native in the agent chat: Expo, EAS, Metro, Gradle, CocoaPods, Xcode, adb, Detox and Maestro commands get their own rows and
// cards with an IDE-style test explorer; edits and reads surface TurboModules, native bridges, permissions, screens, Reanimated hooks
// and rebuild warnings; and a panel above the chat follows builds, devices, tests and mobile architecture.

const EN = {
  'Android derlemesi': 'Android build', 'iOS derlemesi': 'iOS build', 'Android çalıştırma': 'Run on Android', 'iOS çalıştırma': 'Run on iOS', 'Metro': 'Metro', 'Expo': 'Expo', 'Expo prebuild': 'Expo prebuild', 'EAS derlemesi': 'EAS build', 'EAS gönderimi': 'EAS submit', 'EAS güncellemesi': 'EAS update', 'CocoaPods': 'CocoaPods', 'Cihaz komutu': 'Device command', 'Bağlı cihazlar': 'Connected devices', 'Cihaz günlüğü': 'Device log', 'Uygulama kurulumu': 'App install', 'E2E testleri': 'E2E tests', 'Bundle üretimi': 'Bundle',
  'Android derleniyor': 'Building for Android', 'iOS derleniyor': 'Building for iOS', 'Metro başlatılıyor': 'Starting Metro', 'Expo çalışıyor': 'Running Expo', 'Native projeler üretiliyor': 'Generating native projects', 'EAS derlemesi çalışıyor': 'Running EAS build', 'Mağazaya gönderiliyor': 'Submitting to the store', 'Güncelleme yayımlanıyor': 'Publishing the update', "Pod'lar kuruluyor": 'Installing pods', 'Cihaz komutu çalışıyor': 'Running a device command', 'E2E testleri çalışıyor': 'Running E2E tests', 'Bundle üretiliyor': 'Bundling',
  'Başarılı': 'Succeeded', 'Başarısız': 'Failed', 'görev': 'tasks', 'çalıştı': 'executed', 'güncel': 'up to date', 'hata': 'errors', 'uyarı': 'warnings', 'cihaz': 'devices', 'pod': 'pods', 'modül': 'modules', 'geçti': 'passed', 'kaldı': 'failed', 'atlandı': 'skipped',
  'Ne ters gitti': 'What went wrong', 'Başarısız görevler': 'Failed tasks', 'Son görevler': 'Latest tasks', 'Çıktılar': 'Outputs', 'Süre': 'Duration', 'Varyant': 'Variant', 'Platform': 'Platform', 'Profil': 'Profile', 'Derleme sayfası': 'Build page', 'Geliştirme adresi': 'Dev address', 'Hatalar': 'Errors', 'Cihaz': 'Device', 'Durum': 'Status', 'Cihaz yok': 'No devices', 'Kod yapısı': 'Code structure', 'Kurulan podlar': 'Installed pods',
  'native': 'native', 'Expo ayarı': 'Expo config', 'RN bileşeni': 'RN component', 'Native kod değişti: hot reload yetmez, yeni bir native derleme gerekir.': 'Native code changed: hot reload is not enough, a new native build is needed.', 'package.json değişti: native bir paket eklendiyse pod install ve yeni derleme gerekir.': 'package.json changed: a new native package needs pod install and a new build.', 'Expo yapılandırması değişti: prebuild veya yeni derleme gerekebilir.': 'Expo config changed: a prebuild or a new build may be needed.',
  'Son Android derlemesi': 'Last Android build', 'Son iOS derlemesi': 'Last iOS build', 'Son testler': 'Last tests', 'Henüz yok': 'None yet', 'Son komutlar': 'Recent commands', 'Çalışıyor': 'Running',
};
const isGradle = node => /^gradlew?$/.test(node.program);
const lower = node => node.args.map(arg => String(arg).toLowerCase());
const JS_TESTS = new Set(['jest', 'vitest']);
/** What a command does in a React Native project; null when it is not one of its tools. */
function commandOf(node) {
  const args = lower(node), sub = args[0] || '', program = node.program;
  if (isGradle(node)) return /test/.test(args.join(' ')) ? { key: 'android-test', title: 'E2E testleri', activity: 'E2E testleri çalışıyor', test: true } : { key: 'gradle', title: 'Android derlemesi', activity: 'Android derleniyor', build: 'android' };
  if (program === 'xcodebuild') return args.includes('test') ? { key: 'ios-test', title: 'E2E testleri', activity: 'E2E testleri çalışıyor', test: true } : { key: 'xcode', title: 'iOS derlemesi', activity: 'iOS derleniyor', build: 'ios' };
  if (program === 'pod') return { key: 'pod', title: 'CocoaPods', activity: "Pod'lar kuruluyor" };
  if (program === 'adb') return { key: 'adb', sub, title: sub === 'devices' ? 'Bağlı cihazlar' : sub === 'logcat' ? 'Cihaz günlüğü' : sub === 'install' ? 'Uygulama kurulumu' : 'Cihaz komutu', activity: 'Cihaz komutu çalışıyor' };
  if (program === 'detox' || program === 'maestro') return { key: 'e2e', title: 'E2E testleri', activity: 'E2E testleri çalışıyor', test: true };
  if (program === 'eas') return sub === 'build' ? { key: 'eas', title: 'EAS derlemesi', activity: 'EAS derlemesi çalışıyor' } : sub === 'submit' ? { key: 'eas', title: 'EAS gönderimi', activity: 'Mağazaya gönderiliyor' } : sub === 'update' ? { key: 'eas', title: 'EAS güncellemesi', activity: 'Güncelleme yayımlanıyor' } : { key: 'eas', title: 'Expo', activity: 'Expo çalışıyor' };
  if (program === 'expo') {
    if (sub === 'run:android') return { key: 'gradle', title: 'Android çalıştırma', activity: 'Android derleniyor', build: 'android' };
    if (sub === 'run:ios') return { key: 'xcode', title: 'iOS çalıştırma', activity: 'iOS derleniyor', build: 'ios' };
    if (sub === 'prebuild') return { key: 'prebuild', title: 'Expo prebuild', activity: 'Native projeler üretiliyor' };
    if (sub === 'start') return { key: 'metro', title: 'Metro', activity: 'Metro başlatılıyor' };
    return { key: 'expo', title: 'Expo', activity: 'Expo çalışıyor' };
  }
  if (program === 'react-native') {
    if (sub === 'run-android') return { key: 'gradle', title: 'Android çalıştırma', activity: 'Android derleniyor', build: 'android' };
    if (sub === 'run-ios') return { key: 'xcode', title: 'iOS çalıştırma', activity: 'iOS derleniyor', build: 'ios' };
    if (sub === 'start') return { key: 'metro', title: 'Metro', activity: 'Metro başlatılıyor' };
    if (sub === 'bundle') return { key: 'bundle', title: 'Bundle üretimi', activity: 'Bundle üretiliyor' };
    return { key: 'expo', title: 'Metro', activity: 'Metro başlatılıyor' };
  }
  return null;
}
function gradleResult(text) {
  const result = text.match(/BUILD (SUCCESSFUL|FAILED) in ([^\n]+)/), actionable = text.match(/(\d+) actionable tasks?:\s*(?:(\d+) executed)?(?:,\s*)?(?:(\d+) up-to-date)?/);
  const failed = [...new Set([...text.matchAll(/^> Task (\S+) FAILED/gm)].map(match => match[1]))], tasks = [...text.matchAll(/^> Task (\S+)(?:\s+(\S[\w -]*))?\s*$/gm)].map(match => ({ name: match[1], state: match[2] || '' }));
  const wrong = text.match(/\* What went wrong:\n([\s\S]*?)(?:\n\* Try:|\n\* Exception|\n\* Get more|\n={5,}|$)/)?.[1]?.trim() || '';
  const artifacts = [...new Set([...text.matchAll(/\S*(?:outputs[\\/](?:apk|bundle))[\\/]\S+\.(?:apk|aab)/g)].map(match => match[0]))];
  return { ok: result ? result[1] === 'SUCCESSFUL' : null, duration: result?.[2]?.trim() || '', tasks: actionable ? Number(actionable[1]) : tasks.length, executed: actionable?.[2] ? Number(actionable[2]) : 0, upToDate: actionable?.[3] ? Number(actionable[3]) : 0, failed, recent: tasks.slice(-8), wrong, artifacts };
}
const xcodeResult = text => { const match = text.match(/\*\* (?:BUILD|ARCHIVE|TEST) (SUCCEEDED|FAILED) \*\*/); return { ok: match ? match[1] === 'SUCCEEDED' : null }; };
function podResult(text) {
  const match = text.match(/There (?:is|are) (\d+) dependenc(?:y|ies) from the Podfile and (\d+) total pods? installed/);
  const installed = [...text.matchAll(/^Installing\s+(\S+)\s+\(([^)]+)\)/gm)].map(item => ({ name: item[1], version: item[2] }));
  return match || installed.length ? { dependencies: Number(match?.[1] || 0), pods: Number(match?.[2] || installed.length), installed } : null;
}
const metroBundle = text => { const matches = [...text.matchAll(/(?:Bundled|Bundling complete)\s*(\d+)\s*ms\s*(\S+)?\s*\((\d+) modules?\)/g)].at(-1); return matches ? { ms: Number(matches[1]), entry: matches[2] || '', modules: Number(matches[3]) } : null; };
const devServer = text => text.match(/\bexp:\/\/\S+/)?.[0] || text.match(/Metro waiting on (\S+)/)?.[1] || text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\S*/)?.[0] || '';
const easLink = text => text.match(/https:\/\/expo\.dev\/\S*builds\/\S+/)?.[0] || '';
const devices = text => [...text.matchAll(/^(\S+)\s+(device|offline|unauthorized|emulator|recovery)\b(.*)$/gm)].filter(match => !/^List$/.test(match[1])).map(match => ({ serial: match[1], state: match[2], model: match[3].match(/model:(\S+)/)?.[1] || '' }));
const logcat = text => [...text.matchAll(/^.*?\s([EF])\s+([\w.$/-]+)\s*:\s(.*)$|^([EF])\/([\w.$-]+)\s*\(\s*\d+\):\s(.*)$/gm)].map(match => ({ tag: match[2] || match[5], message: match[3] || match[6] })).slice(-40);
const buildsNative = node => commandOf(node)?.build;

const nativePath = path => /(?:^|[\\/])(?:android|ios)[\\/]/.test(path) && !/[\\/](?:build|Pods)[\\/]/.test(path);
const configPath = path => /(?:^|[\\/])(?:app\.json|app\.config\.[jt]s|eas\.json|metro\.config\.[cm]?[jt]s|babel\.config\.[cm]?[jt]s|react-native\.config\.[cm]?[jt]s)$/.test(path);
const manifestPath = path => /(?:^|[\\/])package\.json$/.test(path);

/** Extracts TurboModules, native bridges, permissions, screens, Reanimated hooks and Gradle/CocoaPods entries from edited or read files. */
function analyzeRnCode(files) {
  const tags = new Set(), items = [];
  for (const file of files) {
    if (nativePath(file.path)) tags.add('native');
    if (configPath(file.path)) tags.add('Expo ayarı');
    const source = file.addedText || file.text || '';
    if (!source) continue;
    for (const match of source.matchAll(/\b(?:TurboModuleRegistry\.get(?:Enforcing)?|codegenNativeComponent|requireNativeComponent)\s*(?:<[^>]+>)?\s*\(\s*['"]([^'"]+)['"]/g)) {
      tags.add('native');
      items.push({ badge: 'TurboModule', tone: 'accent', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\bNativeModules\.([A-Za-z_$][\w$]*)/g)) {
      items.push({ badge: 'NativeBridge', tone: 'accent', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/@ReactMethod\s+(?:fun|(?:public|private)\s+\w+)\s+(\w+)\s*\(/g)) {
      tags.add('native');
      items.push({ badge: 'Android Bridge', tone: 'needs', name: `@ReactMethod ${match[1]}()`, file: file.path });
    }
    for (const match of source.matchAll(/\bRCT_EXPORT_(?:MODULE|METHOD|BLOCKING_SYNCHRONOUS_METHOD)\s*\(\s*(\w+)/g)) {
      tags.add('native');
      items.push({ badge: 'iOS Bridge', tone: 'needs', name: `RCT_EXPORT ${match[1]}`, file: file.path });
    }
    for (const match of source.matchAll(/<(?:Stack|Tab|Tabs|Drawer)\.Screen\b[^>]*?\bname=['"]([^'"]+)['"]/g)) {
      tags.add('RN bileşeni');
      items.push({ badge: 'Screen', tone: 'accent', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(FlatList|FlashList|SectionList|ScrollView|Modal|Pressable|SafeAreaView|KeyboardAvoidingView|RefreshControl)\b/g)) {
      tags.add('RN bileşeni');
      items.push({ badge: 'RN UI', tone: 'idle', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(useSharedValue|useAnimatedStyle|withSpring|withTiming|Gesture\.\w+)\b/g)) {
      tags.add('RN bileşeni');
      items.push({ badge: 'Reanimated', tone: 'running', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/\b(PermissionsAndroid\.\w+|Platform\.select|Platform\.OS|Linking\.\w+|AsyncStorage\.\w+)\b/g)) {
      items.push({ badge: 'Device API', tone: 'done', name: match[1], file: file.path });
    }
    for (const match of source.matchAll(/android\.permission\.([A-Z_]+)/g)) {
      items.push({ badge: 'Permission', tone: 'needs', name: match[1], detail: 'Android', file: file.path });
    }
    for (const match of source.matchAll(/<key>(NS\w+UsageDescription)<\/key>/g)) {
      items.push({ badge: 'Permission', tone: 'needs', name: match[1], detail: 'iOS', file: file.path });
    }
    if (/build\.gradle/i.test(file.path)) {
      for (const match of source.matchAll(/\b(?:implementation|api|ksp|kapt)\s*\(?['"]([^'"]+)['"]\)?/g)) items.push({ badge: 'Gradle', tone: 'accent', name: match[1], file: file.path });
    }
    if (/Podfile$/i.test(file.path)) {
      for (const match of source.matchAll(/\bpod\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/g)) items.push({ badge: 'Pod', tone: 'accent', name: match[1], detail: match[2] || '', file: file.path });
    }
  }
  return { tags: [...tags], items };
}

export function activate(aiws) {
  aiws.i18n.add({ en: EN });
  const t = aiws.i18n.t, { html, raw } = aiws.ui, { parse, ui } = aiws.conversation, { flagValue, sourceFiles } = parse;
  const read = node => parse.stripAnsi(node.output);
  const outcome = (node, ok) => node.status === 'failed' || ok === false ? 'failed' : ok === true || node.status === 'completed' ? 'done' : undefined;

  aiws.conversation.addToolView({
    id: 'rn-commands', order: 10,
    match: node => node.kind === 'tool' && Boolean(commandOf(node)),
    summary(node) {
      const command = commandOf(node), done = node.status !== 'running', text = read(node), base = { pin: Boolean(command.build || command.test || command.key === 'eas'), icon: 'RN', title: t(command.title), activity: t(command.activity), subject: node.args.join(' ').slice(0, 140) };
      if (!done) return base;
      if (command.key === 'gradle') { const result = gradleResult(text), found = parse.diagnostics(text); return { ...base, tone: outcome(node, result.ok), chips: [result.ok !== true ? null : { text: t('Başarılı'), tone: 'done' }, found.errors ? { text: `${found.errors} ${t('hata')}`, tone: 'failed' } : null, result.tasks ? { text: `${result.tasks} ${t('görev')}` } : null, result.duration ? { text: result.duration } : null] }; }
      if (command.key === 'xcode') { const result = xcodeResult(text), found = parse.diagnostics(text); return { ...base, tone: outcome(node, result.ok), chips: [result.ok !== true ? null : { text: t('Başarılı'), tone: 'done' }, result.ok === false && node.status !== 'failed' ? { text: t('Başarısız'), tone: 'failed' } : null, found.errors ? { text: `${found.errors} ${t('hata')}`, tone: 'failed' } : null] }; }
      if (command.key === 'pod') { const pods = podResult(text); return { ...base, tone: outcome(node, pods ? true : null), chips: pods ? [{ text: `${pods.pods} ${t('pod')}`, tone: 'done' }] : [] }; }
      if (command.key === 'metro' || command.key === 'bundle') { const bundle = metroBundle(text), server = devServer(text); return { ...base, chips: [bundle ? { text: `${bundle.modules} ${t('modül')}`, tone: 'done' } : null, bundle ? { text: `${(bundle.ms / 1000).toFixed(1)} s` } : null, server ? { text: server, tone: 'running' } : null] }; }
      if (command.key === 'adb' && command.sub === 'devices') { const list = devices(text); return { ...base, chips: [{ text: `${list.length} ${t('cihaz')}`, tone: list.some(item => item.state === 'device') ? 'done' : 'needs' }] }; }
      if (command.key === 'adb' && command.sub === 'logcat') { const errors = logcat(text); return { ...base, chips: errors.length ? [{ text: `${errors.length} ${t('hata')}`, tone: 'failed' }] : [] }; }
      if (command.test) {
        const report = parse.testReport(text);
        return { ...base, tone: report ? report.failed ? 'failed' : 'done' : outcome(node, null), chips: report ? [report.passed ? { text: `${report.passed} ${t('geçti')}`, tone: 'done' } : null, report.failed ? { text: `${report.failed} ${t('kaldı')}`, tone: 'failed' } : null, report.skipped ? { text: `${report.skipped} ${t('atlandı')}`, tone: 'idle' } : null, report.duration ? { text: report.duration } : null] : [] };
      }
      return { ...base, tone: outcome(node, null) };
    },
    inline(node) {
      if (node.status === 'running') return undefined;
      const command = commandOf(node), text = read(node);
      if (command.key === 'gradle') { const result = gradleResult(text), errors = parse.diagnostics(text).items.filter(item => item.severity === 'error'); if (result.ok !== false) return undefined; return errors.length ? ui.diagnostics(errors, 4) : result.wrong ? html`<p class="rn-wrong">${result.wrong.split('\n')[0]}</p>` : undefined; }
      if (command.key === 'xcode') { const errors = parse.diagnostics(text).items.filter(item => item.severity === 'error'); return errors.length ? ui.diagnostics(errors, 4) : undefined; }
      if (command.test) { const report = parse.testReport(text); return report ? ui.testExplorer(report, { compact: true }) : undefined; }
      return undefined;
    },
    detail(node) {
      const command = commandOf(node), text = read(node), args = lower(node);
      if (command.key === 'gradle') {
        const result = gradleResult(text), found = parse.diagnostics(text), variant = node.args.find(arg => /assemble|bundle|install/i.test(arg)) || flagValue(args, '--variant', '--mode');
        return `${ui.stats([{ label: t('Varyant'), value: variant }, { label: t('Süre'), value: result.duration }, { label: t('çalıştı'), value: result.executed || '' }, { label: t('güncel'), value: result.upToDate || '' }])}${result.failed.length ? html`<h4 class="cv-section-title rn-title">${t('Başarısız görevler')}</h4>${raw(ui.failures(result.failed))}` : ''}${result.wrong ? html`<h4 class="cv-section-title rn-title">${t('Ne ters gitti')}</h4><pre class="cv-code-block rn-block">${result.wrong}</pre>` : ''}${found.items.length ? ui.diagnostics(found.items) : ''}${result.artifacts.length ? html`<h4 class="cv-section-title rn-title">${t('Çıktılar')}</h4><div class="cv-file-rows rn-rows">${raw(result.artifacts.map(path => ui.fileName(path)).join(''))}</div>` : ''}${!result.failed.length && result.recent.length ? html`<h4 class="cv-section-title rn-title">${t('Son görevler')}</h4>${raw(ui.steps(result.recent.map(task => ({ text: task.name, detail: task.state, state: 'done' }))))}` : ''}`;
      }
      if (command.key === 'xcode') { const found = parse.diagnostics(text); return found.items.length ? ui.diagnostics(found.items) : undefined; }
      if (command.key === 'pod') {
        const pods = podResult(text);
        if (!pods) return undefined;
        return `${ui.stats([{ label: 'Podfile', value: pods.dependencies || '' }, { label: t('pod'), value: pods.pods }])}${pods.installed.length ? html`<h4 class="cv-section-title rn-title">${t('Kurulan podlar')}</h4>${raw(ui.codeMap(pods.installed.map(pod => ({ badge: 'Pod', tone: 'done', name: pod.name, detail: pod.version })), 15))}` : ''}`;
      }
      if (command.key === 'metro' || command.key === 'bundle' || command.key === 'expo') { const server = devServer(text), bundle = metroBundle(text); return server || bundle ? ui.stats([{ label: t('Geliştirme adresi'), value: server }, { label: t('modül'), value: bundle?.modules }, { label: t('Süre'), value: bundle ? `${(bundle.ms / 1000).toFixed(1)} s` : '' }]) : undefined; }
      if (command.key === 'eas') { const link = easLink(text); return `${ui.stats([{ label: t('Platform'), value: flagValue(args, '--platform', '-p') }, { label: t('Profil'), value: flagValue(args, '--profile', '-e') }])}${link ? html`<p><a href="${link}" target="_blank" rel="noopener noreferrer">${t('Derleme sayfası')}</a></p>` : ''}`; }
      if (command.key === 'adb' && command.sub === 'devices') { const list = devices(text); return list.length ? html`<div class="rn-devices">${raw(list.map(item => html`<div data-tone="${item.state === 'device' ? 'done' : 'needs'}"><b>${item.model || item.serial}</b><code>${item.serial}</code><span>${item.state}</span></div>`).join(''))}</div>` : html`<p>${t('Cihaz yok')}</p>`; }
      if (command.key === 'adb' && command.sub === 'logcat') { const errors = logcat(text); return errors.length ? html`<h4 class="cv-section-title rn-title">${t('Hatalar')}</h4><div class="cv-code-block rn-log">${raw(errors.map(entry => html`<div><b>${entry.tag}</b><span>${entry.message}</span></div>`).join(''))}</div>` : undefined; }
      if (command.test) { const report = parse.testReport(text); return report ? ui.testExplorer(report) : undefined; }
      return undefined;
    },
  });

  // What an edit or read means for the running React Native app, and what bridges, permissions or screens it touches.
  aiws.conversation.addToolView({
    id: 'rn-files', order: 20,
    match: node => {
      const files = sourceFiles(node);
      if (!files.length) return false;
      const { tags, items } = analyzeRnCode(files);
      return tags.length > 0 || items.length > 0;
    },
    summary(node) {
      const files = sourceFiles(node), { tags, items } = analyzeRnCode(files);
      return { chips: [...(files.some(file => nativePath(file.path)) ? [{ text: t('native'), tone: 'needs' }] : tags.map(tag => ({ text: t(tag), tone: 'accent' })))] };
    },
    inline(node) {
      const files = sourceFiles(node);
      const hint = node.kind === 'files' && files.some(file => nativePath(file.path)) ? html`<p class="cv-hint rn-hint">${t('Native kod değişti: hot reload yetmez, yeni bir native derleme gerekir.')}</p>` : node.kind === 'files' && files.some(file => configPath(file.path)) ? html`<p class="cv-hint rn-hint">${t('Expo yapılandırması değişti: prebuild veya yeni derleme gerekebilir.')}</p>` : node.kind === 'files' && files.some(file => manifestPath(file.path)) ? html`<p class="cv-hint rn-hint">${t('package.json değişti: native bir paket eklendiyse pod install ve yeni derleme gerekir.')}</p>` : '';
      return hint || undefined;
    },
    detail(node) {
      const { items } = analyzeRnCode(sourceFiles(node));
      return items.length ? html`<h4 class="cv-section-title rn-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(items, 20))}` : undefined;
    },
  });

  const latestBuild = (nodes, platform) => [...nodes].reverse().find(node => buildsNative(node) === platform && node.status !== 'running');
  const buildState = node => { if (!node) return null; const text = read(node), ok = buildsNative(node) === 'android' ? gradleResult(text).ok : xcodeResult(text).ok; return ok === false || node.status === 'failed' ? 'failed' : 'done'; };
  const latestTests = nodes => [...nodes].reverse().find(node => (commandOf(node)?.test || JS_TESTS.has(node.program)) && node.status !== 'running');
  aiws.conversation.addPanel({
    id: 'rn-summary', title: 'React Native', icon: 'RN', order: 10,
    visible: ctx => ctx.nodes.some(node => commandOf(node) || analyzeRnCode(sourceFiles(node)).tags.length),
    summary(ctx) {
      const android = buildState(latestBuild(ctx.nodes, 'android')), ios = buildState(latestBuild(ctx.nodes, 'ios')), tests = latestTests(ctx.nodes), report = tests && parse.testReport(read(tests));
      return [android ? { text: 'Android', tone: android } : null, ios ? { text: 'iOS', tone: ios } : null, report ? { text: `${report.passed}/${report.total}`, tone: report.failed ? 'failed' : 'done', title: t('Son testler') } : null, ctx.nodes.some(node => commandOf(node) && node.status === 'running') ? { text: t('Çalışıyor'), tone: 'running' } : null];
    },
    render(container, ctx) {
      const paint = next => {
        const label = state => state ? t(state === 'failed' ? 'Başarısız' : 'Başarılı') : t('Henüz yok');
        const android = buildState(latestBuild(next.nodes, 'android')), ios = buildState(latestBuild(next.nodes, 'ios')), tests = latestTests(next.nodes), report = tests && parse.testReport(read(tests));
        const deviceNode = [...next.nodes].reverse().find(node => node.program === 'adb' && lower(node)[0] === 'devices' && node.status !== 'running'), recent = next.nodes.filter(node => commandOf(node)).slice(-6).reverse();
        const links = next.nodes.map(node => easLink(read(node))).filter(Boolean);
        const codeItems = next.nodes.flatMap(node => analyzeRnCode(sourceFiles(node)).items);
        container.innerHTML = `${ui.stats([{ label: t('Son Android derlemesi'), value: label(android), tone: android || undefined }, { label: t('Son iOS derlemesi'), value: label(ios), tone: ios || undefined }, { label: t('Son testler'), value: report ? `${report.passed} ${t('geçti')} · ${report.failed} ${t('kaldı')} (${report.passRate}%)` : t('Henüz yok'), tone: report ? report.failed ? 'failed' : 'done' : undefined }, deviceNode ? { label: t('Bağlı cihazlar'), value: devices(read(deviceNode)).filter(item => item.state === 'device').length } : null])}${report ? ui.testExplorer(report, { limit: 8 }) : ''}${codeItems.length ? html`<h4 class="cv-section-title rn-title">${t('Kod yapısı')}</h4>${raw(ui.codeMap(codeItems, 8))}` : ''}${links.length ? html`<p><a href="${links.at(-1)}" target="_blank" rel="noopener noreferrer">${t('Derleme sayfası')}</a></p>` : ''}${recent.length ? html`<h4 class="cv-section-title rn-title">${t('Son komutlar')}</h4>${raw(ui.steps(recent.map(node => ({ text: node.commandLine, state: node.status === 'running' ? 'running' : node.status === 'failed' ? 'failed' : 'done' }))))}` : ''}`;
      };
      paint(ctx);
      return { update: paint };
    },
  });
}
