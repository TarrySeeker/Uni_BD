/**
 * Серверная санитизация rich-text (docs/11 §5.1.3, инвариант 5.1, ADR-010).
 *
 * Анти-XSS: доверять клиентскому HTML нельзя (аналог серверного anti-tamper
 * расчёта цен). Tiptap на клиенте отдаёт HTML — СЕРВЕР обязан очистить его перед
 * записью в БД (`upsertCmsSection`). Чистая функция без БД/сети — тестируема юнитом.
 *
 * Реализация поверх `sanitize-html` (серверная либа), обёрнута в собственный
 * консервативный whitelist: разрешены только форматирующие теги контента
 * (p/strong/em/a/ul/ol/li/h2-h4/br/blockquote). Вырезаются: script, обработчики
 * `on*`, `javascript:`/`data:`-схемы в href, style-атрибуты (вектор CSS-инъекции).
 */

import sanitizeHtmlLib from 'sanitize-html';

/** Whitelist тегов rich-text контента CMS. */
const ALLOWED_TAGS = [
  'p',
  'strong',
  'em',
  'a',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'h4',
  'br',
  'blockquote',
] as const;

/** Разрешённые схемы URL в href (без javascript:/data:). */
const ALLOWED_SCHEMES = ['http', 'https', 'mailto', 'tel'] as const;

const OPTIONS: sanitizeHtmlLib.IOptions = {
  allowedTags: [...ALLOWED_TAGS],
  // Только href у ссылок; никаких style/on*-атрибутов нигде.
  allowedAttributes: {
    a: ['href'],
  },
  // Разрешённые схемы; относительные ссылки (/path) допускаются отдельно ниже.
  allowedSchemes: [...ALLOWED_SCHEMES],
  allowedSchemesByTag: {},
  // Разрешаем относительные URL (href="/catalog") — они без схемы.
  allowProtocolRelative: false,
  // Текст неразрешённых тегов сохраняем, сами теги выкидываем.
  disallowedTagsMode: 'discard',
  // Нормализация сущностей/entities выполняется библиотекой.
  enforceHtmlBoundary: false,
};

/**
 * Очищает произвольный HTML до безопасного whitelist-подмножества.
 *
 * Устойчива к нестроковому входу (undefined/null/число) — возвращает ''.
 * Идемпотентна: повторный прогон уже очищенного HTML не меняет результат.
 */
export function sanitizeHtml(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0) {
    return '';
  }
  return sanitizeHtmlLib(input, OPTIONS);
}
