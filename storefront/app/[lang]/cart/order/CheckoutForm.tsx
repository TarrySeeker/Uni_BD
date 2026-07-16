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

/** Русские подписи причин проблем позиций (issues[].code из /cart/quote). */
const ISSUE_LABELS: Record<string, string> = {
  out_of_stock: 'нет в наличии в нужном количестве',
  invalid_item: 'товар недоступен',
  not_found: 'товар больше не найден в каталоге',
  inactive: 'товар снят с продажи',
};

/** Причины отказа промокода (promo.reason из /cart/quote). */
const PROMO_REASONS: Record<string, string> = {
  not_found: 'Промокод не найден.',
  expired: 'Срок действия промокода истёк.',
  not_started: 'Промокод ещё не активен.',
  inactive: 'Промокод неактивен.',
  usage_limit: 'Лимит использований промокода исчерпан.',
  min_order: 'Заказ не достигает минимальной суммы для промокода.',
  per_customer_limit: 'Вы уже использовали этот промокод.',
};

/** Ошибки создания заказа (code из /orders → CreateOrderResult). */
const ORDER_ERROR_LABELS: Record<string, string> = {
  out_of_stock: 'Часть товаров закончилась, пока вы оформляли заказ. Обновите корзину.',
  invalid_item: 'Один из товаров стал недоступен. Уберите его из корзины.',
  invalid_promo: 'Промокод недействителен. Уберите его и попробуйте снова.',
  invalid_gift: 'Подарочный сертификат недействителен.',
  delivery_unavailable:
    'Не удалось рассчитать доставку в выбранное место. Измените способ или адрес доставки.',
  payments_disabled:
    'Онлайн-оплата временно недоступна. Свяжитесь с магазином для оформления.',
};

function humanError(err: unknown): string {
  if (err instanceof ApiError) {
    return ORDER_ERROR_LABELS[err.code] ?? err.message;
  }
  return err instanceof Error ? err.message : 'Произошла ошибка. Попробуйте ещё раз.';
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
          setQuoteError(humanError(err));
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
      setSubmitError(humanError(err));
      setSubmitting(false);
    }
  }

  if (!mounted) {
    return <div className="sf-checkout__loading">Загрузка…</div>;
  }

  if (items.length === 0) {
    return (
      <div className="sf-checkout">
        <h3 className="text-center">Ваша корзина пуста :(</h3>
        <p className="text-center">
          <a href={localizedHref('/catalog', locale)} className="sf-checkout__link">
            Перейти в каталог →
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
              Некоторые товары добавлены в корзину в старой версии сайта и не могут
              быть оформлены. Пожалуйста, удалите их из корзины и добавьте заново со
              страницы товара.
            </div>
          )}

          {/* --- Контакты --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">Контактные данные</legend>
            <label className="sf-field">
              <span className="sf-field__label">Имя и фамилия</span>
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
              <span className="sf-field__label">E-mail</span>
              <input
                className="sf-field__input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
              />
              {email.length > 0 && !isEmail(email) && (
                <span className="sf-field__error">Введите корректный e-mail.</span>
              )}
            </label>
            <label className="sf-field">
              <span className="sf-field__label">Телефон</span>
              <input
                className="sf-field__input"
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                autoComplete="tel"
                placeholder="+7 900 000-00-00"
                required
              />
            </label>
          </fieldset>

          {/* --- Доставка --- */}
          <fieldset className="sf-checkout__section">
            <legend className="sf-checkout__legend">Доставка</legend>

            <div className="sf-checkout__delivery-tabs">
              {zones.length > 0 && (
                <label className="sf-radio">
                  <input
                    type="radio"
                    name="delivery"
                    checked={deliveryChoice === 'zone'}
                    onChange={() => setDeliveryChoice('zone')}
                  />
                  <span>Курьер по Москве</span>
                </label>
              )}
              <label className="sf-radio">
                <input
                  type="radio"
                  name="delivery"
                  checked={deliveryChoice === 'courier'}
                  onChange={() => setDeliveryChoice('courier')}
                />
                <span>Курьер СДЭК</span>
              </label>
              <label className="sf-radio">
                <input
                  type="radio"
                  name="delivery"
                  checked={deliveryChoice === 'pvz'}
                  onChange={() => setDeliveryChoice('pvz')}
                />
                <span>Пункт выдачи СДЭК</span>
              </label>
            </div>

            {/* Зоны Москвы */}
            {deliveryChoice === 'zone' && (
              <label className="sf-field">
                <span className="sf-field__label">Зона доставки</span>
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
                <span className="sf-field__label">Город</span>
                <input
                  className="sf-field__input"
                  type="text"
                  value={cityQuery}
                  onChange={(e) => {
                    setCityQuery(e.target.value);
                    setSelectedCity(null);
                  }}
                  placeholder="Начните вводить город"
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
                <span className="sf-field__label">Адрес доставки</span>
                <input
                  className="sf-field__input"
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Улица, дом, квартира"
                  autoComplete="street-address"
                />
              </label>
            )}

            {/* Пункт выдачи (ПВЗ) */}
            {deliveryChoice === 'pvz' && selectedCity && (
              <label className="sf-field">
                <span className="sf-field__label">Пункт выдачи</span>
                {pvzLoading ? (
                  <span className="sf-field__hint">Загрузка пунктов выдачи…</span>
                ) : pvzList.length === 0 ? (
                  <span className="sf-field__hint">
                    В этом городе не найдено пунктов выдачи.
                  </span>
                ) : (
                  <select
                    className="sf-field__input"
                    value={pvzCode}
                    onChange={(e) => setPvzCode(e.target.value)}
                  >
                    <option value="">— выберите пункт —</option>
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
            <legend className="sf-checkout__legend">Промокод</legend>
            {appliedPromo ? (
              <div className="sf-promo-applied">
                <span>
                  Применён: <strong>{appliedPromo}</strong>
                  {quote && !quote.promo.applied && (
                    <em className="sf-field__error">
                      {' '}
                      — {PROMO_REASONS[quote.promo.reason ?? ''] ?? 'не применён'}
                    </em>
                  )}
                </span>
                <button type="button" className="sf-btn-link" onClick={removePromo}>
                  Убрать
                </button>
              </div>
            ) : (
              <div className="sf-promo-row">
                <input
                  className="sf-field__input"
                  type="text"
                  value={promoInput}
                  onChange={(e) => setPromoInput(e.target.value)}
                  placeholder="Введите промокод"
                />
                <button
                  type="button"
                  className="sf-btn-secondary"
                  onClick={applyPromo}
                  disabled={promoInput.trim().length === 0}
                >
                  Применить
                </button>
              </div>
            )}
          </fieldset>
        </div>

        {/* ------------------------------- Правая колонка: итог -------------- */}
        <aside className="sf-checkout__summary">
          <h2 className="sf-checkout__summary-title">Ваш заказ</h2>

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
                        ({ISSUE_LABELS[issue] ?? issue})
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
              <span>Товары</span>
              <span>{quote ? fmt(quote.itemsTotal) : '—'}</span>
            </div>
            {quote && Number(quote.discountTotal) > 0 && (
              <div className="sf-summary-row">
                <span>Скидка</span>
                <span>−{fmt(quote.discountTotal)}</span>
              </div>
            )}
            {quote && Number(quote.giftDiscountTotal) > 0 && (
              <div className="sf-summary-row">
                <span>Сертификат</span>
                <span>−{fmt(quote.giftDiscountTotal)}</span>
              </div>
            )}
            <div className="sf-summary-row">
              <span>Доставка</span>
              <span>
                {!quote
                  ? '—'
                  : !quote.delivery.available
                    ? 'уточняется'
                    : quote.delivery.free || Number(quote.deliveryTotal) === 0
                      ? 'бесплатно'
                      : fmt(quote.deliveryTotal)}
              </span>
            </div>
            <div className="sf-summary-row sf-summary-row--total">
              <span>Итого</span>
              <span>{quote ? fmt(quote.grandTotal) : '—'}</span>
            </div>
          </div>

          {quoteLoading && (
            <div className="sf-checkout__hint">Пересчёт заказа…</div>
          )}
          {quoteError && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {quoteError}
            </div>
          )}
          {quote && !quote.fulfillable && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              Некоторые товары недоступны в нужном количестве — измените корзину.
            </div>
          )}
          {quote && quote.fulfillable && !quote.delivery.available && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              Не удалось рассчитать доставку — измените способ или адрес доставки.
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
            {submitting ? 'Переход к оплате…' : 'Оплатить'}
          </button>

          <p className="sf-checkout__legal">
            Нажимая «Оплатить», вы соглашаетесь с условиями продажи. Оплата
            производится онлайн через защищённую платёжную страницу.
          </p>
        </aside>
      </div>
    </form>
  );
}
