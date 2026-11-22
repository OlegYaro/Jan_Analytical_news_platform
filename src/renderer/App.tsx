import { useCallback, useEffect, useState } from 'react';
import type { GateStatus } from '../shared/api.ts';
import type { Settings } from '../shared/types.ts';
import { CountriesPage } from './pages/Countries.tsx';
import { HistoryPage } from './pages/History.tsx';
import { Home } from './pages/Home.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Wizard } from './pages/Wizard.tsx';
import { currentLang, setLangLocal } from './i18n.ts';
import { t } from './strings.ts';

export type PageId = 'home' | 'countries' | 'history' | 'settings';

const PAGES: PageId[] = ['home', 'countries', 'history', 'settings'];

export function App() {
  const [page, setPage] = useState<PageId>('home');
  const [settings, setSettings] = useState<Settings | null>(null);

  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    window.rw.settings.get().then(setSettings).catch(() => setLoadError(true));
  }, []);

  // Язык: главным остаётся Settings.uiLanguage; при расхождении приводим localStorage к настройке и перезагружаем окно один раз.
  useEffect(() => {
    document.documentElement.lang = currentLang();
    if (!settings || !settings.uiLanguage || settings.uiLanguage === currentLang()) return;
    let done = false;
    try {
      done = sessionStorage.getItem('rw-lang-reloaded') === '1';
      if (!done) sessionStorage.setItem('rw-lang-reloaded', '1');
    } catch {
      done = true; // без sessionStorage перезагрузка могла бы зациклиться
    }
    setLangLocal(settings.uiLanguage);
    if (!done) window.location.reload();
  }, [settings]);

  const [gate, setGate] = useState<GateStatus | null>(null);

  // Статус гейта почты пересчитываем при любом изменении настроек (пароль, тестовое письмо и т.д.).
  useEffect(() => {
    let alive = true;
    window.rw.gate.status().then((g) => alive && setGate(g)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [settings]);

  const onSettings = useCallback((s: Settings) => setSettings(s), []);

  if (settings && !settings.onboardingDone) return <Wizard settings={settings} onSettings={onSettings} />;

  let body;
  if (page === 'home') body = <Home settings={settings} gate={gate} goTo={setPage} />;
  else if (page === 'settings') body = <SettingsPage settings={settings} onSettings={onSettings} />;
  else if (page === 'countries') body = <CountriesPage settings={settings} />;
  else body = <HistoryPage />;

  return (
    <div className="layout">
      <nav className="sidebar">
        <div className="brand">{t.extra.appName}</div>
        {PAGES.map((p) => (
          <button key={p} type="button" className={p === page ? 'nav active' : 'nav'} onClick={() => setPage(p)}>
            {t.menu[p]}
          </button>
        ))}
      </nav>
      <main className="content">
        {loadError && <div className="banner warn">{t.extra.loadError}</div>}
        {body}
      </main>
    </div>
  );
}
