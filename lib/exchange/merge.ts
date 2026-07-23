/**
 * Слияние значений ключа настроек `exchange` — защита от гонки read-modify-write.
 *
 * ПРОБЛЕМА. Ключ exchange хранится одним JSONB-документом, и оба писателя (ночной
 * крон ЦБ и форма админки) делают read → modify → write целиком. Между чтением и
 * записью крона владелец успевает нажать «Сохранить» — и запись крона откатывает
 * его правку. Раньше терялся только курс (следующий прогон его всё равно перезапишет),
 * а с ПЕР-ВАЛЮТНЫМ признаком manualRate потеря молчаливая и стойкая: валюта
 * возвращается на автокурс, и владелец узнаёт об этом только по «уехавшей» цене.
 *
 * ВЫБОР РЕШЕНИЯ. Оптимистичная блокировка (версия/updated_at в WHERE) требует
 * изменения контракта репозитория настроек и колонки версии — а миграции в этом
 * треке вне зоны (всё живёт в JSONB shop_settings). Поэтому берётся более дешёвый
 * и достаточный для двух писателей вариант: ПОЛЕВОЕ СЛИЯНИЕ НА МОМЕНТ ЗАПИСИ —
 * непосредственно перед upsert читается свежий снимок, и он объявляется
 * авторитетным по всему, кроме собственно курсов автоматических валют. Крон по
 * построению меняет ровно одно поле (rate + своя метка), поэтому слияние по коду
 * валюты закрывает гонку без версионирования. Остаточное окно (сохранение ровно
 * между re-read и upsert) сузилось до долей миллисекунды и не приводит к потере
 * признака: свежий снимок читается последним.
 */

import type { DisplayCurrencySetting, ExchangeSettings } from '@/lib/settings/schemas';
import { isManualRate } from './cron';

/** Индекс валют по ISO-коду. */
function byCode(list: readonly DisplayCurrencySetting[]): Map<string, DisplayCurrencySetting> {
  return new Map(list.map((c) => [c.code, c]));
}

/**
 * Итог прогона крона поверх СВЕЖЕГО снимка настроек.
 *
 * Авторитет свежего снимка: состав валют, autoRate, признаки manualRate и все
 * прочие поля. От крона берётся ТОЛЬКО rate (и его метка) и ТОЛЬКО для валют,
 * которые в свежем снимке остались автоматическими. Валюта, помеченная ручной
 * во время прогона, не трогается; добавленная — не исчезает; удалённая — не
 * воскресает.
 */
export function mergeCronRates(
  latest: ExchangeSettings,
  computed: readonly DisplayCurrencySetting[],
): ExchangeSettings {
  const fresh = latest.displayCurrencies ?? [];
  const computedByCode = byCode(computed);

  return {
    ...latest,
    displayCurrencies: fresh.map((c) => {
      if (isManualRate(c)) return c;
      const upd = computedByCode.get(c.code);
      if (!upd) return c;
      return upd.rateUpdatedAt !== undefined
        ? { ...c, rate: upd.rate, rateUpdatedAt: upd.rateUpdatedAt }
        : { ...c, rate: upd.rate };
    }),
  };
}

/**
 * Пер-валютные метки при РУЧНОМ сохранении формы.
 *
 * Метка обновляется только у валют, чей курс реально изменился (или которых
 * раньше не было). Иначе сохранение любой соседней настройки выдавало бы
 * подтянутый кроном автокурс за «только что введённый вручную».
 */
export function stampManualSave(
  previous: ExchangeSettings,
  incoming: readonly DisplayCurrencySetting[],
  now: string,
): DisplayCurrencySetting[] {
  const prev = byCode(previous.displayCurrencies ?? []);
  return incoming.map((c) => {
    const before = prev.get(c.code);
    if (before && before.rate === c.rate) {
      // Курс не менялся — сохраняем прежнюю метку (её может не быть вовсе).
      return before.rateUpdatedAt !== undefined
        ? { ...c, rateUpdatedAt: before.rateUpdatedAt }
        : c;
    }
    return { ...c, rateUpdatedAt: now };
  });
}
