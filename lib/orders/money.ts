/**
 * Точная денежная арифметика модуля orders (docs/07 §3.1, ADR-010).
 *
 * ПОДХОД К ДЕНЬГАМ. Деньги в домене/БД — строки `NUMERIC(14,2)` (точность не
 * теряется при передаче из postgres.js). Любая арифметика над ними (суммы
 * позиций, проценты промокода, порог доставки, итог) ведётся в ЦЕЛЫХ
 * МИНИМАЛЬНЫХ ЕДИНИЦАХ (копейках) — это исключает ошибки чисел с плавающей
 * точкой (0.1 + 0.2 ≠ 0.3). На границе домена значения парсятся строкой в
 * целое число копеек (без `parseFloat`), считаются целочисленно, и
 * форматируются обратно в строку с ровно двумя знаками.
 *
 * Округление процентов промокода — `Math.round` к ближайшей копейке (half-up
 * для положительных, как и в каталоге `discountPercent`). Все функции чистые.
 */

/** Денежная строка `NUMERIC(14,2)` (домен/БД). */
export type MoneyString = string;

/**
 * Парсит денежную строку/число в ЦЕЛОЕ число копеек (минимальных единиц).
 *
 * Работает по тексту (а не через float), чтобы '19.99' → 1999 точно. Допускает
 * 0..2 знаков после точки; больше двух — ошибка (домен хранит копейки). Минус
 * запрещён (деньги ≥ 0). `number` приводится через фиксированное представление.
 */
export function toMinor(value: MoneyString | number): number {
  const raw = typeof value === 'number' ? numberToDecimalString(value) : value.trim();
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) {
    throw new Error(
      `Некорректная денежная величина: "${value}". Ожидается неотрицательное ` +
        'число с не более чем 2 знаками после точки.',
    );
  }
  const whole = Number(m[1]);
  const frac = (m[2] ?? '').padEnd(2, '0'); // '' → '00', '5' → '50'
  return whole * 100 + Number(frac);
}

/**
 * Форматирует целое число копеек обратно в денежную строку с ровно двумя
 * знаками после точки (как `NUMERIC(14,2)`). Отрицательные → ошибка (домен ≥ 0).
 */
export function fromMinor(minor: number): MoneyString {
  if (!Number.isInteger(minor)) {
    throw new Error(`Денежные копейки должны быть целым числом, получено: ${minor}.`);
  }
  if (minor < 0) {
    throw new Error(`Денежная величина не может быть отрицательной: ${minor} коп.`);
  }
  const whole = Math.trunc(minor / 100);
  const frac = minor % 100;
  return `${whole}.${String(frac).padStart(2, '0')}`;
}

/**
 * Нормализует денежную строку/число к каноничной форме `NUMERIC(14,2)`
 * (через копейки) — удобно для снапшотов позиций (ADR-010).
 */
export function normalizeMoney(value: MoneyString | number): MoneyString {
  return fromMinor(toMinor(value));
}

/**
 * Процент от суммы (в копейках) с округлением к ближайшей копейке (half-up).
 * Используется для percent-промокода: round(itemsMinor × pct / 100).
 * pct — проценты 0..100 (может быть дробным, как и в каталоге).
 */
export function percentOfMinor(amountMinor: number, pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  // amountMinor и pct целочисленно-дробные: считаем в плавающей, округляем к копейке.
  return Math.round((amountMinor * pct) / 100);
}

/** Преобразует число (напр. порог доставки из env) в десятичную строку без хвостов float. */
function numberToDecimalString(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Некорректное денежное число: ${n}.`);
  }
  // toFixed(2) даёт корректное округление к 2 знакам для разумных диапазонов денег.
  return n.toFixed(2);
}
