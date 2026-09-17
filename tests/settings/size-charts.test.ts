import { describe, it, expect } from 'vitest';

import {
  SETTING_KEYS,
  SETTING_SCHEMAS,
  isSettingKey,
  parseSettingValue,
  sizeChartsSchema,
} from '@/lib/settings/schemas';
import {
  buildSizeChartsPayload,
  chartsToFormState,
  emptyChartDraft,
  emptyRowDraft,
  parseGendersText,
  type SizeChartsFormState,
} from '@/lib/settings/size-charts-form';

/**
 * Размерные сетки (ключ настроек `size_charts`).
 *
 * Функционал вернулся в кит с прода одного магазина, где жил в обход репозитория.
 * Тесты фиксируют ровно тот контракт, который делает его мультитенантным: набор
 * сеток И набор колонок произвольны, платформенный дефолт — «сеток нет», а
 * привязка сетки к полу необязательна. Компонентного рендера нет (vitest
 * environment=node, RTL в проекте отсутствует) — покрываем схему и чистый маппинг
 * «состояние формы ⇄ значение настройки».
 */
describe('settings/schemas — sizeChartsSchema', () => {
  it('ключ size_charts зарегистрирован в реестре настроек', () => {
    expect(SETTING_KEYS).toContain('size_charts');
    expect(isSettingKey('size_charts')).toBe(true);
    expect(SETTING_SCHEMAS.size_charts).toBe(sizeChartsSchema);
  });

  it('пустой объект → дефолт «сеток нет» (сид миграции 0042 кладёт именно {})', () => {
    expect(sizeChartsSchema.parse({})).toEqual({ charts: [] });
  });

  it('парсит сетку с произвольными колонками; genders по умолчанию пуст', () => {
    const parsed = sizeChartsSchema.parse({
      charts: [
        {
          id: 'women',
          title: 'Женская',
          columns: [
            { key: 'size', label: 'Размер' },
            { key: 'chest', label: 'Обхват груди' },
          ],
          rows: [{ size: 'S', chest: '84' }],
        },
      ],
      footnote: 'мерки в сантиметрах',
    });

    expect(parsed.charts[0]?.genders).toEqual([]);
    expect(parsed.charts[0]?.columns).toHaveLength(2);
    expect(parsed.footnote).toBe('мерки в сантиметрах');
  });

  it('отвергает дубль id: молча потерять одну из сеток нельзя', () => {
    const chart = {
      title: 'Сетка',
      columns: [{ key: 'size', label: 'Размер' }],
    };
    const res = sizeChartsSchema.safeParse({
      charts: [
        { ...chart, id: 'women' },
        { ...chart, id: 'women' },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('отвергает дубль ключа колонки внутри сетки (две колонки схлопнулись бы в одну ячейку)', () => {
    const res = sizeChartsSchema.safeParse({
      charts: [
        {
          id: 'women',
          title: 'Женская',
          columns: [
            { key: 'size', label: 'Размер' },
            { key: 'size', label: 'Размер (EU)' },
          ],
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('отвергает ячейку, не соответствующую ни одной колонке (мусор в jsonb и audit_log)', () => {
    const res = sizeChartsSchema.safeParse({
      charts: [
        {
          id: 'women',
          title: 'Женская',
          columns: [{ key: 'size', label: 'Размер' }],
          rows: [{ size: 'S', hips: '90' }],
        },
      ],
    });
    expect(res.success).toBe(false);
  });

  it('strip: неизвестные поля отбрасываются (анти-tamper JSONB)', () => {
    const parsed = sizeChartsSchema.parse({ charts: [], evil: '<script>' }) as Record<
      string,
      unknown
    >;
    expect(parsed.evil).toBeUndefined();
  });

  it('parseSettingValue: кривое значение из БД → null (мерж не падает, остаётся дефолт)', () => {
    expect(parseSettingValue('size_charts', { charts: 'не массив' })).toBeNull();
  });
});

describe('settings/size-charts-form — чистый маппинг формы', () => {
  it('parseGendersText: запятые и переносы строк, пустые значения отбрасываются', () => {
    expect(parseGendersText(' women , женский \n жен ,, ')).toEqual([
      'women',
      'женский',
      'жен',
    ]);
    expect(parseGendersText('   ')).toEqual([]);
  });

  it('buildSizeChartsPayload: тримит, отбрасывает пустое, и результат проходит схему', () => {
    const state: SizeChartsFormState = {
      charts: [
        {
          id: ' women ',
          title: ' Женская ',
          note: '  ',
          gendersText: 'women, женский',
          columns: [
            { key: ' size ', label: ' Размер ' },
            { key: '', label: '' }, // мусорная колонка — отбрасывается с ячейками
            { key: 'chest', label: 'Грудь' },
          ],
          rows: [
            [' S ', 'мусор', ' 84 '],
            ['', '', ''], // полностью пустая строка — отбрасывается
            ['M', '', ''], // пустые ячейки в значение не попадают
          ],
        },
        // Сетка отбрасывается только когда пусты И id, И title (id проставляется
        // автоматически при добавлении, поэтому одного пустого title мало).
        { ...emptyChartDraft(''), id: '  ' },
      ],
      footnote: '  ',
    };

    const payload = buildSizeChartsPayload(state);

    expect(payload.charts).toHaveLength(1);
    const chart = payload.charts[0]!;
    expect(chart.id).toBe('women');
    expect(chart.title).toBe('Женская');
    expect(chart.genders).toEqual(['women', 'женский']);
    expect(chart.columns).toEqual([
      { key: 'size', label: 'Размер' },
      { key: 'chest', label: 'Грудь' },
    ]);
    expect(chart.rows).toEqual([{ size: 'S', chest: '84' }, { size: 'M' }]);
    // Пустые note/footnote ОТСУТСТВУЮТ (не null и не '') — как в PublicSettingsDto.
    expect('note' in chart).toBe(false);
    expect('footnote' in payload).toBe(false);
    expect(sizeChartsSchema.safeParse(payload).success).toBe(true);
  });

  it('дубль id НЕ «чинится» формой — его должна отвергнуть схема на бэкенде', () => {
    const draft = (id: string) => ({
      id,
      title: 'Сетка',
      note: '',
      gendersText: '',
      columns: [{ key: 'size', label: 'Размер' }],
      rows: [] as string[][],
    });
    const payload = buildSizeChartsPayload({
      charts: [draft('women'), draft('women')],
      footnote: '',
    });

    expect(payload.charts).toHaveLength(2);
    expect(sizeChartsSchema.safeParse(payload).success).toBe(false);
  });

  it('round-trip: значение → форма → значение не теряет данные', () => {
    const value = sizeChartsSchema.parse({
      charts: [
        {
          id: 'men',
          title: 'Мужская',
          note: 'снимайте мерки по телу',
          genders: ['men'],
          columns: [
            { key: 'size', label: 'Размер' },
            { key: 'chest', label: 'Грудь' },
          ],
          rows: [{ size: 'L', chest: '104' }],
        },
      ],
      footnote: 'см',
    });

    expect(buildSizeChartsPayload(chartsToFormState(value))).toEqual(value);
  });

  it('ячейки в форме хранятся ПО ИНДЕКСУ: переименование key колонки не теряет данные', () => {
    const state = chartsToFormState(
      sizeChartsSchema.parse({
        charts: [
          {
            id: 'women',
            title: 'Женская',
            columns: [{ key: 'size', label: 'Размер' }],
            rows: [{ size: 'S' }],
          },
        ],
      }),
    );

    // Владелец переименовал ключ колонки — значение ячейки остаётся на месте.
    state.charts[0]!.columns[0]!.key = 'size_ru';
    const payload = buildSizeChartsPayload(state);

    expect(payload.charts[0]?.rows).toEqual([{ size_ru: 'S' }]);
  });

  it('emptyRowDraft даёт строку под текущее число колонок', () => {
    expect(emptyRowDraft(3)).toEqual(['', '', '']);
  });
});
