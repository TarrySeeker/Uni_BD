/**
 * Округление цен ОТОБРАЖЕНИЯ в доп.валютах (products.display_prices, миграция 0062).
 *
 * ЗАЧЕМ. Цена в доп.валюте считается делением базовой на курс, поэтому витрина
 * показывала «178,51 €» и «362,61 €» — арифметический хвост вместо ценника.
 * Решение владельца (29.07.2026): округлять до ЦЕЛОЙ единицы валюты и
 * ПЕРЕСЧИТЫВАТЬ автоматически при смене курса ЦБ — иначе зафиксированная цена
 * в евро со временем разъедется с рублёвой (товар «подешевеет» при росте курса).
 *
 * 🔴 ГРАНИЦА, которую нельзя размывать: display_prices — ТОЛЬКО ПОКАЗ.
 * В корзине, заказе и оплате участвует base_price в базовой валюте (ADR-010).
 * Здесь считается витринный ярлык, а не деньги: сюда не должны просачиваться
 * ни промо-скидки, ни доставка, ни итоги корзины. Guard-тесты
 * `payment-base-currency` и `display-prices-not-in-payments` это сторожат.
 *
 * Мультитенантность: политика округления и набор валют приходят параметрами,
 * магазин-специфики в коде нет. Другой магазин включит другие валюты — модуль
 * не изменится.
 *
 * Логика ЧИСТАЯ (без БД и сети) — воркер в `cron.ts` подаёт данные и пишет итог.
 */

/** Как округлять цену показа. Сейчас поддержан один режим; поле оставлено ради
 *  расширения (магазин может захотеть «до 5» или «оканчивать на 9»). */
export interface RoundablePricePolicy {
  mode: 'whole';
}

/** Товар в виде, достаточном для расчёта ярлыка. */
export interface RoundableProduct {
  id: string;
  /** Базовая цена строкой NUMERIC (напр. «16000.00»). */
  basePrice: string;
  /** Текущая карта ручных цен показа: { EUR: '179.00' }. */
  displayPrices: Record<string, string>;
}

/** Что нужно записать по одному товару. */
export interface DisplayPriceUpdate {
  id: string;
  displayPrices: Record<string, string>;
}

/**
 * Минимальная цена показа. Округление дешёвого товара вниз дало бы «0 €» —
 * это и брак витрины, и приглашение «купить бесплатно», хотя списание всё равно
 * идёт в рублях. Ниже единицы не опускаемся.
 */
const MIN_DISPLAY_UNITS = 1;

/**
 * Считает цену показа в одной валюте.
 *
 * `rate` — сколько единиц БАЗОВОЙ валюты стоит одна единица валюты показа
 * (EUR rate=89.63 → 1 € = 89,63 ₽), поэтому цена показа = базовая / rate.
 *
 * Возвращает null, если считать не из чего: негодный курс или негодная цена.
 * Витрина в этом случае покажет курсовую цену — это честнее, чем выдуманный ярлык.
 */
export function roundDisplayPrice(
  basePrice: number,
  rate: number,
  policy: RoundablePricePolicy,
): string | null {
  if (!Number.isFinite(basePrice) || basePrice <= 0) return null;
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const raw = basePrice / rate;
  if (!Number.isFinite(raw)) return null;

  const rounded = policy.mode === 'whole' ? Math.round(raw) : Math.round(raw);
  const units = Math.max(MIN_DISPLAY_UNITS, rounded);

  // Две цифры после запятой — формат колонки и DTO (NUMERIC-строка).
  return units.toFixed(2);
}

/**
 * Строит план обновления: только те товары, у которых ярлык реально меняется.
 *
 * Идемпотентность важна не для красоты: воркер ходит по всему каталогу, и без
 * сравнения каждый ночной прогон переписывал бы тысячи строк вхолостую, раздувая
 * WAL и мешая репликации.
 *
 * Валюта с испорченным курсом пропускается, НО уже проставленная цена по ней
 * не стирается: прежний ярлык лучше пустоты, а сбой курса — дело временное.
 */
export function planDisplayPriceUpdates(
  products: readonly RoundableProduct[],
  rates: Readonly<Record<string, number>>,
  policy: RoundablePricePolicy,
): DisplayPriceUpdate[] {
  const codes = Object.keys(rates);
  if (codes.length === 0) return [];

  const updates: DisplayPriceUpdate[] = [];

  for (const product of products) {
    const basePrice = Number(product.basePrice);
    const current = product.displayPrices ?? {};
    // Стартуем от текущей карты: валюты, которые сейчас посчитать нельзя,
    // сохраняют прежнее значение вместо того, чтобы исчезнуть.
    const next: Record<string, string> = { ...current };
    let changed = false;

    for (const code of codes) {
      const price = roundDisplayPrice(basePrice, rates[code]!, policy);
      if (price === null) continue;
      if (next[code] !== price) {
        next[code] = price;
        changed = true;
      }
    }

    if (changed) updates.push({ id: product.id, displayPrices: next });
  }

  return updates;
}
