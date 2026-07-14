# 21 — Контракт публичного Storefront API (`/api/storefront/v1/*`)

> **Назначение.** Полный справочник публичного API, который потребляет витрина.
> Используется при **сращивании** макета магазина с Admik (см. `docs/20`, фаза 4).
> Источник истины по реализации — `app/api/storefront/v1/**` и `lib/storefront/**`.
> Связанные: `docs/13` (метод сращивания, worked-example), `docs/08` (СДЭК),
> `docs/15` (Т-Банк), `docs/11` (настройки/CMS).

---

## 0. Общие правила (применимы ко всем эндпоинтам)

**База:** `/api/storefront/v1`. Серверные (SSR) запросы витрины ходят внутрь
docker-сети на `http://app:3000/api/storefront/v1/*`; браузерные — на
`https://${ADMIN_DOMAIN}/api/storefront/v1/*` (значение в `NEXT_PUBLIC_ADMIK_API_URL`).

**Конвейер каждого запроса** (`lib/storefront/response.ts → runStorefront`):
1. **Модульный гейт** — если модуль эндпоинта выключен (`isModuleEffectivelyEnabled`)
   → `404`/`503`. `core`-эндпоинты (settings, leads, newsletter, pageview) доступны всегда.
2. **Авторизация** (`authorizeStorefront`) — см. ниже; иначе `401`.
3. **Rate-limit** — щедрый лимит витрины (по умолчанию ~600 запросов/60с), по ключу
   или нормализованному IP.
4. **CORS** — заголовки `Access-Control-Allow-Origin` (нормализованный Origin), `Vary: Origin`.
5. **Preflight** — `OPTIONS` → `204` с `Access-Control-Max-Age`.

**Авторизация витрины (OR-логика, `lib/storefront/auth.ts`):**
- **API-ключ**: заголовок `X-Storefront-Key` (или `X-Api-Key`); сверяется
  timing-safe со списком `STOREFRONT_API_KEYS` (формат `ключ` или `домен:ключ`,
  CSV). **ИЛИ**
- **Origin**: заголовок `Origin` ∈ `STOREFRONT_ALLOWED_ORIGINS` (CSV,
  нормализуется к `https://host[:port]`).
- **Mock-режим**: если ОБА списка пусты — доступ открыт всем + один `console.warn`
  (удобно для локального demo/CI; на бою задай ключ/Origin).

**Формат ответов:** успех — `{ "data": <...>, "pagination"?: {...}, "count"?: n }`;
ошибка — `{ "error": "<code>", "message"?: "<...>", "fieldErrors"?: {...} }`.

**Деньги — в копейках** (целые); конвертацию в рубли делает витрина по
`settings.currency`. Изображения отдаются как **публичные URL** (ключи S3 уже
развёрнуты через `storage.url()`).

**Anti-tamper (критично):** цены, остатки, вес/габариты, итоги, стоимость доставки
и суммы оплаты **считаются сервером по каталогу** — значения из тела запроса для
этих величин игнорируются. Витрина передаёт только выбор покупателя (id/qty/промокод/
адрес/способ).

---

## 1. Каталог (модуль `catalog`)

### `GET /products` — список товаров
Query: `q`, `brandId`(uuid), `category`(slug), `categoryId`(uuid, приоритет),
`featured`, `new`, `sale` (1/true/0/false), `limit`(1–100, деф. 24), `offset`(≥0),
`page` (совместимость).
```json
{ "data": [ {
  "slug":"...", "name":"...", "price":"29900", "compareAtPrice":"39900",
  "discountPct":25, "onSale":true, "isNew":false, "isFeatured":true,
  "brand": { "slug":"acme","name":"ACME","logoUrl":"https://..." },
  "imageUrl":"https://...", "inStock":true, "availableQty":42
} ], "pagination": { "total":234, "limit":24, "offset":0, "count":24 } }
```
Отдаются только `status='active'`. `availableQty = quantity − reserved`.

### `GET /products/:slug` — карточка товара
`data`: `id, slug, sku, name, description, price, compareAtPrice, discountPct,
onSale, isNew, isFeatured, brand, categories:[slug], attributes:{...},
variants:[{ id, sku, name, price, compareAtPrice, discountPct, onSale,
attributes:{...}, inStock, availableQty }], media:[{ url, type, alt, isPrimary }],
inStock, availableQty, meta:{ title, description, canonical, ogTitle,
ogDescription, ogImageUrl, noindex }`. `404` если slug не найден/не active.

### `GET /categories` — дерево категорий
`data`: рекурсивный массив `{ slug, name, description, children:[...] }`. Только активные.

### `GET /brands` — список брендов
`data`: `{ slug, name, logoUrl, description, seoTitle, seoDescription, meta:{...} }`,
`count`. Только `is_active=true`.

---

## 2. Корзина и заказы (модуль `orders`)

### `POST /cart/quote` — расчёт корзины (цены/скидки/доставка)
Тело:
```json
{ "items": [ { "productId":"...", "qty":2 }, { "variantId":"...", "qty":1 } ],
  "promoCode":"SAVE10",
  "delivery": { "type":"pvz", "city":"Москва", "pvzCode":"125412" } }
```
`data`: `itemsTotal, discountTotal, deliveryTotal, grandTotal, currency,
lines:[{ productId, variantId, qty, price, lineTotal, discount }],
promo:{ code, valid, discountTotal }, delivery:{ type, cost, etaDays },
fulfillable, issues:[]`. Цены/остатки/габариты — из каталога (anti-tamper).
`400` — невалидный ввод; `422` — невалидный промокод/позиция.

### `POST /orders` — создание заказа
Заголовок `Idempotency-Key` (рекоменд.) ИЛИ поле `idempotencyKey`. Тело:
```json
{ "items":[{ "productId":"...","variantId":"...","qty":2 }],
  "customer": { "name":"...", "email":"...", "phone":"+7..." },
  "delivery": { "type":"door", "city":"Москва", "address":"ул. Ленина, 10" },
  "paymentMethod":"tbank", "promoCode":"SAVE10", "comment":"..." }
```
`data`: `{ number, status, paymentStatus, grandTotal, currency, accessToken }`.
`201` новый / `200` повтор по idempotency. `409` нет остатка; `422` валидация.
Сервер: ревалидация цен/остатков из каталога → атомарный резерв → номер
(`ПРЕФИКС-ГОД-NNNNNN`) → снимок позиций → учёт промокода. **Сохрани `accessToken`**
на витрине — он нужен для трекинга и инициации оплаты.

### `GET /orders/:number` — статус/трекинг заказа
Query: `token` (accessToken, приоритет) ИЛИ `email`. `data`: `number, status,
paymentStatus, deliveryStatus, grandTotal, currency, items:[{ sku, name, qty,
price, lineTotal }], delivery:{ type, address, trackingUrl }`. Anti-enumeration:
неверный token/email → `404`.

### `GET /promotions` — публичные активные акции
`data`: `{ publicLabel, kind, applyScope, bogoBuyQty, bogoPayQty,
targetCategorySlugs, targetBrandSlugs, activeFrom, activeTo }`, `count`.
Скрыты: сам `code`, лимиты, счётчики, комментарий, id.

---

## 3. Доставка СДЭК (модуль `cdek`)

### `GET /delivery/cdek/cities?q=<≥2>&limit=<1..50>` — автокомплит города
`data`: `[{ code, name, region }]`. В mock — фикстуры без запроса к СДЭК.

### `GET /delivery/cdek/pvz?city_code=<int>|postal_code=<str>` — ПВЗ/постаматы
Опц.: `type` (PVZ|POSTAMAT), `country_code`. `data`: `[{ code, name, address,
type, location:{ latitude, longitude }, workTime }]`. `400` если нет city_code/postal_code.

### `POST /delivery/cdek/calculate` — расчёт доставки
Тело: `{ to:{ city_code, postal_code }, deliveryMode:"door"|"pvz",
items:[{ variantId|productId, qty }], tariffCode? }`. `data`: `{ tariffCode, cost,
etaDays, periodMin, periodMax }`. Anti-tamper: `from_location` всегда серверный
(`CDEK_FROM_LOCATION_CODE`), вес/габариты — из каталога, `tariffCode` — по whitelist.

> Эндпоинтов «создание отправления / печать накладной / трекинг по webhook» в
> ПУБЛИЧНОМ API нет — это операции админки/СДЭК-webhook (`app/api/cdek/webhook`,
> cron `app/api/cron/cdek/*`). Витрина видит статус доставки через `GET /orders/:number`.

---

## 4. Оплата Т-Банк (модуль `payments`)

### `POST /payments/tbank/init` — инициация оплаты
Тело: `{ orderNumber, accessToken|email, returnUrl? }`. `data`: `{ paymentUrl,
paymentId, status, isMock }`. Сумма берётся сервером из `orders.grand_total`
(не из тела). Доступ — по accessToken/email (иначе `404`). `409` — уже
оплачен/возвращён; `422` — ошибка инициации. В mock — demo-`paymentUrl`
(страница `app/mock/tbank/pay`), весь путь оплаты проходится без боевых ключей.

> Статус оплаты приходит в Admik через webhook `app/api/payments/tbank/webhook`
> (идемпотентно по `payment_id+status`); витрина отражает его через `GET /orders/:number`.

---

## 5. CMS-страницы (модуль `cms`)

### `GET /pages` — список опубликованных страниц
`data`: `[{ slug, title, description, meta:{ title, description, ogImageUrl,
canonical, noindex } }]`, `count`. Только `status='published'`.

### `GET /pages/:slug` — страница с секциями
`data`: `{ slug, title, sections:[{ type, ... }], meta:{...} }`. Секции отсортированы по
`display_order`. Типы секций (дискриминатор `type`, **источник истины — `lib/cms/types.ts`
`CMS_SECTION_TYPES`**): `hero`, `text`, `banner`, `products_grid`, `faq`, `cta`, `gallery`
(7 типов). `404` если не найдена/не published. Примечание: `rich-text` — это НЕ тип секции,
а формат HTML-поля ВНУТРИ секции (санитизированный HTML); не путать с `type`.

> **Паритет рендера (обязательно при сращивании).** Витрина ДОЛЖНА уметь отрисовать
> каждый из этих типов — необработанный тип секции даёт «пропажу» введённого в админке
> контента без ошибки (тихий дефект). Ветку `switch(section.type)` строй по всему списку
> `CMS_SECTION_TYPES` (не хардкодь подмножество), а в `default` логируй неизвестный тип и
> рендери безопасный фолбэк. При добавлении нового типа в схему обнови и этот список, и
> рендер витрины синхронно.

---

## 6. Ядро (`core` — доступно всегда, без модульного гейта)

### `GET /settings` — публичные настройки/брендинг магазина
`data`: `branding{ shopName, logoUrl, faviconUrl, theme{primaryColor, accentColor,
mode}, supportEmail, supportPhone }`, `currency{ code, symbol, locale,
fractionDigits }`, `units{ weight, dimension, system }`, `contacts{ phone, email,
address, workingHours, socials[] }`, `legalEntity{ name, inn, kpp, ogrn,
legalAddress }`, `delivery{ freeDeliveryThreshold }`, `seo{ siteName, siteUrl,
titleTemplate, defaultDescription, … }`, `home{ hero, about, quality, delivery }`,
`navigation{ header[], footer[] }`.
**Скрыто:** `bankDetails`, `og_image_key`, `robots_extra`, `noindex_site`,
`module_overrides`. Это главный источник брендинга/навигации/контента главной
для витрины.

### `POST /leads` — заявка с формы обратной связи
Тело: `{ name, contact, message }`. `data`: `{ id }`. Видна в админке `/admin/leads`.

### `POST /newsletter` — подписка на рассылку
Тело: `{ email }`. `data`: `{ ok:true }`. Идемпотентно (ON CONFLICT). Админка `/admin/subscribers`.

### `POST /events/pageview` — beacon посещения (опционально)
Тело игнорируется. `data`: `{ ok:true }` (всегда 200, best-effort). Инкрементит
суточный счётчик `storefront_pageviews` для графика «Посещения» на дашборде.

---

## 7. Шпаргалка маппинга «что на витрине → какой эндпоинт»

| Что нужно витрине | Эндпоинт |
|---|---|
| Список товаров / каталог с фильтрами | `GET /products` |
| Карточка товара (с вариантами/медиа/SEO) | `GET /products/:slug` |
| Навигация по категориям | `GET /categories` |
| Страница/меню брендов | `GET /brands` |
| Предпросчёт корзины (цены/скидки/доставка) | `POST /cart/quote` |
| Оформление заказа | `POST /orders` (+ сохранить `accessToken`) |
| Личный кабинет / трекинг | `GET /orders/:number?token=` |
| Автокомплит города (checkout) | `GET /delivery/cdek/cities?q=` |
| Выбор ПВЗ | `GET /delivery/cdek/pvz?city_code=` |
| Стоимость/сроки доставки | `POST /delivery/cdek/calculate` |
| Оплата | `POST /payments/tbank/init` → редирект на `paymentUrl` |
| Контентные страницы (О нас, доставка, оферта) | `GET /pages`, `GET /pages/:slug` |
| Логотип, название, цвета, контакты, меню, главная | `GET /settings` |
| Баннер промо-акций | `GET /promotions` |
| Форма обратной связи | `POST /leads` |
| Подписка на рассылку (футер) | `POST /newsletter` |
| Счётчик посещений (опц.) | `POST /events/pageview` |

> Анти-паттерн: НЕ передавай цены/итоги/вес с витрины в `quote`/`orders`/`calculate`
> — сервер их игнорирует и считает сам по каталогу. Витрина — тонкий рендер.
