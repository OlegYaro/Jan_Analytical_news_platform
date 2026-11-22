// Профиль извлечения источника (docs/02 §10, docs/04 §5, SRC-04). Чистые типы: их хранит Source (countries.json),
// а прогоняет движок src/main/collect/profile.ts. Здесь — чтобы renderer видел тип, не подтягивая cheerio.

export interface PaginationSpec {
  /** Имя query-параметра номера страницы (первая страница — без параметра). */
  param: string;
  max_pages: number;
}

export interface RssProfile {
  kind: 'rss';
  url: string;
  pagination?: PaginationSpec;
}

export interface HtmlListProfile {
  kind: 'html_list';
  url: string;
  /** CSS-селектор строки списка. */
  item: string;
  /** Селекторы внутри строки. `link` — «селектор[href]» или «селектор@атрибут»; пусто — сама строка / первая ссылка в ней. */
  title?: string;
  link?: string;
  date?: string;
  /** Подсказка формата для числовых дат, напр. `DD.MM.YYYY`. */
  date_format?: string;
  issuer?: string;
  pagination?: PaginationSpec;
}

export interface JsonApiProfile {
  kind: 'json_api';
  url: string;
  /** Пути вида `a.b[0].c` (без eval). `items` — путь к массиву; остальные — относительно элемента. */
  json_paths: { items: string; title: string; link: string; date: string };
  date_format?: string;
  pagination?: PaginationSpec;
}

export type ExtractionProfile = RssProfile | HtmlListProfile | JsonApiProfile;
