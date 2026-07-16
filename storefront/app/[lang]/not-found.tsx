/**
 * 404 витрины carre внутри сегмента локали. Рендерится внутри [lang]/layout.tsx
 * (шапка/меню/футер сохраняются). notFound() из страниц (товар/категория/CMS не
 * найдены) приводит сюда. Ссылка «в каталог» ведёт на корень (ru) — на клиенте
 * middleware/навигация сохранит текущий префикс через обычные внутренние ссылки.
 */

export default function NotFound() {
  return (
    <div className="sf-cms-page">
      <div className="page-title">
        <h1>404</h1>
      </div>
      <div className="sf-empty">
        Страница не найдена. <a href="/catalog">Перейти в каталог →</a>
      </div>
    </div>
  );
}
