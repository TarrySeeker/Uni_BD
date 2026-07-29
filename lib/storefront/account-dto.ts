/**
 * DTO ЛК покупателя (docs/24 §6). Граница «домен → публичный ответ витрины».
 *
 * УТЕЧКА ЗАПРЕЩЕНА: наружу НЕ уходят password_hash, id сессии, внутренний uuid
 * покупателя, сырые токены. `me` отдаёт профиль без секретов; список заказов —
 * сводка с подписями статусов НА ЯЗЫКЕ ПОКУПАТЕЛЯ (единый источник
 * lib/orders/labels). Без локали — базовый ru (обратная совместимость).
 */

import {
  orderStatusLabel,
  paymentStatusLabel,
  deliveryStatusLabel,
} from '@/lib/orders/labels';
import type { Customer } from '@/lib/customer-auth/types';
import type { CustomerOrderSummary } from '@/lib/customer-auth/repository';

/** Публичный профиль покупателя (GET /account/me). Без id/секретов/таймстампов. */
export interface CustomerMeDto {
  email: string;
  name: string;
  phone: string | null;
  status: Customer['status'];
  emailVerified: boolean;
  preferredLocale: string | null;
  ordersCount: number;
  totalSpent: string;
}

export function toCustomerMeDto(c: Customer): CustomerMeDto {
  return {
    email: c.email,
    name: c.name,
    phone: c.phone,
    status: c.status,
    emailVerified: c.emailVerifiedAt !== null,
    preferredLocale: c.preferredLocale,
    ordersCount: c.ordersCount,
    totalSpent: c.totalSpent,
  };
}

/** Сводка заказа в ЛК (GET /account/orders). Внутренние id/токены скрыты. */
export interface CustomerOrderDto {
  number: string;
  status: string;
  statusLabel: string;
  paymentStatus: string;
  paymentStatusLabel: string;
  deliveryStatus: string;
  deliveryStatusLabel: string;
  grandTotal: string;
  currency: string;
  createdAt: string;
}

/**
 * Сводка заказа → DTO ЛК. `locale` — язык ПОКУПАТЕЛЯ (из `?locale=`, вычислен
 * runStorefront); не задан → базовый ru, как было до локализации.
 */
export function toCustomerOrderDto(
  o: CustomerOrderSummary,
  locale?: string | null,
): CustomerOrderDto {
  return {
    number: o.number,
    status: o.status,
    statusLabel: orderStatusLabel(o.status, locale),
    paymentStatus: o.paymentStatus,
    paymentStatusLabel: paymentStatusLabel(o.paymentStatus, locale),
    deliveryStatus: o.deliveryStatus,
    deliveryStatusLabel: deliveryStatusLabel(o.deliveryStatus, locale),
    grandTotal: o.grandTotal,
    currency: o.currency,
    createdAt: o.createdAt.toISOString(),
  };
}
