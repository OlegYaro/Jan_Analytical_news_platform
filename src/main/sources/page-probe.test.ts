// Эвристики страницы и перевод причин (фаза 6). Страницы — SYNTHETIC (./fixtures) и сохранённый lex.uz.
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { analyzePage, readableHtml, siteOf, softRedirect, unreachableReason } from './page-probe.ts';
import { FORBIDDEN_UI_WORDS, GENERIC_REASON_RU, REASON_RU, reasonCode, translateReason, translateReasons } from './reasons-ru.ts';

const FIX = resolve(import.meta.dirname, 'fixtures');
const LEX = resolve(import.meta.dirname, '..', 'collect', 'fixtures');
const fx = (n: string): string => readFileSync(join(FIX, n), 'utf8');

test('analyzePage: форма пароля → вход; SPA → нужен JavaScript; обычная страница — ни то ни другое', () => {
  const login = analyzePage(fx('synthetic-login.html'), 'https://x.example/login', 'text/html');
  assert.ok(login.loginRequired && login.passwordField);
  const spa = analyzePage(fx('synthetic-spa.html'), 'https://x.example/', 'text/html');
  assert.ok(spa.needsJs && !spa.loginRequired);
  const list = analyzePage(fx('synthetic-acts-list.html'), 'https://x.example/ru/acts', 'text/html');
  assert.ok(!list.loginRequired && !list.needsJs && !list.captcha);
  const captcha = analyzePage('<html><head><title>Just a moment...</title></head><body><div class="cf-turnstile"></div></body></html>', 'https://x.example/', 'text/html');
  assert.ok(captcha.captcha);
  // большая содержательная страница с формой входа в шапке — НЕ «нужен вход»
  const big = `<html><body><form><input type="password"></form><main>${'<p>Текст новости о банковском регулировании.</p>'.repeat(80)}</main></body></html>`;
  assert.ok(!analyzePage(big, 'https://x.example/', 'text/html').loginRequired);
  assert.equal(analyzePage('<?xml version="1.0"?><rss><channel></channel></rss>', 'https://x/rss', 'application/rss+xml').format, 'xml');
});

test('readableHtml: без скриптов и стилей, по строке на метку; селекторы дают то же, что на исходной странице', () => {
  const raw = readFileSync(join(LEX, 'lexuz-official-week.html'), 'utf8');
  const r = readableHtml(raw);
  assert.doesNotMatch(r, /<script/i);
  assert.doesNotMatch(r, /<style/i);
  assert.ok(r.split('\n').every((l) => l.length < 5000), 'нет сверхдлинных строк');
  for (const sel of ['tr.dd-table__main-item', 'a.lx_link', '.badge']) assert.equal(load(r)(sel).length, load(raw)(sel).length, sel);
});

test('siteOf и unreachableReason', () => {
  assert.equal(siteOf('https://www.adilet.zan.kz/rus'), 'zan.kz');
  assert.equal(siteOf('https://www.gov.kz/memleket/entities/ardfm'), 'www.gov.kz'.replace(/^www\./, ''));
  assert.equal(siteOf('https://minjust.gov.tm'), 'minjust.gov.tm');
  assert.equal(siteOf('lex.uz'), 'lex.uz');
  const t = unreachableReason({ url: 'u', ok: false, otherSite: false, failKind: 'timeout', failMessage: 'Сайт не отвечает за 45 секунд', format: 'other', loginRequired: false, captcha: false, needsJs: false, passwordField: false, visibleTextLength: 0, scriptCount: 0 });
  assert.equal(t, 'Сайт не открывается: сайт не отвечает за 45 секунд. Проверьте адрес источника');
});

test('перевод причин модели: словарь, неизвестное → общая фраза, без технических слов', () => {
  const cases: Array<[string, keyof typeof REASON_RU]> = [
    ['requires login', 'login'],
    ['captcha', 'captcha'],
    ['not an official site', 'not_official'],
    ['content does not match the declared type', 'type_mismatch'],
    ['no dated list of documents', 'no_listing'],
    ['list is rendered by JavaScript', 'needs_js'],
    ['documents only as PDF files', 'pdf_only'],
    ['list not updated for a long time', 'stale'],
    ['site is unreachable (timeout)', 'unreachable'],
    ['CSS selector did not match', 'profile_failed'],
  ];
  for (const [en, code] of cases) {
    assert.equal(reasonCode(en), code, en);
    assert.equal(translateReason(en), REASON_RU[code]);
  }
  assert.equal(translateReason('quantum flux in the archive'), GENERIC_REASON_RU);
  assert.deepEqual(translateReasons(['site is reachable', 'requires login', 'login form shown']), [REASON_RU.login]);
  for (const ru of [...Object.values(REASON_RU), GENERIC_REASON_RU]) assert.doesNotMatch(ru, FORBIDDEN_UI_WORDS, ru);
});

test('analyzePage: подключённый скрипт reCAPTCHA в приложении-«оболочке» — не капча, а «нужен JavaScript» (живой KG, фаза 6)', () => {
  // SYNTHETIC: по форме страницы cbd.minjust.gov.kg (18.11.2026) — пустой корень и скрипт reCAPTCHA для форм.
  const shell = '<!doctype html><html><head><script src="https://www.google.com/recaptcha/api.js"></script><title>Минюст</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/static/js/main.js"></script></body></html>';
  const a = analyzePage(shell, 'https://cbd.example.kg', 'text/html');
  assert.ok(!a.captcha);
  assert.ok(a.needsJs);
  const wall = '<html><body><div class="g-recaptcha" data-sitekey="x"></div><p>Подтвердите, что вы не робот</p></body></html>';
  assert.ok(analyzePage(wall, 'https://x.example', 'text/html').captcha);
});

test('softRedirect: перенаправление скриптом и meta refresh на почти пустой странице', () => {
  assert.equal(softRedirect('  <script>window.location.href="index.php?lang=az";</script>', 'https://meclis.example.az'), 'https://meclis.example.az/index.php?lang=az');
  assert.equal(softRedirect('<html><head><meta http-equiv="refresh" content="0; url=/ru/"></head><body></body></html>', 'https://x.example/'), 'https://x.example/ru/');
  assert.equal(softRedirect(`<html><body>${'<p>текст</p>'.repeat(60)}<script>location.href="/x"</script></body></html>`, 'https://x.example/'), null);
});
