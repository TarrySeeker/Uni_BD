/**
 * Публичные DTO Storefront API — подмножество полей, используемых витриной.
 * Форма сверена с `Uni_BD/lib/storefront/*` (dto.ts, settings-dto.ts) и
 * `docs/21-контракт-storefront-api.md`. Деньги товаров приходят строкой NUMERIC
 * в рублях (напр. "7500.00").
 */

export interface BrandDto {
  slug: string;
  name: string;
  logoUrl: string | null;
}

export interface ProductListItemDto {
  slug: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  imageUrl: string | null;
  inStock: boolean;
  availableQty: number;
}

export interface Pagination {
  total: number;
  limit: number;
  offset: number;
  count: number;
}

export interface ProductsResponse {
  data: ProductListItemDto[];
  pagination: Pagination;
}

export interface CategoryDto {
  slug: string;
  name: string;
  description: string;
  imageUrl: string | null;
  children: CategoryDto[];
}

export interface MediaDto {
  url: string | null;
  type: string;
  alt: string;
  isPrimary: boolean;
}

/**
 * Дисплейный цвето-свотч товара (легаси-блок carre `.wv__colors`). Зеркалит
 * Admik `ProductColorDto`: `hex` красит кружок, `name` (ru) — его title.
 * НЕ покупаемый вариант.
 */
export interface ProductColorDto {
  hex: string;
  name: string;
}

export interface VariantDto {
  id: string;
  sku: string;
  name: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  attributes: Record<string, unknown>;
  inStock: boolean;
  availableQty: number;
}

export interface DesignerDto {
  slug: string;
  name: string;
  imageUrl: string | null;
}

/**
 * Полный дизайнер для публичной страницы /designers/[slug]. Зеркалит 1:1
 * Admik `FullDesignerDto` (lib/storefront/dto.ts → toFullDesignerDto): внутренние
 * поля скрыты, imageUrl/pageImageUrl — уже публичные URL (не S3-ключи).
 */
export interface FullDesignerDto extends DesignerDto {
  country: string | null;
  description: string;
  pageImageUrl: string | null;
  videoUrl: string | null;
  socials: Record<string, string>;
  workCount: number;
  seoTitle: string | null;
  seoDescription: string | null;
  meta: SeoMetaDto;
}

export interface SeoMetaDto {
  title: string | null;
  description: string | null;
  canonical?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  noindex?: boolean;
}

export interface ProductDetailDto {
  id: string;
  slug: string;
  sku: string;
  name: string;
  description: string;
  price: string;
  compareAtPrice: string | null;
  discountPct: number | null;
  onSale: boolean;
  isNew: boolean;
  isFeatured: boolean;
  brand: BrandDto | null;
  designer: DesignerDto | null;
  categories: string[];
  attributes: Record<string, unknown>;
  /**
   * Дисплейные цвето-свотчи (легаси carre `.wv__colors`); [] → блок не рендерится.
   * Поле опционально для устойчивости к старым ответам API без него.
   */
  colors?: ProductColorDto[];
  variants: VariantDto[];
  media: MediaDto[];
  inStock: boolean;
  availableQty: number;
  meta: SeoMetaDto;
}

export interface PublicSocialDto {
  type: string;
  url: string;
}

/**
 * Способ доставки, доступный покупателю (зеркало PublicDeliveryMethod из
 * Uni_BD/lib/storefront/settings-dto.ts). Это ВОЗМОЖНОСТЬ магазина, а не имя
 * модуля платформы: витрина не знает и не должна знать про ADMIK_MODULES.
 */
export type DeliveryMethod = 'zone' | 'cdek_courier' | 'cdek_pvz';

// -----------------------------------------------------------------------------
// Оформление заказа (чекаут). Формы входа сверены ДОСЛОВНО с Zod-схемами Admik
// (Uni_BD/lib/orders/schemas.ts: CartQuoteSchema, CreateOrderSchema,
// deliverySelectionSchema, cartLineSchema) и публичными DTO ответов
// (lib/storefront/order-dto.ts: QuoteDto, OrderCreatedDto, OrderPublicDto),
// а также роутами delivery/cdek/* и payments/init (эквайер выбирает сервер).
// Anti-tamper (ADR-010): в телах запроса НЕТ полей цены — сумму считает сервер.
// -----------------------------------------------------------------------------

/** Позиция корзины на входе quote/orders — variantId ИЛИ productId + qty. */
export interface CartLineInput {
  variantId?: string;
  productId?: string;
  qty: number;
}

/** Способ доставки (orders.delivery_type). */
export type CheckoutDeliveryType = 'courier' | 'pvz' | 'pickup';

/** Способ оплаты (orders.payment_method). Онлайн-эквайринг (PayKeeper) = 'card'. */
export type CheckoutPaymentMethod =
  | 'unset'
  | 'cod'
  | 'card'
  | 'sbp'
  | 'cdek_pay'
  | 'invoice';

/** Выбор доставки на входе (стоимость считает сервер — её здесь нет). */
export interface DeliverySelectionInput {
  type: CheckoutDeliveryType;
  city?: string;
  /** Числовой код города СДЭК (из /cdek/cities) — точнее строкового city. */
  cityCode?: number;
  address?: string;
  pvzCode?: string;
  /** id зоны доставки из настроек (ТЗ_1) — цену берёт сервер по этому id. */
  zoneId?: string;
  /** Постамат — подвид ПВЗ с автовыдачей (флаг поверх type='pvz'). */
  isPostamat?: boolean;
}

/** Тело POST /cart/quote (CartQuoteSchema). */
export interface CartQuoteRequest {
  items: CartLineInput[];
  promoCode?: string;
  /**
   * Код подарочного сертификата (giftCertificateCodeSchema). Стекается ПОВЕРХ
   * промокода к остатку: сервер списывает min(остаток сертификата, нетто-товары
   * после промо) — сумму считает только он (anti-tamper).
   */
  giftCertificateCode?: string;
  delivery?: DeliverySelectionInput;
}

/** Контакты покупателя (customerContactSchema). */
export interface CustomerContactInput {
  name: string;
  email: string;
  phone: string;
}

/** Тело POST /orders (CreateOrderSchema). */
export interface CreateOrderRequest {
  items: CartLineInput[];
  customer: CustomerContactInput;
  delivery: DeliverySelectionInput;
  paymentMethod: CheckoutPaymentMethod;
  promoCode?: string;
  /**
   * Код подарочного сертификата. При создании заказа списывается атомарно в
   * транзакции; сумму списания определяет сервер. Полное покрытие → заказ
   * рождается уже оплаченным (paymentStatus='paid'), онлайн-шлюз не нужен.
   */
  giftCertificateCode?: string;
  comment?: string;
  idempotencyKey?: string;
  /**
   * Итог, который ВИДИТ покупатель на момент нажатия «Оплатить» (= quote.grandTotal).
   * Сервер сверяет его со своим пересчитанным итогом и при расхождении отказывает
   * причиной `total_mismatch` вместо тихого создания заказа (аудит: находки №2/№9).
   *
   * 🔴 Это НЕ цена: anti-tamper не ослаблен — сумму по-прежнему считает только
   * сервер, а поле служит исключительно ОЖИДАНИЕМ для сравнения. Опционально —
   * старый клиент без него работает как раньше.
   */
  expectedGrandTotal?: string;
  /**
   * КОД валюты, в которой покупатель СМОТРЕЛ цены на витрине (ISO-4217). Сервер
   * сохраняет снимок «что было на экране» (orders.display_currency/rate/total,
   * миграция 0059), чтобы через неделю можно было разобрать претензию: курс ЦБ
   * меняется ежедневно и нигде больше не фиксируется.
   *
   * 🔴 ЭТО НЕ ДЕНЬГИ. Ни курс, ни сумма в валюте показа не отправляются: сервер
   * берёт курс из настроек магазина и считает справочный итог сам от своего
   * grandTotal (ADR-010 anti-tamper). Подделка кода меняет лишь СПРАВОЧНУЮ
   * подпись в карточке заказа, но не сумму к оплате.
   *
   * Отсутствует, когда покупатель смотрел в базовой валюте магазина.
   */
  displayCurrency?: string;
}

/**
 * Блок подарочного сертификата в ответе /cart/quote (GiftQuoteDto платформы).
 * Номинал и суммарно потраченное НЕ раскрываются (бирер-инструмент) — витрина
 * видит только факт применения, списанную сумму и остаток ПОСЛЕ заказа.
 */
export interface GiftQuoteDto {
  /** Сертификат реально уменьшил сумму к оплате. */
  applied: boolean;
  /** Эхо переданного кода. */
  code: string;
  /** Списано сертификатом на этот заказ (NUMERIC-строка). */
  appliedAmount: string;
  /** Остаток сертификата ПОСЛЕ применения. */
  balanceRemainingAfter: string;
  /** Машинная причина отказа (not_found/expired/depleted/disabled/no_amount_due); null — применён. */
  reason: string | null;
}

/** Позиция расчёта корзины (QuoteLineDto). */
export interface QuoteLineDto {
  name: string;
  sku: string;
  unitPrice: string;
  compareAtPrice: string | null;
  qty: number;
  lineTotal: string;
  isGift: boolean;
}

/** Ответ POST /cart/quote (QuoteDto). Все суммы — строки NUMERIC в рублях. */
export interface QuoteDto {
  itemsTotal: string;
  discountTotal: string;
  giftDiscountTotal: string;
  deliveryTotal: string;
  grandTotal: string;
  currency: string;
  lines: QuoteLineDto[];
  promo: {
    applied: boolean;
    code: string | null;
    discount: string;
    reason: string | null;
  };
  /** Итог применения сертификата; null — код к корзине не применяли. */
  gift: GiftQuoteDto | null;
  delivery: {
    free: boolean;
    freeThresholdMet: boolean;
    cost: string;
    /** false → расчёт СДЭК был нужен, но упал; cost не доверять, не оформлять. */
    available: boolean;
  };
  fulfillable: boolean;
  issues: Array<{ index: number; code: string }>;
}

/** Ответ POST /orders (OrderCreatedDto). */
export interface OrderCreatedDto {
  number: string;
  status: string;
  paymentStatus: string;
  grandTotal: string;
  giftDiscountTotal: string;
  currency: string;
  /** Токен для GET /orders/:number (трекинг/страница успеха). */
  accessToken: string;
}

/**
 * Ответ POST /payments/init — инициация оплаты у АКТИВНОМ эквайере магазина.
 *
 * 🔴 Витрина НЕ знает, какой эквайер настроен: сервер выбирает его сам и лишь
 * НАЗЫВАЕТ в ответе (для логов/диагностики). Раньше здесь был PayKeeper-специфичный
 * DTO и жёсткий путь `/payments/paykeeper/init` — из-за этого при активном другом
 * эквайере покупателя уводило на mock-страницу PayKeeper (аудит major №1).
 */
export interface PaymentInitDto {
  /** Куда редиректить покупателя: invoice_url / PaymentURL / formUrl (в mock — demo-URL). */
  paymentUrl: string;
  /** Идентификатор счёта у эквайера (нормализован сервером). */
  paymentId: string;
  /** Имя эквайера, реально выставившего счёт ('tbank' | 'paykeeper' | 'alfabank'). */
  provider: string;
  status: string;
  isMock: boolean;
  /** Алиас paymentId для PayKeeper — обратная совместимость, витриной не используется. */
  invoiceId?: string;
}

/** Город СДЭК (GET /cdek/cities). */
export interface CdekCityDto {
  code: number;
  name: string;
  region: string;
}

/** ПВЗ/постамат СДЭК (GET /cdek/pvz). */
export interface CdekPvzDto {
  code: string;
  name: string;
  address: string;
  type: string;
  location: { latitude: number; longitude: number } | null;
  workTime: string | null;
}

/** Позиция заказа для трекинга (OrderItemDto). */
export interface OrderItemDto {
  name: string;
  sku: string;
  attributes: Record<string, unknown>;
  unitPrice: string;
  compareAtPrice: string | null;
  qty: number;
  lineTotal: string;
  isGift: boolean;
}

/** Публичный статус заказа (GET /orders/:number → OrderPublicDto). */
export interface OrderPublicDto {
  number: string;
  status: string;
  paymentStatus: string;
  deliveryStatus: string;
  statusLabel: string;
  paymentStatusLabel: string;
  deliveryStatusLabel: string;
  itemsTotal: string;
  discountTotal: string;
  giftDiscountTotal: string;
  deliveryTotal: string;
  grandTotal: string;
  currency: string;
  promoCode: string | null;
  paymentMethod: string;
  /**
   * Время ПОСЛЕДНЕЙ инициации платежа (ISO); null — счёт не выставляли.
   *
   * 🔴 Единственный способ отличить «оплатил и вернулся раньше вебхука» от «не
   * платил вовсе»: пока с этого момента прошло мало времени, кнопку «оплатить»
   * показывать нельзя — это второе списание (см. lib/payment-result).
   *
   * НЕОБЯЗАТЕЛЬНОЕ: поле добавлено в DTO позже (миграция 0058), а витрина и
   * админка выкатываются независимо — старый сервер его не пришлёт. undefined
   * означает «сервер не знает» и трактуется как отсутствие инициации.
   */
  paymentInitiatedAt?: string | null;
  delivery: {
    type: string;
    isPostamat: boolean;
    city: string | null;
    /**
     * Адрес курьерской доставки. НЕОБЯЗАТЕЛЬНОЕ: поле добавлено в DTO позже
     * (аудит №5), а витрина и админка выкатываются независимо — старый сервер
     * его не пришлёт. Рендер обязан переживать undefined (см. order-view).
     */
    address?: string | null;
    /** Код пункта выдачи/постамата. Необязательное — как address (version skew). */
    pvzCode?: string | null;
    track: string | null;
  };
  items: OrderItemDto[];
  createdAt: string;
}

/**
 * Форма ошибки Storefront API: { error: { code, message, reason? } }.
 *
 * `code` — ТРАНСПОРТНЫЙ код (unprocessable/conflict/not_found/…): HTTP-семантика,
 * по нему нельзя понять причину отказа.
 * `reason` — ДОМЕННАЯ причина из публичного алфавита платформы (out_of_stock,
 * invalid_promo, invalid_gift, delivery_unavailable, …). Необязательное поле:
 * старый сервер его не присылает. Именно по нему витрина выбирает свой перевод.
 * `message` — диагностика на языке магазина; ПОКУПАТЕЛЮ НЕ ПОКАЗЫВАЕТСЯ (иначе
 * франкоязычный покупатель читает русскую серверную строку — аудит №3/№6).
 */
export interface StorefrontApiError {
  code: string;
  message: string;
  reason?: string;
}

// -----------------------------------------------------------------------------
// CMS-страницы (docs/11 §5.1.4, ADR-012). Форма сверена 1:1 с публичным DTO
// Admik (lib/storefront/cms-dto.ts → toPublicPageDto) и Zod-схемами секций
// (lib/cms/schemas.ts). Секция — { type, content }, где content дискриминирован
// полем type. Сырые ключи хранилища уже заменены публичными URL на стороне API
// (imageKey → imageUrl), поэтому здесь только *Url-поля.
// -----------------------------------------------------------------------------

/** Карта content по типу секции (после резолва медиа imageKey → imageUrl). */
export interface SectionContentByType {
  /** Rich-text: сервер-санитизированный HTML (admin-authored). */
  text: { html: string };
  hero: {
    title: string;
    subtitle?: string;
    html?: string;
    imageUrl?: string;
    ctaLabel?: string;
    ctaHref?: string;
  };
  banner: { imageUrl?: string; href?: string; alt?: string };
  gallery: { images: { imageUrl?: string; alt?: string }[] };
  faq: { items: { q: string; a: string }[] };
  /**
   * Подборка товаров по slug-фильтру (БЕЗ FK на каталог — витрина дотягивает
   * товары через существующий /products; инвариант 5.1). limit — из схемы (деф. 12).
   */
  products_grid: {
    mode: 'slugs' | 'category' | 'brand';
    slugs?: string[];
    categorySlug?: string;
    brandSlug?: string;
    limit?: number;
    title?: string;
  };
  cta: { title: string; html?: string; buttonLabel: string; buttonHref: string };
}

/** Тип секции CMS (дискриминатор). */
export type CmsSectionType = keyof SectionContentByType;

/** Публичная секция страницы — дискриминированный union по `type`. */
export type PageSection = {
  [K in CmsSectionType]: { type: K; content: SectionContentByType[K] };
}[CmsSectionType];

/** Публичная CMS-страница (детальная, для /pages/[slug]). */
export interface PageDto {
  slug: string;
  title: string;
  meta: SeoMetaDto;
  sections: PageSection[];
}

/**
 * Строка списка страниц (`GET /pages`) — источник бокового меню разделов
 * доп-страниц. `showInNav`/`navOrder` опциональны намеренно: витрина может
 * временно работать со старым Admik, где миграции 0060 ещё нет; тогда боковик
 * просто пуст (см. buildPageNav), а страницы рендерятся на всю ширину.
 */
export interface PageListItemDto {
  slug: string;
  title: string;
  meta: SeoMetaDto;
  showInNav?: boolean;
  navOrder?: number | null;
}

export interface PublicSettingsDto {
  branding: {
    shopName: string;
    logoUrl: string | null;
    faviconUrl: string | null;
    theme: {
      primaryColor: string | null;
      accentColor: string | null;
      mode: 'light' | 'dark' | 'system';
    };
    supportEmail: string | null;
    supportPhone: string | null;
  };
  currency: {
    code: string;
    symbol: string | null;
    locale: string | null;
    fractionDigits: number;
    /**
     * Доп.валюты ОТОБРАЖЕНИЯ (мультивалюта, ₽/€). Базовая — code выше; эти —
     * переключаемые в шапке для показа по курсу (rate = единиц базовой за 1 единицу
     * этой; цена_€ = цена_₽ / rate). Пустой/отсутствует → показ только базовой (₽),
     * как раньше. Опционально для устойчивости к старым ответам API без поля.
     */
    displayCurrencies?: {
      code: string;
      symbol: string;
      rate: number;
      fractionDigits: number;
    }[];
  };
  contacts: {
    phone: string | null;
    email: string | null;
    address: string | null;
    workingHours: string | null;
    socials: PublicSocialDto[];
  };
  /**
   * Публичные реквизиты юрлица (БЕЗ приватных bankDetails). Витрине отсюда нужен
   * `emailDesigners` — вторая приёмная почта в низу выезжающего меню («Для
   * дизайнеров», эталон docs/41 §2). Секция и поле опциональны ЦЕЛИКОМ (version
   * skew: старая админка их ещё не отдаёт, магазин без дизайнерского направления
   * не заполняет) — отсутствие означает «блока в меню нет», а не ошибку.
   */
  legalEntity?: {
    name?: string | null;
    inn?: string | null;
    kpp?: string | null;
    ogrn?: string | null;
    legalAddress?: string | null;
    emailDesigners?: string | null;
  };
  /**
   * Доставка (ТЗ_1): порог бесплатной доставки + зоны (Москва в МКАД / за МКАД).
   * Деньги — в КОПЕЙКАХ. Опционально для устойчивости к старым ответам API.
   */
  delivery?: {
    freeDeliveryThreshold: number;
    zones: Array<{
      id: string;
      label: string;
      price: number;
      freeThreshold: number | null;
    }>;
    /**
     * 🔴 Аудит №20 — ДОСТУПНЫЕ способы доставки (возможности магазина, не модули
     * платформы). Чекаут предлагает покупателю строго то, что здесь перечислено:
     * при выключенном модуле СДЭК его способов тут нет, и радио не рендерятся
     * (иначе роуты /delivery/cdek/* отвечают 404 и покупатель — в тупике).
     * Поле опционально: старый ответ API без него → считаем СДЭК доступным
     * (прежнее поведение витрины, без регресса).
     */
    methods?: DeliveryMethod[];
  };
  seo: {
    siteName: string | null;
    siteUrl: string | null;
    titleTemplate: string;
    defaultDescription: string | null;
    twitterSite: string | null;
  };
  home: {
    hero: {
      title: string | null;
      subtitle: string | null;
      imageUrl: string | null;
      ctaLabel: string | null;
      ctaHref: string | null;
    };
    about: { title: string; paragraphs: string[]; imageUrls: string[]; values: string[] };
    /**
     * «Образы» (lookbook) v2: вкладки-категории + карточки карусели «автор + фото».
     * У категории `text`/`imageUrl` — наследие v1 (статичная сетка), в v2-рендере
     * не используются, но остаются в контракте ради совместимости.
     */
    looks: {
      enabled: boolean;
      title: string;
      categories: { id: string; title: string; text: string; imageUrl: string }[];
      items: {
        categoryId: string;
        imageUrl: string;
        authorName: string;
        authorAvatarUrl: string | null;
      }[];
    };
    /** M4 — «Плитки категорий» (.dop-links--adaptive): показ + плитки (imageUrl — публичный URL). */
    tiles: {
      enabled: boolean;
      items: { title: string; href: string; imageUrl: string }[];
    };
    /** M4 — «Видео» (.mainpage--video): показ + embedUrl (уже готовый публичный URL). */
    video: { enabled: boolean; embedUrl: string };
    /** M4 — «Витрина дизайнеров» (.mainpage--designers): avatarUrl/workUrl — публичные URL, *Top — inline top в %. */
    designers: {
      enabled: boolean;
      title: string;
      items: {
        name: string;
        href: string;
        avatarUrl: string;
        workUrl: string;
        avatarTop: number;
        workTop: number;
      }[];
    };
    /** M5 — «Промо-слайдер» (.mainpage--slider): показ + слайды (imageUrl — публичный URL; name/caption — подписи). */
    slider: {
      enabled: boolean;
      slides: { imageUrl: string; href: string; name: string; caption: string }[];
    };
    /** M5 — «Корпоративным / сертификаты» (.dop-links--vertical): показ + плитки-ссылки (imageUrl — публичный URL). */
    corpCert: {
      enabled: boolean;
      tiles: { imageUrl: string; href: string; title: string }[];
    };
  };
  navigation: {
    header: { label: string; href: string }[];
    footer: { title: string; links: { label: string; href: string }[] }[];
    /**
     * Подвал (эталон `.footer-top__subscriptions` + `.footer-foot`): заголовок
     * рассылки, приписка о согласии, копирайт, кредит студии. Пустая строка =
     * владелец не задал → берётся словарный дефолт локали (см. SiteFooter).
     * Опционально ЦЕЛИКОМ — version skew: старая админка это поле ещё не отдаёт.
     */
    footerMeta?: {
      subscribeTitle: string;
      subscribeNote: string;
      copyright: string;
      designedByLabel: string;
      designedByHref: string;
    };
  };
  /**
   * Набор языков магазина (ключ i18n ∩ whitelist платформы). Контракт трека A:
   * выключение языка в админке убирает его из `locales` — витрина рендерит
   * переключатель/hreflang только по этому набору (см. enabledLocalesFrom).
   * defaultLocale — язык базовых (непереведённых) полей, живёт на корне без префикса.
   * Опционально для устойчивости к старым ответам API без поля (тогда fail-open).
   */
  i18n?: {
    defaultLocale: string;
    locales: string[];
  };
}
