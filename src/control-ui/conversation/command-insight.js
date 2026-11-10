/* Understands what a shell command does and what its output says, with no knowledge of the provider that ran it. commandInsight()
 * splits a command line, removes wrappers (shells, npx, env assignments, a leading cd) and classifies what is left; testSummary(),
 * testReport(), diagnostics() and searchResults() read common tool output into counts, test suites and lists. Commands and output are
 * data: nothing here executes or evaluates them. Plugins reach these parsers through aiws.conversation.parse. */
(function (global) {
  'use strict';
  const kit = global.AIWSConversationKit, t = kit.t;
  const stripAnsi = value => String(value ?? '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '').replace(/\r\n/g, '\n').replace(/^.*\r(?=[^\n])/gm, '');
  const baseName = path => String(path ?? '').split(/[\\/]/).at(-1);

  /** Splits at unquoted `&&`, `||`, `;`, `|` and line breaks; `piped` marks a part that only filters the one before it. */
  function splitCommand(command) {
    const parts = [], source = String(command ?? ''); let current = '', quote = '', piped = false;
    const flush = next => { if (current.trim()) parts.push({ text: current.trim(), piped }); current = ''; piped = next; };
    for (let index = 0; index < source.length; index++) {
      const char = source[index], two = source.slice(index, index + 2);
      if (quote) { current += char; if (char === '\\' && quote === '"' && index + 1 < source.length) current += source[++index]; else if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") { quote = char; current += char; continue; }
      if (two === '&&' || two === '||') { flush(false); index++; continue; }
      if (char === '|') { flush(true); continue; }
      if (char === ';' || char === '\n') { flush(false); continue; }
      current += char;
    }
    flush(false);
    return parts;
  }
  /** The words of one command part with their quotes removed. */
  function shellWords(text) {
    const words = []; let current = '', quote = '', started = false;
    for (const char of String(text ?? '')) {
      if (quote) { if (char === quote) quote = ''; else current += char; continue; }
      if (char === '"' || char === "'") { quote = char; started = true; continue; }
      if (/\s/.test(char)) { if (started || current) words.push(current); current = ''; started = false; continue; }
      current += char;
    }
    if (started || current) words.push(current);
    return words;
  }
  /** The value after a CLI flag (`-c Release` or `--configuration=production`), or `''`. */
  function flagValue(args = [], ...names) {
    for (const name of names) {
      const lower = name.toLowerCase(), index = args.findIndex(arg => arg === name || String(arg).toLowerCase() === lower);
      if (index >= 0 && args[index + 1] !== undefined && !String(args[index + 1]).startsWith('-')) return String(args[index + 1]);
      const inline = args.find(arg => String(arg).toLowerCase().startsWith(`${lower}=`));
      if (inline) return String(inline).slice(name.length + 1);
    }
    return '';
  }
  const KNOWN_VALUE_FLAGS = new Set(['-c', '--configuration', '-p', '--project', '-f', '--framework', '-r', '--runtime', '--filter', '-t', '--target', '--targets', '-v', '--version', '--variant', '--mode', '--profile', '-e']);
  /** Positional operands after the first subcommand word, skipping flags and their values. */
  function operands(args = [], extraValueFlags = []) {
    const takesValue = new Set([...KNOWN_VALUE_FLAGS, ...extraValueFlags.map(flag => flag.toLowerCase())]), result = [];
    for (let index = 1; index < args.length; index++) {
      const word = String(args[index] ?? '');
      if (takesValue.has(word.toLowerCase())) { index++; continue; }
      if (!word.startsWith('-')) result.push(word);
    }
    return result;
  }
  /** Parses `sed -i` substitution expressions (`18s/old/new/; s/a/b/`) into unified diff hunks and line counts. */
  function parseSedDiff(script) {
    const hunks = []; let added = 0, removed = 0, text = String(script ?? '');
    const readPart = (source, start, delim) => {
      let out = '', index = start;
      while (index < source.length) {
        const char = source[index];
        if (char === '\\' && index + 1 < source.length) {
          const next = source[++index];
          out += next === delim || '[]&^$*'.includes(next) ? next : `\\${next}`;
          index++; continue;
        }
        if (char === delim) return { value: out, next: index + 1 };
        out += char; index++;
      }
      return null;
    };
    let cursor = 0;
    while (cursor < text.length) {
      const rest = text.slice(cursor), match = rest.match(/^\s*;?\s*(?:(\d+)(?:,\d+)?)?s([/|#@])/);
      if (!match) break;
      const lineNo = match[1] || '', delim = match[2], fromStart = cursor + match[0].length;
      const before = readPart(text, fromStart, delim); if (!before) break;
      const after = readPart(text, before.next, delim); if (!after) break;
      cursor = after.next; while (cursor < text.length && /[gipIms]/.test(text[cursor])) cursor++;
      const cleanBefore = before.value.replace(/^\^/, '').replace(/\$$/, '');
      hunks.push(`${lineNo ? `@@ -${lineNo} +${lineNo} @@\n` : ''}-${cleanBefore}\n+${after.value}`);
      added++; removed++;
    }
    return hunks.length ? { diff: hunks.join('\n'), added, removed } : null;
  }
  /** Extracts files modified in-place by `sed -i` commands or reported by `git diff --stat` in a shell tool call. */
  function shellFiles(node) {
    if (!node || node.kind !== 'tool') return [];
    const byPath = new Map();
    for (const part of splitCommand(node.command)) {
      if (part.piped) continue;
      const words = shellWords(part.text), program = String(words[0] ?? '').split(/[\\/]/).at(-1).toLowerCase();
      if (program === 'sed' && words.some(word => /^-i/.test(word))) {
        const args = words.slice(1).filter(word => !/^-/.test(word));
        if (args.length >= 2) {
          const script = args[0], filePaths = args.slice(1), parsed = parseSedDiff(script);
          for (const rawPath of filePaths) {
            const existing = byPath.get(rawPath);
            const diff = [existing?.diff, parsed?.diff].filter(Boolean).join('\n');
            byPath.set(rawPath, { path: rawPath, kind: 'update', diff, added: (existing?.added || 0) + (parsed?.added || 0), removed: (existing?.removed || 0) + (parsed?.removed || 0) });
          }
        }
      }
    }
    for (const match of stripAnsi(node.output).matchAll(/^\s*([A-Za-z0-9_./\\-]+\.[A-Za-z0-9]+)\s+\|\s+(\d+)\s+(\+*)(-*)\s*$/gm)) {
      const statPath = match[1].trim(), shortName = baseName(statPath), plus = match[3].length, minus = match[4].length;
      const shortEntry = byPath.get(shortName);
      if (shortEntry && shortName !== statPath) { byPath.delete(shortName); byPath.set(statPath, { ...shortEntry, path: statPath }); }
      else if (!byPath.has(statPath)) byPath.set(statPath, { path: statPath, kind: 'update', diff: '', added: plus, removed: minus });
    }
    return [...byPath.values()];
  }
  /** The files an edit or read tool call touched, with their full text and added lines ready for language-specific inspection. */
  function sourceFiles(node) {
    if (!node) return [];
    const fileList = node.kind === 'files' ? (node.files || []) : node.kind === 'tool' && (node.files?.length ? node.files : shellFiles(node));
    if (fileList && fileList.length) {
      return fileList.filter(file => file?.path).map(file => {
        const lines = String(file.diff || '').split('\n');
        const added = lines.filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
        const removed = lines.filter(line => line.startsWith('-') && !line.startsWith('---')).map(line => line.slice(1)).join('\n');
        const context = lines.filter(line => (line.startsWith('+') && !line.startsWith('+++')) || line.startsWith(' ')).map(line => line.slice(1)).join('\n');
        return { path: String(file.path), kind: file.kind || 'update', text: context || added, addedText: added, removedText: removed, diff: String(file.diff || '') };
      });
    }
    if (node.kind === 'tool' && (node.activityKind === 'read' || node.view === 'read')) {
      const path = String(node.command || (node.args || []).find(arg => !String(arg).startsWith('-')) || '').trim();
      if (!path) return [];
      const text = stripAnsi(node.output).split('\n').map(line => line.replace(/^\s*\d+(?:\t|→)/, '')).join('\n');
      return [{ path, kind: 'read', text, addedText: text, removedText: '', diff: '' }];
    }
    return [];
  }
  const programName = word => String(word ?? '').split(/[\\/]/).at(-1).replace(/\.(?:exe|cmd|bat|ps1)$/i, '').toLowerCase();
  const SHELLS = new Set(['bash', 'sh', 'zsh', 'pwsh', 'powershell', 'cmd']), SHELL_FLAG = /^(?:-l?c|-command|\/c)$/i;
  const REDIRECT_TOKEN = /^(?:[12]?>>?&[12]|[12]?>\/dev\/null)$/;
  // Parts that only prepare the one that does the work.
  const NOISE = /^(?:(?:cd|set-location|sl|pushd|popd|export|set|source|\.|echo|write-output|write-host|sleep|start-sleep|true|false|clear)(?:\s|$)|\$[\w:]+\s*=|\[.*\]::)/i;
  /** The words a part really runs, without environment assignments, redirections and launchers such as npx or `python -m`. */
  function coreWords(input) {
    const words = input.filter(word => !REDIRECT_TOKEN.test(word));
    for (let guard = 0; guard < 8 && words.length; guard++) {
      const program = programName(words[0]), next = String(words[1] ?? '').toLowerCase();
      if (/^\w+=/.test(words[0]) || words[0] === '&' || ['time', 'sudo', 'nice', 'call', 'env'].includes(program)) { words.shift(); continue; }
      if (program === 'timeout' && /^\d/.test(next)) { words.splice(0, 2); continue; }
      if (program === 'npx' || program === 'bunx' || program === 'pnpx') { words.shift(); while (/^-/.test(words[0] ?? '')) words.shift(); continue; }
      if (['pnpm', 'yarn', 'npm'].includes(program) && ['exec', 'dlx'].includes(next)) { words.splice(0, 2); continue; }
      if (['uv', 'poetry', 'pipenv'].includes(program) && next === 'run') { words.splice(0, 2); continue; }
      if (/^py(?:thon[\d.]*)?$/.test(program) && next === '-m' && words[2]) { words.splice(0, 2); continue; }
      break;
    }
    return words;
  }
  /** The real parts of a command line with their words, looking inside `bash -c "…"` and `pwsh -Command …`. */
  function commandParts(command, depth = 0) {
    const result = [];
    for (const part of splitCommand(command)) {
      if (part.piped) continue;
      const cleanLine = part.text.replace(/\s+(?:[12]?>>?&[12]|[12]?>\/dev\/null)\s*$/g, '').trim();
      const words = shellWords(cleanLine), flag = words.findIndex(word => SHELL_FLAG.test(word));
      if (depth < 2 && SHELLS.has(programName(words[0])) && flag > 0 && words[flag + 1] !== undefined) { result.push(...commandParts(words.slice(flag + 1).join(' '), depth + 1)); continue; }
      if (NOISE.test(cleanLine)) continue;
      const core = coreWords(words);
      if (core.length) result.push({ line: cleanLine, words: core, program: programName(core[0]), args: core.slice(1) });
    }
    return result;
  }
  const VALUE_FLAGS = /^(?:-[ABCmgtfe]|--(?:glob|type|max-count|context|after-context|before-context|regexp|file))$/;
  function searchTarget(program, args) {
    const flags = [], rest = []; let pattern = '';
    for (let index = 0; index < args.length; index++) {
      const word = args[index];
      if (/^-pattern$/i.test(word)) { pattern = args[++index] ?? ''; continue; }
      if (/^-(?:path|literalpath)$/i.test(word)) { rest.push(args[++index] ?? ''); continue; }
      if (word === '-e' || word === '--regexp') { pattern = args[++index] ?? ''; continue; }
      if (VALUE_FLAGS.test(word)) { const value = args[++index]; if (/^-g|--glob|-t|--type/.test(word) && value) flags.push(value); continue; }
      if (/^(?:-|\/[a-z]$)/i.test(word)) { if (/^-[a-z]*i|--ignore-case/i.test(word)) flags.push('-i'); continue; }
      rest.push(word);
    }
    if (!pattern) pattern = rest.shift() ?? '';
    return { pattern, paths: rest, flags };
  }
  const firstOperand = args => { for (let index = 0; index < args.length; index++) { const word = args[index]; if (/^-(?:n|c|lines|tail|head|totalcount|first|last)$/i.test(word)) { index++; continue; } if (/^-(?:path|literalpath)$/i.test(word)) return args[index + 1] ?? ''; if (!/^-/.test(word)) return word; } return ''; };
  const short = (value, limit = 160) => { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > limit ? `${text.slice(0, limit - 1)}…` : text; };
  const GIT_TITLES = { status: 'Git durumu', diff: 'Git farkı', log: 'Git geçmişi', show: 'Commit görüntüleme', add: 'Git hazırlama', commit: 'Commit', push: 'Git push', pull: 'Git pull', fetch: 'Git fetch', checkout: 'Branch değiştirme', switch: 'Branch değiştirme', branch: "Git branch'leri", merge: 'Git merge', rebase: 'Git rebase', stash: 'Git stash', worktree: 'Git worktree', reset: 'Git reset', restore: 'Git geri alma', rm: 'Git dosya silme', 'cherry-pick': 'Cherry-pick', tag: 'Git etiketi' };
  const TITLES = { test: 'Testleri çalıştırma', build: 'Derleme', lint: 'Kod denetimi', search: 'Kodda arama', read: 'Dosya okuma', list: 'Dosya listeleme', write: 'Dosya yazma', install: 'Bağımlılık kurma', run: 'Uygulama çalıştırma', network: 'Ağ isteği', docker: 'Container komutu', shell: 'Terminal komutu', git: 'Git komutu', aiws: 'AIWS komutu' };
  const ACTIVITIES = { test: 'Testler çalışıyor', build: 'Derleniyor', lint: 'Kod denetleniyor', search: 'Kodda aranıyor', read: 'Dosya okunuyor', list: 'Dosyalar listeleniyor', write: 'Dosya yazılıyor', install: 'Bağımlılıklar kuruluyor', run: 'Uygulama çalıştırılıyor', network: 'Ağ isteği yapılıyor', docker: 'Container komutu çalışıyor', shell: 'Komut çalışıyor', git: 'Git komutu çalışıyor', aiws: 'AIWS komutu çalışıyor', files: 'Dosyalar düzenleniyor', agent: 'Alt agent çalışıyor', web: 'Web araştırılıyor' };
  /** What one real part of a command does. */
  function classify({ program, args, line, words }) {
    const sub = String(args[0] ?? '').toLowerCase(), second = String(args[1] ?? '').toLowerCase();
    const kindOfScript = name => /test|spec|e2e/i.test(name) ? 'test' : /build|compile|typecheck|tsc|bundle|package|dist/i.test(name) ? 'build' : /lint|format|prettier/i.test(name) ? 'lint' : /^(?:dev|start|serve|watch|preview)/i.test(name) ? 'run' : null;
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) {
      if (['ci', 'install', 'i', 'add', 'remove', 'uninstall', 'update', 'link'].includes(sub) || (program === 'yarn' && !sub)) return { kind: 'install' };
      const script = sub === 'run' || sub === 'run-script' ? second : sub;
      if (['t', 'tst'].includes(script)) return { kind: 'test' };
      const kind = kindOfScript(script); if (kind) return { kind };
      return { kind: sub === 'run' ? 'run' : 'shell' };
    }
    if (['vitest', 'jest', 'pytest', 'mocha', 'ava', 'rspec', 'phpunit', 'ctest', 'tox', 'nox', 'karma', 'vstest'].includes(program)) {
      const testPaths = args.filter(arg => !arg.startsWith('-') && /[\\/]|\.(?:test|spec)\b/i.test(arg));
      const subject = line.length > 90 && testPaths.length >= 2 ? `${program} ${testPaths.map(baseName).join(' · ')}` : '';
      return { kind: 'test', ...(subject ? { subject } : {}) };
    }
    if (['detox', 'maestro', 'playwright', 'cypress'].includes(program) && ['test', 'run'].includes(sub)) return { kind: 'test' };
    if (['go', 'cargo', 'dotnet', 'deno', 'flutter', 'swift', 'mvn', 'mvnw', 'xcodebuild'].includes(program) && args.includes('test')) return { kind: 'test' };
    if (/^gradlew?$/.test(program)) return { kind: args.some(arg => /test/i.test(arg)) ? 'test' : args.some(arg => /assemble|build|bundle|install/i.test(arg)) ? 'build' : 'shell' };
    if (program === 'ng') return { kind: ['t', 'test', 'e', 'e2e'].includes(sub) ? 'test' : ['b', 'build'].includes(sub) ? 'build' : sub === 'lint' ? 'lint' : ['s', 'serve'].includes(sub) ? 'run' : 'shell' };
    if (program === 'nx') { const target = args.join(' '); return { kind: /\b(?:test|e2e)\b/.test(target) ? 'test' : /\bbuild\b/.test(target) ? 'build' : /\blint\b/.test(target) ? 'lint' : /\bserve\b/.test(target) ? 'run' : 'shell' }; }
    if (['tsc', 'webpack', 'rollup', 'esbuild', 'msbuild', 'make', 'ninja', 'electron-builder', 'electron-packager', 'electron-rebuild', 'xcodebuild'].includes(program)) return { kind: 'build' };
    if (['vite', 'next', 'nuxt', 'electron-vite'].includes(program)) return { kind: sub === 'build' ? 'build' : 'run' };
    if (program === 'cmake' && args.includes('--build')) return { kind: 'build' };
    if (['go', 'cargo', 'swift', 'flutter'].includes(program) && ['build', 'check'].includes(sub)) return { kind: 'build' };
    if (program === 'dotnet' && ['build', 'publish', 'pack', 'msbuild'].includes(sub)) return { kind: 'build' };
    if (['mvn', 'mvnw'].includes(program)) return { kind: 'build' };
    if (['eslint', 'prettier', 'ruff', 'black', 'flake8', 'mypy', 'stylelint', 'biome'].includes(program) || (program === 'dotnet' && sub === 'format') || (program === 'cargo' && ['clippy', 'fmt'].includes(sub)) || (program === 'go' && ['vet', 'fmt'].includes(sub))) return { kind: 'lint' };
    if (['rg', 'grep', 'egrep', 'fgrep', 'ag', 'ack', 'findstr', 'select-string', 'sls'].includes(program)) return { kind: 'search', search: searchTarget(program, args) };
    if (program === 'git' && sub === 'grep') return { kind: 'search', search: searchTarget(program, args.slice(1)) };
    if (program === 'sed' && args.some(arg => /^-i/.test(arg))) return { kind: 'write' };
    if (/(?:^|\s)>>?\s*[^\s&]/.test(line.replace(/"[^"]*"|'[^']*'/g, '""')) && !/2>/.test(line)) return { kind: 'write' };
    if (['cat', 'type', 'gc', 'get-content', 'head', 'tail', 'less', 'more', 'bat', 'sed', 'read_file'].includes(program)) { const operand = program === 'sed' ? args.at(-1) : firstOperand(args); return { kind: 'read', path: operand, subject: program === 'sed' && args[1] ? `${operand} · ${args[1]}` : operand }; }
    if (['ls', 'dir', 'gci', 'get-childitem', 'find', 'fd', 'tree', 'wc', 'du', 'stat', 'test-path', 'pwd'].includes(program)) return { kind: 'list', subject: firstOperand(args) || line };
    if (['set-content', 'add-content', 'out-file', 'tee', 'new-item', 'cp', 'mv', 'rm', 'copy', 'move', 'del', 'rmdir', 'remove-item', 'copy-item', 'move-item', 'mkdir', 'md', 'touch', 'write_file'].includes(program)) return { kind: 'write' };
    if (program === 'git') { const title = GIT_TITLES[sub]; const message = sub === 'commit' ? args[args.findIndex(arg => /^(?:-[a-z]*m|--message)$/.test(arg)) + 1] : ''; return { kind: 'git', ...(title ? { title: t(title) } : {}), subject: sub === 'commit' && message && !/^-/.test(message) ? message : '', git: sub }; }
    if (program === 'gh') return { kind: 'git', title: `GitHub ${sub}`.trim() };
    if ((['pip', 'pip3', 'pod', 'bundle', 'apt', 'apt-get', 'brew', 'winget', 'choco', 'uv', 'poetry'].includes(program) && ['install', 'add', 'sync', 'update', 'upgrade'].includes(sub)) || (program === 'dotnet' && (sub === 'restore' || ['add', 'remove', 'tool'].includes(sub))) || (program === 'cargo' && sub === 'add') || (program === 'go' && (sub === 'get' || sub === 'mod'))) return { kind: 'install' };
    if (['node', 'python', 'python3', 'py', 'ruby', 'tsx', 'ts-node', 'electron', 'expo', 'php', 'perl'].includes(program) || (['dotnet', 'go', 'cargo', 'deno', 'flutter'].includes(program) && sub === 'run')) return { kind: 'run' };
    if (['curl', 'wget', 'invoke-webrequest', 'iwr', 'invoke-restmethod', 'irm', 'ssh', 'scp', 'rsync'].includes(program)) return { kind: 'network' };
    if (['docker', 'docker-compose', 'kubectl', 'helm', 'podman'].includes(program)) return { kind: 'docker' };
    if (program === 'aiws') {
      const action = `${sub === 'control' ? second : sub} ${sub === 'control' ? String(args[2] ?? '').toLowerCase() : second}`;
      const title = /^tasks message/.test(action) ? 'Göreve not ekleme' : /^complete/.test(action) ? 'Görevi tamamlama' : /^reply/.test(action) ? 'Yanıt gönderme' : /^session/.test(action) ? 'Oturum kaydı' : null;
      return { kind: 'aiws', ...(title ? { title: t(title) } : {}), subject: words.slice(1, 5).join(' ') };
    }
    return { kind: 'shell' };
  }
  const PRIORITY = ['test', 'build', 'lint', 'install', 'git', 'docker', 'network', 'aiws', 'run', 'write', 'search', 'read', 'list', 'shell'];
  /** What a command does: { kind, title, subject, line, program, args, commands, search?, path?, git? }. */
  function commandInsight(command) {
    const parts = commandParts(command).map(part => ({ ...part, ...classify(part) }));
    if (!parts.length) return { kind: 'shell', title: t(TITLES.shell), subject: short(command), line: String(command ?? '').trim(), program: '', args: [], commands: [] };
    const main = [...parts].sort((left, right) => PRIORITY.indexOf(left.kind) - PRIORITY.indexOf(right.kind))[0];
    const subject = (main.search && [main.search.pattern, ...main.search.paths].filter(Boolean).join(' · ')) || main.subject || main.line;
    return { kind: main.kind, title: main.title || t(TITLES[main.kind]), subject: short(subject), line: main.line, program: main.program, args: main.args, commands: parts.map(part => part.line), ...(main.search ? { search: main.search } : {}), ...(main.path ? { path: main.path } : {}), ...(main.git ? { git: main.git } : {}) };
  }
  /** The status line of a running tool. */
  const activityLabel = kind => t(ACTIVITIES[kind] || ACTIVITIES.shell);

  const COUNT_WORDS = { passed: 'passed', passing: 'passed', pass: 'passed', ok: 'passed', succeeded: 'passed', success: 'passed', failed: 'failed', failing: 'failed', fail: 'failed', failures: 'failed', errors: 'failed', error: 'failed', skipped: 'skipped', skip: 'skipped', ignored: 'skipped', pending: 'skipped', todo: 'skipped', flaky: 'flaky', total: 'total' };
  const SUITE_FILE_RE = /^\S+\.(?:[cm]?[jt]sx?|py|rs|go|cs|kt|java|swift)(?:\s+\([\d.]+\s*m?s\))?$/i;
  const FAILURE_PATTERNS = [
    /^\s*(?:×|✗|✘|✕)\s+(.+?)(?:\s+\(?[\d.]+\s*m?s\)?)?\s*$/gm,    // vitest, jest test lines
    /^\s*●\s+(.+?)\s*$/gm,                                        // jest bullet
    /^\s{2,}\?\s+([^\n]+?)(?:\s+\([\d.]+\s*m?s\))?\s*$/gm,        // jest on non-UTF8 Windows console (? instead of ✕)
    /^FAILED\s+(\S+(?:::\S+)*)/gm,                                // pytest
    /^\s*Failed\s+([\w.`+<>,\s()-]+?)\s+\[[^\]]*\]\s*$/gm,        // dotnet test
    /^\s*\d+\)\s+(\S+:\d+:\d+\s+›.+?)\s*$/gm,                     // playwright
    /^test\s+(\S+)\s+\.\.\.\s+FAILED/gm,                          // cargo
    /^\s*--- FAIL:\s+(\S+)/gm,                                    // go
    /^(?:[\w .]+?\([^)]*\)\s+)(.+?)\s+FAILED\s*$/gm,              // karma
    /^\s*([\w.$]+\s+>\s+[\w$ ()]+?)\s+FAILED\s*$/gm,              // gradle junit
    /^\s*\[Failed\]\s+(\S+)/gm,                                   // maestro
    /^\s*FAIL\s+(.+?)(?:\s+\([\d.]+\s*m?s\)|\s+\d+\s*ms)?\s*$/gm, // suite or fallback FAIL line
  ];
  const TEST_LINE_RE = /^\s*([✓✔√×✗✘✕○])\s+(.+?)(?:\s+\(?(\d+(?:\.\d+)?\s*m?s)\)?)?\s*$/m;
  const testLineStatus = mark => /[×✗✘✕]/.test(mark) ? 'failed' : mark === '○' ? 'skipped' : 'passed';
  /** Test results in an output: { passed, failed, skipped, total, duration, failures }, or null when it reports none. */
  function testSummary(raw) {
    const text = stripAnsi(raw), counts = {};
    const read = line => { let found = false; for (const match of line.matchAll(/(\d+)\s+(passed|passing|pass|succeeded|success|failed|failing|fail|failures|errors?|skipped|skip|ignored|pending|todo|flaky|total)\b/gi)) { const key = COUNT_WORDS[match[2].toLowerCase()]; counts[key] = (counts[key] || 0) + Number(match[1]); found = true; } return found; };
    let duration = '';
    const dotnet = [...text.matchAll(/(?:Passed|Failed)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)(?:,\s*Duration:\s*([^-\n]+))?/g)];
    if (dotnet.length) for (const match of dotnet) { counts.failed = (counts.failed || 0) + Number(match[1]); counts.passed = (counts.passed || 0) + Number(match[2]); counts.skipped = (counts.skipped || 0) + Number(match[3]); counts.total = (counts.total || 0) + Number(match[4]); duration = match[5]?.trim() || duration; }
    else {
      const karmaExec = [...text.matchAll(/Executed (\d+) of (\d+)([^\n]*)/g)].at(-1), karmaTotal = text.match(/^TOTAL:\s*(?:(\d+) FAILED,\s*)?(\d+) SUCCESS/m);
      if (karmaExec || karmaTotal) {
        const detail = karmaExec?.[3] || '', failed = Number(karmaTotal?.[1] ?? detail.match(/\((\d+) FAILED\)/)?.[1] ?? 0), done = Number(karmaExec?.[1] ?? 0);
        counts.failed = failed; counts.passed = karmaTotal ? Number(karmaTotal[2]) : Math.max(0, done - failed); counts.skipped = Number(detail.match(/skipped (\d+)/)?.[1] ?? 0); counts.total = Number(karmaExec?.[2] ?? counts.passed + counts.failed + counts.skipped);
        const seconds = detail.match(/\(([\d.]+) secs?/)?.[1]; if (seconds) duration = `${seconds} s`;
      } else {
        const tests = [...text.matchAll(/^\s*Tests:?\s+(.+)$/gm)].at(-1);
        if (tests) read(tests[1]);
        else {
          const pytest = [...text.matchAll(/^=+\s*(.*?\d+\s+\w+.*?)\s+in\s+([\d.]+s)[^=]*=+\s*$/gm)].at(-1);
          if (pytest) { read(pytest[1]); duration = pytest[2]; }
          else {
            const cargo = [...text.matchAll(/^test result: \w+\.\s*(.+)$/gm)];
            if (cargo.length) for (const match of cargo) read(match[1].replace(/;/g, ','));
            else {
              const gradle = text.match(/(\d+)\s+tests?\s+completed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/i);
              if (gradle) { counts.total = Number(gradle[1]); counts.failed = Number(gradle[2]); counts.skipped = Number(gradle[3] || 0); counts.passed = Math.max(0, counts.total - counts.failed - counts.skipped); }
              else {
                for (const match of text.matchAll(/^\s*(\d+\s+(?:passed|failed|flaky|skipped|passing|failing|pending))\b(?:\s+\(([^)]+)\))?\s*$/gm)) { read(match[1]); duration = match[2] || duration; }
                if (!Object.keys(counts).length) {
                  const plain = text.match(/Total tests:\s*(\d+)[\s\S]*?Passed:\s*(\d+)(?:[\s\S]*?Failed:\s*(\d+))?/);
                  if (plain) { counts.total = Number(plain[1]); counts.passed = Number(plain[2]); counts.failed = Number(plain[3] || 0); }
                  else {
                    const passed = (text.match(/^(?:ok\s+\S+|--- PASS:|\s*\[Passed\]\s+\S+|Test Case '-\[[^\]]+\]' passed|\s*[\w.$]+\s+>\s+[\w$ ()]+?\s+PASSED\s*$)/gm) || []).length;
                    const failed = (text.match(/^(?:FAIL\s+\S+\s+[\d.]+s|--- FAIL:|\s*\[Failed\]\s+\S+|Test Case '-\[[^\]]+\]' failed|\s*[\w.$]+\s+>\s+[\w$ ()]+?\s+FAILED\s*$)/gm) || []).length;
                    if (passed + failed) { counts.passed = passed; counts.failed = failed; }
                  }
                }
              }
            }
          }
        }
      }
    }
    if (!Object.keys(counts).length) return null;
    duration = duration || text.match(/^\s*(?:Duration|Time:?)\s+([\d.]+\s*m?s(?:\s*\(.*?\))?|[\d.]+\s*\w+)/m)?.[1]?.replace(/\s*\(.*$/, '') || '';
    const failures = [], suiteFailures = [];
    for (const pattern of FAILURE_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const name = match[1].trim();
        if (!name) continue;
        if (SUITE_FILE_RE.test(name) && !/\s+[>›]\s+/.test(name)) {
          if (!suiteFailures.includes(name)) suiteFailures.push(name);
          continue;
        }
        if (!failures.includes(name) && failures.length < 40) failures.push(name);
      }
    }
    const finalFailures = failures.length ? failures : suiteFailures;
    const passed = counts.passed || 0, failed = counts.failed || 0, skipped = counts.skipped || 0;
    return { passed, failed, skipped, total: counts.total || passed + failed + skipped, duration, failures: failed ? finalFailures : [] };
  }

  /** Expected vs actual values and file:line location inside an assertion failure block. */
  function assertionDetail(message = '', stack = '') {
    let expected, actual;
    const jestDiff = message.match(/-\s*Expected\b[^\n]*\n\s*\+\s*Received\b[^\n]*\n+([\s\S]*?)(?=\n\s*\n|\n\s*(?:>?\s*\d+\s*\||at\s+)|$)/i);
    if (jestDiff) {
      const expLines = [], actLines = [];
      for (const rawLine of jestDiff[1].split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        if (/^-\s/.test(trimmed)) expLines.push(trimmed.slice(1).trim());
        else if (/^\+\s/.test(trimmed)) actLines.push(trimmed.slice(1).trim());
        else { expLines.push(trimmed); actLines.push(trimmed); }
      }
      if (expLines.length && actLines.length) {
        expected = expLines.join(' ').replace(/\s+/g, ' ');
        actual = actLines.join(' ').replace(/\s+/g, ' ');
      }
    }
    if (expected === undefined) {
      const jasmine = message.match(/Expected\s+(.+?)\s+to\s+(?:equal|be|toBe|toEqual|match)\s+(.+?)\.?$/im);
      const pair = message.match(/Expected:\s*([^\n]+)\n\s*(?:Actual|Received|But was):\s*([^\n]+)/i)
        || message.match(/expected:<([^>]+)>\s*but was:<([^>]+)>/i)
        || message.match(/XCTAssertEqual failed:\s*\("([^"]*)"\)\s*is not equal to\s*\("([^"]*)"\)/i)
        || message.match(/Assert\.AreEqual failed\.\s*Expected:<([^>]*)>\.\s*Actual:<([^>]*)>/i);
      expected = pair ? pair[1].trim() : jasmine ? jasmine[2].trim() : undefined;
      actual = pair ? pair[2].trim() : jasmine ? jasmine[1].trim() : undefined;
    }
    const combined = `${stack}\n${message}`;
    const at = combined.match(/ in ([^\n]+?):line (\d+)/)?.slice(1, 3).join(':')
      || combined.match(/\(([^\s():]+\.(?:[cm]?[jt]sx?|cs|kt|java|swift|py|rs|go)):(\d+)(?::(\d+))?\)/)?.slice(1).filter(Boolean).join(':')
      || combined.match(/^\s*(?:at|❯)\s+([^\s():]+\.(?:[cm]?[jt]sx?|cs|kt|java|swift|py|rs|go)):(\d+)(?::(\d+))?/m)?.slice(1).filter(Boolean).join(':')
      || combined.match(/((?:\/?[A-Za-z]:)?[^\s():]+\.(?:swift|kt|java|cs|ts|tsx|js)):(\d+):/)?.slice(1, 3).join(':') || '';
    return { ...(expected !== undefined && actual !== undefined ? { expected, actual } : {}), ...(at ? { at } : {}) };
  }
  /** Splits a qualified test name into its suite/class and short test case name. */
  function splitTestName(fullName, defaultSuite = '') {
    const raw = String(fullName || '').trim();
    const segments = raw.split(/\s+[›>]\s+/);
    if (segments.length > 1 && SUITE_FILE_RE.test(segments[0])) return { suite: baseName(segments[0]), name: segments.slice(1).join(' › ') };
    if (raw.includes(' › ')) { const parts = raw.split(/\s+›\s+/); return { suite: parts.slice(0, -1).join(' › '), name: parts.at(-1) }; }
    if (raw.includes(' > ')) { const parts = raw.split(/\s+>\s+/); return { suite: parts.slice(0, -1).join(' > '), name: parts.at(-1) }; }
    if (raw.includes('::')) { const parts = raw.split('::'); return { suite: parts.slice(0, -1).join('::'), name: parts.at(-1) }; }
    const prefix = raw.replace(/\(.*$/, '').trim(), dot = prefix.lastIndexOf('.');
    if (dot > 0 && !/[\s\\/]/.test(prefix.slice(0, dot)) && !/^(?:tsx?|jsx?|mjs|cjs|spec|test)$/i.test(prefix.slice(dot + 1))) return { suite: prefix.slice(0, dot), name: raw.slice(dot + 1) };
    const karmaSuite = raw.match(/^([A-Z][\w$]*(?:Component|Service|Directive|Pipe|Guard|Interceptor|Controller|Resolver|Store|Effects|Module|Spec|Test))\s+(.+)$/);
    if (karmaSuite) return { suite: karmaSuite[1], name: karmaSuite[2] };
    return { suite: defaultSuite, name: raw };
  }
  /** Full IDE test runner model: summary counts, pass rate, environment, project assemblies and hierarchical suites with test cases. */
  function testReport(raw) {
    const text = stripAnsi(raw), summary = testSummary(text);
    if (!summary) return null;
    const projects = [...text.matchAll(/(Passed|Failed)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)(?:,\s*Duration:\s*([^-\n]+?))?\s*(?:-\s*(\S+?)(?:\.dll)?\s*(?:\(([^)]+)\))?)?\s*$/gm)].map(match => ({ ok: match[1] === 'Passed', failed: Number(match[2]), passed: Number(match[3]), skipped: Number(match[4]), total: Number(match[5]), duration: match[6]?.trim() || '', name: match[7] || '', framework: match[8] || '' }));
    const browser = text.match(/^(\w[\w ]*?\d[\d.]*)\s*(?:\([^)]*\))\s*(?:ERROR|Executed|LOG|\S.*FAILED)/m)?.[1] || '';
    const environment = browser || projects.find(project => project.framework)?.framework || '';
    const suiteHeaders = new Map();
    // Walks Jest's per-file tree: which file and describe blocks each test line and failure block belongs to.
    const owners = new Map(), treeCases = [], otherLines = [], stack = [];
    let currentFile = '';
    for (const line of text.split('\n')) {
      const header = line.match(/^\s*(PASS|FAIL)\s+(\S+\.(?:[cm]?[jt]sx?|py|rs|go|cs|kt|java|swift))(?:\s+\(([\d.]+\s*m?s)\))?\s*$/);
      if (header) {
        currentFile = baseName(header[2]); stack.length = 0;
        suiteHeaders.set(currentFile, { name: currentFile, path: header[2], ok: header[1] === 'PASS', duration: header[3] || '' });
        otherLines.push(line); continue;
      }
      if (/^\s*(?:Test Suites:|Tests:|Ran all test suites|Summary of all failing tests)/.test(line)) currentFile = '';
      if (!currentFile || !line.trim()) { otherLines.push(line); continue; }
      const bullet = line.match(/^\s*●\s+(.+?)\s*$/);
      if (bullet) { owners.set(bullet[1], `${currentFile} › ${bullet[1]}`); otherLines.push(line); continue; }
      const indent = line.match(/^\s*/)[0].length;
      while (stack.length && stack.at(-1).indent >= indent) stack.pop();
      const mark = line.match(TEST_LINE_RE);
      if (mark) {
        const qualified = [...stack.map(item => item.name), mark[2].trim()].join(' › '), fullName = `${currentFile} › ${qualified}`;
        owners.set(qualified, fullName); owners.set(mark[2].trim(), fullName);
        treeCases.push({ fullName, status: testLineStatus(mark[1]), ...(mark[3] ? { duration: mark[3] } : {}) });
      } else if (indent) stack.push({ indent, name: line.trim() });
    }
    // Vitest's default reporter names no tests but gives each file real counts.
    for (const match of text.matchAll(/^\s*[✓✔√×✗✘✕❯○↓]\s+(\S+\.(?:[cm]?[jt]sx?))\s+\((\d+) tests?((?:\s*\|\s*\d+ \w+)*)\)(?:\s+([\d.]+\s*m?s))?\s*$/gm)) {
      const name = baseName(match[1]), count = word => Number(match[3].match(new RegExp(`(\\d+) ${word}`))?.[1] || 0), failed = count('failed'), skipped = count('skipped');
      suiteHeaders.set(name, { name, path: match[1], ok: !failed, duration: match[4] || '', counts: { failed, skipped, passed: Math.max(0, Number(match[2]) - failed - skipped) } });
    }
    // A Jest filter names what was asked for, which may be only part of a file name; a real file row answers for it.
    const reportedFiles = [...suiteHeaders.keys()];
    for (const path of text.match(/Ran all test suites matching ([^\n]+?)\.?$/m)?.[1]?.split('|').map(item => item.trim()).filter(Boolean) || []) {
      const name = baseName(path);
      if (!reportedFiles.some(file => file.includes(name))) suiteHeaders.set(name, { name, path, ok: summary.failed ? null : true, duration: '' });
    }
    const casesByFull = new Map();
    const recordCase = (fullName, patch) => {
      const key = String(fullName || '').trim(); if (!key || casesByFull.size >= 500) return;
      const existing = casesByFull.get(key) || { fullName: key, status: 'passed', duration: '', message: '', stack: '' };
      casesByFull.set(key, { ...existing, ...patch, fullName: key });
    };
    const parseJsFailureBody = (name, body, suiteHint = '') => {
      const lines = body.trimEnd().split('\n'), stackStart = lines.findIndex(line => /^\s+(?:at|❯)\s+/.test(line));
      const rawMessage = (stackStart >= 0 ? lines.slice(0, stackStart) : lines).map(line => line.replace(/^\s{2,4}/, '')).join('\n').trim();
      const stack = stackStart >= 0 ? lines.slice(stackStart).map(line => line.trim()).join('\n').trim() : '';
      const detail = assertionDetail(rawMessage, stack);
      const cleanMessage = detail.expected !== undefined ? rawMessage.replace(/\n*-\s*Expected\b[\s\S]*?(?=\n\s*\n|\n\s*>?\s*\d+\s*\||$)/i, '').trim() : rawMessage;
      const qualified = owners.get(name) || (suiteHint && !/\s+[>›]\s+/.test(name) ? `${suiteHint} › ${name}` : name);
      recordCase(qualified, { status: 'failed', message: cleanMessage, stack, ...detail });
    };
    // 1. Detailed failure blocks (.NET VSTest, Jest/Vitest, Karma/Jasmine, Gradle/JUnit, Xcode/XCTest, Maestro).
    for (const match of text.matchAll(/^\s*Failed\s+(.+?)\s+\[([^\]]*)\]\s*\n([\s\S]*?)(?=^\s*(?:(?:Failed|Passed|Skipped)\s+.+?\s+\[[^\]]*\]\s*$|Passed!|Failed!|Test Run|Total tests)|(?![\s\S]))/gm)) {
      const message = match[3].match(/Error Message:\s*\n([\s\S]*?)(?:\n\s*(?:Stack Trace|Standard Output Messages):|$)/)?.[1]?.trim() || '';
      const stack = match[3].match(/Stack Trace:\s*\n([\s\S]*?)(?:\n\s*Standard Output Messages:|$)/)?.[1]?.trim() || '';
      recordCase(match[1], { status: 'failed', duration: match[2].trim(), message, stack, ...assertionDetail(message, stack) });
    }
    for (const match of text.matchAll(/^\s*FAIL\s+(\S+\.(?:[cm]?[jt]sx?))(?:\s+\(([\d.]+\s*m?s)\))?\s*\n\s{2,}(?:[×✗✘✕●]|\?(?=\s+\S))\s+([^\n]+?)\s*\n\n([\s\S]*?)(?=^\s*(?:FAIL|PASS|●|Test Suites:)|(?![\s\S]))/gm)) {
      parseJsFailureBody(match[3].trim(), match[4], baseName(match[1]));
    }
    for (const match of text.matchAll(/^\s*●\s+(.+?)\s*\n\n([\s\S]*?)(?=^\s*●\s+|\n\s*Test Suites:|\n\s*Ran all test suites|(?![\s\S]))/gm)) {
      const failedHeader = [...suiteHeaders.values()].find(item => !item.ok);
      parseJsFailureBody(match[1].trim(), match[2], failedHeader?.name || '');
    }
    for (const match of text.matchAll(/^\s*FAIL\s+(.+?\s+>\s+.+?)\s*\n([\s\S]*?)(?=^\s*(?:FAIL\s+|⎯{3,}|Test Files\b)|(?![\s\S]))/gm)) {
      parseJsFailureBody(match[1].trim(), match[2]);
    }
    for (const match of text.matchAll(/^(?:[\w .]+?\([^)]*\)\s+)(.+?)\s+FAILED\s*\n((?:[ \t]+[^\n]+\n?)*)/gm)) {
      const lines = match[2].split('\n').map(line => line.trim()).filter(Boolean), stackStart = lines.findIndex(line => /^at\s+|<Jasmine>/.test(line));
      const message = (stackStart >= 0 ? lines.slice(0, stackStart) : lines).join('\n'), stack = stackStart >= 0 ? lines.slice(stackStart).join('\n') : '';
      recordCase(match[1], { status: 'failed', message, stack, ...assertionDetail(message, stack) });
    }
    for (const match of text.matchAll(/^\s*([\w.$]+\s+>\s+[\w$ ()]+?)\s+FAILED\s*\n((?:[ \t]+[^\n]+\n?)*)/gm)) {
      const lines = match[2].split('\n').map(line => line.trim()).filter(Boolean), stackStart = lines.findIndex(line => /^at\s+/.test(line));
      const message = (stackStart >= 0 ? lines.slice(0, stackStart) : lines).join('\n'), stack = stackStart >= 0 ? lines.slice(stackStart).join('\n') : '';
      recordCase(match[1], { status: 'failed', message, stack, ...assertionDetail(message, stack) });
    }
    for (const match of text.matchAll(/^((?:\/?[A-Za-z]:)?[^\s():]+\.swift):(\d+):\s*error:\s*-\[([^\s\]]+)\s+([^\]]+)\]\s*:\s*(.+)$/gm)) {
      const fullName = `${match[3]}.${match[4]}`, message = match[5].trim(), at = `${match[1]}:${match[2]}`;
      recordCase(fullName, { status: 'failed', message, at, ...assertionDetail(message, '') });
    }
    // 2. Individual test case lines (Passed / Failed / Skipped).
    for (const match of text.matchAll(/^\s*(Passed|Failed|Skipped)\s+([\w.`+<>,:\s()-]+?)\s+\[([^\]]+)\]\s*$/gm)) {
      const status = match[1].toLowerCase(); recordCase(match[2], { status, duration: match[3].trim() });
    }
    for (const match of text.matchAll(/^\s*([\w.$]+\s+>\s+[\w$ ()]+?)\s+(PASSED|FAILED|SKIPPED)(?:\s+\(([\d.]+\s*m?s)\))?\s*$/gm)) {
      recordCase(match[1], { status: match[2].toLowerCase(), ...(match[3] ? { duration: match[3] } : {}) });
    }
    for (const match of text.matchAll(/Test Case '-\[([^\s\]]+)\s+([^\]]+)\]' (passed|failed|skipped) \(([\d.]+) seconds\)/gm)) {
      recordCase(`${match[1]}.${match[2]}`, { status: match[3].toLowerCase(), duration: `${(Number(match[4]) * 1000).toFixed(0)} ms` });
    }
    for (const match of text.matchAll(/^\s*\[(Passed|Failed|Skipped)\]\s+(\S+?)(?:\s+\(([\d.]+\s*\w+)\))?(?:\s*-\s*(.+))?$/gm)) {
      recordCase(match[2], { status: match[1].toLowerCase(), ...(match[3] ? { duration: match[3] } : {}), ...(match[4] ? { message: match[4].trim() } : {}) });
    }
    const activeFailedSuite = [...suiteHeaders.values()].find(item => !item.ok)?.name || '';
    for (const { fullName, ...patch } of treeCases) recordCase(fullName, patch);
    for (const match of otherLines.join('\n').matchAll(new RegExp(TEST_LINE_RE, 'gm'))) {
      const textLine = match[2].trim();
      if (/^\d+\s+problems?\b|^nx run\b|^(?:Packaging|Making|Preparing|Rebuilding|Building|Compiled)\b/i.test(textLine) || SUITE_FILE_RE.test(textLine) || /^\S+\s+\(\d+ tests?\b/.test(textLine)) continue;
      const status = testLineStatus(match[1]);
      const qualified = status === 'failed' && activeFailedSuite && !/\s+[>›]\s+/.test(textLine) ? `${activeFailedSuite} › ${textLine}` : textLine;
      recordCase(qualified, { status, ...(match[3] ? { duration: match[3] } : {}) });
    }
    for (const name of summary.failures) {
      const qualified = owners.get(name) || (activeFailedSuite && !/\s+[>›]\s+/.test(name) && !SUITE_FILE_RE.test(name) ? `${activeFailedSuite} › ${name}` : name);
      if (!casesByFull.has(qualified) && !casesByFull.has(name)) recordCase(qualified, { status: 'failed' });
    }
    // 3. Group cases into suites.
    const defaultSuite = activeFailedSuite || projects[0]?.name || browser || t('Testler');
    const suitesByName = new Map();
    const suiteOf = (name, target = '') => {
      const key = name || defaultSuite; let suite = suitesByName.get(key);
      if (!suite) {
        const header = suiteHeaders.get(key);
        suite = { name: key, target: target || environment, passed: 0, failed: 0, skipped: 0, total: 0, duration: header?.duration || '', ok: header?.ok ?? null, unlistedPassed: 0, cases: [] };
        suitesByName.set(key, suite);
      }
      return suite;
    };
    for (const item of casesByFull.values()) {
      const { suite: suiteName, name } = splitTestName(item.fullName, defaultSuite);
      const project = projects.find(entry => entry.name && suiteName.startsWith(entry.name)) || projects[0];
      const suite = suiteOf(suiteName, project?.framework || browser);
      if (project?.duration && !suite.duration) suite.duration = project.duration;
      suite.cases.push({ ...item, name });
      if (item.status === 'failed') suite.failed++; else if (item.status === 'skipped') suite.skipped++; else suite.passed++;
    }
    for (const header of suiteHeaders.values()) if (!suitesByName.has(header.name)) suiteOf(header.name);
    if (!suitesByName.size && projects.length) for (const project of projects) { const suite = suiteOf(project.name || defaultSuite, project.framework); suite.passed = project.passed; suite.failed = project.failed; suite.skipped = project.skipped; suite.total = project.total; suite.duration = project.duration; suite.unlistedPassed = project.passed; }
    else if (!suitesByName.size) { const suite = suiteOf(defaultSuite, environment); suite.passed = summary.passed; suite.failed = summary.failed; suite.skipped = summary.skipped; suite.total = summary.total; suite.duration = summary.duration; suite.unlistedPassed = summary.passed; }
    else {
      for (const suite of suitesByName.values()) {
        const counts = suiteHeaders.get(suite.name)?.counts; if (!counts) continue;
        suite.failed = Math.max(suite.failed, counts.failed); suite.skipped = Math.max(suite.skipped, counts.skipped);
        if (counts.passed > suite.passed) { suite.unlistedPassed += counts.passed - suite.passed; suite.passed = counts.passed; }
      }
      // Passes the output does not attribute go to a suite only when there is a single one; several suites keep unknown counts rather than an invented split.
      const remaining = summary.passed - [...suitesByName.values()].reduce((sum, suite) => sum + suite.passed, 0);
      if (remaining > 0 && suitesByName.size === 1) { const [suite] = suitesByName.values(); suite.unlistedPassed += remaining; suite.passed += remaining; }
      for (const suite of suitesByName.values()) { suite.total = suite.passed + suite.failed + suite.skipped; if (!suite.duration && suitesByName.size === 1) suite.duration = summary.duration; }
    }
    const suites = [...suitesByName.values()].sort((left, right) => (right.failed - left.failed) || left.name.localeCompare(right.name));
    const executed = summary.passed + summary.failed;
    const denom = summary.skipped > executed * 2 && executed > 0 ? executed : summary.total || executed;
    const passRate = denom ? Math.round((summary.passed / denom) * 100) : summary.passed ? 100 : 0;
    return { ...summary, passRate, environment, projects, suites };
  }

  const DIAGNOSTIC_PATTERNS = [
    /^\s*((?:[A-Za-z]:)?[^\s:(][^:(\n]*?)\((\d+)(?:,(\d+))?\)\s*:\s*(error|warning)\s*([A-Z]+\d+)?\s*:?\s*(.*?)(?:\s+\[[^\]\n]+\])?\s*$/gim,   // msbuild, older tsc
    /^\s*((?:[A-Za-z]:)?[^\s:][^:\n]*?):(\d+)(?::(\d+))?\s*(?:-|:)?\s*(error|warning)\s*:?\s*([A-Z]+\d+)?\s*:?\s*(.*?)\s*$/gim,                 // tsc --pretty, gcc, clang
    /^\s*([ew]):\s*(?:file:\/\/)?((?:\/?[A-Za-z]:)?[^\s:][^:\n]*?):(\d+)(?::(\d+))?\s+(.*?)\s*$/gm,                                              // kotlinc
  ];
  /** Compiler errors and warnings in an output, each once: { errors, warnings, items: [{ severity, file, line, column, code, message }] }. */
  function diagnostics(raw) {
    const text = stripAnsi(raw), seen = new Set(), items = [];
    const add = (severity, source, line, column, code, message) => { const file = String(source).replace(/^\/(?=[A-Za-z]:)/, ''), key = `${severity}|${file}|${line}|${column}|${code}|${message}`; if (seen.has(key) || items.length >= 200) return; seen.add(key); items.push({ severity, file: String(file).trim(), line: Number(line), ...(column ? { column: Number(column) } : {}), ...(code ? { code } : {}), message: String(message).trim() }); };
    for (const match of text.matchAll(DIAGNOSTIC_PATTERNS[0])) add(match[4].toLowerCase(), match[1], match[2], match[3], match[5], match[6]);
    for (const match of text.matchAll(DIAGNOSTIC_PATTERNS[1])) add(match[4].toLowerCase(), match[1], match[2], match[3], match[5], match[6]);
    for (const match of text.matchAll(DIAGNOSTIC_PATTERNS[2])) add(match[1] === 'e' ? 'error' : 'warning', match[2], match[3], match[4], '', match[5]);
    items.sort((left, right) => (left.severity === right.severity ? 0 : left.severity === 'error' ? -1 : 1));
    return { errors: items.filter(item => item.severity === 'error').length, warnings: items.filter(item => item.severity === 'warning').length, items };
  }
  /** Matches of a search tool's output grouped by file: { files: [{ path, matches: [{ line, text }], count }], matches, empty, truncated }. */
  function searchResults(raw) {
    const files = new Map(); let total = 0, truncated = false;
    const fileOf = path => { let file = files.get(path); if (!file) { file = { path, matches: [], count: 0 }; files.set(path, file); } return file; };
    for (const source of stripAnsi(raw).split('\n')) {
      const line = source.replace(/\s+$/, '');
      if (!line || line === '--') continue;
      if (/^(?:No (?:matches|files) found|Found \d+|\[Showing results|\[Omitted|\(Results are truncated)/i.test(line)) { if (/^\[Showing|truncated/i.test(line)) truncated = true; continue; }
      const match = line.match(/^((?:[A-Za-z]:)?[^:\n]+?):(\d+)(?::\d+)?[:-](.*)$/);
      if (match && /[\\/.]/.test(match[1])) { const file = fileOf(match[1]); if (file.matches.length < 50) file.matches.push({ line: Number(match[2]), text: match[3] }); file.count++; total++; continue; }
      const count = line.match(/^((?:[A-Za-z]:)?[^:\n]+?):(\d+)$/);
      if (count && /[\\/.]/.test(count[1])) { fileOf(count[1]).count += Number(count[2]); total += Number(count[2]); continue; }
      if (!/\s{2,}/.test(line) && /[\\/.]/.test(line) && line.length < 400 && !line.includes(': ')) { fileOf(line); continue; }
      const bare = line.match(/^(\d+)[:-](.*)$/);
      if (bare) { const file = fileOf(''); if (file.matches.length < 50) file.matches.push({ line: Number(bare[1]), text: bare[2] }); file.count++; total++; continue; }
    }
    return { files: [...files.values()], matches: total, empty: !files.size, truncated };
  }
  Object.assign(kit, { stripAnsi, baseName, flagValue, operands, shellFiles, sourceFiles, splitCommand, shellWords, commandInsight, activityLabel, testSummary, testReport, diagnostics, searchResults });
})(globalThis);
