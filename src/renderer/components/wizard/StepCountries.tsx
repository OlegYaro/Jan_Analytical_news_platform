import { useEffect, useState } from 'react';
import type { Country } from '../../../shared/types.ts';
import { t } from '../../strings.ts';
import { flagEmoji } from '../countries/logic.ts';

export function StepCountries() {
  const [countries, setCountries] = useState<Country[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  useEffect(() => {
    window.rw.countries.list().then(setCountries).catch(() => setLoadFailed(true));
  }, []);

  const toggle = async (code: string, active: boolean) => {
    try {
      const res = await window.rw.countries.setActive(code, active);
      setCountries(res.countries);
      setSaveFailed(!res.ok);
    } catch {
      setSaveFailed(true);
    }
  };

  return (
    <section className="card">
      <h2>{t.wizard.steps[4]}</h2>
      {loadFailed && <p className="error">{t.wizard.countriesLoadError}</p>}
      {!countries && !loadFailed && <p className="muted">{t.extra.loading}</p>}
      {saveFailed && <p className="error">{t.wizard.countriesError}</p>}
      {countries && (
        <ul className="wz-countries">
          {countries.map((c) => (
            <li key={c.code}>
              <label>
                <input type="checkbox" checked={c.active} onChange={(e) => void toggle(c.code, e.target.checked)} />{' '}
                <span>{flagEmoji(c.code)} {c.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">{t.wizard.countriesHint}</p>
    </section>
  );
}
