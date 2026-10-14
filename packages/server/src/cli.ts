import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { openDatabase } from './db.js';
import { TokenStore } from './tokens.js';

const store = new TokenStore(openDatabase(resolve(process.env.POURGATE_DB ?? 'data/pourgate.db')));
const [group, action, ...rest] = process.argv.slice(2);

function usage(): never {
  console.error(`Usage:
  cli tokens create --name <name> [--rpm <n>] [--daily <n>] [--expires-days <n>]
  cli tokens list
  cli tokens revoke <id>`);
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

if (group !== 'tokens') usage();

if (action === 'create') {
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
  const { token, record } = store.create({
    name: values.name,
    rpmLimit: positiveInt(values.rpm, 'rpm'),
    dailyRequestLimit: positiveInt(values.daily, 'daily'),
    expiresAt: days ? Date.now() + days * 86_400_000 : undefined,
  });
  console.log(`Created token #${record.id} (${record.name}). Store it now, it cannot be shown again:\n${token}`);
} else if (action === 'list') {
  for (const t of store.list()) {
    const status = t.revokedAt ? 'revoked' : t.expiresAt && t.expiresAt <= Date.now() ? 'expired' : 'active';
    const u = store.usageToday(t.id);
    console.log(
      `#${t.id}\t${t.name}\t${t.prefix}…\t${status}\trpm=${t.rpmLimit ?? '-'}\tdaily=${t.dailyRequestLimit ?? '-'}\ttoday: ${u.requests} req / ${u.tokens} tok`,
    );
  }
} else if (action === 'revoke') {
  const id = Number(rest[0]);
  if (!Number.isInteger(id)) usage();
  console.log(store.revoke(id) ? `Revoked token #${id}` : `Token #${id} not found or already revoked`);
} else {
  usage();
}
