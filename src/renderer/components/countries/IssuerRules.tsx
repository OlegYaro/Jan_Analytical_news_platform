import { useEffect, useState } from 'react';
import { DEFAULT_ISSUER_RULES } from '../../../main/collect/issuer-class.ts';
import type { Country } from '../../../shared/types.ts';
import { tc } from '../../strings-countries.ts';
import { formatIssuerLines, parseIssuerLines, validateIssuerRules } from './logic.ts';
import type { RunOp } from './types.ts';

interface Props {
  country: Country;
  run: RunOp;
}

/** Блок «Органы и уровень отбора» (SCR): правила классов органов страны. */
export function IssuerRules({ country, run }: Props) {
  const defaults = DEFAULT_ISSUER_RULES[country.code];
  const effective = country.issuerClasses ?? defaults;
  const [c1, setC1] = useState(formatIssuerLines(effective?.class1 ?? []));
  const [c2, setC2] = useState(formatIssuerLines(effective?.class2 ?? []));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const t = tc.issuers;

  const stamp = JSON.stringify(effective ?? null);
  useEffect(() => {
    setC1(formatIssuerLines(effective?.class1 ?? []));
    setC2(formatIssuerLines(effective?.class2 ?? []));
    setErrors({});
  }, [country.code, stamp]);

  async function apply(issuerClasses: { class1: string[]; class2: string[] } | null) {
    setSaved(false);
    const res = await run(() => window.rw.countries.update(country.code, { issuerClasses }));
    if (!res) return;
    setErrors(res.ok ? {} : res.errors);
    setSaved(res.ok);
  }

  function save() {
    const rules = { class1: parseIssuerLines(c1), class2: parseIssuerLines(c2) };
    const bad = validateIssuerRules(rules, t);
    setErrors(bad);
    if (Object.keys(bad).length === 0) void apply(rules);
  }

  const noRules = !effective;
  return (
    <section className="card">
      <div className="card-head"><h2>{t.title}</h2></div>
      <p className="muted">{t.intro}</p>
      {noRules && c1 === '' && c2 === '' && <div className="banner warn">{t.noRules}</div>}

      <label className="cty-label" htmlFor="ci-c1">{t.class1}</label>
      <textarea id="ci-c1" className="st-input" rows={5} value={c1} onChange={(e) => { setC1(e.target.value); setSaved(false); }} />
      <div className="muted cty-hint">{t.class1Hint}</div>
      {errors['class1'] && <div className="error">{errors['class1']}</div>}

      <label className="cty-label" htmlFor="ci-c2">{t.class2}</label>
      <textarea id="ci-c2" className="st-input" rows={4} value={c2} onChange={(e) => { setC2(e.target.value); setSaved(false); }} />
      <div className="muted cty-hint">{t.class2Hint}</div>
      {errors['class2'] && <div className="error">{errors['class2']}</div>}

      <p className="muted">{t.others}</p>
      {defaults && <p className="muted cty-hint">{country.issuerClasses ? t.customNote : t.defaultNote}</p>}

      <div className="cty-actions cty-left">
        <button type="button" className="cty-primary" onClick={save}>{t.save}</button>
        <button type="button" onClick={() => void apply(null)} disabled={!country.issuerClasses} title={defaults ? undefined : t.resetDisabledHint}>{t.reset}</button>
        {saved && <span className="cty-ok">{t.saved}</span>}
      </div>
    </section>
  );
}
