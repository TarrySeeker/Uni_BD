# Этап 7 — Онлайн-платежи Т-Банк (модуль `payments/tbank`)

> Проектный документ Solution Architect. Дизайн модуля интернет-эквайринга **Т-Банк**
> (бывш. Тинькофф; продукт «Интернет-эквайринг» / «T-Kassa» / «Т-Бизнес») для Admik на
> TypeScript/Next.js/Postgres/Redis. Архитектурный паттерн полностью повторяет модуль СДЭК
> (ADR-011, `docs/08`): слоистость `Manager → Client → Service`, **mock-first** при пустых ключах,
> **идемпотентный webhook**, секреты только в `.env`. Этот документ предлагает **ADR-017
> «Платежи Т-Банк»** и декомпозицию на волны реализации.
>
> **Статус:** ✅ **ВОЛНЫ 1–2 РЕАЛИЗОВАНЫ** (2026-06-17, см. `docs/00`). Модуль `lib/payments/tbank/*` +
> роуты (`…/payments/tbank/init`, `…/payments/tbank/webhook`) + миграция `0027` написаны по этому документу;
> mock-first работает без ключей, боевой клиент готов. typecheck/lint/тесты зелёные (+98 тестов).
> **Осталось (волна 2/4):** живой прогон по тест-картам на ТЕСТОВОМ терминале (нужны ключи из ЛК,
> только в `.env` стенда) → боевой запуск. ADR-017 — принят.
>
> **Принцип документа:** интеграция — *аддитивная*. Поля оплаты на `orders`
> (`payment_method`, `payment_status`, `paid_at`, `payment_ref`) уже заложены (Этап 3,
> `lib/orders/types.ts`), статус-машины order/payment — в `lib/orders/status.ts`. Этап 7 добавляет
> провайдер онлайн-оплаты *без рефакторинга ядра заказов*: при выключенном модуле/пустых ключах
> поведение прежнее (оплата при получении / выставление счёта).

---

## 1. Краткое резюме и источники

### 1.1 Что это

Т-Банк предоставляет REST-API интернет-эквайринга (T-API): мерчант создаёт платёж методом `Init`,
перенаправляет покупателя на платёжную форму (`PaymentURL`), получает асинхронный webhook-callback о
смене статуса (`Notification`) и/или опрашивает `GetState`. Поддерживаются оплата картой, **СБП**
(QR/линк), T-Pay, SberPay, рассрочка; одно- и двухстадийная оплата; формирование чека по 54-ФЗ
(объект `Receipt`).

### 1.2 Ключевые факты (сверено по 2+ источникам)

| Параметр | Значение | Источник |
|---|---|---|
| Боевой URL | `https://securepay.tinkoff.ru/v2` | офиц. + SDK |
| Тестовый URL (sandbox) | `https://rest-api-test.tinkoff.ru/v2` | офиц. «Тестовая среда» + SDK |
| Аутентификация | `TerminalKey` (идентификатор терминала) + `Password` (пароль терминала из ЛК) | офиц. `Init`/`token` |
| Подпись запроса | `Token` = SHA-256(hex, lowercase) от конкатенации значений корневых полей + `Password`, отсортированных по ключу | офиц. `/eacq/intro/developer/token` + SDK + Go-клиент |
| Формат запросов | `POST`, `Content-Type: application/json` | офиц. `Init` |
| Суммы | в **копейках** (целое) | офиц. `Init` (Amount, Price, Amount) |
| Основные методы | `Init`, `GetState`, `Confirm`, `Cancel`, `Charge` (рекуррент), `GetQr`/`GetQrState` (СБП) | офиц. + 2 SDK |
| Двухстадийность | `PayType: "O"` (одностадийная, авто-списание) / `"T"` (двухстадийная: hold → Confirm) | офиц. `Init` + SDK |
| Webhook | `POST` на `NotificationURL` из настроек терминала; в ответ строго `OK` (HTTP 200, plain text); ожидание ответа ~10 c | офиц. «Уведомления» |
| Статусы платежа | `NEW, FORM_SHOWED, AUTHORIZING, AUTHORIZED, CONFIRMING, CONFIRMED, REVERSING, REVERSED, REFUNDING, PARTIAL_REFUNDED, REFUNDED, REJECTED, DEADLINE_EXPIRED` | офиц. + Go-клиент (полный список — **уточнить по докам/ЛК**) |
| Тестовая карта | `4300 0000 0000 0777`, exp `11/22` (любая будущая), CVC `123` | офиц. «Тестовая среда» |
| Тест-кейсы (на проде) | терминал с суффиксом/префиксом `DEMO` → запросы на боевой URL | офиц. «Тест-кейсы» |

### 1.3 Официальные источники (developer/acquiring docs Т-Банка)

- Дев-портал, интернет-эквайринг: https://developer.tbank.ru/eacq/intro
- Метод `Init`: https://developer.tbank.ru/eacq/api/init
- Формирование подписи `Token`: https://developer.tbank.ru/eacq/intro/developer/token
- Уведомления об операциях (webhook): https://developer.tbank.ru/eacq/intro/developer/notification
- Тестовая среда и карты: https://developer.tbank.ru/eacq/intro/errors/test
- Тест-кейсы: https://developer.tbank.ru/eacq/intro/errors/test-cases
- Тестирование СБП: https://developer.tbank.ru/eacq/intro/errors/test-sbp
- Документация T-API (обзор): https://developer.tbank.ru/docs/api/internet-ekvairing

> Вспомогательные (сверка полей/алгоритма, НЕ источник истины): SDK
> `nikita-vanyasin/tinkoff` (Go), `esurkov1/tbank-payments` (TS). Перед боевым запуском все поля
> сверяются по актуальной офиц. документации и ЛК (Т-Банк периодически меняет минорные детали).

---

## 2. Архитектура модуля `lib/payments/tbank`

Слоистость 1:1 с СДЭК (`Manager → Client → Service`), единый флаг `isMock`, mock-слой отдельным
каталогом. Заказы НЕ зависят от модуля платежей напрямую — связка через тонкий адаптер/роуты
(аналог `lib/orders/delivery-cost.ts` для СДЭК).

```
lib/payments/
  tbank/
    config.ts        # чтение TBANK_* из env (Zod) + isTbankMock(); порт CdekConfig/getCdekConfig
    client.ts        # низкоуровневый HTTP к /v2/* (POST json, таймаут, ретраи 5xx/сеть); ВСЕГДА реальный
    token.ts         # подпись Token (SHA-256) + verifyNotificationToken — ЧИСТЫЕ функции, без сети
    manager.ts       # фасад: config + client + mock; флаг isMock; ленивый синглтон (порт CdekManager)
    mock/
      index.ts       # детерминированные mock-операции: initPayment→фейковый PaymentId/PaymentURL,
                      #   getState, confirm, cancel; mock-PaymentURL ведёт на внутреннюю demo-страницу
      fixtures.ts    # фикстуры статусов/ответов
    service.ts       # PaymentService: createPayment(order)→Init, syncState(paymentId)→GetState,
                      #   confirm/cancel/refund; маппинг статуса T-Банка → PaymentStatus (status-map)
    status-map.ts    # ЧИСТАЯ: T-Банк Status → orders.payment_status (+ влияние на orders.status)
    receipt.ts       # ЧИСТАЯ: сборка объекта Receipt (54-ФЗ) из Order+OrderItem
    types.ts         # доменные типы (InitRequest/InitResponse/Notification/Status enum)
    errors.ts        # TbankError(code,message,{tbankErrorCode,httpStatus}) — порт CdekError
    index.ts         # реэкспорт публичного API
app/api/payments/tbank/
  webhook/route.ts   # server-to-server callback: проверка Token → атомарная recordWebhookEvent (лог+статус+processed) → "OK" / 500 на throw
app/api/storefront/v1/payment/tbank/
  init/route.ts      # витрина: по orderId создать платёж → вернуть PaymentURL (module-gate+CORS+rate-limit)
  return/route.ts    # (опц.) обработка SuccessURL/FailURL: показать статус, не доверять как источнику истины
```

### 2.1 Выбор mock vs real (контракт — как у СДЭК)

```ts
const m = getTbankManager();
if (m.isMock) {
  // боевых ключей нет → детерминированный mock:
  const res = m.mock.initPayment({ orderId, amountKop });   // фейковый PaymentId + внутренний PaymentURL
} else {
  // реальный транспорт:
  const res = await m.client.request('/v2/Init', signedBody);
}
```

Источник истины — `manager.isMock` (эквивалент `isTbankMock()` / пустой `TBANK_PASSWORD`).
`client` в mock-режиме НЕ инстанцируется (обращение кидает `TbankError` — баг вызывающего). Транспорт
остаётся чистым (без веток «если mock»), mock-данные живут в `lib/payments/tbank/mock/*`. Это полностью
повторяет решение СДЭК (см. `lib/cdek/client.ts` шапку «АРХИТЕКТУРНОЕ РЕШЕНИЕ» и `manager.ts`).

### 2.2 Отличия от СДЭК (важно учесть)

- **Аутентификация иная:** у СДЭК — OAuth2 `client_credentials` + Bearer-токен с кешем (`token-cache.ts`).
  У Т-Банка **нет** долгоживущего токена — каждый запрос **подписывается** полем `Token` (SHA-256). Поэтому
  модуль платежей **не нуждается** в `token-cache`/Redis для авторизации — только в чистой функции подписи
  (`token.ts`). Это упрощает клиент.
- **Webhook-аутентификация:** у СДЭК — IP-whitelist + `?key=` секрет. У Т-Банка основной механизм —
  **проверка `Token` в теле** (HMAC-подобная подпись на `Password`). IP-whitelist оставляем как
  доп. слой (опц., `TBANK_WEBHOOK_IPS`), но **главная** проверка — `Token`.
  **SECURITY (волна 4, баг B):** IP-whitelist аутентифицирует запрос **только за доверенным прокси**
  (`TBANK_WEBHOOK_TRUST_PROXY=true`). Без trustProxy (дефолт) `extractIp` возвращает `''` сразу, НЕ
  читая клиент-контролируемые `X-Forwarded-For`/`X-Real-IP`, — иначе подделкой заголовка из whitelist
  атакующий обошёл бы IP-гейт. Эталон — порт CDEK-webhook (`extractIp` там тоже `if (!trustProxy) return ''`).
- **Связь с заказом:** `Init.OrderId` = `orders.number` (человекочитаемый, уникальный), `Init.Amount` =
  `grand_total` в копейках. `PaymentId` Т-Банка сохраняем в `orders.payment_ref` (или в отдельную таблицу
  `tbank_payments`, см. §4.4).

---

## 3. ENV-переменные

Стиль и режимы — как у `CDEK_*` (`.env.example` §«СДЭК»): три режима по заполненности ключей.
**Все ключи — только в `.env`** (`.env` в `.gitignore`); в репозитории — плейсхолдеры/комментарии.
Добавляется в `lib/config/env.ts` (Zod, `.optional()` → отсутствие = mock).

| ENV | Тип / дефолт | Назначение |
|---|---|---|
| `TBANK_BASE_URL` | url, дефолт `https://securepay.tinkoff.ru/v2` | боевой / тестовый (`https://rest-api-test.tinkoff.ru/v2`) |
| `TBANK_TERMINAL_KEY` | string, optional | идентификатор терминала (≤20). **ПУСТО → mock** |
| `TBANK_PASSWORD` | string, optional | пароль терминала (для подписи Token). **ПУСТО → mock** (секрет!) |
| `TBANK_PAY_TYPE` | enum `O`/`T`, дефолт `O` | одностадийная (списание сразу) / двухстадийная (hold→Confirm) |
| `TBANK_RECEIPT_ENABLED` | bool, дефолт `false` | формировать ли чек 54-ФЗ (вкл. только если онлайн-касса подключена к терминалу) |
| `TBANK_TAXATION` | enum, optional | СНО магазина: `osn`/`usn_income`/`usn_income_outcome`/`esn`/`patent` |
| `TBANK_DEFAULT_TAX` | enum, дефолт `none` | ставка НДС позиции по умолчанию: `none`/`vat0`/`vat10`/`vat20`/… (уточнить ставки по докам) |
| `TBANK_NOTIFICATION_URL` | url, optional | абсолютный URL нашего webhook (передаётся в `Init.NotificationURL`; иначе берётся из настроек терминала в ЛК) |
| `TBANK_SUCCESS_URL` | url, optional | редирект витрины при успехе |
| `TBANK_FAIL_URL` | url, optional | редирект витрины при отказе |
| `TBANK_WEBHOOK_IPS` | csv, optional | доп. IP-whitelist webhook (главная защита — Token); пустой допустим |
| `TBANK_WEBHOOK_TRUST_PROXY` | bool, дефолт `false` | брать IP из `X-Forwarded-For` (за Caddy) |
| `TBANK_REDIRECT_DUE_MIN` | int, дефолт напр. `60` | срок жизни ссылки/QR (мин) → `Init.RedirectDueDate` |

> `isTbankMock()` = `true`, если пуст `TBANK_TERMINAL_KEY` **или** `TBANK_PASSWORD` (порт `isCdekMock`).
> Тестовый контур: `TBANK_BASE_URL=https://rest-api-test.tinkoff.ru/v2` + тестовые `TerminalKey`/`Password`
> из ЛК (тестовый терминал). Для тестовой среды нужно добавить IP в whitelist тестовой среды через чат
> в ЛК Т-Бизнес (**уточнить при подключении**).

Плейсхолдер-блок в `.env.example` (по образцу СДЭК):

```dotenv
# -----------------------------------------------------------------------------
# Т-БАНК ИНТЕРНЕТ-ЭКВАЙРИНГ (Этап 7, docs/15). ТРИ режима по заполненности ключей:
#   1) MOCK (по умолчанию): TBANK_TERMINAL_KEY/TBANK_PASSWORD ПУСТЫ → сеть не дёргается,
#      Init возвращает фейковый PaymentId + внутренний PaymentURL (demo-страница оплаты).
#      Для CI/demo — заказ оформляется и «оплачивается» без боевого терминала.
#   2) ТЕСТОВЫЙ КОНТУР (sandbox): TBANK_BASE_URL=https://rest-api-test.tinkoff.ru/v2
#      + тестовые TerminalKey/Password из ЛК Т-Бизнес (тестовый терминал). Тестовая
#      карта 4300 0000 0000 0777 / 11/22 / 123. IP добавить в whitelist тестовой среды.
#   3) БОЕВОЙ: TBANK_BASE_URL=https://securepay.tinkoff.ru/v2 + боевые TerminalKey/Password.
#   ⚠ Любые ключи Т-Банка (включая тестовые) живут ТОЛЬКО в .env, не в репозитории.
# -----------------------------------------------------------------------------
TBANK_BASE_URL=https://securepay.tinkoff.ru/v2
TBANK_TERMINAL_KEY=
TBANK_PASSWORD=
TBANK_PAY_TYPE=O
TBANK_RECEIPT_ENABLED=false
TBANK_TAXATION=
TBANK_DEFAULT_TAX=none
TBANK_NOTIFICATION_URL=
TBANK_SUCCESS_URL=
TBANK_FAIL_URL=
TBANK_WEBHOOK_IPS=
TBANK_WEBHOOK_TRUST_PROXY=false
TBANK_REDIRECT_DUE_MIN=60
```

---

## 4. Поток оплаты (storefront → Init → webhook → orders)

### 4.1 Создание платежа

1. Витрина создаёт заказ обычным путём (Этап 3): `POST /api/storefront/v1/orders` →
   `order { number, grandTotal, paymentMethod }`. Для онлайн-оплаты `paymentMethod ∈ {card, sbp}`,
   `payment_status = pending`, `order.status = awaiting_payment`.
2. Витрина запрашивает платёжную ссылку: `POST /api/storefront/v1/payment/tbank/init { orderId }`.
   Сервер (НЕ фронт) собирает `Init`:
   - `TerminalKey` = `TBANK_TERMINAL_KEY` (с сервера, не от клиента — анти-tamper, ADR-010),
   - `OrderId` = `order.number`,
   - `Amount` = `grandTotal` × 100 (копейки, считает сервер из БД, не из запроса),
   - `Description`, `NotificationURL`, `SuccessURL`, `FailURL`, `PayType`, опц. `Receipt` (см. §6),
   - `Token` = подпись (см. §5).
3. Ответ `Init`: `{ Success, PaymentId, PaymentURL, Status: "NEW", ErrorCode }`. Сохраняем
   `PaymentId` (в `orders.payment_ref` или `tbank_payments`), отдаём витрине `PaymentURL`.
4. Витрина редиректит покупателя на `PaymentURL`. Для СБП — можно запросить `GetQr` по `PaymentId`
   и показать QR (опц., волна 3).

### 4.2 Подтверждение оплаты (источник истины — webhook)

5. Покупатель платит на форме Т-Банка → Т-Банк шлёт `POST` на `NotificationURL` (наш webhook).
6. Webhook (`app/api/payments/tbank/webhook`):
   - **проверяет `Token`** в теле (см. §5.2); невалидный → 403, НЕ обрабатываем;
   - (опц.) IP-whitelist;
   - маппит `Status` → `payment_status` через статус-машину `lib/orders/status.ts` (переход
     применяется лишь если допустим);
   - **АТОМАРНО** обрабатывает событие одним вызовом `recordWebhookEvent` (см. §4.4) в ОДНОЙ
     транзакции: (a) идемпотентная запись в `tbank_payment_log` (UNIQUE по `(payment_id, status)`,
     `ON CONFLICT DO NOTHING`) — дубликат → ранний выход, повторно не обрабатываем; (b) смена
     `orders.payment_status` (`SELECT … FOR UPDATE` + guarded `UPDATE … WHERE payment_status = from`,
     при оплате — `paid_at`, `orders.status` см. §4.3); (c) пометка лога `processed = true`. Защита
     от out-of-order/конкурентных webhook (UNIQUE защищает от повтора ОДНОГО события, guard — от двух
     РАЗНЫХ, напр. не даёт откатить `paid → authorized`);
   - **штатный результат** (включая дубликат / недопустимый переход / заказ не найден / неизвестный
     статус — все no-op без throw) → **строго `OK`** (HTTP 200, plain text), иначе Т-Банк ретраит
     без нужды. **Неожиданная ошибка** обработки верифицированного события (throw) → **500**: пусть
     Т-Банк РЕТРАЙНЕТ — атомарность `recordWebhookEvent` гарантирует откат всей транзакции (включая
     вставку лога), не оставляя «осиротевшего» события `processed=false`, и повтор безопасно
     переприменит статус.
7. Витрина после редиректа на `SuccessURL` показывает статус, но **источник истины — webhook**
   (или `GetState` как fallback при «зависшем» платеже — задел под cron-синхронизацию).

### 4.3 Маппинг статусов (status-map.ts, ЧИСТАЯ)

| Т-Банк `Status` | `orders.payment_status` | `orders.status` (если допустим переход) |
|---|---|---|
| `NEW`, `FORM_SHOWED`, `AUTHORIZING` | `pending` | `awaiting_payment` |
| `AUTHORIZED` (двухстадийная, hold) | `authorized` | `awaiting_payment` (ждём Confirm) |
| `CONFIRMED` | `paid` (+ `paid_at`) | `paid` |
| `REJECTED`, `DEADLINE_EXPIRED`, `REVERSED` | `failed` | без авто-смены (или `cancelled` по политике) |
| `REFUNDED` | `refunded` | `refunded` |
| `PARTIAL_REFUNDED` | `refunded` (частичный — уточнить политику) | без авто-смены |

> Существующий `PaymentStatus` = `pending|authorized|paid|failed|refunded` **уже покрывает** все
> исходы T-Банка — новых значений в БД НЕ требуется. `authorized` ровно соответствует hold-у
> двухстадийной оплаты (`AUTHORIZED`).

### 4.4 Привязка к существующей модели заказов

- **`payment_method`** — `card`/`sbp` уже есть в whitelist (`lib/orders/types.ts`). Решение:
  **НЕ вводить** значение `tbank` — провайдер ортогонален способу. Покупатель выбирает `card`/`sbp`,
  а *кто провайдер* (Т-Банк) — деталь конфигурации/отдельного поля. **Альтернатива** (если нужно
  явно различать провайдеров на уровне заказа) — добавить `payment_provider TEXT` на `orders`
  миграцией (значения `tbank`/`cdek_pay`/`manual`). Рекомендация: добавить `payment_provider` —
  это чище для аналитики и будущих провайдеров (**решение вынести в ADR-017**).
- **`payment_ref`** — хранит `PaymentId` Т-Банка (уже есть на `orders`, `string|null`).
- **Опциональная таблица `tbank_payments`** (волна 2, миграция `00NN`, идемпотентная, стиль `0012`):
  `order_id` (FK), `payment_id`, `status`, `amount_kop`, `pay_type`, `is_mock`, `raw_init`,
  `created_at`/`updated_at` — для аудита/рефандов/повторов. Плюс лог `tbank_payment_log`
  (`payment_id`, `status`, `received_at`, UNIQUE для идемпотентности webhook — порт `cdek_status_log`).
- **`applyPaymentStatus(orderId, to, comment)`** (`repository.ts`, порт `applyDeliveryStatus`) —
  смена `payment_status` без Server Actions (webhook не имеет RBAC-контекста). **Атомарность
  (анти-TOCTOU):** вся операция в `sql.begin` — `SELECT payment_status … FOR UPDATE` (блокировка
  строки заказа), проверка `canTransition('payment', from, to)`, guarded `UPDATE … WHERE id = orderId
  AND payment_status = from`. История (`order_status_history`) и `paid_at` пишутся **только при
  `rowCount === 1`**; иначе (заказ не найден / `from === to` / недопустимый переход / строку уже
  изменил другой webhook) → `false`, no-op. Это исключает откат уже выставленного статуса
  конкурентным/неупорядоченным уведомлением Т-Банка. Тело вынесено во внутреннюю
  `applyPaymentStatusTx(tx, …)` и переиспользуется в `recordWebhookEvent` без отдельного `begin`.
- **`recordWebhookEvent({ log, nextStatus, comment })`** (`repository.ts`) — **АТОМАРНАЯ** обработка
  события webhook в ОДНОЙ транзакции `sql.begin`: (1) `INSERT … tbank_payment_log … ON CONFLICT
  (payment_id, status) DO NOTHING RETURNING id` — нет id → `{inserted:false, processed:false}`
  (дубликат, эффект не повторяем); (2) при `nextStatus` — `applyPaymentStatusTx(tx, …)`; (3)
  `UPDATE tbank_payment_log SET processed = true`. **Зачем атомарность:** ранее три шага шли в ТРЁХ
  отдельных транзакциях; сбой БД на смене статуса ПОСЛЕ коммита лога оставлял лог `processed=false`
  навсегда, а повтор webhook видел дубликат и НЕ применял статус → оплаченный заказ навсегда висел
  в `pending` (потеря денег). Теперь сбой откатывает ВСЁ, включая вставку лога, и повтор события
  снова применяет статус.

---

## 5. Подпись Token

### 5.1 Алгоритм (исходящие запросы)

Подтверждён офиц. страницей `/eacq/intro/developer/token` и двумя SDK:

1. Взять **только корневые** пары ключ-значение запроса. **Исключить** `Token` и **вложенные
   объекты/массивы** (`Receipt`, `DATA`, `Items` — в подписи НЕ участвуют).
2. Добавить пару `Password` со значением пароля терминала (`TBANK_PASSWORD`).
3. Отсортировать пары **по ключу в алфавитном порядке**.
4. **Конкатенировать только значения** (без ключей и разделителей) в одну строку.
5. `SHA-256` (UTF-8) → **hex в нижнем регистре**. Результат → поле `Token` запроса.

Пример из офиц. доки (для сверки реализации):
параметры `TerminalKey, Amount, OrderId, Description` + `Password` → сортировка
`Amount, Description, OrderId, Password, TerminalKey` → конкатенация значений →
`SHA-256` → `Token`.

> Реализация — ЧИСТАЯ функция `signToken(payload, password): string` в `token.ts`, покрыта unit-тестом
> на эталонном векторе из доки. `Receipt`/`DATA` сериализуются в тело, но в подпись не идут.
> Булевы значения сериализуются как `"true"/"false"`, числа — как строки (**сверить точную
> сериализацию по докам/эталону при первом боевом запросе**).

### 5.2 Проверка Token входящего webhook

Тот же алгоритм применяется к телу `Notification` (исключая `Token` и вложенные объекты):
пересобрать значения корневых полей + `Password`, отсортировать, конкатенировать, SHA-256,
сравнить с присланным `Token` (constant-time сравнение). Несовпадение → 403, событие игнорируется.
Реализация — ЧИСТАЯ `verifyNotificationToken(body, password): boolean` (порт идеи `verifyWebhookIp`,
но на подписи, не на IP).

---

## 6. Чек 54-ФЗ (объект `Receipt`)

Передаётся в `Init.Receipt`, **обязателен только если** к терминалу подключена онлайн-касса
(`TBANK_RECEIPT_ENABLED=true`). Минимально необходимое (сверено по офиц. `Init`):

```jsonc
"Receipt": {
  "Email": "buyer@example.com",     // или Phone — одно из двух обязательно
  "Phone": "+79991234567",
  "Taxation": "usn_income",          // СНО магазина: osn|usn_income|usn_income_outcome|esn|patent
  "Items": [                         // ≤100 позиций; сумма Amount = Init.Amount
    {
      "Name": "Название товара",     // ≤128
      "Quantity": 1,
      "Price": 150000,               // цена за единицу, КОПЕЙКИ
      "Amount": 150000,              // = Price × Quantity, КОПЕЙКИ
      "Tax": "none",                 // ставка НДС: none|vat0|vat10|vat20|… (точный набор — по докам)
      "PaymentMethod": "full_payment",   // признак способа расчёта (опц., есть дефолт у терминала)
      "PaymentObject": "commodity"       // признак предмета расчёта (опц.)
    }
  ]
}
```

Сборка `Receipt` — ЧИСТАЯ функция `buildReceipt(order, items, cfg)` в `receipt.ts`:
- `Items` ← `order_items` (снимки `nameSnapshot`, `unitPrice`, `quantity`, `lineTotal`); суммы в копейки
  через **`toMinor`** (`@/lib/orders/money` — строковый разбор, без float; обёртка `toKopecks`
  возвращает `0` на невалидном входе, не падает);
- доставка (`deliveryTotal`) — отдельной позицией `Name: "Доставка"`, `PaymentObject: "service"` (если >0);
  доставка **не дисконтируется** (отдельная услуга, полная стоимость);
- **скидка промокода** (`order.discountTotal > 0`) распределяется ПО ПОЗИЦИЯМ товаров
  пропорционально их доле (54-ФЗ требует учёта скидки в цене позиции, иначе Σ `Amount` >
  `Init.Amount` ровно на `discountTotal` → Т-Банк отклонит Init). Остаток округления раздаётся
  методом наибольшего остатка (largest remainder), чтобы Σ совпала точно до копейки. При наличии
  скидки позиция формируется как одна строка чека (`Quantity:1`, `Price = Amount =` дисконтированный
  итог строки) — это сохраняет инвариант `Amount === Price × Quantity` без дробной копейки на единицу;
- `Email`/`Phone` ← `order.customerEmail`/`customerPhone`;
- `Taxation` ← `TBANK_TAXATION`; `Tax` позиции ← `TBANK_DEFAULT_TAX` (на товар можно завести
  `tax` в каталоге — **отложено**, MVP: единая ставка из env).

> **Критично:** сумма всех `Items.Amount` ДОЛЖНА равняться `Init.Amount` (= `grand_total` в копейках;
> иначе Т-Банк отклонит). `buildReceipt` **сверяет инвариант ВСЕГДА** (`receiptTotalKop(receipt) ===
> toKopecks(order.grandTotal)`) и при расхождении бросает `TbankError('tbank_receipt_mismatch')` —
> лучше упасть на нашей стороне с понятной ошибкой, чем получить отказ Init. Покрыто unit-тестами
> `buildReceipt` (в т.ч. кейсы со скидкой и остатком округления). Подарки (`isGift`, нулевые позиции):
> цена = эффективная `unitPrice` (после скидки), подарок = `Price:0` (**уточнить допустимость нулевой
> позиции в чеке по докам ОФД/Т-Банка**).

---

## 7. Безопасность

- **Секреты только в `.env`** (`.env` в `.gitignore`). В репозитории — плейсхолдеры (§3). `TBANK_PASSWORD`
  никогда не попадает в код/фронт/логи. `TerminalKey`/`Password` подставляются на сервере, не передаются
  с витрины (анти-tamper, ADR-010).
- **mock-first** (ADR-002/ADR-011): пустые `TBANK_TERMINAL_KEY`/`TBANK_PASSWORD` → `isMock=true`,
  сеть не дёргается, demo/CI работают. Разовый `console.warn` при инициализации (порт `warnMockOnce`).
- **Подпись Token** на исходящих и проверка на входящих (§5). `Password` — единственный секрет подписи.
- **Идемпотентность webhook:** UNIQUE-ключ в `tbank_payment_log` + `ON CONFLICT DO NOTHING`; повторная
  доставка безопасна; ответ всегда `OK` на корректно подписанном событии (Т-Банк не должен ретраить вечно).
- **Суммы и статусы — с сервера:** `Amount` считается из `orders.grand_total` в БД, не из запроса
  витрины; `payment_status` меняется только webhook-ом/`GetState`, не доверяя `SuccessURL`.
- **Логи:** payload webhook логируется без `Token`/PAN (маскировать `Pan`/`CardId`). Структурный
  логгер `logger.child({ module: 'tbank.webhook' })` (порт СДЭК).
- **Транспорт:** таймаут на `Init`/`GetState` (AbortController), ретраи на сеть/5xx (порт `CdekClient`);
  на бизнес-ошибки (`Success:false`, `ErrorCode`) ретраев нет — это не транспортная ошибка.

---

## 8. План реализации волнами

mock-first сначала; боевой контур включается конфигом после получения ключей (завтра).

### Волна 1 — Каркас + mock (без ключей, можно начинать сразу)
- `lib/payments/tbank/{config,types,errors,token,status-map,manager,mock}` — каркас + `isTbankMock`.
- `token.ts`: `signToken`/`verifyNotificationToken` — ЧИСТЫЕ, unit-тест на эталонном векторе из доки.
- `status-map.ts`: T-Банк `Status` → `payment_status` — ЧИСТАЯ, unit-тест.
- `mock/`: `initPayment` → фейковый `PaymentId` + внутренний `PaymentURL` (demo-страница «оплатить»,
  кнопки «успех/отказ» → дёргают наш же webhook с валидным mock-Token).
- Storefront-роут `payment/tbank/init` + webhook-роут (module-gate, mock-путь).
- Флаг модуля `payments`/`tbank` в `lib/config/modules.ts`. `.env.example` + `env.ts` Zod.
- **DoD:** в demo (mock) заказ оформляется, «оплачивается», `payment_status` → `paid`, тесты зелёные без ключей.

### Волна 2 — Боевой клиент + БД-аудит (после получения ТЕСТОВОГО терминала)
- `client.ts`: реальный `POST /v2/Init|GetState|Confirm|Cancel` с подписью, таймаут/ретраи.
- `service.ts`: `createPayment/syncState/confirm/cancel/refund`.
- Миграции `00NN`: `tbank_payments` + `tbank_payment_log` (UNIQUE, идемпотентность); опц.
  `payment_provider` на `orders`.
- Webhook: реальная проверка `Token`, идемпотентная запись, маппинг статуса.
- Прогон по тест-картам/тест-кейсам на `rest-api-test.tinkoff.ru` (или DEMO-терминал на проде).
- **DoD:** на тестовом терминале полный цикл Init→оплата→webhook→`paid` работает; рефанд через Cancel.

### Волна 3 — СБП, чек 54-ФЗ, двухстадийность, синхронизация (по требованию витрин)
- `GetQr`/`GetQrState` для СБП (показ QR на витрине вместо редиректа).
- `receipt.ts` + `TBANK_RECEIPT_ENABLED` (если подключена онлайн-касса).
- Двухстадийная оплата (`PayType: T` + admin-action `Confirm`/`Cancel` под правом `payments.manage`).
- Cron-синхронизация «зависших» платежей через `GetState` (порт идеи СДЭК `create-pending`/`notify-stuck`).
- Рекуррент (`Charge`) — **вне охвата сейчас** (отметить как задел).

### Волна 4 — Боевой запуск
- Боевые `TBANK_TERMINAL_KEY`/`TBANK_PASSWORD` + `TBANK_BASE_URL=securepay` — только при развёртывании,
  НИКОГДА в репозитории. Регистрация боевого `NotificationURL` в ЛК. Контрольный платёж на малую сумму.

### Маппинг на ADR — предложение **ADR-017 «Платежи Т-Банк»**

> **ADR-017. Платежи Т-Банк: слоистый порт паттерна СДЭК + mock-режим + Token-подписанный
> идемпотентный webhook.**
> **Контекст.** Online-оплата картой/СБП через интернет-эквайринг Т-Банка. Поля оплаты на `orders`
> уже заложены (Этап 3). **Решение:** (1) слоистый модуль `lib/payments/tbank` (`Manager→Client→
> Service`), как СДЭК (ADR-011), но БЕЗ OAuth-токен-кеша — авторизация через подпись `Token`
> (SHA-256+Password) на каждом запросе; (2) **mock-first** при пустых `TBANK_TERMINAL_KEY`/
> `TBANK_PASSWORD`; (3) webhook с проверкой `Token` + идемпотентностью (UNIQUE в `tbank_payment_log`),
> ответ `OK`; (4) `payment_method` остаётся `card`/`sbp`, добавляется `payment_provider` на `orders`
> для различения провайдеров; статусы покрываются существующим `PaymentStatus`; (5) суммы/статусы —
> только с сервера (анти-tamper, ADR-010); webhook — источник истины. **Альтернатива** (значение
> `payment_method='tbank'`) отвергнута: провайдер ортогонален способу оплаты.

---

## 9. Открытые вопросы (уточнить по докам/ЛК/ключам)

1. **Точная сериализация значений в подписи** (булевы `true/false`, вложенность, регистр) — сверить на
   эталонном векторе из доки при первой реализации `signToken`.
2. **Полный перечень `Status`** и какие из них реально приходят в webhook на нашем тарифе — сверить по
   `GetState`-доке и тест-кейсам.
3. **`payment_provider` на `orders`** — добавлять ли поле (рекомендация: да) — решение в ADR-017.
4. **Чек 54-ФЗ** — подключена ли онлайн-касса к терминалу? Если нет — `Receipt` не нужен (волна 3 опц.).
   СНО магазина (`TBANK_TAXATION`) и ставки НДС (`Tax`) — от бухгалтерии владельца. Допустимость нулевых
   позиций (подарки) в чеке — по докам ОФД.
5. **Одно- или двухстадийная оплата** по умолчанию (`TBANK_PAY_TYPE`) — для розницы обычно `O`
   (списание сразу); `T` нужен, если есть ручная проверка перед списанием.
6. **СБП** — нужен ли отдельный показ QR (`GetQr`) или достаточно `PaymentURL` со способом СБП на форме.
7. **Боевой `NotificationURL`** — публичный HTTPS-домен Admik для callback (за Caddy); зарегистрировать в ЛК.
8. **Тестовая среда** — добавить наш IP в whitelist тестового контура через чат в ЛК Т-Бизнес.
9. **Минор-версии полей** Т-Банк периодически меняет — финальную сверку делать по актуальной офиц. доке
   перед боевым запуском.
