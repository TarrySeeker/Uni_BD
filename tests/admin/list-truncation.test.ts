import { describe, it, expect } from 'vitest';

import { listTruncationNotice } from '@/lib/admin/list-truncation';

/**
 * Находка #9: список подписчиков молча обрезался до 500. Чистая функция плашки
 * усечения — текст показывается только когда записей реально больше лимита.
 */
describe('listTruncationNotice', () => {
  it('записей меньше лимита → плашки нет', () => {
    expect(listTruncationNotice(120, 120, 500)).toBeNull();
  });

  it('записей ровно лимит → плашки нет (всё показано)', () => {
    expect(listTruncationNotice(500, 500, 500)).toBeNull();
  });

  it('записей больше лимита, показан полный лимит → плашка с числами', () => {
    expect(listTruncationNotice(500, 742, 500)).toBe('Показаны последние 500 из 742');
  });

  it('пустой список → плашки нет', () => {
    expect(listTruncationNotice(0, 0, 500)).toBeNull();
  });
});
