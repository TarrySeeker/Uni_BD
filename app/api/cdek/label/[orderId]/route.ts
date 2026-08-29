/**
 * Прокси PDF накладной/ШК СДЭК для админки.
 *
 * 🔴 ЗАЧЕМ ОТДЕЛЬНЫЙ РОУТ, а не прямая ссылка из `cdek_shipments.print_url`.
 * URL печати, который возвращает СДЭК
 * (https://api.cdek.ru/v2/print/orders/<uuid>.pdf), требует заголовка
 * `Authorization: Bearer <token>`. Открытие такой ссылки в новой вкладке —
 * запрос БЕЗ заголовка, и СДЭК отвечает 401 (проверено живьём 2026-08-29:
 * без токена → 401 JSON, с токеном → application/pdf, 91 КБ).
 * Поэтому оператору отдаём PDF через собственный роут: он сам сходит в СДЭК
 * с токеном и отдаст файл в браузер.
 *
 * Доступ: только авторизованный пользователь с правом `cdek.manage` —
 * накладная содержит ПДн получателя (имя, телефон, адрес), в открытый доступ
 * её отдавать нельзя.
 *
 *   GET /api/cdek/label/<orderId>?kind=waybill|barcode
 */

import { NextResponse, type NextRequest } from 'next/server';

import { getCurrentUser } from '@/lib/auth/session';
import { can } from '@/lib/auth/rbac';
import { getCdekManager } from '@/lib/cdek/manager';
import { PrintService } from '@/lib/cdek/services/print';

export const dynamic = 'force-dynamic';

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ orderId: string }> },
): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }
  if (!can(user, 'cdek.manage')) {
    return NextResponse.json({ ok: false, error: 'forbidden' }, { status: 403 });
  }

  const { orderId } = await ctx.params;
  const kind = req.nextUrl.searchParams.get('kind') === 'barcode' ? 'barcode' : 'waybill';

  try {
    const { url } = await new PrintService().getShipmentLabel(orderId, { kind });

    const manager = getCdekManager();
    // MOCK-режим: реального PDF нет — отдаём понятное объяснение, а не битый файл.
    if (manager.isMock) {
      return NextResponse.json(
        { ok: false, error: 'cdek_mock_mode', message: 'MOCK-режим СДЭК: реальной накладной нет.' },
        { status: 409 },
      );
    }

    const token = await manager.client.getToken();
    const upstream = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });

    if (!upstream.ok) {
      return NextResponse.json(
        { ok: false, error: 'cdek_pdf_fetch_failed', status: upstream.status },
        { status: 502 },
      );
    }

    const body = await upstream.arrayBuffer();
    const filename = kind === 'barcode' ? `barcode-${orderId}.pdf` : `waybill-${orderId}.pdf`;

    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        // inline — чтобы открывалось во вкладке, а не скачивалось молча.
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown';
    return NextResponse.json({ ok: false, error: 'cdek_print_failed', message }, { status: 502 });
  }
}
