// Снимок страницы кандидата (COL-05): HTML как есть + извлечённый текст. Текст — доказательная база для HAL-02,
// поэтому символы оригинала не нормализуются (ʼ ў қ ғ ҳ, кавычки, регистр остаются как на сайте).
import { load } from 'cheerio';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Fetcher } from './fetcher-types.ts';
import { extractPdfText } from './pdf-text.ts';

interface N {
  type: string;
  data?: string;
  name?: string;
  children?: N[];
}

const BLOCK = new Set([
  'address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dl', 'dt', 'fieldset', 'figcaption',
  'figure', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'li', 'main', 'ol', 'p', 'pre', 'section', 'summary',
  'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'div', 'center', 'body', 'html',
]);

/** Служебные элементы, не относящиеся к тексту документа. */
const JUNK =
  'script, style, noscript, template, nav, header, footer, aside, select, button, textarea, iframe, svg, canvas, ' +
  'object, embed, [hidden], [role="navigation"], [role="banner"], [role="contentinfo"], ' +
  '[style*="display:none"], [style*="display: none"], ' +
  '.lx_elem2, .lx_elem3, .menu, .main-menu, .sidebar-menu, #menu, .counter, #counter, ' +
  '.breadcrumb, .breadcrumbs, .cookie-banner, .modal, .dropdown, .dropdown-menu, .docNavbar';

const clean = (s: string): string => s.replace(/[\s ​]+/g, ' ').trim();

/** Текст узла одной строкой (для ячеек таблиц). */
function flat(n: N): string {
  if (n.type === 'text') return n.data ?? '';
  if (n.type !== 'tag') return '';
  if (n.name === 'br') return ' ';
  return (n.children ?? []).map(flat).join(BLOCK.has(n.name ?? '') ? ' ' : '');
}

/** Преобразует HTML в читаемый текст: блоки и пункты на отдельных строках, таблицы построчно. */
export function htmlToText(html: string): string {
  const $ = load(html);
  const title = clean($('title').first().text());
  $(JUNK).remove();
  const bodyLen = clean($('body').text()).length;
  $('form').each((_, el) => {
    const f = $(el);
    if (bodyLen > 0 && clean(f.text()).length > bodyLen * 0.5) {
      f.find('input, label').remove(); // форма-обёртка всей страницы (ASP.NET): текст оставляем
    } else {
      f.remove();
    }
  });

  const lines: string[] = [];
  let cur = '';
  const flush = (): void => {
    const t = clean(cur);
    if (t) lines.push(t);
    cur = '';
  };
  const walk = (n: N): void => {
    if (n.type === 'text') {
      cur += n.data ?? '';
      return;
    }
    if (n.type !== 'tag' && n.type !== 'root') return;
    const name = n.name ?? '';
    if (name === 'br') return flush();
    if (name === 'tr') {
      flush();
      const cells = (n.children ?? []).filter((c) => c.type === 'tag' && (c.name === 'td' || c.name === 'th'));
      const row = (cells.length > 0 ? cells : [n]).map((c) => clean(flat(c))).filter(Boolean);
      if (row.length) lines.push(row.join(' | '));
      return;
    }
    const block = BLOCK.has(name);
    if (block) flush();
    for (const c of n.children ?? []) walk(c);
    if (block) flush();
  };
  const root = ($('body').get(0) ?? $.root().get(0)) as unknown as N;
  walk(root);
  flush();

  if (title && lines[0] !== title) lines.unshift(title);
  return lines.join('\n') + '\n';
}

export interface RelatedSource {
  label: string;
  url: string;
}

export interface RelatedResult {
  label: string;
  url: string;
  ok: boolean;
  htmlPath?: string;
  textPath?: string;
  message?: string;
}

export interface SnapshotInput {
  fetcher: Fetcher;
  url: string;
  /** Папка акта: туда пишутся snapshot.html и snapshot.txt. */
  dir: string;
  /** Связанные страницы (напр. приложения): сохраняются в `<dir>/related/<n>.html|.txt`, n с 1. */
  relatedSnapshots?: RelatedSource[];
  /**
   * Адрес PDF-версии документа по адресу страницы (null — у сайта такой нет). Если текста в HTML мало
   * (< PDF_FALLBACK_BELOW знаков), PDF скачивается и его текст дописывается в snapshot.txt.
   */
  pdfUrlFor?: (pageUrl: string) => string | null;
}

/** Если текста акта в HTML меньше стольких знаков, пробуем PDF (у lex.uz свежие акты — только в PDF). */
export const PDF_FALLBACK_BELOW = 2500;

/** Итог попытки взять текст из PDF — в snapshot.json и в журнал. */
export interface PdfSnapshotInfo {
  url: string;
  ok: boolean;
  pages?: number;
  truncated?: boolean;
  /** Сохранённый PDF (имя файла рядом со снимком). */
  file?: string;
  message?: string;
}

export type SnapshotResult =
  | {
      ok: true;
      htmlPath: string;
      textPath: string;
      finalUrl: string;
      /** Размер сохранённого HTML, байт. */
      bytes: number;
      related: RelatedResult[];
      /** Есть, только если пробовали PDF (текста в HTML мало). */
      pdf?: PdfSnapshotInfo;
    }
  | { ok: false; message: string };

/** Скачивает страницу и сохраняет HTML (в UTF-8, после декодирования) и текст. Связанные страницы — по возможности. */
export async function takeSnapshot(input: SnapshotInput): Promise<SnapshotResult> {
  const r = await input.fetcher.get(input.url);
  if (!r.ok) return { ok: false, message: r.message };
  const htmlPath = join(input.dir, 'snapshot.html');
  const textPath = join(input.dir, 'snapshot.txt');
  try {
    await mkdir(input.dir, { recursive: true });
    await writeFile(htmlPath, r.body, 'utf8');
    await writeFile(textPath, htmlToText(r.body), 'utf8');
  } catch {
    return { ok: false, message: 'Не удалось сохранить снимок страницы в папку прогона' };
  }
  const pdf = await addPdfText(input, htmlPath, textPath);
  const related: RelatedResult[] = [];
  let n = 0;
  for (const rel of input.relatedSnapshots ?? []) {
    n++;
    const rr = await input.fetcher.get(rel.url);
    if (!rr.ok) {
      related.push({ label: rel.label, url: rel.url, ok: false, message: rr.message });
      continue;
    }
    const dir = join(input.dir, 'related');
    const hp = join(dir, `${n}.html`);
    const tp = join(dir, `${n}.txt`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(hp, rr.body, 'utf8');
      await writeFile(tp, htmlToText(rr.body), 'utf8');
      related.push({ label: rel.label, url: rr.url, ok: true, htmlPath: hp, textPath: tp });
    } catch {
      related.push({ label: rel.label, url: rel.url, ok: false, message: 'Не удалось сохранить страницу' });
    }
  }
  return { ok: true, htmlPath, textPath, finalUrl: r.url, bytes: Buffer.byteLength(r.body, 'utf8'), related, ...(pdf ? { pdf } : {}) };
}

/**
 * Текста в HTML мало → скачать PDF и дописать его текст в snapshot.txt (цитатная проверка идёт по этому файлу).
 * Если PDF не получился, снимок остаётся прежним, а причина попадает в snapshot.json.
 */
async function addPdfText(input: SnapshotInput, htmlPath: string, textPath: string): Promise<PdfSnapshotInfo | undefined> {
  if (!input.pdfUrlFor) return undefined;
  const pdfUrl = input.pdfUrlFor(input.url);
  if (!pdfUrl) return undefined;
  const html = await readFile(textPath, 'utf8');
  if (html.length >= PDF_FALLBACK_BELOW) return undefined;
  const got = await input.fetcher.get(pdfUrl, { binary: true, timeoutMs: 60_000 });
  if (!got.ok) return { url: pdfUrl, ok: false, message: got.message };
  if (!got.bytes) return { url: pdfUrl, ok: false, message: 'Сайт не вернул файл PDF' };
  const text = await extractPdfText(got.bytes);
  if (!text.ok) return { url: pdfUrl, ok: false, message: text.message };
  if (text.text.length <= html.length) return { url: pdfUrl, ok: false, message: 'В PDF не больше текста, чем на странице' };
  const pdfPath = join(dirname(htmlPath), 'snapshot.pdf');
  try {
    await writeFile(pdfPath, got.bytes);
    await writeFile(textPath, `${html.trimEnd()}\n\n--- Текст из PDF: ${pdfUrl} ---\n${text.text}`, 'utf8');
  } catch {
    return { url: pdfUrl, ok: false, message: 'Не удалось сохранить PDF в папку прогона' };
  }
  return { url: pdfUrl, ok: true, pages: text.pages, truncated: text.truncated, file: 'snapshot.pdf' };
}
