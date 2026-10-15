import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVICE_NAME = 'pourgatellm';
export const LAUNCHD_LABEL = 'dev.pourgatellm.gateway';
export const WINDOWS_TASK = 'PourGateLLM';

export type ServicePlatform = 'linux' | 'darwin' | 'win32';

export interface ServiceSpec {
  platform: ServicePlatform;
  /** Absolute path of the Node.js binary. */
  nodePath: string;
  /** Absolute path of bin/pourgate.mjs. */
  launcher: string;
  /** PourGateLLM home (config, data, logs). */
  home: string;
  /** The user's home directory (where per-user service files live). */
  userHome: string;
}

export interface RunResult {
  code: number;
  out: string;
}
export type Runner = (cmd: string, args: string[]) => RunResult;

const systemdQuote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`;
const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function systemdUnit(s: ServiceSpec): string {
  return `[Unit]
Description=PourGateLLM gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=POURGATE_HOME=${systemdQuote(s.home)}
ExecStart=${systemdQuote(s.nodePath)} ${systemdQuote(s.launcher)} start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(s: ServiceSpec): string {
  const log = join(s.home, 'pourgate.log');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(s.nodePath)}</string><string>${xml(s.launcher)}</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>POURGATE_HOME</key><string>${xml(s.home)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`;
}

/** Command line run by the Windows scheduled task: hidden PowerShell that appends output to a log file. */
export function windowsTaskCommand(s: ServiceSpec): string {
  const log = join(s.home, 'pourgate.log');
  const inner = `$env:POURGATE_HOME=${psQuote(s.home)}; & ${psQuote(s.nodePath)} ${psQuote(s.launcher)} start *>> ${psQuote(log)}`;
  return `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "${inner.replace(/"/g, '\\"')}"`;
}

export function unitPath(s: ServiceSpec): string | undefined {
  if (s.platform === 'linux') return join(s.userHome, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
  if (s.platform === 'darwin') return join(s.userHome, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
  return undefined;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  detail: string;
}

/** Installs the per-user auto-start service (starts at login/boot, restarts on failure) and starts it now. */
export function installService(s: ServiceSpec, run: Runner): string[] {
  const steps: string[] = [];
  const must = (cmd: string, args: string[]) => {
    const r = run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.out.trim() || `exit ${r.code}`}`);
    steps.push(`${cmd} ${args.join(' ')}`);
  };
  mkdirSync(s.home, { recursive: true });
  if (s.platform === 'linux') {
    const path = unitPath(s)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, systemdUnit(s));
    steps.push(`wrote ${path}`);
    must('systemctl', ['--user', 'daemon-reload']);
    must('systemctl', ['--user', 'enable', '--now', SERVICE_NAME]);
    steps.push('To keep it running when you are logged out: loginctl enable-linger $USER');
  } else if (s.platform === 'darwin') {
    const path = unitPath(s)!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, launchdPlist(s));
    steps.push(`wrote ${path}`);
    run('launchctl', ['unload', '-w', path]); // ignore: may not be loaded yet
    must('launchctl', ['load', '-w', path]);
  } else {
    must('schtasks', ['/Create', '/TN', WINDOWS_TASK, '/SC', 'ONLOGON', '/TR', windowsTaskCommand(s), '/F']);
    must('schtasks', ['/Run', '/TN', WINDOWS_TASK]);
  }
  return steps;
}

export function uninstallService(s: ServiceSpec, run: Runner): string[] {
  const steps: string[] = [];
  if (s.platform === 'linux') {
    const path = unitPath(s)!;
    run('systemctl', ['--user', 'disable', '--now', SERVICE_NAME]);
    if (existsSync(path)) {
      rmSync(path);
      steps.push(`removed ${path}`);
    }
    run('systemctl', ['--user', 'daemon-reload']);
  } else if (s.platform === 'darwin') {
    const path = unitPath(s)!;
    run('launchctl', ['unload', '-w', path]);
    if (existsSync(path)) {
      rmSync(path);
      steps.push(`removed ${path}`);
    }
  } else {
    run('schtasks', ['/End', '/TN', WINDOWS_TASK]);
    const r = run('schtasks', ['/Delete', '/TN', WINDOWS_TASK, '/F']);
    if (r.code === 0) steps.push(`deleted scheduled task ${WINDOWS_TASK}`);
  }
  return steps;
}

export function serviceStatus(s: ServiceSpec, run: Runner): ServiceStatus {
  if (s.platform === 'linux') {
    const installed = existsSync(unitPath(s)!);
    const r = run('systemctl', ['--user', 'is-active', SERVICE_NAME]);
    return { installed, running: r.code === 0, detail: r.out.trim() || 'unknown' };
  }
  if (s.platform === 'darwin') {
    const installed = existsSync(unitPath(s)!);
    const r = run('launchctl', ['list', LAUNCHD_LABEL]);
    return { installed, running: r.code === 0, detail: r.code === 0 ? 'loaded' : 'not loaded' };
  }
  const r = run('schtasks', ['/Query', '/TN', WINDOWS_TASK]);
  return { installed: r.code === 0, running: /Running/i.test(r.out), detail: r.code === 0 ? (/Running/i.test(r.out) ? 'running' : 'registered') : 'not registered' };
}
