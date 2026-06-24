/**
 * PrintService — печать накладной/ШК (docs/08 §7.3, порт carre PrintService.php).
 *
 * Печать в СДЭК двухшаговая: POST задачи (получаем printUuid) → GET URL PDF
 * (опрос, URL появляется не сразу). getShipmentLabel делает оба шага с короткой
 * ре-попыткой опроса и возвращает URL.
 *
 * Выбор источника — по manager.isMock:
 *   • mock → mockPrintUrl() (фейковый PDF-URL, без сети);
 *   • real → /v2/print/orders (накладная) | /v2/print/barcodes (ШК).
 */

import type { CdekManager } from '../manager';
import { getCdekManager } from '../manager';
import { CdekError } from '../errors';
import { getShipmentByOrderId, updateShipmentByOrderId } from '../repository';

export type PrintFormat = 'A4' | 'A5' | 'A6';

interface PrintEntityRaw {
  entity?: { uuid?: string };
  url?: string;
}

/** Пауза между опросами URL печати (мс). */
const POLL_DELAY_MS = 400;
const POLL_ATTEMPTS = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class PrintService {
  constructor(private readonly manager: CdekManager = getCdekManager()) {}

  /** Запрос задачи на накладную (POST /v2/print/orders) → printUuid. */
  async requestWaybill(orderUuid: string, copyCount = 1): Promise<string> {
    const raw = await this.manager.client.request<PrintEntityRaw>('POST', '/v2/print/orders', {
      json: { orders: [{ order_uuid: orderUuid }], copy_count: copyCount },
    });
    const uuid = raw?.entity?.uuid;
    if (!uuid) throw new CdekError('cdek_print_no_uuid', 'СДЭК не вернул uuid задачи печати накладной.');
    return uuid;
  }

  /** Опрос URL готовой накладной (GET /v2/print/orders/{uuid}) → url|null. */
  async getWaybillUrl(printUuid: string): Promise<string | null> {
    const raw = await this.manager.client.request<PrintEntityRaw>(
      'GET',
      `/v2/print/orders/${printUuid}`,
    );
    return typeof raw?.url === 'string' ? raw.url : null;
  }

  /** Запрос задачи на ШК (POST /v2/print/barcodes) → printUuid. */
  async requestBarcode(orderUuid: string, format: PrintFormat = 'A6', copyCount = 1): Promise<string> {
    const raw = await this.manager.client.request<PrintEntityRaw>('POST', '/v2/print/barcodes', {
      json: { orders: [{ order_uuid: orderUuid }], format, copy_count: copyCount },
    });
    const uuid = raw?.entity?.uuid;
    if (!uuid) throw new CdekError('cdek_print_no_uuid', 'СДЭК не вернул uuid задачи печати ШК.');
    return uuid;
  }

  /** Опрос URL готового ШК (GET /v2/print/barcodes/{uuid}) → url|null. */
  async getBarcodeUrl(printUuid: string): Promise<string | null> {
    const raw = await this.manager.client.request<PrintEntityRaw>(
      'GET',
      `/v2/print/barcodes/${printUuid}`,
    );
    return typeof raw?.url === 'string' ? raw.url : null;
  }

  /** Опрос URL с короткой ре-попыткой (URL готов не мгновенно). */
  private async pollUrl(get: () => Promise<string | null>): Promise<string | null> {
    for (let i = 0; i < POLL_ATTEMPTS; i++) {
      const url = await get();
      if (url) return url;
      if (i < POLL_ATTEMPTS - 1) await sleep(POLL_DELAY_MS);
    }
    return null;
  }

  /**
   * Главный метод: URL накладной (по умолчанию) либо ШК для заказа (docs/08 §7.3).
   * mock → фейковый PDF-URL; real → двухшаговый запрос+опрос. Сохраняет URL в
   * cdek_shipments.print_url. Требует созданного отправления (cdek_uuid).
   */
  async getShipmentLabel(
    orderId: string,
    opts: { kind?: 'waybill' | 'barcode'; format?: PrintFormat; copyCount?: number } = {},
  ): Promise<{ url: string }> {
    const kind = opts.kind ?? 'waybill';

    if (this.manager.isMock) {
      const url = this.manager.mock.mockPrintUrl();
      await updateShipmentByOrderId(orderId, { printUrl: url }).catch(() => {});
      return { url };
    }

    const shipment = await getShipmentByOrderId(orderId);
    if (!shipment?.cdekUuid) {
      throw new CdekError(
        'cdek_no_shipment',
        `Для заказа ${orderId} нет отправления (cdek_uuid) для печати.`,
      );
    }

    let url: string | null;
    if (kind === 'barcode') {
      const printUuid = await this.requestBarcode(shipment.cdekUuid, opts.format, opts.copyCount);
      url = await this.pollUrl(() => this.getBarcodeUrl(printUuid));
    } else {
      const printUuid = await this.requestWaybill(shipment.cdekUuid, opts.copyCount);
      url = await this.pollUrl(() => this.getWaybillUrl(printUuid));
    }

    if (!url) {
      throw new CdekError('cdek_print_not_ready', 'PDF печати ещё не готов (повторите позже).');
    }

    await updateShipmentByOrderId(orderId, { printUrl: url });
    return { url };
  }
}
