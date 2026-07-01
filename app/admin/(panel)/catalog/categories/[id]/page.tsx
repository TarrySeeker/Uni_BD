import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getCategoryTree } from '@/lib/catalog/repository';
import type { CategoryTreeNode } from '@/lib/catalog/types';

import { Forbidden } from '../../../_components/Forbidden';
import { guardCatalog } from '../../_components/guard';
import { CategoryForm } from '../../_components/CategoryForm';

/**
 * Карточка категории (тупик C13 — SEO/OG-поля категории недоступны в дереве).
 * Чтение — catalog.read; правки — catalog.write (проверяется в Server Action).
 * Данные берём из getCategoryTree (узел уже несёт description/SEO/OG-поля —
 * отдельный запрос не нужен).
 *
 * force-dynamic: читает БД/cookies — не пререндерить при build.
 */
export const dynamic = 'force-dynamic';

/** Поиск узла по id в дереве категорий (узлы несут все поля Category). */
function findNode(nodes: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const found = findNode(n.children, id);
    if (found) return found;
  }
  return null;
}

export default async function CategoryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const guard = await guardCatalog('catalog.read');
  if (!guard.ok) {
    if (guard.reason === 'module_disabled') {
      return <Forbidden permission="catalog (модуль выключен)" />;
    }
    return <Forbidden permission={guard.permission} />;
  }

  const { id } = await params;
  const tree = await getCategoryTree();
  const node = findNode(tree, id);
  if (!node) {
    notFound();
  }

  return (
    <div>
      <nav className="text-sm text-gray-500" aria-label="Хлебные крошки">
        <Link href="/admin/catalog/categories" className="text-blue-700 hover:underline">
          Категории
        </Link>{' '}
        / {node.name}
      </nav>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">{node.name}</h1>

      <div className="mt-6">
        <CategoryForm category={node} />
      </div>
    </div>
  );
}
