import { useSyncExternalStore } from 'react';

const en = {
  appName: 'PourGateLLM',
  login: 'Sign in',
  password: 'Admin password',
  logout: 'Sign out',
  invalidPassword: 'Invalid password',
  tooMany: 'Too many attempts, try again in a minute',
  tokens: 'Tokens',
  providers: 'Providers',
  name: 'Name',
  rpm: 'Requests/min',
  daily: 'Requests/day',
  expiresDays: 'Expires (days)',
  create: 'Create token',
  revoke: 'Revoke',
  status: 'Status',
  usageToday: 'Today',
  active: 'Active',
  revoked: 'Revoked',
  expired: 'Expired',
  newToken: 'New token (shown only once)',
  copy: 'Copy',
  copied: 'Copied',
  noTokens: 'No client tokens yet.',
  keys: 'keys',
  cooling: 'cooling',
  disabled: 'No API key configured',
  models: 'Models',
  unverified: 'unverified',
  trainsOnPrompts: 'May train on your prompts',
  error: 'Something went wrong',
  unlimited: 'unlimited',
} as const;

export type Key = keyof typeof en;

const it: Record<Key, string> = {
  appName: 'PourGateLLM',
  login: 'Accedi',
  password: 'Password admin',
  logout: 'Esci',
  invalidPassword: 'Password non valida',
  tooMany: 'Troppi tentativi, riprova tra un minuto',
  tokens: 'Token',
  providers: 'Provider',
  name: 'Nome',
  rpm: 'Richieste/min',
  daily: 'Richieste/giorno',
  expiresDays: 'Scadenza (giorni)',
  create: 'Crea token',
  revoke: 'Revoca',
  status: 'Stato',
  usageToday: 'Oggi',
  active: 'Attivo',
  revoked: 'Revocato',
  expired: 'Scaduto',
  newToken: 'Nuovo token (mostrato una sola volta)',
  copy: 'Copia',
  copied: 'Copiato',
  noTokens: 'Nessun token client.',
  keys: 'chiavi',
  cooling: 'in pausa',
  disabled: 'Nessuna chiave API configurata',
  models: 'Modelli',
  unverified: 'non verificato',
  trainsOnPrompts: 'Può addestrarsi sui tuoi prompt',
  error: 'Qualcosa è andato storto',
  unlimited: 'illimitato',
};

const dictionaries: Record<string, Record<Key, string>> = { en, it };
const lang = (navigator.language || 'en').slice(0, 2);
const dict = dictionaries[lang] ?? en;

/** Translate a key using the browser language, falling back to English. */
export const t = (key: Key): string => dict[key] ?? en[key];
// Kept as a hook so a runtime language switcher can be added without touching call sites.
export const useT = () => {
  useSyncExternalStore(() => () => {}, () => dict);
  return t;
};
