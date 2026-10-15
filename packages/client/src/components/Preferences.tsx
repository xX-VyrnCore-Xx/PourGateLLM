import { useState } from 'react';
import { getLang, setLang, useT, type Lang } from '../lib/i18n';
import { getTheme, setTheme, type Theme } from '../lib/theme';

const selectClass = 'rounded-lg border border-border bg-transparent px-2 py-1.5 text-xs';

/** Theme and language pickers. Both persist in the browser only. */
export function Preferences() {
  const t = useT();
  const [theme, setThemeState] = useState<Theme>(getTheme());
  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={t('theme')}
        title={t('theme')}
        className={selectClass}
        value={theme}
        onChange={(e) => {
          setThemeState(e.target.value as Theme);
          setTheme(e.target.value as Theme);
        }}
      >
        <option value="system">{t('themeSystem')}</option>
        <option value="light">{t('themeLight')}</option>
        <option value="dark">{t('themeDark')}</option>
      </select>
      <select aria-label={t('language')} title={t('language')} className={selectClass} value={getLang()} onChange={(e) => setLang(e.target.value as Lang)}>
        <option value="en">EN</option>
        <option value="it">IT</option>
      </select>
    </div>
  );
}
