import {
  GIFT_SETTINGS_DEFAULTS,
  resolveGiftSettings,
  type ResolvedGiftSettings,
} from '@/lib/settings/schemas';

/**
 * Чистая логика формы «Подарочные сертификаты» (ТЗ владельца п.11).
 *
 * Вынесена из компонента: тестов React-компонентов в проекте нет (vitest env
 * 'node'), поэтому вся конвертация «поля формы ↔ значение настройки» живёт здесь
 * и покрыта юнитами. Модуль НЕ серверный: импортирует только схемы (zod) и не
 * тянет БД — безопасен для клиентского бандла.
 */

/** Состояние полей формы (всё — строки/флаги, как в DOM). */
export interface GiftFormState {
  autoIssue: boolean;
  /** Срок действия кода в днях; пустая строка = бессрочно. */
  validDaysText: string;
  /** Адреса разделов каталога через запятую/с новой строки. */
  categorySlugsText: string;
  allowIssueOnGiftPaidOrder: boolean;
}

export type BuildResult =
  | { ok: true; value: { gift: ResolvedGiftSettings } }
  | { ok: false; error: string };

/** Сохранённое значение (оверрайд) → начальное состояние полей формы. */
export function giftFormStateFrom(saved: unknown): GiftFormState {
  const eff = resolveGiftSettings(saved);
  return {
    autoIssue: eff.autoIssue,
    // Бессрочный срок показываем ПУСТЫМ полем: «0 дней» владелец читает как ошибку.
    validDaysText: eff.validDays > 0 ? String(eff.validDays) : '',
    categorySlugsText: eff.categorySlugs.join(', '),
    allowIssueOnGiftPaidOrder: eff.allowIssueOnGiftPaidOrder,
  };
}

/** Строка «а, б\nв» → нормализованный список без пустых и дублей. */
export function parseCategorySlugs(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(/[,\n]/)) {
    const slug = part.trim();
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/** Состояние формы → payload действия. Ошибку показываем владельцу словами. */
export function buildGiftPayload(state: GiftFormState): BuildResult {
  const raw = state.validDaysText.trim();
  let validDays = 0;
  if (raw !== '') {
    // Только целое без экспонент/плюсов: '1e3'/'1.5'/'-5' — не срок в днях.
    if (!/^\d+$/.test(raw)) {
      return { ok: false, error: 'Срок действия — целое число дней (0 или пусто — бессрочно).' };
    }
    validDays = Number(raw);
    if (!Number.isSafeInteger(validDays)) {
      return { ok: false, error: 'Срок действия слишком большой — укажите разумное число дней.' };
    }
  }

  return {
    ok: true,
    value: {
      gift: {
        autoIssue: state.autoIssue,
        validDays,
        categorySlugs: parseCategorySlugs(state.categorySlugsText),
        allowIssueOnGiftPaidOrder: state.allowIssueOnGiftPaidOrder,
      },
    },
  };
}

/** Дефолты платформы — для подсказок в форме (плейсхолдеры), без хардкода. */
export const GIFT_FORM_DEFAULTS = GIFT_SETTINGS_DEFAULTS;
