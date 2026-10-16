declare const __PG_VERSION__: string | undefined;

/** Build-time version (the release workflows set POURGATE_VERSION while building); "dev" when running from source. */
export const VERSION: string = process.env.POURGATE_VERSION || (typeof __PG_VERSION__ === 'string' ? __PG_VERSION__ : 'dev');
