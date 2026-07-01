# Этап 5 — CMS, промо-механики N×M, SEO, настройки магазина

> Проектный документ Solution Architect + Documentation Manager. Этап 5 — четыре аддитивные
> подсистемы поверх готового ядра (Этапы 1–4): **5.1 CMS-страницы** (контент-механика
> `page_sections`/JSONB, паттерн 2x2), **5.2 Промо-механики «N по M»** (исполнение `kind='bogo'` +
> scope-таргетинг поверх задела заказов), **5.3 SEO** (метаполя сущностей, `sitemap.xml`/`robots.txt`),
> **5.4 Настройки магазина из БД** (`shop_settings`: env-дефолт ⊕ БД-оверрайд, оверрайд модулей через UI).
>
> Архитектурное обоснование — ADR-012 (CMS), ADR-013 (настройки env⊕БД), ADR-014 (движок акций N×M)
> в `docs/01`, опирающиеся на ADR-002 (что берём из 2x2/carre), ADR-003 (1 магазин = 1 БД, без
> `tenant_id`), ADR-004 (сначала тесты), ADR-005 (RBAC), ADR-008 (Storefront API), ADR-010
> (anti-tamper расчёт денег). Источники паттернов: `2x2` (`page_sections`, `site_settings`,
> `sitemap.ts`/`robots.ts`) и `carre` (промокоды, SEO-поля сущностей).
>
> **Принцип документа:** все четыре подсистемы — *строго аддитивны*. Никаких правок логики
> `core`/`orders`/`catalog`/`cdek`, кроме явно перечисленных точек смены **источника значения**
> (env → env⊕БД) при сохранении контрактов DTO. Каждая мутация — через существующий `defineAction`
> (гвард → Zod → БД → revalidate → audit), деньги — в копейках, миграции идемпотентны.

---

## 0. Краткое следствие (TL;DR)

- **Четыре подсистемы, один сквозной слой настроек.** 5.4 (`shop_settings`) — фундамент: переводит
  магазино-специфику с env на БД (env = дефолт, БД = оверрайд), включая оверрайд `ADMIK_MODULES`.
  5.3 (SEO) читает домен/шаблоны из `shop_settings`. Поэтому **5.4 реализуется первым** в этапе.
- **Никакого `tenant_id` / `website_id`** (ADR-003). Расхождение с рекомендацией 2x2 (`website_id`
  везде) — осознанное: у Admik мультитенантность = изоляция БД, а не общая схема.
- **Нумерация миграций — единая сплошная для всего этапа: `0019`–`0024`** (последняя в репозитории —
  `0018_product_weight_dims.sql`). Все четыре подсистемы в разведке независимо предлагали начать с
  `0019`; конфликт разрешён здесь распределением непересекающегося диапазона (см. §1.3 и §2).
- **CMS** — отключаемый модуль (`cms`, флаг и права `cms.read`/`cms.write` уже заведены). Один
  магазин-инстанс может работать как headless-каталог без CMS; другой — с CMS-страницами и акциями.
- **Промо N×M** живёт в модуле `orders` (это денежный движок, не контент): расширяем `promo_codes`
  одним `kind`-полем + `promo_targets`, дописываем чистую `bogoDiscountMinor`. Anti-tamper (ADR-010)
  сохраняется буквально.
- **SEO** — поля на самих сущностях (НЕ отдельная `page_metadata` как в 2x2); `sitemap.xml`/`robots.txt`
  — core-always-on route handlers, но наполнение фильтруется по `isModuleEnabled`.
- **Сначала тесты** (ADR-004): для каждой подсистемы перечислены конкретные падающие-до-кода кейсы.

---

## 1. Цель, охват и Definition of Done

### 1.1. Цель этапа

Закрыть требования платформы по контенту, маркетингу, поисковой оптимизации и конфигурируемости,
превратив стек из env-driven в DB-driven и обеспечив «копировать-вставить» новый магазин **без правки
кода** (только настройка через UI). Четыре подсистемы делают платформу самодостаточной CMS/ERP-ядром.

### 1.2. In scope

| Подсистема | Что входит |
|---|---|
| **5.1 CMS** | `cms_pages` + `cms_page_sections` (+опц. `cms_page_revisions`), JSONB-секции (hero/text/banner/products_grid/faq/cta/gallery), rich-text Tiptap + серверная санитизация, статусы draft/published/archived, Storefront `/pages/[slug]`, admin `/admin/cms/*` |
| **5.2 Промо N×M** | исполнение `kind='bogo'` (купи N плати M), `apply_scope` (cart/category/brand/set) + `promo_targets`, приоритет/комбинируемость, расширение формы промокода, обновление `quoteCart`/`createOrder` |
| **5.3 SEO** | SEO-поля на products/categories/brands/cms_pages (og_*/canonical/noindex), `sitemap.xml`, `robots.txt`, `SeoMetaDto` в DTO, переиспользуемый `<SeoFieldset>` |
| **5.4 Настройки** | `shop_settings` (key-value JSONB), env⊕БД-merge, оверрайд `ADMIK_MODULES` через UI, брендинг/валюта/единицы/реквизиты/пороги, Storefront `/settings`, admin `/admin/settings/*` |

### 1.3. Out of scope (явно отложено)

- **gift-позиция** (товар-подарок в заказе) — в 5.2 только *задел* (колонки + UI за флагом);
  исполнение (вставка в `order_items` + резерв) — отдельный будущий пакет/ADR.
- **Множественные промокоды на один заказ** — в 5.2 один `promoCode` на заказ; `stackable` — резерв.
- **`cms_page_revisions`** (миграция `0021`) — опционально, можно отложить (см. §3.1).
- **sitemap-index** для >50k URL — точка роста (MVP: один файл с `LIMIT`).
- **i18n/мультиязычность контента**, **Redis-кеш CMS/настроек** — задел, не блокер (1 магазин = 1 БД).
- **Email-уведомления** по промо/контенту — Этап 6+.

### 1.4. Definition of Done (этап)

- [ ] Миграции `0019`–`0024` идемпотентны (`IF NOT EXISTS`, CHECK через DO-блок + `pg_constraint`,
      `INSERT ... schema_migrations ON CONFLICT DO NOTHING`), сплошная нумерация без пропусков от `0018`.
- [ ] **5.4:** `shop_settings` + `mergeSettings(env, db)` (чистая); `getEffectiveSettings()`/
      `getEffectiveModules()`; оверрайд модулей через `/admin/settings/modules`; `GET /settings`
      (core-always-on); каркас админки и витрина читают эффективные настройки (env→env⊕БД).
- [ ] **5.1:** CMS-страницы CRUD через `defineAction(cms.write)`; JSONB-секции с дискриминированной
      Zod-валидацией по `type`; серверная санитизация rich-text; Storefront `/pages/[slug]` под
      `module:'cms'`; admin `/admin/cms/*` с drag-and-drop reorder.
- [ ] **5.2:** `bogoDiscountMinor`/`scopeDiscountMinor` (чистые); `quote.promo.discount` для bogo
      больше не `0`; `createOrder` пишет `promo_redemptions.discount_applied` атомарно; форма промокода
      расширена (scope/targets/bogo/priority/stackable).
- [ ] **5.3:** SEO-поля на 4 сущностях; `SeoMetaDto` в DTO (наружу `ogImageUrl`, не ключ S3);
      `sitemap.xml` фильтруется по модулям и `noindex`; `robots.txt` берёт домен из `shop_settings`,
      non-prod → `Disallow: /`.
- [ ] Тесты идут первыми (ADR-004); зелёные без боевых ключей и без БД для unit-слоя.
- [ ] ADR-012/013/014 в `docs/01`; журнал (`docs/00`) и роадмап (`docs/03`) обновлены.

---

## 2. Сводная карта миграций Этапа 5 (разрешение конфликта нумерации)

Последняя миграция в репозитории — `0018_product_weight_dims.sql`. Разведка по каждой из четырёх
подсистем независимо предложила начать с `0019`, что создаёт коллизию. **Решение оркестратора:**
единый сплошной диапазон с фиксированным владельцем каждого номера. Реализация подсистем идёт в
порядке 5.4 → 5.3 → 5.1 → 5.2 (см. §8), но **номера закреплены заранее**, чтобы пакеты не конкурировали
за один файл.

| № | Файл | Подсистема | Содержание |
|---|---|---|---|
| `0019` | `0019_shop_settings.sql` | 5.4 | `CREATE TABLE shop_settings` (setting_key citext PK, value jsonb, updated_at, updated_by FK→users), CHECK `jsonb_typeof(value)='object'`, GRANT |
| `0020` | `0020_shop_settings_seed.sql` | 5.4 | Идемпотентный seed пустых ключей `branding/currency/units/module_overrides/seo` (`ON CONFLICT DO NOTHING`) |
| `0021` | `0021_seo_entity_fields.sql` | 5.3 | ALTER products/categories/brands: `og_title/og_description/og_image_key/canonical_url` text, `noindex` boolean DEFAULT false |
| `0022` | `0022_cms_pages.sql` | 5.1 | `CREATE TABLE cms_pages` (slug citext UNIQUE, status триада, published_at, seo_*/og_image_url/canonical_url/noindex, sitemap_priority/changefreq, created_by/updated_by) |
| `0023` | `0023_cms_page_sections.sql` | 5.1 | `CREATE TABLE cms_page_sections` (page_id FK CASCADE, section_key, type CHECK, content jsonb, display_order, enabled) + CHECK размера content; **опц.** `cms_page_revisions` в этой же миграции либо отдельной |
| `0024` | `0024_promo_mechanics_nxm.sql` | 5.2 | ALTER promo_codes (`apply_scope/priority/stackable/min_qty/gift_*` + CHECK `promo_bogo_pair_chk`); `CREATE TABLE promo_targets` |

> Примечание по SEO для CMS-страниц: разведка 5.3 предлагала отдельную миграцию `cms_pages_seo_fields`.
> Здесь решено: SEO/sitemap-поля CMS-страниц включаются **прямо в `CREATE TABLE cms_pages` (`0022`)**,
> т.к. 5.1 и 5.3 в одном этапе — нет нужды в ALTER «вдогонку». Колонки помечены `IF NOT EXISTS`-устойчиво
> (если когда-либо 5.3 опередит 5.1 — `0021` затрагивает только products/categories/brands, а CMS-поля
> живут в `0022`). Это снимает зависимость «`0020` ALTER `cms_pages`» из разведки 5.3.

---

## 5.4. Настройки магазина из БД (`shop_settings`) — **реализуется первым**

> core-always-on. Это слой конфигурации, превращающий стек из env-driven в DB-driven. ADR-013.

### 5.4.1. Модель данных

**`shop_settings`** (миграция `0019`):

| Колонка | Тип | Назначение |
|---|---|---|
| `setting_key` | `citext PRIMARY KEY` | стабильный ключ логического раздела (`branding`, `currency`, `units`, `contacts`, `legal_entity`, `catalog`, `delivery`, `orders`, `module_overrides`, `seo`) |
| `value` | `jsonb NOT NULL` | полезная нагрузка раздела, типизированная Zod-схемой ключа; CHECK `jsonb_typeof(value)='object'` |
| `updated_at` | `timestamptz NOT NULL DEFAULT now()` | обновляется явно в репозитории |
| `updated_by` | `uuid NULL REFERENCES users(id) ON DELETE SET NULL` | кто менял (audit-trail на строке + `audit_log`) |

**Схемы `value` по ключам** (одна строка = одна логическая группа, НЕ плоский blob, НЕ таблица-на-ключ):

- `branding`: `{ shopName, logoUrl, faviconUrl, theme:{primaryColor,accentColor,mode}, supportEmail, supportPhone }`
- `currency`: `{ code (ISO 4217, дефолт RUB), symbol, locale, fractionDigits }`
- `units`: `{ weight:'g'|'kg', dimension:'cm'|'mm', system:'metric' }`
- `contacts`: `{ phone, email, address, workingHours, socials:[{type,url}] }`
- `legal_entity`: `{ name, inn, kpp, ogrn, legalAddress, bankDetails }`
- `catalog`: `{ newProductDays:int }` — оверрайд `SHOP_NEW_PRODUCT_DAYS`
- `delivery`: `{ freeDeliveryThreshold:int (копейки) }` — оверрайд `SHOP_FREE_DELIVERY_THRESHOLD`
- `orders`: `{ orderPrefix:string }` — оверрайд `SHOP_ORDER_PREFIX`
- `module_overrides`: `{ catalog?:bool, orders?:bool, cdek?:bool, cms?:bool, payments?:bool }` — частичный оверрайд `ADMIK_MODULES`; отсутствие поля → env. Применяется **авторитетно в рантайме** через `getEffectiveModuleSet()`/`isModuleEffectivelyEnabled()` (волна 5), не только в `sitemap.ts`
- `seo`: `{ site_name, site_url, title_template '%s — {site_name}', default_description, default_og_image_key, robots_extra, twitter_site, noindex_site }` (используется 5.3)

**Семантика merge (инвариант):** `env-дефолт ⊕ строка БД`, частичный merge на уровне полей внутри
`value`. Отсутствие строки/поля → берётся env. Деньги в `value` — в **копейках**.

### 5.4.2. Миграции

- **`0019_shop_settings.sql`** — `CREATE TABLE IF NOT EXISTS shop_settings`; FK `updated_by` и CHECK
  `jsonb_typeof(value)='object'` через DO-блок + `pg_constraint` (у `ADD CONSTRAINT` нет `IF NOT
  EXISTS`); `GRANT SELECT,INSERT,UPDATE,DELETE ON shop_settings TO admik_app` (DELETE — для reset к
  env-дефолту); запись в `schema_migrations`.
- **`0020_shop_settings_seed.sql`** — идемпотентный seed: `INSERT ... ON CONFLICT (setting_key) DO
  NOTHING` (НЕ `DO UPDATE` — повторный накат не затирает правки администратора). Сидируем
  `branding/currency/units/module_overrides/seo` пустыми `'{}'::jsonb` (пустой объект = «нет
  оверрайда» → читается env).

### 5.4.3. Server Actions (`lib/settings/actions.ts`)

Все через `defineAction({ permission:'settings.manage' })` (право уже core, `permissions.ts:51`):

- `updateBrandingSettings` — UPSERT ключа `branding`; revalidate `['/admin','/admin/settings','/']`;
  audit `settings.branding.update` (before/after).
- `updateCurrencyAndUnits` — UPSERT `currency`/`units`; revalidate витринных путей (форматирование цен).
- `updateLegalAndContacts` — UPSERT `legal_entity`/`contacts` (ИНН 10/12 цифр, КПП, ОГРН).
- `updateCatalogOrdersSettings` — UPSERT `catalog`/`delivery`/`orders` (`freeDeliveryThreshold` вводится
  в рублях → хранится в копейках через `toMinor`).
- `updateModuleOverrides` — UPSERT `module_overrides`; **обязательно** revalidate всех `/admin/*` и
  витрины (меняется состав меню/доступность роутов); audit `settings.modules.update` (before/after).
  Гард от self-lock: `settings` всегда core → `/admin/settings` не исчезнет (не входит в схему
  `module_overrides`). При выключении модуля с активными данными (например `cms:false` при наличии
  опубликованных страниц) action не блокирует, но возвращает `warnings:string[]` (напр.
  `'cms_has_published_pages'`) — данные не удаляются, лишь скрывается UI/API; UI показывает предупреждение.
- `resetSetting` — `DELETE` строки ключа → возврат к env-дефолту; audit `settings.reset`.

**Слой эффективных настроек** (`lib/config/settings.ts`):
- `mergeSettings(envDefaults, dbRows)` — **чистая** функция (env⊕БД), тестируется без БД. Несёт также
  распарсенный `module_overrides` в `EffectiveSettings.modules.overrides` (мягкий `.strip()`-парс).
- `getEffectiveSettings()` — читает БД один раз и мемоизирует (module-level memo); `invalidateSettingsCache()`
  вызывается в каждом settings-action (read-your-own-writes). Redis — задел на будущее.
  - **Epoch/generation guard против TOCTOU (волна 6, баг A):** in-flight чтение захватывает
    монотонный `cacheEpoch` ДО `await read()` и кеширует результат **только если** epoch не
    сменился за время чтения. `invalidateSettingsCache()` инкрементирует `cacheEpoch`. Без этого
    была гонка: пока зависший SELECT запроса A не зарезолвился, параллельный `updateModuleOverrides`
    делал upsert + инвалидацию, после чего A резолвился СТАРЫМ снапшотом и перезаписывал `cached`
    устаревшим значением — stale висел до следующей записи настроек. Критично после d1bc04b, т.к.
    этот кэш авторитетен для ВСЕХ рантайм-гейтов модулей. Теперь A возвращает прочитанное вызывающему
    (read-your-own-read), но не кеширует устаревшее → следующий вызов перечитывает БД.
- `getEffectiveModules(env, dbOverrides)` — поверх `getEnabledModules(env)` накладывает `module_overrides`.
- **`getEffectiveModuleSet()` / `isModuleEffectivelyEnabled(name)`** (волна 5, баг #1) — **АВТОРИТЕТНЫЙ
  рантайм-гейт** модулей (env⊕БД-оверрайд) через тот же memo-кэш. До фикса единственным потребителем
  `getEffectiveModules` был `sitemap.ts`, а ВСЕ рантайм-гейты читали только `process.env` через синхронный
  `isModuleEnabled` — выключение модуля из UI было почти no-op. Теперь на async-гейт переведены:
  `runStorefront` (404 `module_disabled`), per-action asserts (`assertOrdersEnabled`/`assertCatalogEnabled`/
  `assertCmsEnabled`/`assertCdekEnabled`), webhooks Т-Банк/СДЭК, cron СДЭК, `computeDeliveryCost`, дашборд,
  карточка заказа (блок СДЭК), admin section-guards и `buildAdminNav` (через `layout.tsx`). Без оверрайда
  поведение совпадает с env; при недоступности БД (нет `DATABASE_URL`) гейт мягко откатывается на env-набор.
  Синхронный `isModuleEnabled`/`getEnabledModules` оставлены для чисто-env контекстов (напр. `settings/page.tsx`
  показывает env-набор для дельты «по умолчанию vs оверрайд»).

### 5.4.4. Storefront API

- **`GET /api/storefront/v1/settings`** — публичные настройки (брендинг, currency, units, contacts,
  socials, seo-дефолты, freeDeliveryThreshold). Через `runStorefront(req, handler)` **без `options.module`**
  (core-always-on — отдаётся независимо от флагов). `toPublicSettingsDto` скрывает `updated_by`/`updated_at`,
  `legal_entity.bankDetails`, приватные ключи. Образец — `brands/route.ts` (`jsonData`+`handlePreflight`+CORS).
- **Влияние на существующие роуты (аддитивно, контракт DTO неизменен):** `products/[slug]`/`products`
  и `lib/orders/repository.ts` берут `newProductDays`/`freeDeliveryThreshold` теперь из
  `getEffectiveSettings()` (env⊕БД) вместо прямого `getEnv()`. Меняется **источник значения**, не DTO.
- Write-эндпоинтов в Storefront НЕТ (настройки правит только админка).

### 5.4.5. Admin UI (`/admin/settings/*`)

- `app/admin/(panel)/settings/page.tsx` — серверная страница (guard `settings.read`/`settings.manage`),
  вкладки. Пункт меню в `lib/admin/nav.ts`: `{ href:'/admin/settings', label:'Настройки',
  permission:'settings.manage' }` **без `module`** (core) — `buildAdminNav` отфильтрует по праву.
  `buildAdminNav(user, enabledModules)` (волна 5) принимает **эффективный набор модулей** (env⊕БД),
  который вычисляет `layout.tsx` через `getEffectiveModuleSet()` — меню реагирует на выключение модуля
  из UI, а не только на `ADMIK_MODULES`. Функция остаётся чистой (не читает env/БД сама).
- `_components/`: `BrandingForm` (логотип через S3-upload как в catalog `MediaSection`, цвета темы),
  `CurrencyUnitsForm`, `LegalContactsForm`, `CatalogOrdersForm`, `ModulesForm` (три состояния на модуль:
  наследовать env / включить / выключить; показывает env-значение и оверрайд). Список модулей формы
  и маппинг состояния вынесены в чистый `_components/modules-form-state.ts` (тестируется без DOM) и
  **выводятся из `ALL_MODULES`** (включая `payments`). Волна 5, баг #2: раньше форма перечисляла модули
  вручную без `payments`, из-за чего его оверрайд не читался и при каждом сохранении **молча затирался**;
  деривация из `ALL_MODULES` устраняет рассинхрон и делает `payments` управляемым из UI.
- Каркас-консьюмеры брендинга: `app/admin/(panel)/layout.tsx`, `app/admin/login/page.tsx` читают
  `getEffectiveSettings().branding` вместо `env.SHOP_NAME/SHOP_LOGO_URL` (login вне `(panel)` — прямое
  чтение БД с fallback на env). Тема через CSS-переменные из `branding.theme`.

### 5.4.6. Тест-кейсы (до кода)

- `lib/config/settings.test.ts` — `mergeSettings`: пустая БД → env; частичный оверрайд (только
  `branding.shopName`) → остальное из env; полный оверрайд; лишние поля в `value` отброшены Zod.
- `getEffectiveModules`: `env=all + override{orders:false}` → orders выкл; `env='catalog' +
  override{cms:true}` → catalog+cms; пустой override → ровно `getEnabledModules(env)`.
- `updateModuleOverrides` (mock deps): без `settings.manage` → `forbidden`; невалидный модуль →
  `validation`; успех → upsert + audit + revalidate всех `/admin`.
- **self-lock guard `updateModuleOverrides`:** попытка выключить `settings`-релевантный core нерелевантна
  (settings не в `module_overrides`-схеме → не выключаем сами себя); `getEffectiveModules` после
  `{settings-маршрут всегда доступен}` — `/admin/settings` остаётся в навигации при любом оверрайде
  (тест через `buildAdminNav`: пункт «Настройки» присутствует даже при `module_overrides={catalog:false,
  orders:false,cdek:false,cms:false}`).
- **выключение модуля с активными данными:** `updateModuleOverrides({cms:false})` при наличии
  опубликованных `cms_pages` (mock-репозиторий «есть данные») → action **успешен**, но возвращает
  `warnings:['cms_has_published_pages']` (мягкое предупреждение, не блок — данные не теряются, лишь
  скрывается UI/API); тест проверяет наличие предупреждения и что аудит зафиксировал before/after.
- `updateBrandingSettings`: невалидный `logoUrl`/hex-цвет → `validation`; успех пишет `updated_by` + audit.
- `legalEntitySchema`: ИНН не 10/12 цифр → ошибка; пустой `shopName` → ошибка.
- `toPublicSettingsDto`: НЕ содержит `bankDetails`/`updated_by`/internal-ключей; содержит публичные.
- Деньги: `freeDeliveryThreshold` рубли→копейки round-trip без float.
- Кеш: два чтения → один запрос к sql (mock); после мутации → новый запрос (инвалидация).
- API `GET /settings`: корректный DTO + CORS; отдаётся даже при `ADMIK_MODULES` без `cms`.

### 5.4.7. Инварианты 5.4

- Без `tenant_id`/`website_id` (ADR-003). Без хардкодов магазина — всё в `value` строк.
- Деньги — в копейках. Каждая запись проходит Zod конкретного ключа + CHECK `jsonb_typeof='object'`.
- core-always-on (управляет оверрайдом модулей — не может прятаться за флагом, который сама переключает).
- Идемпотентность: `0019` DDL, `0020` seed `ON CONFLICT DO NOTHING`. Reset = `DELETE` → env-дефолт.

---

## 5.3. SEO (метаполя сущностей, sitemap, robots, отдача меты)

> Расщепляется по флагам: SEO-поля каталога — `catalog`, CMS-страниц — `cms`; `sitemap.xml`/`robots.txt`/
> `settings` — core-always-on, но наполнение sitemap фильтруется по `isModuleEnabled`. ADR (см. §5.3.7).

### 5.3.1. Модель данных

**ALTER products / categories / brands** (миграция `0021`) — slug citext UNIQUE и
`seo_title`/`seo_description` уже есть; добавляем только недостающее:

| Колонка | Тип | Примечание |
|---|---|---|
| `og_title` | `text NULL` | |
| `og_description` | `text NULL` | |
| `og_image_key` | `text NULL` | **ключ** объекта S3/MinIO (как `product_media.storage_key`); URL собирается `getStorage().publicUrl` — домен не хардкодим |
| `canonical_url` | `text NULL` | абсолютный https-URL или path с `/`; NULL = автоген из slug+домена |
| `noindex` | `boolean NOT NULL DEFAULT false` | |

**`cms_pages`** (создаётся в `0022`, 5.1): SEO/sitemap-поля включены в `CREATE TABLE` —
`seo_title/seo_description/og_*/canonical_url/noindex` + `sitemap_priority numeric(2,1) CHECK 0..1` +
`sitemap_changefreq text CHECK (daily/weekly/monthly/...)`.

**`shop_settings.seo`** (создаётся 5.4) — единственный источник домена: `site_url` для
canonical/sitemap/og:url. **Никаких `process.env`-доменов в проде.**

### 5.3.2. Миграции

- **`0021_seo_entity_fields.sql`** — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` для products/categories/
  brands; CHECK через DO-блок; GRANT не нужен (таблицы уже с DML-грантами); `schema_migrations`.
- CMS-SEO-поля — в `0022` (см. §2, не отдельной миграцией). `shop_settings` — `0019`/`0020` (5.4).

### 5.3.3. Server Actions

- `updateShopSeoSettings` — `defineAction({ permission:'settings.manage' })` — UPSERT ключа `seo` в
  `shop_settings`; валидация `site_url` (url или пусто), `title_template` содержит `%s`; revalidate
  `['/sitemap.xml','/robots.txt','/admin/settings/seo']`; audit `settings.seo.update`.
- **Расширение существующих** `ProductUpdate/CategoryUpdate/BrandUpdate` (в `lib/catalog/actions.ts`)
  полями `seoTitle/seoDescription/ogTitle/ogDescription/ogImageKey/canonicalUrl/noindex` — НЕ новый
  action, добавляем поля в Zod + SET в UPDATE; `permission='catalog.write'` (уже есть); revalidate +
  `['/sitemap.xml']`.
- Расширение action редактирования CMS-страницы (5.1) полями SEO + `sitemap_priority/changefreq`;
  `permission='cms.write'`.

### 5.3.4. Storefront API

- **`SeoMetaDto`** добавляется полем `meta` в `ProductDetailDto`/`CategoryDto`/`FullBrandDto`/`PageDto`.
  `meta = { title (seoTitle ?? name, прогнан через title_template), description, canonical (canonical_url
  ?? ${site_url}/<путь>), ogTitle, ogDescription, ogImageUrl (og_image_key → storage.publicUrl ??
  default_og_image_key), noindex, jsonLd (Product/BreadcrumbList/Organization — опц. MVP) }`. Мапперы
  чистые: `seoCtx` (домен/шаблон) передаётся **параметром**, не читается внутри. Наружу — `ogImageUrl`,
  **никогда** `og_image_key`.
  - **Безопасность подстановки в `title_template` (фикс волны 5):** контент-контролируемый текст
    (`seoTitle`/`name`) подставляется в `String.prototype.replace` через **функцию-замену**
    (`template.replace('%s', () => base)`), а НЕ строкой. Строковый аргумент раскрывает доллар-
    последовательности (`$$`→`$`, `$&`→весь матч, `` $` ``/`$'`/`$n`) как спец-паттерны замены и портит
    публичный SEO/OG title. Function-replacer подставляет текст буквально. Остальные поля meta
    (canonical/ogImageUrl/description) собираются конкатенацией/`??`-fallback — `replace` с контентом там
    не используется.
- **`GET /sitemap.xml`** — `app/sitemap.ts` (`MetadataRoute.Sitemap`). Базовые URL (`site_url`) + при
  `isModuleEnabled('catalog')`: active products/categories/brands; при `isModuleEnabled('cms')`:
  published cms_pages. Исключает `noindex`. `revalidate=3600`. Fallback при недоступности БД — только
  корень (паттерн 2x2). Публичный (не под `authorizeStorefront`).
- **`GET /robots.txt`** — `app/robots.ts` (`MetadataRoute.Robots`). `Disallow: /admin,/api` (кроме
  `/api/storefront`); `Sitemap: ${site_url}/sitemap.xml`; `robots_extra` дописывается. **non-prod**
  (`NODE_ENV !== 'production'` ИЛИ `seo.noindex_site=true`) → `Disallow: /` (защита dev/staging).
- `GET /api/storefront/v1/pages/[slug]` (module `cms`) — публичная CMS-страница с `meta` (см. 5.1).

### 5.3.5. Admin UI

- `/admin/settings/seo` — форма (site_name, site_url, title_template, default_description,
  default_og_image, twitter_site, robots_extra, чекбокс `noindex_site` для staging). Guard
  `settings.manage`.
- **`<SeoFieldset>`** — один переиспользуемый компонент для всех 4 сущностей: `seoTitle`, `seoDescription`
  (с превью-сниппетом Google), `ogTitle/ogDescription/ogImage`, `canonicalUrl` (плейсхолдер = автоген),
  чекбокс `noindex`. Встраивается в формы товара/категории/бренда (`catalog.write`) и CMS-страницы
  (`cms.write`) + `sitemap_priority`/`changefreq` для страницы.

### 5.3.6. Тест-кейсы (до кода)

- [migrate] после `0021` в `information_schema.columns` есть `products.noindex`/`categories.canonical_url`/
  `brands.og_image_key`; повторный накат не падает.
- [unit] `buildSeoMeta`: `title` через `title_template`; пустой `seoTitle` → fallback на name;
  пустой `canonical_url` → `${site_url}/product/<slug>`; `og_image_key` → URL через инъецированный
  `storage.publicUrl`; оба пусты → null. Никакого хардкода CDN-домена.
- [unit] **`canonicalUrl`-валидация (Zod + `buildSeoMeta`):** абсолютный `https://…` принимается как есть;
  относительный путь с ведущим `/` → достраивается до `${site_url}<path>`; мусор отвергается на уровне
  Zod-схемы сущности — `javascript:…`, `http://` без host, относительный без ведущего `/`, пробелы →
  `validation`-ошибка (не доходит до рендера). Защита от open-redirect/XSS в `<link rel=canonical>`.
- [unit] `buildSitemapEntries(modules, rows)`: catalog выкл → нет товаров/категорий/брендов; cms выкл →
  нет страниц; `noindex`/черновики исключены; `site_url` из настроек.
- [unit] `buildRobots(env, settings)`: prod → `Allow /` + `Disallow /admin,/api`; non-prod ИЛИ
  `noindex_site` → `Disallow /`; строка `Sitemap` с доменом из настроек.
- [unit] DTO: мапперы включают `meta`; `og_image_key` НЕ утекает наружу.
- [integration] `/sitemap.xml` фильтруется по `ADMIK_MODULES`; Content-Type `application/xml`.
  `/robots.txt` Content-Type `text/plain`, домен из `shop_settings` (мок), в `NODE_ENV=test` → `Disallow /`.
- [unit] `updateShopSeoSettings`: без права → `forbidden`; `title_template` без `%s` → `validation`;
  успех → audit + revalidate `['/sitemap.xml','/robots.txt']`.

### 5.3.7. Инварианты 5.3

- SEO-поля живут НА сущностях, отдельной `page_metadata` НЕ заводим (избегаем рассинхрона
  homepage_sections/page_sections из 2x2; у Admik сущности уже самодостаточны → без лишних JOIN).
- Единственный источник домена — `shop_settings.seo.site_url` (env только bootstrap-fallback).
- og:image хранится КЛЮЧОМ S3, URL собирается рантайм-слоем storage.
- sitemap/robots — core-always-on, но содержимое строго фильтруется по `isModuleEnabled` и
  опубликованности (карта не ссылается на URL отключённых модулей).
- DTO-изоляция: наружу `ogImageUrl`, не ключ; `noindex`/`canonical` через мапперы.

---

## 5.1. CMS-страницы (контент-механика `page_sections` / JSONB)

> Модуль `cms` (флаг, права `cms.read`/`cms.write`, пункт меню `/admin/cms` — уже заведены). Каждый
> admin-handler в начале делает `assertCmsEnabled()` (по образцу `assertCatalogEnabled`); Storefront-роуты
> передают `options.module='cms'` в `runStorefront` (дефолт там `'catalog'` — **обязательно** переопределить).
> ADR-012.

### 5.1.1. Модель данных

**`cms_pages`** (миграция `0022`):

| Колонка | Тип | Примечание |
|---|---|---|
| `id` | `uuid PK DEFAULT gen_random_uuid()` | |
| `slug` | `citext NOT NULL` | UNIQUE INDEX `cms_pages_slug_uniq` |
| `title` | `text NOT NULL` | |
| `status` | `text NOT NULL DEFAULT 'draft' CHECK IN ('draft','published','archived')` | триада как у products (закрывает gap «нет draft» из 2x2) |
| `published_at` | `timestamptz NULL` | ставится при первом переходе в published |
| `seo_title`/`seo_description`/`og_image_url`/`canonical_url` | `text NULL` | SEO (5.3) |
| `noindex` | `boolean NOT NULL DEFAULT false` | |
| `sitemap_priority` | `numeric(2,1) NULL CHECK 0..1` | (5.3) |
| `sitemap_changefreq` | `text NULL CHECK (daily/weekly/...)` | (5.3) |
| `created_by`/`updated_by` | `uuid NULL REFERENCES users(id) ON DELETE SET NULL` | |
| `created_at`/`updated_at` | `timestamptz NOT NULL DEFAULT now()` | |

Индексы: `UNIQUE(slug)`, `INDEX(status)`, `INDEX(published_at DESC)`.

**`cms_page_sections`** (миграция `0023`) — ядро паттерна 2x2 (`010_page_sections.sql`), но
**нормализовано** как дочерняя таблица (FK CASCADE), а не плоская `(page_path,section_key)`:

| Колонка | Тип | Примечание |
|---|---|---|
| `id` | `uuid PK` | |
| `page_id` | `uuid NOT NULL REFERENCES cms_pages(id) ON DELETE CASCADE` | целостность + атомарный reorder |
| `section_key` | `text NOT NULL` | UNIQUE(page_id, section_key) |
| `type` | `text NOT NULL CHECK IN ('hero','text','banner','products_grid','faq','cta','gallery')` | дискриминатор Zod-валидации |
| `content` | `jsonb NOT NULL DEFAULT '{}'` | CHECK `pg_column_size(content) < 65536` (закрывает gap «нет maxsize») |
| `display_order` | `integer NOT NULL DEFAULT 0` | INDEX(page_id, display_order) |
| `enabled` | `boolean NOT NULL DEFAULT true` | |
| `created_at`/`updated_at` | `timestamptz` | |

**Контракт `content` по `type` (дискриминированный union `CmsSectionContentSchema`).** Каждая секция
имеет строго типизированный `content`; неизвестные поля отбрасываются Zod. Опорные контракты:

| `type` | Поля `content` | Примечание |
|---|---|---|
| `hero` | `{ title, subtitle?, html? (rich-text), imageKey?, ctaLabel?, ctaHref? }` | `html` санитизируется на сервере; `imageKey` — ключ S3 (URL собирает storage) |
| `text` | `{ html (rich-text) }` | санитизируется на сервере |
| `banner` | `{ imageKey, href?, alt? }` | |
| `products_grid` | `{ mode:'slugs'\|'category'\|'brand', slugs?:string[], categorySlug?, brandSlug?, limit:int (1..48, дефолт 12), title? }` | **только идентификаторы-фильтры**, без FK на каталог; витрина дотягивает товары через существующий `/products`. `mode='slugs'` ⇒ `slugs` непуст; `mode='category'` ⇒ `categorySlug`; `mode='brand'` ⇒ `brandSlug` (refine в схеме) |
| `faq` | `{ items:[{ q, a (rich-text, санитизируется) }] }` | |
| `cta` | `{ title, html?, buttonLabel, buttonHref }` | |
| `gallery` | `{ images:[{ imageKey, alt? }] }` | |

> **Изоляция `products_grid` от каталога (инвариант).** Секция хранит **только slug/идентификаторы**,
> не FK и не снимок товаров. Несуществующий/удалённый `slug`/`categorySlug` **не ломает** ни валидацию
> секции (Zod проверяет лишь формат строки), ни рендер витрины: `/products` просто вернёт меньше позиций
> (отсутствующие тихо отфильтровываются). Так модули `cms` и `catalog` остаются независимыми.

**`cms_page_revisions`** (опц., в `0023` или отдельно) — `page_id` FK CASCADE, `revision int`,
`snapshot jsonb` (полный JSON страницы+секции на момент публикации), `created_by`, `created_at`,
UNIQUE(page_id, revision). Закрывает gap «версионирование»; пишется транзакционно при `publishCmsPage`.
**На MVP можно отложить.**

### 5.1.2. Миграции

- **`0022_cms_pages.sql`** — `CREATE TABLE IF NOT EXISTS cms_pages` (SEO/sitemap-поля включены);
  `CREATE UNIQUE INDEX IF NOT EXISTS cms_pages_slug_uniq`; INDEX status/published_at; CHECK статуса
  внутри CREATE (если ALTER'ом — DO-блок); `GRANT ... TO admik_app`; `schema_migrations`. Опц.
  идемпотентный seed демо-страницы (`slug='about'`, `ON CONFLICT DO NOTHING`).
- **`0023_cms_page_sections.sql`** — `CREATE TABLE IF NOT EXISTS cms_page_sections`; UNIQUE(page_id,
  section_key); INDEX(page_id, display_order); CHECK размера content через DO-блок + `pg_constraint`;
  GRANT; `schema_migrations`. Опц. `cms_page_revisions` здесь же.

### 5.1.3. Server Actions (`lib/cms/actions.ts`)

Все через `defineAction({ permission:'cms.write' })`; каждый handler: `assertCmsEnabled()` (бросок
`CmsError('module_disabled')`) → sql-мутация (параметризовано) → revalidate → `{ result, audit, revalidate }`.

- `createCmsPage` — `slug` опц. → `slugify(title)`; `insertWithUniqueSlug` (ретрай на 23505, паттерн
  `catalog/actions.ts`); audit `cms.page.create`; revalidate `['/admin/cms','/admin/cms/'+id]`.
- `updateCmsPage` — partial поля + SEO; `updated_by`/`updated_at`; audit `cms.page.update` (before/after).
- **Публикация — ТОЛЬКО через `publishCmsPage` (фикс волны 5, вариант Б).** `CmsPageCreateSchema`/
  `CmsPageUpdateSchema` принимают `status` лишь из `cmsPageEditableStatusSchema = enum(['draft',
  'archived'])`; `'published'` отвергается схемой. Иначе `create`/`update` делали страницу публичной
  обычным UPDATE — с `published_at=NULL` и БЕЗ ревизии (нарушение инварианта 0022/0023; `ORDER BY
  published_at DESC NULLS LAST` ставил бы её в конец навигации). `cmsPageStatusSchema` (полная триада)
  сохранена для `CmsPageListFilterSchema`. В `PageForm.tsx` убран `<option value="published">` (для уже
  опубликованной страницы — `disabled`-вариант, чтобы select не сбрасывался); `save()` не отправляет
  `status='published'` (публикация/снятие — выделенными кнопками). Архивирование/снятие через
  `'archived'`/`'draft'` безопасно — `published_at` остаётся исторической меткой.
- `deleteCmsPage` — DELETE (CASCADE снимает секции/ревизии); audit `cms.page.delete`; Storefront-инвалидация slug.
- `publishCmsPage`/`unpublishCmsPage` — `status='published'`, `published_at = COALESCE(published_at,
  now())`; транзакционно (`sql.begin`, образец `createOrder`) пишет снимок в `cms_page_revisions`
  (`revision = max+1`); audit `cms.page.publish`/`unpublish`.
- `upsertCmsSection` — **КЛЮЧЕВОЕ:** `content` валидируется **дискриминированным union**
  `CmsSectionContentSchema` по полю `type` ВНУТРИ handler + **серверная санитизация** rich-text
  (`sanitizeHtml` в `lib/cms/sanitize.ts` — чистая функция, whitelist тегов/атрибутов, удаление
  `script`/`on*`/`javascript:`) для `type:'text'/'hero'`. `ON CONFLICT (page_id, section_key) DO UPDATE`.
  audit `cms.section.upsert`.
- `reorderCmsSections` — `{ pageId, order:[{id, displayOrder}] }`; транзакционный UPDATE (`sql.begin`).
- `setCmsSectionEnabled`/`deleteCmsSection` — переключение/удаление секции.

**Репозиторий** (`lib/cms/repository.ts`, ТОЛЬКО SELECT): `listCmsPages(filter)` (поиск/статус/
пагинация как `listProducts`), `getCmsPageById(id)` (страница+секции по `display_order`),
`getPublishedCmsPageBySlug(slug)` (для витрины: `status='published'`). Чистые мапперы
`mapCmsPage`/`mapCmsSection` экспортируются для юнит-тестов (образец `mapProduct`/`mapCategory`).

**Slug/схемы:** `lib/cms/slug.ts` — **переиспользовать** (НЕ дублировать) `slugify`/`isValidSlug`/
`uniquifySlug` из `lib/catalog/slug.ts` (импорт или вынос в общий `lib/slug`). `lib/cms/schemas.ts` —
дискриминированный `CmsSectionContentSchema = z.discriminatedUnion('type', [...])`.

### 5.1.4. Storefront API

- **`GET /api/storefront/v1/pages/[slug]`** — структура копирует `products/[slug]/route.ts`:
  `dynamic='force-dynamic'`; `runStorefront(req, handler, { module:'cms' })` (**обязательно** `cms`);
  `getPublishedCmsPageBySlug(slug)` → null ⇒ `jsonError('not_found')`; иначе
  `jsonData(toPublicPageDto(page), {}, cors)`; OPTIONS → `handlePreflight`.
- **`GET /api/storefront/v1/pages`** — список опубликованных (slug+title+seo для навигации витрины),
  `module:'cms'`.
- `lib/storefront/cms-dto.ts` — `toPublicPageDto` (образец `toProductDetailDto`): отдаёт ТОЛЬКО
  `slug/title/seoTitle/seoDescription/ogImageUrl/canonicalUrl/noindex` + `sections:[{type,content}]`
  с `enabled=true`, по `display_order`. СКРЫВАЕТ: id, status, created_by/updated_by, timestamps,
  revisions, draft-страницы. Для `products_grid` секция содержит slug-фильтр товаров — витрина
  дотягивает через существующий `/products` (без FK CMS→catalog).

### 5.1.5. Admin UI (`/admin/cms/*`)

- `/admin/cms` — список (slug/title/status/published_at, поиск+пагинация как `/admin/catalog`).
  Server Component через `listCmsPages`. Guard `cms.read` + `isModuleEnabled('cms')`. Пункт меню уже в nav.
- `/admin/cms/new`, `/admin/cms/[id]` — форма страницы: title, slug (авто из title, редактируемо), SEO
  (`<SeoFieldset>` из 5.3), статус; кнопки Publish/Unpublish.
- **Редактор секций** (client): drag-and-drop reorder (`reorderCmsSections`), переключатель `enabled`,
  добавление секции по `type`; для каждого `type` — форма по `CmsSectionContentSchema` (один редактор,
  выбор полей по `type` — паттерн `PAGE_SECTION_SCHEMAS` из 2x2).
- **Tiptap** (`@tiptap/react` — новая зависимость, в `package.json` нет) для `type:'text'/'hero'`:
  на клиенте редактирует → HTML/JSON; СЕРВЕР санитизирует при `upsertCmsSection` (доверие клиенту
  запрещено — анти-tamper, как серверный расчёт цен). Санитайзер — серверный (`sanitize-html`/
  `isomorphic-dompurify`).

### 5.1.6. Тест-кейсы (до кода)

- `db/cms-migrations.test.ts` — `0022`/`0023`(/ревизии) существуют, нумерация сплошная от `0018`,
  все CREATE с `IF NOT EXISTS`, GRANT `TO admik_app`, `schema_migrations ... ON CONFLICT DO NOTHING`,
  CHECK идемпотентно.
- `cms/slug.test.ts` — slug-валидатор использует те же правила (переиспользование).
- `cms/schemas.test.ts` — дискриминированный union: валидный hero/text/banner/products_grid/faq
  проходит; неверный `type` отвергается; чужие поля для типа отвергаются. **`products_grid`-контракт:**
  `mode='slugs'` с пустым `slugs` → ошибка; `mode='category'` без `categorySlug` → ошибка;
  `limit` вне 1..48 → ошибка; дефолт `limit=12`; лишние поля отброшены. Несуществующий slug на уровне
  схемы валиден (формат-строка) — отсутствие товара обрабатывается витриной, не валидатором.
- `cms/sanitize.test.ts` — `<script>`/`on*`/`javascript:` вырезаются; разрешённые теги (p/strong/em/a/
  ul/li/h2..) остаются; href нормализуется. (Защита от хранимого XSS.)
- `cms/actions-guard.test.ts` — без юзера → `unauthorized`; только `cms.read` → `forbidden`; `cms.write`
  → handler вызван; невалидный slug → `validation` + fieldErrors (deps замоканы).
- `cms/repository.test.ts` — мапперы `mapCmsPage`/`mapCmsSection` (snake→camel, дефолты).
- `storefront/cms-dto.test.ts` — `toPublicPageDto` скрывает id/status/timestamps/revisions; только
  `enabled`-секции по `display_order`; draft не доходит до DTO.
- `storefront/cms-routes.integration.test.ts` (skipIf без DATABASE_URL) — module cms выкл → 404
  `module_disabled`; published → 200 + DTO; draft/archived → 404; auth/CORS как у остальных.
- `cms/integration.test.ts` (skipIf) — двойной накат миграций без ошибок; `publishCmsPage` пишет
  ревизию транзакционно + `published_at`; `upsertCmsSection` ON CONFLICT обновляет; reorder атомарен;
  CASCADE удаляет секции; CHECK размера content отвергает гигантский блок.

### 5.1.7. Инварианты 5.1

- Нормализованные секции (FK CASCADE) вместо плоской таблицы 2x2 (целостность, атомарный reorder).
- Дискриминированная Zod-валидация `content` по `type` как контракт секций.
- **Серверная санитизация rich-text — обязательный анти-XSS инвариант** (доверие клиенту запрещено,
  аналог анти-tamper расчёта цен).
- Триада статусов draft/published/archived вместо boolean `enabled` из 2x2.
- Без `tenant_id`/`website_id`. Slug-логика переиспользуется из каталога, не дублируется.
- `products_grid` хранит slug-фильтр, не FK на товары (модули `cms` и `catalog` независимы).

---

## 5.2. Промо-механики «N по M» (движок акций поверх задела заказов)

> Модуль `orders` (НЕ `cms`): это денежный движок корзины/заказа. Существующий CRUD промокодов уже за
> `assertOrdersEnabled()` + `orders.write`; меню `/admin/promo` под orders. Anti-tamper (ADR-010)
> сохраняется буквально. ADR-014.

### 5.2.1. Модель данных

**ALTER `promo_codes`** (миграция `0024`, аддитивно к `0014`):

| Колонка | Назначение |
|---|---|
| `apply_scope text NOT NULL DEFAULT 'cart' CHECK IN ('cart','category','brand','set')` | на что распространяется скидка/механика |
| `priority integer NOT NULL DEFAULT 100 CHECK >= 0` | порядок применения (меньше = раньше); tie-break по `code` |
| `stackable boolean NOT NULL DEFAULT false` | комбинируемость (false → эксклюзивна) |
| `min_qty integer CHECK (NULL OR > 0)` | qty-порог (дополняет `min_order_total`) |
| `gift_product_id uuid REFERENCES products(id) ON DELETE SET NULL` | **задел** товар-подарок (исполнение отложено) |
| `gift_variant_id uuid REFERENCES product_variants(id) ON DELETE SET NULL` | задел |
| `gift_qty integer CHECK (NULL OR > 0)` | задел |
| CHECK `promo_bogo_pair_chk` (DO-блок) | `kind='bogo'` ⇒ `bogo_buy_qty` и `bogo_pay_qty` не NULL и `bogo_pay_qty < bogo_buy_qty` |

**`promo_targets`** (NEW, `0024`) — список таргетов акции (к каким товарам применяется scope/N×M-группировка):

| Колонка | Примечание |
|---|---|
| `id uuid PK` | |
| `promo_code_id uuid NOT NULL REFERENCES promo_codes(id) ON DELETE CASCADE` | |
| `target_type text NOT NULL CHECK IN ('category','brand','product','variant')` | |
| `category_id`/`brand_id`/`product_id`/`variant_id uuid` FK ON DELETE CASCADE | ровно одна заполнена (CHECK DO-блок) |
| `created_at timestamptz` | UNIQUE по `(promo_code_id, target_type, COALESCE(...))`; INDEX(promo_code_id) |

GRANT `SELECT,INSERT,UPDATE,DELETE ON promo_targets TO admik_app`.

> **Инвариант scope↔targets (волна 5, баг B).** Для `apply_scope ∈ {category,brand,set}` нужна ≥1
> строка `promo_targets` (требует `refinePromo`, `lib/orders/schemas.ts`). Но FK таргетов на каталог —
> `ON DELETE CASCADE`, поэтому жёсткое удаление товара/варианта/категории/бренда
> (`deleteProduct`/`deleteVariant`/`deleteCategory`/`deleteBrand`) могло снести **последнюю** цель и
> оставить scoped-промокод активным с пустым набором — `scopeDiscountMinor=0`, скидка молча не
> применялась («мёртвая» акция). Миграция **`0029_promo_scope_deactivate_on_empty`** добавляет
> `AFTER DELETE`-триггер на `promo_targets`: если у затронутого промокода `apply_scope ∈ {category,brand,set}`
> и целей не осталось — в той же транзакции переводит его в `is_active=false` (промокод не удаляется —
> история/аудит сохраняются). Функция `SECURITY DEFINER` + фиксированный `search_path=public` (UPDATE
> срабатывает независимо от инициатора каскада). Миграция идемпотентна
> (`CREATE OR REPLACE FUNCTION`; `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`) и аддитивна.

**`promo_redemptions`** (БЕЗ изменений, `0015`): вся скидка акции по заказу — одна строка
`discount_applied` (как сейчас для percent/fixed). **`order_items` БЕЗ изменений** — N×M-скидка идёт
агрегатом в `order.discount_total`, позиции остаются по своей цене (anti-tamper снимок). Помарочная
разбивка чека «подарок» — будущая отдельная миграция.

> **Инвариант денег (критично для совместимости).** `bogoDiscountMinor`/`scopeDiscountMinor` возвращают
> **копейки** (`int`). И `promo_redemptions.discount_applied`, и `orders.discount_total` — `numeric(14,2)`
> в **рублях** (схема Этапа 3). Поэтому при записи N×M-скидки в эти поля значение конвертируется
> `fromMinor(discountMinor)` → рубли — ровно как существующая ветка `percent`/`fixed`. Запрещено писать
> копейки в `numeric(14,2)`-поля напрямую. Чистый pricing-слой остаётся в копейках; конвертация — на
> границе репозитория (`createOrder`).

> **Инвариант `min_qty` по scope (волна 7, баг A).** `validatePromo` сверяет `min_qty` с кол-вом единиц
> **В SCOPE** промокода, а не со всей корзиной. Репозиторий (`quoteCart`/`createOrder`) считает это число
> единым хелпером `scopedQty(lines, applyScope, scopeTargets)` (та же разметка `lineInScope`, что и
> фактический расчёт скидки `promoScopeDiscountMinor`). Раньше валидация брала Σqty всей корзины, а скидка —
> только scoped-кол-во, из-за чего scoped-промокод (`apply_scope ∈ {category,brand,set}`) проходил
> валидацию, но давал **нулевую скидку** и зря потреблял `used_count`/слот `per_customer_limit`. Для
> `apply_scope='cart'` `scopedQty == Σqty` — поведение не изменилось.
>
> **Защита целостности лимита (волна 7, баг A, доп.).** `createOrder` инкрементирует `used_count` и пишет
> `promo_redemptions` ТОЛЬКО при реальном эффекте промокода (`promoHadEffect = quote.promo.applied ||
> giftLine != null` — денежная скидка / применённая бесплатная доставка / прикреплённый подарок).
> Промокод с нулевым эффектом не «съедает» слот лимита. Сам код по-прежнему пишется в `orders.promo_code`
> (факт ввода), но без потребления лимита.

### 5.2.2. Миграции

- **`0024_promo_mechanics_nxm.sql`** — `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` для promo_codes +
  CHECK через DO-блок + `pg_constraint`; `CREATE TABLE IF NOT EXISTS promo_targets` с FK/UNIQUE/INDEX/
  CHECK; GRANT; `schema_migrations`. Без backfill (DEFAULT покрывают существующие строки).

### 5.2.3. Server Actions (расширение существующих)

- Расширить `lib/orders/schemas.ts`: `applyScope`, `priority`, `stackable`, `minQty`, `giftProductId/
  giftVariantId/giftQty`, `targets[]`. Расширить `refinePromo`: `kind='bogo'` ⇒ `bogoBuyQty/bogoPayQty`
  обязательны и `payQty<buyQty`; `applyScope IN (category/brand/set)` ⇒ `targets` непуст.
- `createPromoCode`/`updatePromoCode` (`lib/orders/actions.ts`, тот же `defineAction(orders.write)`):
  внутри `sql.begin(tx)` — INSERT/UPDATE promo_codes + bulk INSERT (или DELETE+INSERT) promo_targets;
  audit `promo.create`/`promo.update` (before/after). `assertOrdersEnabled()`.
- `deactivatePromoCode`/`deletePromoCode`/`getPromoCode` — без изменений (CASCADE снимает таргеты; для
  scoped-акций утрата последней цели через каскад каталога гасит промокод триггером `0029`, см. выше).
- Новый repository-хелпер `getPromoWithTargets(code, customerEmail?)` — расширяет `getPromoWithCounts`:
  догружает promo_targets + резолвит множества `productId`/`variantId` под акцию (категории через
  `product_categories`, бренды через `products.brand_id`). Возвращается в `quoteCart`/`createOrder`.

### 5.2.4. Storefront API

- `POST /api/storefront/v1/cart/quote` (СУЩЕСТВУЕТ) — контракт запроса не меняется; в ответе
  `quote.promo.discount` теперь корректно отражает N×M/scope-скидку (раньше bogo→0). Витрина шлёт только
  `items+promoCode+delivery`; цену/скидку считает сервер.
- `POST /api/storefront/v1/orders` (СУЩЕСТВУЕТ) — `createOrder` применяет ту же N×M-логику в транзакции
  (ре-валидация), `discount_total`/`grand_total` серверные.
- **НОВЫЙ (опц., read-only)** `GET /api/storefront/v1/promotions` — публичный список активных акций для
  бейджей «3 по 2». `runStorefront(req, handler, { module:'orders' })`. `toPublicPromotionDto` отдаёт
  ТОЛЬКО `publicLabel/kind/applyScope/bogoBuyQty/bogoPayQty/targetCategorySlugs/targetBrandSlugs/
  activeFrom/activeTo`; СКРЫВАЕТ `usageLimit/usedCount/perCustomerLimit/comment/id`. Можно отложить.

### 5.2.5. Admin UI (расширение `/admin/promo/*`)

- Форма промокода: `applyScope` (radio: вся корзина/категория/бренд/набор); при scope≠cart —
  мультиселект таргетов (категории/бренды/товары-поиск); для `kind='bogo'` — `bogoBuyQty`/`bogoPayQty`
  («купи N / плати M», hint «3 по 2»); `priority` (number); `stackable` (checkbox); `minQty`; блок
  «Подарок» (gift_*) — **скрыт за фичефлагом UI** до реализации gift-kind.
- Список `/admin/promo` — колонки «Тип» («N по M 3→2», «−10% на бренд X»), «Scope», «Приоритет», бейдж
  «эксклюзивная/суммируемая». Без новых nav-пунктов и новых прав.
- nice-to-have: мини-калькулятор в форме (вызов `quoteCart` с тестовой корзиной — демонстрирует anti-tamper).

### 5.2.6. Тест-кейсы (до кода)

- `tests/orders/pricing-bogo.test.ts` (НОВЫЙ, чистый) — матрица `bogoDiscountMinor`: «3 по 2» 3×100 →
  бесплатна 1 → discount=100; 6 шт → 2 бесплатно; 5 шт «3 по 2» → 1 бесплатно (floor(5/3)); разные цены
  [100,200,300] «3 по 2» → бесплатна 100 (самая дешёвая в группе); «купи 2 плати 1» 4 шт → 2 бесплатно;
  qty<buyQty → 0; discount ≤ itemsTotal; grandTotal ≥ 0; копейки без float (33.33).
- `tests/orders/pricing-scope.test.ts` (НОВЫЙ) — scope='category'/'brand': % только к подмножеству
  линий в target; вне scope не дисконтируется; пустое пересечение → 0; min_qty соблюдён.
- `tests/orders/promo-combine.test.ts` (НОВЫЙ) — приоритет/комбинируемость: две stackable суммируются
  по priority; не-stackable эксклюзивна; итог детерминирован; сумма ≤ itemsTotal.
- `tests/orders/promo.test.ts` (РАСШИРИТЬ) — `validatePromo` для bogo; reject если bogo без пары;
  below_min_total с учётом min_qty.
- `tests/orders/schemas.test.ts` (РАСШИРИТЬ) — `refinePromo`: bogo без пары → ошибка; payQty≥buyQty →
  ошибка; scope≠cart без targets → ошибка.
- `tests/orders/repository.test.ts` / `tests/storefront/orders.test.ts` (РАСШИРИТЬ, **`describe.skipIf(!process.env.DATABASE_URL)`**)
  — `quoteCart` с bogo возвращает корректный `quote.promo.discount`; `createOrder` пишет реальный
  `discount_applied` (в рублях через `fromMinor`), increment `used_count` атомарно; идемпотентность;
  ре-валидация anti-tamper.
- `tests/db/promo-scope-deactivate-migration.test.ts` (NEW, волна 5, баг B) — юнит: `0029` существует,
  идемпотентна (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`/`CREATE TRIGGER`), триггер
  `AFTER DELETE FOR EACH ROW ON promo_targets`, `SECURITY DEFINER` + `search_path=public`; интеграция
  (`describe.skipIf(!DATABASE_URL)`) — каскадное удаление единственной цели scoped-промокода →
  `is_active=false`; при нескольких целях удаление одной не гасит; `apply_scope='cart'` триггер не трогает.

> **Граница «с БД / без БД» для 5.2 (DoD §1.4).** Unit-слой — чистый и **обязан быть зелёным без БД**:
> `pricing-bogo`, `pricing-scope`, `promo-combine`, `schemas`/`promo` (refine) не касаются sql. Только
> `repository`/`storefront/orders` (интеграция quote→order, запись redemption) требуют живой БД и
> поэтому обёрнуты в `describe.skipIf(!process.env.DATABASE_URL)` — как уже сделано для CMS
> (`storefront/cms-routes.integration`) и в Этапах 3–4. В dev/CI без `DATABASE_URL` эти кейсы skipped, не failed.
- `tests/db/orders-migrations.test.ts` (РАСШИРИТЬ) — `0024` идемпотентна, `promo_targets` создана,
  новые колонки/CHECK на месте, GRANT.

### 5.2.7. Инварианты 5.2

- Расширяем `promo_codes` одним `kind`-полем + `promo_targets`, не плодим таблицу-на-тип акции.
- Алгоритм N×M детерминирован: `floor(qty/buyQty)` групп, в каждой бесплатны `buyQty−payQty` **самых
  дешёвых** единиц; группировка в пределах scope. Скидка = `freeUnits × unitPrice` (целые копейки, без %).
- **Комбинируемость (MVP-правило):** ≤1 не-stackable (выбор по priority asc, tie-break code) + N
  stackable от остатка; суммарный discount жёстко `clamp ≤ itemsTotal`, `≥ 0`. Один `promoCode` на заказ.
- Anti-tamper: принадлежность линии scope определяет СЕРВЕР из каталога (не из тела запроса); pricing
  остаётся чистым (принимает уже размеченные линии). Деньги в копейках.
- Аддитивность: ни одной правки в percent/fixed/free_delivery; новые сигнатуры рядом со старыми
  (`PricedLine` дополняется опц. `productId?/variantId?/categoryIds?/brandId?` — старые тесты зелёные).
- gift-позиция — задел (колонки + UI за флагом), исполнение отложено.

---

## 6. Влияние на витрины-потребители (примеры профилей конфигурации)

| Профиль магазина | CMS (5.1) | Промо N×M (5.2) | SEO (5.3) | Настройки (5.4) |
|---|---|---|---|---|
| **«Минимальный»** (без брендов) | модуль `cms` может быть **выключен** — работает как headless-каталог без CMS-страниц | акции опциональны | sitemap без раздела брендов (пустая `brands`), products/categories — есть | брендинг через `shop_settings` |
| **«С акциями»** | CMS-страницы (промо-лендинги, о компании) включены | «3 по 2» / scope-скидки на категории/бренды — ключевой сценарий | sitemap с брендами, акции-бейджи | свои `module_overrides` (catalog+orders+cms), порог бесплатной доставки |

- Состав модулей у каждой витрины задаётся `ADMIK_MODULES` (env) и переопределяется через
  `/admin/settings/modules` (5.4) — **без правки кода**.
- Все магазино-специфичные значения (название, домен, валюта, пороги, набор акций, контент) — **данные**
  в `shop_settings`/`cms_pages`/`promo_codes`, не хардкод.

---

## 7. Инварианты этапа (сквозные)

1. **Флаги модулей.** CMS — за `cms`; промо N×M — за `orders`; sitemap/robots/settings — core-always-on,
   но наполнение фильтруется по `isModuleEnabled`. Storefront-роуты CMS — `runStorefront(..., {module:'cms'})`
   (не дефолтный `catalog`).
2. **Идемпотентность.** Миграции `0019`–`0024`: `CREATE/ADD COLUMN IF NOT EXISTS`, CHECK через DO-блок
   + `pg_constraint`, seed `ON CONFLICT DO NOTHING`, запись в `schema_migrations`. Сплошная нумерация.
3. **Без хардкодов магазина.** Домен/название/валюта/пороги/контент — данные БД (`shop_settings` env⊕БД).
4. **Деньги: расчёт — в копейках, хранение — `numeric(14,2)` в рублях (как в Этапе 3).** Весь
   арифметический слой (`pricing.ts`, `bogoDiscountMinor`/`scopeDiscountMinor`, пороги настроек)
   оперирует целыми копейками (`toMinor`/`fromMinor`), без float. **При персисте** в существующие
   `numeric(14,2)`-поля БД (`orders.discount_total`/`items_total`, `promo_redemptions.discount_applied`,
   `promo_codes.value`/`min_order_total`) копейки конвертируются обратно в рубли через `fromMinor` —
   чтобы N×M-скидка ложилась в ту же шкалу, что и существующие `percent`/`fixed` (не сломать совместимость).
   N×M discount `clamp ≤ itemsTotal`, `≥ 0`. **Уточнение по `shop_settings`:** денежные поля в JSONB
   `value` (`delivery.freeDeliveryThreshold`) хранятся **в копейках** (`int`) — это новый JSONB-слой,
   не legacy `numeric`-схема; при отдаче в DTO/расчёт остаются копейками, конвертация в рубли — только
   на границе записи в legacy `numeric`-таблицы.
5. **Anti-tamper (ADR-010).** Скидки/итоги — на сервере; rich-text санитизируется на сервере;
   принадлежность scope — серверная.
6. **Переиспользование.** Все мутации — через `defineAction` (гвард→Zod→БД→revalidate→audit); slug —
   из `lib/catalog/slug`; DTO-изоляция по образцу `toProductDetailDto`; права `cms.*`/`orders.*`/
   `settings.manage`/`catalog.write` — существующие (новых не вводим).
7. **DTO-изоляция.** Наружу — только публичные поля (`ogImageUrl`, не ключ S3; нет `bankDetails`,
   `created_by`, draft-страниц, internal-промо-полей).
8. **Без `tenant_id`/`website_id`** (ADR-003) — расхождение с рекомендацией 2x2 осознанно.

---

## 8. Декомпозиция Этапа 5 на пакеты (волны, «сначала тесты»)

Порядок волн: **W1 (настройки) → W2 (SEO) → W3 (CMS) → W4 (промо)**. Внутри волны границы владения
файлами не пересекаются. Каждый пакет — отдельный коммит. Номера миграций закреплены в §2.

### Волна W1 — Настройки магазина (фундамент DB-driven)

**Пакет 5.D-1 — Миграции + слой merge (фундамент, блокирует 5.D-2/5.3/каркас)**
- Файлы: `db/migrations/0019_shop_settings.sql`, `0020_shop_settings_seed.sql`; `lib/config/settings.ts`
  (`mergeSettings`/`getEffectiveSettings`/`getEffectiveModules`/`invalidateSettingsCache`);
  `lib/settings/schemas.ts`, `lib/settings/repository.ts`.
- Тесты (до кода): `mergeSettings` (env/частичный/полный/лишние поля), `getEffectiveModules` (матрица),
  кеш-мемо/инвалидация, миграции идемпотентны.
- Критерий: эффективные настройки/модули вычисляются; миграции применяются двойным накатом.
- Зависимости: нет.

**Пакет 5.D-2 — Actions + Storefront `/settings` + Admin UI + каркас-консьюмеры**
- Файлы: `lib/settings/actions.ts`; `app/api/storefront/v1/settings/route.ts`, `lib/storefront/settings-dto.ts`;
  `app/admin/(panel)/settings/page.tsx` + `_components/*`; правка `lib/admin/nav.ts` (пункт «Настройки»),
  `app/admin/(panel)/layout.tsx`, `app/admin/login/page.tsx` (брендинг env→эффективные);
  правка `lib/orders/repository.ts` и `products` (источник `newProductDays`/`freeDeliveryThreshold`).
- Тесты: actions (forbidden/validation/audit/revalidate), `toPublicSettingsDto` (нет приватных полей),
  деньги round-trip, API core-always-on, обратная совместимость репозиториев при пустой БД.
- Критерий: настройки правятся через UI; витрина получает `/settings`; оверрайд модулей меняет меню.
- Зависимости: 5.D-1.

### Волна W2 — SEO

**Пакет 5.S-1 — SEO-поля сущностей + билдеры + sitemap/robots**
- Файлы: `db/migrations/0021_seo_entity_fields.sql`; `lib/seo/meta.ts` (`buildSeoMeta`/`buildJsonLd`),
  `lib/seo/sitemap.ts` (`buildSitemapEntries`), `lib/seo/robots.ts` (`buildRobots`);
  `app/sitemap.ts`, `app/robots.ts`; правка `lib/storefront/dto.ts` (`SeoMetaDto` в DTO);
  расширение `lib/catalog/schemas.ts`/`actions.ts` (SEO-поля) + `<SeoFieldset>`; `updateShopSeoSettings`
  + `/admin/settings/seo`.
- Тесты: миграция идемпотентна; `buildSeoMeta`/`buildSitemapEntries`/`buildRobots` (фильтрация по
  модулям, non-prod Disallow, домен из настроек); DTO не утекает `og_image_key`; интеграция sitemap/robots.
- Критерий: sitemap фильтруется по модулям и noindex; robots берёт домен из `shop_settings`.
- Зависимости: 5.D-1 (`shop_settings.seo`).

### Волна W3 — CMS

**Пакет 5.C-1 — Миграции + домен (фундамент, блокирует 5.C-2/5.C-3)**
- Файлы: `db/migrations/0022_cms_pages.sql`, `0023_cms_page_sections.sql`; `lib/cms/types.ts`,
  `lib/cms/schemas.ts` (дискриминированный union), `lib/cms/slug.ts` (переиспользование),
  `lib/cms/sanitize.ts`, `lib/cms/repository.ts`, `lib/cms/errors.ts`.
- Тесты (до кода): `cms-migrations`, `cms/slug`, `cms/schemas`, `cms/sanitize`, `cms/repository`.
- Критерий: миграции идемпотентны; схемы/санитайзер/мапперы покрыты.
- Зависимости: нет (но SEO-поля cms_pages согласованы с 5.S-1 — оба читают `0022`).

**Пакет 5.C-2 — Server Actions CMS + Storefront `/pages`**
- Файлы: `lib/cms/actions.ts`; `app/api/storefront/v1/pages/[slug]/route.ts`, `pages/route.ts`,
  `lib/storefront/cms-dto.ts`.
- Тесты: `cms/actions-guard`, `storefront/cms-dto`, `storefront/cms-routes.integration`, `cms/integration`
  (publish→ревизия, ON CONFLICT, reorder атомарен, CASCADE, CHECK размера).
- Критерий: CRUD под `cms.write` + audit; витрина отдаёт только опубликованное под `module:'cms'`.
- Зависимости: 5.C-1.

**Пакет 5.C-3 — Admin UI CMS + Tiptap**
- Файлы: `app/admin/(panel)/cms/{page,new,[id]}/page.tsx` + `_components/*` (редактор секций, Tiptap);
  `package.json` (`@tiptap/react` + санитайзер).
- Тесты: e2e (создание/публикация страницы), форма секции по `type`.
- Критерий: контент-менеджер создаёт страницу, добавляет/сортирует секции, публикует.
- Зависимости: 5.C-2.

### Волна W4 — Промо N×M

**Пакет 5.P-1 — Миграция + чистая логика N×M/scope (фундамент)**
- Файлы: `db/migrations/0024_promo_mechanics_nxm.sql`; `lib/orders/pricing.ts` (новые чистые
  `bogoDiscountMinor`/`scopeDiscountMinor`/комбинируемость), `lib/orders/types.ts`/`schemas.ts` (поля +
  `refinePromo`).
- Тесты (до кода): `pricing-bogo`, `pricing-scope`, `promo-combine`, `promo` (РАСШИРИТЬ), `schemas`
  (РАСШИРИТЬ), `orders-migrations` (РАСШИРИТЬ).
- Критерий: матрица N×M/scope/комбинируемость зелёная; существующие pricing/promo тесты не тронуты.
- Зависимости: нет (миграция `0024` — последняя в этапе).

**Пакет 5.P-2 — Резолв таргетов + интеграция в quote/order + Admin UI + опц. Storefront**
- Файлы: `lib/orders/repository.ts` (`getPromoWithTargets`, разметка линий в `quoteCart`/`createOrder`),
  `lib/orders/actions.ts` (расширение create/updatePromoCode + targets); `app/admin/(panel)/promo/
  _components/*` (форма); опц. `lib/storefront/dto.ts` (`toPublicPromotionDto`) + `/promotions` route.
- Тесты: `repository`/`storefront/orders` (РАСШИРИТЬ, с БД) — quote/order считают N×M, пишут redemption.
- Критерий: админ создаёт «3 по 2» на категорию → витрина quote→order считает корректно.
- Зависимости: 5.P-1.

**Граф:** W1 (5.D-1 → 5.D-2) → W2 (5.S-1). W3 и W4 далее параллелизуемы (5.C-1→5.C-2→5.C-3;
5.P-1→5.P-2), т.к. файлы `lib/cms/*` и `lib/orders/*` не пересекаются. Документация (ADR-012/013/014,
журнал, роадмап) — сквозная.

---

## 9. Новые зависимости

| Зависимость | Назначение | Где |
|---|---|---|
| `@tiptap/react` (+ ядро) | rich-text редактор CMS-секций | 5.1, admin-бандл |
| `sanitize-html` или `isomorphic-dompurify` | **серверная** санитизация rich-text (анти-XSS) | 5.1, Node |

Остальное переиспользуется: `zod`, `postgres.js`, `ioredis` (задел кеша), S3-слой `getStorage()`,
`defineAction`, `runStorefront`. Новых runtime-зависимостей для 5.2/5.3/5.4 нет.

---

## 10. Зависимости этапа

- **От предыдущих этапов:** ядро (`defineAction`, RBAC, `audit_log`), каталог (slug/SEO-поля, S3-медиа,
  `product_categories`/`brands`), заказы (`promo_codes`/`promo_redemptions`, `calculateQuote`/`quoteCart`/
  `createOrder`, `money.ts`), Storefront (`runStorefront`, DTO-слой, CORS). Этап строго аддитивен.
- **Внутри этапа:** 5.3 (SEO) зависит от 5.4 (`shop_settings.seo` — домен/шаблоны); 5.1 (CMS-SEO-поля)
  и 5.3 согласованы по миграции `0022`. 5.2 (промо) самодостаточна (миграция `0024`). Поэтому порядок:
  **5.4 → 5.3 → {5.1, 5.2}**.
- **Для следующих этапов:** `shop_settings` — фундамент конфигурируемости (Этап 6.5 развёртывание);
  CMS-страницы и акции — контент новых витрин без кода.

---

## 11. Резюме архитектурных решений (для журнала)

1. **`shop_settings` (env⊕БД)** — источник магазино-специфики переходит с env на БД (env = дефолт),
   включая оверрайд `ADMIK_MODULES` через UI. core-always-on. **ADR-013.**
2. **CMS на `cms_pages`+`cms_page_sections` (JSONB)** — нормализованные секции (FK CASCADE) вместо
   плоской таблицы 2x2; дискриминированная Zod-валидация по `type`; серверная санитизация rich-text;
   триада статусов; опц. ревизии. Модуль `cms`. **ADR-012.**
3. **Промо N×M** — расширение `promo_codes` одним `kind`-полем + `promo_targets`; чистая
   `bogoDiscountMinor`/`scopeDiscountMinor`; детерминированный алгоритм; комбинируемость MVP-правилом;
   один промокод/заказ; gift отложен. Модуль `orders`, anti-tamper. **ADR-014.**
4. **SEO** — поля на самих сущностях (НЕ отдельная `page_metadata`); домен из `shop_settings.seo.site_url`;
   og:image ключом S3; `sitemap.xml`/`robots.txt` core-always-on, наполнение фильтруется по модулям.
5. **Миграции `0019`–`0024`** — сплошной диапазон (конфликт «все начинают с 0019» разрешён §2),
   идемпотентны по шаблону `0018`.
6. **Без `tenant_id`/`website_id`** (ADR-003); деньги в копейках; всё через `defineAction`; права —
   существующие. ADR-005/008/010 переиспользуются без изменений.
