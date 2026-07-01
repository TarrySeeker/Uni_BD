import { describe, it, expect } from 'vitest';

import { rolesChanged } from '@/lib/admin/user-roles';

/**
 * Находка #16: форма пользователя должна слать roleIds только если состав ролей
 * реально менялся (иначе сервер требует roles.manage даже при правке одного имени).
 * Чистая функция сравнения наборов — порядок и дубликаты не важны.
 */
describe('rolesChanged', () => {
  it('одинаковый набор (тот же порядок) → не изменился', () => {
    expect(rolesChanged(['a', 'b'], ['a', 'b'])).toBe(false);
  });

  it('одинаковый набор в другом порядке → не изменился', () => {
    expect(rolesChanged(['a', 'b'], ['b', 'a'])).toBe(false);
  });

  it('оба пустые → не изменился', () => {
    expect(rolesChanged([], [])).toBe(false);
  });

  it('добавили роль → изменился', () => {
    expect(rolesChanged(['a'], ['a', 'b'])).toBe(true);
  });

  it('сняли роль → изменился', () => {
    expect(rolesChanged(['a', 'b'], ['a'])).toBe(true);
  });

  it('заменили роль (та же длина, другой состав) → изменился', () => {
    expect(rolesChanged(['a', 'b'], ['a', 'c'])).toBe(true);
  });

  it('дубликаты не влияют на равенство наборов', () => {
    expect(rolesChanged(['a', 'a', 'b'], ['a', 'b'])).toBe(false);
  });
});
