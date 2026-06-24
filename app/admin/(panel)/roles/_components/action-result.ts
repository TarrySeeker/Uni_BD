/**
 * Реэкспорт хелперов ActionResult для форм ролей. Сообщения те же, что у форм
 * пользователей (раздел RBAC), поэтому переиспользуем единую реализацию вместо
 * дублирования.
 */
export { errorMessage, fieldError } from '../../users/_components/action-result';
