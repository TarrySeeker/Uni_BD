import { describe, it, expect } from 'vitest';
import { mockSearchCities } from '@/lib/cdek/mock';

/**
 * Демо-режим СДЭК (нет ключей): автокомплит города не должен заводить покупателя
 * в тупик для города вне фикстур — иначе пустой список → нечего выбрать → нет
 * cityCode → недостижимы ПВЗ/расчёт. Поэтому для любого осмысленного запроса без
 * фикстурного совпадения отдаём ОДИН синтетический город (как PVZ-fallback).
 */
describe('cdek/mock — mockSearchCities синтетический фолбэк (#12)', () => {
  it('короткий запрос (<2 символов) → пусто', () => {
    expect(mockSearchCities('М')).toEqual([]);
    expect(mockSearchCities(' ')).toEqual([]);
  });

  it('фикстурный город резолвится без синтетики (Москва)', () => {
    const r = mockSearchCities('Москв');
    expect(r.some((c) => /Москва/i.test(c.name))).toBe(true);
    // все результаты — реальные фикстуры (код в «низком» диапазоне)
    expect(r.every((c) => c.code < 1_000_000)).toBe(true);
  });

  it('город вне фикстур → ровно один синтетический результат (не пусто)', () => {
    const r = mockSearchCities('Урюпинск');
    expect(r.length).toBe(1);
    expect(r[0].name).toMatch(/Урюпинск/i);
    expect(r[0].code).toBeGreaterThan(0);
  });

  it('синтетический код детерминирован (один запрос → один код, регистр/пробелы не влияют)', () => {
    const a = mockSearchCities('Урюпинск')[0].code;
    const b = mockSearchCities('  урюпинск ')[0].code;
    expect(a).toBe(b);
  });

  it('синтетический код в высоком диапазоне (не пересекается с фикстурными)', () => {
    expect(mockSearchCities('Несуществуйск')[0].code).toBeGreaterThanOrEqual(1_000_000);
  });

  it('имя приводится к Title Case', () => {
    expect(mockSearchCities('нижний тагил')[0].name).toBe('Нижний Тагил');
  });

  it('у синтетического города заполнен region (видно, что демо)', () => {
    expect(mockSearchCities('Урюпинск')[0].region).toBeTruthy();
  });
});
