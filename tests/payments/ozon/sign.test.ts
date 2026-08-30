/**
 * Тесты подписей Ozon Acquiring на КОНТРОЛЬНЫХ ПРИМЕРАХ из документации.
 *
 * Значения взяты из спеки (docs-ozon/01, 02) — они тестовые и доступа к боевому
 * сервису не дают. Эти тесты — страховка от молчаливой поломки подписи: при
 * неверной подписи Ozon возвращает код 16 (Unauthenticated) с HTTP 400, что
 * легко спутать с ошибкой валидации данных.
 */

import { describe, it, expect } from "vitest";
import {
  signCreateOrder,
  signOrderLookup,
  signCancelOrder,
  signRefundOrder,
  notificationSign,
  requestSign,
  safeEqualHex,
} from "@/lib/payments/ozon/sign";

const ACCESS_KEY = "63fd43a4-f16d-4c3a-9bdf-50f2328781db";
const SECRET_KEY = "PnHtbKc0lLiTlo4WITnWB44Qb1kpygRl";

describe("подпись запроса (sha256, без разделителей)", () => {
  it("createOrder совпадает с контрольным примером документации", () => {
    const sign = signCreateOrder({
      accessKey: ACCESS_KEY,
      expiresAt: "2025-10-01T20:00:00.000Z",
      extId: "MyOrderID-1",
      fiscalizationType: "FISCAL_TYPE_SINGLE",
      paymentAlgorithm: "PAY_ALGO_SMS",
      currencyCode: "643",
      value: "100",
      secretKey: SECRET_KEY,
    });
    expect(sign).toBe("406d29c45ffcb991eb40c3fbce98e714c1ed8963fee0024d7c3ba80dabc407bd");
  });

  it("пустые необязательные поля входят в строку как пустая строка", () => {
    // Спека: expiresAt и fiscalizationType «могут быть пустыми», но своё место
    // в конкатенации сохраняют. Пропуск поля дал бы другую подпись и код 16.
    const withEmpty = signCreateOrder({
      accessKey: ACCESS_KEY,
      expiresAt: null,
      extId: "X-1",
      fiscalizationType: null,
      paymentAlgorithm: "PAY_ALGO_SMS",
      currencyCode: "643",
      value: "100",
      secretKey: SECRET_KEY,
    });
    const manual = requestSign([ACCESS_KEY, "", "X-1", "", "PAY_ALGO_SMS", "643", "100"], SECRET_KEY);
    expect(withEmpty).toBe(manual);
  });

  it("порядок полей различается по методам", () => {
    const lookup = signOrderLookup({ id: "A", extId: "B", accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
    const cancel = signCancelOrder({ id: "A", accessKey: ACCESS_KEY, secretKey: SECRET_KEY });
    expect(lookup).not.toBe(cancel);
    expect(lookup).toBe(requestSign(["A", "B", ACCESS_KEY], SECRET_KEY));
    expect(cancel).toBe(requestSign(["A", ACCESS_KEY], SECRET_KEY));
  });

  it("refundOrder включает сумму", () => {
    const sign = signRefundOrder({
      id: "ord-1", extId: "ref-1", accessKey: ACCESS_KEY,
      currencyCode: "643", value: "500", secretKey: SECRET_KEY,
    });
    expect(sign).toBe(requestSign(["ord-1", "ref-1", ACCESS_KEY, "643", "500"], SECRET_KEY));
  });
});

describe("подпись уведомления (sha256 через |, отдельный ключ)", () => {
  it("совпадает с контрольным примером документации", () => {
    const sign = notificationSign({
      accessKey: "1fac5a70-0ec4-4963-a33a-040ea301ea85",
      orderID: "69f37767-8a8b-4de1-a601-384387aea8c4",
      transactionID: 6981437,
      extOrderID: "",
      amount: 52569,
      currencyCode: "643",
      notificationSecretKey: "4qEzUJjBoCXwA6P5NMyrJJUdA6xsnvbV",
    });
    expect(sign).toBe("ae3c635dd72ec6b2c7833aa7458d57827895a57d4c35fba0e7dcb48f1d367d5f");
  });

  it("отличается от подписи запроса при тех же данных", () => {
    // Защита от подмены схемы: у вебхука ДРУГОЙ формат (разделители "|") и
    // ДРУГОЙ ключ. Спутать их — значит принимать чужие уведомления.
    const notif = notificationSign({
      accessKey: ACCESS_KEY, orderID: "A", transactionID: "1", extOrderID: "B",
      amount: 100, currencyCode: "643", notificationSecretKey: SECRET_KEY,
    });
    const req = requestSign([ACCESS_KEY, "A", "1", "B", "100", "643"], SECRET_KEY);
    expect(notif).not.toBe(req);
  });
});

describe("safeEqualHex", () => {
  it("сравнивает без учёта регистра и пробелов", () => {
    const hex = "ae3c635dd72ec6b2c7833aa7458d57827895a57d4c35fba0e7dcb48f1d367d5f";
    expect(safeEqualHex(hex.toUpperCase(), hex)).toBe(true);
    expect(safeEqualHex(` ${hex} `, hex)).toBe(true);
  });

  it("отвергает пустое, разную длину и неверное значение", () => {
    const hex = "ae3c635dd72ec6b2c7833aa7458d57827895a57d4c35fba0e7dcb48f1d367d5f";
    expect(safeEqualHex(undefined, hex)).toBe(false);
    expect(safeEqualHex("", hex)).toBe(false);
    expect(safeEqualHex("abc", hex)).toBe(false);
    expect(safeEqualHex(hex.replace(/.$/, "0"), hex)).toBe(false);
  });
});
