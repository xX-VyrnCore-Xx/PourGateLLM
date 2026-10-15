export type Theme = 'system' | 'light' | 'dark';
const KEY = 'pourgate.theme';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // storage blocked
  }
  return 'system';
}

/** Applies the theme by toggling the `dark` class on <html> (the stylesheet keys off it). */
export function applyTheme(theme: Theme): void {
  const dark = theme === 'dark' || (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    // applied but not persisted
  }
  applyTheme(theme);
}
