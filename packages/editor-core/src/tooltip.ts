let tooltipEl: HTMLDivElement | null = null;
let tooltipTimer: ReturnType<typeof setTimeout> | null = null;
let cssInjected = false;
const DELAY = 600;

const TOOLTIP_CSS = `
.kivi-tooltip {
  position: fixed;
  z-index: 10001;
  padding: 4px 8px;
  background: var(--vscode-editorHoverWidget-background, #2d2d30);
  color: var(--vscode-editorHoverWidget-foreground, #cccccc);
  border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
  border-radius: 4px;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.12s ease-out;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}
.kivi-tooltip.visible { opacity: 1; }
`;

function injectCSS() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  if (document.querySelector('style[data-kivi-tooltip]')) return;
  const style = document.createElement('style');
  style.setAttribute('data-kivi-tooltip', '1');
  style.textContent = TOOLTIP_CSS;
  document.head.appendChild(style);
}

function ensure(): HTMLDivElement {
  if (!tooltipEl) {
    injectCSS();
    tooltipEl = document.createElement('div');
    tooltipEl.className = 'kivi-tooltip';
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}

/**
 * Converts a native `title` attribute into a delayed hover tooltip.
 * Removes the `title` to prevent the browser's built-in tooltip from firing
 * and shows a styled tooltip after DELAY ms on mouseenter.
 */
export function addDelayedTooltip(el: HTMLElement): void {
  const text = el.title || el.getAttribute('data-tooltip');
  if (!text) return;
  el.removeAttribute('title');
  el.setAttribute('data-tooltip', text);

  el.addEventListener('mouseenter', () => {
    if (tooltipTimer) clearTimeout(tooltipTimer);
    tooltipTimer = setTimeout(() => {
      const tip = ensure();
      tip.textContent = text;
      const rect = el.getBoundingClientRect();
      tip.style.left = `${rect.left + rect.width / 2}px`;
      tip.style.top = `${rect.bottom + 6}px`;
      tip.style.transform = 'translateX(-50%)';
      tip.classList.add('visible');
    }, DELAY);
  });

  el.addEventListener('mouseleave', () => {
    if (tooltipTimer) { clearTimeout(tooltipTimer); tooltipTimer = null; }
    const tip = ensure();
    tip.classList.remove('visible');
  });
}
