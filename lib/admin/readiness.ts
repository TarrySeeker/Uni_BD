/**
 * «Готовность магазина» — диагностика КОНФИГУРАЦИИ и ДАННЫХ инстанса.
 *
 * ЗАЧЕМ. `lib/health.ts` отвечает на вопрос «жива ли инфраструктура» (БД, Redis,
 * S3). Но самый дорогой класс отказов на боевых магазинах — другой: инфраструктура
 * жива, код исправен, тесты зелёные, а магазин не работает, потому что не заполнены
 * ключи, секреты или данные. Такие отказы не видит ни один автотест: они живут в
 * `.env` и в БД конкретного инстанса.
 *
 * Что этот класс отказов уже стоил на живых магазинах:
 *   • ключи СДЭК владелец «передавал трижды» — во всех бэкапах `.env` их длина 0;
 *     покупателю месяцами показывались ВЫМЫШЛЕННЫЕ пункты выдачи из mock-фикстур,
 *     а стоимость доставки не считалась вовсе;
 *   • `CDEK_CRON_SECRET` пуст → cron-роут отвечает 503 → статусы доставки не
 *     обновляются. Случилось в трёх магазинах подряд, каждый раз незамеченным;
 *   • цена стояла у 2 товаров из 4484 — магазин физически не мог ничего продать,
 *     при этом в админке «всё в порядке».
 *
 * Общее у всех случаев: система ЗНАЛА о проблеме (пустая переменная, нулевой
 * счётчик), но нигде об этом не говорила. Этот модуль превращает молчаливое
 * знание в явный экран.
 *
 * ЧИСТАЯ ФУНКЦИЯ. `buildReadinessReport` принимает готовый снимок фактов и
 * возвращает отчёт — без обращений к БД и сети. Сбор фактов (I/O) живёт отдельно,
 * в вызывающем коде. Так вся логика вердиктов покрывается тестами без стенда —
 * а непроверяемость как раз и порождает дыры такого рода.
 *
 * МУЛЬТИТЕНАНТНОСТЬ. Пункты, относящиеся к выключенному модулю, помечаются
 * `skipped` и не портят вердикт: магазин-заявка без онлайн-оплаты или магазин с
 * самовывозом без СДЭК — легальные конфигурации, а не поломки.
 */

/**
 * Уровень пункта:
 *   • `blocker` — магазин не может нормально работать (продать/доставить/принять
 *     оплату). Требует действия немедленно;
 *   • `warning` — работать можно, но покупатель видит что-то плохое или неполное;
 *   • `ok`      — проверено, всё в порядке;
 *   • `skipped` — не применимо (модуль выключен);
 *   • `unknown` — ФАКТ НЕ УДАЛОСЬ УСТАНОВИТЬ. Отдельный уровень принципиально:
 *     «не смогли посчитать» никогда не должно выглядеть как «всё хорошо».
 */
export type ReadinessLevel = 'blocker' | 'warning' | 'ok' | 'skipped' | 'unknown';

/** Итоговый вердикт по магазину = худший из пунктов. */
export type ReadinessStatus = 'blocked' | 'attention' | 'ok';

/** Один пункт проверки. */
export interface ReadinessItem {
  /** Стабильный идентификатор (для тестов и ссылок), напр. `cdek.keys`. */
  id: string;
  /** Раздел для группировки в UI. */
  group: 'Интеграции' | 'Витрина' | 'Каталог' | 'Документы';
  /** Короткий заголовок пункта. */
  title: string;
  level: ReadinessLevel;
  /** Что именно обнаружено — с числами, если они есть. */
  detail: string;
  /** Что сделать владельцу. Пусто только для ok/skipped/unknown. */
  action: string;
  /** Куда перейти, чтобы исправить (если исправляется из админки). */
  href?: string;
}

export interface ReadinessReport {
  status: ReadinessStatus;
  items: ReadinessItem[];
  /** Только блокеры — выносятся наверх, чтобы их нельзя было пролистать. */
  blockers: ReadinessItem[];
}

/**
 * Снимок фактов об инстансе. Числовые поля допускают `null` — «посчитать не
 * удалось» (нет таблицы, ошибка запроса). Это НЕ то же самое, что 0.
 */
export interface ReadinessInput {
  /** Эффективно включённые модули (совпадает с боковым меню админки). */
  modules: {
    cdek: boolean;
    payments: boolean;
    catalog: boolean;
    orders: boolean;
    /** Личный кабинет покупателя. */
    account: boolean;
  };
  integrations: {
    /** true — боевые ключи СДЭК не заданы, работает эмуляция. */
    cdekMock: boolean;
    /** Задан ли секрет cron-роутов (без него они отвечают 503). */
    cdekCronSecretSet: boolean;
    /** true — боевые ключи платёжного провайдера не заданы. */
    paymentsMock: boolean;
    /** Настроено ли внешнее хранилище файлов (иначе — локальный диск). */
    storageConfigured: boolean;
    /** Настроена ли отправка почты (SMTP). */
    mailConfigured: boolean;
  };
  site: {
    /** Публичный домен магазина (`seo.site_url`). */
    siteUrl: string | null;
    shopNameSet: boolean;
    /** Заполнен ли хотя бы один способ связи (телефон/email). */
    contactsSet: boolean;
  };
  catalog: {
    activeProducts: number | null;
    /** Активные товары без цены — их нельзя купить. */
    withoutPrice: number | null;
    withoutImage: number | null;
    /** Товары, похожие на тестовые («test», «тест», «zz-»). */
    testLike: number | null;
  };
  legal: {
    /**
     * Slug'и ОПУБЛИКОВАННЫХ правовых страниц. `null` — список не удалось
     * получить (запрос к БД не выполнен), это не то же самое, что «их нет».
     */
    publishedDocs: string[] | null;
    /** Заданы ли реквизиты продавца (наименование/ИНН) — ст.9 ЗоЗПП. */
    legalEntitySet: boolean;
  };
}

/** Пункт-«не удалось установить» — единый вид для всех неизвестных фактов. */
function unknownItem(
  id: string,
  group: ReadinessItem['group'],
  title: string,
): ReadinessItem {
  return {
    id,
    group,
    title,
    level: 'unknown',
    detail: 'Не удалось проверить — запрос к базе данных не выполнен.',
    action: '',
  };
}

/** Пункт-«не применимо»: модуль выключен, проверять нечего. */
function skippedItem(
  id: string,
  group: ReadinessItem['group'],
  title: string,
  why: string,
): ReadinessItem {
  return { id, group, title, level: 'skipped', detail: why, action: '' };
}

/** Склонение существительного при числе: 1 товар / 2 товара / 5 товаров. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/** Проверки блока «Интеграции». */
function integrationItems(input: ReadinessInput): ReadinessItem[] {
  const { modules, integrations } = input;
  const items: ReadinessItem[] = [];

  // --- Ключи службы доставки -------------------------------------------------
  if (!modules.cdek) {
    items.push(
      skippedItem(
        'cdek.keys',
        'Интеграции',
        'Ключи службы доставки',
        'Модуль доставки выключен — ключи не нужны.',
      ),
    );
  } else if (integrations.cdekMock) {
    items.push({
      id: 'cdek.keys',
      group: 'Интеграции',
      title: 'Ключи службы доставки',
      level: 'blocker',
      // Формулировка намеренно избегает слова «mock»: владелец не обязан его
      // знать, а именно непонятность термина позволяла проблеме жить месяцами.
      detail:
        'Боевые ключи не заданы — служба доставки работает в режиме эмуляции. ' +
        'Покупателю показываются ВЫМЫШЛЕННЫЕ пункты выдачи, а стоимость доставки ' +
        'не рассчитывается.',
      action:
        'Получите договорные ключи в личном кабинете службы доставки и пропишите ' +
        'их в .env инстанса (CDEK_ACCOUNT / CDEK_SECRET), затем перезапустите приложение.',
    });
  } else {
    items.push({
      id: 'cdek.keys',
      group: 'Интеграции',
      title: 'Ключи службы доставки',
      level: 'ok',
      detail: 'Боевые ключи заданы — расчёт и накладные идут через реальный API.',
      action: '',
    });
  }

  // --- Секрет фоновых задач --------------------------------------------------
  if (!modules.cdek) {
    items.push(
      skippedItem(
        'cron.secret',
        'Интеграции',
        'Секрет фоновых задач',
        'Модуль доставки выключен — фоновые задачи не используются.',
      ),
    );
  } else if (!integrations.cdekCronSecretSet) {
    items.push({
      id: 'cron.secret',
      group: 'Интеграции',
      title: 'Секрет фоновых задач',
      level: 'blocker',
      detail:
        'Секрет не задан — служебный адрес фоновых задач отключён и отвечает ошибкой 503. ' +
        'Статусы доставки не обновляются автоматически.',
      action:
        'Задайте CDEK_CRON_SECRET в .env, перезапустите приложение и убедитесь, что ' +
        'планировщик (cron) вызывает задачи с этим секретом.',
    });
  } else {
    items.push({
      id: 'cron.secret',
      group: 'Интеграции',
      title: 'Секрет фоновых задач',
      level: 'ok',
      detail: 'Секрет задан — фоновые задачи могут выполняться.',
      action: '',
    });
  }

  // --- Ключи приёма оплаты ---------------------------------------------------
  if (!modules.payments) {
    items.push(
      skippedItem(
        'payments.keys',
        'Интеграции',
        'Приём оплаты',
        'Модуль оплаты выключен — магазин работает по модели заявки.',
      ),
    );
  } else if (integrations.paymentsMock) {
    items.push({
      id: 'payments.keys',
      group: 'Интеграции',
      title: 'Приём оплаты',
      level: 'blocker',
      detail:
        'Боевые ключи платёжного провайдера не заданы — оплата эмулируется. ' +
        'Реальные деньги за заказы не принимаются.',
      action:
        'Пропишите боевые ключи терминала в .env инстанса и перезапустите приложение. ' +
        'Если приём оплаты на сайте не планируется — выключите модуль «Оплата», ' +
        'чтобы этот пункт не считался ошибкой.',
    });
  } else {
    items.push({
      id: 'payments.keys',
      group: 'Интеграции',
      title: 'Приём оплаты',
      level: 'ok',
      detail: 'Боевые ключи заданы — оплата принимается через реальный терминал.',
      action: '',
    });
  }

  // --- Хранилище файлов ------------------------------------------------------
  items.push(
    integrations.storageConfigured
      ? {
          id: 'storage',
          group: 'Интеграции',
          title: 'Хранилище файлов',
          level: 'ok',
          detail: 'Настроено внешнее хранилище — фотографии переживут пересборку.',
          action: '',
        }
      : {
          id: 'storage',
          group: 'Интеграции',
          title: 'Хранилище файлов',
          level: 'warning',
          detail:
            'Внешнее хранилище не настроено — файлы лежат на диске приложения и ' +
            'могут быть потеряны при пересоздании контейнера.',
          action:
            'Настройте S3-совместимое хранилище (S3_ENDPOINT / S3_BUCKET / ключи) ' +
            'и убедитесь, что каталог с медиа попадает в резервные копии.',
        },
  );

  // --- Отправка почты --------------------------------------------------------
  //
  // Уровень зависит от того, включён ли личный кабинет. Без кабинета почта
  // полезна, но не критична. С кабинетом её отсутствие — блокер: покупатель не
  // сможет ни подтвердить адрес (а значит и увидеть свои прежние заказы), ни
  // восстановить забытый пароль. Тупик, из которого нет выхода со стороны
  // покупателя вообще.
  if (integrations.mailConfigured) {
    items.push({
      id: 'mail',
      group: 'Интеграции',
      title: 'Отправка писем',
      level: 'ok',
      detail: 'Почта настроена — письма покупателям уходят.',
      action: '',
    });
  } else if (modules.account) {
    items.push({
      id: 'mail',
      group: 'Интеграции',
      title: 'Отправка писем',
      level: 'blocker',
      detail:
        'Почта не настроена, а личный кабинет включён. Покупатель не сможет ни ' +
        'подтвердить адрес (без этого он не увидит заказы, оформленные ранее), ' +
        'ни восстановить забытый пароль — вернуть доступ будет нечем.',
      action:
        'Задайте параметры SMTP в .env инстанса (SMTP_HOST, MAIL_FROM и, если ' +
        'нужно, SMTP_USER / SMTP_PASSWORD) и перезапустите приложение. ' +
        'Если кабинет покупателю не нужен — выключите модуль «Личный кабинет».',
    });
  } else {
    items.push({
      id: 'mail',
      group: 'Интеграции',
      title: 'Отправка писем',
      level: 'warning',
      detail:
        'Почта не настроена — письма не отправляются. Уведомления о заказах и ' +
        'ответы покупателям придётся отправлять вручную.',
      action:
        'Задайте параметры SMTP в .env инстанса (SMTP_HOST, MAIL_FROM) ' +
        'и перезапустите приложение.',
    });
  }

  return items;
}

/** Проверки блока «Витрина». */
function siteItems(input: ReadinessInput): ReadinessItem[] {
  const { site } = input;
  const items: ReadinessItem[] = [];

  items.push(
    site.siteUrl
      ? {
          id: 'site.url',
          group: 'Витрина',
          title: 'Адрес сайта',
          level: 'ok',
          detail: `Публичный адрес магазина: ${site.siteUrl}`,
          action: '',
        }
      : {
          id: 'site.url',
          group: 'Витрина',
          title: 'Адрес сайта',
          level: 'blocker',
          // Без него ломаются не только ссылки: на нём строится URL вебхука.
          detail:
            'Публичный адрес магазина не задан. Без него неверно формируются ' +
            'ссылки в письмах и служебные адреса для служб доставки и оплаты.',
          action: 'Заполните «Домен сайта» в разделе Настройки → SEO.',
          href: '/admin/settings/seo',
        },
  );

  items.push(
    site.shopNameSet
      ? {
          id: 'site.brand',
          group: 'Витрина',
          title: 'Название магазина',
          level: 'ok',
          detail: 'Название задано.',
          action: '',
        }
      : {
          id: 'site.brand',
          group: 'Витрина',
          title: 'Название магазина',
          level: 'warning',
          detail: 'Название магазина не задано — покупатель видит заглушку.',
          action: 'Заполните название и логотип в разделе Настройки → Брендинг.',
          href: '/admin/settings',
        },
  );

  items.push(
    site.contactsSet
      ? {
          id: 'site.contacts',
          group: 'Витрина',
          title: 'Контакты',
          level: 'ok',
          detail: 'Способ связи указан.',
          action: '',
        }
      : {
          id: 'site.contacts',
          group: 'Витрина',
          title: 'Контакты',
          level: 'warning',
          detail:
            'Ни телефон, ни email не заполнены — покупателю некуда обратиться ' +
            'с вопросом по заказу.',
          action: 'Заполните телефон и email в разделе Настройки → Реквизиты и контакты.',
          href: '/admin/settings',
        },
  );

  return items;
}

/** Проверки блока «Каталог». */
function catalogItems(input: ReadinessInput): ReadinessItem[] {
  const { modules, catalog } = input;
  if (!modules.catalog) {
    return [
      skippedItem('catalog.products', 'Каталог', 'Товары', 'Модуль каталога выключен.'),
    ];
  }

  const items: ReadinessItem[] = [];

  // --- Есть ли что продавать -------------------------------------------------
  if (catalog.activeProducts === null) {
    items.push(unknownItem('catalog.products', 'Каталог', 'Товары'));
  } else if (catalog.activeProducts === 0) {
    items.push({
      id: 'catalog.products',
      group: 'Каталог',
      title: 'Товары',
      level: 'blocker',
      detail: 'В каталоге нет ни одного опубликованного товара — покупателю нечего купить.',
      action: 'Добавьте товары и переведите их в статус «Опубликован».',
      href: '/admin/catalog',
    });
  } else {
    items.push({
      id: 'catalog.products',
      group: 'Каталог',
      title: 'Товары',
      level: 'ok',
      detail: `Опубликовано ${catalog.activeProducts} ${plural(catalog.activeProducts, 'товар', 'товара', 'товаров')}.`,
      action: '',
    });
  }

  // --- Цены ------------------------------------------------------------------
  if (catalog.withoutPrice === null) {
    items.push(unknownItem('catalog.price', 'Каталог', 'Цены'));
  } else if (catalog.withoutPrice > 0) {
    const n = catalog.withoutPrice;
    items.push({
      id: 'catalog.price',
      group: 'Каталог',
      title: 'Цены',
      level: 'blocker',
      // Число обязательно: «есть проблема» не заставляет действовать,
      // «4482 товара нельзя купить» — заставляет.
      detail: `${n} ${plural(n, 'опубликованный товар', 'опубликованных товара', 'опубликованных товаров')} без цены — их невозможно купить.`,
      action: 'Проставьте цены или снимите такие товары с публикации.',
      href: '/admin/catalog',
    });
  } else {
    items.push({
      id: 'catalog.price',
      group: 'Каталог',
      title: 'Цены',
      level: 'ok',
      detail: 'У всех опубликованных товаров есть цена.',
      action: '',
    });
  }

  // --- Фотографии (не блокер: продавать технически можно) --------------------
  if (catalog.withoutImage === null) {
    items.push(unknownItem('catalog.images', 'Каталог', 'Фотографии'));
  } else if (catalog.withoutImage > 0) {
    const n = catalog.withoutImage;
    items.push({
      id: 'catalog.images',
      group: 'Каталог',
      title: 'Фотографии',
      level: 'warning',
      detail: `${n} ${plural(n, 'товар', 'товара', 'товаров')} без фотографии — карточка выглядит пустой.`,
      action: 'Загрузите фотографии в карточках товаров.',
      href: '/admin/catalog',
    });
  } else {
    items.push({
      id: 'catalog.images',
      group: 'Каталог',
      title: 'Фотографии',
      level: 'ok',
      detail: 'У всех опубликованных товаров есть фотография.',
      action: '',
    });
  }

  // --- Тестовые данные в проде -----------------------------------------------
  if (catalog.testLike === null) {
    items.push(unknownItem('catalog.testdata', 'Каталог', 'Тестовые данные'));
  } else if (catalog.testLike > 0) {
    const n = catalog.testLike;
    items.push({
      id: 'catalog.testdata',
      group: 'Каталог',
      title: 'Тестовые данные',
      level: 'warning',
      detail: `Похоже на тестовые: ${n} ${plural(n, 'позиция', 'позиции', 'позиций')} в опубликованном каталоге — их видит покупатель.`,
      action: 'Удалите или снимите с публикации тестовые товары и категории.',
      href: '/admin/catalog',
    });
  } else {
    items.push({
      id: 'catalog.testdata',
      group: 'Каталог',
      title: 'Тестовые данные',
      level: 'ok',
      detail: 'Тестовых позиций в опубликованном каталоге не найдено.',
      action: '',
    });
  }

  return items;
}

/**
 * Обязательные правовые документы интернет-магазина.
 *
 * Ниша здесь ни при чём — это требования к ЛЮБОЙ розничной продаже через сайт:
 *  • privacy — политика обработки ПДн: сайт собирает имя/телефон/почту, а
 *    ч.2 ст.18.1 152-ФЗ обязывает ОПУБЛИКОВАТЬ документ о политике обработки;
 *  • offer   — условия продажи (публичная оферта): без них договор с
 *    покупателем не описан, а ст.10 ЗоЗПП требует довести условия до покупателя;
 *  • returns — порядок и сроки возврата: ст.26.1 ЗоЗПП. Если информация не
 *    предоставлена, срок отказа от товара растягивается с 7 дней до 3 МЕСЯЦЕВ.
 */
const REQUIRED_LEGAL_DOCS: readonly { slug: string; title: string }[] = [
  { slug: 'privacy', title: 'политика обработки персональных данных' },
  { slug: 'offer', title: 'публичная оферта (условия продажи)' },
  { slug: 'returns', title: 'возврат и обмен' },
];

/**
 * Проверки блока «Документы» (урок живого магазина).
 *
 * Магазин месяцами работал на бою вообще без оферты, а страница возврата
 * утверждала, что товар «возврату не подлежит» — это не ловится тестами кода,
 * потому что код исправен. Ловится только проверкой факта: опубликован ли
 * документ и заданы ли реквизиты продавца.
 */
function legalItems(input: ReadinessInput): ReadinessItem[] {
  const { legal } = input;
  const items: ReadinessItem[] = [];

  if (legal.publishedDocs === null) {
    items.push(unknownItem('legal.docs', 'Документы', 'Правовые документы'));
  } else {
    const missing = REQUIRED_LEGAL_DOCS.filter(
      (doc) => !legal.publishedDocs!.includes(doc.slug),
    );
    items.push(
      missing.length === 0
        ? {
            id: 'legal.docs',
            group: 'Документы',
            title: 'Правовые документы',
            level: 'ok',
            detail: 'Опубликованы политика обработки ПДн, оферта и порядок возврата.',
            action: '',
          }
        : {
            id: 'legal.docs',
            group: 'Документы',
            title: 'Правовые документы',
            level: 'blocker',
            detail:
              `Не опубликовано: ${missing.map((d) => d.title).join(', ')}. ` +
              'Магазин принимает заказы и собирает персональные данные, не раскрыв ' +
              'покупателю обязательные условия — это нарушение ЗоЗПП и 152-ФЗ.',
            action:
              'Создайте страницы в разделе «Контент» со slug: ' +
              `${missing.map((d) => d.slug).join(', ')} — и опубликуйте их.`,
          },
    );
  }

  items.push(
    legal.legalEntitySet
      ? {
          id: 'legal.entity',
          group: 'Документы',
          title: 'Реквизиты продавца',
          level: 'ok',
          detail: 'Наименование и ИНН продавца заданы и выводятся покупателю.',
          action: '',
        }
      : {
          id: 'legal.entity',
          group: 'Документы',
          title: 'Реквизиты продавца',
          level: 'blocker',
          detail:
            'Реквизиты продавца не заданы. Ст.9 ЗоЗПП обязывает довести до покупателя ' +
            'наименование, адрес и сведения о государственной регистрации продавца.',
          action: 'Заполните «Реквизиты» в разделе Настройки.',
        },
  );

  return items;
}

/**
 * Собирает отчёт о готовности магазина. Чистая: без БД и сети.
 *
 * Вердикт = худший из пунктов: один блокер делает весь отчёт `blocked`. Это
 * намеренно строго — смысл экрана в том, чтобы блокер нельзя было не заметить.
 * `unknown` не считается успехом и опускает вердикт до `attention`.
 */
export function buildReadinessReport(input: ReadinessInput): ReadinessReport {
  const items = [
    ...integrationItems(input),
    ...siteItems(input),
    ...catalogItems(input),
    ...legalItems(input),
  ];

  const blockers = items.filter((i) => i.level === 'blocker');
  const hasAttention = items.some((i) => i.level === 'warning' || i.level === 'unknown');

  const status: ReadinessStatus =
    blockers.length > 0 ? 'blocked' : hasAttention ? 'attention' : 'ok';

  return { status, items, blockers };
}
