# AUDIT — финальная сверка требований с кодом (фаза 11, пункты 1–2)

Дата: 21.11.2026. Реальный `claude` и приложение не запускались; сверка — по коду (grep, чтение), тестам
(`npm run typecheck`, `npm test`) и записям `docs/TRACEABILITY.md`, `docs/FINDINGS.md`.
Построчная сверка TRACEABILITY — `npm run audit` (`scripts/trace-audit.mjs`, код выхода 1 при нарушениях).

**Как ставился вердикт.** ✅ — реализовано, и критерий приёмки покрыт тестом или живой проверкой
(ручная проверка в окне может ещё понадобиться — она указана в колонке «Проверено»). ⚠ — реализовано
частично, либо критерий требует проверки, которой не было и которую юнит-тест не заменяет (реальное
письмо, перезагрузка Mac, качество модели), либо найдено расхождение с документами. ❌ — нет в коде.
Пути в колонке «Код» — от `src/main/` (если не указано `renderer/`, `components/` = `src/renderer/components/`,
`pages/` = `src/renderer/pages/`, `skills/`, `schemas/`, `scripts/`).

## Итог

| | Всего | ✅ | ⚠ | ❌ |
|---|---|---|---|---|
| Must (M) | 128 | 99 | 29 | 0 |
| Should / Could (S/C) | 21 | 11 | 8 | 2 (C: TRI-06, DLV-08) |
| **Всего требований** | **149** | **110** | **37** | **2** |

S/C по TRACEABILITY: ✅ CFG-03, CFG-10, SRC-06, SRC-08, RUN-08, DLV-03, COV-06, PRM-08, PRM-09, NFR-08,
NFR-15; ⚠ CFG-05 (влияние на значимость не проверено живьём), CFG-15 (подсказка из docs/05 §6.4 не
показана, смена модели в окне вручную не проверялась), SRC-07, SRC-09 (живьём не запускались), HAL-07
(прогон модели по случаям не сделан), DLV-07 (показ уведомления не проверен), SKL-04 (T-17), NFR-16 (частично: замер UZ есть, девять стран — оценка, живой прогон на Mac);
❌ TRI-06, DLV-08 — приоритет C, по плану «можно позже».

## 1. Особые проверки

### 1.1 Поля настроек docs/05 §6 (правило 4 CLAUDE.md, CFG-01/02)

Все поля из §6.1–6.6 есть в окне (`src/renderer/components/settings/*Section.tsx`, тексты —
`src/renderer/strings-settings.ts`). Поля оформлены компонентом `Field` (`components/settings/Field.tsx:17`):
название, подсказка, «Например», «по умолчанию», ошибка проверки. Разбор всех 30 вызовов `<Field>`:
у 27 есть подсказка, пример и значение по умолчанию. У трёх нет примера и умолчания, но это не поля ввода:
«Показать тексты скиллов», «Сбросить всё к стандартным» (кнопки) и «Расход последнего прогона» (только показ).

| Раздел docs/05 | Поле | В окне | Замечание |
|---|---|---|---|
| 6.1 | Тема / Для кого оценивать / Искать в новостях | ✅ SearchSection | русская подпись темы и perspective — `DEFAULT_TOPIC_RU`/`DEFAULT_PERSPECTIVE_RU` |
| 6.2 | Название, Включено, Дни, Время, Страны (до 9 расписаний) | ✅ ScheduleSection | **исправлено:** у «Включено» подсказка (`enabledHint`) была в строках, но не показывалась. Подпись «по умолчанию: Расписание 1» относится к новому расписанию; стандартное первое называется «Основная проверка» (defaults.ts:13). Нет фразы «страна из двух расписаний проверится один раз» |
| 6.2 | Запускать при входе / Проверить при включении | ✅ | — |
| 6.3 | Сервис, адрес, пароль (+ «Как получить»), кому, язык отчёта, предупреждать о сбоях, тестовое письмо, сервер/порт/шифрование для «Другой» | ✅ MailSection | ссылка Gmail по curl отдавала 404 (FINDINGS «Фаза 7: проверка ссылок»), Mail.ru ведёт на общую страницу |
| 6.4 | Режим, ползунок X % | ✅ SpendSection | — |
| 6.4 | Модель этапа «Экран» | ✅ в «Дополнительно» → «Модели по этапам» | подсказка из docs/05 («Дешёвая модель быстро просматривает…») не показана, только название этапа |
| 6.4 | Расход последнего прогона | **⚠ заглушка**: всегда «Данных ещё нет» (`SpendSection.tsx`) | расход виден в окне «Прогон» (RunPanel, NFR-08), в Настройках — нет |
| 6.5 | Рабочая папка, «Открыть в Finder» | ✅ FoldersSection | — |
| 6.6 | Модели, таймауты, первый прогон (30), транскрипты, путь к Claude Code, тексты скиллов (чтение), «Сбросить всё» | ✅ AdvancedSection (`<details>`, свёрнуто) | — |

Ни одной настройки, которую нужно править в файле, не найдено. Права модели, промпты и скиллы в окне
не редактируются (CFG-12).

### 1.2 Права моделей по этапам (docs/02 §6, PRM-03/05/06)

`src/main/runner/stage-profiles.ts` сверен с таблицей построчно: `--tools`, WebFetch (свободно /
по доменам / нет), WebSearch, `--max-turns` (+2 на structured output), таймауты (`settings/presets.ts`),
модели пресетов «Экономно / Сбалансировано / Максимальная точность» — **совпадают**. Отклонения
записаны в FINDINGS: Read у SRC-DISCOVER (вход файлом), WebFetch по доменам источников ✅ и ⚠ (PRM-04),
`--output-format stream-json` вместо `json` (нужен сторожу PRM-08, совместимость с `--json-schema`
проверена в фазе 0). **Bash, Agent, Task, Write, Edit, MultiEdit, NotebookEdit** — в `--disallowedTools`
на всех этапах (`DISALLOWED_TOOLS`, stage-profiles.ts:64); всегда `--permission-mode dontAsk`,
`--setting-sources project`, `--strict-mcp-config`; каждое правило `--allowedTools` — отдельный аргумент.
Тест: `stage-profiles.test.ts` («права этапов по таблице docs/02 §6», «Bash, Agent, Write, Edit всегда
в --disallowedTools; dontAsk всегда»); живой T-12.

### 1.3 Секреты (NFR-12, правило 8)

Пароль приложения шифруется `safeStorage` (`src/main/secrets.ts`), читается только в main при отправке
(`index.ts:196`). В preload и `shared/api.ts` есть только `secrets.status()` → `{ mailPasswordSet }`
и `setMailPassword(password)` (запись); метода чтения нет. В `Settings` (`shared/types.ts`) поля пароля нет.
`smtp.ts` не включает пароль в тексты ошибок. Не проверено: работа Связки ключей на Mac пользователя.

### 1.4 Нативные модули (правило 3, INS-02, NFR-09)

В `package.json` нет нативных зависимостей. В `node_modules` нет пакетов с `binding.gyp`/`gypfile`;
install-скрипт только у `electron-winstaller` (выбор архитектуры 7z, без сборки). Файлы `*.node` есть
только у готовых бинарников инструментов сборки (lightningcss, rolldown, fsevents, extract-zip), их не
компилируют. PDF — `pdfjs-dist` (чистый JS). ✅

### 1.5 Окружение `claude` (правило 9, NFR-11)

`env.ts:37-45` `stripClaudeEnv` вырезает `CLAUDECODE` и все `CLAUDE_*`; `buildClaudeEnv` берёт окружение
login shell (`$SHELL -ilc env`), при ошибке — `process.env` без тех же переменных (`index.ts:111-112`).
Это окружение получают и прогон, и проверка источников (`sources/model-call.ts:78`), и doctor
(`doctor.ts:67`). Тест: `env.test.ts`. ✅

### 1.6 «Нет изменений — нет письма» (DLV-01)

`digest/build.ts:509` `hasContent` = есть хоть одна показанная страна; `runner/finalize.ts`: нет находок →
`email.state = not_needed`, письмо не ставится в очередь. Пробный прогон и «за период» писем не шлют.
Письмо о сбое — отдельно, только по COV-06. Тесты: `build.test.ts` («нет находок — письмо не нужно
(DLV-01)…»), `finalize.test.ts` (T-3 второй прогон, T-4). ✅

### 1.7 COV-01…06

| ID | Где | Тест | Вердикт |
|---|---|---|---|
| COV-01 | `orchestrator.ts:617` (`failed:<код>`), `:1374` (`changes`/`no_changes`) | orchestrator.test.ts | ✅ |
| COV-02 | `orchestrator.ts:1465` (`finished_at` только когда у всех стран итог) | orchestrator.test.ts | ✅ |
| COV-03 | `claude-runner.ts` (1 повтор) + `orchestrator.ts` (без второго повтора) | claude-runner.test.ts, orchestrator.test.ts | ✅ |
| COV-04 | `collector.ts:424` (`critical` по типу источника) | collector.test.ts, orchestrator.test.ts («сбор: …»), finalize.test.ts (T-5) | ✅ |
| COV-05 | `checks/anomaly.ts:21` (медиана 8 прогонов, окно ≥ 7 дней), `collector.ts:532` | anomaly.test.ts, collector.test.ts | ✅ |
| COV-06 (S) | `runner/finalize.ts:97` (`state/country_failures.json`, ≥ 2 подряд) | finalize.test.ts («COV-06…») | ✅ |

### 1.8 Приёмочные тесты T-1…T-21

| ID | Чем покрыт | Статус | Почему не done |
|---|---|---|---|
| T-1 | живой 18.11 (`scripts/t1.mjs`): 3254-1 и 3254-2 найдены | partial | весь ретро-прогон через оркестратор (127 актов, ≈ $65–150) не прогонялся; экран варианта B живьём не прогонялся |
| T-2 | живой `npm run golden` 18.11 | done | — |
| T-3 | юнит `finalize.test.ts` «T-3» (оркестратор + подставная почта) | partial | живой повторный прогон с реальной почтой — Mac |
| T-4 | юнит `finalize.test.ts` «T-4», orchestrator.test.ts (0 вызовов) | partial | живой прогон — Mac |
| T-5 | юнит `finalize.test.ts` «COV-06…», orchestrator.test.ts | partial | подмена URL на живом прогоне — Mac |
| T-6 | живой `scripts/t6.mjs --round2` 18.11 | done | — |
| T-7 | юнит executors.test.ts, build.test.ts | partial | показ `rejected` в окне не сделан |
| T-8 | юнит budget.test.ts | done | живая пауза — Mac (инструкция в FINDINGS «Фаза 8») |
| T-9 | юнит scheduler.test.ts «T-9…» ×2 | partial | реальный сон/перезапуск — Mac |
| T-10 | живой `scripts/sources-check.mjs --t10` | done | — |
| T-11 | — | blocked | живой прогон новой страны — Mac |
| T-12 | живой `scripts/t12.mjs` | done | — |
| T-13 | юнит claude-runner.test.ts, orchestrator.test.ts | done | — |
| T-14 | юнит evidence.test.ts, golden.test.ts, orchestrator.test.ts | done | — |
| T-15 | юнит orchestrator.test.ts | done | — |
| T-16 | живой `npm run golden` | ✅ | 19.11: после закрепления формата `location` 45 из 45 (до исправления было 30 из 45) |
| T-17 | — | blocked | ручной вызов `/analyze-act` в Claude Code — Mac |
| T-18 | юнит orchestrator.t18.test.ts (SIGKILL) | done | — |
| T-19 | юнит smtp/outbox (тексты ошибок) | blocked | реальный пароль приложения — Mac |
| T-20 | статический разбор README, чек-лист в FINDINGS «Фаза 10» | blocked | чистый macOS |
| T-21 | юнит mail-gate.test.ts, wizard/logic.test.ts, orchestrator.test.ts (гейт) | blocked | ручной проход мастера — Mac |

Итого: done 9 (T-2, T-6, T-8, T-10, T-12…T-15, T-18), partial 7 (T-1, T-3, T-4, T-5, T-7, T-9, T-16),
blocked 5 (T-11, T-17, T-19, T-20, T-21). Из обязательных для приёмки проекта (docs/07 §3: T-1, T-2, T-3,
T-4, T-10, T-16 на реальных данных) пройдены живьём T-2 и T-10; T-16 сейчас не проходит.

## 2. Требования Must: сверка с кодом

| ID | Требование (кратко) | Код (файл:строка) | Проверено (тест / вручную нужно) | Вердикт |
|---|---|---|---|---|
| CFG-01 | Всё изменяемое настраивается в окне приложения полями формы на русском. Ни одной… | renderer/pages/Settings.tsx:9; components/settings/*Section.tsx | CDP (фаза 2); фаза 11 — сверка полей docs/05 §6 со strings-settings.ts (см. §1) | ✅ |
| CFG-02 | У каждого поля: понятное название, подсказка «что это и зачем», пример, значение по… | components/settings/Field.tsx:17; main/settings/validate.ts:59 | validate.test.ts; фаза 11: у 27 из 30 полей подсказка+пример+умолчание, у 3 кнопок/показа — подсказка | ✅ |
| CFG-04 | Тема поиска — большое текстовое поле. По умолчанию — текст из 05-ui-and-settings.md | components/settings/SearchSection.tsx:23; runner/executors.ts:341 | executors.test.ts (topic во входе этапов) | ✅ |
| CFG-06 | Расписание: список расписаний (до 9, SCH-01); у каждого — название, флажки дней недели,… | settings/defaults.ts:13; components/settings/ScheduleSection.tsx; scheduler.ts | scheduler.test.ts, validate.test.ts, migrations.test.ts; окно — вручную | ✅ |
| CFG-07 | Почта: выбор почтового сервиса из списка (Gmail, Outlook/Hotmail, iCloud, Яндекс,… | components/settings/MailSection.tsx:53; mail/service.ts; settings/presets.ts:41 | smtp.test.ts, service.test.ts; **T-19 (реальное письмо) — blocked**; ссылка Gmail по curl 404 | ⚠ |
| CFG-08 | Язык отчёта: «Английский» / «Русский» / «Оба в одном письме» / «Два отдельных письма». По… | runner/finalize.ts:8 (plannedLangs) | finalize.test.ts (ru/en/both_one/both_two) | ✅ |
| CFG-09 | Расход: ползунок «Не тратить больше X% 5-часового лимита за раз» (по умолчанию 80%;… | components/settings/SpendSection.tsx; runner/budget.ts:13; settings/presets.ts:6 | budget.test.ts, stage-profiles.test.ts («пресет меняет модель») | ✅ |
| CFG-11 | Рабочая папка (архив) — выбор папки кнопкой. По умолчанию ~/RegWatch | components/settings/FoldersSection.tsx:25; settings/defaults.ts:8 | defaults.test.ts, workspace-dir.test.ts; вручную (~/RegWatch) | ✅ |
| CFG-12 | Промпты и скиллы фиксированы: в интерфейсе только просмотр. Настройки подставляются… | main/index.ts:574 (skills.read, только чтение); workspace.ts | workspace.test.ts (перезапись при старте) | ✅ |
| CFG-13 | Настройки хранятся в ~/Library/Application Support/RegWatch/settings.json с версией схемы… | settings/store.ts:10; settings/migrations.ts:130 | store.test.ts, migrations.test.ts | ✅ |
| CFG-14 | Почта обязательна. Пока не настроена и не проверена тестовым письмом, расписание и любые… | main/mail-gate.ts:5; run-controller.ts; wizard/logic.ts; pages/Home.tsx (баннер) | mail-gate.test.ts, orchestrator.test.ts («гейт почты»), wizard/logic.test.ts; T-21 вручную — blocked | ✅ |
| CTY-01 | Раздел «Страны»: таблица — переключатель «Участвует», флаг и название, число источников,… | components/countries/CountriesTable.tsx:16 | countries/logic.test.ts; CDP 17.11 | ✅ |
| CTY-02 | «Добавить страну»: выбор из списка стран (ISO-код подставляется сам), государственные… | components/countries/AddCountryDialog.tsx:14; countries/catalog.ts | catalog.test.ts, store.test.ts | ✅ |
| CTY-03 | Удаление страны с подтверждением; архив её прогонов не удаляется | countries/store.ts:240 removeCountry | store.test.ts (архив остаётся) | ✅ |
| CTY-04 | Клик по строке → карточка страны: источники и отслеживаемые акты | components/countries/CountryCard.tsx:23 | CDP: карточка UZ | ✅ |
| CTY-05 | Источник: адрес (URL), тип (Правовая база / Регулятор / Проекты актов / Новости), язык,… | components/countries/SourceForm.tsx:17; countries/store.ts:285 | store.test.ts, collector.test.ts («выключенный источник… не опрашиваются») | ✅ |
| CTY-06 | Отслеживаемые акты: название, номер регистрации, ссылка. Добавить / изменить / удалить | components/countries/ActsSection.tsx:57; collect/collector.ts:399 readWatched | store.test.ts, collector.test.ts; **канал А только для lex.uz** (collector.ts:416 — остальные пропускаются) | ⚠ |
| CTY-09 | Классы органов (новое): у страны есть список органов с классом: 1 — финансовые регуляторы… | collect/issuer-class.ts:72; components/countries/IssuerRules.tsx:14 | issuer-class.test.ts, countries/logic.test.ts; UI — два списка (класс 1, класс 2), а не таблица с выпадающим классом; нет «Новые» (органы из сбора) | ⚠ |
| CTY-07 | Выключенная страна не запускается и не входит в «проверено N/N»; журнал отправленного… | runner/orchestrator.ts:1437 (только active) | orchestrator.test.ts («выключенная не участвует»), store.test.ts | ✅ |
| CTY-08 | При первом запуске загружаются стартовые страны и источники из 08-countries-and-sources.md | countries/seed.ts:94 | seed.test.ts (9 стран, 28 источников) | ✅ |
| SRC-01 | Кнопка «Проверить источники» на трёх уровнях: источник, страна, все страны | sources/sources-controller.ts:14; components/countries/SourcesSection.tsx:76,82; pages/Countries.tsx:57 | sources-controller.test.ts; кнопки — вручную | ✅ |
| SRC-02 | Проверку делает скилл /verify-sources (только в рабочей папке приложения) | sources/checker.ts:604; skills/verify-sources/SKILL.md | checker.test.ts; живой 18.11 (UZ/KZ) | ✅ |
| SRC-03 | Проверяется: открывается без входа и капчи; официальный ли (домен госоргана/регулятора);… | sources/page-probe.ts:12; sources/checker.ts | checker.test.ts, page-probe.test.ts; живой: 28/28 кодом, 9 стран с моделью | ✅ |
| SRC-04 | Скилл предлагает профиль извлечения (RSS / HTML-список с селекторами / API). Код сам… | sources/checker.ts:23 profileHealthy; collect/profile.ts | checker.test.ts, profile.test.ts; живой cbu.uz | ✅ |
| SRC-05 | Итог: ✅ / ⚠ / ❌ с причиной простыми словами. ❌ не участвует в прогоне, у страны… | sources/reasons-ru.ts:6; sources/checker.ts; collect/collector.ts | checker.test.ts, collector.test.ts; T-10 живой | ✅ |
| RUN-01 | Запуск по расписаниям (CFG-06, SCH) | main/index.ts:23 createScheduler; scheduler.ts | scheduler.test.ts, run-controller.test.ts; в установленном приложении — вручную | ✅ |
| RUN-02 | Кнопки: «Проверить сейчас» (все / одна страна), «Пробный прогон» (без письма и без записи… | pages/Home.tsx:90 (три кнопки); run-controller.ts:71 | run-controller.test.ts; **кнопки «Проверить сейчас — одна страна» в окне нет** (бэкенд `countries` есть) | ⚠ |
| RUN-03 | Пропущенный прогон догоняется: если в момент расписания Mac спал, был выключен или… | scheduler.ts:114 dueRuns; index.ts:696 powerMonitor resume | scheduler.test.ts (T-9 ×2); реальный сон/перезапуск — Mac | ✅ |
| RUN-04 | Флажок «Запускать при входе в систему» (по умолчанию включён); приложение живёт в строке… | main/index.ts:492 setLoginItemSettings; index.ts:470 Tray | юнит-теста нет; перезагрузка Mac не проверялась | ⚠ |
| RUN-05 | Во время прогона Mac не засыпает (powerSaveBlocker), после — обычный режим. Уточнено: во… | runner/orchestrator.ts:174 powerSave; index.ts:80; auto-resume.ts | orchestrator.test.ts, auto-resume.test.ts | ✅ |
| RUN-06 | Прогон возобновляется с той страны, того акта и того этапа, где прервался (сон,… | runner/run-state.ts:190 resumePlan; auto-resume.ts:27 | run-state.test.ts, orchestrator.t18.test.ts (T-18), budget.test.ts (T-8) | ✅ |
| RUN-07 | Одновременно идёт только один прогон; повторное нажатие показывает текущий | runner/orchestrator.ts:1433 | orchestrator.test.ts («RUN-07…») | ✅ |
| RUN-09 | Окно поиска по стране — с даты последнего успешного прогона этой страны (для первой — 30… | runner/orchestrator.ts:274 computeWindow; finalize.ts markLastSuccess | orchestrator.test.ts, finalize.test.ts (T-4) | ✅ |
| SCH-01 | Несколько расписаний: от 1 до 9. У каждого: название (1–60 знаков), «включено», дни… | settings/validate.ts:24; components/settings/ScheduleSection.tsx | validate.test.ts, migrations.test.ts, sanitize.test.ts | ✅ |
| SCH-02 | Страны расписания: выбранные коды; пусто = все включённые страны на момент запуска.… | scheduler.ts:158 resolveCountries | scheduler.test.ts | ✅ |
| SCH-03 | Очередь: сработавшие вместе расписания (или пока идёт прогон) запускаются по очереди, по… | scheduler.ts:175 planQueue | scheduler.test.ts | ✅ |
| SCH-04 | Догон по каждому расписанию (RUN-03): за пропущенное время — не больше одного прогона, не… | scheduler.ts:114 dueRuns, :142 rebaseline | scheduler.test.ts | ✅ |
| SCH-05 | Местное время и переход часов: переход на летнее/зимнее время не даёт ни пропуска, ни… | scheduler.ts:44 slotOn | scheduler.test.ts (Europe/Berlin) | ✅ |
| COL-01 | Сбор делает код приложения: по профилям источников забирает списки документов, извлекает… | collect/collector.ts:273; collect/profile.ts; adapters/lexuz.ts | collector.test.ts («0 вызовов модели…»); живой UZ | ✅ |
| COL-02 | Каналы: А — история редакций отслеживаемых актов; Б — новые акты источников типа… | collect/collector.ts:172; runner/executors.ts:99 resolveLead | collector.test.ts, orchestrator.test.ts (NEWS); A — только lex.uz; В — у проектов UZ источник ❌; Г живьём не прогонялся | ⚠ |
| COL-03 | Учитываются все уровни актов: законы, указы и постановления президента, постановления… | collect/adapters/lexuz.ts:96 | живой прогон UZ (200 + 267 актов) | ✅ |
| COL-04 | Кандидаты сравниваются с журналом отправленного; уже отправленное без новой стадии — не… | runner/orchestrator.ts:56 filterCandidates; collector.ts:207 maybeUpdate | orchestrator.test.ts, ledger.test.ts | ✅ |
| COL-05 | Для каждого кандидата сохраняется снимок страницы/текста (HTML + извлечённый текст).… | collect/snapshot.ts:41; collect/pdf-text.ts:4 | snapshot.test.ts, pdf-text.test.ts; **акты 3976/3971/ЎРҚ-1189/1190 заново не сняты** (критерий приёмки) | ⚠ |
| COL-08 | Для каждого кандидата код определяет класс органа (CTY-09) по полю issuer и записывает… | checks/bank-terms.ts:81; collect/issuer-class.ts; runner/executors.ts:797 prepareScreen | bank-terms.test.ts, issuer-class.test.ts, orchestrator.screen.test.ts (а); запись в candidates.json тестом не проверена | ✅ |
| COL-06 | Сетевые запросы: таймаут 30 с, 2 повтора с паузой, вежливая задержка между запросами к… | collect/fetcher.ts:4,50 | fetcher.test.ts | ✅ |
| COL-07 | Для lex.uz (Узбекистан) — отдельный адаптер (новые акты по органам + история редакций… | collect/adapters/lexuz.ts:1 (ONDATE, редакции) | lexuz.test.ts; T-1 живой | ✅ |
| TRI-01 | Этап 2 — скилл /triage по названиям и аннотациям кандидатов против темы | runner/executors.ts:71; skills/triage | executors.test.ts; живой golden | ✅ |
| TRI-02 | Решения: relevant / borderline (в схеме допускается и псевдоним maybe) / irrelevant.… | schemas/triage.json:22; runner/screen.ts; orchestrator screenStage | schemas.test.ts, orchestrator.screen.test.ts | ✅ |
| TRI-03 | Каждое irrelevant — с кодом причины из фиксированного списка (04-schemas.md) | schemas/triage.json:26; checks/completeness.ts | schemas.test.ts, completeness.test.ts | ✅ |
| TRI-04 | Журнал отправленного по стране. Ключ: номер регистрации Минюста; если нет — номер | ledger.ts:18; runner/finalize.ts:28 commitSent | ledger.test.ts, finalize.test.ts (T-3) | ✅ |
| TRI-05 | Новая стадия уже отправленного акта (проект → принят → опубликован → вступил; изменение… | ledger.ts:60; digest/build.ts:393 | ledger.test.ts, build.test.ts | ✅ |
| SCR-01 | Этап SCREEN — скилл /screen-act, пакеты по 5 кандидатов. Для каждого relevant/borderline… | runner/screen.ts:42; skills/screen-act; schemas/screen.json | screen.test.ts, orchestrator.screen.test.ts; **живого экрана на модели нет** | ⚠ |
| SCR-02 | Подтверждение (sonnet, короткий ответ) для всякого none у кандидата из класса органов 1–2… | runner/screen.ts:104; runner/orchestrator.ts:158 | screen.test.ts, orchestrator.screen.test.ts (г); эталонов экрана на реальных данных нет | ⚠ |
| SCR-03 | Сомнительное идёт дальше: unsure после подтверждения и расхождение экрана с… | runner/screen.ts:80 | screen.test.ts, orchestrator.screen.test.ts | ✅ |
| SCR-04 | Нераспознанное — «не удалось проверить»: нет текста (COL-05 no_text), ошибка схемы после… | runner/orchestrator.ts:998; digest/build.ts:141 | orchestrator.screen.test.ts (б), build.test.ts | ✅ |
| ANA-01 | Скилл /analyze-act: один акт — один процесс claude -p. Изменено (вариант B): полный… | runner/executors.ts:12; orchestrator.ts | executors.test.ts, orchestrator.screen.test.ts (в) | ✅ |
| ANA-10 | В карточке /analyze-act дополнительно: headline (тема в 3–5 слов, для письма) и… | schemas/card.json:307; digest/build.ts | schemas.test.ts, build.test.ts; живой golden 19.11 — поля есть | ✅ |
| ANA-02 | Реквизиты: вид акта, орган, номер, дата принятия, номер и дата регистрации, дата… | schemas/card.json:44; skills/analyze-act | живой golden (T-2) | ✅ |
| ANA-03 | Что изменяет (базовый акт) и цепочка предыдущих поправок | schemas/card.json:135 | живой golden (T-2) | ✅ |
| ANA-04 | На кого распространяется и на кого нет | schemas/card.json:174 | живой golden (T-2) | ✅ |
| ANA-05 | Число изменений: по приложению к акту и по отметкам правовой базы, с объяснением… | schemas/card.json:190 | живой golden (T-2): 10/14 с объяснением | ✅ |
| ANA-06 | Каждое изменение: место (пункт), вид (изложен заново / дополнен / исключён / новая… | schemas/card.json:243 | живой golden 18.11 ✅; **19.11 T-16 30/45: формат места «Annex item N – para M»** | ⚠ |
| ANA-07 | Ссылки: изменяющий акт, текущая редакция, редакция на дату вступления в силу | schemas/card.json:274; digest/build.ts:136 («Читать:») | golden: ссылки совпали; открываемость по сети не проверяется | ⚠ |
| ANA-08 | Есть ли официальный русский текст; если нет — пометка «перевод неофициальный» | schemas/card.json:66; digest/build.ts:145 | build.test.ts | ✅ |
| ANA-09 | Пометка «Не является юридической консультацией» | digest/build.ts:144; digest/report.ts | build.test.ts, report.test.ts | ✅ |
| VER-01 | Скилл /verify-report — отдельный процесс со свежим контекстом (не видел анализа, видит… | runner/executors.ts:651; skills/verify-report | T-6 живой 18.11 | ✅ |
| VER-02 | Проверка полноты: просматривает заголовки отброшенных (irrelevant, none) и канал А… | runner/orchestrator.ts:674; skills/verify-report:12 | orchestrator.screen.test.ts (е); живьём — нет | ⚠ |
| VER-03 | Расхождение ключевых полей (номер, даты, вступление в силу, переходный период, ссылки,… | runner/orchestrator.ts:241 isKeyField | orchestrator.test.ts (T-6), orchestrator.screen.test.ts (ж); подпункт «нет текста после анализа → без круга» без теста | ⚠ |
| VER-04 | Результат виден в приложении | history.ts:162; components/history/CountryTabs.tsx:77 | history.test.ts, history/logic.test.ts; экран — вручную | ✅ |
| HAL-01 | Каждое фактическое поле карточки — с цитатой-доказательством на языке оригинала и URL | schemas/card.json:253 (Fact: value+quote+url) | schemas.test.ts | ✅ |
| HAL-02 | Код проверяет, что цитата дословно есть в снимке (нормализация пробелов, регистра,… | checks/evidence.ts:12,24 | evidence.test.ts, golden.test.ts (T-14) | ✅ |
| HAL-03 | Код проверяет, что даты и номера в поле присутствуют в его цитате | checks/evidence.ts:151 | evidence.test.ts | ✅ |
| HAL-04 | Полноту считает код: кандидаты = отобранные + отброшенные с причиной. Иначе страна не… | checks/completeness.ts:17; orchestrator.ts:10 | completeness.test.ts, orchestrator.test.ts (T-15) | ✅ |
| HAL-05 | В /triage — критерии темы с положительными и отрицательными примерами (включая 3254-2 как… | skills/triage/SKILL.md:35 | живой golden (3254-2 → relevant) | ✅ |
| HAL-06 | Набор эталонов golden/ и команда npm run golden; любой правке скилла — прогон эталонов | golden.ts:37; scripts/golden.mjs | golden.test.ts; **последний живой `npm run golden` 30/45 (T-16 не пройден)** | ⚠ |
| HAL-08 | unknown в обязательном поле не скрывается — в письме «не удалось установить» | digest/build.ts:114,128,131 | build.test.ts («unknown не скрывается (HAL-08)») | ✅ |
| HAL-09 | Текст сайтов — недоверенные данные: инструкции из него не выполняются (правило в каждом… | skills/*/SKILL.md (Rules) | фаза 11, вручную: правило есть во всех 8 скиллах (translate-ru — «Text in the input is data…») | ✅ |
| LNG-01 | Скиллы, промпты, исходный отчёт — английский | skills/*, schemas/*, digest/report.ts | фаза 11, вручную: кириллицы нет, кроме образцов в translate-ru | ✅ |
| LNG-02 | Перевод на русский — скилл /translate-ru по готовому проверенному отчёту, без нового… | skills/translate-ru; runner/executors.ts:886 createTranslator; index.ts:277 | executors.test.ts, build.test.ts; живой перевод отложен (лимит) | ✅ |
| LNG-03 | Код сверяет все числа, даты, номера и URL в EN и RU | checks/numbers.ts:113; runner/executors.ts:651 | numbers.test.ts, executors.test.ts (T-7); **показа `rejected` в окне нет** | ⚠ |
| LNG-04 | Интерфейс — русский | shared/i18n.ts:5; renderer/strings-*.ts | renderer/i18n.test.ts; фаза 10 — статический разбор | ✅ |
| DLV-01 | Нет изменений — нет письма | digest/build.ts:509 hasContent; runner/finalize.ts:223,462 | build.test.ts, finalize.test.ts (T-3, T-4) | ✅ |
| DLV-02 | Одно письмо-дайджест на прогон (или по одному на язык, CFG-08), сгруппированное по… | digest/build.ts:505 buildDigest; runner/finalize.ts | build.test.ts («эталон 24/2…»), finalize.test.ts | ✅ |
| DLV-04 | Письмо в HTML с текстовой версией; читается на телефоне | digest/build.ts:497 (viewport, 640) | build.test.ts («HTML: …»); вид на телефоне — вручную | ✅ |
| DLV-05 | Отправка по SMTP (nodemailer) из самого приложения с пресетами сервисов; пароль… | mail/smtp.ts:3; index.ts:196 (пароль из safeStorage в main) | smtp.test.ts, outbox.test.ts; **T-19 blocked** | ⚠ |
| DLV-06 | Не ушло (нет сети, ошибка сервера) → повтор через 15 мин, до 6 раз; отчёт всё равно в… | mail/outbox.ts:5; index.ts (таймер очереди) | outbox.test.ts, finalize.test.ts | ✅ |
| ARC-01 | Всё раскладывается по датам и странам в рабочей папке (структура — 02-architecture.md §5) | archive.ts:7 | archive.test.ts; раскладка построчно с docs/02 §5 не сверялась | ⚠ |
| ARC-02 | Сохраняются: кандидаты, отобранные и отброшенные с причинами, снимки, карточки,… | runner/orchestrator.ts:992; runner/finalize.ts:537 (digest.*); collect/snapshot.ts | orchestrator.test.ts, finalize.test.ts; полный набор файлов реального прогона не сверялся | ⚠ |
| ARC-03 | Раздел «История»: дата → страна → отчёт / проверка / источники / лог; кнопка «Открыть… | history.ts:322; pages/History.tsx:10; components/history/* | history.test.ts, history/logic.test.ts; экран — вручную | ✅ |
| ARC-04 | Отчёт по стране — report.en.md / report.ru.md, человекочитаемый | digest/report.ts:309 | report.test.ts, history.test.ts; report.ru.md — по-русски только подписи (FINDINGS «Фаза 7») | ⚠ |
| COV-01 | Каждая активная страна получает статус changes / no_changes / failed:<причина> | runner/orchestrator.ts:617,1374 | orchestrator.test.ts | ✅ |
| COV-02 | Прогон завершён, только когда статус есть у каждой активной страны | runner/orchestrator.ts:1465 | orchestrator.test.ts | ✅ |
| COV-03 | Этап без результата → 1 повтор → failed с причиной | runner/claude-runner.ts; orchestrator.ts:617 | claude-runner.test.ts, orchestrator.test.ts | ✅ |
| COV-04 | Недоступный источник → failed:source, а не no_changes (если это единственный источник… | collect/collector.ts:424 critical | collector.test.ts, orchestrator.test.ts («сбор: …»), finalize.test.ts (T-5) | ✅ |
| COV-05 | 0 документов у источника, где обычно они есть (медиана последних 8 прогонов > 0, окно ≥ 7… | checks/anomaly.ts:21; collector.ts:532 | anomaly.test.ts, collector.test.ts | ✅ |
| SKL-01 | Каждое действие модели — отдельный скилл в skills/<имя>/SKILL.md, копируется в <рабочая… | workspace.ts:180 (8 скиллов) | workspace.test.ts | ✅ |
| SKL-02 | Единый шаблон скилла (03-skills.md §2) | skills/*/SKILL.md | фаза 11, вручную: шаблон есть у всех; **news-sweep и discover-sources — общие правила docs/03 §3 не дословно** | ⚠ |
| SKL-03 | Скилл получает только свои данные (пути к файлам страны и акта, тему, perspective) | runner/executors.ts:5 (input.json страны/акта) | executors.test.ts, checker.test.ts («NFR-05…») | ✅ |
| SKL-05 | Правки скиллов в рабочей папке вручную перезаписываются при старте; в интерфейсе… | workspace.ts; strings-settings.ts:200 (плашка) | workspace.test.ts | ✅ |
| PRM-01 | Модель запускается только claude -p, без PTY | runner/claude-runner.ts:13 (spawn, без PTY) | claude-runner.test.ts | ✅ |
| PRM-02 | Всегда --permission-mode dontAsk: неразрешённое отклоняется сразу | runner/stage-profiles.ts:230 | stage-profiles.test.ts; T-12 живой | ✅ |
| PRM-03 | Права этапов задаёт код флагами по таблице 02-architecture.md §6 | runner/stage-profiles.ts:67-104 | stage-profiles.test.ts («права этапов по таблице docs/02 §6»); фаза 11 — сверка вручную (§2) | ✅ |
| PRM-04 | WebFetch ограничен доменами источников страны со статусом ✅ (WebFetch(domain:…)) | runner/stage-profiles.ts:209-213; executors.ts allowedDomains | stage-profiles.test.ts, executors.test.ts; отклонение: ✅ и ⚠ (FINDINGS «Фаза 6: PRM-04») | ✅ |
| PRM-05 | Модель ничего не пишет на диск: ответ только в stdout по JSON-схеме, файлы пишет код.… | runner/stage-profiles.ts:64 | stage-profiles.test.ts; T-12 | ✅ |
| PRM-06 | Bash и Agent запрещены модели на всех этапах | runner/stage-profiles.ts:64 | stage-profiles.test.ts; T-12 живой | ✅ |
| PRM-07 | Таймаут процесса и --max-turns на этап; превышение → убить, 1 повтор, failed:timeout | runner/claude-runner.ts:8; stage-profiles.ts:187 | claude-runner.test.ts (T-13) | ✅ |
| PRM-10 | Пользовательские настройки Claude Code не должны расширять права этапов (флаг… | runner/stage-profiles.ts:232-234 (--setting-sources project, --strict-mcp-config) | stage-profiles.test.ts; FINDINGS фаза 0 | ✅ |
| NFR-01 | Полнота важнее экономии. Уточнено: ни одно существенное для темы изменение не теряется;… | runner/screen.ts; checks/completeness.ts; collect/issuer-class.ts | T-1 живой (до варианта B); screen.test.ts; **замер на 6+6 эталонах прогона 2026-11-18_1517 не сделан** | ⚠ |
| NFR-02 | Каждое утверждение подкреплено ссылкой, которую агент реально открыл | checks/evidence.ts (цитаты по снимку) | golden; **кодом не проверяется, что URL факта реально открывался** | ⚠ |
| NFR-03 | Числа, пункты и даты — из текста акта | checks/evidence.ts | T-2 живой | ✅ |
| NFR-04 | Оркестратор — код, не модель | runner/orchestrator.ts:1404 | orchestrator.test.ts | ✅ |
| NFR-05 | Изоляция: страна × этап — отдельный процесс; на анализе — акт = процесс | runner/executors.ts:151 | orchestrator.test.ts, executors.test.ts | ✅ |
| NFR-06 | 5-часовой лимит: перед каждым процессом код оценивает долю лимита; выше порога (CFG-09) —… | runner/budget.ts:107; auto-resume.ts | budget.test.ts (T-8), auto-resume.test.ts; живая пауза — Mac | ✅ |
| NFR-07 | Экономия: этап 1 без модели; дешёвая модель на отбор и перевод; сильная — только на… | runner/orchestrator.ts:575; settings/presets.ts | orchestrator.test.ts (0 вызовов без кандидатов), finalize.test.ts (T-4) | ✅ |
| NFR-09 | Платформа: macOS 13+ (Apple Silicon и Intel), Electron + TS + React, без нативных модулей | package.json (Electron + TS + React); scripts/app.mjs:92 (arm64/x64) | npm run build на этой машине (arm64); Intel и macOS 13 не проверены | ⚠ |
| NFR-10 | Через установленный и залогиненный Claude Code CLI (подписка), API-ключ не нужен | doctor.ts:36; env.ts | doctor.test.ts; npm run doctor | ✅ |
| NFR-11 | Окружение claude: из login shell, без CLAUDE_/CLAUDECODE | env.ts:37-45; index.ts:111 | env.test.ts; проверено на машине (11 переменных CLAUDE_*) | ✅ |
| NFR-12 | Секреты в safeStorage, не в файлах, не в renderer | secrets.ts:1; index.ts:196,659 | secrets-store.test.ts, secrets-has.test.ts; фаза 11 вручную (§3) | ✅ |
| NFR-13 | Лог по стране: источники, найденное, отброшенное и почему, каждый процесс модели (этап,… | archive.ts:55 appendLog; orchestrator.ts:565 | orchestrator.test.ts; полноту журнала по реальному прогону не сверяли | ⚠ |
| NFR-14 | Новая страна — без правки кода | countries/store.ts:225 addCountry | store.test.ts; T-11 blocked | ✅ |
| NFR-17 | Тесты чистой логики на node:test: журнал, статусы, расписание и догон, проверка цитат,… | src/**/*.test.ts | npm test 674/674 | ✅ |
| NFR-18 | Все тексты ошибок для пользователя — по-русски, без стектрейсов, с тем, что делать | mail/smtp.ts:112 translateMailError; settings/validate.ts; sources/reasons-ru.ts | smtp.test.ts, checker.test.ts; сплошной сверки всех текстов ошибок не было | ⚠ |
| INS-01 | Установка тремя командами: git clone …, npm install, npm run app | scripts/app.mjs:150 | на этой машине; **T-20 blocked**; адрес git-репозитория в README не подставлен | ⚠ |
| INS-02 | npm install не требует Xcode, Python, node-gyp | package.json | фаза 11 вручную: нет binding.gyp/install-сборки | ✅ |
| INS-03 | npm run doctor и экран первого запуска проверяют: версия Node, найден ли claude, выполнен… | doctor.ts:14; doctor-cli.ts:7; StepComputer.tsx | doctor.test.ts; npm run doctor | ✅ |
| INS-04 | Мастер первого запуска: рабочая папка → почта (с тестовым письмом) → тема → страны →… | pages/Wizard.tsx:9; components/wizard/* | wizard/logic.test.ts; CDP шаги 1–3; **T-20 blocked** | ⚠ |
| INS-05 | README.ru.md для пользователя: установка, первый запуск, настройка почты по сервисам,… | README.ru.md | статический разбор (фаза 10); **T-20 blocked** | ⚠ |
| INS-06 | Обновление: git pull && npm install && npm run app, настройки сохраняются | README.ru.md:374; scripts/app.mjs | данные вне репозитория; живой `git pull` не проверялся | ⚠ |

## 3. Пробелы

Объём: **мало** — до дня, правка в одном-двух местах; **средне** — несколько файлов, новый тест или живой
прогон; **много** — новая подсистема.

### 3.1 Критично для пользователя

| № | Требования | Что не сделано | Объём |
|---|---|---|---|
| 1 | T-16, HAL-06, ANA-06 | **Закрыто 19.11.2026:** формат `location` закреплён в `skills/analyze-act/SKILL.md`, живой `npm run golden` — 45 из 45. (Остаётся: golden обязателен после любой правки скиллов, в том числе `screen-act` и `translate-ru`, которые в эталон не входят.) | — |
| 2 | T-19, T-21, T-20, CFG-07, DLV-05, INS-01/04/05/06 | Нет ни одной проверки на Mac пользователя: реальное тестовое письмо, мастер без почты, чистая установка, обновление через `git pull`. В README не подставлен адрес git-репозитория. Ссылка Gmail «Как получить пароль» по curl отдавала 404 (`settings/presets.ts`, `shared/mail-links.ts`; README уже даёт `?hl=en`), у Mail.ru ссылка ведёт на общую страницу | мало (код) + действия пользователя по чек-листу FINDINGS «Фаза 10» |
| 3 | COL-02, CTY-06, SRC-03 | У KZ, KG, TM, AZ, MN правовые базы строят список документов JavaScript-ом, код их не читает (источники ⚠). Канал А (новые редакции отслеживаемых актов) работает только для lex.uz: у остальных стран акт пропускается с записью в журнал (`collector.ts:416`). Для 5 из 9 стран покрытие фактически держится на сайтах ЦБ и новостях. Идея из HANDOFF: рендерить такие страницы скрытым окном Electron, без нативных модулей | много |
| 4 | SCR-01, SCR-02, NFR-01 | Экран по тексту (вариант B) ни разу не запускался на реальной модели. Не доказано, что дешёвая модель с перепроверкой не теряет `material`. Нужны эталоны 6 существенных + 6 шумовых актов из прогона 2026-11-18_1517 (только реальные данные, правило 7) и прогон `scripts/replay.mjs` | средне |
| 5 | RUN-02 | **Закрыто 21.11.2026:** кнопка «Проверить эту страну» в `CountryCard.tsx`. (Было: в окне нет «Проверить сейчас» для одной страны.) Бэкенд это умеет (`RunStartOptions.countries`), не хватает кнопки в карточке страны (`CountryCard.tsx` → `rw.run.start('manual', { countries: [code] })`) | мало |
| 6 | LNG-03, T-7 | Отвергнутые сверкой EN/RU фрагменты перевода (`rejected`) пишутся в `<прогон>/translate/result.json`, но в окне не показываются. В письме стоит английский оригинал с пометкой «Перевод неполный», а в приложении этого не видно | мало–средне |
| 7 | NFR-02 | Код не проверяет, что URL факта в карточке действительно открывался: цитата сверяется со снимком (HAL-02), но поле `url` — нет. Ссылки проверяет только модель-верификатор (VER-03, ключевые поля `links.*`) | средне |
| 8 | docs/05 §6.4, NFR-08 | **Закрыто 21.11.2026:** блок показывает реальные данные последнего прогона (SpendSection.tsx). (Было: в Настройках → Расход поле «Расход последнего прогона» — заглушка («Данных ещё нет»). Расход виден только в окне «Прогон» | мало |
| 9 | RUN-04 | Нет юнит-теста автозапуска при входе, после перезагрузки Mac не проверялось | мало (ручная проверка) |
| 10 | SKL-02 (docs/03 §3) | В `news-sweep` и `discover-sources` общие правила вставлены не дословно: нет «You are one step…», «Use only the data…», «Do not try tools…». Скиллы не правились: после правки нужен живой прогон | мало (+ живая проверка) |

### 3.2 Желательно

| № | Требования | Что не сделано | Объём |
|---|---|---|---|
| 11 | CTY-09, docs/05 §4 | «Органы и уровень отбора» сделаны двумя списками (класс 1, класс 2; остальные — класс 3), а не таблицей с выпадающим классом. Нет списка «Новые» (органы, замеченные при сборе и не внесённые в список) и кнопки «Добавить орган» | средне |
| 12 | docs/05 §3 | **Закрыто 21.11.2026** (Home.tsx, components/home/logic.ts): предупреждения об источниках ❌, странах со сбоем и паузе. (Было: на Главной нет предупреждений «источники с ❌» и «страны со сбоями». Неотправленное письмо видно в окне «Прогон». Пока прогон стоит на паузе по лимиту, строка статуса на Главной показывает «Следующая проверка»; сама пауза видна в окне «Прогон» и в пояснении | мало |
| 13 | ARC-04 | В `report.ru.md` по-русски только подписи, содержание английское (решение фазы 7, FINDINGS) | средне |
| 14 | VER-03 | Нет теста: карточка `unconfirmed` из-за отсутствия текста после анализа → без второго круга | мало |
| 15 | COL-08 | Нет теста на то, что класс органа и банковские термины записываются в `candidates.json` | мало |
| 16 | COL-05 | Снимки актов 3976, 3971, ЎРҚ-1189, ЎРҚ-1190 (критерий приёмки) не сняты заново с извлечением текста из PDF | мало (живой сбор, без модели) |
| 17 | ARC-01, ARC-02, NFR-13 | Раскладка архива и полнота журнала на реальном прогоне построчно с docs/02 §5 не сверены | мало |
| 18 | NFR-09, NFR-16 | Не проверены Intel и macOS 13; длительность девяти стран — оценка по замеру Узбекистана (FINAL-REPORT §2.2–2.4), живой прогон девяти стран не делался | действия на Mac |
| 19 | HAL-07, SRC-07, SRC-09, CFG-15, DLV-07, SKL-04 (S) | Живые прогоны и ручные проверки: модель по случаям из приложения, поиск источников и основных законов, уведомление macOS, ручной `/analyze-act` (T-17). У поля модели «Экрана» нет подсказки из docs/05 §6.4 | мало–средне |
| 20 | TRI-06, DLV-08 (C) | Напоминание до вступления в силу и Telegram не делались (приоритет C) | средне |
| 21 | docs/05 §6.2 | Мелочи текста: нет фразы «страна из двух расписаний проверится один раз». Подпись «по умолчанию: Расписание 1» относится к новому расписанию, а стандартное называется «Основная проверка» | мало |

## 4. Что исправлено в ходе аудита

- `src/renderer/components/settings/ScheduleSection.tsx`: показана подсказка к переключателю «Включено»
  расписания. Строка `enabledHint` была, но не выводилась (правило 4 CLAUDE.md, CFG-02). Это React-разметка
  без юнит-теста; проверено `npm run typecheck`.
- `docs/01-requirements.md` SKL-01: «7 скиллов» → «8 скиллов» (добавлен `screen-act`, SCR-01; код и
  `workspace.test.ts` уже копировали 8).
- `docs/07-test-plan.md`: строка T-21 была отделена от таблицы пустой строкой и не входила в таблицу.
- `docs/TRACEABILITY.md`: восстановлены 3 сломанные строки (DLV-06, DLV-07, COV-06 без колонки
  «Требование»), исправлены 4 ссылки на несуществующие названия тестов. Из 6 строк `done` без
  доказательства 4 получили запись о проверке (ANA-03, ANA-04, LNG-01, INS-02), а ANA-06 и SKL-02
  понижены до `partial` с причиной. Устаревшие «фаза N» в 24 строках заменены текущим состоянием
  со ссылками на тесты; повышены до `done` только строки с тестом
  (CFG-04, CFG-10, CTY-07, TRI-05, SCR-04, HAL-08, LNG-04, COV-05, NFR-08, NFR-15, NFR-17). T-11, T-17,
  NFR-16 переведены из `todo` в `blocked` с причиной. Юнит-набор `digest.test.ts` соотнесён с
  `build.test.ts` и `finalize.test.ts`.
- `scripts/trace-audit.mjs` + `npm run audit`. Запускать через `npm run audit`: команда `npm audit`
  без `run` вызывает встроенную проверку уязвимостей npm.
