import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Slice } from '@tiptap/pm/model';
import { parseMarkdown } from '@kivi/markdown-parser';

const clipboardPluginKey = new PluginKey('kiviClipboard');

export interface ImageStorageAdapter {
  store(blob: Blob, filename: string): Promise<string>;
}

/** Default adapter: converts images to data URLs */
export const dataUrlImageAdapter: ImageStorageAdapter = {
  async store(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  },
};

/**
 * Heuristic to detect if text looks like Markdown.
 * Requires at least 2 distinct Markdown patterns to trigger rich paste.
 */
export function looksLikeMarkdown(text: string): boolean {
  const patterns = [
    /^#{1,6}\s/m,
    /^\s*[-*+]\s/m,
    /^\s*\d+\.\s/m,
    /^\s*>/m,
    /\*\*[^*]+\*\*/,
    /\*[^*]+\*/,
    /`[^`]+`/,
    /^```/m,
    /\[([^\]]+)\]\([^)]+\)/,
    /!\[([^\]]*)\]\([^)]+\)/,
    /^\s*[-*_]{3,}\s*$/m,
    /^\|.+\|/m,
    /\[[ x]\]/,
  ];

  let score = 0;
  for (const pattern of patterns) {
    if (pattern.test(text)) score++;
  }

  return score >= 2;
}

export interface KiviClipboardOptions {
  imageAdapter?: ImageStorageAdapter;
}

export const KiviClipboard = Extension.create<KiviClipboardOptions>({
  name: 'kiviClipboard',

  addOptions() {
    return { imageAdapter: undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const imageAdapter = this.options.imageAdapter ?? dataUrlImageAdapter;

    return [
      new Plugin({
        key: clipboardPluginKey,
        props: {
          handlePaste(_view, event, _slice) {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;

            // Handle image paste
            const items = Array.from(clipboardData.items || []);
            const imageItem = items.find((i) => i.type.startsWith('image/'));
            if (imageItem) {
              event.preventDefault();
              const blob = imageItem.getAsFile();
              if (blob) {
                const ext = imageItem.type.split('/')[1] || 'png';
                const filename = `pasted-${Date.now()}.${ext}`;
                imageAdapter.store(blob, filename).then((url) => {
                  editor.commands.setImage({ src: url, alt: filename });
                }).catch(() => {
                  // Silently fail — user can paste again
                });
              }
              return true;
            }

            const plainText = clipboardData.getData('text/plain');
            const htmlText = clipboardData.getData('text/html');

            if (htmlText && !looksLikeMarkdown(plainText)) {
              return false;
            }

            if (plainText && looksLikeMarkdown(plainText)) {
              event.preventDefault();

              try {
                const parsed = parseMarkdown(plainText);
                const doc = parsed.doc as { content?: unknown[] };
                if (doc.content && doc.content.length > 0) {
                  editor.commands.insertContent(doc.content);
                  return true;
                }
              } catch {
                editor.commands.insertContent(plainText);
                return true;
              }
            }

            return false;
          },

          clipboardTextSerializer(slice) {
            return serializeSliceToMarkdown(slice);
          },
        },
      }),
    ];
  },
});

function serializeSliceToMarkdown(slice: Slice): string {
  const parts: string[] = [];

  slice.content.forEach((node) => {
    if (node.type.name === 'codeBlock') {
      const lang = node.attrs.language || '';
      const text = node.textContent;
      parts.push('```' + lang + '\n' + text + '\n```');
      return;
    }

    if (node.type.name === 'blockquote') {
      const inner: string[] = [];
      node.content.forEach((child) => {
        inner.push('> ' + serializeInline(child));
      });
      parts.push(inner.join('\n'));
      return;
    }

    if (node.type.name === 'bulletList') {
      node.content.forEach((li) => {
        parts.push('- ' + serializeInline(li.firstChild!));
      });
      return;
    }

    if (node.type.name === 'orderedList') {
      let num = node.attrs.start || 1;
      node.content.forEach((li) => {
        parts.push(`${num}. ` + serializeInline(li.firstChild!));
        num++;
      });
      return;
    }

    if (node.type.name === 'horizontalRule') {
      parts.push('---');
      return;
    }

    if (node.isTextblock) {
      let text = serializeInline(node);

      if (node.type.name === 'heading') {
        const level = node.attrs.level || 1;
        text = '#'.repeat(level) + ' ' + text;
      }

      parts.push(text);
    }
  });

  return parts.join('\n\n');
}

function serializeInline(node: import('@tiptap/pm/model').Node): string {
  let result = '';
  node.content.forEach((child) => {
    if (child.isText) {
      let t = child.text || '';
      child.marks.forEach((mark) => {
        switch (mark.type.name) {
          case 'bold':
            t = `**${t}**`;
            break;
          case 'italic':
            t = `*${t}*`;
            break;
          case 'code':
            t = `\`${t}\``;
            break;
          case 'strike':
            t = `~~${t}~~`;
            break;
          case 'link':
            t = `[${t}](${mark.attrs.href || ''})`;
            break;
        }
      });
      result += t;
    } else if (child.type.name === 'hardBreak') {
      result += '  \n';
    } else if (child.type.name === 'image') {
      result += `![${child.attrs.alt || ''}](${child.attrs.src || ''})`;
    }
  });
  return result;
}
