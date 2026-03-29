import type { KiviTheme, ThemeColors } from '@kivi/shared-types';

interface ExtendedColors extends ThemeColors {
  tagColor: string;
  selectionBg: string;
  focusRing: string;
  successColor: string;
  errorColor: string;
}

const themes: Record<KiviTheme, ExtendedColors> = {
  dark: {
    bg: '#1f1f1f',
    bgSurface: '#181818',
    bgEditor: '#1f1f1f',
    text: '#cccccc',
    textMuted: '#7d7d7d',
    border: '#2b2b2b',
    accent: '#4daafc',
    accentHover: '#3c9cf0',
    tagColor: '#4ec9b0',
    selectionBg: 'rgba(38, 79, 120, 0.5)',
    focusRing: '#4daafc',
    successColor: '#4ec9b0',
    errorColor: '#f44747',
  },
  light: {
    bg: '#ffffff',
    bgSurface: '#f8fafc',
    bgEditor: '#ffffff',
    text: '#1e293b',
    textMuted: '#64748b',
    border: '#e2e8f0',
    accent: '#6366f1',
    accentHover: '#4f46e5',
    tagColor: '#059669',
    selectionBg: 'rgba(99, 102, 241, 0.15)',
    focusRing: '#6366f1',
    successColor: '#059669',
    errorColor: '#dc2626',
  },
  sepia: {
    bg: '#f5f0e8',
    bgSurface: '#ede6d8',
    bgEditor: '#faf6ee',
    text: '#433422',
    textMuted: '#7a6a52',
    border: '#d4c9b4',
    accent: '#b06028',
    accentHover: '#944e1c',
    tagColor: '#7c6828',
    selectionBg: 'rgba(176, 96, 40, 0.15)',
    focusRing: '#b06028',
    successColor: '#527a40',
    errorColor: '#a03030',
  },
  nord: {
    bg: '#2e3440',
    bgSurface: '#3b4252',
    bgEditor: '#2e3440',
    text: '#eceff4',
    textMuted: '#a0aec0',
    border: '#4c566a',
    accent: '#88c0d0',
    accentHover: '#81a1c1',
    tagColor: '#a3be8c',
    selectionBg: 'rgba(136, 192, 208, 0.2)',
    focusRing: '#88c0d0',
    successColor: '#a3be8c',
    errorColor: '#bf616a',
  },
};

export function getThemeColors(theme: KiviTheme): ThemeColors & { tagColor: string; selectionBg: string; focusRing: string; successColor: string; errorColor: string } {
  return themes[theme] ?? themes.dark;
}

export function applyTheme(
  root: HTMLElement,
  theme: KiviTheme,
  options?: { fontFamily?: string; fontSize?: number; lineHeight?: number },
): void {
  const colors = themes[theme] ?? themes.dark;
  root.style.setProperty('--bg', colors.bg);
  root.style.setProperty('--bg-surface', colors.bgSurface);
  root.style.setProperty('--bg-editor', colors.bgEditor);
  root.style.setProperty('--text', colors.text);
  root.style.setProperty('--text-muted', colors.textMuted);
  root.style.setProperty('--border', colors.border);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--accent-hover', colors.accentHover);
  root.style.setProperty('--kivi-tag-color', colors.tagColor);
  root.style.setProperty('--kivi-selection-bg', colors.selectionBg);
  root.style.setProperty('--kivi-focus-ring', colors.focusRing);
  root.style.setProperty('--kivi-success', colors.successColor);
  root.style.setProperty('--kivi-error', colors.errorColor);

  if (options?.fontFamily) {
    root.style.setProperty('--kivi-font', options.fontFamily);
  }
  if (options?.fontSize) {
    root.style.setProperty('--kivi-font-size', `${options.fontSize}px`);
  }
  if (options?.lineHeight) {
    root.style.setProperty('--kivi-line-height', String(options.lineHeight));
  }

  root.setAttribute('data-theme', theme);
}

export const allThemes: KiviTheme[] = ['dark', 'light', 'sepia', 'nord'];
