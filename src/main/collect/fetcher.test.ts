import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createFetcher } from './fetcher.ts';

let flaky = 0;
const seen: Array<{ url: string; ua?: string; cookie?: string; body: string }> = [];

const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
    seen.push({ url: req.url ?? '', ua: Buffer.from(req.headers['user-agent'] ?? '', 'latin1').toString('utf8'), cookie: req.headers.cookie, body });
    const url = req.url ?? '';
    if (url === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<p>привет</p>');
    } else if (url === '/flaky') {
      if (flaky++ < 1) res.writeHead(503).end('busy');
      else res.writeHead(200, { 'content-type': 'text/plain' }).end('done');
    } else if (url === '/missing') {
      res.writeHead(404).end('no');
    } else if (url === '/hang') {
      // не отвечаем
    } else if (url === '/redir') {
      res.writeHead(302, { location: '/ok', 'set-cookie': 'ASP.NET_SessionId=abc123; path=/; HttpOnly' }).end();
    } else if (url === '/big') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('x'.repeat(5000));
    } else if (url === '/post') {
      res.writeHead(200, { 'content-type': 'text/plain' }).end(body);
    } else if (url === '/cp1251') {
      res.writeHead(200, { 'content-type': 'text/html; charset=windows-1251' }).end(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]));
    } else {
      res.writeHead(200).end('ok');
    }
  });
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
});

const fast = { perDomainDelayMs: 0, sleep: async () => {} };

test('успешный GET и User-Agent', async () => {
  const f = createFetcher(fast);
  const r = await f.get(base + '/ok');
  assert.ok(r.ok);
  assert.equal(r.body, '<p>привет</p>');
  assert.equal(r.status, 200);
  assert.match(seen.at(-1)?.ua ?? '', /^RegWatch\/0\.1 \(мониторинг нормативных актов\)$/);
  const r2 = await createFetcher({ ...fast, userAgent: 'X/1' }).get(base + '/ok');
  assert.ok(r2.ok);
  assert.equal(seen.at(-1)?.ua, 'X/1');
});

test('503 -> повтор -> успех (пауза между попытками)', async () => {
  flaky = 0;
  const pauses: number[] = [];
  const f = createFetcher({ perDomainDelayMs: 0, sleep: async (ms) => void pauses.push(ms) });
  const r = await f.get(base + '/flaky');
  assert.ok(r.ok);
  assert.equal(r.body, 'done');
  assert.deepEqual(pauses, [1000]);
});

test('404 без повторов', async () => {
  const before = seen.length;
  const r = await createFetcher(fast).get(base + '/missing');
  assert.ok(!r.ok);
  assert.equal(r.kind, 'http');
  assert.equal(r.status, 404);
  assert.match(r.message, /ошибку 404/);
  assert.equal(seen.length - before, 1);
});

test('503 исчерпывает повторы', async () => {
  flaky = -100;
  const before = seen.length;
  const r = await createFetcher({ ...fast, retries: 2 }).get(base + '/flaky');
  assert.ok(!r.ok);
  assert.equal(r.message, 'Сайт вернул ошибку 503');
  assert.equal(seen.length - before, 3);
});

test('таймаут', async () => {
  const r = await createFetcher({ ...fast, timeoutMs: 100, retries: 0 }).get(base + '/hang');
  assert.ok(!r.ok);
  assert.equal(r.kind, 'timeout');
  assert.match(r.message, /не отвечает/);
});

test('нет соединения', async () => {
  const r = await createFetcher({ ...fast, retries: 0 }).get('http://127.0.0.1:1/');
  assert.ok(!r.ok);
  assert.equal(r.kind, 'network');
  assert.match(r.message, /Нет соединения/);
});

test('задержка на домен: один домен ждёт, разные не мешают (поддельные часы)', async () => {
  let t = 1000;
  const sleeps: number[] = [];
  const f = createFetcher({
    perDomainDelayMs: 1000,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  });
  const rs = await Promise.all([f.get(base + '/a'), f.get(base + '/b'), f.get(base + '/c')]);
  assert.ok(rs.every((r) => r.ok));
  assert.deepEqual(sleeps, [1000, 1000]);
  // другой хост (localhost вместо 127.0.0.1) не ждёт
  sleeps.length = 0;
  const other = base.replace('127.0.0.1', 'localhost');
  const r = await f.get(other + '/d');
  assert.ok(r.ok);
  assert.deepEqual(sleeps, []);
});

test('редирект: итоговый url и куки', async () => {
  const f = createFetcher(fast);
  const r = await f.get(base + '/redir');
  assert.ok(r.ok);
  assert.equal(r.url, base + '/ok');
  // cookie из ответа-редиректа ушла уже на /ok
  assert.equal(seen.at(-1)?.cookie, 'ASP.NET_SessionId=abc123');
  await f.get(base + '/other');
  assert.equal(seen.at(-1)?.cookie, 'ASP.NET_SessionId=abc123');
  // другой Fetcher — другая сессия
  await createFetcher(fast).get(base + '/other');
  assert.equal(seen.at(-1)?.cookie, undefined);
});

test('too_large', async () => {
  const r = await createFetcher({ ...fast, maxBytes: 1000 }).get(base + '/big');
  assert.ok(!r.ok);
  assert.equal(r.kind, 'too_large');
});

test('POST формы', async () => {
  const r = await createFetcher(fast).postForm(base + '/post', { a: '1', b: 'ў қ' });
  assert.ok(r.ok);
  assert.equal(r.body, 'a=1&b=%D1%9E+%D2%9B');
});

test('кодировка windows-1251', async () => {
  const r = await createFetcher(fast).get(base + '/cp1251');
  assert.ok(r.ok);
  assert.equal(r.body, 'Привет');
});
