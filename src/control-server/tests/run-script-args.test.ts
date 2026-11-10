import { describe, expect, it } from 'vitest';
import { parsePowerShellParameters, scriptLine, splitScriptArgs } from '../run-scripts.js';

describe('run script arguments', () => {
  it('scans PowerShell param blocks into named typed values', () => {
    expect(parsePowerShellParameters(`param(
      [Parameter(Mandatory=$true)][string]$Environment,
      [string]$Server = 'build server',
      [switch]$Force,
      [int]$Count = 3
    )\nWrite-Output $Environment`)).toEqual([
      { name: 'Environment', type: 'string', switch: false, defaultValue: '' },
      { name: 'Server', type: 'string', switch: false, defaultValue: "'build server'" },
      { name: 'Force', type: 'switch', switch: true, defaultValue: '' },
      { name: 'Count', type: 'int', switch: false, defaultValue: '3' },
    ]);
  });
  it('shows PowerShell aliases and all declared parameters', () => {
    expect(parsePowerShellParameters(`param(
      # Ad çözülmezse güncel sunucu IP'sini -Ip ile verin.
      [Alias('Ip')]
      [string]$ServerHost = 'build-host',
      [string]$ServerUser = 'deploy',
      [string[]]$Only = @()
    )`)).toEqual([
      { name: 'Ip', type: 'string', switch: false, defaultValue: "'build-host'" },
      { name: 'ServerUser', type: 'string', switch: false, defaultValue: "'deploy'" },
      { name: 'Only', type: 'string[]', switch: false, defaultValue: '@()' },
    ]);
  });
  it('splits words and keeps quoted values together', () => {
    expect(splitScriptArgs('')).toEqual([]);
    expect(splitScriptArgs(`-Env prod --name "my app" 'a b' ""`)).toEqual(['-Env', 'prod', '--name', 'my app', 'a b', '']);
    expect(splitScriptArgs('say "he said \\"hi\\""')).toEqual(['say', 'he said "hi"']);
  });

  it('writes the line a script terminal types into its shell', () => {
    expect(scriptLine({ absolute: 'C:/r/a.ps1' }, '-X 1', 'win32')).toBe("powershell -ExecutionPolicy Bypass -File 'C:/r/a.ps1' '-X' '1'");
    expect(scriptLine({ absolute: 'C:/r/a.cmd' }, 'x', 'win32')).toBe("& 'C:/r/a.cmd' 'x'");
    expect(scriptLine({ absolute: '/r/a.sh' }, "'x y'", 'linux')).toBe("bash '/r/a.sh' 'x y'");
    expect(scriptLine({ absolute: 'C:/r/a.sh', bash: 'C:/Git/bash.exe' }, '', 'win32')).toBe("& 'C:/Git/bash.exe' 'C:/r/a.sh'");
    expect(scriptLine({ absolute: '/r/package.json', npmScript: 'build' }, `"it's"`, 'win32')).toBe("npm --prefix '/r' run 'build' -- 'it''s'");
    expect(scriptLine({ absolute: '/r/package.json', npmScript: 'build' }, '"a b"', 'linux')).toBe("npm --prefix '/r' run 'build' -- 'a b'");
  });

  it('appends argument lines to custom commands', () => {
    expect(scriptLine({ command: 'myapp dosomething' }, '--port 3000\n  --verbose ')).toBe('myapp dosomething --port 3000 --verbose');
  });
});

describe('ask-for-arguments flag', () => {
  it('is kept only when enabled', async () => {
    const { validateRunScripts } = await import('../run-scripts.js');
    const [a, b] = validateRunScripts([{ name: 'a', command: 'x', askArgs: true }, { name: 'b', command: 'y', askArgs: false }], process.cwd());
    expect(a).toMatchObject({ askArgs: true });
    expect(b).not.toHaveProperty('askArgs');
  });
});

describe('deleted script files', () => {
  it('keep a saved entry but reject a new one', async () => {
    const { validateRunScripts } = await import('../run-scripts.js');
    const previous = [{ id: 'script_old', name: 'gone', path: 'scripts/gone.ps1' }];
    expect(validateRunScripts([{ id: 'script_old', name: 'gone', path: 'scripts/gone.ps1' }], process.cwd(), previous)).toEqual(previous);
    expect(() => validateRunScripts([{ name: 'gone', path: 'scripts/gone.ps1' }], process.cwd(), previous)).toThrow('Script not found');
  });
});

describe('run script memory', () => {
  it('keeps the five most recent distinct argument sets, independent of field order', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const { ControlStore } = await import('../store.js'), { RunScriptMemory } = await import('../run-script-memory.js');
    const directory = mkdtempSync(join(tmpdir(), 'aiws-args-')), store = new ControlStore(directory), memory = new RunScriptMemory(store);
    try {
      const values = [{ Ip: '1.2.3.4', Force: false }, '--prod', '', '--staging', { Force: true, Ip: '1.2.3.4' }];
      expect(memory.save('p', 's', [values[0], { Force: false, Ip: '1.2.3.4' }, '--prod', '--prod', '', '', '--staging', values[4], '--sixth'])).toEqual(values);
      expect(memory.history('p', 's')).toEqual(values);
      expect(memory.save('p', 's', ['--staging', ...values])).toEqual(['--staging', ...values.filter(value => value !== '--staging')]);
      expect(memory.history('other-project', 's')).toEqual([]);
      expect(memory.history('p', 'other-script')).toEqual([]);
    } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps encrypted parameters in the database across restarts', async () => {
    const { mkdtempSync, readFileSync } = await import('node:fs'), { tmpdir } = await import('node:os'), { join } = await import('node:path');
    const { ControlStore } = await import('../store.js'), { RunScriptMemory } = await import('../run-script-memory.js');
    const directory = mkdtempSync(join(tmpdir(), 'aiws-args-'));
    let store = new ControlStore(directory);
    new RunScriptMemory(store).save('p', 's', ['-Token hunter2', { Ip: '1.2.3.4', Force: true }]);
    expect(store.getMeta('run-script-args.p.s')).not.toContain('hunter2');
    store.close(); store = new ControlStore(directory);
    expect(new RunScriptMemory(store).history('p', 's')).toEqual(['-Token hunter2', { Ip: '1.2.3.4', Force: true }]);
    expect(readFileSync(join(directory, 'control.db')).includes('hunter2')).toBe(false);
    new RunScriptMemory(store).save('p', 's', []);
    expect(store.getMeta('run-script-args.p.s')).toBeUndefined();
    store.close();
  });
});
