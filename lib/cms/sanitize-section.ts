/**
 * Серверная санитизация rich-text ВНУТРИ content секции (docs/11 §5.1.3, инвариант
 * 5.1, ADR-010/ADR-012).
 *
 * Анти-XSS: доверять клиентскому HTML нельзя (аналог серверного anti-tamper расчёта
 * цен). `upsertCmsSection` вызывает `sanitizeSectionContent` ПЕРЕД записью JSONB —
 * каждое rich-text-поле прогоняется через консервативный whitelist `sanitizeHtml`
 * (lib/cms/sanitize.ts). Не-rich-text типы (banner/products_grid/gallery) проходят
 * без изменений (в них нет HTML-полей).
 *
 * Чистая функция без БД/сети — иммутабельна (возвращает новый объект), тестируема
 * юнитом. Вынесена в отдельный модуль (не actions.ts), т.к. actions.ts помечен
 * 'use server' и может экспортировать только async-функции.
 */

import { sanitizeHtml } from './sanitize';
import type { CmsSectionContent } from './types';

/**
 * Очищает все rich-text-поля content секции по её `type`. Возвращает НОВЫЙ объект
 * (вход не мутируется). Для типов без rich-text — поверхностная копия как есть.
 */
export function sanitizeSectionContent(
  content: CmsSectionContent,
): CmsSectionContent {
  switch (content.type) {
    case 'text':
      return { ...content, html: sanitizeHtml(content.html) };

    case 'hero':
      return {
        ...content,
        ...(content.html !== undefined ? { html: sanitizeHtml(content.html) } : {}),
      };

    case 'cta':
      return {
        ...content,
        ...(content.html !== undefined ? { html: sanitizeHtml(content.html) } : {}),
      };

    case 'faq':
      return {
        ...content,
        items: content.items.map((item) => ({
          q: item.q,
          a: sanitizeHtml(item.a),
        })),
      };

    case 'banner':
    case 'products_grid':
    case 'gallery':
    default:
      // Типы без rich-text — копируем как есть (нет HTML-полей для очистки).
      return { ...content };
  }
}
