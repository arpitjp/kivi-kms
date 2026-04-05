/**
 * CSS zoom helpers.
 *
 * When a container has CSS `zoom`, `getBoundingClientRect()` on its
 * children returns viewport (zoomed) coordinates, while layout
 * properties like `offsetWidth`, `scrollTop`, `clientHeight` return
 * unzoomed values.  Mixing the two without dividing by the zoom
 * factor produces positioning bugs.
 *
 * Two positioning strategies:
 *
 * 1. **`position: absolute` inside a zoomed container** — use
 *    `toContainerCoords` to convert viewport rects to container-local
 *    coordinates, dividing out the zoom.
 *
 * 2. **`position: fixed` appended to `document.body`** — use
 *    `positionFixedPopup` which accounts for both the body-level zoom
 *    and any ancestor CSS zoom (e.g., Kivi editor zoom on `#editor`).
 */

/**
 * Effective CSS zoom ratio for an element (cumulative, including ancestors).
 *
 * Modern Chrome (128+) changed behaviour: `offsetWidth` on a zoomed element
 * now returns the *zoomed* value, matching `getBoundingClientRect().width`.
 * The old `bw/ow` trick therefore returns ~1 even when zoom is active.
 *
 * To be robust across all browsers we walk up the DOM and accumulate
 * explicitly-set CSS `zoom` values.  Falls back to the `bw/ow` ratio if
 * no explicit zoom is found (handles legacy behaviour).
 */
export function getHostZoom(el: HTMLElement): number {
  let z = getExplicitZoomChain(el);
  if (z !== 1) return z;
  // Fallback: detect via rect ratio for older browsers / edge cases
  const ow = el.offsetWidth;
  const bw = el.getBoundingClientRect().width;
  if (ow > 0 && bw > 0) {
    const ratio = bw / ow;
    if (Math.abs(ratio - 1) > 0.01) return ratio;
  }
  return 1;
}

/**
 * Walk from `el` up through ancestors and accumulate CSS `zoom` values.
 *
 * @param stopBefore - Stop before this element (exclusive). Defaults to
 *   `document.documentElement` (i.e. include everything up to `<html>`).
 */
function getExplicitZoomChain(el: HTMLElement, stopBefore?: HTMLElement | null): number {
  const sentinel = stopBefore ?? (typeof document !== 'undefined' ? document.documentElement : null);
  let z = 1;
  let cur: HTMLElement | null = el;
  while (cur && cur !== sentinel) {
    const raw = cur.style.zoom;
    if (raw) {
      const v = parseFloat(raw);
      if (v > 0 && v !== 1) z *= v;
    }
    cur = cur.parentElement;
  }
  return z;
}

/**
 * The zoom applied at the `<body>` level by VS Code or other host.
 *
 * In modern Chrome, `getBoundingClientRect().width / offsetWidth` on the
 * body may always return 1 even when `body.style.zoom` is set, so we
 * read the style property directly as a primary strategy.
 */
export function getBodyZoom(): number {
  if (typeof document === 'undefined') return 1;
  const body = document.body;
  if (!body) return 1;
  const raw = body.style.zoom;
  if (raw) {
    const v = parseFloat(raw);
    if (v > 0 && v !== 1) return v;
  }
  // Fallback: rect ratio for older browsers
  const ow = body.offsetWidth;
  const bw = body.getBoundingClientRect().width;
  if (ow > 0 && bw > 0) {
    const ratio = bw / ow;
    if (Math.abs(ratio - 1) > 0.01) return ratio;
  }
  return 1;
}

/**
 * Detect whether `getBoundingClientRect()` includes CSS zoom or not.
 * Returns the correction factor to multiply onto rect values so they
 * become true viewport coordinates.
 *
 * If the browser already includes zoom → returns ~1.
 * If the browser ignores zoom  → returns the CSS zoom chain.
 */
export function getRectZoomCorrection(el: HTMLElement): number {
  if (typeof document === 'undefined') return 1;
  const cssZoom = getExplicitZoomChain(el, document.body);
  if (cssZoom <= 1.001 && cssZoom >= 0.999) return 1;
  // Probe with the old bw/ow ratio to detect browser behaviour.
  // If bw/ow ≈ cssZoom, the browser includes zoom in rects → no correction.
  // If bw/ow ≈ 1, the browser ignores zoom → need correction.
  const ow = el.offsetWidth;
  const bw = el.getBoundingClientRect().width;
  if (ow > 0 && bw > 0) {
    const ratio = bw / ow;
    if (Math.abs(ratio - cssZoom) < 0.05) return 1;
  }
  return cssZoom;
}

/**
 * Detect whether scrollTop/scrollLeft on a zoomed container return zoomed
 * or layout values.  Chrome 128+ returns zoomed values (offsetWidth ≈
 * getBoundingClientRect().width).  Older browsers return layout values
 * (offsetWidth ≈ getBoundingClientRect().width / z).
 */
export function isScrollZoomed(container: HTMLElement): boolean {
  const hw = container.offsetWidth;
  const bw = container.getBoundingClientRect().width;
  return hw > 0 && bw > 0 && Math.abs(bw / hw - 1) < 0.05;
}

/**
 * Convert a viewport-space rect delta into the container's layout
 * coordinate space, accounting for zoom and scroll.
 *
 * Handles both Chrome 128+ (scrollTop/Left in zoomed space) and
 * older browsers (scrollTop/Left in layout space).
 */
export function toContainerCoords(
  viewportRect: { top: number; left: number; bottom?: number; right?: number; width?: number; height?: number },
  container: HTMLElement,
): { top: number; left: number; bottom: number; right: number; width: number; height: number } {
  const cr = container.getBoundingClientRect();
  const z = getHostZoom(container);
  const scrollZ = isScrollZoomed(container);

  let top: number, left: number;
  if (scrollZ) {
    top = (viewportRect.top - cr.top + container.scrollTop) / z;
    left = (viewportRect.left - cr.left + container.scrollLeft) / z;
  } else {
    top = (viewportRect.top - cr.top) / z + container.scrollTop;
    left = (viewportRect.left - cr.left) / z + container.scrollLeft;
  }
  const width = (viewportRect.width ?? 0) / z;
  const height = (viewportRect.height ?? 0) / z;
  return { top, left, width, height, bottom: top + height, right: left + width };
}

interface PopupRect {
  left: number;
  top: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

interface FixedPopupOptions {
  /** Anchor rect in viewport space (from getBoundingClientRect or coordsAtPos). */
  anchorRect: { top: number; bottom: number; left: number; right: number };
  /** The popup element (must be in the DOM to measure its size). */
  popup: HTMLElement;
  /** Optional container rect to clamp within (viewport space). Defaults to window. */
  containerRect?: { top: number; bottom: number; left: number; right: number } | null;
  /** Gap between anchor and popup. Default: 6 */
  gap?: number;
  /** Padding from edges. Default: 8 */
  pad?: number;
  /** Horizontal alignment: 'left' | 'center'. Default: 'left' */
  alignX?: 'left' | 'center';
  /** Preferred vertical placement. Default: 'auto' */
  preferY?: 'above' | 'below' | 'auto';
  /**
   * An element inside the zoomed container (e.g., the anchor element or
   * the editor DOM node).  Used to detect whether getBoundingClientRect
   * already includes ancestor CSS zoom.  If omitted, no correction is
   * applied beyond body-level zoom.
   */
  anchorEl?: HTMLElement;
}

/**
 * Compute and apply `position: fixed` coordinates for a popup,
 * correctly accounting for body-level CSS zoom AND any ancestor
 * CSS zoom that the browser may or may not fold into
 * getBoundingClientRect() values.
 *
 * All inputs should be in the space returned by getBoundingClientRect
 * or coordsAtPos.
 */
export function positionFixedPopup(opts: FixedPopupOptions): PopupRect {
  const { anchorRect: rawAnchor, popup, gap = 6, pad = 8, alignX = 'left', preferY = 'auto' } = opts;
  const bz = getBodyZoom();

  // Correct anchor & container rects if the browser doesn't include
  // ancestor CSS zoom in getBoundingClientRect values.
  const zc = opts.anchorEl ? getRectZoomCorrection(opts.anchorEl) : 1;
  const anchorRect = zc === 1 ? rawAnchor : {
    top: rawAnchor.top * zc,
    bottom: rawAnchor.bottom * zc,
    left: rawAnchor.left * zc,
    right: rawAnchor.right * zc,
  };
  const rawCR = opts.containerRect;
  const cr = rawCR
    ? (zc === 1 ? rawCR : { top: rawCR.top * zc, bottom: rawCR.bottom * zc, left: rawCR.left * zc, right: rawCR.right * zc })
    : { top: 0, bottom: window.innerHeight, left: 0, right: window.innerWidth };

  const pw = popup.offsetWidth || 200;
  const ph = popup.offsetHeight || 32;

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  const viewTop = Math.max(cr.top, 0);
  const viewBottom = Math.min(cr.bottom, winH);
  const viewLeft = Math.max(cr.left, 0);
  const viewRight = Math.min(cr.right, winW);

  const spaceAbove = anchorRect.top - viewTop;
  const spaceBelow = viewBottom - anchorRect.bottom;

  let top: number;
  if (preferY === 'above' && spaceAbove >= ph + gap) {
    top = anchorRect.top - ph - gap;
  } else if (preferY === 'below' && spaceBelow >= ph + gap) {
    top = anchorRect.bottom + gap;
  } else if (spaceAbove >= ph + gap && (preferY === 'above' || spaceAbove >= spaceBelow)) {
    top = anchorRect.top - ph - gap;
  } else if (spaceBelow >= ph + gap) {
    top = anchorRect.bottom + gap;
  } else {
    top = spaceAbove >= spaceBelow
      ? anchorRect.top - ph - gap
      : anchorRect.bottom + gap;
  }
  top = Math.max(viewTop + pad, Math.min(top, viewBottom - ph - pad));

  let left: number;
  if (alignX === 'center') {
    const mid = (anchorRect.left + anchorRect.right) / 2;
    left = mid - pw / 2;
  } else {
    left = anchorRect.left;
  }
  const maxLeft = viewRight - pw - pad;
  const minLeft = viewLeft + pad;
  left = Math.max(minLeft, Math.min(left, maxLeft));

  // If the body has CSS zoom, fixed positions are scaled by that zoom,
  // so divide to get the correct CSS value.
  popup.style.left = `${left / bz}px`;
  popup.style.top = `${top / bz}px`;

  return { left, top, width: pw, height: ph, bottom: top + ph, right: left + pw };
}
