# Этап 4 — Интеграция СДЭК (модуль `cdek`)

> Проектный документ Solution Architect. Порт логики СДЭК из референса `carre` (PHP/Yii2) на
> TypeScript/Next.js платформы Admik. Архитектурное обоснование — ADR-011 (`docs/01`), который
> опирается на ADR-002 (что берём из carre), ADR-008 (Storefront API), ADR-010 (заказы: серверный
> расчёт + снимки). Источники: `docs/14-cdek-api-spec.md` и `common/components/Cdek/*` в carre.
>
> **Принцип документа:** Этап 4 — *аддитивный*. Поля доставки на `orders` уже заложены в `0012`,
> статус-машина delivery — в `lib/orders/status.ts`, заглушка стоимости (`stubDeliveryCost → '0.00'`)
> — в `lib/orders/repository.ts`. Этап 4 заменяет заглушку реальным расчётом, добавляет хранение
> отправлений, webhook, cron и UI — *без рефакторинга ядра заказов*.

---

## 1. Цель, охват, Definition of Done

### 1.1 Цель

Реализовать модуль `cdek` — полную интеграцию с API СДЭК (компания — партнёр СДЭК), закрывающую
требования ТЗ (`CLAUDE.md`, раздел «Интеграция со СДЭК»):

| № | Требование ТЗ | Где реализуется |
|---|---|---|
| 1 | Расчёт стоимости доставки | `Calculator` + `/api/storefront/v1/delivery/cdek/calculate`, замена `stubDeliveryCost` |
| 2 | Получение ПВЗ | `PvzService` + `/api/storefront/v1/delivery/cdek/pvz` |
| 3 | Создание отправлений | `OrderService.createShipment` + cron `create-pending` + admin-action |
| 4 | Отслеживание отправлений | `TrackingService.syncOrder` (pull) + webhook (push) |
| 5 | Статусы доставки | `StatusMap` → `delivery_status` через статус-машину `lib/orders/status.ts` |
| 6 | Печать документов | `PrintService` (накладная `/print/orders`, ШК `/print/barcodes`) |
| 7 | Управление заказами СДЭК | admin-actions (`cdek.manage`): создать/отменить/трек/печать; список отправлений |
| 8 | Автоматизация логистики | cron-воркеры `create-pending`, `notify-stuck`, регистрация webhook |

### 1.2 Охват

- **Модуль** `cdek` (флаг уже есть в `lib/config/modules.ts`). При выключенном флаге: storefront-роуты
  СДЭК → 404, admin-блок СДЭК скрыт, cron-воркеры — no-op, заглушка стоимости остаётся `'0.00'`.
- **Слои** (`lib/cdek/*`): `CdekClient` (HTTP+OAuth), `Services` (Calculator/Pvz/Order/Tracking/
  Webhook/Print/StatusMap/DeliveryQuoteGuard), `CdekManager` (фасад).
- **БД** (миграции с `0017`): хранение отправлений, лог статусов с идемпотентностью, габариты товара.
- **Storefront API**: расчёт + ПВЗ для витрин магазинов.
- **Admin**: server-actions + UI-блок в карточке заказа, список отправлений, настройки.
- **MOCK-режим** обязателен (см. §11): при отсутствии `CDEK_ACCOUNT`/`CDEK_SECRET` всё работает на
  заглушках — demo-магазин и тесты без боевых ключей (ADR-002, `docs/02`).

**Вне охвата Этапа 4** (заложить, но можно отложить): email-уведомления `cdek_*` (см. §8.5 — каркас
есть, шаблоны — опционально), вызов курьера `/intakes`, мульти-место (>1 упаковки на заказ).

### 1.3 Definition of Done

- [ ] Миграции `0017`–`0019` идемпотентны (`IF NOT EXISTS`), применяются `scripts/init-shop.sh`, запись в `schema_migrations`.
- [ ] `CdekClient`: OAuth client_credentials, кеш токена (Redis-when-available / memory-mock), retry на 401 и сетевые ошибки.
- [ ] `Calculator` заменяет `stubDeliveryCost`: `quoteCart`/`createOrder` считают доставку через СДЭК (в mock — по формуле).
- [ ] `/api/storefront/v1/delivery/cdek/{calculate,pvz}` отдают данные витрине (с module-gate `cdek`, CORS, rate-limit).
- [ ] `OrderService.createShipment(order)` создаёт отправление; webhook обновляет `delivery_status` через статус-машину; идемпотентность по UNIQUE в `cdek_status_log`.
- [ ] `PrintService` отдаёт URL PDF накладной/ШК.
- [ ] Cron `create-pending` / `notify-stuck` — реализованы как route/script, помечены для DevOps (Docker).
- [ ] Admin-блок СДЭК в заказе: создать/отменить/трек/статус/печать (право `cdek.manage`, audit `cdek.*`).
- [ ] **MOCK-режим**: при пустых `CDEK_*` все сервисы работают, demo-магазин оформляет заказ, тесты зелёные без боевых ключей.
- [ ] Тесты идут первыми (ADR-004): unit (StatusMap, Calculator-mock, normalizePhone, token-cache TTL, webhook-идемпотентность), интеграционные (webhook route, storefront-роуты), e2e (оформление заказа в demo).
- [ ] `.env.example` дополнен `CDEK_*`; `lib/config/env.ts` — Zod-схема; ADR-011 в `docs/01`; журнал/роадмап обновлены.

---

## 2. Архитектура — порт carre на TypeScript

Слоистость carre `Manager → Client → Services` (ADR-002) переносится 1:1. Всё живёт в `lib/cdek/`.

```
lib/cdek/
  index.ts              // публичный API модуля: getCdekManager()
  manager.ts            // CdekManager — фасад, ленивые синглтоны сервисов
  client.ts             // CdekClient — HTTP + OAuth2 + retry
  token-cache.ts        // кеш OAuth-токена (Redis | memory-mock), как rate-limit.ts
  mock/
    client.ts           // MockCdekClient — детерминированные заглушки всех эндпоинтов
    fixtures.ts         // фикстуры ПВЗ, тарифов, статусов
  services/
    calculator.ts       // Calculator — тариф/список тарифов/стоимость
    pvz.ts              // PvzService — список ПВЗ, поиск по коду (кеш)
    order.ts            // OrderService — создание/отмена отправления, buildPayload
    tracking.ts        // TrackingService — pull статусов (GET /orders/{uuid})
    webhook.ts         // WebhookService — parseEvent/handleEvent, идемпотентность
    print.ts           // PrintService — накладная/ШК
    quote-guard.ts     // DeliveryQuoteGuard — серверная ре-проверка тарифа на checkout
  status-map.ts         // StatusMap — коды СДЭК → delivery_status + шаблоны писем
  config.ts             // чтение CDEK_* из env + настройки магазина (отправитель, тариф, габариты)
  types.ts              // TS-типы запросов/ответов СДЭК и доменные типы модуля
  repository.ts         // доступ к cdek_shipments / cdek_status_log (pg)
  errors.ts             // CdekError (порт Exception.php: message + cdekErrors[] + httpStatus)
```

### 2.1 `CdekManager` (фасад)

Порт `Manager.php`. Ленивые синглтоны; выбирает реальный или mock-клиент по конфигу.

```ts
// lib/cdek/manager.ts
export interface CdekConfig {
  baseUrl: string;          // CDEK_BASE_URL (prod https://api.cdek.ru, test https://api.edu.cdek.ru)
  account: string | null;   // CDEK_ACCOUNT (client_id); null → mock
  secret: string | null;    // CDEK_SECRET (client_secret); null → mock
  testMode: boolean;        // CDEK_TEST_MODE
  fromLocationCode: number; // CDEK_FROM_LOCATION_CODE (город отправления, дефолт 44 = Москва)
  shipmentPoint?: string;   // CDEK_SHIPMENT_POINT (код склада отправителя, взаимоисключим с fromLocation)
  defaultTariffCode: number;// CDEK_DEFAULT_TARIFF (дефолт 136)
  allowedTariffs?: number[];// CDEK_ALLOWED_TARIFFS
  sender: CdekSenderConfig; // имя/телефон/email/ИНН отправителя (env CDEK_SENDER_*)
  webhookSecret: string | null;   // CDEK_WEBHOOK_SECRET
  webhookAllowedIps: string[];    // CDEK_WEBHOOK_IPS (IP/CIDR; пусто = bypass только в testMode)
  defaultDimensions: PackageDims; // дефолтные габариты (см. §3.3, cdek-dimensions.php-аналог)
  createEnabled: boolean;   // CDEK_CREATE_ENABLED — kill-switch авто-создания (дефолт true)
}

export class CdekManager {
  constructor(private readonly cfg: CdekConfig) {}
  get isMock(): boolean { return !this.cfg.account || !this.cfg.secret; }
  get client(): ICdekClient;        // реальный или MockCdekClient
  get calculator(): Calculator;
  get pvz(): PvzService;
  get order(): OrderService;
  get tracking(): TrackingService;
  get webhook(): WebhookService;
  get print(): PrintService;
  get quoteGuard(): DeliveryQuoteGuard;
}

export function getCdekManager(): CdekManager; // синглтон на процесс, конфиг из lib/cdek/config.ts
```

### 2.2 `CdekClient` (HTTP + OAuth) — порт `Client.php`

```ts
// lib/cdek/client.ts
export interface ICdekClient {
  request<T = unknown>(method: HttpMethod, path: string, opts?: RequestOptions): Promise<T>;
  getToken(): Promise<string>;
  invalidateToken(): Promise<void>;
  locationCities(params: { city?: string; country_codes?: string; size?: number; page?: number }): Promise<CdekCity[]>;
}

interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;                 // тело JSON
  timeoutMs?: number;             // дефолт 30000
  connectTimeoutMs?: number;      // дефолт 10000
  maxNetworkRetries?: number;     // дефолт 2 (задержки 250/500мс)
}
```

Поведение (порт carre, через `fetch`/`undici`):
- **OAuth:** `POST {baseUrl}/v2/oauth/token`, `application/x-www-form-urlencoded`, тело
  `grant_type=client_credentials&client_id=…&client_secret=…`. Ответ: `access_token`, `expires_in`.
  Кешируется *строка токена* (не весь ответ), TTL = `expires_in − 60` (минимум 60с, дефолт-фоллбэк 3540с).
- **Заголовки запросов:** `Authorization: Bearer <token>`, `Accept: application/json`.
- **Retry на 401:** `invalidateToken()` → новый токен → ровно один повтор.
- **Сетевой retry:** до `maxNetworkRetries` с задержками 250/500мс.
- **HTTP ≥ 400:** бросает `CdekError(message, body.errors, httpStatus)`.

### 2.3 Кеш OAuth-токена — `token-cache.ts`

Зеркалит паттерн `lib/auth/rate-limit.ts`: абстракция `TokenStore` с двумя реализациями —
`RedisTokenStore` (ioredis, `SET key val EX ttl`) при наличии `REDIS_URL`, иначе
`MemoryTokenStore` (Map, one-time `console.warn` про in-process кеш). Ключ:
`cdek:oauth:token:<sha256(account)>`. Потокобезопасность: при промахе — single-flight (in-flight
Promise на процесс), чтобы параллельные запросы не дёргали `/oauth/token` одновременно.

```ts
export interface TokenStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
}
export function getTokenStore(): TokenStore; // Redis | memory, как getDefaultLimiter()
```

### 2.4 `StatusMap` — `status-map.ts` (порт `StatusMap.php`)

Статические таблицы кодов СДЭК. Категория из carre (0–5) маппится на `DeliveryStatus` Admik
(`lib/orders/types.ts`: `pending|registered|in_transit|delivered|returned|cancelled`).

```ts
// lib/cdek/status-map.ts
import type { DeliveryStatus } from '@/lib/orders/types';

export const StatusMap = {
  /** Категория СДЭК (0–5, как carre) → DeliveryStatus заказа Admik */
  toDeliveryStatus(code: string): DeliveryStatus | null,
  /** Человекочитаемое русское имя статуса */
  displayName(code: string): string,
  /** Шаблон клиентского письма или null */
  clientEmailTemplate(code: string): string | null,
  /** Шаблон админ-письма (проблемы) или null */
  adminEmailTemplate(code: string): string | null,
};
```

Маппинг категории carre → `DeliveryStatus` Admik:

| Категория carre | Коды (примеры) | `DeliveryStatus` Admik |
|---|---|---|
| 1 (накладная создана) | `CREATED`, `ACCEPTED` | `registered` |
| 2 (в пути) | `RECEIVED_AT_SHIPMENT_WAREHOUSE`, `ON_THE_WAY`, `SENT_TO_RECIPIENT_CITY` … | `in_transit` |
| 3 (прибыл в город/ПВЗ) | `ACCEPTED_AT_PICK_UP_POINT`, `READY_FOR_PICKUP`, `TAKEN_BY_COURIER` | `in_transit` |
| 4 (вручён) | `DELIVERED` | `delivered` |
| 5 (проблема/возврат) | `NOT_DELIVERED`, `RETURNED_TO_SENDER*`, `LOST`, `INVALID` | `returned` |
| 5 (отмена) | `CANCELLED` | `cancelled` |

Полные таблицы кодов (`STATUS_TO_CATEGORY`, `STATUS_TO_NAME`, шаблоны писем) переносятся дословно из
`StatusMap.php` — см. digest в журнале Этапа 4. Категории 1/2/3 коллапсируют в `registered`/
`in_transit`, потому что статус-машина Admik (`status.ts`) грубее: `registered → in_transit →
delivered/returned`. Переход применяется только если допустим `canTransitionDelivery(from, to)`
(идемпотентность повторных webhook + защита от «отката» статуса).

---

## 3. Схема БД (миграции с 0017)

Стиль — как `0012`/`0011`: идемпотентно (`CREATE TABLE/INDEX IF NOT EXISTS`, `ADD COLUMN IF NOT
EXISTS`), `uuid` PK `gen_random_uuid()`, `timestamptz`, отложенное добавление CHECK через
`DO $$ ... pg_constraint`, `GRANT ... TO admik_app`, запись в `schema_migrations`.

### 3.1 `0017_cdek_shipments.sql` — отправления и лог статусов

Решение (ADR-002 «единая модель запроса, не 3 таблицы»): одна таблица отправлений `cdek_shipments`
(1:1 к заказу, но вынесена отдельно — поля `cdek_uuid`/`cdek_track` на `orders` остаются
денормализованными «горячими» полями для списков/витрины) + лог статусов `cdek_status_log`.

```sql
-- 0017_cdek_shipments.sql

CREATE TABLE IF NOT EXISTS cdek_shipments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL,                  -- FK → orders.id
  cdek_uuid       text,                           -- UUID отправления в СДЭК (NULL до создания)
  cdek_number     text,                           -- трек-номер (cdek_number)
  tariff_code     integer,                        -- код тарифа
  pvz_code        text,                           -- код ПВЗ назначения
  city_code       integer,                        -- код города получателя
  delivery_mode   text,                           -- pvz | postamat | door
  weight_g        integer    CHECK (weight_g IS NULL OR weight_g >= 0),
  length_cm       integer,
  width_cm        integer,
  height_cm       integer,
  delivery_sum    numeric(14,2) CHECK (delivery_sum IS NULL OR delivery_sum >= 0),
  status_code     text,                           -- последний код СДЭК
  status_name     text,                           -- displayName
  status_at       timestamptz,                    -- время последнего статуса
  print_url       text,                           -- URL последней накладной/ШК (опц.)
  is_mock         boolean   NOT NULL DEFAULT false,-- создано в mock-режиме
  error           text,                           -- последняя ошибка СДЭК
  retry_count     smallint  NOT NULL DEFAULT 0,   -- попыток создания (kill при >= max)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- FK добавляем отложенно (orders создан в 0012)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cdek_shipments_order_fk') THEN
    ALTER TABLE cdek_shipments
      ADD CONSTRAINT cdek_shipments_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cdek_shipments_order ON cdek_shipments(order_id);
CREATE INDEX IF NOT EXISTS ix_cdek_shipments_uuid   ON cdek_shipments(cdek_uuid);
CREATE INDEX IF NOT EXISTS ix_cdek_shipments_number ON cdek_shipments(cdek_number);
CREATE INDEX IF NOT EXISTS ix_cdek_shipments_status ON cdek_shipments(status_code, status_at);

-- Лог статусов с идемпотентностью webhook (порт cdek_status_log)
CREATE TABLE IF NOT EXISTS cdek_status_log (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL,
  cdek_uuid        text NOT NULL,
  status_code      text NOT NULL,
  status_name      text,
  status_date_time timestamptz,
  city_code        integer,
  city_name        text,
  is_mock          boolean NOT NULL DEFAULT false,
  raw_payload      jsonb,
  received_at      timestamptz NOT NULL DEFAULT now()
);

-- КЛЮЧ ИДЕМПОТЕНТНОСТИ webhook (порт uk_idem из carre):
-- одно событие (uuid + код + время) пишется один раз → INSERT ... ON CONFLICT DO NOTHING
CREATE UNIQUE INDEX IF NOT EXISTS uq_cdek_status_idem
  ON cdek_status_log(cdek_uuid, status_code, status_date_time);
CREATE INDEX IF NOT EXISTS ix_cdek_status_order ON cdek_status_log(order_id);
CREATE INDEX IF NOT EXISTS ix_cdek_status_uuid  ON cdek_status_log(cdek_uuid);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cdek_status_log_order_fk') THEN
    ALTER TABLE cdek_status_log
      ADD CONSTRAINT cdek_status_log_order_fk
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON cdek_shipments  TO admik_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON cdek_status_log TO admik_app;

INSERT INTO schema_migrations (version, name)
VALUES ('0017', 'cdek_shipments') ON CONFLICT DO NOTHING;
```

> Замечание по идемпотентности и `NULL`: в Postgres `NULL` в UNIQUE-индексе не конфликтует сам с
> собой, поэтому для событий без `status_date_time` подставляем `to_timestamp(0)` (а не `NULL`),
> чтобы повтор всё-таки ловился. Это делает `WebhookService` перед вставкой.

### 3.2 `0018_product_weight_dims.sql` — габариты товара

В каталоге Admik **нет** веса/габаритов на `products`/`product_variants` (подтверждено: только
`product_media.width/height` — пиксели). Для расчёта СДЭК нужен хотя бы вес. Решение
(мульти-магазин, без хардкода): добавляем nullable-поля на оба уровня; `NULL` → берётся дефолт из
настроек магазина (`CDEK_DEFAULT_*`, аналог `cdek-dimensions.php`). Вес варианта переопределяет вес
товара.

```sql
-- 0018_product_weight_dims.sql
ALTER TABLE products         ADD COLUMN IF NOT EXISTS weight_g  integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS length_cm integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS width_cm  integer;
ALTER TABLE products         ADD COLUMN IF NOT EXISTS height_cm integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS weight_g  integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS length_cm integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS width_cm  integer;
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS height_cm integer;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_weight_nonneg') THEN
    ALTER TABLE products ADD CONSTRAINT products_weight_nonneg
      CHECK (weight_g IS NULL OR weight_g >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'variants_weight_nonneg') THEN
    ALTER TABLE product_variants ADD CONSTRAINT variants_weight_nonneg
      CHECK (weight_g IS NULL OR weight_g >= 0);
  END IF;
END $$;

INSERT INTO schema_migrations (version, name)
VALUES ('0018', 'product_weight_dims') ON CONFLICT DO NOTHING;
```

Соответственно дополняются `lib/catalog/types.ts` (`Product`/`ProductVariant`), `schemas.ts` и
форма каталога в админке (необязательные поля «вес, г / Д×Ш×В, см»). Это единственное вторжение
Этапа 4 в каталог — изолированный аддитив.

### 3.3 Дефолтные габариты (`CDEK_DEFAULT_*`) — аналог `cdek-dimensions.php`

Так как у Admik нет «материал/размер» как у carre, упрощаем: один набор дефолтов на магазин из env
(`CDEK_DEFAULT_WEIGHT_G=500`, `…_LENGTH_CM=30`, `…_WIDTH_CM=20`, `…_HEIGHT_CM=10`). `Calculator`/
`OrderService` берут вес/габариты по приоритету: вариант → товар → дефолт магазина. Хардкод-фоллбэк
последней инстанции (если и env пуст) — `500 г / 30×20×10` (как `*/*`-fallback `250/28/28/6` в carre,
но крупнее — под относительно габаритные товары).

### 3.4 Кеш ПВЗ/тарифов (опционально, `0019`)

По умолчанию кешируем ПВЗ/тарифы в Redis (TTL: ПВЗ 24ч, тариф 10–30 мин), как carre. Таблица БД —
*опциональна* и нужна только если Redis недоступен на конкретном деплое; по умолчанию **не создаём**
(избегаем лишней схемы, ADR-002). Если потребуется — `0019_cdek_pvz_cache.sql` с `(city_code, payload
jsonb, fetched_at)` и TTL-очисткой в cron. В базовом плане Этапа 4 — пропускаем.

---

## 4. OAuth и кеш токена

- **Грант:** `client_credentials`. `CDEK_ACCOUNT` → `client_id`, `CDEK_SECRET` → `client_secret`.
- **Endpoint:** `POST {CDEK_BASE_URL}/v2/oauth/token`, форма (`x-www-form-urlencoded`).
- **Хранение:** строка `access_token` в `TokenStore` (Redis при `REDIS_URL`, иначе memory-mock).
  Ключ `cdek:oauth:token:<sha256(account)>`. TTL = `expires_in − 60` (min 60с).
- **Обновление:** при промахе кеша — `fetchToken()`; на ответ `401` от любого запроса —
  `invalidateToken()` + один повтор.
- **Потокобезопасность:** single-flight Promise на процесс при добыче токена (один запрос к
  `/oauth/token` даже при параллельных вызовах). На нескольких инстансах допускается редкая гонка —
  оба токена валидны, второй перезапишет кеш; критичности нет.
- **MOCK:** если `account`/`secret` пусты → `CdekManager.isMock = true`, `MockCdekClient` не ходит в
  сеть, `getToken()` возвращает `'mock-token'`. Один `console.warn` при инициализации.

---

## 5. Расчёт доставки (замена заглушки `stubDeliveryCost`)

### 5.1 Где меняется

`lib/orders/repository.ts`: функция `stubDeliveryCost(deliveryType?) → '0.00'` вызывается в
`quoteCart` и `createOrder`. Этап 4 вводит `lib/cdek/services/calculator.ts` и подключает его через
тонкий адаптер `lib/orders/delivery-cost.ts`, чтобы `lib/orders` не зависел жёстко от `lib/cdek`
(модуль может быть выключен).

```ts
// lib/orders/delivery-cost.ts
export interface DeliveryCostInput {
  deliveryType: DeliveryType;                 // courier | pvz | pickup
  items: Array<{ variantId: string; productId: string; qty: number }>;
  destination: { cityCode?: number; pvzCode?: string; cityName?: string };
  tariffCode?: number;
}
export interface DeliveryCostResult {
  cost: string;            // '0.00' для pickup; иначе расчёт (NUMERIC как string)
  tariffCode: number | null;
  periodMin: number | null;
  periodMax: number | null;
  source: 'cdek' | 'cdek_mock' | 'stub';
}
export async function computeDeliveryCost(input: DeliveryCostInput): Promise<DeliveryCostResult>;
```

Логика `computeDeliveryCost`:
1. `deliveryType === 'pickup'` → `{ cost: '0.00', source: 'stub' }` (самовывоз бесплатно).
2. Модуль `cdek` выключен → старый стуб `{ cost: '0.00', source: 'stub' }` (поведение Этапа 3 сохранено).
3. Иначе собрать `packages` (вес/габариты из товара/варианта/дефолта, §3.3), вызвать
   `Calculator.calculateByTariff` (или `quoteGuard.quote` на checkout для ре-проверки).
4. В mock-режиме — формула (§5.3), `source: 'cdek_mock'`.
- Применяется порог бесплатной доставки `SHOP_FREE_DELIVERY_THRESHOLD` (если сумма корзины ≥ порога → `cost = '0.00'`, как в Этапе 3).

**Признак назначения (`hasDestination`):** расчёт СДЭК запускается, если в `destination`
есть хотя бы один признак — `cityCode` (код города), `postalCode` (индекс), `pvzCode`
(код ПВЗ) **или `cityName` (имя города)**. Имя города критично для КУРЬЕРСКОЙ доставки:
заказ из `lib/orders` несёт назначение строкой `delivery.city` (→ `destination.cityName`),
числового кода у курьера обычно нет. Без учёта `cityName` курьерская доставка всегда
деградировала к stub `0.00` (был баг). `cityName` пробрасывается в `Calculator.to` как
`address` (real СДЭК геокодирует; mock считает по весу). Опц. числовой `delivery.cityCode`
(из автокомплита витрины) даёт точное назначение и идёт в `Calculator.to.code`.

**Anti-undercharge — реальный вес позиций (BUG A, волна 4).** Адаптер
`resolveDeliveryCost` (в `lib/orders/repository.ts`) ОБЯЗАН нести в `DeliveryCostLine[]`
не только `qty`, но и `weightG/lengthCm/widthCm/heightCm` каждой позиции (снимок каталога
из `resolveLineDims`). Раньше строился `lines.map(l => ({ qty: l.qty }))` — вес/габариты
терялись, `aggregatePackage` подставлял дефолт магазина (`CDEK_DEFAULT_WEIGHT_G ≈ 500`), и
`quote`/`createOrder` считали доставку по дефолтному весу, тогда как `order_items.weight_g`
и реальная СДЭК-накладная (`lib/cdek/services/order.ts`) билятся по РЕАЛЬНОМУ весу →
магазин недополучал за доставку тяжёлых товаров. В `quoteCart` локальный массив позиций
типизирован `ResolvedLine[]` (а не `PricedLine[]`), чтобы габариты были видны компилятору и
дошли до расчёта. `null`-поля по-прежнему легитимно деградируют к дефолту магазина.

**Anti-undercharge — 200 без цены (BUG B, волна 4).** СДЭК отвечает HTTP 200 даже когда
тариф недоступен для назначения: тело несёт непустой `errors[]` и НЕ содержит
`delivery_sum`/`total_sum`. `mapTariffResult` ДО маппинга требует конечную цену и пустой
`errors[]`; иначе бросает `CdekError('cdek_calc_no_price', …, { cdekErrors })`. Это
поднимается до `DeliveryCalculationError` (`createOrder` → `delivery_unavailable`; `quote`
`softFail` → `resolved:false`), а НЕ резолвится молча в `0.00`. Легитимный нуль
(`delivery_sum: 0` без `errors`) остаётся валидным `'0.00'`. Mock не затронут (его суммы
считаются формулой и не проходят через `mapTariffResult`).

### 5.2 `Calculator` (порт `Calculator.php`)

```ts
// lib/cdek/services/calculator.ts
export class Calculator {
  /** POST /v2/calculator/tariff → { delivery_sum, period_min, period_max } */
  calculateByTariff(tariffCode: number, from: CdekLocation, to: CdekLocation, packages: CdekPackage[]): Promise<TariffResult>;
  /** POST /v2/calculator/tarifflist → { tariff_codes: TariffOption[] } (type=2 ИМ) */
  calculateAvailable(from: CdekLocation, to: CdekLocation, packages: CdekPackage[], type?: number): Promise<TariffOption[]>;
}
interface CdekPackage { weight: number; length?: number; width?: number; height?: number }
interface CdekLocation { code?: number; postal_code?: string; address?: string }
```

Кеш результатов тарифа: Redis-ключ `cdek:tariff:<sha256(from|to|packages|tariff)>`, TTL 10 мин
(стоимость/сроки меняются медленно; на checkout всё равно ре-проверяем через `DeliveryQuoteGuard`).

### 5.3 Mock-тариф (без боевых ключей)

`MockCdekClient.calculateByTariff` возвращает детерминированную формулу:

```
base = 300 ₽
perKg = 100 ₽/кг → weightKg = ceil(weight_g / 1000)
cost = base + perKg * weightKg + (deliveryType==='courier' ? 150 : 0)   // курьер дороже ПВЗ
period_min = 2, period_max = 5
```

Стабильно, без сети, demo-магазин видит реалистичную стоимость. `source: 'cdek_mock'`.

---

## 6. ПВЗ для витрины

### 6.1 Storefront-эндпоинты (ADR-008, под `/api/storefront/v1/delivery/cdek/*`)

Оба роута проходят `runStorefront(req, handler, { module: 'cdek', methods })` — module-gate (404 при
выключенном `cdek`), `authorizeStorefront` (API-key/домен), rate-limit, CORS.

**`GET /api/storefront/v1/delivery/cdek/pvz`**
- Query: `city_code` (int) **или** `postal_code`; опц. `type=PVZ|POSTAMAT`, `country_code`.
- Хендлер → `PvzService.getOffices(filters)` → массив ПВЗ.
- Ответ (`jsonData`): `{ data: [{ code, name, address, location: { latitude, longitude }, workTime, type }] }`.
- Кеш 24ч (Redis). `from_location` витрине не нужен.

**`POST /api/storefront/v1/delivery/cdek/calculate`**
- Тело: `{ to: { city_code?, postal_code? }, deliveryMode: 'pvz'|'postamat'|'door', items: [{ variantId, qty }], tariffCode? }`.
- `from_location` — **всегда серверный** (`CDEK_FROM_LOCATION_CODE`), из тела не берётся (анти-tamper, ADR-010).
- **`tariffCode` из тела НЕ доверяется напрямую** (анти-tamper): нормализуется по `CDEK_ALLOWED_TARIFFS`
  (`resolveAllowedTariff`). Если whitelist непуст и входной код вне списка → подмена на
  `CDEK_DEFAULT_TARIFF` (расчёт не падает, тарифом управляет сервер). Пустой whitelist → любой код.
- Хендлер собирает `packages` по `items` (вес/габариты сервер-сайд), → `Calculator`
  → `{ data: { tariffCode, deliverySum, periodMin, periodMax } }`.
- В mock — формула §5.3 + фикстурные `tariff_codes`.

### 6.2 Виджет

Виджет ПВЗ (карта) живёт на **витрине** магазина; бэкенд Admik отдаёт только данные
через два эндпоинта выше (прокси к СДЭК, ключи не утекают на фронт — порт `CdekWidgetController`).
Бэкенд не рендерит виджет — это headless-контракт (ADR-008).

### 6.3 `PvzService` (порт `PvzService.php`)

```ts
// lib/cdek/services/pvz.ts
export class PvzService {
  /** GET /v2/deliverypoints?<filters> ; кеш 24ч */
  getOffices(filters: { city_code?: number; postal_code?: string; type?: string; country_code?: string }): Promise<CdekOffice[]>;
  /** GET /v2/deliverypoints?code=… ; positive-кеш 1ч, negative-кеш 5мин */
  findByCode(code: string): Promise<CdekOffice | null>;
}
```

---

## 7. Создание отправления и печать

### 7.1 `OrderService` (порт `OrderService.php`)

```ts
// lib/cdek/services/order.ts
export class OrderService {
  /** POST /v2/orders → { entity: { uuid }, requests } */
  create(payload: CdekOrderPayload): Promise<CdekCreateResult>;
  /** GET /v2/orders/{uuid} → { entity: { cdek_number, statuses[] } } */
  get(uuid: string): Promise<CdekOrderEntity>;
  /** DELETE /v2/orders/{uuid} (до приёмки) | PATCH (после приёмки) */
  cancel(uuid: string, afterAcceptance?: boolean): Promise<unknown>;

  /**
   * Оркестратор. Идемпотентен: пропускает заказы с уже выставленным cdek_uuid
   * и при retry_count >= max. Самовывоз (pickup) пропускает.
   * Транзакция: SELECT ... FOR UPDATE по orders/cdek_shipments → buildPayload → create →
   * запись cdek_uuid/cdek_number в cdek_shipments + денорм. в orders.cdek_uuid/cdek_track.
   * При ошибке: rollback + отдельный UPDATE error/retry_count++.
   *
   * Волна 7 (баг B): при УСПЕШНОМ пере-создании накладной (existing-ветка) вызов
   * updateShipmentByOrderId идёт с clearError=true → error СБРАСЫВАЕТСЯ в NULL и
   * retry_count в 0 ЯВНО. COALESCE(error) при error=null оставил бы текст прошлой
   * неудачи, и оператор видел бы «ошибку» на фактически успешной накладной. Флаг
   * clearError применяется ТОЛЬКО на успехе; обычный патч (без флага) сохраняет
   * прежнее COALESCE-поведение и не трогает retry_count.
   */
  createShipment(orderId: string, opts?: { force?: boolean }): Promise<CdekShipment | null>;
}
```

`buildPayload(order, shipment)` — порт `buildPayload`:
- `type=1` (ИМ), `number = order.number`, `tariff_code = shipment.tariffCode ?? CDEK_DEFAULT_TARIFF`.
- `sender` из `CDEK_SENDER_*` (имя/телефон/email/ИНН, `contragent_type=INDIVIDUAL_ENTREPRENEUR`).
- `recipient = { name, phones:[{ number: normalizePhone(order.customerPhone) }], email? }`.
  `normalizePhone` — порт: только цифры; 10 → `+7…`; 11 c `8`/`7` → `+7…`; иначе ошибка.
- Отправитель: `CDEK_SHIPMENT_POINT` (если задан) **или** `from_location: { code: CDEK_FROM_LOCATION_CODE }`.
- Назначение: `deliveryMode pvz/postamat` → `delivery_point = pvz_code`; `door` → `to_location:
  { code: city_code, postal_code?, address }`.
- `packages` — одна упаковка: вес = Σ(вес позиции × qty), Д/Ш = max, В = Σ; `items[]` со
  `{ name, ware_key: variantId, payment:{value:0}, cost, amount, weight }`. Фоллбэки габаритов §3.3.

### 7.2 `TrackingService` (порт логики `actionSyncOrder`)

В carre отдельного `TrackingService` нет — pull статусов делает `OrderService::get` + replay. В
Admik выносим в явный сервис:

```ts
// lib/cdek/services/tracking.ts
export class TrackingService {
  /** GET /v2/orders/{uuid}; читает entity.statuses[] и проигрывает каждый через WebhookService.handleEvent */
  syncOrder(orderId: string): Promise<void>;
}
```

Используется admin-кнопкой «Обновить статус» и cron-фоллбэком (если webhook не пришёл).

### 7.3 `PrintService` (порт `PrintService.php`)

```ts
// lib/cdek/services/print.ts
export class PrintService {
  /** POST /v2/print/orders {orders:[{order_uuid}], copy_count} → printUuid */
  requestWaybill(orderUuid: string, copyCount?: number): Promise<string>;
  /** GET /v2/print/orders/{printUuid} → url|null */
  getWaybillUrl(printUuid: string): Promise<string | null>;
  /** POST /v2/print/barcodes {orders:[{order_uuid}], format, copy_count} → printUuid */
  requestBarcode(orderUuid: string, format?: 'A4'|'A5'|'A6', copyCount?: number): Promise<string>;
  getBarcodeUrl(printUuid: string): Promise<string | null>;
}
```

Печать — двухшаговая (запрос задачи → опрос URL). Admin-action делает оба шага (с короткой
ре-попыткой опроса) и возвращает URL PDF. Право `cdek.manage`. В mock — возвращает
`https://example.invalid/mock-waybill.pdf`.

---

## 8. Webhook статусов

### 8.1 Route

**`POST /api/cdek/webhook?key=<secret>`** — `app/api/cdek/webhook/route.ts`, `export const dynamic =
'force-dynamic'`. Это **не** Storefront-роут (СДЭК → сервер), поэтому без `runStorefront`/CORS;
защита своя.

### 8.2 Защита (порт `CdekController::actionWebhook`, ужесточена после security-ревью)

Аутентификация — `authenticate()` в `app/api/cdek/webhook/route.ts`. Порядок (defense-in-depth):

1. **Секрет `?key=` — ПЕРВИЧНАЯ аутентификация.** Если задан `CDEK_WEBHOOK_SECRET`, он
   **обязателен** и сверяется ПЕРВЫМ (constant-time, `safeEqual` из `lib/storefront/order-dto.ts`).
   Неверный/отсутствующий ключ → `401` (жёсткий отказ; IP-слой НЕ перекрывает неверный секрет).
2. **IP-whitelist — ДОП. слой, ТОЛЬКО за доверенным прокси.** `CDEK_WEBHOOK_IPS` (IP/CIDR).
   **SECURITY:** IP берём из соединения, а **не** из `X-Forwarded-For`/`X-Real-IP` — эти заголовки
   клиент-контролируемые и доверяются ТОЛЬКО при `CDEK_WEBHOOK_TRUST_PROXY=true` (за Caddy, который
   пробрасывает реальный IP). Без `trustProxy` источник IP пустой → подделка заголовка обхода не даёт.
   Непустой список + IP вне диапазона → `403`.
3. **Пустой whitelist** разрешён (bypass с warn) **ТОЛЬКО в mock-режиме** (нет боевых
   `CDEK_ACCOUNT`/`CDEK_SECRET`, `isCdekMock()` — edu/CI-контур). **SECURITY:** bypass завязан на
   `isMock`, а **не** на `CDEK_TEST_MODE` — боевой test-контур (реальные ключи + `CDEK_TEST_MODE=true`)
   больше НЕ открывает write-путь к боевым `orders`. Вне mock-режима, если не настроены НИ секрет,
   НИ whitelist → `401` (роут не работает открытым).
4. **Аудит:** IP источника (если получен за `trustProxy`) сохраняется в `cdek_status_log.ip`
   (`handleWebhookEvent(payload, ip)` → `insertStatusLog({ ip })`, миграция 0017).
5. **Парсинг:** битый JSON → `200 { ok:false, warn:'invalid_json' }` (не 4xx/5xx — СДЭК не должен ретраить вечно).
6. Любая ошибка хендлера → `200 { ok:false, warn:'handler_error' }` (логируется). Успех → `200 { ok:true }`.

### 8.3 `WebhookService` (порт `WebhookService.php`)

```ts
// lib/cdek/services/webhook.ts
export class WebhookService {
  parseEvent(payload: unknown): CdekEvent;       // нормализует type/uuid/attributes
  handleEvent(event: CdekEvent): Promise<void>;  // см. ниже
  // подписка
  register(url: string, type?: 'ORDER_STATUS'): Promise<{ uuid: string }>;
  list(): Promise<CdekWebhook[]>;
  delete(uuid: string): Promise<void>;
}
```

`handleEvent`:
1. **Поиск заказа:** по `attributes.number` (= `order.number`) → по `cdek_number` → по `cdek_uuid`.
   Не найден → WARN, выход (без ошибки).
2. **Идемпотентность:** `INSERT INTO cdek_status_log (...) ON CONFLICT (cdek_uuid, status_code,
   status_date_time) DO NOTHING`. `status_date_time` при отсутствии → `to_timestamp(0)`. Если
   `rowCount === 0` (дубликат) → выход (никаких писем/обновлений).
3. **Обновление:** только если новое событие не старше текущего (`status_at`). Маппинг
   `StatusMap.toDeliveryStatus(code)` → если переход допустим `canTransitionDelivery(current, next)`,
   применяем (обновляем `cdek_shipments.status_*`, `orders.delivery_status`, при наличии — `cdek_track`).
   Недопустимый/повторный переход — пропускаем молча.
4. **Письма (опц., §8.5):** `StatusMap.clientEmailTemplate/adminEmailTemplate`.

### 8.4 Связь со статус-машиной заказа

Переход `delivery_status` идёт через `assertTransition`/`canTransitionDelivery` (`lib/orders/status.ts`).
Webhook не дёргает `orders.status` (оплата/выполнение) напрямую — только `delivery_status`; при
`delivered` отдельным правилом (Этап 3 §) основной статус может перейти в `completed` — это решение
оставляем в `lib/orders` (не в `lib/cdek`), чтобы СДЭК не знал про бизнес-статусы заказа.

### 8.5 Email-уведомления (опционально / заложить)

Каркас `StatusMap.clientEmailTemplate(code)` (`cdek_accepted`/`cdek_in_transit`/
`cdek_ready_for_pickup`/`cdek_delivered`/`cdek_courier_dispatched`) и `adminEmailTemplate(code)`
(`cdek_problem`) портируется. Фактическая отправка зависит от почтового модуля Admik (если его ещё
нет — откладываем, оставляя hook `notify(order, template)`-заглушку с `console.info` в mock).

---

## 9. Cron-воркеры

Реализация (порт `console/controllers/CdekController`): защищённые HTTP-роуты под cron-секрет
(`app/api/cdek/cron/<job>/route.ts`, заголовок `X-Cron-Secret = CDEK_CRON_SECRET`) **или** скрипты
`scripts/cdek-*.ts` (`tsx`). Для Docker — **пометить для DevOps**: добавить в `docker-compose.yml`/
cron-контейнер расписание. Все воркеры — no-op при выключенном модуле `cdek` или в mock без явного флага.

| Воркер | Расписание | Логика (порт) |
|---|---|---|
| `create-pending` | каждые 5 мин | `orders WHERE status оплачен AND cdek_uuid IS NULL AND retry_count < max AND created_at > now()-24h AND delivery_type != 'pickup'` → `OrderService.createShipment` для каждого (LIMIT 100). |
| `notify-stuck` | ежедневно 10:00 | `orders` оплаченные, без `cdek_uuid`, `retry_count >= max`, за 7 дней → одно админ-письмо `cdek_stuck`. |
| `sync-stale` (опц.) | каждый час | заказы `in_transit` без webhook > N часов → `TrackingService.syncOrder` (фоллбэк pull). |
| `register-webhook` | вручную/deploy | `WebhookService.register({siteurl}/api/cdek/webhook?key=…)`. |

«Оплачен» — по фактическому полю Этапа 3 (`orders.status`/`payment_status`); сверяется при реализации
с `lib/orders/status.ts`.

---

## 10. Server Actions и UI админки

### 10.1 Server Actions (порт через `defineAction`, право `cdek.manage`)

В `lib/cdek/actions.ts`, паттерн `lib/catalog/actions.ts`. Каждая пишет audit `cdek.*`.

```ts
export const createCdekShipment = defineAction({
  permission: 'cdek.manage',
  input: z.object({ orderId: z.string().uuid(), force: z.boolean().optional() }),
  handler: async ({ orderId, force }) => {
    const sh = await getCdekManager().order.createShipment(orderId, { force });
    return {
      result: sh,
      revalidate: ['/admin/orders/' + orderId],
      audit: { action: 'cdek.shipment.create', entityType: 'cdek_shipment', entityId: sh?.id, after: { cdekUuid: sh?.cdekUuid } },
    };
  },
});

export const cancelCdekShipment  = defineAction({ permission:'cdek.manage', /* cancel(uuid) → audit 'cdek.shipment.cancel' */ });
export const syncCdekStatus      = defineAction({ permission:'cdek.manage', /* TrackingService.syncOrder → audit 'cdek.status.sync' */ });
export const getCdekWaybillUrl   = defineAction({ permission:'cdek.manage', /* PrintService waybill → audit 'cdek.print.waybill' */ });
export const getCdekBarcodeUrl   = defineAction({ permission:'cdek.manage', /* PrintService barcode → audit 'cdek.print.barcode' */ });
```

### 10.2 UI

- **Карточка заказа** (`app/admin/(panel)/orders/[id]/_components/CdekBlock.tsx`): блок СДЭК —
  текущий статус доставки + история (`cdek_status_log`), трек-номер (ссылка на отслеживание СДЭК),
  кнопки: «Создать отправление», «Обновить статус», «Печать накладной», «Печать ШК», «Отменить
  отправление». Видим только при `isModuleEnabled('cdek')` и праве `cdek.manage`.
- **Список отправлений** (`app/admin/(panel)/cdek/page.tsx`): таблица `cdek_shipments` (фильтр по
  статусу/ошибке/«зависшие»), массовая повторная попытка создания.
- **Настройки СДЭК** (`app/admin/(panel)/cdek/settings/page.tsx`): город отправления, тариф по
  умолчанию, габариты по умолчанию, отправитель — read-only из env/настроек (источник правды — env;
  редактируемые per-shop настройки — опционально, как расширение).

---

## 11. MOCK-режим целиком

**Триггер:** `CDEK_ACCOUNT` или `CDEK_SECRET` пусты → `CdekManager.isMock = true`. Один
`console.warn('[cdek] mock-режим: боевые ключи не заданы')` при инициализации (паттерн
`rate-limit.ts`/`storefront/auth.ts`). Demo-магазин и CI работают без боевых ключей (`docs/02`).

| Возможность | Поведение в mock |
|---|---|
| OAuth | `getToken()` → `'mock-token'`, без сети |
| Расчёт (`Calculator`) | формула §5.3 (`base + perKg*kg + courier`), детерминированно; `source:'cdek_mock'` |
| ПВЗ (`PvzService`) | фикстуры `mock/fixtures.ts` — 3–5 ПВЗ для городов 44/137 и пары координат |
| Создание (`OrderService`) | фейковый `cdek_uuid = 'mock-' + randomUUID()`, `cdek_number = '1' + 9цифр`, `cdek_shipments.is_mock = true` |
| Печать (`PrintService`) | URL `https://example.invalid/mock-waybill.pdf` |
| Webhook | принимается, в `cdek_status_log.is_mock = true`; `actionSimulateWebhook`-аналог как admin-кнопка/скрипт для прогона статусов |
| Cron | работают на mock-данных (создают mock-отправления), не ходят в сеть |
| Tracking | возвращает mock-статусы из фикстур |

Тесты (ADR-004): unit на mock-клиенте без сети; e2e demo-магазина оформляет заказ и видит
mock-стоимость; webhook-роут тестируется фейковым payload + проверкой идемпотентности (повторный POST
→ один ряд в логе).

---

## 12. Декомпозиция Этапа 4 на задачи (пакеты)

Порядок — «сначала тесты» (ADR-004). Пакеты с непересекающимися файлами параллелизуемы.

### Пакет A — Миграции + типы + конфиг (фундамент, блокирует B–G)
- Файлы: `db/migrations/0017_cdek_shipments.sql`, `0018_product_weight_dims.sql`; `lib/cdek/types.ts`,
  `lib/cdek/config.ts`, `lib/cdek/errors.ts`, `lib/cdek/repository.ts`; правки `lib/config/env.ts`
  (Zod `CDEK_*`), `.env.example`; `lib/catalog/types.ts`/`schemas.ts` (вес/габариты).
- Тесты: env-валидация, repository CRUD `cdek_shipments`/`cdek_status_log`, идемпотентность UNIQUE.
- Критерий: миграции применяются идемпотентно; типы компилируются; `getCdekConfig()` читает env+mock-флаг.
- Зависимости: нет.

### Пакет B — Client + OAuth + token-cache + mock-клиент
- Файлы: `lib/cdek/client.ts`, `lib/cdek/token-cache.ts`, `lib/cdek/mock/{client,fixtures}.ts`, `lib/cdek/manager.ts`.
- Тесты: TTL токена, retry 401, single-flight, mock-клиент детерминирован.
- Критерий: реальный/mock клиент по конфигу; `CdekManager` отдаёт сервисы.
- Зависимости: A.

### Пакет C — Services: Calculator + Pvz + StatusMap + QuoteGuard
- Файлы: `lib/cdek/services/{calculator,pvz,quote-guard}.ts`, `lib/cdek/status-map.ts`.
- Тесты: StatusMap (полная таблица кодов→DeliveryStatus), Calculator mock-формула, кеш тарифа/ПВЗ, quote-guard fallback.
- Критерий: расчёт и ПВЗ работают на real+mock.
- Зависимости: B.

### Пакет D — Services: Order + Tracking + Webhook + Print
- Файлы: `lib/cdek/services/{order,tracking,webhook,print}.ts`.
- Тесты: `buildPayload` (ПВЗ/курьер/postamat ветки), `normalizePhone`, webhook-идемпотентность,
  переход `delivery_status` через статус-машину, print двухшаговый.
- Критерий: создание/отмена/трек/печать на mock; webhook не дублирует.
- Зависимости: C (StatusMap), A (repository).

### Пакет E — Storefront-эндпоинты + интеграция расчёта в заказы
- Файлы: `app/api/storefront/v1/delivery/cdek/{calculate,pvz}/route.ts`, `lib/orders/delivery-cost.ts`;
  правка `lib/orders/repository.ts` (замена `stubDeliveryCost` → `computeDeliveryCost` в `quoteCart`/`createOrder`).
- Тесты: роуты под `runStorefront` (module-gate 404, CORS, rate-limit), `quoteCart` считает доставку
  (mock), порог бесплатной доставки, pickup → 0.
- Критерий: витрина получает стоимость+ПВЗ; demo оформляет заказ.
- Зависимости: C, D.

### Пакет F — Webhook-route + UI админки + actions
- Файлы: `app/api/cdek/webhook/route.ts`; `lib/cdek/actions.ts`;
  `app/admin/(panel)/orders/[id]/_components/CdekBlock.tsx`, `app/admin/(panel)/cdek/{page,settings/page}.tsx`.
- Тесты: webhook IP-whitelist/secret/идемпотентность (HTTP), actions под `cdek.manage` + audit `cdek.*`.
- Критерий: webhook принимает и мапит статус; админ управляет отправлением.
- Зависимости: D.

### Пакет G — Cron-воркеры + DevOps
- Файлы: `app/api/cdek/cron/{create-pending,notify-stuck,sync-stale}/route.ts` (или `scripts/cdek-*.ts`);
  пометка для DevOps в `docker-compose.yml`/Caddyfile + `CDEK_CRON_SECRET`.
- Тесты: выборка кандидатов, идемпотентность `create-pending` (повторный прогон не дублирует).
- Критерий: воркеры создают/нотифицируют; задокументировано расписание для DevOps.
- Зависимости: D.

**Граф:** A → B → C → D; затем параллельно E, F, G. Документация (ADR-011, журнал, роадмап) —
сквозная.

---

## 13. Новые зависимости и env

### 13.1 Зависимости

- Сеть — `fetch`/`undici` (встроено в Node 18+); отдельный HTTP-клиент не нужен.
- `ioredis` — **уже** используется `lib/auth/rate-limit.ts` (переиспользуем для token/ПВЗ/тариф-кеша).
- Валидация — `zod` (уже есть).
- Новых runtime-зависимостей **не требуется**.

### 13.2 Переменные окружения (`lib/config/env.ts`, Zod `.optional()` → mock при отсутствии)

| Переменная | Назначение | Дефолт |
|---|---|---|
| `CDEK_BASE_URL` | базовый URL API | `https://api.cdek.ru` (test: `https://api.edu.cdek.ru`) |
| `CDEK_ACCOUNT` | client_id; **пусто → mock** | — |
| `CDEK_SECRET` | client_secret; **пусто → mock** | — |
| `CDEK_TEST_MODE` | тестовый контур СДЭК | `false` |
| `CDEK_FROM_LOCATION_CODE` | код города отправления | `44` (Москва) |
| `CDEK_SHIPMENT_POINT` | код склада отправителя (взаимоисключим с from_location) | — |
| `CDEK_DEFAULT_TARIFF` | тариф по умолчанию | `136` |
| `CDEK_ALLOWED_TARIFFS` | белый список тарифов (csv); непуст → storefront-расчёт отклоняет код вне списка (fallback на `CDEK_DEFAULT_TARIFF`) | — |
| `CDEK_SENDER_NAME` / `CDEK_SENDER_CONTACT_NAME` | отправитель | — |
| `CDEK_SENDER_PHONE` | телефон отправителя | — |
| `CDEK_SENDER_EMAIL` / `CDEK_SENDER_INN` | email/ИНН отправителя | — |
| `CDEK_DEFAULT_WEIGHT_G` / `_LENGTH_CM` / `_WIDTH_CM` / `_HEIGHT_CM` | дефолтные габариты | `500 / 30 / 20 / 10` |
| `CDEK_WEBHOOK_SECRET` | секрет `?key=` для webhook | — |
| `CDEK_WEBHOOK_IPS` | IP/CIDR whitelist (csv); работает ТОЛЬКО за `CDEK_WEBHOOK_TRUST_PROXY=true` | — (пусто допустимо лишь в mock-режиме, нет боевых ключей) |
| `CDEK_WEBHOOK_TRUST_PROXY` | доверять прокси-заголовку IP (за Caddy) | `false` |
| `CDEK_CRON_SECRET` | секрет cron-роутов | — |
| `CDEK_CREATE_ENABLED` | kill-switch авто-создания | `true` |

Существующие переиспользуемые: `REDIS_URL` (кеши), `SHOP_FREE_DELIVERY_THRESHOLD` (порог бесплатной
доставки), `ADMIK_MODULES` (флаг `cdek`).

---

## Резюме архитектурных решений

1. **Слоистый порт carre на TS** в `lib/cdek/*`: `CdekManager → CdekClient → Services`
   (Calculator/Pvz/Order/Tracking/Webhook/Print/StatusMap/QuoteGuard). Зафиксировано в ADR-011.
2. **MOCK-режим** при пустых `CDEK_ACCOUNT/CDEK_SECRET`: формула расчёта, фикстуры ПВЗ, фейковые
   uuid/трек, `is_mock`-флаги. Demo-магазин и CI без боевых ключей (ADR-002, docs/02).
3. **OAuth client_credentials** + кеш токена (Redis-when-available / memory-mock, паттерн
   `rate-limit.ts`), TTL=`expires_in−60`, retry на 401, single-flight.
4. **Идемпотентность webhook** через UNIQUE `(cdek_uuid, status_code, status_date_time)` в
   `cdek_status_log` + `ON CONFLICT DO NOTHING`, IP-whitelist + `?key=` секрет, всегда `200`.
5. **Аддитивность:** заглушка `stubDeliveryCost` заменена `computeDeliveryCost` (через адаптер
   `lib/orders/delivery-cost.ts`, без жёсткой связки `orders→cdek`); статус webhook идёт через
   статус-машину `lib/orders/status.ts`; поля доставки `0012` переиспользуются.
6. **БД с `0017`:** `cdek_shipments` (1:1 к заказу) + `cdek_status_log` (идемпотентность);
   `0018` добавляет вес/габариты товару/варианту (в каталоге их не было); дефолты — из env.
7. **Storefront API** `/api/storefront/v1/delivery/cdek/{calculate,pvz}` (ADR-008), `from_location`
   серверный (анти-tamper, ADR-010); виджет — на витрине, бэкенд отдаёт данные.
8. **Admin** через `defineAction(permission:'cdek.manage')` + audit `cdek.*`; блок СДЭК в заказе,
   список отправлений, настройки.
9. **Cron** `create-pending`/`notify-stuck`(/`sync-stale`) как защищённые роуты/скрипты, расписание —
   для DevOps в Docker.

## Список задач Этапа 4 (пакеты)

- **A — Миграции+типы+конфиг** (фундамент): `0017`/`0018`, `lib/cdek/{types,config,errors,repository}`,
  env `CDEK_*`, вес/габариты в каталог. Без зависимостей.
- **B — Client+OAuth+token-cache+mock**: `lib/cdek/{client,token-cache,manager}`, `mock/*`. Зависит от A.
- **C — Calculator+Pvz+StatusMap+QuoteGuard**: расчёт и ПВЗ. Зависит от B.
- **D — Order+Tracking+Webhook+Print**: отправления, статусы, печать. Зависит от C, A.
- **E — Storefront-эндпоинты + интеграция расчёта**: `/delivery/cdek/{calculate,pvz}`, замена
  `stubDeliveryCost`. Зависит от C, D.
- **F — Webhook-route + UI + actions**: `/api/cdek/webhook`, `lib/cdek/actions`, админ-блок/список.
  Зависит от D.
- **G — Cron + DevOps**: `create-pending`/`notify-stuck`/`sync-stale`, расписание для DevOps. Зависит от D.

Граф: **A → B → C → D**, затем параллельно **E, F, G**.
