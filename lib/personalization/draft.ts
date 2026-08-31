/**
 * Черновик описания персонализации — то, что владелец заполняет в форме товара,
 * и его сборка в готовое описание (`PersonalizationSpec`).
 *
 * Вынесено из компонента намеренно: это чистая функция, её можно проверить
 * тестами без React и без браузера, а форма остаётся тонкой.
 *
 * Главное правило сборки — **громкий отказ вместо тихой потери** (docs/32 §3).
 * Репитер, который сам выбрасывал не до конца заполненные строки и рапортовал
 * «сохранено», уже стоил боевому магазину исчезнувших данных: владелец видел
 * успех, а запись пропадала после перезагрузки. Поэтому неполное поле здесь не
 * отбрасывается, а останавливает сохранение с указанием, что именно дозаполнить.
 */

import { slugify } from '@/lib/catalog/slug';

import {
  MAX_FIELDS,
  MAX_LINES,
  MAX_OPTIONS,
  MAX_TEXT_LENGTH,
  PersonalizationSpecSchema,
  type PersonalizationField,
  type PersonalizationSpec,
} from './schemas';

export type FieldType = PersonalizationField['type'];

/**
 * Одно поле в форме. Числа хранятся строками: это состояние `<input>`, и
 * пустая строка должна отличаться от нуля, иначе «поле не заполнено» станет
 * неотличимо от «предел 0 знаков».
 */
export type FieldDraft = {
  /**
   * Технический ключ. Владельцу не показывается и им не заполняется — он
   * выводится из подписи при добавлении поля и дальше НЕ меняется. Если бы ключ
   * пересчитывался при каждой правке подписи, переименование «Надпись» →
   * «Гравировка» меняло бы контракт с витриной на ровном месте.
   */
  key: string;
  type: FieldType;
  label: string;
  hint: string;
  required: boolean;
  /** Только для text_lines. */
  lines: string;
  /** Для text и text_lines. */
  maxLength: string;
  /** Только для select: по строке на вариант, «код|подпись» либо просто «подпись». */
  options: string;
  /** Только для select. */
  allowEmpty: boolean;
  emptyLabel: string;
};

export type BuildResult =
  | { ok: true; spec: PersonalizationSpec | null }
  | { ok: false; message: string };

/** Пустое поле по умолчанию: три строки по 20 знаков — самый частый случай. */
export function emptyFieldDraft(type: FieldType = 'text_lines'): FieldDraft {
  return {
    key: '',
    type,
    label: '',
    hint: '',
    required: false,
    lines: '3',
    maxLength: '20',
    options: '',
    allowEmpty: true,
    emptyLabel: '',
  };
}

/**
 * Ключ из подписи. Кириллица транслитерируется (тем же slugify, что и ЧПУ),
 * дефисы меняются на подчёркивания — ключ уходит в JSON и должен быть
 * идентификатором. Если после транслитерации ничего не осталось (подпись из
 * одних знаков препинания), берётся порядковый `field_N`.
 */
export function keyFromLabel(label: string, index: number, taken: Set<string>): string {
  const base = slugify(label).replace(/-/g, '_').replace(/^[^a-z]+/i, '');
  let key = base || `field_${index + 1}`;
  let n = 2;
  while (taken.has(key)) {
    key = `${base || `field_${index + 1}`}_${n}`;
    n += 1;
  }
  return key;
}

/** Разбор строки вариантов select: «hoop|Обруч» либо просто «Обруч». */
function parseOptions(
  raw: string,
  fieldLabel: string,
): { ok: true; options: { value: string; label: string }[] } | { ok: false; message: string } {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) {
    return { ok: false, message: `Поле «${fieldLabel}»: добавьте хотя бы один вариант выбора.` };
  }
  if (lines.length > MAX_OPTIONS) {
    return { ok: false, message: `Поле «${fieldLabel}»: не больше ${MAX_OPTIONS} вариантов.` };
  }

  const options: { value: string; label: string }[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const [left, right] = line.includes('|')
      ? [line.slice(0, line.indexOf('|')).trim(), line.slice(line.indexOf('|') + 1).trim()]
      : [null, line];

    const label = right;
    if (!label) {
      return { ok: false, message: `Поле «${fieldLabel}»: у варианта «${line}» пустая подпись.` };
    }
    const value = left || keyFromLabel(label, options.length, seen);
    if (seen.has(value)) {
      return {
        ok: false,
        message: `Поле «${fieldLabel}»: код варианта «${value}» повторяется.`,
      };
    }
    seen.add(value);
    options.push({ value, label });
  }

  return { ok: true, options };
}

function parseLimit(
  raw: string,
  max: number,
  fieldLabel: string,
  what: string,
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return { ok: false, message: `Поле «${fieldLabel}»: укажите ${what}.` };
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > max) {
    return {
      ok: false,
      message: `Поле «${fieldLabel}»: ${what} — целое число от 1 до ${max}.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Собирает описание из черновика формы.
 *
 * `enabled = false` → `null`: товар не персонализируется. Черновик при этом не
 * стирается — владелец может выключить персонализацию и вернуть её обратно, не
 * набирая поля заново.
 */
export function buildSpecFromDraft(enabled: boolean, drafts: FieldDraft[]): BuildResult {
  if (!enabled) return { ok: true, spec: null };

  if (drafts.length === 0) {
    return {
      ok: false,
      message: 'Добавьте хотя бы одно поле — либо выключите персонализацию у товара.',
    };
  }
  if (drafts.length > MAX_FIELDS) {
    return { ok: false, message: `Не больше ${MAX_FIELDS} полей персонализации.` };
  }

  const fields: PersonalizationField[] = [];
  const takenKeys = new Set<string>();

  for (let i = 0; i < drafts.length; i++) {
    const draft = drafts[i]!;
    const label = draft.label.trim();
    if (!label) {
      return { ok: false, message: `Поле ${i + 1}: заполните подпись — её увидит покупатель.` };
    }

    const key = draft.key.trim() || keyFromLabel(label, i, takenKeys);
    if (takenKeys.has(key)) {
      return { ok: false, message: `Поле «${label}»: такое поле уже есть.` };
    }
    takenKeys.add(key);

    const common = {
      key,
      label,
      required: draft.required,
      ...(draft.hint.trim() ? { hint: draft.hint.trim() } : {}),
    };

    switch (draft.type) {
      case 'text': {
        const max = parseLimit(draft.maxLength, MAX_TEXT_LENGTH, label, 'предел знаков');
        if (!max.ok) return max;
        fields.push({ ...common, type: 'text', maxLength: max.value });
        break;
      }
      case 'text_lines': {
        const lines = parseLimit(draft.lines, MAX_LINES, label, 'число строк');
        if (!lines.ok) return lines;
        const max = parseLimit(draft.maxLength, MAX_TEXT_LENGTH, label, 'предел знаков в строке');
        if (!max.ok) return max;
        fields.push({
          ...common,
          type: 'text_lines',
          lines: lines.value,
          maxLength: max.value,
        });
        break;
      }
      case 'select': {
        const options = parseOptions(draft.options, label);
        if (!options.ok) return options;
        fields.push({
          ...common,
          type: 'select',
          options: options.options,
          allowEmpty: draft.allowEmpty,
          ...(draft.emptyLabel.trim() ? { emptyLabel: draft.emptyLabel.trim() } : {}),
        });
        break;
      }
      case 'color': {
        fields.push({ ...common, type: 'color' });
        break;
      }
    }
  }

  // Финальная сверка той же схемой, что валидирует значение из БД: форма и
  // рантайм не должны расходиться в том, что считается корректным описанием
  // (docs/32 §3 — «два расходящихся набора дефолтов»).
  const parsed = PersonalizationSpecSchema.safeParse({ fields });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Описание полей некорректно.' };
  }
  return { ok: true, spec: parsed.data };
}

/** Обратное преобразование: сохранённое описание → черновик для формы. */
export function draftFromSpec(spec: PersonalizationSpec | null): FieldDraft[] {
  if (spec === null) return [];
  return spec.fields.map((field) => {
    const base: FieldDraft = {
      ...emptyFieldDraft(field.type),
      key: field.key,
      type: field.type,
      label: field.label,
      hint: field.hint ?? '',
      required: field.required,
      lines: '',
      maxLength: '',
      options: '',
      allowEmpty: false,
      emptyLabel: '',
    };
    if (field.type === 'text') {
      return { ...base, maxLength: String(field.maxLength) };
    }
    if (field.type === 'text_lines') {
      return { ...base, lines: String(field.lines), maxLength: String(field.maxLength) };
    }
    if (field.type === 'select') {
      return {
        ...base,
        options: field.options.map((o) => `${o.value}|${o.label}`).join('\n'),
        allowEmpty: field.allowEmpty,
        emptyLabel: field.emptyLabel ?? '',
      };
    }
    return base;
  });
}
