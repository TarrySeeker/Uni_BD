'use server';

import {
  issueGiftCertificate,
  updateGiftCertificate,
  setGiftStatus,
} from '@/lib/gift-certificates';
import type { ActionResult } from '@/lib/server/action';

/**
 * Тонкие серверные обёртки над Server Actions сертификатов (lib/gift-certificates).
 * Бизнес-логика, guard (gift.write), Zod, аудит и инвалидация — внутри defineAction;
 * здесь только проксирование для клиентских форм ('use client').
 */

export async function issueGiftCertificateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return issueGiftCertificate(input);
}

export async function updateGiftCertificateAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  return updateGiftCertificate(input);
}

export async function setGiftStatusAction(
  input: unknown,
): Promise<ActionResult<{ id: string; status: string }>> {
  return setGiftStatus(input);
}
