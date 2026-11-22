import { useEffect, useMemo, useState } from 'react';
import type { CatalogCountry } from '../../../shared/types.ts';
import { tc, countryDisplayName } from '../../strings-countries.ts';
import { filterCatalog, flagEmoji, parseLanguages } from './logic.ts';
import { Modal } from './Modal.tsx';
import type { RunOp } from './types.ts';

interface Props {
  existingCodes: string[];
  run: RunOp;
  onClose: () => void;
}

export function AddCountryDialog({ existingCodes, run, onClose }: Props) {
  const [catalog, setCatalog] = useState<CatalogCountry[] | null>(null);
  const [catalogFailed, setCatalogFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [languages, setLanguages] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    window.rw.countries.catalog().then(setCatalog).catch(() => setCatalogFailed(true));
  }, []);

  const options = useMemo(() => filterCatalog(catalog ?? [], existingCodes, query), [catalog, existingCodes, query]);

  function pick(c: CatalogCountry) {
    setCode(c.code);
    setName(countryDisplayName(c.code, c.nameRu));
    setLanguages(c.languages.join(', '));
    setErrors({});
  }

  async function submit() {
    if (!code) {
      setErrors({ code: tc.add.chooseFirst });
      return;
    }
    setBusy(true);
    const res = await run(() => window.rw.countries.add({ code, name: name.trim(), languages: parseLanguages(languages) }));
    setBusy(false);
    if (!res) return;
    if (res.ok) onClose();
    else setErrors(res.errors);
  }

  return (
    <Modal title={tc.add.title} onClose={onClose}>
      <label className="cty-label" htmlFor="cty-search">{tc.add.pick}</label>
      <input id="cty-search" type="search" placeholder={tc.add.search} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      {catalogFailed && <div className="error">{tc.add.catalogError}</div>}
      {catalog && catalog.length > 0 && options.length === 0 && (
        <div className="muted">{query ? tc.add.nothing : tc.add.allAdded}</div>
      )}
      <ul className="cty-picklist" role="listbox" aria-label={tc.add.pick}>
        {options.map((c) => (
          <li key={c.code}>
            <button type="button" role="option" aria-selected={c.code === code} className={c.code === code ? 'cty-pick selected' : 'cty-pick'} onClick={() => pick(c)}>
              <span aria-hidden="true">{flagEmoji(c.code)}</span> {countryDisplayName(c.code, c.nameRu)}
            </button>
          </li>
        ))}
      </ul>

      <label className="cty-label" htmlFor="cty-code">{tc.add.code}</label>
      <input id="cty-code" value={code} readOnly placeholder={tc.add.codeHint} />
      {errors['code'] && <div className="error">{errors['code']}</div>}

      <label className="cty-label" htmlFor="cty-name">{tc.add.name}</label>
      <input id="cty-name" value={name} onChange={(e) => setName(e.target.value)} />
      {errors['name'] && <div className="error">{errors['name']}</div>}

      <label className="cty-label" htmlFor="cty-langs">{tc.add.languages}</label>
      <input id="cty-langs" value={languages} onChange={(e) => setLanguages(e.target.value)} />
      <div className="muted cty-hint">{tc.add.languagesHint}</div>
      {errors['languages'] && <div className="error">{errors['languages']}</div>}

      <div className="cty-actions">
        <button type="button" onClick={onClose} disabled={busy}>{tc.add.cancel}</button>
        <button type="button" className="cty-primary" onClick={submit} disabled={busy}>{tc.add.submit}</button>
      </div>
    </Modal>
  );
}
