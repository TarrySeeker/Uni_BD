/**
 * Серверная санитизация rich-text новости (docs/24 §3, ADR-010).
 *
 * Тело новости (CKEditor/Tiptap-HTML) — недоверенный ввод: СЕРВЕР обязан очистить
 * его перед записью в БД (createNews/updateNews) для базы (ru) И для каждого языка
 * оверлея. ПЕРЕИСПОЛЬЗУЕМ консервативный whitelist CMS (sanitizeHtml) — единый
 * анти-XSS для всего rich-контента платформы.
 */

export { sanitizeHtml } from '@/lib/cms/sanitize';
