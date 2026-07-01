/**
 * Чистая логика «изменился ли состав ролей пользователя» (находка #16).
 *
 * Зачем: форма пользователя при сохранении всегда слала roleIds, а сервер
 * (updateUser) трактует ЛЮБОЕ присутствие roleIds как изменение ролей и требует
 * дополнительно право roles.manage. Носитель только users.manage (без roles.manage)
 * не мог сохранить даже имя. Форма должна слать roleIds лишь когда состав ролей
 * реально менялся — тогда чистая правка имени/статуса проходит под users.manage.
 *
 * Сравнение по МНОЖЕСТВУ (порядок и дубликаты не важны): два набора одинаковы,
 * если содержат ровно одни и те же id. Чистая функция, тестируема без БД/React.
 */
export function rolesChanged(
  original: readonly string[],
  current: readonly string[],
): boolean {
  const a = new Set(original);
  const b = new Set(current);
  if (a.size !== b.size) return true;
  for (const id of a) {
    if (!b.has(id)) return true;
  }
  return false;
}
