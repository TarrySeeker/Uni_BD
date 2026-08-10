'use server';

import { z } from 'zod';

import { defineAction, PublicActionError } from '@/lib/server/action';
import { isModuleEffectivelyEnabled } from '@/lib/config/settings';
import {
  ensureWebhookSubscription,
  type WebhookSubscriptionReport,
} from '@/lib/cdek/services/webhook';

/**
 * Server Action «Проверить подписку на вебхуки» раздела /admin/cdek (боевой
 * гэп №2 аудита 2026-07-09: POST /v2/webhooks нигде не вызывался — в боевом
 * режиме вебхуки СДЭК не приходили вообще).
 *
 * Пайплайн defineAction (docs/04 §4.7): guard (cdek.manage) → Zod → handler
 * (идемпотентная ensureWebhookSubscription: GET /v2/webhooks → сравнение →
 * POST недостающих / пересоздание НАШИХ устаревших; чужие url не трогаются) →
 * audit `cdek.webhook.subscription.ensure`. Инвалидация путей не нужна —
 * состояние живёт в кабинете СДЭК, страница ничего не кеширует.
 *
 * Отчёт безопасен для UI/аудита: секрет вебхука в URL маскируется (key=***)
 * внутри сервиса. В mock-режиме — no-op с mock:true (кнопка поясняет).
 */
export const ensureCdekWebhookSubscription = defineAction<
  Record<string, never>,
  WebhookSubscriptionReport
>({
  permission: 'cdek.manage',
  input: z.object({}).strip() as z.ZodType<Record<string, never>>,
  handler: async () => {
    if (!(await isModuleEffectivelyEnabled('cdek'))) {
      throw new PublicActionError('Модуль «СДЭК» выключен.');
    }
    const report = await ensureWebhookSubscription();
    return {
      result: report,
      audit: {
        action: 'cdek.webhook.subscription.ensure',
        entityType: 'cdek_webhook',
        entityId: 'subscription',
        after: {
          mock: report.mock,
          targetUrl: report.targetUrl,
          created: report.created,
          kept: report.kept,
          deleted: report.deleted,
          errors: report.errors,
        },
      },
    };
  },
});
