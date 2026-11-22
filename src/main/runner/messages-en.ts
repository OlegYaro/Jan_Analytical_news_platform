// Английские варианты технических сообщений этапов для окна «Прогон» (интерфейс на английском).
// Модули сбора и исполнители формируют сообщения по-русски (журнал log.jsonl и тесты опираются на них);
// здесь известные фразы заменяются по месту. Неизвестный текст остаётся как есть.
import type { UiLanguage } from '../../shared/types.ts'
import { translateFetchMessage } from '../sources/page-probe.ts'

type Rule = [RegExp, string | ((...m: string[]) => string)]

const RULES: Rule[] = [
  // сбор (collector)
  [/для источника ещё нет способа чтения — запустите проверку источников/g, 'the source has no reading method yet — run the source check'],
  [/профиль чтения источника повреждён — запустите проверку источников/g, 'the source reading profile is damaged — run the source check'],
  [/источник отмечен ❌ при проверке и не участвует в прогоне/g, 'the source was marked ❌ in the check and does not take part in the run'],
  [/Список документов не разобран — перепроверьте источник/g, 'The document list was not parsed — recheck the source'],
  [/внутренняя ошибка сборщика/g, 'internal collector error'],
  [/Отслеживаемый акт/g, 'Watched act'],
  [/: 0 документов/g, ': 0 documents'],
  [/Адрес в профиле некорректен/g, 'The address in the profile is invalid'],
  [/Профиль не нашёл на странице ни одного документа/g, 'The profile found no documents on the page'],
  [/lex\.uz не ответил/g, 'lex.uz did not respond'],
  [/Неверное окно поиска/g, 'Invalid search window'],
  [/Документ lex\.uz/g, 'lex.uz document'],
  // PDF и снимки
  [/Файл не похож на PDF/g, 'The file does not look like a PDF'],
  [/В PDF нет текстового слоя \(возможно, это скан\): текст не извлечён/g, 'The PDF has no text layer (it may be a scan): no text extracted'],
  [/Не удалось прочитать PDF: файл повреждён или защищён/g, 'Could not read the PDF: the file is damaged or protected'],
  [/Не удалось сохранить снимок страницы в папку прогона/g, 'Could not save the page snapshot to the run folder'],
  [/Не удалось сохранить страницу акта/g, 'Could not save the act page'],
  [/Не удалось сохранить страницу/g, 'Could not save the page'],
  [/Сайт не вернул файл PDF/g, 'The site did not return the PDF file'],
  [/В PDF не больше текста, чем на странице/g, 'The PDF has no more text than the page'],
  [/Не удалось сохранить PDF в папку прогона/g, 'Could not save the PDF to the run folder'],
  [/страница акта не открылась/g, 'the act page did not open'],
  [/PDF не прочитан/g, 'PDF not read'],
  [/причина неизвестна/g, 'reason unknown'],
  [/на странице только заголовок, текста акта нет/g, 'the page has only a heading, no act text'],
  [/текста акта на сайте нет \(возможно, только PDF-скан\)/g, 'the site has no act text (possibly only a PDF scan)'],
  [/Проверка отчёта не вернула результат по карточкам/g, 'The report verification returned no result for the cards'],
  // claude-runner
  [/Не удалось запустить Claude Code/g, 'Could not start Claude Code'],
  [/Claude Code не отвечал \(нет событий\) и был остановлен/g, 'Claude Code did not respond (no events) and was stopped'],
  [/Этап не уложился во время и был остановлен/g, 'The stage ran out of time and was stopped'],
  [/Исчерпан лимит подписки Claude/g, 'The Claude subscription limit is exhausted'],
  [/Claude Code не вернул ответ по схеме/g, 'Claude Code did not return an answer matching the schema'],
  [/Claude Code завершился с ошибкой/g, 'Claude Code finished with an error'],
  [/Claude Code завершился без результата \(код ([^)]*)\)/g, (_m, c = '') => `Claude Code finished without a result (code ${c === 'нет' ? 'none' : c})`],
  [/Ответ не прошёл проверку схемы/g, 'The answer did not pass the schema check'],
  [/Превышено число ходов/g, 'Turn limit exceeded'],
  [/неизвестная ошибка/g, 'unknown error'],
  [/этап не дал результата/g, 'the stage gave no result'],
  // полнота отбора
  [/Отбор вернул неполный ответ/g, 'The selection returned an incomplete answer'],
  [/потеряны кандидаты/g, 'candidates lost'],
  [/повторные записи/g, 'duplicate entries'],
  [/лишние id/g, 'extra ids'],
  [/отброшено без причины/g, 'dropped without a reason'],
]

/** Русское сообщение этапа → английское (для L='en'); при 'ru' возвращает исходный текст. */
export function translateMsg(text: string, L: UiLanguage): string {
  if (L !== 'en' || !text) return text
  let out = translateFetchMessage(text, L)
  for (const [re, to] of RULES) out = out.replace(re, to as string)
  out = out
    .replace(/Сайт вернул ошибку (\d+)/g, 'The site returned error $1')
    .replace(/Сайт не отвечает за (\d+) секунд/g, 'The site did not respond within $1 seconds')
    .replace(/Нет соединения с сайтом \(проверьте интернет и адрес источника\)/g, 'No connection to the site (check your internet and the source address)')
  return out
}
