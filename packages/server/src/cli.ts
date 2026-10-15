import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';
import { backup, check, maintain, stats } from './dbtools.js';
import { runDoctor, symbol } from './doctor.js';
import { loadRegistry } from './registry.js';
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

if (group === 'doctor') {
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
