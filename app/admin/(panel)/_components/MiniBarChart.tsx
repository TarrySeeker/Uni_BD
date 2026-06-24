import type { DailyPoint } from '@/lib/analytics/repository';

/**
 * Минималистичный столбчатый график на чистом inline-SVG — без сторонних
 * библиотек (самохостинг + лёгкая сборка, в проекте есть ограничение по памяти
 * сборки). Серверный компонент: только разметка, без интерактива. Используется на
 * дашборде для рядов «заказы» и «посещения» (Prevki.md).
 *
 * Доступность: role="img" + aria-label с суммой; у каждого столбца <title>
 * (день: значение) для нативного тултипа.
 */
export function MiniBarChart({
  title,
  points,
  unit,
  barClassName = 'fill-gray-800',
}: {
  title: string;
  points: DailyPoint[];
  /** Слово для подписи итога, напр. «заказов» / «просмотров». */
  unit: string;
  /** Tailwind-класс заливки столбца. */
  barClassName?: string;
}) {
  const total = points.reduce((s, p) => s + p.count, 0);
  const max = points.reduce((m, p) => Math.max(m, p.count), 0);

  // Геометрия viewBox (адаптивно растягивается по ширине контейнера).
  const W = 320;
  const H = 120;
  const padX = 4;
  const padBottom = 16; // место под подписи дат
  const n = points.length || 1;
  const slot = (W - padX * 2) / n;
  const barW = Math.max(2, slot * 0.62);
  const chartH = H - padBottom;

  // Подписи дат: показываем ~7 равномерно (иначе тесно при 14 днях).
  const labelEvery = Math.max(1, Math.ceil(n / 7));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-5">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-gray-500">{title}</h2>
        <span className="text-sm text-gray-400">
          всего {total} {unit}
        </span>
      </div>

      {total === 0 ? (
        <p className="mt-6 mb-4 text-sm text-gray-400">
          Пока нет данных за период.
        </p>
      ) : (
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="mt-3 h-32 w-full"
          role="img"
          aria-label={`${title}: всего ${total} ${unit} за ${n} дней`}
          preserveAspectRatio="none"
        >
          {points.map((p, i) => {
            const h = max > 0 ? (p.count / max) * (chartH - 2) : 0;
            const x = padX + i * slot + (slot - barW) / 2;
            const y = chartH - h;
            return (
              <g key={p.day}>
                <rect
                  x={x}
                  y={y}
                  width={barW}
                  height={h}
                  rx={1}
                  className={barClassName}
                >
                  <title>{`${p.label}: ${p.count} ${unit}`}</title>
                </rect>
                {i % labelEvery === 0 ? (
                  <text
                    x={x + barW / 2}
                    y={H - 4}
                    textAnchor="middle"
                    className="fill-gray-400"
                    fontSize={8}
                  >
                    {p.label}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
