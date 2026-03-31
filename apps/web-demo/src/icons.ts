/**
 * Inline SVG icons for the Kivi UI — 16×16.
 *
 * Style guide:
 *   Toolbar / editor controls  → Codicon-inspired (fill, chunky, IDE-like)
 *   Sidebar / tree / outline   → Tabler-inspired (1.5 stroke, geometric)
 *   App / settings / search    → Lucide-inspired (1.5 stroke, elegant)
 */

// ── helpers ──────────────────────────────────────────────────────

/** Stroke-based wrapper (Lucide / Tabler style) */
const s = (d: string, extra = '') =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

/** Fill-based wrapper (Codicon style) */
const f = (d: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">${d}</svg>`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TOOLBAR — Codicon-inspired, chunky, IDE-feel
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const iconBold = () => f(
  '<path d="M4 2.5h4.5a3 3 0 0 1 2.12 5.12A3.25 3.25 0 0 1 9 13.5H4V2.5zM4 8h5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>',
);

export const iconItalic = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">` +
  `<line x1="10" y1="2.5" x2="6" y2="13.5"/>` +
  `<line x1="7.5" y1="2.5" x2="11.5" y2="2.5"/>` +
  `<line x1="4.5" y1="13.5" x2="8.5" y2="13.5"/>` +
  `</svg>`;

export const iconStrike = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">` +
  `<line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5"/>` +
  `<path d="M10.2 4.8C9.7 3.6 8.6 3 7.5 3 5.8 3 4.5 4 4.5 5.5c0 1 .5 1.7 1.3 2.2" stroke-width="1.6" fill="none"/>` +
  `<path d="M5.8 11.2c.5 1.2 1.6 1.8 2.7 1.8 1.7 0 3-1 3-2.5 0-.7-.3-1.3-.8-1.7" stroke-width="1.6" fill="none"/>` +
  `</svg>`;

export const iconCode = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
  `<polyline points="5,3.5 1.5,8 5,12.5"/>` +
  `<polyline points="11,3.5 14.5,8 11,12.5"/>` +
  `</svg>`;

export const iconH1 = () => f(
  '<path d="M2.5 3v10M2.5 8h5M7.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
  '<path d="M11 11V6l-1.2.8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
);

export const iconH2 = () => f(
  '<path d="M2 3v10M2 8h4.5M6.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
  '<path d="M9.5 6.5a2 2 0 0 1 3.8.7c0 1.2-1.3 2.3-3.3 3.8h3.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
);

export const iconH3 = () => f(
  '<path d="M1.5 3v10M1.5 8h4M5.5 3v10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
  '<path d="M9.5 6.3a1.8 1.8 0 0 1 3.2.5 1.6 1.6 0 0 1-1.2 1.7 1.8 1.8 0 0 1 1.5 1.8 2 2 0 0 1-3.5 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
);

// ── Lists (Codicon-style, filled bullets, thick lines) ──────────

export const iconBulletList = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round">` +
  `<circle cx="3" cy="4" r="1.3" fill="currentColor" stroke="none"/>` +
  `<circle cx="3" cy="8" r="1.3" fill="currentColor" stroke="none"/>` +
  `<circle cx="3" cy="12" r="1.3" fill="currentColor" stroke="none"/>` +
  `<line x1="6.5" y1="4" x2="14" y2="4"/>` +
  `<line x1="6.5" y1="8" x2="14" y2="8"/>` +
  `<line x1="6.5" y1="12" x2="14" y2="12"/>` +
  `</svg>`;

export const iconOrderedList = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-linecap="round">` +
  `<text x="1.5" y="5.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">1</text>` +
  `<text x="1.5" y="9.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">2</text>` +
  `<text x="1.5" y="13.5" font-size="5.5" font-family="system-ui,-apple-system,sans-serif" font-weight="700" stroke="none">3</text>` +
  `<line x1="6.5" y1="4" x2="14" y2="4" stroke-width="1.6" fill="none"/>` +
  `<line x1="6.5" y1="8" x2="14" y2="8" stroke-width="1.6" fill="none"/>` +
  `<line x1="6.5" y1="12" x2="14" y2="12" stroke-width="1.6" fill="none"/>` +
  `</svg>`;

export const iconTaskList = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="1.5" y="1.5" width="5" height="5" rx="1"/>` +
  `<polyline points="3,4 4,5.2 6,2.8" stroke-width="1.6"/>` +
  `<line x1="9" y1="4" x2="14.5" y2="4"/>` +
  `<rect x="1.5" y="9.5" width="5" height="5" rx="1"/>` +
  `<line x1="9" y1="12" x2="14.5" y2="12"/>` +
  `</svg>`;

// ── Blocks (Codicon-style) ──────────────────────────────────────

export const iconQuote = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round">` +
  `<line x1="1.5" y1="2.5" x2="1.5" y2="13.5" stroke-width="2.5"/>` +
  `<line x1="5" y1="4" x2="14" y2="4" stroke-width="1.5"/>` +
  `<line x1="5" y1="8" x2="11" y2="8" stroke-width="1.5"/>` +
  `<line x1="5" y1="12" x2="13" y2="12" stroke-width="1.5"/>` +
  `</svg>`;

export const iconCodeBlock = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="1.5" y="1" width="13" height="14" rx="2"/>` +
  `<polyline points="5.5,5.5 3.5,8 5.5,10.5"/>` +
  `<polyline points="10.5,5.5 12.5,8 10.5,10.5"/>` +
  `</svg>`;

export const iconHr = () => s('<line x1="2" y1="8" x2="14" y2="8" stroke-width="1.5" stroke-dasharray="3,2"/>');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// VIEW MODES — Proper panel layout icons
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const iconViewLive = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="1.5" y="2" width="13" height="12" rx="2"/>` +
  `<line x1="4.5" y1="5.5" x2="11.5" y2="5.5"/>` +
  `<line x1="4.5" y1="8" x2="9" y2="8"/>` +
  `<line x1="4.5" y1="10.5" x2="11.5" y2="10.5"/>` +
  `</svg>`;

export const iconViewSplit = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="1.5" y="2" width="13" height="12" rx="2"/>` +
  `<line x1="8" y1="2" x2="8" y2="14"/>` +
  `<line x1="3.5" y1="5" x2="6.5" y2="5" stroke-width="1"/>` +
  `<line x1="3.5" y1="7" x2="5.5" y2="7" stroke-width="1"/>` +
  `<text x="9.5" y="8.5" font-size="5" fill="currentColor" stroke="none" font-family="monospace">#</text>` +
  `</svg>`;

export const iconViewMarkdown = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">` +
  `<rect x="1.5" y="2" width="13" height="12" rx="2"/>` +
  `<path d="M4 10V6l2 2.5L8 6v4" stroke-width="1.4" fill="none"/>` +
  `<polyline points="10.5,9.5 12,7.5 13.5,9.5" stroke-width="1.4" fill="none"/>` +
  `</svg>`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// APP ACTIONS — Lucide-inspired
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const iconGraph = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">` +
  `<circle cx="8" cy="3.5" r="2"/>` +
  `<circle cx="3.5" cy="12" r="2"/>` +
  `<circle cx="12.5" cy="12" r="2"/>` +
  `<line x1="6.8" y1="5.2" x2="4.7" y2="10.3"/>` +
  `<line x1="9.2" y1="5.2" x2="11.3" y2="10.3"/>` +
  `</svg>`;

export const iconSearch = () => s(
  '<circle cx="7" cy="7" r="4"/><line x1="10.2" y1="10.2" x2="13.5" y2="13.5" stroke-width="1.8"/>',
);

export const iconChevronDown = () => s('<polyline points="4,6 8,10 12,6"/>');
export const iconChevronUp = () => s('<polyline points="4,10 8,6 12,10"/>');

export const iconToolbar = () => s(
  '<line x1="3" y1="4" x2="13" y2="4"/>' +
  '<line x1="3" y1="8" x2="13" y2="8"/>' +
  '<line x1="3" y1="12" x2="10" y2="12"/>',
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TABLE CONTROLS — Codicon-inspired
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const tc = (d: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const iconRowAfter = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="8" y1="10" x2="8" y2="14" stroke-width="1.8"/><line x1="6" y1="12" x2="10" y2="12" stroke-width="1.8"/>');
export const iconColAfter = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="10" y1="8" x2="14" y2="8" stroke-width="1.8"/><line x1="12" y1="6" x2="12" y2="10" stroke-width="1.8"/>');
export const iconRowBefore = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="8" y1="2" x2="8" y2="6" stroke-width="1.8"/><line x1="6" y1="4" x2="10" y2="4" stroke-width="1.8"/>');
export const iconColBefore = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="6" y2="8" stroke-width="1.8"/><line x1="4" y1="6" x2="4" y2="10" stroke-width="1.8"/>');
export const iconDeleteRow = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="8" x2="14" y2="8"/><line x1="5" y1="11" x2="11" y2="11" stroke="var(--kivi-error, #f44747)" stroke-width="1.8"/>');
export const iconDeleteCol = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="11" y1="5" x2="11" y2="11" stroke="var(--kivi-error, #f44747)" stroke-width="1.8"/>');
export const iconHeaderRow = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="2" y1="6" x2="14" y2="6"/><rect x="3" y="3" width="10" height="2" fill="currentColor" stroke="none" rx="0.5"/>');
export const iconMergeCells = () => tc('<rect x="2" y="2" width="12" height="12" rx="1.5"/><line x1="8" y1="2" x2="8" y2="14"/><line x1="2" y1="8" x2="14" y2="8"/><polyline points="6,6 8,8 6,10"/><polyline points="10,6 8,8 10,10"/>');
export const iconTrash = () => s(
  '<polyline points="3,4 13,4"/>' +
  '<path d="M5.5 4V3a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1"/>' +
  '<path d="M4 4l.7 9.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8L12 4"/>',
);

// ── Image controls (Lucide-style) ───────────────────────────────

export const iconAlignLeft = () => s(
  '<line x1="2" y1="3" x2="14" y2="3"/>' +
  '<line x1="2" y1="7" x2="10" y2="7"/>' +
  '<line x1="2" y1="11" x2="14" y2="11"/>',
);
export const iconAlignCenter = () => s(
  '<line x1="2" y1="3" x2="14" y2="3"/>' +
  '<line x1="4" y1="7" x2="12" y2="7"/>' +
  '<line x1="2" y1="11" x2="14" y2="11"/>',
);
export const iconAlignRight = () => s(
  '<line x1="2" y1="3" x2="14" y2="3"/>' +
  '<line x1="6" y1="7" x2="14" y2="7"/>' +
  '<line x1="2" y1="11" x2="14" y2="11"/>',
);
export const iconAlt = () => f(
  '<rect x="1" y="4" width="14" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/>' +
  '<text x="3.5" y="10.5" font-size="6" font-family="system-ui,-apple-system,sans-serif" font-weight="600" stroke="none">Alt</text>',
);

// ── Link popup (Lucide-style) ───────────────────────────────────

export const iconEdit = () => s('<path d="M11.5 2.5a1.5 1.5 0 0 1 2 2L5 13l-3 1 1-3z"/>');
export const iconUnlink = () => s(
  '<path d="M7 11l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L3.5 7.5"/>' +
  '<path d="M9 5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L12.5 8.5"/>' +
  '<line x1="4" y1="12" x2="12" y2="4" stroke-dasharray="1.5,2"/>',
);
export const iconCopy = () => s(
  '<rect x="5" y="5" width="9" height="9" rx="1.5"/>' +
  '<path d="M5 11H3.5A1.5 1.5 0 0 1 2 9.5V3.5A1.5 1.5 0 0 1 3.5 2h6A1.5 1.5 0 0 1 11 3.5V5"/>',
);
export const iconCheck = () => s('<polyline points="3,8 6.5,11.5 13,4.5" stroke-width="2"/>');

// ── Zoom (Lucide-style) ─────────────────────────────────────────

export const iconZoomIn = () => s(
  '<circle cx="7" cy="7" r="4.5"/>' +
  '<line x1="10.8" y1="10.8" x2="14" y2="14" stroke-width="1.8"/>' +
  '<line x1="5" y1="7" x2="9" y2="7"/>' +
  '<line x1="7" y1="5" x2="7" y2="9"/>',
);
export const iconZoomOut = () => s(
  '<circle cx="7" cy="7" r="4.5"/>' +
  '<line x1="10.8" y1="10.8" x2="14" y2="14" stroke-width="1.8"/>' +
  '<line x1="5" y1="7" x2="9" y2="7"/>',
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SIDEBAR / SECTION CONTROLS — Tabler-inspired
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const iconNewFile = () => s(
  '<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/>' +
  '<polyline points="9,2 9,6 13,6"/>' +
  '<line x1="6" y1="9.5" x2="10" y2="9.5" stroke-width="1.6"/>' +
  '<line x1="8" y1="7.5" x2="8" y2="11.5" stroke-width="1.6"/>',
);

export const iconMove = () => s(
  '<polyline points="2,8 5,5"/><polyline points="2,8 5,11"/>' +
  '<polyline points="14,8 11,5"/><polyline points="14,8 11,11"/>' +
  '<line x1="2" y1="8" x2="14" y2="8"/>',
);

export const iconGrip = () =>
  `<svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">` +
  `<circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/>` +
  `<circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/>` +
  `<circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/>` +
  `</svg>`;

// ── File tree icons ─────────────────────────────────────────

export const iconFile = () => s(
  '<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/>' +
  '<polyline points="9,2 9,6 13,6"/>',
);

export const iconFileMarkdown = () =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` +
  `<path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6z"/>` +
  `<polyline points="9,2 9,6 13,6"/>` +
  `<path d="M5.5 11V9l1.2 1.2L8 9v2" stroke-width="1.2"/>` +
  `</svg>`;

export const iconFolder = () => s(
  '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/>',
);

export const iconFolderOpen = () => s(
  '<path d="M2 4.5A1.5 1.5 0 0 1 3.5 3H6l1.5 1.5h5A1.5 1.5 0 0 1 14 6v1H4L2 12V4.5z"/>' +
  '<path d="M2 12l2-5h10l-2 5z"/>',
);

export const iconCollapseAll = () => s(
  '<polyline points="4,5 8,2 12,5"/>' +
  '<polyline points="4,11 8,8 12,11"/>',
);

export const iconChevronRight = () => s('<polyline points="6,4 10,8 6,12"/>');

// ── Sidebar pane icons ──────────────────────────────────────────

export const iconBacklink = () => s(
  '<path d="M7 11l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5L3.5 7.5"/>' +
  '<path d="M9 5l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5L12.5 8.5"/>' +
  '<line x1="5.5" y1="10.5" x2="10.5" y2="5.5"/>',
);

export const iconGitCommit = () => s(
  '<circle cx="8" cy="8" r="2.5"/>' +
  '<line x1="1" y1="8" x2="5.5" y2="8"/>' +
  '<line x1="10.5" y1="8" x2="15" y2="8"/>',
);

// ── Code block controls (Lucide-style) ──────────────────────────

export const iconWrap = () => s(
  '<path d="M3 4h10"/>' +
  '<path d="M3 8h7a2 2 0 0 1 2 2v0a2 2 0 0 1-2 2H8"/>' +
  '<polyline points="9.5,10.5 8,12 9.5,13.5"/>',
);

// ── Settings (Lucide-style gear) ────────────────────────────────

export const iconSettings = () => s(
  '<circle cx="8" cy="8" r="2.2"/>' +
  '<path d="M8 1v2M8 13v2M1 8h2M13 8h2' +
  'M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4' +
  'M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"/>',
);
