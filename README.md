# RegWatch

RegWatch is a macOS desktop app (Electron, TypeScript, React) that checks on a schedule for changes in
banking and corporate regulation in nine countries of Central Asia, the Caucasus and Mongolia, and emails
a digest **only when something new is found**. The default focus is a private-equity investor in the capital
of financial institutions; the topic and the viewpoint are editable in the app.

All model work goes through the user's installed Claude Code CLI (`claude -p`) on their subscription. No API key.

## What it does

- Runs on a schedule (for example, Mondays 08:00) and reads official legislation and regulator websites for the countries you enable: Uzbekistan, Kazakhstan, Kyrgyzstan, Tajikistan, Turkmenistan, Georgia, Armenia, Azerbaijan, Mongolia.
- Finds new and amended acts, screens them against your topic, and analyses the relevant ones: what changed, effective date, transition period, who is affected.
- Every extracted value (act number, dates, quoted points) is checked against the act text by code; findings it cannot confirm are flagged "unconfirmed".
- Sends **one email, and only if something new was found**. No changes means no email.
- Reports are written in English; the app can add a Russian version (UI and e-mail language are settings).
- Everything is configured in the app window: there are no config files to edit.

RegWatch is a screening aid, not legal advice. Always check important findings against the act itself.

## Requirements

- macOS 13 or newer (Apple Silicon or Intel)
- Node.js 22.18 or newer (<https://nodejs.org>, LTS installer)
- Git
- Claude Code installed and signed in to your Claude account: `npm install -g @anthropic-ai/claude-code`, then run `claude` once and log in. Check with `claude -p "reply: ok"`.
- A mailbox that can send through SMTP with an **app password** (Gmail, Outlook, iCloud, Yandex, Mail.ru, or any SMTP server)

No Xcode, Python or compilers are needed: the project has no native modules.

## Install on a new Mac

Open Terminal (Cmd+Space, type "Terminal") and run:

```bash
git clone https://github.com/OlegYaro/Jan_Analytical_news_platform.git
cd Jan_Analytical_news_platform
npm install
npm run app
```

Before installing, check `node --version` (it must print v22.18 or newer; older Node fails with confusing errors). Optionally run `npm run doctor` (also needs Node 22.18+): it checks Node, Claude Code and sign-in and tells you what to fix.

`npm run app` builds the app, ad-hoc signs it, installs it to `/Applications/RegWatch.app`
(or `~/Applications` if there is no write access) and launches it. The first build takes a few minutes.

If macOS says it cannot verify the developer: **System Settings → Privacy & Security → scroll down → "Open Anyway"**.
The app is built on your own machine and is not signed with a paid Apple certificate. This is shown only once.

RegWatch lives in the menu bar. Closing the window does not stop scheduled checks; use menu bar icon → Quit to stop it.

## First launch: setup wizard

An 8-step wizard opens on first launch:

1. **Computer check**: Node, Claude Code, sign-in. Fix any ❌ using the hint and press "Check again".
2. **Reports folder**: default `~/RegWatch`. Avoid Documents/Desktop/Downloads (macOS prompts).
3. **E-mail** (mandatory, see below).
4. **What to look for**: topic and "evaluate significance for" (default: a private-equity investor in bank capital). Both are plain-text fields.
5. **Countries**: switch on the ones you need.
6. **Schedule**: up to 9 schedules with their own days, time and countries; "Run at login"; "Catch up if the Mac was off".
7. **Source check**: optional check that the listed websites can be read.
8. **Done**: shows the next check. "Run a dry run now" runs a check without sending e-mail.

## E-mail setup

Mail is required: without a verified test e-mail, scheduled checks and the "Check now" button are blocked.

1. Choose the mail service (Gmail, Outlook, iCloud, Yandex, Mail.ru or "Other"; "Other" asks for server, port and encryption).
2. Enter **your address**: the sender of the reports.
3. Create an **app password** (not your normal password) at your mail provider. This usually needs two-step verification enabled. Paste it into the field and press **Save password**. It is stored encrypted via the macOS keychain (Electron `safeStorage`) and is never shown again.
   - Gmail: <https://support.google.com/accounts/answer/185833> (if you get a 404, add `?hl=en`)
   - iCloud: <https://support.apple.com/102654>
   - Outlook: <https://support.microsoft.com/account-billing/5896ed9b-4263-e681-128a-a6f2979a7944> (work Microsoft 365 accounts often forbid app passwords)
   - Yandex: <https://yandex.ru/support/id/authorization/app-passwords.html>
   - Mail.ru: search "app password mail.ru" in your security settings
4. **Send to**: one or more addresses separated by commas (default: your address).
5. Pick the report language and whether to warn about failures.
6. Press **Send test e-mail** and check the inbox (and Spam). When it arrives the app shows "Mail verified ✅".

If macOS asks for keychain access when you save the password, choose **Allow** (or **Always Allow**). If you denied it by mistake, restart RegWatch and save the password again.
If a digest cannot be sent, RegWatch retries every 15 minutes up to 6 times; the queue survives restarts.

## Usage and cost

- **Home**: status, next check, "Check now", "Dry run (no e-mail)", "Check for a period…". A dry run never changes the check window. "Check for a period" sends no e-mail and writes no sent-log, but moves the country's check date to the end of the period when the period continues directly from the last checked date.
- The app shows an estimate of the next check (dates, cost, share of the 5-hour Claude limit) and the real usage after each run.
- Work goes through your Claude subscription. A "do not spend more than X % of the 5-hour limit" slider pauses a run and resumes it automatically.
- A first check of a country covers the last 30 days (a setting). It is the most expensive; later weekly checks are much cheaper.

## Update

```bash
cd Jan_Analytical_news_platform
git pull
npm install
npm run app
```

Settings, countries, the archive and the sent-log live outside the repository and are kept.

## Uninstall

Quit RegWatch, move `RegWatch.app` to the Trash, remove it from Login Items, and optionally delete `~/Library/Application Support/RegWatch` (settings) and `~/RegWatch` (reports and archive).

## Troubleshooting

| Problem | What to do |
|---|---|
| "Claude Code not found" | `npm install -g @anthropic-ai/claude-code`, run `claude` and sign in, then "Check again" |
| "Not signed in" | Run `claude` in Terminal and log in |
| "Update Claude Code" | `claude update` |
| Old Node | Install the LTS from <https://nodejs.org> and reopen Terminal |
| Test e-mail fails | Use an app password, press Save password first, check the server/port for "Other" |
| Run paused | Normal: the 5-hour limit was reached; it resumes by itself |
| Blank window | Press "Reload", or quit from the menu bar and reopen |

Full user guide in Russian: [README.ru.md](README.ru.md).

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Run in development mode |
| `npm run typecheck` | `tsc` for main/preload/shared and renderer |
| `npm test` | Unit tests (`node:test`, pure logic, no network) |
| `npm run doctor` | Check the environment: Node, `claude`, sign-in, required CLI flags, workspace access |
| `npm run golden` | Run the golden reference cases against the live `claude` (costs usage limit; required after any skill edit) |
| `npm run app` | Build and install `RegWatch.app` (do not run it from inside an installed RegWatch session) |

Check any change with `npm run typecheck && npm test`.

## Rules

- The orchestrator is code, not the model: country order, statuses, retries, budget, completeness and quote checks are TypeScript. The model is called for narrow stages through skills.
- The model is started only as `claude -p` (no PTY, no interactive TUI) with `--permission-mode dontAsk`, explicit `--tools`, `--allowedTools`, `--disallowedTools`, `--output-format json`, `--json-schema` and a process timeout. Bash and Agent are denied to the model everywhere.
- No native modules (no node-pty, Swift, node-gyp).
- Every setting is a field in the app window; prompts and skills are not user-editable.
- Secrets only through Electron `safeStorage`, never passed to the renderer.
- Completeness beats token savings: checks are never weakened to spend less.

## Documents (`docs/`)

| File | Contents |
|---|---|
| `01-requirements.md` | All requirements with IDs |
| `02-architecture.md` | Modules, pipeline, data, processes, permissions |
| `03-skills.md` | Model skills: set, permissions, rules (texts are in `skills/`) |
| `04-schemas.md` | JSON schemas of model answers and state files |
| `05-ui-and-settings.md` | Screens, settings fields, hint texts |
| `06-installation.md` | Installation and first launch |
| `07-test-plan.md` | Tests and acceptance |
| `08-countries-and-sources.md` | Starting countries, sources, tracked acts |
| `09-implementation-plan.md` | Phases and their exit criteria |
| `10-lessons-from-claude-asist.md` | Claude Code CLI pitfalls found in practice |
| `golden/` | Reference case for the control test |
| `TRACEABILITY.md` | Requirement and test IDs, where implemented, how verified, status |
| `FINDINGS.md` | What turned out in practice (CLI flags, site behaviour, deviations from the documents) |
| `HANDOFF.md` | Where the work stopped |

The documents are the source of truth; skill texts are in `skills/*/SKILL.md` (English).

## Disclaimer

RegWatch is a screening aid, not legal advice.
