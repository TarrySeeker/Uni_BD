/**
 * Whitelist переводимых полей отзыва (ADR-i18n, docs/24 §1, §4) — ЕДИНЫЙ источник
 * правды для read-path (storefront review-dto), write-path (admin reply-action) и
 * панели LocaleTabs на форме ответа.
 *
 * ПЕРЕВОДИМ ТОЛЬКО reply (ответ магазина). UGC (author_name, body) — НЕ переводим
 * по ADR: пользовательский текст остаётся на языке автора. Рейтинг/даты/статус —
 * язык-агностичны.
 */
export const REVIEW_TRANSLATABLE_FIELDS = ['reply'] as const;
