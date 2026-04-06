import { Node, mergeAttributes } from '@tiptap/core';

export const Video = Node.create({
  name: 'video',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: {
        default: true,
        parseHTML: (el: HTMLElement) => el.hasAttribute('controls'),
        renderHTML: (attrs: Record<string, unknown>) => {
          return attrs.controls ? { controls: '' } : {};
        },
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width');
          if (!w) return null;
          if (w === '100%') return '100%';
          return parseInt(w, 10) || null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.width) return {};
          if (attrs.width === '100%') return { width: '100%', style: 'width:100%' };
          return { width: String(attrs.width), style: `width:${attrs.width}px;max-width:100%` };
        },
      },
      'data-align': {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || null,
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs['data-align']) return {};
          return { 'data-align': attrs['data-align'] as string };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'video[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { style: _style, ...rest } = HTMLAttributes;
    const baseStyle = rest.width ? undefined : 'max-width:100%';
    return ['video', mergeAttributes(rest, {
      class: 'kivi-video',
      preload: 'metadata',
      ...(baseStyle ? { style: baseStyle } : {}),
    })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentVideoNode = node;
      const wrapper = document.createElement('div');
      wrapper.className = 'kivi-video-wrapper';
      wrapper.draggable = true;

      const align = node.attrs['data-align'] as string | null;
      if (align) wrapper.setAttribute('data-align', align);

      const video = document.createElement('video');
      video.className = 'kivi-video';
      video.preload = 'metadata';
      video.controls = node.attrs.controls !== false;
      video.playsInline = true;

      if (node.attrs.src) video.src = node.attrs.src;
      if (node.attrs.width === '100%') {
        video.style.width = '100%';
      } else if (node.attrs.width) {
        video.style.width = `${node.attrs.width}px`;
        video.style.maxWidth = '100%';
      } else {
        video.style.maxWidth = '100%';
      }

      video.addEventListener('mousedown', (e) => {
        const rect = video.getBoundingClientRect();
        const controlsHeight = 40;
        const isOnControls = e.clientY > rect.bottom - controlsHeight;

        if (isOnControls || video.paused === false) {
          e.stopPropagation();
          return;
        }

        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) {
          editor.commands.setNodeSelection(pos);
        }
      });

      video.addEventListener('click', (e) => {
        const rect = video.getBoundingClientRect();
        const controlsHeight = 40;
        if (e.clientY > rect.bottom - controlsHeight) {
          e.stopPropagation();
        }
      });

      video.addEventListener('dblclick', (e) => {
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
          const src = currentVideoNode.attrs.src;
          if (src) document.dispatchEvent(new CustomEvent('kivi-open-asset', { detail: { src } }));
          return;
        }
        e.stopPropagation();
        if (video.paused) {
          video.play().catch(() => {});
        } else {
          video.pause();
        }
      });

      wrapper.appendChild(video);

      return {
        dom: wrapper,
        contentDOM: undefined,

        update(updatedNode) {
          if (updatedNode.type.name !== 'video') return false;
          currentVideoNode = updatedNode;

          const newSrc = updatedNode.attrs.src;
          if (newSrc !== video.getAttribute('src')) {
            if (newSrc) video.src = newSrc;
            else video.removeAttribute('src');
          }

          video.controls = updatedNode.attrs.controls !== false;

          if (updatedNode.attrs.width === '100%') {
            video.style.width = '100%';
            video.style.maxWidth = '';
          } else if (updatedNode.attrs.width) {
            video.style.width = `${updatedNode.attrs.width}px`;
            video.style.maxWidth = '100%';
          } else {
            video.style.width = '';
            video.style.maxWidth = '100%';
          }

          const newAlign = updatedNode.attrs['data-align'] as string | null;
          if (newAlign) wrapper.setAttribute('data-align', newAlign);
          else wrapper.removeAttribute('data-align');

          return true;
        },

        selectNode() {
          wrapper.classList.add('ProseMirror-selectednode');
        },

        deselectNode() {
          wrapper.classList.remove('ProseMirror-selectednode');
        },

        stopEvent(event) {
          if (event.type === 'mousedown' || event.type === 'click' ||
              event.type === 'dblclick' || event.type === 'contextmenu') {
            const target = event.target as HTMLElement;
            if (target === video || target.closest('video')) {
              const rect = video.getBoundingClientRect();
              const controlsHeight = 40;
              const e = event as MouseEvent;
              if (e.clientY > rect.bottom - controlsHeight) return true;
              if (!video.paused) return true;
            }
          }
          if (event.type === 'play' || event.type === 'pause' ||
              event.type === 'volumechange' || event.type === 'seeked' ||
              event.type === 'seeking' || event.type === 'timeupdate') {
            return true;
          }
          return false;
        },

        destroy() {
          video.pause();
          video.removeAttribute('src');
          video.load();
        },
      };
    };
  },
});

export const Audio = Node.create({
  name: 'audio',
  group: 'block',
  atom: true,
  draggable: true,

  addAttributes() {
    return {
      src: { default: null },
      controls: {
        default: true,
        parseHTML: (el: HTMLElement) => el.hasAttribute('controls'),
        renderHTML: (attrs: Record<string, unknown>) => {
          return attrs.controls ? { controls: '' } : {};
        },
      },
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const w = el.getAttribute('width');
          if (!w) return null;
          if (w === '100%') return '100%';
          return parseInt(w, 10) || null;
        },
        renderHTML: (attrs: Record<string, unknown>) => {
          if (!attrs.width) return {};
          if (attrs.width === '100%') return { width: '100%', style: 'width:100%' };
          return { width: String(attrs.width), style: `width:${attrs.width}px;max-width:100%` };
        },
      },
    };
  },

  parseHTML() {
    return [{ tag: 'audio[src]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const { style: _style, ...rest } = HTMLAttributes;
    const baseStyle = rest.width ? undefined : 'max-width:100%';
    return ['audio', mergeAttributes(rest, {
      class: 'kivi-audio',
      preload: 'metadata',
      ...(baseStyle ? { style: baseStyle } : {}),
    })];
  },

  addNodeView() {
    return ({ node, editor, getPos }) => {
      let currentNode = node;
      const wrapper = document.createElement('div');
      wrapper.className = 'kivi-audio-wrapper';

      const audio = document.createElement('audio');
      audio.className = 'kivi-audio';
      audio.preload = 'metadata';
      audio.controls = node.attrs.controls !== false;

      if (node.attrs.src) audio.src = node.attrs.src;
      if (node.attrs.width === '100%') {
        audio.style.width = '100%';
      } else if (node.attrs.width) {
        audio.style.width = `${node.attrs.width}px`;
        audio.style.maxWidth = '100%';
      } else {
        audio.style.width = '100%';
        audio.style.maxWidth = '100%';
      }

      audio.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        const pos = typeof getPos === 'function' ? getPos() : null;
        if (pos != null) {
          editor.commands.setNodeSelection(pos);
        }
      });

      audio.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const src = currentNode.attrs.src;
        if (src) document.dispatchEvent(new CustomEvent('kivi-open-asset', { detail: { src } }));
      });

      wrapper.appendChild(audio);

      return {
        dom: wrapper,
        contentDOM: undefined,

        update(updatedNode) {
          if (updatedNode.type.name !== 'audio') return false;
          currentNode = updatedNode;

          const newSrc = updatedNode.attrs.src;
          if (newSrc !== audio.getAttribute('src')) {
            if (newSrc) audio.src = newSrc;
            else audio.removeAttribute('src');
          }

          audio.controls = updatedNode.attrs.controls !== false;

          if (updatedNode.attrs.width === '100%') {
            audio.style.width = '100%';
            audio.style.maxWidth = '';
          } else if (updatedNode.attrs.width) {
            audio.style.width = `${updatedNode.attrs.width}px`;
            audio.style.maxWidth = '100%';
          } else {
            audio.style.width = '100%';
            audio.style.maxWidth = '100%';
          }

          return true;
        },

        selectNode() {
          wrapper.classList.add('ProseMirror-selectednode');
        },

        deselectNode() {
          wrapper.classList.remove('ProseMirror-selectednode');
        },

        stopEvent(event) {
          if (event.type === 'mousedown' || event.type === 'click' || event.type === 'dblclick') {
            return true;
          }
          if (event.type === 'play' || event.type === 'pause' ||
              event.type === 'volumechange' || event.type === 'seeked' ||
              event.type === 'seeking' || event.type === 'timeupdate') {
            return true;
          }
          return false;
        },

        destroy() {
          audio.pause();
          audio.removeAttribute('src');
          audio.load();
        },
      };
    };
  },
});
