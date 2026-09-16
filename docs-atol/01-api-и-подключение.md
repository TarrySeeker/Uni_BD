# АТОЛ Pay Ecom — API интернет-эквайринга

Источник: «Описание API АТОЛ Pay Ecom (интернет-эквайринг)», версия 2.9 от 01.01.2025
(добавлен НДС 22%). PDF заказчика: `2x2/Описание_API_АТОЛ_Pay_Ecom_...pdf`.

## Среды

| Среда | ЛК | API |
|---|---|---|
| Прод | `https://lk.atolpay.ru` | `https://new-api-mobile.atolpay.ru/v1/ecom/` |
| Песочница | `https://croc-sandbox-lk.atolpay.ru` | `https://croc-sandbox-api-mobile.atolpay.ru/v1/ecom/` |

Swagger: `https://new-api-mobile.atolpay.ru/v1/ecom/documentation/`
Доступ в тестовый ЛК — по запросу на `1@atol.ru`.

## Авторизация

Токен генерируется в ЛК: **Настройки → API Токены** (показывается ОДИН раз).

🔴 **РАСХОЖДЕНИЕ С ДОКУМЕНТОМ, проверено на боевом API 15.09.2026.**
Документ (стр. 14) предписывает `Authorization: <access_token>`.
Реально так приходит **403 AUTH_ERROR**. Рабочий вариант:

    Authorization: Bearer <token>

Контрольная проверка: выдуманные токены → `NO_AUTH_DATA` (412), боевой без
`Bearer` → `AUTH_ERROR` (403), с `Bearer` → осмысленный ответ.
Писать по документу = получить 403 и искать ошибку не там.

## Методы

| Метод | Назначение |
|---|---|
| `POST /v1/ecom/payments` | регистрация платежа → `paymentUrl` |
| `POST /v1/ecom/payments/{orderId}/cancel` | отмена И возврат (одна ручка) |
| `POST /v1/ecom/payments/{orderId}/deposit` | списание по 2-стадийной (в течение 7 суток) |
| `GET /v1/ecom/payments/{orderId}/status` | статус платежа (фоллбэк, если callback не дошёл) |
| `GET /v1/ecom/receipts/dictionaries` | словари: paymentSubjects, НДС, СНО |
| `GET /v1/ecom/receipts/agents` / `/suppliers` | агенты и поставщики (54-ФЗ) |

## Регистрация платежа

`POST /v1/ecom/payments`

Ключевые поля:
- `amount` — **сумма в КОПЕЙКАХ** (`10000` = 100 ₽)
- `orderId` — UUID заказа (допустимы цифры, латиница и `: + - _ .`)
- `sessionType` — `oneStep` (одностадийный) | `twoStep`
- `additionalProps.returnUrl` — куда вернуть покупателя
- `additionalProps.notificationUrl` — куда слать callback; **приоритет над настройками ЛК**.
  Можно добавлять свои query-параметры для идентификации заказа.
- `receipt` — блок фискализации (см. 02)
- `paymentMethods[]` — `{paymentType, bankId}`. ⚠️ Поле `bankId` верхнего уровня
  УСТАРЕЛО, приоритет у `paymentMethods`.

`paymentType`: `card` | `bank_app` | `sbp`
`bankId` для `card`: 100 Альфа-Банк, **600 Т-Банк**, 900 ГПБ
`bankId` для `sbp`: 100 Альфа, 200 Открытие, 300 Райффайзен, **400 Сбербанк**, 401 СберPay

Ответ: `{ orderId, amount, paymentUrl }`
Ошибка: `{ errorCode, errorMessage, status: "error" }`

🔴 `quantity` — **в ТЫСЯЧНЫХ** (`999000` = 999 штук). `price` — в копейках.
Это та же ловушка, на которой горели с Озоном (см. `tvuchet-ozon-kopecks-bug`).

## Статусы платежа (числовые, `paymentStatus`)

| Код | Значение | Расшифровка |
|---|---|---|
| 0 | processing | В обработке |
| 1 | success | Успех (выполнен) |
| 2 | notResponding | Банк не ответил |
| 3 | error | Ошибка, повтор невозможен |
| 4 | canceled | Отменён |
| 5 | refunded | Возвращён |
| 6 | fraud | Подозрение в мошенничестве |
| 7 | partialCancel | Частичная отмена |
| 8 | partialRefund | Частично возвращён |
| 9 | paymentIsOverdue | Платёж просрочен |
| 10 | confirm3ds | Подтверждение 3DS |
| 11 | awaitingDeposit | Ожидает списания (2-стадийная) |
| 12 | retryError | Ошибка, повтор ВОЗМОЖЕН |

## Возврат / отмена

`POST /v1/ecom/payments/{orderId}/cancel` — полный и частичный.
Доступен для статусов: Завершён, Частично отменён, Частично возвращён,
Ожидает списания. Для одностадийного возврат — через сутки после оплаты.
Также возможен вручную в ЛК: раздел «ECOM транзакции» → кнопка отмены в строке.

## Коды ошибок

`USER_NOT_FOUND`, `PERMISSION_DENIED`, `BANK_SETTINGS_NOT_FOUND`, `CARD_NOT_FOUND`,
`INVALID_ORDER_ID`, `PAYMENT_NOT_FOUND`, `PAYMENT_PROCESSED` (уже обработан),
`AUTH_ERROR` (неверный токен), `PAYMENT_EXISTS` (заказ уже существует),
`UNEXPECTED_REGISTER_PAYMENT_ERROR`, `INVALID_RECEIPT_AMOUNT` (сумма платежа
отличается от суммы позиций).
