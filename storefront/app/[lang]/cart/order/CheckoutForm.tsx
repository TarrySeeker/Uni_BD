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

/** Подпись причины проблемы позиции (issues[].code из /cart/quote). */
function issueLabel(t: CheckoutDict, code: string): string {
  const map: Record<string, string> = {
    out_of_stock: t.issueOutOfStock,
    invalid_item: t.issueInvalidItem,
    not_found: t.issueNotFound,
    inactive: t.issueInactive,
  };
  return map[code] ?? code;
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

/** Человекочитаемая ошибка создания заказа (code из /orders → CreateOrderResult). */
function humanError(t: CheckoutDict, err: unknown): string {
  const map: Record<string, string> = {
    out_of_stock: t.orderErrorOutOfStock,
    invalid_item: t.orderErrorInvalidItem,
    invalid_promo: t.orderErrorInvalidPromo,
    invalid_gift: t.orderErrorInvalidGift,
    delivery_unavailable: t.orderErrorDeliveryUnavailable,
    payments_disabled: t.orderErrorPaymentsDisabled,
  };
  if (err instanceof ApiError) {
    return map[err.code] ?? err.message;
  }
  return err instanceof Error ? err.message : t.orderErrorGeneric;
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
      return { type: 'courier', zoneId: zoneId || undefined };
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
    if (deliveryChoice === 'zone') return Boolean(zoneId);
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
      }),
    [apiItems, buildDelivery, appliedPromo],
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
    // recalcSignature инкапсулирует все зависимости (apiItems/delivery/promo).
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
        },
        idempotencyKey,
        locale,
      );

      // 2) Куда вернуть покупателя после оплаты (mock demo-URL уважает returnUrl;
      //    боевой PayKeeper возвращает по настройкам ЛК). Страница успеха читает
      //    заказ по номеру+токену. Ссылка возврата — в текущей локали.
      const returnUrl =
        typeof window !== 'undefined'
          ? `${window.location.origin}${localizedHref('/cart/success', locale)}?number=${encodeURIComponent(
              order.number,
            )}&token=${encodeURIComponent(order.accessToken)}`
          : undefined;

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
                  <span>{t.deliveryCourierMoscow}</span>
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

            {/* Зоны Москвы */}
            {deliveryChoice === 'zone' && (
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

            {/* Адрес (курьер) */}
            {deliveryChoice === 'courier' && (
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
            {submitting ? t.submitting : t.submit}
          </button>

          <p className="sf-checkout__legal">{t.legal}</p>
        </aside>
      </div>
    </form>
  );
}
