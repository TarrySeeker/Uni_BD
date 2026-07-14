import { describe, expect, it } from 'vitest';

import { sanitizeReviewBody } from '@/lib/reviews/sanitize';

/**
 * ЮНИТ (без БД): санитизация UGC-текста отзыва (docs/24 §4). Отзыв — plain-text:
 * вырезаем ВСЕ теги (strip→plain), защита от stored-XSS.
 */
describe('reviews/sanitize — sanitizeReviewBody', () => {
  it('вырезает <script> и оставляет текст', () => {
    const out = sanitizeReviewBody('Отлично<script>alert(1)</script>');
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('alert');
    expect(out).toContain('Отлично');
  });

  it('вырезает ВСЕ HTML-теги (plain-only), сохраняя текст', () => {
    const out = sanitizeReviewBody('<b>жирный</b> и <a href="x">ссылка</a>');
    expect(out).not.toMatch(/<[a-z]/i);
    expect(out).toContain('жирный');
    expect(out).toContain('ссылка');
  });

  it('img/onerror вектор нейтрализован', () => {
    const out = sanitizeReviewBody('<img src=x onerror="alert(1)">текст');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('<img');
    expect(out).toContain('текст');
  });

  it('нестроковый вход → пустая строка', () => {
    expect(sanitizeReviewBody(undefined)).toBe('');
    expect(sanitizeReviewBody(null)).toBe('');
    expect(sanitizeReviewBody(42 as unknown)).toBe('');
  });

  it('схлопывает лишние пробелы и тримит', () => {
    expect(sanitizeReviewBody('  много    пробелов  ')).toBe('много пробелов');
  });

  it('идемпотентна', () => {
    const once = sanitizeReviewBody('<p>ok</p>');
    expect(sanitizeReviewBody(once)).toBe(once);
  });
});
