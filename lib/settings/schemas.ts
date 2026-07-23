/**
 * Zod-схемы значений `shop_settings.value` по ключам (docs/11 §5.4.1).
 *
 * Одна строка таблицы = одна логическая группа настроек (НЕ плоский blob и НЕ
 * таблица-на-ключ). `value` каждого ключа типизирован своей схемой; неизвестные
 * поля ОТБРАСЫВАЮТСЯ Zod (по умолчанию `.strip()`) — анти-tamper для JSONB.
 *
 * Семантика merge (§7 инвариант): env-дефолт ⊕ строка БД, частичный merge на
 * уровне полей. Пустой объект `{}` = «нет оверрайда» → берётся env. Деньги в
 * `value` (delivery.freeDeliveryThreshold) — в КОПЕЙКАХ (int), без float.
 *
 * Экспортируется как ОБЫЧНЫЙ модуль (не 'use server') — содержит схемы/типы,
 * переиспользуемые и слоем настроек, и Server Actions, и UI-формами.
 */

import { z } from 'zod';

// -----------------------------------------------------------------------------
// Переиспользуемые примитивы.
// -----------------------------------------------------------------------------

/** Непустая строка с тримом. */
const nonEmpty = z.string().trim().min(1);

/** Опциональный URL (пустая строка не допускается — поле либо есть, либо нет). */
const urlField = z.string().trim().url();

/**
 * Ссылка на изображение настроек (логотип/favicon). Допускает:
 *  - абсолютный http(s)-URL (внешний хостинг или S3 с заданным S3_PUBLIC_URL);
 *  - относительный путь от «/» — так отдаёт ЛОКАЛЬНОЕ хранилище по умолчанию
 *    (LocalStorage publicBase='/media' → '/media/settings/logo/<uuid>.webp').
 *
 * Фикс ревью Batch 6: раньше logoUrl/faviconUrl требовали .url() (абсолютный URL),
 * поэтому загрузка логотипа в дефолтном (local) режиме хранилища писала относительный
 * '/media/…', а последующее сохранение формы брендинга падало валидацией → форма
 * становилась несохраняемой. Относительный путь — валидная same-origin ссылка на
 * картинку. Опасный 'javascript:' и пустая строка отсекаются.
 */
const imageRefSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) => v.startsWith('/') || /^https?:\/\/\S+$/i.test(v),
    'Укажите URL картинки (https://…) или путь от «/» (например /media/…)',
  );

/**
 * Ссылка-маршрут для CTA/навигации (находка 21 аудита). Допускает:
 *  - относительный путь от «/» (включая «/#anchor»): /catalog, /product/x, /#delivery;
 *  - полный http(s)-URL: https://shop.ru;
 *  - контактные схемы mailto:/tel: (для ссылок футера/навигации).
 * Отсекает частые опечатки, ведущие на 404: «catolog» (без «/»), «www.site.ru»
 * (без протокола), пустую строку, опасный «javascript:».
 */
const hrefSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (v) =>
      v.startsWith('/') ||
      /^https?:\/\/\S+$/i.test(v) ||
      /^(?:mailto:|tel:)\S+$/i.test(v),
    'Укажите путь от «/» (например /catalog или /#delivery) либо полный URL https://…',
  );

/**
 * Ссылка-маршрут ВНУТРЕННЕЙ навигации витрины (M5 — slider/corpCert). СТРОЖЕ, чем
 * hrefSchema: допускает ТОЛЬКО относительный путь от «/» ИЛИ полный https://-URL.
 * Отсекает http:// (открытый редирект/mixed-content), mailto:/tel:, javascript:,
 * data: и опечатки без «/». Зеркалит https-only гвард video.embedUrl из M4 и
 * defense-in-depth designer.href: применяется к href слайдов промо-слайдера и
 * плиток corp/cert (onclick=window.location.href / <a href>), где значение может
 * прийти из настроек магазина — анти-XSS/анти-open-redirect.
 */
const internalHrefSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    // `/path` (но НЕ `//host` — protocol-relative = скрытый open-redirect на чужой
    // хост) ИЛИ полный https://-URL.
    (v) => (v.startsWith('/') && !v.startsWith('//')) || /^https:\/\/\S+$/i.test(v),
    'Укажите путь от «/» (например /search?q=…) либо полный URL https://…',
  );

/** HEX-цвет вида #rgb / #rrggbb (для темы брендинга). */
const hexColor = z
  .string()
  .trim()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Ожидается HEX-цвет (#rgb или #rrggbb)');

/** ISO 4217 — буквенный код валюты (3 заглавные латинские). */
const currencyCode = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, 'Код валюты — 3 заглавные латинские буквы (ISO 4217)');

/** ИНН: ровно 10 (юрлицо) или 12 (ИП/физлицо) цифр. */
const innField = z
  .string()
  .trim()
  .regex(/^(?:\d{10}|\d{12})$/, 'ИНН — 10 или 12 цифр');

/** Денежная величина в копейках (целое, ≥ 0). */
const minorMoney = z.number().int().min(0);

// -----------------------------------------------------------------------------
// Схемы значений по ключам (§5.4.1). Все объекты — `partial`/опциональные поля,
// т.к. строка БД хранит ТОЛЬКО оверрайды; отсутствующее поле → env-дефолт.
// -----------------------------------------------------------------------------

/** branding — название/логотип/тема/контакты поддержки. */
export const brandingSchema = z
  .object({
    shopName: nonEmpty.optional(),
    // logo/favicon — абсолютный URL ИЛИ относительный путь от «/» (так отдаёт
    // локальное хранилище по умолчанию). См. imageRefSchema (фикс ревью Batch 6).
    logoUrl: imageRefSchema.optional(),
    faviconUrl: imageRefSchema.optional(),
    theme: z
      .object({
        primaryColor: hexColor.optional(),
        accentColor: hexColor.optional(),
        mode: z.enum(['light', 'dark', 'system']).optional(),
      })
      .optional(),
    supportEmail: z.string().trim().email().optional(),
    supportPhone: z.string().trim().min(1).optional(),
  })
  .strip();

/** currency — валюта магазина. */
export const currencySchema = z
  .object({
    code: currencyCode.optional(),
    symbol: z.string().trim().min(1).optional(),
    locale: z.string().trim().min(1).optional(),
    fractionDigits: z.number().int().min(0).max(4).optional(),
  })
  .strip();

/**
 * exchange — мультивалюта ОТОБРАЖЕНИЯ (₽/€ и т.п.). Базовая валюта магазина
 * остаётся в `currency` (RUB): цены товаров хранятся и списываются В РУБЛЯХ.
 * Здесь — только доп.валюты для ПОКАЗА на витрине по курсу (реальные деньги в €
 * не участвуют; эквайринг рублёвый).
 *
 * Модель:
 *  - displayCurrencies[] — валюты отображения. Для каждой:
 *      code   — ISO 4217 (EUR);
 *      symbol — знак (€);
 *      rate   — единиц БАЗОВОЙ валюты за 1 единицу отображаемой
 *               (EUR rate=100 → 1€=100₽ → цена_€ = цена_₽ / rate);
 *      fractionDigits — знаков после запятой при показе (опц.; € обычно 2);
 *      manualRate — курс задан ВРУЧНУЮ: крон ЦБ эту валюту не обновляет (опц.);
 *      rateUpdatedAt — своя метка обновления курса этой валюты (опц.).
 *  - autoRate — обновлять ли rate кроном автоматически с ЦБ РФ (fallback —
 *    ручной rate из этой же настройки, если ЦБ недоступен).
 *  - rateUpdatedAt — ISO-метка последнего успешного обновления курса (диагностика/UI).
 *
 * Все поля опциональны, `.strip()` (анти-tamper JSONB). Отсутствие ключа/пустой
 * объект → доп.валют нет → витрина показывает только базовую (₽) как раньше.
 */
export const displayCurrencySchema = z
  .object({
    code: currencyCode,
    symbol: z.string().trim().min(1),
    // rate > 0: цена_отображаемой = цена_базовой / rate — деление на 0/отрицательный
    // курс недопустимо. positive() отсекает 0 и отрицательные.
    rate: z.number().positive('Курс должен быть больше нуля'),
    fractionDigits: z.number().int().min(0).max(4).optional(),
    // ПЕР-ВАЛЮТНЫЙ ручной курс: true → ночной крон ЦБ эту валюту не трогает.
    // ОБЯЗАТЕЛЬНО опционально: на живых стендах лежат значения без этого поля,
    // а parseSettingValue при несовпадении схемы вернул бы null и молча уронил
    // весь раздел exchange на дефолты (переключатель валют исчез бы с витрины).
    manualRate: z.boolean().optional(),
    // Своя метка обновления курса ИМЕННО этой валюты (крон ставит при авто-
    // обновлении, форма — при ручном сохранении). Опционально — см. выше.
    rateUpdatedAt: z.string().trim().min(1).optional(),
  })
  .strip();

export const exchangeSchema = z
  .object({
    autoRate: z.boolean().optional(),
    rateUpdatedAt: z.string().trim().min(1).optional(),
    displayCurrencies: z.array(displayCurrencySchema).optional(),
  })
  .strip();

/** units — единицы измерения веса/габаритов. */
export const unitsSchema = z
  .object({
    weight: z.enum(['g', 'kg']).optional(),
    dimension: z.enum(['cm', 'mm']).optional(),
    system: z.literal('metric').optional(),
  })
  .strip();

/** contacts — публичные контакты магазина. */
export const contactsSchema = z
  .object({
    phone: z.string().trim().min(1).optional(),
    email: z.string().trim().email().optional(),
    address: z.string().trim().min(1).optional(),
    workingHours: z.string().trim().min(1).optional(),
    socials: z
      .array(
        z.object({
          type: nonEmpty,
          url: urlField,
        }),
      )
      .optional(),
  })
  .strip();

/** legal_entity — реквизиты юрлица (приватные: bankDetails наружу не отдаём). */
export const legalEntitySchema = z
  .object({
    name: nonEmpty.optional(),
    inn: innField.optional(),
    kpp: z
      .string()
      .trim()
      .regex(/^\d{9}$/, 'КПП — 9 цифр')
      .optional(),
    ogrn: z
      .string()
      .trim()
      .regex(/^(?:\d{13}|\d{15})$/, 'ОГРН — 13 или 15 цифр')
      .optional(),
    legalAddress: z.string().trim().min(1).optional(),
    bankDetails: z.string().trim().min(1).optional(),
    // §9 (← c_options): аддитивные опц. поля, обратно совместимы (.strip() уже
    // терпит отсутствие; старые настройки без них валидны).
    /** Ключ S3-файла оферты (offer_doc). Как og_image_key — КЛЮЧ, URL собирает storage. */
    offerDocKey: z.string().trim().max(512).optional(),
    /** Почта для заявок дизайнеров (email_designers). */
    emailDesigners: z.string().trim().email('Некорректный e-mail').optional(),
  })
  .strip();

/** catalog — оверрайд SHOP_NEW_PRODUCT_DAYS. */
/**
 * Позиция справочника мастер-цветов магазина (оверрайд DEFAULT_MASTER_COLORS,
 * lib/catalog/master-colors.ts). Задан → ЗАМЕНЯЕТ дефолтный список платформы
 * целиком; не задан/пуст → дефолт. hex — '#rrggbb' (канонизацию и отбраковку
 * битых записей делает resolveMasterColors). До 64 позиций — защита от мусора
 * в JSONB, легаси-справочник был на 13.
 */
export const masterColorSchema = z
  .object({
    id: nonEmpty,
    name: nonEmpty,
    hex: z.string().trim().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strip();

export const catalogSettingsSchema = z
  .object({
    newProductDays: z.number().int().min(0).optional(),
    /** Справочник мастер-цветов магазина (мультитенантный оверрайд, п.4 ТЗ). */
    masterColors: z.array(masterColorSchema).max(64).optional(),
  })
  .strip();

/**
 * Зона доставки (ТЗ_1) — универсальная, задаётся магазином в админке.
 *  - id: стабильный slug (напр. "mkad_in") — генерируется из label при создании;
 *  - label: человекочитаемое имя зоны («В пределах МКАД»);
 *  - price: цена доставки в зоне, КОПЕЙКИ (int ≥ 0), как freeDeliveryThreshold;
 *  - freeThreshold: опц. порог бесплатной доставки ИМЕННО для этой зоны (копейки);
 *    задан → перекрывает общий порог магазина для заказов в эту зону.
 * `.strip()` — анти-tamper JSONB. Никакого хардкода конкретного города/магазина.
 */
export const deliveryZoneSchema = z
  .object({
    id: nonEmpty,
    label: nonEmpty,
    price: minorMoney,
    freeThreshold: minorMoney.optional(),
  })
  .strip();

/** delivery — оверрайд SHOP_FREE_DELIVERY_THRESHOLD (в КОПЕЙКАХ) + зоны доставки. */
export const deliverySettingsSchema = z
  .object({
    freeDeliveryThreshold: minorMoney.optional(),
    zones: z.array(deliveryZoneSchema).optional(),
  })
  .strip();

/** orders — оверрайд SHOP_ORDER_PREFIX. */
export const ordersSettingsSchema = z
  .object({
    orderPrefix: z.string().trim().optional(),
  })
  .strip();

/**
 * module_overrides — частичный оверрайд ADMIK_MODULES.
 * Отсутствие поля → берётся env-набор (getEnabledModules); явный true/false —
 * включает/выключает соответствующий модуль поверх env. `settings` НЕ входит в
 * схему (core-always-on — не может прятаться за флагом, который сам переключает).
 */
export const moduleOverridesSchema = z
  .object({
    catalog: z.boolean().optional(),
    orders: z.boolean().optional(),
    cdek: z.boolean().optional(),
    cms: z.boolean().optional(),
    payments: z.boolean().optional(),
    news: z.boolean().optional(),
    reviews: z.boolean().optional(),
    account: z.boolean().optional(),
  })
  .strip();

/** seo — дефолты SEO/sitemap/robots (используется подсистемой 5.3). */
export const seoSettingsSchema = z
  .object({
    site_name: z.string().trim().min(1).optional(),
    site_url: urlField.optional(),
    title_template: z.string().trim().min(1).optional(),
    default_description: z.string().trim().optional(),
    default_og_image_key: z.string().trim().optional(),
    robots_extra: z.string().trim().optional(),
    twitter_site: z.string().trim().optional(),
    noindex_site: z.boolean().optional(),
  })
  .strip();

/**
 * home — редактируемый контент главной страницы витрины (ADR-018).
 *
 * Именованные блоки (hero/about/quality/delivery); все поля опциональны и
 * `.strip()` (анти-tamper JSONB). Изображения хранятся КЛЮЧАМИ S3 (imageKey/
 * imageKeys), не URL — единый контракт с CMS (ADR-012); витрина резолвит ключ в
 * URL на своей стороне. Семантика merge (§5.4.1): строка БД хранит оверрайд
 * блока ЦЕЛИКОМ; отсутствие блока → дефолт витрины (lib/config/home-defaults).
 */
export const homeSchema = z
  .object({
    hero: z
      .object({
        title: z.string().trim().min(1).optional(),
        subtitle: z.string().trim().min(1).optional(),
        imageKey: z.string().trim().min(1).optional(),
        ctaLabel: z.string().trim().min(1).optional(),
        // Ссылка всей обложки (главный CTA) — валидируем маршрут, чтобы опечатка
        // не делала баннер битым (находка 21 аудита).
        ctaHref: hrefSchema.optional(),
      })
      .strip()
      .optional(),
    about: z
      .object({
        title: z.string().trim().min(1).optional(),
        paragraphs: z.array(z.string().trim().min(1)).optional(),
        imageKeys: z.array(z.string().trim().min(1)).optional(),
        values: z.array(z.string().trim().min(1)).optional(),
      })
      .strip()
      .optional(),
    quality: z
      .object({
        title: z.string().trim().min(1).optional(),
        items: z.array(z.string().trim().min(1)).optional(),
      })
      .strip()
      .optional(),
    delivery: z
      .object({
        items: z
          .array(
            z
              .object({
                title: nonEmpty,
                text: nonEmpty,
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
    // B1 — лента ценностей: показ (enabled) + список пар title/text. По умолчанию
    // (нет оверрайда) лента скрыта; opt-in включение из админки без правки кода.
    valuesStrip: z
      .object({
        enabled: z.boolean().optional(),
        items: z
          .array(z.object({ title: nonEmpty, text: nonEmpty }).strip())
          .optional(),
      })
      .strip()
      .optional(),
    // B3 — философия: надзаголовок/заголовок/абзац + ссылка (label/href).
    // linkHref валидируется как маршрут (как hero.ctaHref), чтобы не вёл на 404.
    philosophy: z
      .object({
        eyebrow: z.string().trim().min(1).optional(),
        title: z.string().trim().min(1).optional(),
        text: z.string().trim().min(1).optional(),
        linkLabel: z.string().trim().min(1).optional(),
        linkHref: hrefSchema.optional(),
      })
      .strip()
      .optional(),
    // ТЗ_2 — «Образы» (lookbook): опц. заголовок + список категорий, каждая =
    // фото (imageKey S3, ADR-012 — DTO резолвит в URL) + заголовок + абзац. По
    // умолчанию (нет оверрайда) блок скрыт и пуст; магазин наполняет его в админке
    // без правки кода. Универсальный блок — никакого хардкода под нишу магазина.
    looks: z
      .object({
        enabled: z.boolean().optional(),
        title: z.string().trim().min(1).optional(),
        categories: z
          .array(
            z
              .object({
                title: nonEmpty,
                text: nonEmpty,
                imageKey: z.string().trim().min(1),
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
    // M4 — «Плитки категорий» (.dop-links--adaptive): список плиток title +
    // ссылка (hrefSchema — не 404) + фото (imageKey S3, DTO резолвит в URL). По
    // умолчанию скрыт и пуст; наполняется в админке без кода (мультитенант).
    tiles: z
      .object({
        enabled: z.boolean().optional(),
        items: z
          .array(
            z
              .object({
                title: nonEmpty,
                href: hrefSchema,
                imageKey: z.string().trim().min(1),
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
    // M4 — «Видео» (.mainpage--video): один embed-URL для iframe. ОБЯЗАТЕЛЬНО
    // https (анти-XSS: src iframe не должен принять javascript:/data: — Zod
    // отвергает не-https). Пусто → блок не рендерится.
    video: z
      .object({
        enabled: z.boolean().optional(),
        embedUrl: z.string().trim().url().startsWith('https://').optional(),
      })
      .strip()
      .optional(),
    // M4 — «Дизайнеры» (.mainpage--designers): опц. заголовок + список записей,
    // каждая = имя + ссылка (hrefSchema) + аватар/работа (ключи S3, DTO резолвит
    // в URL) + avatarTop/workTop (0..100, вертикальное позиционирование фото;
    // опц. → merge добивает 50). По умолчанию скрыт и пуст; без хардкода ниши.
    designers: z
      .object({
        enabled: z.boolean().optional(),
        title: z.string().trim().min(1).optional(),
        items: z
          .array(
            z
              .object({
                name: nonEmpty,
                href: hrefSchema,
                avatarImageKey: z.string().trim().min(1),
                workImageKey: z.string().trim().min(1),
                avatarTop: z.number().int().min(0).max(100).optional(),
                workTop: z.number().int().min(0).max(100).optional(),
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
    // M5 — «Промо-слайдер» (.mainpage--slider): opt-in массив слайдов. Каждый =
    // фон (imageKey S3, DTO резолвит в URL) + ссылка (internalHrefSchema: только
    // относительный путь или https — анти-XSS/анти-open-redirect для onclick=
    // window.location.href) + name/caption (оба опциональны: у живого carre name
    // пуст, caption «Всем по икре»). По умолчанию скрыт и пуст; без хардкода ниши.
    slider: z
      .object({
        enabled: z.boolean().optional(),
        slides: z
          .array(
            z
              .object({
                imageKey: z.string().trim().min(1),
                href: internalHrefSchema,
                name: z.string().trim().min(1).optional(),
                caption: z.string().trim().min(1).optional(),
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
    // M5 — «Корпоративным / сертификаты» (.dop-links--vertical): opt-in массив
    // плиток-ссылок. Каждая = фото (imageKey S3, DTO резолвит в URL) + ссылка
    // (internalHrefSchema — только относит. путь или https) + заголовок. По
    // умолчанию скрыт и пуст; наполняется в админке без кода (мультитенант).
    corpCert: z
      .object({
        enabled: z.boolean().optional(),
        tiles: z
          .array(
            z
              .object({
                imageKey: z.string().trim().min(1),
                href: internalHrefSchema,
                title: nonEmpty,
              })
              .strip(),
          )
          .optional(),
      })
      .strip()
      .optional(),
  })
  .strip();

// -----------------------------------------------------------------------------
/**
 * navigation — меню шапки и колонки футера витрины (G-10/G-11). Все элементы
 * опциональны; пусто → витрина показывает навигацию по умолчанию. Позволяет
 * переименовать/добавить пункты меню и ссылки футера без правки кода (мультитенант).
 */
const navLinkSchema = z.object({ label: nonEmpty, href: hrefSchema }).strip();

export const navigationSchema = z
  .object({
    header: z.array(navLinkSchema).optional(),
    footer: z
      .array(
        z
          .object({
            title: nonEmpty,
            links: z.array(navLinkSchema),
          })
          .strip(),
      )
      .optional(),
  })
  .strip();

/**
 * access — флаги доступа уровня магазина (B9). Сейчас единственный флаг —
 * singleUserMode: «однопользовательский режим» инстанса. Когда включён, в админке
 * скрывается и блокируется управление пользователями и ролями (двойная защита:
 * меню + guard страниц + серверная блокировка мутаций). Поле опционально → дефолт
 * OFF при мердже (мультитенантность: другие магазины не затронуты без явного
 * включения). `.strip()` — анти-tamper JSONB, как у прочих ключей.
 */
export const accessSchema = z
  .object({
    singleUserMode: z.boolean().optional(),
  })
  .strip();

/**
 * Тег языка магазина: 'ru', 'en', 'pt-br', 'zh-hans'. Нормализуется (trim +
 * нижний регистр) ДО проверки формата, поэтому ' RU ' и 'ru' — одно и то же
 * значение и в БД попадает канонический вид. Набор языков задаётся per-shop
 * (мультитенантность), а не перечислением в типе.
 */
const localeTagField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/,
    'Код языка вида «ru», «en», «pt-br» (латиница, части через дефис)',
  );

/**
 * i18n — набор языков магазина (ADR-i18n, docs/24 §1; сид миграции 0036).
 *
 * `defaultLocale` — язык БАЗОВЫХ колонок таблиц (канон контента), остальные языки
 * живут в jsonb-оверлее `translations`. Инварианты значения:
 *   - locales непуст (магазин без языков невозможен);
 *   - без дублей (после нормализации регистра);
 *   - defaultLocale ∈ locales — иначе резолв «запрошенный → default» указывал бы
 *     на язык, которого в магазине нет.
 * Смену defaultLocale схема НЕ запрещает (значение само по себе валидно) — это
 * решает действие обновления: без миграции данных смена канона переобъявила бы
 * весь существующий контент другим языком.
 */
export const i18nSchema = z
  .object({
    defaultLocale: localeTagField,
    locales: z.array(localeTagField).min(1, 'Нужен хотя бы один язык'),
  })
  .strip()
  .superRefine((value, ctx) => {
    const seen = new Set<string>();
    value.locales.forEach((locale, index) => {
      if (seen.has(locale)) {
        ctx.addIssue({
          code: 'custom',
          message: `Язык «${locale}» указан дважды`,
          path: ['locales', index],
        });
      }
      seen.add(locale);
    });

    if (!seen.has(value.defaultLocale)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Язык по умолчанию должен входить в список включённых языков',
        path: ['defaultLocale'],
      });
    }
  });

/**
 * gift — политика подарочных сертификатов (ТЗ владельца п.11: при покупке
 * сертификата код выпускается автоматически и показывается покупателю).
 *
 * 🔴 ЭТОТ МОДУЛЬ — ЕДИНСТВЕННЫЙ ИСТОЧНИК ПРАВДЫ по ключу `gift`: схема, тип и
 * дефолты. Домен сертификатов (lib/gift-certificates/*) СВОЕЙ копии дефолтов не
 * держит: пока копий было две, форма в админке после «Сбросить настройки»
 * показывала автовыпуск включённым, а выпуск денег на предъявителя был выключен.
 *
 *  - autoIssue: выпускать ли код автоматически при оплате заказа;
 *  - validDays: срок действия кода в днях; 0/отсутствует/null → бессрочный;
 *  - categorySlugs: адреса разделов каталога, товары которых при ОФОРМЛЕНИИ
 *    заказа помечаются в снимке позиции как сертификаты (lib/orders/repository →
 *    applyGiftCategoryMarker); выпуск потом решает по этой пометке, а не по
 *    категории. МУЛЬТИТЕНАНТНОСТЬ: у другого магазина раздел называется иначе —
 *    набор задаётся настройкой, а не хардкодом в коде выпуска. ⚠️ Пустой список
 *    НЕ значит «автовыпуск выключен»: товар, у которого признак сертификата
 *    задан своим атрибутом, будет помечен и без категорий (рубильник — autoIssue);
 *  - allowIssueOnGiftPaidOrder: выпускать ли код по заказу, который сам полностью
 *    оплачен другим сертификатом (обмен номинала). Выключение закрывает сценарий
 *    «кручу номинал по кругу», если магазин этого не хочет.
 *
 * ВСЕ поля опциональны: отсутствие строки/поля = «нет оверрайда», действуют
 * GIFT_SETTINGS_DEFAULTS. `.strip()` — анти-tamper JSONB.
 */
export const giftSettingsSchema = z
  .object({
    autoIssue: z.boolean().optional(),
    // null допускается ОСОЗНАННО: «бессрочно» в jsonb пишут и нулём, и null-ом.
    // Строгий `number | undefined` уронил бы разбор ВСЕГО ключа, и раздел молча
    // вернулся бы к дефолтам — тот же класс дефекта, что уже кусал ключ exchange.
    validDays: z.number().int().min(0).nullable().optional(),
    categorySlugs: z.array(nonEmpty).max(64).optional(),
    allowIssueOnGiftPaidOrder: z.boolean().optional(),
  })
  .strip();

/** Значение gift со ВСЕМИ полями — результат наложения оверрайда на дефолты. */
export type ResolvedGiftSettings = {
  autoIssue: boolean;
  validDays: number;
  categorySlugs: string[];
  allowIssueOnGiftPaidOrder: boolean;
};

/**
 * Дефолты платформы для gift. Автовыпуск включён (владелец ждёт код сразу после
 * оплаты — тем же значением ключ сеет миграция 0056), срок 0 = бессрочно, обмен
 * номинала разрешён. `certificates` — лишь ДЕФОЛТНЫЙ адрес раздела; конкретный
 * магазин меняет его в админке.
 */
export const GIFT_SETTINGS_DEFAULTS: Readonly<ResolvedGiftSettings> = Object.freeze({
  autoIssue: true,
  validDays: 0,
  categorySlugs: Object.freeze(['certificates']) as unknown as string[],
  allowIssueOnGiftPaidOrder: true,
});

/**
 * Эффективная политика сертификатов: дефолты ⊕ оверрайд из БД, merge по полям.
 * Одна функция и для формы админки, и для рантайма выпуска — так «что нарисовано»
 * и «как выдаются деньги» не могут разъехаться.
 *
 * Кривое значение не роняет выпуск — падаем на дефолты (как parseSettingValue).
 * Пустой список категорий — ЯВНЫЙ выбор владельца («ни один раздел»), а не
 * «поля нет»: подменять его дефолтом значило бы вернуть чужие разделы втихую.
 */
export function resolveGiftSettings(raw: unknown): ResolvedGiftSettings {
  const parsed = parseSettingValue('gift', raw) ?? {};
  return {
    autoIssue: parsed.autoIssue ?? GIFT_SETTINGS_DEFAULTS.autoIssue,
    // null = явное «бессрочно» (0), а не «поля нет»: дефолт подставляем только
    // на отсутствие поля, иначе ненулевой дефолт срока перебил бы выбор владельца.
    validDays:
      parsed.validDays === undefined ? GIFT_SETTINGS_DEFAULTS.validDays : (parsed.validDays ?? 0),
    categorySlugs: [...(parsed.categorySlugs ?? GIFT_SETTINGS_DEFAULTS.categorySlugs)],
    allowIssueOnGiftPaidOrder:
      parsed.allowIssueOnGiftPaidOrder ?? GIFT_SETTINGS_DEFAULTS.allowIssueOnGiftPaidOrder,
  };
}

// -----------------------------------------------------------------------------
// Реестр ключ → схема. Единственный источник правды о наборе ключей настроек.
// -----------------------------------------------------------------------------

/** Стабильные ключи логических разделов настроек (PK shop_settings.setting_key). */
export const SETTING_KEYS = [
  'branding',
  'currency',
  'exchange',
  'units',
  'contacts',
  'legal_entity',
  'catalog',
  'delivery',
  'orders',
  'module_overrides',
  'seo',
  'home',
  'navigation',
  'access',
  'i18n',
  'gift',
] as const;

export type SettingKey = (typeof SETTING_KEYS)[number];

/** Карта ключ → Zod-схема значения. */
export const SETTING_SCHEMAS = {
  branding: brandingSchema,
  currency: currencySchema,
  exchange: exchangeSchema,
  units: unitsSchema,
  contacts: contactsSchema,
  legal_entity: legalEntitySchema,
  catalog: catalogSettingsSchema,
  delivery: deliverySettingsSchema,
  orders: ordersSettingsSchema,
  module_overrides: moduleOverridesSchema,
  seo: seoSettingsSchema,
  home: homeSchema,
  navigation: navigationSchema,
  access: accessSchema,
  i18n: i18nSchema,
  gift: giftSettingsSchema,
} as const satisfies Record<SettingKey, z.ZodTypeAny>;

// Типы значений по ключам (выводятся из схем).
export type BrandingSettings = z.infer<typeof brandingSchema>;
export type CurrencySettings = z.infer<typeof currencySchema>;
export type DisplayCurrencySetting = z.infer<typeof displayCurrencySchema>;
export type ExchangeSettings = z.infer<typeof exchangeSchema>;
export type UnitsSettings = z.infer<typeof unitsSchema>;
export type ContactsSettings = z.infer<typeof contactsSchema>;
export type LegalEntitySettings = z.infer<typeof legalEntitySchema>;
export type CatalogSettings = z.infer<typeof catalogSettingsSchema>;
export type DeliverySettings = z.infer<typeof deliverySettingsSchema>;
export type DeliveryZoneSetting = z.infer<typeof deliveryZoneSchema>;
export type OrdersSettings = z.infer<typeof ordersSettingsSchema>;
export type ModuleOverrides = z.infer<typeof moduleOverridesSchema>;
export type SeoSettings = z.infer<typeof seoSettingsSchema>;
export type HomeSettings = z.infer<typeof homeSchema>;
export type NavigationSettings = z.infer<typeof navigationSchema>;
export type AccessSettings = z.infer<typeof accessSchema>;
/**
 * Политика подарочных сертификатов (значение ключа gift, оверрайд; все поля
 * опциональны). ЕДИНСТВЕННОЕ определение типа: домен сертификатов
 * (lib/gift-certificates/types) реэкспортирует его отсюда, своего не заводит.
 */
export type GiftSettings = z.infer<typeof giftSettingsSchema>;
/** Набор языков магазина (значение ключа i18n). */
export type I18nSettings = z.infer<typeof i18nSchema>;

/**
 * Безопасный парс значения по ключу. Возвращает провалидированный частичный
 * объект либо `null`, если value не проходит схему ключа (раздел игнорируется,
 * остаётся env-дефолт — merge не должен падать на одной кривой строке БД).
 */
export function parseSettingValue<K extends SettingKey>(
  key: K,
  value: unknown,
): z.infer<(typeof SETTING_SCHEMAS)[K]> | null {
  const schema = SETTING_SCHEMAS[key];
  const parsed = schema.safeParse(value ?? {});
  return parsed.success ? (parsed.data as z.infer<(typeof SETTING_SCHEMAS)[K]>) : null;
}

/** Проверка, что строка — известный ключ настроек. */
export function isSettingKey(key: string): key is SettingKey {
  return (SETTING_KEYS as readonly string[]).includes(key);
}
