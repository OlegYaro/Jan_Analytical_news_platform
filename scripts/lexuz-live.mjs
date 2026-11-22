// Живая проверка адаптера lex.uz (фаза 4, COL-07): `node scripts/lexuz-live.mjs [from] [to]`.
// Ходит на настоящий lex.uz: ~80 запросов с паузой ≥ 1 с, несколько минут. Не входит в `npm test`.
import { createFetcher } from '../src/main/collect/fetcher.ts';
import {
  dedupeCandidates,
  dedupeDocs,
  editionCandidates,
  lexuzEditions,
  lexuzSearchNew,
  newEditionsSince,
  toCandidate,
} from '../src/main/collect/adapters/lexuz.ts';

const from = process.argv[2] ?? '2026-07-01';
const to = process.argv[3] ?? '2026-11-17';
const DOC = 'https://www.lex.uz/docs/-4888804';

// Пауза ≥ 1 с между концом одного запроса и началом следующего (поверх задержки самого fetcher).
const base = createFetcher();
let last = 0;
const pause = async () => {
  const wait = last + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};
const fetcher = {
  async get(url, o) {
    await pause();
    try { return await base.get(url, o); } finally { last = Date.now(); }
  },
  async postForm(url, f, o) {
    await pause();
    try { return await base.postForm(url, f, o); } finally { last = Date.now(); }
  },
};

const t0 = Date.now();
const out = {};
for (const regOnly of [true, false]) {
  const t = Date.now();
  const r = await lexuzSearchNew({ fetcher, window: { from, to }, regOnly });
  const sec = ((Date.now() - t) / 1000).toFixed(1);
  if (!r.ok) {
    console.log(`regOnly=${regOnly}: ПРОВАЛ ${r.failure}: ${r.reason} (запросов ${r.requests}, ${sec} с)`);
    process.exitCode = 1;
    continue;
  }
  out[regOnly] = r;
  console.log(
    `regOnly=${regOnly}: запрос ${r.query.from}…${r.query.to}; найдено uz=${r.found}, ru=${r.foundRu}; ` +
      `в окне+запасе ${r.docs.length} (в окне ${r.docs.filter((d) => d.inWindow).length}); ` +
      `с русской парой ${r.docs.filter((d) => d.urlRu).length}; запросов ${r.requests}; ${sec} с`,
  );
  for (const w of r.warnings) console.log('  ⚠', w);
}

const docs = dedupeDocs([...(out.true?.docs ?? []), ...(out.false?.docs ?? [])]);
console.log(`\nВсего после дедупликации: ${docs.length}`);
for (const reg of ['3254-1', '3254-2']) {
  const d = docs.find((x) => x.registrationNumber === reg);
  console.log(d ? `✅ рег. ${reg}: ${d.url} | ru ${d.urlRu} | ${d.registrationDate} | ${d.docType} ${d.issuer} | ${d.title}` : `❌ рег. ${reg} не найден`);
  if (!d) process.exitCode = 1;
}

const e = await lexuzEditions({ fetcher, docUrl: DOC });
if (!e.ok) {
  console.log(`Редакции: ПРОВАЛ ${e.failure}: ${e.reason}`);
  process.exitCode = 1;
} else {
  console.log(`\nРедакции ${DOC} (запросов ${e.requests}): «${e.title}», заголовок ${e.headerNumber} от ${e.headerDate}, показана ${e.shownEdition}`);
  for (const x of e.editions) console.log(`  ${x.date} ${x.status.padEnd(7)} ${x.label}  ${x.url}`);
  const fresh = newEditionsSince(e.editions, null, { firstRunFrom: from });
  const fromA = fresh.flatMap((x) => editionCandidates(e, x));
  const fromB = docs.map((d) => toCandidate(d, 'B', 'UZ'));
  const all = dedupeCandidates([...fromB, ...fromA]);
  console.log(`Канал А (редакции с ${from}): ${fromA.map((c) => `${c.id} ${c.key}`).join('; ')}`);
  console.log(`Кандидатов А+Б после дедупликации: ${all.length} (Б ${fromB.length}, А ${fromA.length})`);
  for (const need of ['2026-07-20', '2027-01-13']) {
    const ok = e.editions.some((x) => x.date === need);
    console.log(`${ok ? '✅' : '❌'} редакция ${need}`);
    if (!ok) process.exitCode = 1;
  }
}
console.log(`\nВремя всего: ${((Date.now() - t0) / 1000).toFixed(1)} с`);
