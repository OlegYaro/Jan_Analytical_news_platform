# 04. Схемы данных

Ниже формы описаны на TypeScript. В фазе 3 их нужно перевести в JSON Schema (draft-07) в
`schemas/*.json` (для `--json-schema` и проверки через ajv) **и** в типы `src/shared/types.ts`.
Все поля обязательны, если не помечены `?`. `additionalProperties: false` везде.

## 1. Общие типы

```ts
type ISODate = string            // "YYYY-MM-DD"
type Unknown = 'unknown'

/** Факт с доказательством. Если value = 'unknown', quote и url могут быть пустыми строками. */
interface Fact<T = string> {
  value: T | Unknown
  quote: string                  // дословно, язык оригинала, ≤ 300 символов
  url: string
}
```

## 2. `triage.json`

```ts
interface TriageOutput {
  country: string
  items: Array<{
    id: string
    decision: 'relevant' | 'borderline' | 'irrelevant'   // 'maybe' принимается как псевдоним borderline (TRI-02)
    reason_code: null | 'other_sector' | 'personnel_appointment' | 'individual_decision'
               | 'not_regulatory' | 'duplicate_of_other_candidate' | 'outside_date_window'
    reason_text: string            // ≤ 200 символов
    confidence: 'high' | 'medium' | 'low'
  }>
}
```
Код проверяет: множество `id` = множество кандидатов на входе (HAL-04); `irrelevant` ⇒ `reason_code ≠ null`.

### 2а. Кандидат (`candidates.json`): класс органа

К каждому кандидату код добавляет поля (COL-08): `issuer_class: 1 | 2 | 3` (CTY-09), `issuer_type: string` (орган по списку страны, напр. «ЦБ», «Кабинет Министров»; `unknown`, если не распознан), `bank_terms_found: boolean`, `no_text: boolean` (COL-05), `text_source: 'html' | 'pdf' | 'none'`.

### 2б. `screen.json` (ответ `/screen-act`)

```ts
interface ScreenOutput {
  country: string
  mode: 'screen' | 'confirm'
  items: Array<{
    id: string
    decision: 'material' | 'minor' | 'none' | 'unsure'
    points: string[]                 // ≤ 5 пунктов акта (номер пункта/статьи + суть), англ.
    quote: string                    // ровно одна дословная цитата из переданных фрагментов, язык оригинала, ≤ 300 символов; '' только при unsure без текста
    reason: string                   // ≤ 200 символов
    confidence: 'high' | 'medium' | 'low'
  }>
}
```
Код проверяет: множество `id` = входному (HAL-04); `quote` найдена среди фрагментов входа (иначе решение трактуется как `unsure`); `none` при `issuer_class ∈ {1,2}` обязан пройти режим `confirm`; итог пакета пишется в `screen.json` (поля `final_decision`, `confirmed_by` добавляет код).

## 3. `card.json` (ответ `/analyze-act`)

```ts
interface Card {
  candidate_id: string
  country: string
  act: {
    type: Fact                     // напр. "Central Bank Board resolution"
    issuer: Fact
    number: Fact                   // "24/2"
    title_original: Fact
    title_en: string               // перевод, без доказательства
    adoption_date: Fact<ISODate>
    registration_number: Fact      // "3254-2" или unknown
    registration_date: Fact<ISODate>
    publication_date: Fact<ISODate>
    effective_date: Fact<ISODate>
    transition_period: { exists: Fact<'yes' | 'no'>; details: string }
    original_language: string
    official_russian_text: 'yes' | 'no' | 'unknown'
  }
  headline: string                 // тема в 3–5 слов для письма (англ.), напр. "Corporate governance in banks" (ANA-10)
  top_changes: Array<{             // до 3 главных изменений 🔴 для письма; подмножество changes[]
    n: number                      // номер из changes[]
    location: string
    summary_en: string             // одна строка
    implementation_difficulty: 'low' | 'medium' | 'high'
  }>                               // длина ≤ 3
  stage: 'draft' | 'adopted' | 'registered' | 'published' | 'in_force'
  update_of: null | { ledger_key: string; what_changed: string }
  amends: {
    base_act_title: Fact
    base_act_number: Fact          // "3254"
    base_act_url: string
    prior_amendments: Array<{ number: string; date: ISODate | Unknown; url: string }>
  }
  scope: { applies_to: Fact; not_applies_to: Fact }
  change_count: {
    annex_items: Fact<number>
    legal_base_marks: Fact<number>  // если число получено подсчётом и в тексте не написано — 'unknown', подсчёт в explanation
    explanation: string
  }
  changes: Array<{
    n: number
    location: string               // "Point 16", "Chapter 8¹ (points 50¹–50⁵)"
    kind: 'rewritten' | 'added' | 'repealed' | 'new_chapter'
    summary_en: string
    significance: 'significant' | 'less_significant' | 'not_significant'
    significance_reason: string
    implementation_difficulty: 'low' | 'medium' | 'high'
    difficulty_reason: string
    quote: string
    url: string
  }>
  links: { amending_act: string; current_version: string; version_on_effective_date: string }
  unknowns: string[]               // пути полей со значением unknown
  notes: string
}
```

Код после ответа (`evidence-check.json`):
- каждая `quote` найдена в `snapshot.txt` или в одном из `related_snapshots` после нормализации
  (пробелы, регистр, `ʼ ' ’ ‘ ʻ` → `'`, `« » “ ” „` → `"`, неразрывные пробелы, мягкие переносы);
- для дат: день, месяц, год значения встречаются в цитате (форматы `DD.MM.YYYY`, `YYYY-MM-DD`,
  `D <месяц> YYYY` на языке оригинала — словарь месяцев для ru/uz/kk/ky/tg/tk/ka/hy/az/mn/en; для монгольского (mn) — формат «YYYY оны M дугаар/дүгээр сарын D» с порядковыми названиями месяцев «нэгдүгээр … арван хоёрдугаар сар» и числовой формат `YYYY.MM.DD`);
- для номеров: строка номера встречается в цитате (поэтому число, полученное подсчётом и нигде не
  написанное, — например, отметки правовой базы, — пишется как `unknown` с подсчётом в `explanation`;
  см. FINDINGS «Фаза 5: T-2, T-6, T-16»);
- результат: `{ field, ok, reason }[]`.

## 4. `verification.json`

```ts
interface Verification {
  country: string
  cards: Array<{
    candidate_id: string
    fields: Array<{
      field: string                // путь, напр. "act.effective_date", "changes[3].location"
      status: 'ok' | 'mismatch' | 'unverifiable'
      correct_value?: string
      quote?: string
      url?: string
      comment: string
    }>
    verdict: 'confirmed' | 'needs_correction' | 'unconfirmed'
  }>
  returned: Array<{ id: string; reason: string }>   // reason обязателен и называет, что именно в заголовке связано с банками/темой (VER-02); пустое/общее «на всякий случай» код отклоняет
  watched_acts_check: Array<{
    registration_number: string
    new_edition_found: boolean
    edition_date?: ISODate
    url?: string
  }>
}
```
Проверяются ключевые поля (номер, даты, вступление, переходный период, ссылки, значимые изменения);
остальные — выборочно (VER-03). Если у кандидата нет текста, второго круга нет: «⚠ Не удалось проверить».

Правило кода: карточка попадает в письмо как подтверждённая, только если `verdict = confirmed` и
все её поля прошли `evidence-check`. Иначе — после 2 кругов — с пометкой «⚠ не подтверждено» и
списком спорных полей. `new_edition_found = true` → новый кандидат канала А → анализ → проверка.

## 5. `verify-sources.json`

```ts
interface SourcesCheck {
  country: string
  sources: Array<{
    id: string
    reachable: boolean
    login_or_captcha: boolean
    final_url: string
    official: boolean
    official_reason: string
    type_matches: boolean
    has_dated_listing: boolean
    needs_js: 'yes' | 'no' | 'unknown'
    language: string
    profile: null | {
      kind: 'rss' | 'html_list' | 'json_api'
      url: string
      item?: string; title?: string; link?: string; date?: string
      date_format?: string; issuer?: string
      pagination?: { param: string; max_pages: number }
      json_paths?: { items: string; title: string; link: string; date: string }
    }
    seen_latest: Array<{ title: string; date: string; url: string }>   // ≤ 5
    verdict: 'ok' | 'warn' | 'fail'
    reasons: string[]
  }>
  watched_acts: Array<{ registration_number: string; verdict: 'ok' | 'warn' | 'fail'; reason: string }>
}
```
Код прогоняет `profile`; итоговый ✅ = код извлёк ≥ 3 документа с датами (и модель не нашла замечаний: официальный
сайт, тип совпадает). `seen_latest` модели код не использует: «что видно на сайте» — только извлечённое кодом.

Вход (`input-<раунд>.json`, пишет код, в схему ответа не входит; FINDINGS «Фаза 6»): `country`, `round`, `max_rounds`,
`sources[]` — `id, url, declared_type, language, pages[] {url, final_url, http_status, html_path, text_path},
observed_by_app {final_url, password_field, little_visible_text_many_scripts, visible_text_chars}`, со 2-го раунда —
`previous_attempt {profile, extracted_count, dated_count, problem, html_path, text_path, sample[]}`; `watched_acts[]` —
`registration_number` (или служебный ключ `id:<…>`, если номера нет), `title`, `url`, `pages[]`. Страницы скачивает
и сохраняет код (`state/source-checks/<CC>/<sourceId>/page-0.html|txt`); модель читает их через Read.

## 6. `discover-sources.json`

```ts
interface DiscoverSources {
  country: string
  proposals: Array<{
    type: 'legal_base' | 'regulator' | 'drafts' | 'news'
    name: string; url: string; listing_url: string; language: string; reason: string
  }>
  /** Режим поиска отслеживаемых актов (SRC-09): пусто, если режим не запрашивался. */
  watched_act_proposals: Array<{
    act_type: 'banking_law' | 'central_bank_law' | 'joint_stock_law' | 'fx_law' | 'aml_law' | 'deposit_insurance_law' | 'cb_corporate_governance'
    title_original: string
    number: string                 // номер/регистрационный номер или 'unknown'
    url: string                    // реально открытая страница на официальной правовой базе
    last_edition_date: ISODate | Unknown
    quote: string                  // дословно, язык оригинала: строка со страницы, подтверждающая название/номер
    reason: string
  }>
}
```

## 7. `news-sweep.json`

```ts
interface NewsSweep {
  country: string
  leads: Array<{
    headline: string; outlet: string; date: ISODate; url: string
    act_number: string; act_date: string; issuer: string; summary: string
  }>
}
```
Наводка становится кандидатом, только если код нашёл акт в первичной правовой базе по номеру/дате.
Иначе — в письмо не попадает, записывается в лог «наводка без подтверждения».

## 8. `translation.json`

```ts
// вход (input.json): { glossary: Record<string,string>; items: Array<{ id: string; text: string }> }
interface Translation {
  items: Array<{ id: string; ru: string }>   // ru ≤ 2000 символов, без Markdown
}
```
Переводятся только короткие английские фрагменты письма (тема акта, строки 🔴, «для сведения»), не
документ целиком: письмо и `report.en.md` собирает код (FINDINGS «Фаза 7: перевод фрагментами»).
Каждый перевод код сверяет с оригиналом (`compareNumbers`): расхождение или отсутствие → фрагмент
остаётся по-английски (LNG-03, T-7).

## 9. Состояние

```ts
interface RunState {             // runs/<id>/run.json
  id: string; mode: 'scheduled' | 'manual' | 'dry_run' | 'backfill'
  started_at: string; finished_at?: string
  window_override?: { from: ISODate; to: ISODate }
  skills_hash: string
  countries: Record<string, {
    window: { from: ISODate; to: ISODate }
    status: 'pending' | 'running' | 'changes' | 'no_changes' | `failed:${string}`
    stages: Record<'collect' | 'news' | 'triage' | 'analyze' | 'verify', {
      state: 'pending' | 'done' | 'skipped' | 'failed'; attempts: number; error?: string
    }>
    acts: Record<string, { analyze: 'pending' | 'done' | 'failed'; rounds: number; verdict?: string }>
    usage: { input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }
  }>
  digest?: { en: boolean; ru: 'pending' | 'done' | 'blocked' | 'not_needed' }
  email?: { state: 'not_needed' | 'queued' | 'sent' | 'failed'; attempts: number }
  paused_until?: string          // пауза по лимиту
  stopped?: boolean              // остановлен пользователем: при старте приложения сам не продолжается
}
// Дополнения кода (src/shared/run-types.ts): этап и акт могут быть в состоянии 'running' (при
// возобновлении = прерван, начать шаг заново); у страны есть warnings?: string[] (⚠ в письме);
// у этапа verify attempts = число завершённых проходов проверки.

interface ScheduleFired {        // state/schedule_fired.json (рабочая папка; атомарная запись)
  version: 1
  fired: Record<string, string>        // id расписания → ISO: последнее срабатывание или точка отсчёта
  lastStarted: Record<string, string>  // id расписания → ISO: последний реальный старт прогона (для окна)
}

interface RateLimitFile {        // state/rate_limit.json (атомарная запись; runner/budget.ts, NFR-06)
  version: 1
  updated_at: string             // ISO последней записи
  // Последние известные данные окон из rate_limit_event (после каждого процесса модели). Окно без новых
  // данных в событии сохраняется. Ошибка лимита без доли → utilization 1, status 'rejected' до сброса.
  five_hour?: { utilization: number; resets_at: string | null; status?: string; observed_at: string }
  seven_day?: { utilization: number; resets_at: string | null; status?: string; observed_at: string }
}
// Свежесть: five_hour учитывается, если observed_at моложе 5 ч и resets_at впереди; seven_day — пока
// resets_at впереди (доля в окне только растёт до сброса). Битый файл = данных нет.

interface OutboxFile {           // state/outbox.json (атомарная запись; mail/outbox.ts)
  version: 1
  entries: Array<{
    id: string                   // `<runId>:<digest|failure_alert>:<ru|en|ru+en>` — уникален
    runId: string; kind: 'digest' | 'failure_alert'
    group: string                // письма одной группы коммитят журнал один раз
    createdAt: string; lang: 'ru' | 'en' | 'ru+en'
    subject: string; html: string; text: string; to: string[]
    attempts: number; nextAttemptAt: string
    status: 'queued' | 'sent' | 'failed'
    lastError?: string; lastErrorEn?: string   // translateMailError
    lastAttemptAt?: string; sentAt?: string; failedAt?: string
    inFlightSince?: string       // попытка начата, итог не записан
    commit: Record<string, CommitItem[]>       // страна → RunReport.to_commit
    checked?: Record<string, string>           // страна → ISO для last_success после отправки
    committed: boolean; commitError?: string
  }>
}

interface CountryFailures {      // state/country_failures.json (COV-06)
  version: 1
  countries: Record<string, { consecutive: number; lastRunId: string; lastStatus: string; lastError?: string; since?: string }>
}

type LastSuccess = Record<string, string>   // state/last_success.json: страна → ISO начала прогона

interface LedgerEntry {          // state/ledger/<CC>.json — массив
  key: string                    // "reg:3254-2" | "num:24/2|2026-09-17|<url>"
  first_reported_at: string
  last_stage: Card['stage']
  effective_date: ISODate | Unknown
  title_en: string
  run_id: string
}
```

## 10. `settings.json` (версия схемы 4)

`~/Library/Application Support/RegWatch/settings.json` (CFG-13). Полный тип — `Settings` в
`src/shared/types.ts`; здесь — поля расписания и что меняет миграция.

```ts
interface ScheduleEntry {
  id: string          // ^[a-z0-9][a-z0-9-]{0,39}$, уникален в списке
  name: string        // 1..60 знаков
  enabled: boolean
  days: number[]      // не пусто, 0..6 (0 = воскресенье)
  time: string        // 'HH:MM', местное время
  countries: string[] // коды ^[A-Z]{2}$ без повторов; [] = все включённые страны
}
// Settings (v4): schedules: ScheduleEntry[] (1..9) и uiLanguage: 'ru' | 'en' вместо прежних
// scheduleDays / scheduleTime. Патч из окна заменяет массив schedules целиком.
```

Миграция v3 → v4: `scheduleDays` + `scheduleTime` → `schedules: [{ id: 'main', name: 'Основная проверка',
enabled: true, days, time, countries: [] }]` (неверные значения → пн / 08:00); `uiLanguage` = `'ru'`.
Остальные поля не трогаются. При каждом чтении список расписаний приводится к схеме (лишнее
отбрасывается, больше 9 — обрезается, пусто — одно стандартное).

## 11. `golden/cases/*.json` — случаи из «Истории» (HAL-07)

`<рабочая папка>/golden/cases/<kind>-<CC>-<id>.json`, атомарная запись (`src/main/golden-cases.ts`). Эталоны из
репозитория (`golden/*.expected.json`, `docs/golden/`) не трогаются. `id`: для `false_positive` — id кандидата
(`safeActId`, ≤ 120 знаков), для `missed` — `url-<первые 16 hex sha256 ключа ссылки>` (ключ: без протокола,
`www.`, якоря и конечного `/`). Тот же вид + тот же кандидат / та же ссылка → тот же файл (второй не создаётся).

```ts
interface GoldenCaseFile {
  format: 1
  kind: 'false_positive' | 'missed'
  id: string                       // ^[A-Za-z0-9._-]{1,160}$
  country: string                  // ^[A-Z]{2}$
  created_at: string               // ISO
  run_id: string                   // id прогона, где пометили
  comment: string                  // ≤ 1000 знаков (из формы)
  candidate: {                     // из candidates.json прогона; missed без найденного кандидата — только url
    url: string                    // missed — ссылка из формы (http/https)
    id?: string; key?: string; title_original?: string; issuer?: string; date?: string; doc_type?: string
    issuer_class?: 1 | 2 | 3
  }
  decision_at_that_time: {
    collected: boolean             // кандидат был среди кандидатов прогона
    triage: string | null          // решение triage.json
    screen: 'material' | 'minor' | 'dropped' | 'no_text' | null   // итог экрана (screen.json, иначе run.json)
    by: 'triage' | 'code' | 'screen' | 'confirm' | null           // кто решил последним
    reason: string | null
    result_level: 'material' | 'for_info' | 'unverified' | 'none' // где оказался в result.json
  }
  expected: { level: 'none' }                  // false_positive: не должен попасть в письмо
          | { level: 'material_or_for_info' }  // missed: должен быть виден (существенный / для сведения / не проверен)
  snapshot_text?: string           // `<имя случая>.snapshot.txt` рядом — копия acts/<id>/snapshot.txt, только если он был в архиве
  snapshot_sha256?: string
}
```

`npm run golden -- --app-cases [--workspace <папка>]` перечисляет случаи, проверяет формат (имя файла, поля,
sha256 текста) и — только при сохранённом тексте — кодовую часть экрана (SCR-01/04: нет текста → «не удалось
проверить», орган класса 3 без банковских терминов → отброшен, иначе решает модель). Модель не вызывается.
