#!/usr/bin/env node
// Cross-platform launcher shipped in release bundles.
//   pourgate start            run the gateway (creates a config on first run)
//   pourgate tokens|db|registry ...   management commands (see the README)
//   pourgate doctor           check the installation (add --live to test provider keys)
//   pourgate uninstall        remove PourGateLLM (add --purge to delete your data too)
//   pourgate env              print the config file path
//   pourgate version | help
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.POURGATE_HOME || join(homedir(), '.pourgate');
const envFile = join(home, 'config.env');
const version = existsSync(join(appDir, 'VERSION')) ? readFileSync(join(appDir, 'VERSION'), 'utf8').trim() : 'unknown';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`PourGateLLM needs Node 22.13 or newer (found ${process.versions.node}).`);
  process.exit(1);
}

const [command = 'help', ...rest] = process.argv.slice(2);

if (command === 'help' || command === '--help' || command === '-h') {
  console.log(`PourGateLLM ${version}

  pourgate start                      run the gateway
  pourgate tokens create --name <n>   create a client token (also: list, revoke <id>)
  pourgate db stats|check|optimize    database tools; db backup --out <file>
  pourgate registry bundle|keygen     registry tools
  pourgate doctor [--live]            diagnose the installation; --live also tests every provider key
  pourgate uninstall [--purge] [--yes]  remove PourGateLLM; --purge also deletes data and config
  pourgate env                        print the config file to edit (provider keys, password)
  pourgate version

Data and config live in ${home} (override with POURGATE_HOME).`);
  process.exit(0);
}
if (command === 'version' || command === '--version') {
  console.log(version);
  process.exit(0);
}
if (command === 'env') {
  console.log(envFile);
  process.exit(0);
}

if (command === 'uninstall') {
  // Run a copy of the uninstaller from outside the folder it is about to delete.
  const win = process.platform === 'win32';
  const source = join(appDir, 'install', win ? 'uninstall.ps1' : 'uninstall.sh');
  if (!existsSync(source)) {
    console.error(`Uninstaller not found at ${source}. Download it from https://github.com/xX-VyrnCore-Xx/PourGateLLM/tree/main/install`);
    process.exit(1);
  }
  const copy = join(tmpdir(), `pourgate-uninstall-${process.pid}${win ? '.ps1' : '.sh'}`);
  copyFileSync(source, copy);
  const args = win ? rest.map((a) => (a === '--purge' ? '-Purge' : a === '--yes' || a === '-y' ? '-Yes' : a)) : rest;
  const run = win
    ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', copy, ...args], { stdio: 'inherit', env: { ...process.env, POURGATE_HOME: home } })
    : spawn('sh', [copy, ...args], { stdio: 'inherit', env: { ...process.env, POURGATE_HOME: home } });
  run.on('exit', (code) => {
    rmSync(copy, { force: true });
    process.exit(code ?? 1);
  });
} else {
mkdirSync(join(home, 'data'), { recursive: true });
if (!existsSync(envFile)) {
  const password = randomBytes(18).toString('base64url');
  const token = `pg-${randomBytes(24).toString('base64url')}`;
  writeFileSync(
    envFile,
    `# PourGateLLM configuration. Add provider keys, then restart. See the README for all options.\nPOURGATE_ADMIN_PASSWORD=${password}\nPOURGATE_TOKENS=${token}\nPORT=3000\n# GROQ_API_KEYS=\n# GEMINI_API_KEYS=\n# CEREBRAS_API_KEYS=\n# MISTRAL_API_KEYS=\n# OPENROUTER_API_KEYS=\n`,
    { mode: 0o600 },
  );
  console.log(`First run: created ${envFile}\n  dashboard password: ${password}\n  API token:          ${token}\n`);
}

const fileEnv = {};
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (!m || line.trim().startsWith('#')) continue;
  fileEnv[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
}

const env = {
  POURGATE_DB: join(home, 'data', 'pourgate.db'),
  POURGATE_STATIC_DIR: join(appDir, 'public'),
  POURGATE_REGISTRY_DIR: join(appDir, 'registry'),
  POURGATE_EVALS_FILE: join(appDir, 'evals', 'suite.json'),
  POURGATE_PLUGINS_DIR: join(home, 'plugins'),
  POURGATE_OVERRIDES_DIR: join(home, 'overrides'),
  ...fileEnv,
  ...process.env,
};

const [script, args] = command === 'start' ? ['index.js', rest] : ['cli.js', [command, ...rest]];
const child = spawn(process.execPath, ['--no-warnings', join(appDir, 'dist', script), ...args], { cwd: appDir, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
}
