import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';
import { backup, check, maintain, stats } from './dbtools.js';
import { spawnSync } from 'node:child_process';
import { addKeysNonInteractive, runSetupWizard, type SetupIO } from './setup.js';
import { installService, serviceStatus, uninstallService, systemdUnit, launchdPlist, windowsTaskCommand, type ServicePlatform, type ServiceSpec } from './service.js';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { runDoctor, symbol } from './doctor.js';
import { loadRegistry } from './registry.js';
import { checkRegistry } from './registry-check.js';
import { discover } from './registry-discover.js';
import { stringify } from 'yaml';
import { buildBundle, generateSigningKeys, signBundle } from './registry-sync.js';
import { TokenStore } from './tokens.js';

let storeInstance: TokenStore | undefined;
const getStore = () => (storeInstance ??= new TokenStore(openDatabase(resolve(process.env.POURGATE_DB ?? 'data/pourgate.db'))));
const [group, action, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  cli tokens create --name <name> [--rpm <n>] [--daily <n>] [--expires-days <n>]
  cli tokens list
  cli tokens revoke <id>
  cli registry bundle [--dir registry] --out <file> [--version <n>] [--sign <private.pem>]
  cli registry keygen --out-dir <dir>
  cli registry discover [--provider <name>] [--write]   (list/refresh the free models each provider advertises)
  cli registry check [--provider <name>]   (compare model ids with each provider's live /models list)
  cli setup [--provider <name> --key <key>]...
  cli service install | uninstall | status | print
  cli doctor [--live] [--url http://localhost:3000] [--token <token>]
  cli db stats | check | optimize
  cli db backup --out <file>`);
  process.exit(2);
}

const positiveInt = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${flag} must be a positive integer`);
    process.exit(2);
  }
  return n;
};

const dbPath = () => resolve(process.env.POURGATE_DB ?? 'data/pourgate.db');

const loadRegistryForCli = () => loadRegistry(resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry'));
const configFile = () => resolve(process.env.POURGATE_CONFIG_FILE ?? '.env');

/** Reads a line from the terminal without echoing it (shows * instead). */
function askSecret(question: string): Promise<string> {
  return new Promise((done) => {
    process.stdout.write(question);
    if (!process.stdin.isTTY) {
      // Piped input: read a whole line.
      const rl = createInterface({ input: process.stdin });
      rl.once('line', (l) => {
        rl.close();
        done(l.trim());
      });
      return;
    }
    let buf = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off('data', onData);
          process.stdout.write('\n');
          return done(buf.trim());
        }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') {
          if (buf.length) {
            buf = buf.slice(0, -1);
            process.stdout.write('\b \b');
          }
        } else {
          buf += c;
          process.stdout.write('*');
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

const serviceSpec = (): ServiceSpec => ({
  platform: process.platform as ServicePlatform,
  nodePath: process.execPath,
  launcher: resolve(process.env.POURGATE_APP_DIR ?? '.', 'bin', 'pourgate.mjs'),
  home: resolve(process.env.POURGATE_HOME ?? resolve(homedir(), '.pourgate')),
  userHome: homedir(),
});
const runCmd = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

if (group === 'setup') {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { provider: { type: 'string', multiple: true }, key: { type: 'string', multiple: true } } });
  const registry = loadRegistryForCli();
  if (values.provider?.length || values.key?.length) {
    if (!values.provider || !values.key || values.provider.length !== values.key.length) {
      console.error('Give --provider and --key in pairs, e.g. --provider groq --key gsk_...');
      process.exit(2);
    }
    try {
      const added = addKeysNonInteractive(configFile(), registry, values.provider.map((provider, i) => ({ provider, key: values.key![i]! })));
      for (const a of added) console.log(`+ ${a.provider}: key added to ${a.envName}`);
      console.log(`Saved to ${configFile()}. Restart the gateway to use them.`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else {
    const io: SetupIO = {
      ask: async (q) => {
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        const a = await rl.question(q);
        rl.close();
        return a.trim();
      },
      askSecret,
      print: (l) => console.log(l),
    };
    const res = await runSetupWizard({ configFile: configFile(), registry, io });
    console.log(`\nSaved to ${configFile()}${res.added.length ? ` (${res.added.length} key${res.added.length > 1 ? 's' : ''} added)` : ''}. Restart the gateway to apply changes.`);
    console.log('Next: "pourgate doctor --live" checks the keys, "pourgate start" runs the gateway.');
  }
} else if (group === 'service') {
  const spec = serviceSpec();
  if (action === 'install') {
    try {
      for (const step of installService(spec, runCmd)) console.log(step);
      console.log('PourGateLLM will now start automatically and restart if it crashes. Check it with: pourgate service status');
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    }
  } else if (action === 'uninstall') {
    const steps = uninstallService(spec, runCmd);
    console.log(steps.length ? steps.join('\n') : 'No service was installed.');
  } else if (action === 'status') {
    const st = serviceStatus(spec, runCmd);
    console.log(`${st.installed ? 'installed' : 'not installed'}, ${st.running ? 'running' : 'not running'} (${st.detail})`);
  } else if (action === 'print') {
    console.log(spec.platform === 'linux' ? systemdUnit(spec) : spec.platform === 'darwin' ? launchdPlist(spec) : windowsTaskCommand(spec));
  } else usage();
} else if (group === 'doctor') {
  const { values } = parseArgs({ args: process.argv.slice(3), options: { live: { type: 'boolean' }, url: { type: 'string' }, token: { type: 'string' } } });
  const checks = await runDoctor({
    env: process.env,
    dbPath: dbPath(),
    registryDir: resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry'),
    live: values.live,
    url: values.url,
    token: values.token,
  });
  for (const c of checks) console.log(`${symbol(c.level)} ${c.name.padEnd(18)} ${c.detail}`);
  const fails = checks.filter((c) => c.level === 'fail').length;
  const warns = checks.filter((c) => c.level === 'warn').length;
  console.log(fails ? `\n${fails} problem(s) to fix${warns ? `, ${warns} warning(s)` : ''}.` : warns ? `\nNo problems, ${warns} warning(s).` : '\nAll good.');
  process.exitCode = fails ? 1 : 0;
} else if (group === 'db') {
  const db = openDatabase(dbPath());
  if (action === 'stats') {
    const s = stats(db, dbPath());
    const kb = (n: number | null) => (n === null ? '-' : `${(n / 1024).toFixed(1)} KiB`);
    console.log(`schema v${s.schemaVersion}, file ${kb(s.fileBytes)}, wal ${kb(s.walBytes)}`);
    for (const [t, n] of Object.entries(s.tables)) console.log(`${t.padEnd(16)} ${n}`);
  } else if (action === 'check') {
    const r = check(db);
    console.log(r.ok ? 'ok' : `PROBLEMS FOUND: ${r.integrity.join('; ')} (foreign key violations: ${r.foreignKeyViolations})`);
    process.exitCode = r.ok ? 0 : 1;
  } else if (action === 'optimize') {
    maintain(db);
    console.log('Optimized and checkpointed.');
  } else if (action === 'backup') {
    const { values } = parseArgs({ args: rest, options: { out: { type: 'string' } } });
    if (!values.out) usage();
    try {
      backup(db, resolve(values.out));
      console.log(`Wrote ${values.out} (owner-only; it contains encrypted provider keys and token hashes, and needs the master key to be useful)`);
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
      process.exitCode = 1;
    }
  } else {
    usage();
  }
  db.close();
} else if (group === 'registry') {
  if (action === 'bundle') {
    const { values } = parseArgs({
      args: rest,
      options: { dir: { type: 'string' }, out: { type: 'string' }, version: { type: 'string' }, sign: { type: 'string' } },
    });
    if (!values.out) usage();
    const bundle = buildBundle(loadRegistry(resolve(values.dir ?? 'registry')), positiveInt(values.version, 'version'));
    mkdirSync(dirname(resolve(values.out)), { recursive: true });
    writeFileSync(values.out, bundle);
    console.log(`Wrote ${values.out}`);
    if (values.sign) {
      writeFileSync(`${values.out}.sig`, `${signBundle(bundle, readFileSync(resolve(values.sign), 'utf8'))}\n`);
      console.log(`Wrote ${values.out}.sig`);
    }
  } else if (action === 'discover') {
    const { values } = parseArgs({ args: rest, options: { provider: { type: 'string' }, write: { type: 'boolean' } } });
    const dir = resolve(process.env.POURGATE_REGISTRY_DIR ?? 'registry');
    for (const d of await discover({ only: values.provider })) {
      if (!d.entry) {
        console.log(`! ${d.source.provider}: ${d.error}`);
        continue;
      }
      console.log(`✓ ${d.source.provider}: ${d.entry.models.length} free models`);
      if (values.write) {
        const header = `# Generated by \`pourgate registry discover\`: the models ${d.source.provider} itself marks as free.\n# Limits are not published, so they are left empty and learned from the provider's own headers at runtime.\n# Re-run the command to refresh; \`registry check\` reports ids that disappear.\n`;
        writeFileSync(resolve(dir, `${d.source.provider}.yaml`), header + stringify(d.entry, { lineWidth: 0 }));
        console.log(`  wrote ${d.source.provider}.yaml`);
      }
    }
  } else if (action === 'check') {
    const { values } = parseArgs({ args: rest, options: { provider: { type: 'string' } } });
    const results = await checkRegistry(loadRegistryForCli(), { only: values.provider });
    for (const r of results) {
      const mark = { ok: '✓', stale: '✗', 'needs-key': '–', unreachable: '!' }[r.status];
      console.log(`${mark} ${r.provider}: ${r.status}${r.status === 'ok' ? ` (${r.checked} of ${r.listed} listed models checked)` : ''}${r.detail ? ` — ${r.detail}` : ''}`);
      for (const id of r.missing) console.log(`    no longer listed: ${id}`);
    }
    if (results.some((r) => r.status === 'stale')) process.exitCode = 1;
  } else if (action === 'keygen') {
    const { values } = parseArgs({ args: rest, options: { 'out-dir': { type: 'string' } } });
    if (!values['out-dir']) usage();
    const dir = resolve(values['out-dir']);
    mkdirSync(dir, { recursive: true });
    const { publicPem, privatePem } = generateSigningKeys();
    writeFileSync(resolve(dir, 'registry-private.pem'), privatePem, { mode: 0o600 });
    writeFileSync(resolve(dir, 'registry-public.pem'), publicPem);
    console.log(`Wrote ${dir}/registry-private.pem (keep secret) and registry-public.pem`);
  } else {
    usage();
  }
} else if (group !== 'tokens') {
  usage();
} else if (action === 'create') {
  const { values } = parseArgs({
    args: rest,
    options: {
      name: { type: 'string' },
      rpm: { type: 'string' },
      daily: { type: 'string' },
      'expires-days': { type: 'string' },
    },
  });
  if (!values.name) usage();
  const days = positiveInt(values['expires-days'], 'expires-days');
  const { token, record } = getStore().create({
    name: values.name,
    rpmLimit: positiveInt(values.rpm, 'rpm'),
    dailyRequestLimit: positiveInt(values.daily, 'daily'),
    expiresAt: days ? Date.now() + days * 86_400_000 : undefined,
  });
  console.log(`Created token #${record.id} (${record.name}). Store it now, it cannot be shown again:\n${token}`);
} else if (action === 'list') {
  for (const t of getStore().list()) {
    const status = t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt <= Date.now() ? 'expired' : 'active';
    const u = getStore().usageToday(t.id);
    console.log(
      `#${t.id}\t${t.name}\t${t.prefix}…\t${status}\trpm=${t.rpmLimit ?? '-'}\tdaily=${t.dailyRequestLimit ?? '-'}\ttoday: ${u.requests} req / ${u.tokens} tok`,
    );
  }
} else if (action === 'revoke') {
  const id = Number(rest[0]);
  if (!Number.isInteger(id)) usage();
  console.log(getStore().revoke(id) ? `Revoked token #${id}` : `Token #${id} not found or already revoked`);
} else {
  usage();
}
