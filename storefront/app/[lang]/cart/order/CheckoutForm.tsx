'use client';

/**
 * Форма оформления заказа carre (client). Флоу боевого carrerusse.com на наших
 * Storefront API:
 *   1) контакты покупателя (имя/email/телефон);
 *   2) доставка: курьер (адрес) / ПВЗ СДЭК (город → пункт) / зона Москвы;
 *   3) промокод (опц.);
 *   4) серверный расчёт /cart/quote (пересчёт при смене доставки/промокода);
 *   5) оплата: /orders → /payments/init → редирект на платёжную форму АКТИВНОГО
 *      эквайера (какого именно — решает сервер, витрина про эквайеров не знает).
 *
 * Anti-tamper: НИ ОДНА сумма не считается на клиенте — показываем только ответ
 * /cart/quote. В теле запросов нет полей цены (сервер берёт цену из каталога).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useCart } from '@/lib/cart';
import { formatPrice, type NumberFormatOpts } from '@/lib/format';
import {
  buildApiIndexToCartIndex,
  mapIssuesToCartIndex,
  mapServerLinesToCartIndex,
  hasPriceChanged,
} from '@/lib/checkout-lines';
import { localizedHref, DEFAULT_LOCALE, type Locale } from '@/lib/i18n';
import { getDictionary, fillTemplate } from '@/lib/dictionaries';
import { normalizeGiftCode } from '@/lib/gift-code';
import {
  giftReasonLabel,
  issueLabel,
  orderErrorLabel,
  promoReasonLabel,
  type CheckoutDict,
} from '@/lib/checkout-errors';
import {
  ApiError,
  cdekCities,
  cdekPvz,
  createOrder,
  initPayment,
  quoteCart,
} from '@/lib/api';
import type {
  CartLineInput,
  CdekCityDto,
  CdekPvzDto,
  DeliveryMethod,
  DeliverySelectionInput,
  QuoteDto,
} from '@/lib/types';
import PaymentCurrencyNotice, { useDisplayCurrencyCode } from './PaymentCurrencyNotice';

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
  /**
   * 🔴 Аудит №20 — ДОСТУПНЫЕ способы доставки из публичного DTO настроек
   * (`settings.delivery.methods`). Форма предлагает только то, что здесь есть:
   * при выключенном у магазина модуле СДЭК его радио не рендерятся вовсе, иначе
   * покупатель выбирал бы способ, роуты /delivery/cdek/* отвечали бы 404, а
   * заказ было бы не оформить — без единого объяснения.
   *
   * `undefined` (старый ответ API без поля) → считаем СДЭК доступным: прежнее
   * поведение витрины, без регресса на несинхронно обновлённом стенде.
   */
  deliveryMethods?: DeliveryMethod[];
  /** Текущая локаль — пробрасывается в /cart/quote, /orders (локализ. подписи) и ссылки. */
  locale?: Locale;
  /**
   * 🔴 Аудит minor №9 — ФОРМАТ ЧИСЕЛ МАГАЗИНА (currency.locale / currency.fractionDigits
   * из публичных настроек). Раньше все суммы чекаута форматировались зашитым 'ru-RU'
   * с нулём знаков после запятой, из-за чего магазин с другим рынком/центами видел
   * чужую группировку разрядов и терял копейки в показе. Опционально: без поля —
   * исторический вид (анти-регресс на несинхронно обновлённом стенде).
   */
  numberFormat?: NumberFormatOpts;
}

/** Способ доставки в UI. 'zone' — псевдо-тип (курьер по зоне Москвы). */
type DeliveryChoice = 'courier' | 'pvz' | 'zone';

/**
 * Человекочитаемая ошибка запроса чекаута.
 *
 * 🔴 Покупателю показываем ТОЛЬКО строки словаря витрины. Подпись выбирается по
 * ДОМЕННОЙ причине (`error.reason`) и лишь затем — по транспортному коду; сырое
 * сообщение сервера (оно на языке магазина, обычно русском) и машинный код
 * уходят ИСКЛЮЧИТЕЛЬНО в консоль браузера, для поддержки.
 *
 * Карты кодов вынесены в @/lib/checkout-errors — чистый модуль, покрытый тестами
 * на все три локали (аудит №3/№6: раньше карта была здесь и не срабатывала ни разу).
 */
function humanError(t: CheckoutDict, err: unknown): string {
  const label = orderErrorLabel(t, err instanceof ApiError ? err : null);
  if (label) return label;
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
  deliveryMethods,
  locale = DEFAULT_LOCALE,
  numberFormat,
}: Props) {
  const dict = getDictionary(locale);
  const t = dict.checkout;
  const { items, mounted, clear } = useCart();

  // 🔴 МУЛЬТИВАЛЮТА (ЭТАП 2). КОД валюты, в которой покупатель СМОТРЕЛ цены, —
  // единственное, что витрина сообщает серверу о валюте показа. Суммы формы от
  // него не зависят и остаются БАЗОВЫМИ (guard C7): курс и справочный итог
  // сервер считает сам из своих настроек и своего grandTotal (ADR-010).
  // undefined = смотрел в базовой валюте → снимка в заказе не будет.
  const displayCurrency = useDisplayCurrencyCode();

  // ---- Доступные способы доставки (аудит №20) --------------------------------
  // Зональный курьер жив, пока у магазина есть зоны (это его собственная
  // настройка, СДЭК тут ни при чём). Способы СДЭК — строго по контракту
  // возможностей; отсутствие поля = старый ответ API → прежнее поведение.
  const zoneAvailable = zones.length > 0;
  const cdekCourierAvailable = deliveryMethods === undefined
    ? true
    : deliveryMethods.includes('cdek_courier');
  const cdekPvzAvailable = deliveryMethods === undefined
    ? true
    : deliveryMethods.includes('cdek_pvz');
  const cdekAvailable = cdekCourierAvailable || cdekPvzAvailable;
  const noDeliveryMethods = !zoneAvailable && !cdekAvailable;

  // ---- Контакты покупателя ----
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');

  // ---- Доставка ----
  // Стартовый способ — только из ДОСТУПНЫХ (аудит №20): при выключенном СДЭК и
  // отсутствии зон форма не должна открываться на способе, которого нет.
  const [deliveryChoice, setDeliveryChoice] = useState<DeliveryChoice>(
    zoneAvailable ? 'zone' : cdekCourierAvailable ? 'courier' : 'pvz',
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
  /**
   * 🔴 Аудит №19 — состояния СПРАВОЧНИКОВ СДЭК отдельно от их содержимого.
   * Пустой список и «сервис не ответил» — разные вещи: раньше оба выглядели как
   * «в этом городе нет пунктов выдачи» (для ПВЗ) либо как молчание (для городов).
   * `null` — запроса ещё не было / он в полёте; `false` — сервис ответил;
   * `true` — сбой, и покупателю нельзя говорить «ничего не найдено».
   */
  const [cityLookupFailed, setCityLookupFailed] = useState(false);
  const [cityLookupDone, setCityLookupDone] = useState(false);
  const [pvzLookupFailed, setPvzLookupFailed] = useState(false);

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

  // Идемпотентность: ключ привязан К СОСТАВУ заказа, а не к жизни компонента.
  const idemKeyRef = useRef<string | null>(null);
  const idemSignatureRef = useRef<string | null>(null);

  /**
   * 🔴 НАХОДКА №2 аудита: раньше ключ создавался ОДИН раз — по условию «реф ещё
   * пуст» — и не сбрасывался никогда. Сценарий потери денег: покупатель жмёт «Оплатить» →
   * заказ №A создан, но init оплаты падает → он видит ошибку, вводит промокод (итог
   * 12000 → 9600) → жмёт «Оплатить» снова → запрос уходит с ТЕМ ЖЕ Idempotency-Key →
   * сервер возвращает reused-заказ №A со СТАРЫМИ суммами → покупателя ведут платить
   * 12000 при 9600 на экране.
   *
   * Теперь ключ выдаётся ПО СИГНАТУРЕ состава (recalcSignature — позиции, доставка,
   * промокод, сертификат):
   *   • состав ТОТ ЖЕ (честный ретрай после сбоя сети) → ключ переиспользуется,
   *     защита от двойного заказа работает ровно как раньше;
   *   • состав ИЗМЕНИЛСЯ → новый ключ, потому что это уже ДРУГОЙ заказ, и
   *     переиспользовать прежний нельзя.
   */
  function ensureIdemKey(signature: string): string {
    if (idemKeyRef.current === null || idemSignatureRef.current !== signature) {
      idemKeyRef.current =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      idemSignatureRef.current = signature;
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

  /**
   * 🔴 НАХОДКА minor №1 — «нет в наличии» ВЕШАЛОСЬ НА ЧУЖУЮ СТРОКУ.
   *
   * Серверу уходит УРЕЗАННЫЙ массив apiItems (позиции без productId — старые записи
   * localStorage — отфильтрованы), и `issues[].index` нумеруется ПО НЕМУ. Рендер же
   * идёт по ПОЛНОЙ корзине `items`. Пока в корзине есть хоть одна позиция без
   * productId, индексы расходятся, и метка недоступности показывалась не у той
   * позиции: покупатель удалял здоровый товар, а проблемный оставался.
   *
   * Карта переводит индекс УРЕЗАННОГО массива обратно в индекс ПОЛНОЙ корзины.
   * Строится ТЕМ ЖЕ фильтром, что и apiItems, — иначе рассинхрон вернётся при
   * следующей правке условия.
   */
  const apiIndexToCartIndex = useMemo(() => buildApiIndexToCartIndex(items), [items]);

  // Позиции, которые НЕЛЬЗЯ оформить (нет productId). Раньше о них сообщалось одним
  // общим предложением, не называя ни одной, — покупатель не знал, ЧТО удалять из
  // корзины (особенно когда позиций много и внешне они не отличаются).
  const unresolvableNames = useMemo(
    () => items.filter((i) => !i.productId).map((i) => i.name),
    [items],
  );
  const hasUnresolvableItems = mounted && unresolvableNames.length > 0;

  /**
   * 🔴 НАХОДКА minor №5 — ПОСТАМАТ НЕ ПОМЕЧЕН И isPostamat НЕ ОТПРАВЛЯЛСЯ.
   *
   * Список СДЭК смешивает пункты выдачи и ПОСТАМАТЫ (автоматические ячейки), а
   * витрина печатала в <option> только адрес — тип пункта не подписан, хотя DTO его
   * отдаёт полем `type`. Покупатель не знал, что выбирает, а разница существенная:
   * в постамат не выдают крупногабарит и там нет ни примерки, ни сотрудника.
   * Вдобавок флаг isPostamat не уходил в заказ вообще, и склад/логистика видели
   * постаматную отправку как обычный ПВЗ.
   *
   * Тип нормализуем регистронезависимо: это строка внешнего API, и полагаться на
   * её регистр нельзя.
   */
  const isPostamatOffice = (p: CdekPvzDto): boolean =>
    (p.type ?? '').trim().toUpperCase() === 'POSTAMAT';

  /** Выбранный пункт целиком (не только его код) — нужен для типа пункта. */
  const selectedPvz = useMemo(
    () => pvzList.find((p) => p.code === pvzCode) ?? null,
    [pvzList, pvzCode],
  );

  /** Подпись опции: адрес/имя + ЯВНАЯ метка типа пункта. */
  const pvzOptionLabel = (p: CdekPvzDto): string => {
    const place = p.address || p.name;
    const kind = isPostamatOffice(p) ? t.pvzTypePostamat : t.pvzTypeOffice;
    return `${kind}: ${place}`;
  };

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
        // 🔴 №5: постамат — подвид ПВЗ. Флаг обязан доехать до заказа: по нему
        // склад понимает, что габарит ограничен ячейкой и выдачи с примеркой не
        // будет. Пункт ещё не выбран → флага нет (не выдумываем false как факт).
        ...(selectedPvz ? { isPostamat: isPostamatOffice(selectedPvz) } : {}),
      };
    }
    // courier
    return {
      type: 'courier',
      city: selectedCity?.name || cityQuery.trim() || undefined,
      cityCode: selectedCity?.code,
      address: address.trim() || undefined,
    };
    // selectedPvz — источник флага isPostamat (№5): без него смена пункта с ПВЗ на
    // постамат не меняла бы тело запроса и не запускала пересчёт.
  }, [deliveryChoice, zoneId, selectedCity, pvzCode, cityQuery, address, selectedPvz]);

  /**
   * Город для СДЭК-курьера. Достаточно ЛИБО выбранного из автокомплита города
   * (у него есть числовой код СДЭК — точнее), ЛИБО введённого вручную имени:
   * ровно это и уходит в buildDelivery, и ровно это принимает серверная схема.
   */
  const courierCity = Boolean(selectedCity || cityQuery.trim());

  // Достаточно ли данных доставки для осмысленного расчёта/оформления.
  const deliveryReady = useMemo(() => {
    // Зона: нужен и выбор зоны, и адрес (сервер требует адрес для курьера).
    // Город здесь НЕ нужен: цену задаёт зона из настроек магазина, СДЭК не зовётся.
    if (deliveryChoice === 'zone') return Boolean(zoneId && address.trim());
    if (deliveryChoice === 'pvz') return Boolean(selectedCity && pvzCode);
    // 🔴 Курьер СДЭК (аудит major №3): нужен и адрес, и ГОРОД. Раньше проверялся
    // только адрес — кнопка «Оплатить» была активна без города, расчёт доставки
    // молча деградировал к 0.00, и заказ уходил в производство без города
    // (накладную СДЭК по нему создать нельзя — заказ повисал).
    return Boolean(address.trim() && courierCity);
  }, [deliveryChoice, zoneId, selectedCity, pvzCode, address, courierCity]);

  /**
   * Показать покупателю ПРИЧИНУ неактивной кнопки: не хватает города. Молчащая
   * кнопка — тупик, поэтому подсказку рендерим ровно в этом состоянии (данные
   * доставки заполнены настолько, что осталось только это).
   */
  const needsCityHint =
    (deliveryChoice === 'courier' && !courierCity) ||
    (deliveryChoice === 'pvz' && !selectedCity);

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
      // Запроса не было — ни «не найдено», ни «сбой» показывать не за что.
      setCityLookupDone(false);
      setCityLookupFailed(false);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      cdekCities(q).then((res) => {
        if (cancelled) return;
        setCityResults(res.items);
        // Аудит №19: сбой транспорта НЕ выдаём за «город не найден».
        setCityLookupFailed(res.failed);
        setCityLookupDone(true);
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
      setPvzLookupFailed(false);
      return;
    }
    let cancelled = false;
    setPvzLoading(true);
    setPvzLookupFailed(false);
    cdekPvz(selectedCity.code)
      .then((res) => {
        if (cancelled) return;
        setPvzList(res.items);
        // Аудит №19: «в городе нет пунктов» имеет право появиться, ТОЛЬКО если
        // сервис действительно ответил. Сбой → отдельный текст с подсказкой.
        setPvzLookupFailed(res.failed);
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
    // Город выбран — подсказки по поиску города больше не к месту.
    setCityLookupDone(false);
    setCityLookupFailed(false);
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

  // №9: формат сумм — из настроек магазина (локаль/знаки), а не зашитый ru-RU.
  const fmt = (v: string | number | null | undefined) =>
    formatPrice(v, currencyCode, currencySymbol, numberFormat);

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

  // ---- Оформление: /orders → /payments/init → redirect ----
  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    // Ключ идемпотентности — по СОСТАВУ заказа: смена промокода/сертификата/доставки
    // даёт новый ключ, честный ретрай того же состава переиспользует прежний (№2).
    const idempotencyKey = ensureIdemKey(recalcSignature);
    // Итог, который покупатель ВИДИТ в блоке «Итого» прямо сейчас. canSubmit
    // гарантирует quote !== null, но берём защитно — это же значение уедет серверу
    // как ожидание и послужит эталоном клиентской сверки.
    const expectedGrandTotal = quote?.grandTotal;
    try {
      // 1) Создать заказ (сервер пересчитывает цены — anti-tamper).
      const order = await createOrder(
        {
          items: apiItems,
          customer: { name: name.trim(), email: email.trim(), phone: phone.trim() },
          delivery: buildDelivery(),
          // 'card' = онлайн-карта. Сервер по этому методу инициирует эквайринг
          // у активного эквайера магазина.
          paymentMethod: 'card',
          ...(appliedPromo ? { promoCode: appliedPromo } : {}),
          ...(appliedGift ? { giftCertificateCode: appliedGift } : {}),
          // 🔴 Сверка суммы (аудит №2/№9). Не цена, а ОЖИДАНИЕ: сервер сверит его со
          // своим пересчитанным итогом и откажет (total_mismatch), если разошлось.
          ...(expectedGrandTotal !== undefined ? { expectedGrandTotal } : {}),
          // 🔴 Снимок «что видел покупатель» (0059): только КОД валюты показа.
          // Курс и сумму в ней сервер считает сам — клиентское число к деньгам
          // не допускается. Базовая валюта → поля нет, снимка не будет.
          ...(displayCurrency ? { displayCurrency } : {}),
        },
        idempotencyKey,
        locale,
      );

      // 1b) 🔴 КЛИЕНТСКАЯ СВЕРКА (находки №2 и №9) — вторая линия обороны на случай
      //     СТАРОГО сервера, который ещё не знает expectedGrandTotal и потому создаёт
      //     заказ молча. Сверяем ПО КОПЕЙКАМ: '9600' и '9600.00' — одна сумма, строковое
      //     сравнение дало бы ложное расхождение.
      //
      //     Расхождение возможно, когда: (а) сервер вернул reused-заказ со старыми
      //     суммами после смены состава (№2); (б) сертификат покрыл меньше показанного,
      //     потому что баланс потратили параллельно (№9); (в) изменились цены/промокод.
      //     В любом из случаев покупателя НЕ уводим на оплату: он не должен платить
      //     сумму, которой не видел. Корзину НЕ чистим — заказ ещё не оплачен.
      const totalMismatch =
        expectedGrandTotal !== undefined &&
        Math.round(Number(order.grandTotal) * 100) !==
          Math.round(Number(expectedGrandTotal) * 100);
      if (totalMismatch) {
        setSubmitError(
          `${fillTemplate(t.orderTotalChanged, {
            expected: fmt(expectedGrandTotal),
            actual: fmt(order.grandTotal),
          })} ${t.orderTotalChangedAction}`,
        );
        setSubmitting(false);
        return;
      }

      // 2) Куда вернуть покупателя после оплаты (mock demo-URL уважает returnUrl;
      //    боевой эквайер возвращает по настройкам ЛК). Страница успеха читает
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
      const payment = await initPayment({
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

  /**
   * 🔴 №1: проблемы позиций раскладываем по индексу ПОЛНОЙ корзины, а не по индексу
   * урезанного массива, который пришёл с сервера. Индекс, которому не нашлось строки
   * (сервер отстал от корзины), молча отбрасываем: показать чужой строке чужую
   * проблему хуже, чем не показать ничего.
   */
  const issuesBySku = mapIssuesToCartIndex(quote?.issues ?? [], apiIndexToCartIndex);

  /**
   * 🔴 НАХОДКА minor №2 — ЦЕНЫ СТРОК ИЗ localStorage ПРИ СЕРВЕРНОМ ИТОГЕ.
   *
   * Строка печатала `it.price * it.qty` из КОРЗИНЫ, а «Товары»/«Итого» — суммы из
   * /cart/quote. Если цена в каталоге изменилась после добавления товара в корзину,
   * сумма строк не сходилась с итогом, и покупателю это ничем не объяснялось —
   * выглядело как ошибка в счёте.
   *
   * Сервер — источник истины (он же считает заказ), поэтому показываем СЕРВЕРНЫЙ
   * lineTotal. quote.lines содержит только УСПЕШНО разрешённые позиции в порядке
   * apiItems, поэтому раскладываем их тем же переводом индексов, что и issues.
   */
  const serverLinesByCartIndex = mapServerLinesToCartIndex(
    quote?.lines ?? [],
    quote?.issues ?? [],
    apiItems.length,
    apiIndexToCartIndex,
  );

  /**
   * Цена ХОТЯ БЫ ОДНОЙ позиции в каталоге разошлась с той, что лежит в корзине.
   * Найдено → показываем покупателю ОБЪЯСНЕНИЕ: суммы поменялись не по ошибке
   * витрины, а потому что цена изменилась, и платить он будет по серверной.
   */
  const priceChanged = hasPriceChanged(items, serverLinesByCartIndex);

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
              {/* 🔴 №1: НАЗЫВАЕМ проблемные позиции. Без этого покупателю
                  предлагалось «удалите их из корзины», не сказав какие именно. */}
              <div>
                {fillTemplate(t.unresolvableItemsList, {
                  items: unresolvableNames.join(', '),
                })}
              </div>
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
              {/* 🔴 Аудит №20: способы СДЭК предлагаем, ТОЛЬКО если магазин их
                  реально может выполнить (settings.delivery.methods). Раньше оба
                  радио рисовались безусловно — при выключенном модуле покупатель
                  выбирал ПВЗ, роуты /delivery/cdek/* отвечали 404, списки были
                  пусты и заказ было не оформить без объяснения. */}
              {cdekCourierAvailable && (
                <label className="sf-radio">
                  <input
                    type="radio"
                    name="delivery"
                    checked={deliveryChoice === 'courier'}
                    onChange={() => setDeliveryChoice('courier')}
                  />
                  <span>{t.deliveryCourierCdek}</span>
                </label>
              )}
              {cdekPvzAvailable && (
                <label className="sf-radio">
                  <input
                    type="radio"
                    name="delivery"
                    checked={deliveryChoice === 'pvz'}
                    onChange={() => setDeliveryChoice('pvz')}
                  />
                  <span>{t.deliveryPvz}</span>
                </label>
              )}
            </div>

            {/* Ни одного доступного способа — валидная конфигурация магазина
                (нет зон + модуль СДЭК выключен). Молчать нельзя: покупатель
                должен понимать, почему выбирать нечего и что делать. */}
            {noDeliveryMethods && (
              <p className="sf-field__hint">{t.deliveryNoMethods}</p>
            )}

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
                {/* 🔴 Аудит №19: при пустом списке раньше не рисовалось НИЧЕГО —
                    покупатель не понимал, ищет ли форма вообще. Теперь два разных
                    состояния: сервис ответил и совпадений нет / сервис не ответил
                    (тогда «не найдено» было бы неправдой про его город). */}
                {cityLookupDone && cityResults.length === 0 && (
                  <p
                    className={
                      cityLookupFailed ? 'sf-field__error' : 'sf-field__hint'
                    }
                  >
                    {cityLookupFailed ? t.cityLookupFailed : t.cityLookupEmpty}
                  </p>
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
                ) : /* 🔴 Аудит №19: «в этом городе нет пунктов выдачи» — утверждение
                      о СДЭК, и говорить его можно, ТОЛЬКО когда сервис ответил.
                      Сбой (сеть/5xx/выключенный модуль) получает свой текст с
                      подсказкой, что делать. */
                pvzLookupFailed ? (
                  <span className="sf-field__error">{t.pvzLookupFailed}</span>
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
                    {/* 🔴 №5: тип пункта (ПВЗ/постамат) — В ПОДПИСИ. Раньше здесь
                        печатался только адрес, и постаматы были неотличимы от
                        обычных пунктов выдачи. */}
                    {pvzList.map((p) => (
                      <option key={p.code} value={p.code}>
                        {pvzOptionLabel(p)}
                      </option>
                    ))}
                  </select>
                )}
              </label>
            )}

            {/* 🔴 №5: выбран ПОСТАМАТ — предупреждаем об ограничениях ДО оплаты
                (ячейка: нет примерки и не выдают крупногабарит). Узнать об этом на
                пункте выдачи — уже поздно. */}
            {deliveryChoice === 'pvz' && selectedPvz && isPostamatOffice(selectedPvz) && (
              <p className="sf-field__hint">{t.pvzPostamatHint}</p>
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
              const line = serverLinesByCartIndex.get(idx);
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
                    {/* 🔴 №2: сумма строки — СЕРВЕРНАЯ (lineTotal из /cart/quote), она
                        же ляжет в заказ. Пока расчёта нет (первый рендер, позиция с
                        проблемой, старый ответ API без lines) — показываем цену из
                        корзины как предварительную: пустая ячейка была бы хуже. */}
                    {line ? fmt(line.lineTotal) : fmt(it.price * it.qty)}
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

          {/* 🔴 ГЛАВНЫЙ РИСК МУЛЬТИВАЛЮТНОСТИ: покупатель смотрел цены в евро, а
              списывают в базовой валюте магазина (эквайринг рублёвый). Итог выше
              НАМЕРЕННО остаётся базовым — здесь лишь ПОЯСНЕНИЕ, сколько это в
              валюте, к которой покупатель привык. Компонент сам решает молчать,
              если выбрана базовая валюта: рублёвому покупателю и одновалютному
              магазину не показывается ничего. */}
          <PaymentCurrencyNotice grandTotal={quote?.grandTotal} locale={locale} />

          {/* 🔴 №2: цена в каталоге изменилась после добавления в корзину. Строки
              выше уже показывают СЕРВЕРНУЮ сумму — объясняем, почему она не такая,
              какую покупатель видел в корзине. Молчать нельзя: расхождение сумм без
              причины читается как ошибка магазина. */}
          {priceChanged && (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {t.priceChangedNotice}
            </div>
          )}
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
          {/* 🔴 Аудит major №3: город не указан → доставку не посчитать и не
              отгрузить, кнопка оплаты неактивна. Показываем ПРИЧИНУ: молчащая
              кнопка — тупик, покупатель не понимает, чего от него ждут.
              Подсказка вытесняет общий текст «не удалось рассчитать»: причина
              здесь известна точно и действие покупателя конкретное. */}
          {needsCityHint ? (
            <div className="sf-checkout__notice sf-checkout__notice--warn">
              {t.deliveryNeedsCity}
            </div>
          ) : (
            quote &&
            quote.fulfillable &&
            !quote.delivery.available && (
              <div className="sf-checkout__notice sf-checkout__notice--warn">
                {t.deliveryUnavailable}
              </div>
            )
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
