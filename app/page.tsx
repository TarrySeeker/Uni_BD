import { getTranslations } from 'next-intl/server';

export default async function HomePage() {
  const t = await getTranslations();

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <h1 className="text-2xl font-semibold">{t('common.app.title')}</h1>
    </main>
  );
}
