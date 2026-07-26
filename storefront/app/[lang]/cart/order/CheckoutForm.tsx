'use client';

/**
 * Форма оформления заказа carre (client). Флоу боевого carrerusse.com на наших
 * Storefront API:
 *   1) контакты покупателя (имя/email/телефон);
 *   2) доставка: курьер (адрес) / ПВЗ СДЭК (город → пункт) / зона Москвы;
 *   3) промокод (опц.);
 *   4) серверный расчёт /cart/quote (пересчёт при смене доставки/промокода);
 *   5) оплата PayKeeper: /orders → /payments/paykeeper/init → редирект на invoice_url.
 *
 * Anti-tamper: НИ ОДНА сумма не считается на клиенте — показываем только ответ
 * /cart/quote. В теле запросов нет полей цены (сервер берёт цену из каталога).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useCart } from '@/lib/cart';
import { formatPrice } from '@/lib/format';
import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { getDictionary, fillTemplate, type Dictionary } from '@/lib/dictionaries';
import { normalizeGiftCode } from '@/lib/gift-code';
import {
  ApiError,
  cdekCities,
  cdekPvz,
  createOrder,
  initPaykeeperPayment,
  quoteCart,
} from '@/lib/api';
import type {
  CartLineInput,
  CdekCityDto,
  CdekPvzDto,
  DeliverySelectionInput,
  QuoteDto,
} from '@/lib/types';

interface Zone {
  id: string;
  label: string;
  price: number;
  freeThreshold: number | null;
}

interface Props {
  currencyCode: string;
  currencySymbol: string | null;
  zones: Zone[];
  /** Текущая локаль — пробрасывается в /cart/quote, /orders (локализ. подписи) и ссылки. */
  locale?: Locale;
}

/** Способ доставки в UI. 'zone' — псевдо-тип (курьер по зоне Москвы). */
type DeliveryChoice = 'courier' | 'pvz' | 'zone';

/** Подсекция словаря чекаута — все локализованные подписи формы. */
type CheckoutDict = Dictionary['checkout'];

/**
 * Подпись причины проблемы позиции (issues[].code из /cart/quote).
 * 🔴 Неизвестный код НЕ показываем покупателю сырым — общий текст словаря.
 */
function issueLabel(t: CheckoutDict, code: string): string {
  const map: Record<string, string> = {
    out_of_stock: t.issueOutOfStock,
    invalid_item: t.issueInvalidItem,
    not_found: t.issueNotFound,
    inactive: t.issueInactive,
  };
  return map[code] ?? t.issueInvalidItem;
}

/** Подпись причины отказа промокода (promo.reason из /cart/quote). */
function promoReasonLabel(t: CheckoutDict, reason: string): string {
  const map: Record<string, string> = {
    not_found: t.promoReasonNotFound,
    expired: t.promoReasonExpired,
    not_started: t.promoReasonNotStarted,
    inactive: t.promoReasonInactive,
    usage_limit: t.promoReasonUsageLimit,
    min_order: t.promoReasonMinOrder,
    per_customer_limit: t.promoReasonPerCustomerLimit,
  };
  return map[reason] ?? t.promoNotApplied;
}

/**
 * Подпись причины отказа подарочного сертификата (gift.reason из /cart/quote).
 * 🔴 Сырой машинный код покупателю не показывается НИКОГДА: неизвестная причина
 * (или новый код на сервере) падает в общий человекочитаемый текст словаря.
 */
function giftReasonLabel(t: CheckoutDict, reason: string): string {
  const map: Record<string, string> = {
    not_found: t.giftReasonNotFound,
    expired: t.giftReasonExpired,
    depleted: t.giftReasonDepleted,
    disabled: t.giftReasonDisabled,
    no_amount_due: t.giftReasonNoAmountDue,
  };
  return map[reason] ?? t.giftCodeNotApplied;
}

/**
 * Человекочитаемая ошибка создания заказа (code из /orders → CreateOrderResult).
 *
 * 🔴 Покупателю показываем ТОЛЬКО строки словаря витрины. Раньше неизвестный код
 * падал на сырое сообщение из ApiError — а это текст сервера на РУССКОМ
 * («Подарочный сертификат не найден.», «Сеть недоступна: …»), который уезжал
 * франкоязычному покупателю как есть. Теперь сырое сообщение и машинный код идут
 * исключительно в консоль браузера (для поддержки), а в интерфейс — словарь.
 */
function humanError(t: CheckoutDict, err: unknown): string {
  const map: Record<string, string> = {
    out_of_stock: t.orderErrorOutOfStock,
    invalid_item: t.orderErrorInvalidItem,
    invalid_promo: t.orderErrorInvalidPromo,
    invalid_gift: t.orderErrorInvalidGift,
    delivery_unavailable: t.orderErrorDeliveryUnavailable,
    payments_disabled: t.orderErrorPaymentsDisabled,
    network: t.orderErrorNetwork,
    rate_limited: t.orderErrorRateLimited,
  };
  const known = err instanceof ApiError ? map[err.code] : undefined;
  if (known) return known;
  // Диагностика — в лог, не в интерфейс.
  console.error('[checkout] неизвестная ошибка запроса', err);
  return t.orderErrorGeneric;
}

/** Простейшая валидация телефона/email на клиенте (сервер валидирует строже). */
function isEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
}

export default function CheckoutForm({
  currencyCode,
  currencySymbol,
  zones,
  locale = DEFAULT_LOCALE,
}: Props) {
  const dict = getDictionary(locale);
  const t = dict.checkout;
  const { items, mounted, clear } = useCart();

  // ---- Контакты покупателя ----
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // ---- Доставка ----
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryChoice>(
    zones.length > 0 ? 'zone' : 'courier',
  );
  const [zoneId, setZoneId] = useState<string>(zones[0]?.id ?? '');
  const [address, setAddress] = useState('');
  // ПВЗ: автокомплит города → выбор пункта.
  const [cityQuery, setCityQuery] = useState('');
  const [cityResults, setCityResults] = useState<CdekCityDto[]>([]);
  const [selectedCity, setSelectedCity] = useState<CdekCityDto | null>(null);
  const [pvzList, setPvzList] = useState<CdekPvzDto[]>([]);
  const [pvzCode, setPvzCode] = useState('');
  const [pvzLoading, setPvzLoading] = useState(false);

  // ---- Промокод ----
  const [promoInput, setPromoInput] = useState('');
  const [appliedPromo, setAppliedPromo] = useState('');

  // ---- Подарочный сертификат (стекается ПОВЕРХ промокода, считает сервер) ----
  const [giftInput, setGiftInput] = useState('');
  const [appliedGift, setAppliedGift] = useState('');

  // ---- Расчёт / статус ----
  const [quote, setQuote] = useState<QuoteDto | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Идемпотентность: один ключ на попытку оформления (не пересоздаём при ретраях).
  const idemKeyRef = useRef<string | null>(null);
  function ensureIdemKey(): string {
    if (!idemKeyRef.current) {
      idemKeyRef.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }
    return idemKeyRef.current;
  }

  // Позиции корзины для API: нужен productId (UUID). Позиции без него (старые
  // записи localStorage) нельзя оформить — сервер требует variantId/productId.
  const apiItems: CartLineInput[] = useMemo(
    () =>
      items
        .filter((i) => Boolean(i.productId))
        .map((i) => ({ productId: i.productId as string, qty: i.qty })),
    [items],
  );
  const hasUnresolvableItems = mounted && items.some((i) => !i.productId);

  // Текущий выбор доставки → тело для /cart/quote и /orders (единый источник).
  const buildDelivery = useCallback((): DeliverySelectionInput => {
    if (deliveryChoice === 'zone') {
      // Адрес ОБЯЗАТЕЛЕН: зона — это курьер (type:'courier'), а серверная схема
      // CreateOrderSchema (refineCourierAddress) без непустого адреса даёт 400 —
      // раньше зональный заказ вообще нельзя было оформить.
      return { type: 'courier', zoneId: zoneId || undefined, address: address.trim() || undefined };
    }
    if (deliveryChoice === 'pvz') {
      return {
        type: 'pvz',
        city: selectedCity?.name,
        cityCode: selectedCity?.code,
        pvzCode: pvzCode || undefined,
      };
    }
    // courier
    return {
      type: 'courier',
      city: selectedCity?.name || cityQuery.trim() || undefined,
      cityCode: selectedCity?.code,
      address: address.trim() || undefined,
    };
  }, [deliveryChoice, zoneId, selectedCity, pvzCode, cityQuery, address]);

  // Достаточно ли данных доставки для осмысленного расчёта/оформления.
  const deliveryReady = useMemo(() => {
    // Зона: нужен и выбор зоны, и адрес (сервер требует адрес для курьера).
    if (deliveryChoice === 'zone') return Boolean(zoneId && address.trim());
    if (deliveryChoice === 'pvz') return Boolean(selectedCity && pvzCode);
    return Boolean(address.trim()); // courier требует адрес (серверная схема)
  }, [deliveryChoice, zoneId, selectedCity, pvzCode, address]);

  // ---- Пересчёт /cart/quote при изменении корзины/доставки/промокода ----
  const recalcSignature = useMemo(
    () =>
      JSON.stringify({
        items: apiItems,
        delivery: buildDelivery(),
        promo: appliedPromo,
        gift: appliedGift,
      }),
    [apiItems, buildDelivery, appliedPromo, appliedGift],
  );

  useEffect(() => {
    if (!mounted || apiItems.length === 0) {
      setQuote(null);
      return;
    }
    let cancelled = false;
    setQuoteLoading(true);
    setQuoteError(null);
    quoteCart(
      {
        items: apiItems,
        delivery: buildDelivery(),
        ...(appliedPromo ? { promoCode: appliedPromo } : {}),
        ...(appliedGift ? { giftCertificateCode: appliedGift } : {}),
      },
      locale,
    )
      .then((q) => {
        if (!cancelled) setQuote(q);
      })
      .catch((err) => {
        if (!cancelled) {
          setQuote(null);
          setQuoteError(humanError(t, err));
        }
      })
      .finally(() => {
        if (!cancelled) setQuoteLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // recalcSignature инкапсулирует все зависимости (apiItems/delivery/promo/gift).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recalcSignature, mounted]);

  // ---- Автокомплит города СДЭК (debounce) ----
  useEffect(() => {
    if (deliveryChoice === 'zone') return;
    const q = cityQuery.trim();
    if (q.length < 2 || (selectedCity && selectedCity.name === q)) {
      setCityResults([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      cdekCities(q).then((cities) => {
        if (!cancelled) setCityResults(cities);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [cityQuery, deliveryChoice, selectedCity]);

  // ---- Список ПВЗ при выборе города (только для type='pvz') ----
  useEffect(() => {
    if (deliveryChoice !== 'pvz' || !selectedCity) {
      setPvzList([]);
      setPvzCode('');
      return;
    }
    let cancelled = false;
    setPvzLoading(true);
    cdekPvz(selectedCity.code)
      .then((list) => {
        if (!cancelled) setPvzList(list);
      })
      .finally(() => {
        if (!cancelled) setPvzLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [deliveryChoice, selectedCity]);

  function pickCity(city: CdekCityDto) {
    setSelectedCity(city);
    setCityQuery(city.name);
    setCityResults([]);
    setPvzCode('');
  }

  function applyPromo() {
    setAppliedPromo(promoInput.trim());
  }
  function removePromo() {
    setAppliedPromo('');
    setPromoInput('');
  }

  // Код приводим к ХРАНИМОМУ виду (см. storefront/lib/gift-code.ts): поиск в БД
  // точный (`WHERE code = $1`), а покупатель приносит код с пробелами вместо
  // дефисов, слитно или с юникодным тире из письма.
  const normalizedGift = normalizeGiftCode(giftInput);

  function applyGift() {
    setAppliedGift(normalizeGiftCode(giftInput));
  }
  function removeGift() {
    setAppliedGift('');
    setGiftInput('');
  }
  /**
   * Правка кода после отказа. Сообщение об отказе привязано к содержимому поля
   * (см. giftRejected ниже), поэтому первое же изменение ввода убирает его — текст
   * не висит над уже другим значением. Полностью очищенное поле = код снят: убираем
   * и appliedGift, иначе отклонённый код продолжал бы уходить в /cart/quote.
   */
  function changeGiftInput(value: string) {
    setGiftInput(value);
    if (normalizeGiftCode(value) === '') setAppliedGift('');
  }

  const fmt = (v: string | number | null | undefined) =>
    formatPrice(v, currencyCode, currencySymbol);

  const contactsValid =
    name.trim().length > 0 && isEmail(email) && phone.trim().length >= 5;

  const canSubmit =
    mounted &&
    apiItems.length > 0 &&
    !hasUnresolvableItems &&
    contactsValid &&
    deliveryReady &&
    !!quote &&
    quote.fulfillable &&
    quote.delivery.available &&
    !quoteLoading &&
    !submitting;

  // ---- Оформление: /orders → /payments/paykeeper/init → redirect ----
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    const idempotencyKey = ensureIdemKey();
    try {
      // 1) Создать заказ (сервер пересчитывает цены — anti-tamper).
      const order = await createOrder(
        {
          items: apiItems,
          customer: { name: name.trim(), email: email.trim(), phone: phone.trim() },
          delivery: buildDelivery(),
          // PayKeeper = онлайн-карта. Сервер по этому методу инициирует эквайринг.
          paymentMethod: 'card',
          ...(appliedPromo ? { promoCode: appliedPromo } : {}),
          ...(appliedGift ? { giftCertificateCode: appliedGift } : {}),
        },
        idempotencyKey,
        locale,
      );

      // 2) Куда вернуть покупателя после оплаты (mock demo-URL уважает returnUrl;
      //    боевой PayKeeper возвращает по настройкам ЛК). Страница успеха читает
      //    заказ по номеру+токену. Ссылка возврата — в текущей локали.
      const successPath = `${localizedHref('/cart/success', locale)}?number=${encodeURIComponent(
        order.number,
      )}&token=${encodeURIComponent(order.accessToken)}`;
      const returnUrl =
        typeof window !== 'undefined' ? `${window.location.origin}${successPath}` : undefined;

      // 2b) ПОЛНОЕ покрытие сертификатом: сервер создал заказ уже оплаченным
      //     (paymentStatus='paid', provider manual) — платить нечего. Инициация
      //     шлюза здесь вернула бы conflict «заказ уже оплачен» и покупатель
      //     увидел бы ошибку по успешному заказу. Уходим прямо на страницу успеха.
      if (order.paymentStatus === 'paid' || Number(order.grandTotal) === 0) {
        clear();
        window.location.href = successPath;
        return;
      }

      // 3) Инициировать оплату и получить invoice_url.
      const payment = await initPaykeeperPayment({
        orderNumber: order.number,
        accessToken: order.accessToken,
        returnUrl,
      });

      // 4) Корзина оплачена → очищаем и уходим на платёжную страницу.
      clear();
      window.location.href = payment.paymentUrl;
    } catch (err) {
      setSubmitError(humanError(t, err));
      setSubmitting(false);
    }
  }

  if (!mounted) {
    return <div className="sf-checkout__loading">{dict.common.loading}</div>;
  }

  if (items.length === 0) {
    return (
      <div className="sf-checkout">
        <h3 className="text-center">{t.emptyCart}</h3>
        <p className="text-center">
          <a href={localizedHref('/catalog', locale)} className="sf-checkout__link">
            {dict.common.goToCatalog}
          </a>
        </p>
      </div>
    );
  }

  const issuesBySku = new Map<number, string>();
  quote?.issues.forEach((iss) => issuesBySku.set(iss.index, iss.code));

  // Итог применения сертификата считает СЕРВЕР (quote.gift); grandTotal в DTO
  // уже уменьшен на списанную сумму. grandTotal = 0 → платить нечего.
  const gift = quote?.gift ?? null;
  // 🔴 ДВА РАЗНЫХ СОСТОЯНИЯ, которые раньше рисовались одним блоком:
  //   giftAccepted — код принят и реально уменьшил сумму (можно писать «Применён:»);
  //   giftRejected — код отправлен, но сервер его отклонил (никакого «Применён:»,
  //                  никаких «Списано/Остаток» с нулями — только причина и поле
  //                  ввода, чтобы исправить код).
  // Сверка gift.code с appliedGift обязательна: пока летит пересчёт, в quote лежит
  // ответ на ПРЕДЫДУЩИЙ код, и без сверки отказ показывался бы на чужой код.
  const giftAccepted = gift && gift.applied && gift.code === appliedGift ? gift : null;
  // Отказ показываем, только пока в поле лежит ИМЕННО отклонённый код: стоило
  // покупателю начать правку — сообщение уходит вместе с причиной, а кнопка
  // «Применить» снова становится активной (canApplyGift ниже — то же условие).
  const giftRejected =
    appliedGift !== '' &&
    normalizedGift === appliedGift &&
    gift !== null &&
    !gift.applied &&
    gift.code === appliedGift;
  const giftFullyCovered = Boolean(quote && giftAccepted && Number(quote.grandTotal) === 0);
  // Применять нечего, если поле пустое или этот же код уже отправлен (иначе кнопка
  // была бы «живой», но ничего не делала — тупик для покупателя).
  const canApplyGift = normalizedGift !== '' && normalizedGift !== appliedGift;

  return (
    <form className="sf-checkout" onSubmit={handleSubmit} noValidate>
      <div className="sf-checkout__grid">
        {/* ------------------------------- Левая колонка: форма -------------- */}
        <div className="sf-checkout__main">
          {hasUnresolvableItems && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {t.unresolvableItems}
            </div>
          )}

          {/* --- Контакты --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">{t.contacts}</legend>
            <label className="sf-field">
              <span className="sf-field__label">{t.nameLabel}</span>
              <input
                className="sf-field__input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="name"
                required
              />
            </label>
            <label className="sf-field">
              <span className="sf-field__label">{t.emailLabel}</span>
              <input
                className="sf-field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
              {email.length > 0 && !isEmail(email) && (
                <span className="sf-field__error">{t.emailInvalid}</span>
              )}
            </label>
            <label className="sf-field">
              <span className="sf-field__label">{t.phoneLabel}</span>
              <input
                className="sf-field__input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder={t.phonePlaceholder}
                required
              />
            </label>
          </fieldset>

          {/* --- Доставка --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">{t.delivery}</legend>

            <div className="sf-checkout__delivery-tabs">
              {zones.length > 0 && (
                <label className="sf-radio">
                  <input
                    type="radio"
                    name="delivery"
                    checked={deliveryChoice === 'zone'}
                    onChange={() => setDeliveryChoice('zone')}
                  />
                  {/* i18n-оговорка: z.label — админ-данные (одно поле label:string,
                      без пер-локальных вариантов), потому на en/fr магазине конкретное
                      имя зоны может показаться по-русски. Пер-локальные лейблы зон —
                      изменение схемы/админки, вне рамок этой правки. */}
                  <span>{zones.length === 1 ? zones[0].label : t.deliveryCourierZonal}</span>
                </label>
              )}
              <label className="sf-radio">
                <input
                  type="radio"
                  name="delivery"
                  checked={deliveryChoice === 'courier'}
                  onChange={() => setDeliveryChoice('courier')}
                />
                <span>{t.deliveryCourierCdek}</span>
              </label>
              <label className="sf-radio">
                <input
                  type="radio"
                  name="delivery"
                  checked={deliveryChoice === 'pvz'}
                  onChange={() => setDeliveryChoice('pvz')}
                />
                <span>{t.deliveryPvz}</span>
              </label>
            </div>

            {/* Выбор зоны доставки. При единственной зоне select избыточен —
                зона уже выбрана по умолчанию (zoneId = zones[0].id), её имя
                показано в лейбле радио выше. */}
            {deliveryChoice === 'zone' && zones.length > 1 && (
              <label className="sf-field">
                <span className="sf-field__label">{t.zoneLabel}</span>
                <select
                  className="sf-field__input"
                  value={zoneId}
                  onChange={(e) => setZoneId(e.target.value)}
                >
                  {zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.label}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {/* Город (курьер СДЭК / ПВЗ) — автокомплит */}
            {deliveryChoice !== 'zone' && (
              <div className="sf-field sf-field--autocomplete">
                <span className="sf-field__label">{t.cityLabel}</span>
                <input
                  className="sf-field__input"
                  type="text"
                  value={cityQuery}
                  onChange={(e) => {
                    setCityQuery(e.target.value);
                    setSelectedCity(null);
                  }}
                  placeholder={t.cityPlaceholder}
                  autoComplete="off"
                />
                {cityResults.length > 0 && (
                  <ul className="sf-autocomplete">
                    {cityResults.map((c) => (
                      <li key={`${c.code}`}>
                        <button
                          type="button"
                          className="sf-autocomplete__item"
                          onClick={() => pickCity(c)}
                        >
                          {c.name}
                          {c.region ? `, ${c.region}` : ''}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {/* Адрес (курьер СДЭК и курьер по зоне — сервер требует адрес для обоих) */}
            {(deliveryChoice === 'zone' || deliveryChoice === 'courier') && (
              <label className="sf-field">
                <span className="sf-field__label">{t.addressLabel}</span>
                <input
                  className="sf-field__input"
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder={t.addressPlaceholder}
                  autoComplete="street-address"
                />
              </label>
            )}

            {/* Пункт выдачи (ПВЗ) */}
            {deliveryChoice === 'pvz' && selectedCity && (
              <label className="sf-field">
                <span className="sf-field__label">{t.pvzLabel}</span>
                {pvzLoading ? (
                  <span className="sf-field__hint">{t.pvzLoading}</span>
                ) : pvzList.length === 0 ? (
                  <span className="sf-field__hint">
                    {t.pvzEmpty}
                  </span>
                ) : (
                  <select
                    className="sf-field__input"
                    value={pvzCode}
                    onChange={(e) => setPvzCode(e.target.value)}
                  >
                    <option value="">{t.pvzSelect}</option>
                    {pvzList.map((p) => (
                      <option key={p.code} value={p.code}>
                        {p.address || p.name}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}
          </fieldset>

          {/* --- Промокод --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">{t.promo}</legend>
            {appliedPromo ? (
              <div className="sf-promo-applied">
                <span>
                  {t.promoApplied} <strong>{appliedPromo}</strong>
                  {quote && !quote.promo.applied && (
                    <em className="sf-field__error">
                      {' '}
                      — {promoReasonLabel(t, quote.promo.reason ?? '')}
                    </em>
                  )}
                </span>
                <button type="button" className="sf-btn-link" onClick={removePromo}>
                  {t.promoRemove}
                </button>
              </div>
            ) : (
              <div className="sf-promo-row">
                <input
                  className="sf-field__input"
                  type="text"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  placeholder={t.promoPlaceholder}
                />
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={applyPromo}
                  disabled={promoInput.trim().length === 0}
                >
                  {t.promoApply}
                </button>
              </div>
            )}
          </fieldset>

          {/* --- Подарочный сертификат --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">{t.giftCode}</legend>
            {giftAccepted ? (
              // Код ПРИНЯТ: только здесь уместны «Применён:», «Списано», «Остаток».
              <div className="sf-promo-applied sf-promo-applied--stack">
                <span>
                  {t.giftCodeApplied} <strong>{appliedGift}</strong>
                  <span className="sf-field__hint">
                    {fillTemplate(t.giftCodeCovered, { amount: fmt(giftAccepted.appliedAmount) })}
                  </span>
                  <span className="sf-field__hint">
                    {fillTemplate(t.giftCodeRemaining, {
                      amount: fmt(giftAccepted.balanceRemainingAfter),
                    })}
                  </span>
                </span>
                <button type="button" className="sf-btn-link" onClick={removeGift}>
                  {t.giftCodeRemove}
                </button>
              </div>
            ) : (
              // Код НЕ принят (не введён либо отклонён сервером): поле остаётся
              // доступным, введённое значение сохранено, причина — под полем.
              <>
                <div className="sf-promo-row">
                  <input
                    className="sf-field__input"
                    type="text"
                    value={giftInput}
                    onChange={(e) => changeGiftInput(e.target.value)}
                    placeholder={t.giftCodePlaceholder}
                    autoComplete="off"
                    aria-invalid={giftRejected || undefined}
                  />
                  <button
                    type="button"
                    className="sf-btn-secondary"
                    onClick={applyGift}
                    disabled={!canApplyGift}
                  >
                    {t.giftCodeApply}
                  </button>
                </div>
                {giftRejected && (
                  <p className="sf-field__error">
                    {giftReasonLabel(t, gift?.reason ?? '')}
                    {/* «Проверьте код» — только когда проблема ИМЕННО в коде.
                        no_amount_due означает, что код рабочий, но в этом заказе
                        покрывать нечего: советовать исправить код было бы ложью. */}
                    {gift?.reason === 'no_amount_due' ? null : <> {t.giftCodeRetry}</>}
                  </p>
                )}
              </>
            )}
          </fieldset>
        </div>

        {/* ------------------------------- Правая колонка: итог -------------- */}
        <aside className="sf-checkout__summary">
          <h2 className="sf-checkout__summary-title">{t.yourOrder}</h2>

          <div className="sf-summary-lines">
            {items.map((it, idx) => {
              const issue = issuesBySku.get(idx);
              return (
                <div className="sf-summary-line" key={it.slug}>
                  <div className="sf-summary-line__name">
                    {it.name}
                    <span className="sf-summary-line__qty"> × {it.qty}</span>
                    {issue && (
                      <span className="sf-field__error">
                        {' '}
                        ({issueLabel(t, issue)})
                      </span>
                    )}
                  </div>
                  <div className="sf-summary-line__price">
                    {fmt(it.price * it.qty)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sf-summary-totals">
            <div className="sf-summary-row">
              <span>{t.summaryItems}</span>
              <span>{quote ? fmt(quote.itemsTotal) : '—'}</span>
            </div>
            {quote && Number(quote.discountTotal) > 0 && (
              <div className="sf-summary-row">
                <span>{t.summaryDiscount}</span>
                <span>−{fmt(quote.discountTotal)}</span>
              </div>
            )}
            {quote && Number(quote.giftDiscountTotal) > 0 && (
              <div className="sf-summary-row">
                <span>{t.summaryGift}</span>
                <span>−{fmt(quote.giftDiscountTotal)}</span>
              </div>
            )}
            <div className="sf-summary-row">
              <span>{t.summaryDelivery}</span>
              <span>
                {!quote
                  ? '—'
                  : !quote.delivery.available
                    ? t.deliveryPending
                    : quote.delivery.free || Number(quote.deliveryTotal) === 0
                      ? t.deliveryFree
                      : fmt(quote.deliveryTotal)}
              </span>
            </div>
            <div className="sf-summary-row sf-summary-row--total">
              <span>{t.summaryTotal}</span>
              <span>{quote ? fmt(quote.grandTotal) : '—'}</span>
            </div>
          </div>

          {giftFullyCovered && (
            <div className="sf-checkout__hint">{t.giftCodeFullyCovered}</div>
          )}
          {quoteLoading && (
            <div className="sf-checkout__hint">{t.recalculating}</div>
          )}
          {quoteError && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {quoteError}
            </div>
          )}
          {quote && !quote.fulfillable && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {t.notFulfillable}
            </div>
          )}
          {quote && quote.fulfillable && !quote.delivery.available && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {t.deliveryUnavailable}
            </div>
          )}
          {submitError && (
            <div className="sf-checkout__notice sf-checkout__notice--error">
              {submitError}
            </div>
          )}

          <button
            type="submit"
            className="sf-checkout__submit"
            disabled={!canSubmit}
          >
            {submitting ? t.submitting : giftFullyCovered ? t.submitGiftCovered : t.submit}
          </button>

          {/* 🔴 Легал-текст обязан соответствовать ФАКТИЧЕСКОМУ действию кнопки:
              при полном покрытии сертификатом кнопка — «Оформить заказ», а онлайн-
              оплаты не будет вовсе (заказ рождается оплаченным). */}
          <p className="sf-checkout__legal">
            {giftFullyCovered ? t.legalGiftCovered : t.legal}
          </p>
        </aside>
      </div>
    </form>
  );
}
