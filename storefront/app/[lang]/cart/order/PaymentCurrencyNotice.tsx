'use client';

/**
 * ДИСКЛЕЙМЕР О ВАЛЮТЕ СПИСАНИЯ на чекауте (ЭТАП 1 мультивалютности).
 *
 * ПРОБЛЕМА. Витрина показывает цены в ВЫБРАННОЙ валюте (переключатель ₽/€ в
 * шапке, курс ЦБ РФ обновляется кроном): каталог, карточка, корзина — всё в евро.
 * А эквайринг у магазина работает в БАЗОВОЙ валюте: платёжные адаптеры берут
 * сумму исключительно из серверного `order.grandTotal` и о курсе не знают вовсе
 * (инвариант защищён tests/exchange/payment-base-currency.test.ts). Чекаут же о
 * выборе покупателя не знал и молча форматировал всё в рублях — человек,
 * пришедший из евро-режима, видел «внезапно другие» суммы без единого слова
 * объяснения. Технически безопасно, но это обман ожиданий и прямой повод для
 * претензии/чарджбэка.
 *
 * РЕШЕНИЕ — ПОЯСНЕНИЕ, А НЕ ПЕРЕСЧЁТ.
 *
 *  1. Суммы формы чекаута ОСТАЮТСЯ В БАЗОВОЙ ВАЛЮТЕ. Этот компонент ничего в
 *     форме не меняет: он добавляет отдельную строку «спишут столько-то, это
 *     примерно столько-то в вашей валюте». Пересчёт формы означал бы, что
 *     покупатель видит евро, а уходит на рублёвый шлюз — ровно тот дефект,
 *     который мы закрываем.
 *
 *  2. ПЕРЕКЛЮЧАТЕЛЯ ВАЛЮТ ЗДЕСЬ НЕТ намеренно. Чекаут — точка оплаты; менять на
 *     ней валюту показа значит менять цифры прямо перед списанием.
 *
 *  3. БАЗОВАЯ ВАЛЮТА → компонент не рендерит НИЧЕГО. Рублёвому покупателю фраза
 *     «оплата в рублях» бесполезна, а одновалютный магазин платформы (доп.валют
 *     нет вовсе) не должен увидеть ни пикселя изменений — мультитенантность.
 *
 *  4. ОКРУГЛЕНИЕ ОТ ИТОГА. Справочная сумма считается из ОДНОГО рублёвого итога
 *     (`formatDisplayPrice(grandTotal, selected)` делит на курс), а не
 *     суммированием округлённых позиций: второй способ расходится с итогом на
 *     единицу валюты и порождает ту самую претензию, которую мы предотвращаем.
 *
 *  5. ИСТОЧНИК ИТОГА — СЕРВЕР. На вход приходит `quote.grandTotal` из /cart/quote;
 *     клиентской арифметики над деньгами тут нет (ADR-010 anti-tamper).
 */

import { formatDisplayPrice } from '@/lib/format';
import { useCurrency } from '@/lib/currency';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
import { DEFAULT_LOCALE, type Locale } from '@/lib/i18n';

interface Props {
  /**
   * СЕРВЕРНЫЙ итог заказа в БАЗОВОЙ валюте (quote.grandTotal, строка NUMERIC).
   * null/undefined — расчёта ещё нет: показывать нечего.
   */
  grandTotal: string | null | undefined;
  locale?: Locale;
}

/**
 * Курс числом для текста: «88,7602». Форматируется по локали страницы, до 4 знаков
 * (публикация ЦБ), без «хвоста» нулей у круглых курсов.
 */
function formatRate(rate: number, locale: Locale): string | null {
  if (!Number.isFinite(rate) || rate <= 0) return null;
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(rate);
  } catch {
    return String(rate);
  }
}

export default function PaymentCurrencyNotice({ grandTotal, locale = DEFAULT_LOCALE }: Props) {
  const { selected, currencies, mounted } = useCurrency();
  const t = getDictionary(locale).checkout;

  // Базовая валюта магазина — всегда первая (см. availableCurrencies): она несёт
  // символ и формат чисел из настроек магазина.
  const base = currencies[0] ?? selected;

  // До маунта выбор из localStorage неизвестен и `selected` = базовая — тогда
  // дисклеймера нет, и SSR-разметка совпадает с первым client-render (гидрация
  // не рвётся, тот же приём `mounted`, что в корзине).
  const isBase = !mounted || selected.code === base.code || selected.rate === 1;
  if (isBase) return null;
  if (grandTotal == null || grandTotal === '') return null;

  // ОБЕ суммы — из ОДНОГО серверного итога: charged в базовой, approx в валюте
  // показа (formatDisplayPrice делит на курс сам). Никакой поштучной арифметики.
  const charged = formatDisplayPrice(grandTotal, base);
  const approx = formatDisplayPrice(grandTotal, selected);
  if (charged === '' || approx === '') return null;

  const text = fillTemplate(t.paymentCurrencyNotice, {
    base: base.symbol || base.code,
    charged,
    approx,
  });

  // Хвост про КУРС — отдельной фразой: он уместен, только когда курс осмыслен.
  //
  // ДАТЫ курса здесь НЕТ намеренно. Публичный DTO настроек её не отдаёт (метка
  // `rateUpdatedAt` — внутренняя диагностика, это отдельно защищено guard-тестом
  // tests/storefront/settings-dto.test.ts «наружу НЕ отдаём»), а выдумывать дату
  // из времени рендера значило бы подписать чужой курс сегодняшним числом. Точная
  // дата курса, действовавшего в момент заказа, всё равно фиксируется СЕРВЕРОМ в
  // снимке заказа (orders.display_rate, миграция 0059) — там она и разбирается.
  const rate = formatRate(selected.rate, locale);
  const rateText = rate
    ? fillTemplate(t.paymentCurrencyRate, {
        rate: `${rate} ${base.symbol || base.code}/${selected.symbol || selected.code}`,
      })
    : null;

  return (
    <div className="sf-checkout__notice sf-checkout__notice--currency" role="note">
      {text}
      {rateText ? ` ${rateText}` : null}
    </div>
  );
}

/**
 * Код валюты ОТОБРАЖЕНИЯ для снимка в заказе (ЭТАП 2, orders.display_currency).
 *
 * 🔴 Отдаёт ТОЛЬКО КОД и только когда выбрана НЕ базовая валюта. Ни курс, ни
 * сумма в валюте показа клиентом не отправляются: их считает сервер из своих
 * настроек и своего рублёвого итога (ADR-010). Хук живёт рядом с дисклеймером,
 * чтобы форма чекаута по-прежнему НЕ зависела от стора валюты показа и её суммы
 * оставались базовыми (guard C7).
 */
export function useDisplayCurrencyCode(): string | undefined {
  const { selected, currencies, mounted } = useCurrency();
  const base = currencies[0] ?? selected;
  if (!mounted) return undefined;
  if (selected.code === base.code || selected.rate === 1) return undefined;
  return selected.code;
}
