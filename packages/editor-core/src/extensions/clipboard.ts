import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Fragment, Slice, Node as PMNode } from '@tiptap/pm/model';
import { parseMarkdown } from '@kivi/markdown-parser';

const clipboardPluginKey = new PluginKey('kiviClipboard');

export interface ImageStorageAdapter {
  store(blob: Blob, filename: string, originalName?: string): Promise<string>;
}

const VIDEO_MIME_PREFIXES = ['video/'];
const VIDEO_EXT_MAP: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/x-matroska': 'mkv',
  'video/ogg': 'ogg',
};

const AUDIO_MIME_PREFIXES = ['audio/'];
const AUDIO_EXT_MAP: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/aac': 'aac',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
};

function buildPasteFilename(blob: File | null, fallbackExt: string): string {
  const ts = Date.now();
  if (blob?.name && blob.name !== 'image.png' && blob.name !== 'image.jpg' && !blob.name.startsWith('blob')) {
    const dot = blob.name.lastIndexOf('.');
    const base = dot > 0 ? blob.name.slice(0, dot) : blob.name;
    const ext = dot > 0 ? blob.name.slice(dot) : `.${fallbackExt}`;
    return `${base}-${ts}${ext}`;
  }
  return `image-${ts}.${fallbackExt}`;
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
 * A single distinct Markdown pattern is enough to trigger rich paste.
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
    /^---\s*$/m,
  ];

  for (const pattern of patterns) {
    if (pattern.test(text)) return true;
  }

  return false;
}

export interface FileStorageAdapter {
  store(blob: Blob, filename: string, originalName?: string): Promise<string>;
}

export interface KiviClipboardOptions {
  imageAdapter?: ImageStorageAdapter;
  fileAdapter?: FileStorageAdapter;
}

export const KiviClipboard = Extension.create<KiviClipboardOptions>({
  name: 'kiviClipboard',

  addOptions() {
    return { imageAdapter: undefined, fileAdapter: undefined };
  },

  addProseMirrorPlugins() {
    const editor = this.editor;
    const imageAdapter = this.options.imageAdapter ?? dataUrlImageAdapter;
    const fileAdapter = this.options.fileAdapter;

    return [
      new Plugin({
        key: clipboardPluginKey,
        props: {
          handlePaste(_view, event, _slice) {
            const clipboardData = event.clipboardData;
            if (!clipboardData) return false;

            const items = Array.from(clipboardData.items || []);

            // Handle image paste (actual binary blobs, e.g. screenshot)
            const imageItem = items.find((i) => i.type.startsWith('image/'));
            if (imageItem) {
              event.preventDefault();
              const blob = imageItem.getAsFile();
              if (blob) {
                const ext = imageItem.type.split('/')[1] || 'png';
                const originalName = blob.name || undefined;
                const filename = buildPasteFilename(blob, ext);
                imageAdapter.store(blob, filename, originalName).then((url) => {
                  if (editor.isDestroyed) return;
                  editor.commands.setImage({ src: url, alt: (originalName || filename).replace(/\.[^.]+$/, '') });
                }).catch(() => {});
              }
              return true;
            }

            // Handle video paste
            const videoItem = items.find((i) => VIDEO_MIME_PREFIXES.some((p) => i.type.startsWith(p)));
            if (videoItem) {
              event.preventDefault();
              const blob = videoItem.getAsFile();
              if (blob) {
                const ext = VIDEO_EXT_MAP[videoItem.type] || videoItem.type.split('/')[1] || 'mp4';
                const originalName = blob.name || undefined;
                const filename = buildPasteFilename(blob, ext);
                imageAdapter.store(blob, filename, originalName).then((url) => {
                  if (editor.isDestroyed) return;
                  editor.commands.insertContent(
                    `<video src="${url}" controls style="max-width:100%"></video>`,
                  );
                }).catch(() => {});
              }
              return true;
            }

            // Handle audio paste
            const audioItem = items.find((i) => AUDIO_MIME_PREFIXES.some((p) => i.type.startsWith(p)));
            if (audioItem) {
              event.preventDefault();
              const blob = audioItem.getAsFile();
              if (blob) {
                const ext = AUDIO_EXT_MAP[audioItem.type] || audioItem.type.split('/')[1] || 'mp3';
                const originalName = blob.name || undefined;
                const filename = buildPasteFilename(blob, ext);
                imageAdapter.store(blob, filename, originalName).then((url) => {
                  if (editor.isDestroyed) return;
                  editor.commands.insertContent(
                    `<audio src="${url}" controls></audio>`,
                  );
                }).catch(() => {});
              }
              return true;
            }

            // Handle generic file paste (PDFs, docs, .excalidraw, etc.)
            if (fileAdapter) {
              const fileItem = items.find((i) => i.kind === 'file' && !i.type.startsWith('image/') && !i.type.startsWith('video/') && !i.type.startsWith('audio/'));
              if (fileItem) {
                const blob = fileItem.getAsFile();
                if (blob) {
                  event.preventDefault();
                  const originalName = blob.name || undefined;
                  const name = buildPasteFilename(blob, 'bin');
                  const isExcalidraw = /\.excalidraw$/i.test(blob.name || name);
                  fileAdapter.store(blob, name, originalName).then((relPath) => {
                    if (editor.isDestroyed) return;
                    if (isExcalidraw) {
                      const excAlt = relPath.split('/').pop()?.replace(/\.excalidraw$/i, '') || 'excalidraw';
                      editor.commands.insertContent({
                        type: 'excalidrawBlock',
                        attrs: { src: relPath, data: '{}', alt: excAlt },
                      });
                    } else {
                      const displayName = (originalName || name).replace(/\.[^.]+$/, '');
                      editor.commands.insertContent({
                        type: 'text',
                        text: displayName,
                        marks: [{ type: 'link', attrs: { href: relPath } }],
                      });
                    }
                  }).catch(() => {});
                  return true;
                }
              }
            }

            const plainText = clipboardData.getData('text/plain');
            const htmlText = clipboardData.getData('text/html');

            if (!plainText && !htmlText) return false;
            if (!plainText) return false;

            const isMarkdown = looksLikeMarkdown(plainText);

            // Single-line plain text that isn't markdown: insert inline.
            // VS Code wraps copied text in HTML (<div style=...>) which
            // ProseMirror's default handler turns into a block — wrong for
            // simple text like file paths or short strings.
            if (!isMarkdown && !plainText.includes('\n')) {
              event.preventDefault();
              const tr = _view.state.tr.insertText(plainText);
              _view.dispatch(tr);
              return true;
            }

            // If text looks like markdown, ALWAYS prefer markdown parsing.
            // HTML from code editors (VS Code, Cursor) wraps text in <pre>/<div style>
            // which ProseMirror turns into a code block — wrong behavior for markdown.
            // Only let HTML through if the plain text doesn't look like markdown
            // AND the HTML looks like rich content (from a web page, Google Docs, etc.)
            if (!isMarkdown && htmlText) {
              return false;
            }

            event.preventDefault();

            try {
              const parsed = parseMarkdown(plainText);
              const docJson = parsed.doc as { type: string; content?: unknown[] };
              if (docJson.content && docJson.content.length > 0) {
                const schema = _view.state.schema;
                const nodes: PMNode[] = [];
                for (const nodeJson of docJson.content) {
                  try {
                    nodes.push(PMNode.fromJSON(schema, nodeJson));
                  } catch {
                    // Skip nodes the schema doesn't understand
                  }
                }
                if (nodes.length > 0) {
                  const fragment = Fragment.from(nodes);
                  const slice = new Slice(fragment, 0, 0);
                  const tr = _view.state.tr.replaceSelection(slice);
                  _view.dispatch(tr);
                  return true;
                }
              }
            } catch { /* fall through to plain insert */ }

            editor.commands.insertContent(plainText);
            return true;
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
      if (child.attrs.width || child.attrs['data-align']) {
        let html = `<img src="${child.attrs.src || ''}"`;
        if (child.attrs.alt) html += ` alt="${child.attrs.alt}"`;
        if (child.attrs.width) html += ` width="${child.attrs.width}"`;
        if (child.attrs['data-align']) html += ` data-align="${child.attrs['data-align']}"`;
        html += ' />';
        result += html;
      } else {
        result += `![${child.attrs.alt || ''}](${child.attrs.src || ''})`;
      }
    }
  });
  return result;
}

const ROOTED_PATH_RE = /^(?:\/|[A-Z]:\\|~\/|\.\.?\/)/;
const HAS_EXT_RE = /\.\w{1,10}$/;
const BARE_RELATIVE_PATH_RE = /^[\w][\w.\- ]*(?:\/[\w.\- ]+)+$/;

export function looksLikeFilePath(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 500) return false;
  if (!HAS_EXT_RE.test(t)) return false;
  // Rooted paths: /foo, ~/foo, ./foo, ../foo, C:\foo
  if (ROOTED_PATH_RE.test(t)) return true;
  // Bare relative paths with at least one /: docs/networking/readme.md
  if (BARE_RELATIVE_PATH_RE.test(t)) return true;
  return false;
}

