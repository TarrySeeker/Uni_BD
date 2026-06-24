import { describe, it, expect } from 'vitest';
import { CdekError } from '@/lib/cdek/errors';

/** Юнит-тесты класса ошибки СДЭК (docs/08 §2). Без БД/сети. */
describe('cdek/errors — CdekError', () => {
  it('несёт code и message; cdekErrors/httpStatus по умолчанию пустые', () => {
    const err = new CdekError('network', 'нет связи');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CdekError');
    expect(err.code).toBe('network');
    expect(err.message).toBe('нет связи');
    expect(err.cdekErrors).toEqual([]);
    expect(err.httpStatus).toBeNull();
  });

  it('пробрасывает cdekErrors и httpStatus из ответа СДЭК', () => {
    const err = new CdekError('bad_request', 'ошибка валидации', {
      cdekErrors: [{ code: 'v2_field', message: 'поле обязательно' }],
      httpStatus: 400,
    });
    expect(err.httpStatus).toBe(400);
    expect(err.cdekErrors).toHaveLength(1);
    expect(err.cdekErrors[0]).toEqual({ code: 'v2_field', message: 'поле обязательно' });
  });

  it('ловится как Error (для defineAction/try-catch)', () => {
    try {
      throw new CdekError('mock', 'mock-ошибка');
    } catch (e) {
      expect(e).toBeInstanceOf(CdekError);
      expect(e).toBeInstanceOf(Error);
    }
  });
});
