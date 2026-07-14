/**
 * DTO ЛК покупателя (docs/24 §6). Граница «домен → публичный ответ витрины».
 *
 * УТЕЧКА ЗАПРЕЩЕНА: наружу НЕ уходят password_hash, id сессии, внутренний uuid
 * покупателя, сырые токены. `me` отдаёт профиль без секретов; список заказов —
 * сводка с русскими подписями статусов (единый источник lib/orders/labels).
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

export function toCustomerOrderDto(o: CustomerOrderSummary): CustomerOrderDto {
  return {
    number: o.number,
    status: o.status,
    statusLabel: orderStatusLabel(o.status),
    paymentStatus: o.paymentStatus,
    paymentStatusLabel: paymentStatusLabel(o.paymentStatus),
    deliveryStatus: o.deliveryStatus,
    deliveryStatusLabel: deliveryStatusLabel(o.deliveryStatus),
    grandTotal: o.grandTotal,
    currency: o.currency,
    createdAt: o.createdAt.toISOString(),
  };
}
