# Эквайринг Ozon Банка — как устроено (tvuchet.ru)

Подключено 2026-08-27. Спецификация API — в `docs-ozon/01..03`.

## Путь оплаты

1. Покупатель оформляет заказ на `checkout.html`, выбрав оплату картой.
2. Витрина создаёт заказ: `POST /api/storefront/v1/orders`.
3. Витрина инициирует оплату: `POST /api/storefront/v1/payments/ozon/init`.
4. Сервер вызывает `POST https://payapi.ozon.ru/v1/createOrder` и получает `payLink`.
5. Покупателя перебрасывает на `checkout.ozon.ru`, он платит.
6. Банк присылает уведомление на `POST /api/payments/ozon/webhook`.
7. Сервер проверяет подпись, пишет журнал и переводит заказ в «оплачен».

**Почему через заказы, а не через `/v1/createPayment`:** метод `createPayment`
поддерживает только СБП (`payType: SBP`), картой через него платить нельзя.
Оплата картой доступна лишь путём `createOrder` → `payLink`.

## Ключевые файлы

| Файл | Назначение |
|---|---|
| `lib/payments/ozon/sign.ts` | Подписи запросов и уведомлений |
| `lib/payments/ozon/config.ts` | Чтение настроек, определение mock-режима |
| `lib/payments/ozon/client.ts` | HTTP-клиент, разбор ошибок |
| `lib/payments/ozon/service.ts` | Создание заказа, обработка уведомлений, сверка |
| `lib/payments/ozon/repository.ts` | Работа с БД, атомарная обработка событий |
| `lib/payments/ozon/status-map.ts` | Перевод статусов Ozon в статусы платформы |
| `lib/payments/ozon/cron.ts` | Сверка «зависших» платежей |
| `app/api/storefront/v1/payments/ozon/init/route.ts` | Инициация оплаты |
| `app/api/payments/ozon/webhook/route.ts` | Приём уведомлений банка |
| `db/migrations/0038_ozon_payments.sql` | Журнал платежей, допуск провайдера |

## Две разные подписи — не перепутать

**Запрос** (`requestSign` в теле): обычный `SHA-256` (не HMAC) от конкатенации
значений **без разделителей**, `secretKey` в конце. Порядок полей свой для
каждого метода — см. таблицу в `docs-ozon/01`.

**Уведомление**: `SHA-256` от значений через разделитель `|`, с **другим**
ключом — `notificationSecretKey`.

Обе схемы проверены на контрольных примерах документации (тесты в
`tests/payments/ozon/sign.test.ts`).

## Настройки (.env)

Смысловые значения:

- `OZON_PAY_ALGORITHM=PAY_ALGO_SMS` — одностадийный, деньги списываются сразу.
- `OZON_PAY_FISCALIZATION=true` — касса на стороне Озона, чеки пробивает банк.
- `OZON_PAY_DEFAULT_VAT=VAT_NONE` — у магазина АУСН, НДС не начисляется.
- `OZON_PAY_EXPIRES_MIN=60` — сколько живёт неоплаченный заказ.

Три секрета: `OZON_PAY_ACCESS_KEY` (ID токена), `OZON_PAY_SECRET_KEY` (подпись
запросов), `OZON_PAY_NOTIFICATION_SECRET` (подпись уведомлений — **отдельный** ключ).

## Защита

- **Сумма считается сервером** из `orders.grand_total`, а не берётся из запроса
  витрины — иначе покупатель оплатил бы заказ по своей цене.
- **Уведомление без верной подписи отвергается** (403). Без ключа нотификаций
  вебхук не принимает ничего вообще.
- **Идемпотентность**: ключ `(transaction_uid, status)` — повторная доставка
  уведомления не зачисляет оплату дважды.
- **Атомарность**: запись журнала и смена статуса — в одной транзакции. При сбое
  откатывается всё, и повтор доводит дело до конца.
- **Гард мёртвого заказа**: отменённый заказ не будет помечен оплаченным.

## Сверка платежей

Если уведомление не дойдёт, заказ останется неоплаченным. Крон каждые 15 минут
опрашивает банк по «зависшим» заказам:

    */15 * * * * /root/pribuch/ozon-reconcile.sh

Вручную: `/root/pribuch/ozon-reconcile.sh`

## Диагностика

Журнал платежей:

    SELECT * FROM ozon_payment_log ORDER BY received_at DESC LIMIT 20;

Заказы с оплатой Ozon:

    SELECT number, payment_status, payment_ref FROM orders WHERE payment_provider = 'ozon';

Логи: `docker compose logs app | grep ozon`

**Код ошибки 16** от Ozon = неверная подпись (приходит с HTTP 400, поэтому легко
принять за ошибку данных). В логах такая ошибка пишется отдельной строкой.

## Внимание при пересборке образа

После **любой** пересборки `app` обязательно проверять:

    docker compose exec app node /app/scripts/sharp-selfcheck.mjs
    curl -H 'Origin: https://tvuchet.ru' https://admin.tvuchet.ru/api/storefront/v1/products?limit=1

Иначе можно не заметить, что каталог отдаёт 500 (см. историю с libvips).

## Что осталось за владельцем

1. **Токен в ЛК сейчас в тестовом режиме** — реальные карты не проходят.
   Для приёма настоящих денег перевести токен в статус «Активен».
2. Проверить оплату тестовой картой (карты запросить в поддержке Озона).
3. Сверить в настройках токена адреса возврата и URL уведомлений:
   - успех: `https://tvuchet.ru/order-success.html`
   - отказ: `https://tvuchet.ru/cart.html`
   - уведомления: `https://admin.tvuchet.ru/api/payments/ozon/webhook`
