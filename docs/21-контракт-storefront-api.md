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
ошибка — `{ "error": { "code": "<транспорт>", "message": "<диагностика>", "reason"?: "<домен>" } }`.

**Два кода в ошибке (важно для локализации витрины):**

| поле | что это | как использовать |
|---|---|---|
| `code` | ТРАНСПОРТНЫЙ код: `unauthorized`, `forbidden`, `not_found`, `rate_limited`, `bad_request`, `module_disabled`, `conflict`, `unprocessable` | ветвление по HTTP-семантике |
| `reason` | ДОМЕННАЯ причина из публичного алфавита (**необязательное** поле) | ключ для выбора строки в словаре витрины |
| `message` | текст на языке магазина | логи/поддержка; **покупателю не показывать** |

Публичный алфавит `reason` (`lib/storefront/error-reasons.ts`): `out_of_stock`,
`invalid_item`, `invalid_promo`, `invalid_gift`, `delivery_unavailable`,
`invalid_zone`, `payments_disabled`, `order_not_found`, `order_not_payable`,
`payment_init_failed`, `payment_in_progress`. Расширяется ТОЛЬКО аддитивно; витрина
обязана иметь фолбэк на неизвестное значение. Транспорт выбирается по причине:
`out_of_stock`, `order_not_payable` и `payment_in_progress` → `409 conflict`,
остальные доменные отказы → `422 unprocessable`.

Машинные причины ВНУТРИ успешного `POST /cart/quote` (200) — те же правила «ключ →
строка словаря»: `issues[].code` ∈ {`product_not_found`, `variant_not_found`,
`inactive`, `out_of_stock`}; `promo.reason` ∈ {`not_found`, `inactive`,
`not_started`, `expired`, `below_min_total`, `below_min_qty`, `usage_limit_reached`,
`per_customer_limit_reached`, `invalid_kind`}; `gift.reason` ∈ {`not_found`,
`expired`, `depleted`, `disabled`, `no_amount_due`}.

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
Тело ошибки несёт доменную причину `error.reason` (`out_of_stock`, `invalid_item`,
`invalid_promo`, `invalid_gift`, `delivery_unavailable`, `invalid_zone`,
`payments_disabled`) — именно по ней витрина выбирает переведённое сообщение.
Сервер: ревалидация цен/остатков из каталога → атомарный резерв → номер
(`ПРЕФИКС-ГОД-NNNNNN`) → снимок позиций → учёт промокода. **Сохрани `accessToken`**
на витрине — он нужен для трекинга и инициации оплаты.

### `GET /orders/:number` — статус/трекинг заказа
Query: `token` (accessToken, приоритет) ИЛИ `email`. `data`: `number, status,
paymentStatus, deliveryStatus, statusLabel, paymentStatusLabel,
deliveryStatusLabel, itemsTotal, discountTotal, giftDiscountTotal, deliveryTotal,
grandTotal, currency, promoCode, paymentMethod, paymentInitiatedAt,
items:[{ name, sku, attributes,
unitPrice, compareAtPrice, qty, lineTotal, isGift }], createdAt,
delivery:{ type, isPostamat, city, zoneId, zoneLabel, address, pvzCode, track }`.
Anti-enumeration: неверный token/email → `404`.

**`delivery.address` / `delivery.pvzCode` — добавлены АДДИТИВНО** (аудит
2026-07-26, находка №5: покупатель не мог узнать, где его посылка). Витрина
показывает «куда едет посылка». Клиенты старых версий поля просто игнорируют.

🔴 **Два уровня доступа.** `token` — СИЛЬНОЕ подтверждение (HMAC), `email` —
слабое: номера заказов последовательны, а email покупателя часто известен.
Поэтому ЧУВСТВИТЕЛЬНЫЕ поля `delivery.address` и `delivery.pvzCode` (физическое
место покупателя) отдаются ТОЛЬКО по `token`; по `email` они приходят как `null`,
а остальной трекинг (статусы, город, суммы, позиции, трек) — как прежде. Форма
ответа одинакова в обоих случаях: ключи на месте, скрытое = `null`. Тот же приём,
что у кодов подарочных сертификатов (`allowEmail:false`). Список чувствительных
полей — `SENSITIVE_DELIVERY_FIELDS` в `lib/storefront/order-dto.ts`.

🔴 **`paymentInitiatedAt` — добавлено АДДИТИВНО** (миграция 0058,
`orders.payment_initiated_at`): ISO-время ПОСЛЕДНЕЙ инициации платежа по заказу
(`null` — счёт не выставляли). Нужно против ДВОЙНОЙ ОПЛАТЫ: покупатель может
вернуться со шлюза раньше вебхука, и тогда `paymentStatus` ещё `pending`, хотя
деньги уже списаны. Витрина обязана НЕ предлагать оплату, пока с этого момента
прошло мало времени (эталон реализации — `storefront/lib/payment-result.ts`,
окно 15 минут), и вернуть кнопку по истечении окна, иначе получится тупик.
`paymentRef`/`paymentProvider` наружу по-прежнему НЕ отдаются — только эта
производная отметка времени. Клиенты старых версий поле игнорируют.

🔴 **`paymentStatus` — закрытый алфавит платформы**: `pending`, `authorized`,
`paid`, `failed`, `refunded` (CHECK в `0012_orders.sql` = `PAYMENT_STATUS_TRANSITIONS`
в `lib/orders/status.ts`). `authorized` — ХОЛД: деньги уже удержаны на карте,
предлагать оплату по такому заказу НЕЛЬЗЯ. Незнакомое значение клиент обязан
трактовать консервативно (не «оплачено» и не «можно платить»).

🔴 `*Label` приходят на языке магазина (сервер, `lib/orders/labels.ts`).
Многоязычная витрина обязана переводить статус ПО КОДУ (`deliveryStatus`,
`status`, `paymentStatus`) своим словарём, а серверную подпись использовать
только как фолбэк для незнакомого кода.

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
(не из тела). Доступ — по accessToken/email (иначе `404`). `409` — счёт выставлять
нельзя; `422` — ошибка инициации. В mock — demo-`paymentUrl`
(страница `app/mock/tbank/pay`), весь путь оплаты проходится без боевых ключей.

🔴 **ЗАЩИТА ОТ ДВОЙНОЙ ОПЛАТЫ (сервер, а не витрина).** Инициация отклоняется, если
по заказу уже есть деньги покупателя. Решение по ВСЕМУ алфавиту `payment_status`
(`paymentBlockFor`, `lib/orders/status.ts`) для живого заказа:

| `payment_status` | счёт выставляется | `error.reason` |
|---|---|---|
| `pending` | ✅ да (штатная оплата и ретрай) | — |
| `failed` | ✅ да (повторная попытка) | — |
| `authorized` | ❌ нет — ХОЛД, деньги удержаны на карте | `payment_in_progress` |
| `paid` | ❌ нет — уже оплачено | `order_not_payable` |
| `refunded` | ❌ нет — деньги возвращены | `order_not_payable` |

Отменённый/возвращённый ЗАКАЗ (`status` ∈ `cancelled`/`refunded`) не оплачивается
ни при каком `payment_status` → `order_not_payable`. Незавершённый холд не запирает
заказ: крон-сверка `reconcile-pending` (Т-Банк, Альфа-Банк) берёт заказы в
`pending` И `authorized` и доводит статус (снятая авторизация → `failed`, то есть
заказ снова оплачиваем), а оператор может сменить статус вручную
(`authorized → paid|failed`).

🔴 **`returnUrl` — НЕДОВЕРЕННОЕ значение: из него берётся ТОЛЬКО безопасный ПУТЬ**
(он несёт локаль витрины, `/en/cart/success`). Origin адреса возврата сервер берёт
исключительно из настроек владельца: «Настройки → SEO → Адрес сайта»
(`shop_settings.seo.site_url`), иначе первый домен `STOREFRONT_ALLOWED_ORIGINS`.
Заголовки прокси (`X-Forwarded-Host`) доверенными НЕ считаются. Если доверенного
origin нет — шлюзу адрес НЕ передаётся вовсе (покупатель вернётся на статический
адрес из ЛК эквайера) и в лог пишется предупреждение. Иначе подменённый origin
превратил бы возврат со шлюза в open redirect с утечкой `number`/`token` заказа.
`number`/`token` подставляет сервер, значения из тела игнорируются; `token` кладётся
только если доступ подтверждён самим токеном (по `email` — нет). См.
`lib/payments/return-url.ts`. То же верно для `paykeeper`/`alfabank`.

> Статус оплаты приходит в Admik через webhook `app/api/payments/tbank/webhook`
> (идемпотентно по `payment_id+status`); витрина отражает его через `GET /orders/:number`.

---

## 5. CMS-страницы (модуль `cms`)

### `GET /pages` — список опубликованных страниц
`data`: `[{ slug, title, description, meta:{ title, description, ogImageUrl,
canonical, noindex } }]`, `count`. Только `status='published'`.

### `GET /pages/:slug` — страница с секциями
`data`: `{ slug, title, sections:[{ type, ... }], meta:{...} }`. Типы секций:
`hero`, `banner`, `gallery`, `text`, `rich-text`. `404` если не найдена/не published.

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
