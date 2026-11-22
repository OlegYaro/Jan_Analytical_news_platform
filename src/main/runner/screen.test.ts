// Решения экрана (SCR-01…SCR-04): чистая логика без модели и сети.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_TERMS_CLASS3, afterConfirm, afterScreen, normalizeScreenOutput, routeCandidate, type Decided, type ScreenPrep } from './screen.ts';
import type { ScreenOutput } from '../../shared/schema-types.ts';

const prep = (over: Partial<ScreenPrep> = {}): ScreenPrep => ({ hasText: true, textSource: 'html', termCount: 10, fragments: ['Markaziy bank qarori'], ...over });

test('нет снимка или нет текста — «не удалось проверить» для любого класса', () => {
  assert.equal(routeCandidate({ issuerClass: 1 }, null, 'Сайт вернул ошибку 404').kind, 'no_text');
  assert.equal(routeCandidate({ issuerClass: 1 }, prep({ hasText: false, termCount: 0 })).kind, 'no_text');
});

test('класс 3 без банковских терминов — шум; с терминами — к модели', () => {
  assert.equal(routeCandidate({ issuerClass: 3 }, prep({ termCount: MIN_TERMS_CLASS3 - 1 })).kind, 'drop');
  assert.equal(routeCandidate({ issuerClass: 3 }, prep({ termCount: MIN_TERMS_CLASS3 })).kind, 'ask');
});

test('класс 1 и 2 без терминов всё равно к модели (термины их не отсекают)', () => {
  assert.equal(routeCandidate({ issuerClass: 1 }, prep({ termCount: 0 })).kind, 'ask');
  assert.equal(routeCandidate({ issuerClass: 2 }, prep({ termCount: 0 })).kind, 'ask');
  assert.equal(routeCandidate({}, prep({ termCount: 0 })).kind, 'ask');
});

const frags = new Map([['a', ['Markaziy bank boshqaruvining qarori, 12-band'], ], ['b', ['Pochta aloqasi']]]);
const out = (items: ScreenOutput['items']): ScreenOutput => ({ country: 'UZ', mode: 'screen', items });
const item = (id: string, decision: ScreenOutput['items'][number]['decision'], quote: string): ScreenOutput['items'][number] => ({
  id, decision, points: ['p'], quote, reason: 'r', confidence: 'high',
});

test('нормализация: цитата найдена — решение остаётся', () => {
  const [d] = normalizeScreenOutput(['a'], out([item('a', 'material', 'Markaziy bank boshqaruvining qarori')]), frags);
  assert.equal(d.decision, 'material');
  assert.equal(d.downgraded, undefined);
});

test('нормализация: цитаты нет во фрагментах — понижение до unsure', () => {
  const [d] = normalizeScreenOutput(['a'], out([item('a', 'material', 'выдуманная цитата')]), frags);
  assert.equal(d.decision, 'unsure');
  assert.match(d.downgraded ?? '', /цитата не найдена/);
  const [e] = normalizeScreenOutput(['a'], out([item('a', 'none', '')]), frags);
  assert.equal(e.decision, 'unsure');
});

test('нормализация: unsure без цитаты допустим; пропущенные id — unsure; лишние — отброшены', () => {
  const r = normalizeScreenOutput(['a', 'b'], out([item('a', 'unsure', ''), item('zzz', 'material', 'x')]), frags);
  assert.deepEqual(r.map((x) => [x.id, x.decision]), [['a', 'unsure'], ['b', 'unsure']]);
  assert.equal(r[0].downgraded, undefined);
  assert.equal(r[1].downgraded, 'нет в ответе');
});

test('после экрана: none у прочих органов окончательно, у финансовых и общих — на перепроверку', () => {
  const d = (decision: Decided['decision']): Decided => ({ id: 'a', decision, points: [], quote: 'q', reason: '', confidence: 'high' });
  assert.deepEqual(afterScreen({ issuerClass: 3 }, d('none')), { kind: 'final', final: 'dropped' });
  assert.deepEqual(afterScreen({ issuerClass: 1 }, d('none')), { kind: 'confirm' });
  assert.deepEqual(afterScreen({ issuerClass: 2 }, d('none')), { kind: 'confirm' });
  assert.deepEqual(afterScreen({ issuerClass: 3 }, d('unsure')), { kind: 'confirm' });
  assert.deepEqual(afterScreen({ issuerClass: 1 }, d('material')), { kind: 'final', final: 'material' });
  assert.deepEqual(afterScreen({ issuerClass: 2 }, d('minor')), { kind: 'final', final: 'minor' });
});

test('после перепроверки: сомнение идёт дальше на разбор', () => {
  const d = (decision: Decided['decision']): Decided => ({ id: 'a', decision, points: [], quote: 'q', reason: '', confidence: 'low' });
  assert.equal(afterConfirm(d('unsure')), 'material');
  assert.equal(afterConfirm(d('material')), 'material');
  assert.equal(afterConfirm(d('none')), 'dropped');
  assert.equal(afterConfirm(d('minor')), 'minor');
});

import { quoteMostlyIn } from './screen.ts';

test('почти дословная цитата (ошибка в окончании) принимается, выдуманная — нет', () => {
  const frag = ['Tashqi iqtisodiy faoliyatda mahsulotlarning eksport va importini miqdoriy cheklovlar orqali tartibga solish'];
  assert.equal(quoteMostlyIn('eksport va importini miqdoriy cheklovlar orqali tartibga solish', frag), true);
  assert.equal(quoteMostlyIn('mahsulotlarning eksport va importi miqdoriy cheklov orqali tartib', frag), true);
  assert.equal(quoteMostlyIn('Markaziy bank boshqaruvi litsenziya bekor qiladi', frag), false);
  assert.equal(quoteMostlyIn('eksport', frag), false, 'короткая цитата — только точное совпадение');
});

test('нормализация: цитата с опечаткой в окончании не понижает верное решение', () => {
  const f = new Map([['a', ['Tashqi iqtisodiy faoliyatda mahsulotlarning eksport va importini miqdoriy cheklovlar orqali tartibga solish']]]);
  const [d] = normalizeScreenOutput(['a'], { country: 'UZ', mode: 'confirm', items: [{ id: 'a', decision: 'none', points: [], quote: 'eksport va importi miqdoriy cheklovlar orqali tartibga', reason: 'quota', confidence: 'high' }] }, f);
  assert.equal(d.decision, 'none');
});
