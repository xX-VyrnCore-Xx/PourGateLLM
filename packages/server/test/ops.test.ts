import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderEntry } from '@pourgate/shared';
import { addKeyToList, parseEnv, setEnvValue, splitKeys, validateApiKey } from '../src/configfile.js';
import { addKeysNonInteractive, runSetupWizard } from '../src/setup.js';
import { installService, launchdPlist, serviceStatus, systemdUnit, uninstallService, unitPath, windowsTaskCommand, type ServiceSpec } from '../src/service.js';

let dir: string;
beforeEach(() => void (dir = mkdtempSync(join(tmpdir(), 'pg-ops-'))));
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('config file helpers', () => {
  it('parses values and ignores comments', () => {
    expect(parseEnv('# c\nA=1\n  B = "two" \n#C=3\nBAD LINE\n')).toEqual({ A: '1', B: 'two' });
  });

  it('replaces, activates or appends a setting and keeps the rest', () => {
    const base = '# header\nPORT=3000\n# GROQ_API_KEYS=\nOTHER=x\n';
    expect(setEnvValue(base, 'PORT', '4000')).toBe('# header\nPORT=4000\n# GROQ_API_KEYS=\nOTHER=x\n');
    expect(setEnvValue(base, 'GROQ_API_KEYS', 'k1')).toBe('# header\nPORT=3000\nGROQ_API_KEYS=k1\nOTHER=x\n');
    expect(setEnvValue(base, 'NEW', 'v')).toBe('# header\nPORT=3000\n# GROQ_API_KEYS=\nOTHER=x\nNEW=v\n');
    expect(setEnvValue('', 'A', '1')).toBe('A=1\n');
  });

  it('manages comma lists and validates keys', () => {
    expect(splitKeys(' a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(addKeyToList('a,b', 'c')).toBe('a,b,c');
    expect(addKeyToList('a,b', 'a')).toBe('a,b');
    expect(addKeyToList(undefined, 'x')).toBe('x');
    expect(validateApiKey('short')).toMatch(/8-500/);
    expect(validateApiKey('has space inside')).toMatch(/spaces/);
    expect(validateApiKey('gsk_goodkey123')).toBeUndefined();
  });
});

const registry = (names: string[]): ProviderEntry[] =>
  names.map((n) => ({ provider: n, base_url: `https://${n}.test/v1`, api_key_env: `${n.toUpperCase()}_API_KEYS`, auth: 'bearer', signup_url: `https://${n}.test/keys`, models: [{ id: 'm', capabilities: ['chat'], limits: {}, quirks: [] }] }));

describe('setup wizard', () => {
  it('collects keys, rejects bad ones, appends to existing lists and never prints keys', async () => {
    const file = join(dir, 'config.env');
    writeFileSync(file, 'POURGATE_ADMIN_PASSWORD=short\nGROQ_API_KEYS=gsk_existing_key\n');
    const answers = ['bad key', 'gsk_second_key1', '', '', 'a-much-longer-password-1'];
    const printed: string[] = [];
    const res = await runSetupWizard({
      configFile: file,
      registry: registry(['groq', 'gemini']),
      io: { ask: async () => '', askSecret: async () => answers.shift() ?? '', print: (l) => printed.push(l) },
    });
    const env = parseEnv(readFileSync(file, 'utf8'));
    expect(env.GROQ_API_KEYS).toBe('gsk_existing_key,gsk_second_key1');
    expect(env.GEMINI_API_KEYS).toBeUndefined();
    expect(env.POURGATE_ADMIN_PASSWORD).toBe('a-much-longer-password-1');
    expect(res.added).toEqual([{ provider: 'groq', envName: 'GROQ_API_KEYS' }]);
    expect(res.passwordChanged).toBe(true);
    expect(printed.join('\n')).not.toContain('gsk_second_key1');
    expect(printed.join('\n')).toContain('https://groq.test/keys');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);
  });

  it('adds keys non-interactively and rejects unknown providers', () => {
    const file = join(dir, 'config.env');
    const reg = registry(['groq']);
    addKeysNonInteractive(file, reg, [{ provider: 'groq', key: 'gsk_aaaaaaaa1' }, { provider: 'groq', key: 'gsk_bbbbbbbb2' }]);
    expect(parseEnv(readFileSync(file, 'utf8')).GROQ_API_KEYS).toBe('gsk_aaaaaaaa1,gsk_bbbbbbbb2');
    expect(() => addKeysNonInteractive(file, reg, [{ provider: 'nope', key: 'gsk_aaaaaaaa1' }])).toThrow(/unknown provider/);
    expect(() => addKeysNonInteractive(file, reg, [{ provider: 'groq', key: 'x' }])).toThrow(/8-500/);
  });
});

describe('auto-start service', () => {
  const spec = (platform: ServiceSpec['platform']): ServiceSpec => ({
    platform,
    nodePath: '/usr/bin/node',
    launcher: '/opt/pour gate/bin/pourgate.mjs',
    home: join(dir, 'home'),
    userHome: join(dir, 'user'),
  });

  it('generates a systemd unit, a launchd plist and a Windows task command', () => {
    const unit = systemdUnit(spec('linux'));
    expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/pour gate/bin/pourgate.mjs" start');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain(`Environment=POURGATE_HOME="${join(dir, 'home')}"`);
    const plist = launchdPlist({ ...spec('darwin'), launcher: '/a&b/pourgate.mjs' });
    expect(plist).toContain('<string>/a&amp;b/pourgate.mjs</string>');
    expect(plist).toContain('<key>KeepAlive</key><true/>');
    const win = windowsTaskCommand({ ...spec('win32'), nodePath: "C:\\Program Files\\nodejs\\node.exe" });
    expect(win).toContain('-WindowStyle Hidden');
    expect(win).toContain("& 'C:\\Program Files\\nodejs\\node.exe'");
  });

  it('installs and removes a Linux user service with the right commands', () => {
    const calls: string[] = [];
    const run = (cmd: string, args: string[]) => (calls.push(`${cmd} ${args.join(' ')}`), { code: 0, out: 'active' });
    const s = spec('linux');
    const steps = installService(s, run);
    expect(existsSync(unitPath(s)!)).toBe(true);
    expect(calls).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable --now pourgatellm']);
    expect(steps.join('\n')).toContain('enable-linger');
    expect(serviceStatus(s, run)).toMatchObject({ installed: true, running: true });
    calls.length = 0;
    uninstallService(s, run);
    expect(existsSync(unitPath(s)!)).toBe(false);
    expect(calls[0]).toBe('systemctl --user disable --now pourgatellm');
  });

  it('reports the failing command and uses schtasks on Windows', () => {
    const bad = () => ({ code: 1, out: 'Access denied' });
    expect(() => installService(spec('linux'), bad)).toThrow(/Access denied/);
    const calls: string[][] = [];
    installService(spec('win32'), (cmd, args) => (calls.push([cmd, ...args]), { code: 0, out: '' }));
    expect(calls[0]!.slice(0, 6)).toEqual(['schtasks', '/Create', '/TN', 'PourGateLLM', '/SC', 'ONLOGON']);
    expect(calls[1]).toEqual(['schtasks', '/Run', '/TN', 'PourGateLLM']);
  });
});
