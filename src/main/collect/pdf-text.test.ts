// Тесты текста из PDF: PDF собирается прямо в тесте (минимальный валидный файл), сеть не нужна.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdfText, looksLikePdf } from './pdf-text.ts';
import { PDF_FALLBACK_BELOW, takeSnapshot } from './snapshot.ts';
import { lexuzPdfUrl } from './adapters/lexuz.ts';
import type { FetchOptions, FetchResult, Fetcher } from './fetcher-types.ts';

/** Минимальный PDF с одной страницей и строками латиницей (Helvetica). */
function makePdf(lines: string[]): Uint8Array {
  const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 12 Tf 50 750 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

test('looksLikePdf отличает PDF от HTML', () => {
  assert.equal(looksLikePdf(makePdf(['x'])), true);
  assert.equal(looksLikePdf(new TextEncoder().encode('<html></html>')), false);
});

test('extractPdfText достаёт текст страниц', async () => {
  const r = await extractPdfText(makePdf(['Markaziy bank qarori', 'Banklarni sanatsiya qilish tartibi']));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.pages, 1);
  assert.match(r.text, /Markaziy bank qarori/);
  assert.match(r.text, /sanatsiya qilish/);
});

test('extractPdfText: не PDF и повреждённый PDF — понятная причина, без исключения', async () => {
  const a = await extractPdfText(new TextEncoder().encode('<html>не pdf</html>'));
  assert.deepEqual(a, { ok: false, message: 'Файл не похож на PDF' });
  const b = await extractPdfText(new TextEncoder().encode('%PDF-1.4\nмусор'));
  assert.equal(b.ok, false);
});

test('lexuzPdfUrl: страницы документов lex.uz → /pdffile/<id>, остальное — null', () => {
  assert.equal(lexuzPdfUrl('https://lex.uz/docs/8594974'), 'https://lex.uz/pdffile/8594974');
  assert.equal(lexuzPdfUrl('https://www.lex.uz/docs/-4888804?ONDATE=13.01.2027'), 'https://lex.uz/pdffile/4888804');
  assert.equal(lexuzPdfUrl('https://cbu.uz/ru/press_center/news/1/'), null);
  assert.equal(lexuzPdfUrl('не адрес'), null);
});

class FakeFetcher implements Fetcher {
  calls: string[] = [];
  private pages: Record<string, FetchResult>;
  constructor(pages: Record<string, FetchResult>) {
    this.pages = pages;
  }
  async get(url: string, _opts?: FetchOptions): Promise<FetchResult> {
    this.calls.push(url);
    return this.pages[url] ?? { ok: false, kind: 'http', status: 404, message: 'Сайт вернул ошибку 404 (страница не найдена)' };
  }
  async postForm(): Promise<FetchResult> {
    throw new Error('не нужен');
  }
}

const thinHtml = '<html><body><h1>3976-сон 16.11.2026. Banklarni sanatsiya qilish</h1><p>Kuchga kirish sanasi</p></body></html>';
const okHtml = (u: string): FetchResult => ({ ok: true, status: 200, url: u, body: thinHtml, contentType: 'text/html' });
const okPdf = (u: string, b: Uint8Array): FetchResult => ({ ok: true, status: 200, url: u, body: '', contentType: 'application/pdf', bytes: b });

test('снимок: текста в HTML мало → текст PDF дописан в snapshot.txt, PDF сохранён', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rw-pdf-'));
  try {
    const url = 'https://lex.uz/docs/8594974';
    const f = new FakeFetcher({
      [url]: okHtml(url),
      'https://lex.uz/pdffile/8594974': okPdf('https://lex.uz/pdffile/8594974', makePdf(['Markaziy bank boshqaruvi qarori', 'Banklarni sanatsiya qilish nizomi, 12-band'])),
    });
    const r = await takeSnapshot({ fetcher: f, url, dir, pdfUrlFor: lexuzPdfUrl });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pdf?.ok, true);
    const txt = await readFile(r.textPath, 'utf8');
    assert.match(txt, /3976-сон/);
    assert.match(txt, /Текст из PDF: https:\/\/lex\.uz\/pdffile\/8594974/);
    assert.match(txt, /sanatsiya qilish nizomi, 12-band/);
    assert.ok((await readFile(join(dir, 'snapshot.pdf'))).byteLength > 100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('снимок: текста в HTML достаточно → PDF не запрашивается', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rw-pdf-'));
  try {
    const url = 'https://lex.uz/docs/8530799';
    const long = `<html><body><h1>Акт</h1><p>${'Текст акта. '.repeat(PDF_FALLBACK_BELOW / 5)}</p></body></html>`;
    const f = new FakeFetcher({ [url]: { ok: true, status: 200, url, body: long, contentType: 'text/html' } });
    const r = await takeSnapshot({ fetcher: f, url, dir, pdfUrlFor: lexuzPdfUrl });
    assert.ok(r.ok);
    assert.deepEqual(f.calls, [url]);
    if (r.ok) assert.equal(r.pdf, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('снимок: PDF не скачался → снимок остаётся прежним, причина записана', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rw-pdf-'));
  try {
    const url = 'https://lex.uz/docs/8594974';
    const f = new FakeFetcher({ [url]: okHtml(url) });
    const r = await takeSnapshot({ fetcher: f, url, dir, pdfUrlFor: lexuzPdfUrl });
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.pdf?.ok, false);
    assert.match(r.pdf?.message ?? '', /404/);
    assert.doesNotMatch(await readFile(r.textPath, 'utf8'), /Текст из PDF/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
