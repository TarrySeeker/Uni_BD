'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useRef } from 'react';

/**
 * Rich-text редактор на Tiptap (docs/11 §5.1.5, пакет 5.C-3).
 *
 * Контролируемый: текущий HTML приходит value, изменения уходят onChange(html).
 * На клиенте редактируется HTML; СЕРВЕР санитизирует его в upsertCmsSection
 * (sanitizeSectionContent, инвариант 5.1 — доверие клиенту запрещено, анти-XSS,
 * аналог серверного anti-tamper расчёта цен). Поэтому панель тут минимальная —
 * лишний теги/атрибуты сервер всё равно вырежет.
 *
 * Если Tiptap по какой-то причине не инициализировался (SSR/гидратация) —
 * EditorContent просто не рендерит контент до маунта; полноценный fallback на
 * <textarea> предоставляет родительский SectionEditor для не-rich-text сборок.
 */
export interface RichTextEditorProps {
  value: string;
  onChange: (html: string) => void;
  ariaLabel?: string;
}

const btn =
  'rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-100 data-[active=true]:bg-gray-900 data-[active=true]:text-white';

export function RichTextEditor({ value, onChange, ariaLabel }: RichTextEditorProps) {
  // Чтобы избежать цикла value→setContent→onUpdate→value: помечаем «своё» обновление.
  const skipNextSync = useRef(false);

  const editor = useEditor({
    extensions: [StarterKit],
    content: value,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          'prose prose-sm max-w-none min-h-[120px] rounded border border-gray-300 px-3 py-2 focus:outline-none',
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
      },
    },
    onUpdate: ({ editor: ed }) => {
      skipNextSync.current = true;
      onChange(ed.getHTML());
    },
  });

  // Синхронизация извне (например, сброс формы) → ставим content, не зациклив onUpdate.
  useEffect(() => {
    if (!editor) return;
    if (skipNextSync.current) {
      skipNextSync.current = false;
      return;
    }
    const current = editor.getHTML();
    if (current !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  if (!editor) {
    // До маунта/инициализации — текстовый fallback (серверная санитизация защищает).
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={4}
        aria-label={ariaLabel}
        className="w-full rounded border border-gray-300 px-3 py-2 text-sm"
      />
    );
  }

  return (
    <div>
      <div className="mb-1 flex flex-wrap gap-1" role="toolbar" aria-label="Форматирование">
        <button
          type="button"
          className={btn}
          data-active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          Ж
        </button>
        <button
          type="button"
          className={btn}
          data-active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          К
        </button>
        <button
          type="button"
          className={btn}
          data-active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </button>
        <button
          type="button"
          className={btn}
          data-active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          • Список
        </button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
