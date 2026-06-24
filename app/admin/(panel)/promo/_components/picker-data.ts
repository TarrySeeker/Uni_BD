import 'server-only';

import { sql } from '@/lib/db/client';
import { listBrands, getCategoryTree } from '@/lib/catalog/repository';
import type { CategoryTreeNode } from '@/lib/catalog/types';

import type { PromoPickerData } from './PromoForm';

/**
 * Списки сущностей для выбора таргета промокода по НАЗВАНИЮ (категория/бренд/
 * товар) — вместо ручного ввода UUID. Серверная загрузка; при ошибке/выключенном
 * каталоге возвращает пусто (форма деградирует к текстовому полю).
 *
 * Товары ограничены 1000 для производительности селекта; для очень больших
 * каталогов нужен поиск-автокомплит (будущее улучшение).
 */
function flattenCats(
  nodes: CategoryTreeNode[],
  depth = 0,
): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const n of nodes) {
    out.push({ id: n.id, name: `${'— '.repeat(depth)}${n.name}` });
    out.push(...flattenCats(n.children, depth + 1));
  }
  return out;
}

export async function loadPromoPickerData(): Promise<PromoPickerData> {
  try {
    const [brands, tree, products] = await Promise.all([
      listBrands(),
      getCategoryTree(),
      sql<{ id: string; name: string }[]>`
        SELECT id, name FROM products ORDER BY name LIMIT 1000
      `,
    ]);
    return {
      category: flattenCats(tree),
      brand: brands.map((b) => ({ id: b.id, name: b.name })),
      product: products.map((p) => ({ id: p.id, name: p.name })),
    };
  } catch {
    return {};
  }
}
