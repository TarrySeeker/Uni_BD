# 13 — Сращивание витрины THE CASE с Admik (Storefront API)

> **Автор:** Solution Architect. **Статус:** проектный документ + ТЗ на реализацию (волны A–D
> реализованы; витрина поглощена в монорепо, см. §10–§11).
> **Дата:** 2026-06-16, обновление 2026-06-22.
> **Связанные документы:** `CLAUDE.md`, `docs/06-референсные-магазины.md` (§1 THE CASE),
> `docs/01` (ADR-008 headless + Storefront API, ADR-009 цены/флаги/бренды, ADR-010 anti-tamper),
> `docs/07` (заказы), `docs/08` (СДЭК), `docs/10` (гайд продолжения), `docs/00` (журнал).
>
> **Назначение.** Зафиксировать контракт и план «сращивания» реально загруженной витрины
> **THE CASE** (`/root/admik/THE CASE`, Next.js 15 + Prisma) с бэкендом Admik. Витрина
> переводится в режим **чистого потребителя** публичного Storefront API
> `/api/storefront/v1/*`; её собственный коммерческий бэкенд (статический каталог,
> заказы, СДЭК, админка, NextAuth-для-заказов) **выводится из обращения**.

---

## 0. Решения пользователя (2026-06-16)

| Развилка | Решение |
|---|---|
| **Объём** | **Полный переход** витрины на Admik: каталог + корзина(quote) + заказы + СДЭК — всё через Storefront API. wishlist/корзина остаются клиентскими (zustand). |
| **Данные каталога** | **Без демо-сида.** Каталог наполняет владелец из админки Admik (пара позиций). Задача — чтобы заведённое в админке корректно доезжало до витрины. |
| **Размеры (XS…XXL)** | **Размер = вариант** (`product_variants`): отдельный SKU/остаток/цена на размер. «Максимальная подробность и удобство» — совместимо с резервом/инвентарём/заказами Admik (как и предполагал `docs/06 §1.2`). |

---

## 1. Целевая архитектура

```
            ОДИН VPS (Ubuntu 24.04), один личный домен, схема поддоменов
┌──────────────────────────────┐   HTTP внутри docker-сети (app:3000)   ┌──────────────────────────┐
│  THE CASE (контейнер          │  ──────────────────────────────────▶  │  Admik (контейнер app)    │
│  storefront, Next.js 15)      │      /api/storefront/v1/*              │  каталог/заказы/СДЭК/CMS  │
│  ${SHOP_DOMAIN} (+www)        │  ◀──────────────────────────────────  │  + админка владельца      │
│  zustand: cart, wishlist      │   JSON (NUMERIC-строки ₽, inStock)     │  ${ADMIN_DOMAIN}=admin.*  │
└──────────────────────────────┘                                        └──────────────────────────┘
                  ▲                                                                   ▲
                  └─────────────────  Caddy (auto-TLS, :80/:443)  ────────────────────┘
                       публично: https://${SHOP_DOMAIN}  и  https://${ADMIN_DOMAIN}
```

> **Топология деплоя (2026-06-16).** Витрина больше НЕ на Netlify — она поднимается отдельным
> контейнером `storefront` в том же `docker compose`, что и Admik, на **одном VPS**.
> Браузер ходит на витрину по `${SHOP_DOMAIN}` и в API/админку/медиа по `${ADMIN_DOMAIN}`
> (`admin.<домен>`); серверные запросы витрины к API идут ВНУТРИ docker-сети на `http://app:3000`.
> Подробности развёртывания — `docs/09`. Маршрутизация: `Caddyfile`; сервис — `docker-compose.yml`.

- **Витрина не имеет своей БД/бизнес-логики.** Каталог/цены/скидки/наличие/расчёт корзины/
  доставка/создание заказа — всё на стороне Admik (ADR-008/010). Витрина только рендерит и
  собирает выбор покупателя.
- **wishlist и корзина — клиентские** (zustand, localStorage), как и сейчас. Это UX-состояние,
  не бизнес-данные. Цена/итог в корзине — лишь предпросмотр; **источник истины — `cart/quote`**.
- **Покупательские аккаунты** — на стороне витрины (NextAuth опционально), но заказ создаётся в
  Admik и читается по `accessToken` (анти-перебор номеров). На этапе сращивания ЛК упрощаем до
  трекинга по номеру+токену; полноценный аккаунт-модуль — будущее (docs/06 §1.2).

---

## 2. Маппинг эндпоинтов (что было → что станет)

| Витрина (было) | Admik Storefront API (станет) | Метод |
|---|---|---|
| `lib/products.ts` (статический каталог) | `GET /api/storefront/v1/products` (+фильтры) | список |
| — (нет) | `GET /api/storefront/v1/products/{slug}` | карточка |
| — (хардкод `CATEGORY_*`) | `GET /api/storefront/v1/categories` (дерево) | категории/навигация |
| `GET /api/cdek?action=cities` | `GET …/delivery/cdek/cities?q=` (**добавлено**, Wave C) | поиск города |
| `GET /api/cdek?action=pickup` | `GET …/delivery/cdek/pvz?city_code=` | ПВЗ |
| `GET /api/cdek?action=calculate` | `POST …/delivery/cdek/calculate` | расчёт доставки |
| `POST /api/orders` (+свой СДЭК+email) | `POST …/cart/quote` затем `POST …/orders` | расчёт + создание |
| `GET /api/orders` (по сессии) | `GET …/orders/{number}?token=` | трекинг/ЛК |
| — (нет) | `POST …/events/pageview` (**добавлено**, опц.) | beacon посещений |
| `GET /api/admin` / `/admin` | админка Admik (`/admin`) | — (выводится) |
| `GET /api/invoices/{id}` | накладная — в админке/трекинге Admik | — (выводится) |

> **Beacon посещений (опционально, для графика «Посещения» на дашборде Admik).** Витрина может
> при открытии страницы делать лёгкий `POST /api/storefront/v1/events/pageview` (без тела; авторизация
> — как у прочих storefront-запросов: API-ключ или разрешённый Origin). Admik инкрементит суточный
> счётчик `storefront_pageviews` (миграция `0028`) — внешняя аналитика не нужна (самохостинг). Если
> витрина beacon не шлёт, график посещений просто остаётся пустым; на каталог/заказы это не влияет.
> Рекомендуется слать не чаще одного раза на загрузку страницы (можно дебаунсить на сессию).

**Гэп:** в Storefront API Admik **нет** поиска городов СДЭК (есть только `pvz` и `calculate`,
которым нужен `city_code`). Витрина THE CASE использует автокомплит города. → В Wave C добавить в
Admik `GET /api/storefront/v1/delivery/cdek/cities?q=` (прокси к СДЭК `location/cities`, ключи не
утекают на фронт; mock-фикстуры при пустых `CDEK_*`). Альтернатива (хуже по UX) — ввод индекса
(`postal_code`), который оба наличных эндпоинта уже принимают.

---

## 3. Контракт данных: Admik DTO → модель THE CASE

Витрина оперирует типом `Product` (`src/types/index.ts`). Admik отдаёт `ProductListItemDto` /
`ProductDetailDto` (`lib/storefront/dto.ts`). Маппер-адаптер (`src/lib/admik/adapter.ts`)
переводит одно в другое.

### 3.1. Прямые поля

| Поле THE CASE | Источник Admik | Преобразование |
|---|---|---|
| `slug` | `dto.slug` | как есть (ключ товара; старые числовые `id` упраздняются) |
| `name` | `dto.name` | как есть |
| `price` (number ₽) | `dto.price` (NUMERIC-строка) | `Number(dto.price)` (формат — `formatPrice`, kopeks скрыты) |
| `oldPrice` | `dto.compareAtPrice` | `Number(...)` либо `undefined` |
| `isNew` | `dto.isNew` | как есть |
| `isBestseller` | `dto.isFeatured` | «рекомендуемый» = бестселлер витрины |
| `images` | `dto.media[].url` (detail) / `dto.imageUrl` (list) | абсолютные URL медиа Admik |
| `inStock` | `dto.inStock` | новое поле (на витрине — кнопка «нет в наличии») |

### 3.2. Поля-через-атрибуты (EAV, ADR-007/009)

Полей `gender/composition/care/features/color` в каноне Admik нет — они задаются владельцем в
**атрибутах товара**. Контракт ключей (адаптер читает с фолбэками, регистр/латиница-кириллица —
нормализуются):

| Поле THE CASE | Ключ атрибута Admik (канон) | Фолбэк-ключи | Дефолт |
|---|---|---|---|
| `gender` | `gender` (`women`/`men`/`unisex`) | `пол` | вывод из категории, иначе `unisex` |
| `composition` | `composition` | `состав` | `""` |
| `care` | `care` | `уход` | `""` |
| `color` | `color` | `цвет` | `""` |
| `features` | `features` (array \| строка через `;`/`,`) | `особенности` | `[]` |
| `size` (вариант) | `variant.attributes.size` | `размер` | имя варианта |

> Контракт описывается владельцу в инструкции (Wave D): какие атрибуты заводить у товара/варианта,
> чтобы карточка THE CASE рендерилась полно. Отсутствие атрибута — не ошибка: поле получает дефолт.

### 3.3. Размеры = варианты

- На карточке размеры строятся из `dto.variants` (только `isActive`, наличие из `variant.inStock`).
- Каждый размер несёт **`variant.id` (uuid)** — он кладётся в позицию корзины и уходит в
  `cart/quote` и `orders` как `variantId` (anti-tamper; цену/итог считает сервер).
- **Метка размера для UI** — цепочка фолбэков: `variant.attributes.size` → **имя варианта**
  (`variant.name`) → `variant.sku`. Сортировка — по канону `XS<S<M<L<XL<XXL`, неизвестные — в конец
  по алфавиту.
- ⚠️ **На практике метку даёт имя варианта.** В текущем Admik вариантный `attributes_cache`
  НЕ пересобирается (ребилд только товарного уровня, `lib/catalog/cache.ts`), а админка правит
  атрибуты лишь на уровне товара — поэтому `variant.attributes.size` обычно пуст. Поэтому
  `VariantDto` обогащён публичным полем `name`, а адаптер берёт метку из него. Владелец задаёт
  размер в поле **«Название»** варианта (напр. `M`). Будущее улучшение — пересбор вариантного
  кеша + редактор вариантных атрибутов в админке (тогда заработает `attributes.size`).

### 3.4. Категории — data-driven

Хардкод `Category`/`CATEGORY_LABELS`/`CATEGORY_SLUGS` в `types/index.ts` заменяется деревом из
`GET /categories` (slug+name+children). Навигация/фильтры строятся из ответа API. Это требование
универсальности (`CLAUDE.md`): витрина не должна знать категории конкретного магазина в коде.
На переходный период адаптер сохраняет совместимый shape, но источник — API.

### 3.5. Фасеты каталога (решение по объёму Wave B)

`ProductListItemDto` (списочный) НЕ несёт атрибутов/категорий/вариантов (только цена/бейджи/
наличие/изображение/бренд) — поэтому богатый client-side фасетинг по полю товара из списка
невозможен без обогащения контракта. Решение — **серверный фасетинг по query-параметрам** (масштабируется
и на Gang Auto с 2000+ SKU, где client-side фильтрация полной выборки недопустима):

- **Категория:** добавлен параметр `GET /products?category=<slug>` (Admik, резолвит slug→id через
  `getActiveCategoryIdBySlug`; нет такой → nil-uuid → пустой список). Вкладки категорий каталога
  работают через URL-параметр.
- **Поиск/новинки/распродажа/рекомендуемые/бренд:** уже поддержаны параметрами `q/new/sale/featured/brandId`.
- **Сортировка и порог цены:** client-side над загруженной выборкой страницы.
- **Пол/цвет/размер в сайдбаре грида:** на Wave B **не переносятся** (их нет в списочном DTO).
  Полный выбор размеров (= варианты) и атрибуты (пол/цвет/состав) доступны на **карточке товара**
  (PDP) из `ProductDetailDto`. Пол по факту покрыт категориями «Женское/Мужское». Возврат
  атрибутного фасетинга в грид — будущая опция (обогащение списочного DTO или отдельный facets-эндпоинт).

---

## 4. Реформа корзины (cart-item)

Сейчас: `CartItem = { product: Product; size: ProductSize; quantity }`. Размер — строка.

Станет: позиция корзины несёт **`variantId`** (uuid выбранного размера) + денормализованный снимок
для UI (`name`, `slug`, `price`, `size`, `imageUrl`). Это нужно, потому что `orders`/`cart/quote`
принимают `variantId` (uuid), а не строку размера. Клиентский итог — предпросмотр; перед
оформлением вызывается `cart/quote`, и грандтотал берётся из ответа сервера.

```ts
interface CartItem {
  variantId: string;        // uuid варианта (размера) — ключ для quote/order
  slug: string; name: string; size: string; price: number; imageUrl: string | null;
  quantity: number;
}
```

---

## 5. Контракт создания заказа / расчёта (Admik)

- **`POST /cart/quote`** — body `{ items:[{variantId,qty}], promoCode?, delivery?:{type,city,pvzCode?} }`.
  Ответ — суммы NUMERIC-строками (`itemsTotal/discountTotal/deliveryTotal/grandTotal`), `lines[]`,
  `fulfillable`, `issues[]`. Ничего не создаёт.
- **`POST /orders`** — body `{ items:[{variantId,qty}], customer:{name,email,phone},
  delivery:{type,city?,address?,pvzCode?}, paymentMethod, promoCode?, comment? }` +
  заголовок `Idempotency-Key`. Ответ `{ number, status, paymentStatus, grandTotal, currency, accessToken }`.
- **Перекодировки витрина → Admik:**
  - доставка ПВЗ → `delivery.type='pvz'` + `pvzCode`; курьер → `'courier'`; самовывоз → `'pickup'`.
  - оплата `cdek-pay`→`cdek_pay`, `card`→`card`, `sbp`→`sbp` (enum `PAYMENT_METHODS`).
- **`GET /orders/{number}?token=<accessToken>`** — трекинг/ЛК. Токен возвращается при создании,
  в БД не хранится. Альтернативно — `?email=` покупателя.

---

## 6. Конфигурация витрины (env)

Переменные витрины THE CASE. В деплое на одном VPS их задаёт **сервис `storefront` в
`docker-compose.yml`** (а не отдельный `.env` витрины): серверный адрес API указывает внутрь
docker-сети, публичный — на поддомен Admik.

```dotenv
# Сервер-сайд (server components / route handlers) — ВНУТРИ docker-сети:
ADMIK_API_URL="http://app:3000"
# Клиент (checkout, автокомплит городов) — ПУБЛИЧНЫЙ адрес API (build-arg витрины):
NEXT_PUBLIC_ADMIK_API_URL="https://${ADMIN_DOMAIN}"   # напр. https://admin.myshop.ru
# Публичный адрес самой витрины (SEO/sitemap/абсолютные ссылки):
NEXT_PUBLIC_SITE_URL="https://${SHOP_DOMAIN}"
# Ключ витрины (если Admik настроен на ключи; иначе достаточно Origin-allowlist):
STOREFRONT_API_KEY="<выдаётся в Admik: STOREFRONT_API_KEYS>"
```

На стороне Admik (`.env`) домен витрины добавляется в `STOREFRONT_ALLOWED_ORIGINS`
(`https://${SHOP_DOMAIN},https://www.${SHOP_DOMAIN}`) и/или ключ в `STOREFRONT_API_KEYS`
(`lib/storefront/env.ts`). В dev/mock — без ключей доступ открыт (demo). Полная карта переменных
деплоя (`ADMIN_DOMAIN`, `S3_PUBLIC_URL` для медиа через Caddy, `STOREFRONT_IMAGE`) — в
`.env.example` и `docs/09`.

Удаляются из витрины: `DATABASE_URL`, `DIRECT_DATABASE_URL`, `AUTH_*` (если ЛК упрощаем),
`CDEK_*`, `CDEK_PAY_*`, `SMTP_*` — всё это переезжает в Admik.

---

## 7. Выводится из обращения (Wave D)

- `src/lib/products.ts` — статический каталог (оставить только `formatPrice` в util-модуле).
- `src/app/api/products`, `…/orders`, `…/cdek`, `…/admin`, `…/invoices` — маршруты.
- `src/lib/cdek/*` (свой СДЭК-клиент), `src/lib/email.ts`, `src/lib/db.ts` (Prisma) — если ЛК
  упрощается; `prisma/*` коммерческие модели.
- `src/app/admin/page.tsx` — админка (теперь у Admik).
- NextAuth — оставить только если нужен покупательский логин; иначе вывести.

Удаление — отдельной волной после того, как read-path и checkout переведены и зелёные.

---

## 8. Тестирование (сначала тесты, потом код — CLAUDE.md)

Витрина THE CASE сейчас **без тест-харнесса**. Добавляется **vitest**:

- **Wave A:** юнит-тесты на чистый адаптер `dto → Product` (варианты-размеры, атрибуты→поля,
  дефолты, деньги-строки→number, сортировка размеров) и на клиент (mocked `fetch`: заголовки,
  base URL, обработка ошибок/404). Без сети/БД.
- **Wave C:** перекодировки доставки/оплаты, сборка тела `orders`/`quote`.
- e2e (Playwright) — опционально на стенде против живого Admik (в dev нет сети/БД — норма).

---

## 9. План волн

| Волна | Содержание | Проверяемо в dev |
|---|---|---|
| **A** | `src/lib/admik/{client,types,adapter}.ts` + vitest-харнесс + юнит-тесты | ✅ (pure + mocked fetch) |
| **B** | Каталог read-path: home/catalog/product/search/wishlist/sitemap на Admik; категории data-driven; `next.config` remotePatterns | typecheck/lint; визуально — на стенде |
| **C** | Чекаут: `cart/quote`+`delivery/cdek/*`+`orders`; ЛК/трекинг; **+ cities-endpoint в Admik**; реформа cart-item | typecheck/lint + юнит; e2e на стенде |
| **D** | Вывод из обращения бэкенда витрины; чистка env; README/NETLIFY; синхронизация docs Admik (00/03/10) | typecheck/lint |

Коммиты — повайвно. Документация (`docs/00`, `docs/03`, `docs/10`, этот файл) синхронизируется.

---

## 10. Статус реализации (2026-06-16)

**Все волны A–D — ✅ done.** Витрина THE CASE переведена в режим чистого потребителя
Storefront API Admik; её собственный коммерческий бэкенд выведен из обращения.

### Гейт (зелёный)

- **THE CASE:** `tsc --noEmit` exit 0, `next lint` чисто, `vitest` **60 passed**.
- **Admik (затронутое):** storefront-тесты **92 passed**, cdek-тесты **223 passed**. Полный
  `tsc` Admik в dev **не гонится** (OOM, 1.9 GiB RAM) — норма, гейт на CI.

### По волнам

- **Wave A — слой интеграции витрины ✅.** `THE CASE/src/lib/admik/{types,adapter,client}.ts` —
  типизированный клиент Storefront API (base URL из `ADMIK_API_URL`/`NEXT_PUBLIC_ADMIK_API_URL`,
  ключ `X-Storefront-Key` из `STOREFRONT_API_KEY`) + чистый адаптер DTO→вью-модель (деньги-строки
  NUMERIC→`number`, атрибуты→поля с фолбэками лат/кир, размеры-варианты с сортировкой
  `XS<S<M<L<XL<XXL`). Добавлен vitest-харнесс + юнит-тесты (`adapter.test.ts`, `client.test.ts`).
- **Wave B — каталоговый read-path на Admik ✅.** Главная/каталог/карточка/поиск/избранное/sitemap
  переведены на Admik; корзина реформирована под `variantId`; категории data-driven из
  `/categories`; `next.config` `remotePatterns` под медиа Admik. Решение по фасетам —
  серверный фасетинг по query-параметрам (см. §3.5): сайдбар-фасеты пол/цвет/размер в гриде
  не переносились (доступны на карточке товара).
- **Wave C — чекаут на Storefront API ✅.** `POST /cart/quote` (серверный итог, anti-tamper) +
  `GET /delivery/cdek/{cities,pvz}` + `POST /delivery/cdek/calculate` + `POST /orders`
  (`Idempotency-Key`); ЛК/трекинг через `GET /orders/{number}?token=`.
- **Wave D — вывод из обращения бэкенда витрины ✅.** Удалены `THE CASE/src/app/api/{products,
  orders,cdek,admin,invoices,auth}`, `src/app/admin`, `src/lib/{products,db,auth,email}.ts`, весь
  `src/lib/cdek`, `prisma/`, `src/types/next-auth.d.ts`. `PAYMENT_METHODS` перенесён в
  `src/lib/payment.ts`. Из `package.json` убраны `next-auth`/`prisma`/`bcryptjs`/`nodemailer` +
  db-скрипты + `postinstall`. `.env.example` переведён на `ADMIK_API_URL`/`NEXT_PUBLIC_ADMIK_API_URL`/
  `STOREFRONT_API_KEY`; `NETLIFY.md` переписан под headless-потребителя.

### Новые артефакты на стороне Admik

- **Поиск городов СДЭК** (закрыт гэп из §2, Wave C): сервис `lib/cdek/services/city.ts`
  (`CityService`), тип `CdekCity` (`lib/cdek/types.ts`), mock-фикстуры `MOCK_CITIES` +
  `mockSearchCities` (`lib/cdek/mock/`), роут `app/api/storefront/v1/delivery/cdek/cities/route.ts`,
  тест `tests/cdek/services/city.test.ts`.
- **Параметр `GET /products?category=<slug>`** (Wave B, серверный фасетинг по категории):
  резолвер `getActiveCategoryIdBySlug` в `lib/storefront/queries.ts`; в роуте `products`
  `categoryId` (uuid) имеет приоритет, иначе slug резолвится в id (нет такой → пустой список).
- **Пагинация `GET /products` со свободным `offset`** (fix minor): `limit`/`offset` query —
  `offset` пробрасывается в `listProducts` КАК ЕСТЬ (clamp `>= 0`), без молчаливого округления
  до границы страницы. Ранее роут считал `page = floor(offset/limit)+1` и НЕ передавал offset,
  а `listProducts` брал `offset = (page-1)*pageSize` — свободный (не кратный `limit`) offset
  обнулялся до границы страницы → товары пропускались/дублировались между «страницами».
  В `ProductListFilter` добавлено опц. поле `offset` (приоритет над `page`; не задано → фолбэк
  на `page`, контракт админки не меняется). Ответ отражает фактический offset в
  `pagination.offset`. Тесты: `tests/storefront/products-route.test.ts` (проброс/clamp/фолбэк),
  `tests/catalog/integration.test.ts` (DB-gated: смежные окна со свободным offset без
  пропусков/дублей).

### Версионирование и хранение витрины (решено, 2026-06-22)

- **Витрина THE CASE поглощена в монорепо Admik подкаталогом `THE CASE/`** (решение пользователя).
  Ранее витрина версионировалась как **отдельный репозиторий** и была занесена в корневой
  `.gitignore` (вне git-истории Admik). Теперь её код — **часть монорепо Admik** и хранится в его
  git-истории.
- **Слияние с сохранением истории.** Витрина влита через `git merge -s ours` +
  `git read-tree --prefix='THE CASE/'` (merge-коммит **c343785**) — история коммитов витрины
  сохранена, файлы размещены под префиксом `THE CASE/`. Корневое игнор-правило `THE CASE/` снято
  (коммит **7fd71ea**). Артефакты сборки витрины (`node_modules/`, `.next/`, `.env`) игнорируются
  **вложенным** `THE CASE/.gitignore` — в репозиторий попадает только исходный код.
- **Следствия для деплоя.** Топология не меняется: витрина по-прежнему поднимается отдельным
  контейнером `storefront` в общем `docker compose` (см. §1, `docs/09`). Меняется лишь способ
  доставки исходников — они уже в репозитории Admik, отдельный clone витрины не нужен.

---

## 11. Маршруты и навигация витрины (структура UI, 2026-06-22)

Витрина — App Router Next.js 15 (`THE CASE/src/app/`). Ниже — актуальная карта публичных
маршрутов (страница = `page.tsx` соответствующего сегмента) после правок по брифу заказчика
(коммиты `ee35c09`, `7fd71ea`). Раздел описывает **техническую структуру**, а не журнал
изменений (журнал ведёт history-manager в `docs/00`).

### 11.1. Карта маршрутов (`THE CASE/src/app/`)

| Маршрут | Файл | Назначение |
|---|---|---|
| `/` | `page.tsx` | Главная: hero (кликабелен → `/catalog`, CTA центрирован), блок «Создано вместе с врачами» (без слайдера), «Коллекция» с табами **Для женщин / Для мужчин** (таб «Shop» убран), якорь `#about` («О бренде», полноширинный блок с уменьшенными фото), якорь `#delivery` («Доставка и оплата», без пункта «Service») |
| `/catalog` | `catalog/page.tsx` | Каталог (фасетинг по query, см. §3.5). Заголовок раздела — «Категории» (ранее `CATEGORIES`) |
| `/product/[slug]` | `product/[slug]/page.tsx` | Карточка товара (PDP) |
| `/search` | `search/page.tsx` | Поиск |
| `/cart` | `cart/page.tsx` | Корзина (клиентская, zustand) |
| `/checkout` | `checkout/page.tsx` | Оформление заказа (cart/quote + orders) |
| `/wishlist` | `wishlist/page.tsx` | Избранное (клиентское) |
| `/account` | `account/page.tsx` | **Личный кабинет** (трекинг по номеру+токену) |
| `/contacts` | `contacts/page.tsx` | **Новый маршрут**: страница «Контакты» — форма обратной связи + контакты (Telegram / телефон). Каналы — **TODO-заглушки** (реальные ссылки/номер заполняются позже) |
| `/care` | `care/page.tsx` | Уход за изделием |
| `/payment` | `payment/page.tsx` | Оплата |
| `/returns` | `returns/page.tsx` | Возврат/обмен |
| `/reviews` | `reviews/page.tsx` | Отзывы |
| `/terms` | `terms/page.tsx` | **Наполнен**: пользовательское соглашение (с учётом ЗоЗПП) |
| `/privacy` | `privacy/page.tsx` | **Наполнен**: политика обработки персональных данных (152-ФЗ) |

### 11.2. Навигация (`THE CASE/src/components/layout/Header.tsx`)

Шапка — три зоны (`grid-cols-[1fr_auto_1fr]`):

- **Левая навигация (`NAV_LEFT`):** «Каталог» (`/catalog`), «Коллекция» (`/catalog`, с
  выпадающим подменю из **реальных категорий** магазина через `flattenCategoryNav`; при пустом
  списке деградирует до простой ссылки), «О бренде» (`/#about`).
- **Правая навигация (`NAV_RIGHT`):** «Доставка» (`/#delivery`), **«Контакты» (`/contacts`)** —
  теперь это отдельная страница, а не якорь.
- **Иконки действий (правый блок):** поиск (`/search`), **иконка человека (`User`) → `/account`**
  с `aria-label="Аккаунт"`; в мобильном меню та же ссылка подписана **«Личный кабинет»**.
  Далее — избранное (`/wishlist`) и корзина (`/cart`) со счётчиками из `zustand`.

Подвал (`THE CASE/src/components/layout/Footer.tsx`) ссылается на `/contacts`, `/account`,
`/terms`, `/privacy` среди прочих маршрутов.
