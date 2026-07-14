/**
 * Хлебные крошки — порт frontend/views/misc_blocks/_breadcrumbs.twig (классы
 * .breadcrumbs / .breadcrumbs__colon / .breadcrumbs-mh* сохранены 1:1).
 */

export interface Crumb {
  label: string;
  href?: string;
}

export default function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <div className="breadcrumbs">
      <a href="/" className={items.length > 1 ? 'breadcrumbs-mh' : undefined}>
        Главная
      </a>
      {items.map((bc, i) => {
        const last = i === items.length - 1;
        return (
          <span key={`${bc.label}-${i}`}>
            <span className="breadcrumbs__colon breadcrumbs-mh">›</span>
            {bc.href && !last ? (
              <a href={bc.href} className="breadcrumbs-mha">
                {bc.label}
              </a>
            ) : (
              <span className="breadcrumbs-mha">{bc.label}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
