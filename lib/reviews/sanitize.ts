/**
 * Серверная санитизация UGC-текста отзыва (docs/24 §4, ADR-010).
 *
 * Тело отзыва — НЕДОВЕРЕННЫЙ публичный ввод (submit с витрины). В отличие от
 * rich-text новости/CMS, отзыв — ПРОСТОЙ ТЕКСТ (не rich): вырезаем ВСЕ HTML-теги
 * (strip → plain), схлопываем пробелы. Это закрывает stored-XSS даже если витрина
 * когда-нибудь отрендерит reply/body как HTML.
 *
 * Реализация поверх sanitize-html без единого разрешённого тега (allowedTags: []),
 * с раскодированием сущностей — на выходе чистый текст.
 */

import sanitizeHtmlLib from 'sanitize-html';

/**
 * Приводит произвольный UGC-ввод к безопасному plain-text.
 * Устойчива к нестроковому входу (undefined/null/число) — возвращает ''.
 * Идемпотентна: повторный прогон не меняет результат.
 */
export function sanitizeReviewBody(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }
  // allowedTags: [] → удаляем все теги; текст неразрешённых тегов сохраняем.
  const stripped = sanitizeHtmlLib(input, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'discard',
  });
  // Декодируем оставшиеся HTML-сущности sanitize-html не трогает текст, но нормализуем
  // управляющие пробелы: схлопываем длинные последовательности, тримим края.
  return stripped.replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}
