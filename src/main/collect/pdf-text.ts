// Текст из PDF (чистый JS, без нативных модулей). Нужен для lex.uz: свежие акты там выложены только в PDF,
// а в HTML-странице — один заголовок (находка разбора прогона 2026-11-18_1517, docs/FINDINGS.md).

export interface PdfTextOptions {
  /** Сколько страниц читать не больше (по умолчанию 300). */
  maxPages?: number;
  /** Обрезать текст до стольких знаков (по умолчанию 3 000 000). */
  maxChars?: number;
}

export type PdfTextResult =
  | { ok: true; text: string; pages: number; truncated: boolean }
  | { ok: false; message: string };

const SIGNATURE = '%PDF-';

/** Похоже ли содержимое на PDF (по первым байтам: допускается мусор до 1 КБ). */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  return head.includes(SIGNATURE);
}

/** Извлекает текст всех страниц. Ошибки — по-русски, без стектрейса. */
export async function extractPdfText(bytes: Uint8Array, opts: PdfTextOptions = {}): Promise<PdfTextResult> {
  if (!looksLikePdf(bytes)) return { ok: false, message: 'Файл не похож на PDF' };
  const maxPages = opts.maxPages ?? 300;
  const maxChars = opts.maxChars ?? 3_000_000;
  try {
    // Legacy-сборка pdf.js работает в Node без canvas и DOM.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({
      // pdf.js забирает буфер себе: отдаём копию, чтобы вызывающий мог сохранить исходный файл.
      data: new Uint8Array(bytes),
      useSystemFonts: false,
      verbosity: 0,
    }).promise;
    const pages = Math.min(doc.numPages, maxPages);
    const parts: string[] = [];
    let total = 0;
    let truncated = doc.numPages > pages;
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        line += item.str;
        if (item.hasEOL) line += '\n';
      }
      parts.push(line);
      total += line.length;
      if (total > maxChars) {
        truncated = true;
        break;
      }
    }
    void doc.cleanup();
    let text = parts.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > maxChars) text = text.slice(0, maxChars);
    if (text.length === 0) {
      return { ok: false, message: 'В PDF нет текстового слоя (возможно, это скан): текст не извлечён' };
    }
    return { ok: true, text: text + '\n', pages: doc.numPages, truncated };
  } catch {
    return { ok: false, message: 'Не удалось прочитать PDF: файл повреждён или защищён' };
  }
}
