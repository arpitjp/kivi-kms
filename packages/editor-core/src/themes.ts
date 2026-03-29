import type { KiviTheme, ThemeColors } from '@kivi/shared-types';

const themes: Record<KiviTheme, ThemeColors> = {
  dark: {
    bg: '#1a1a2e',
    bgSurface: '#16213e',
    bgEditor: '#0f172a',
    text: '#e2e8f0',
    textMuted: '#94a3b8',
    border: '#334155',
    accent: '#818cf8',
    accentHover: '#6366f1',
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
  },
  nord: {
    bg: '#2e3440',
    bgSurface: '#3b4252',
    bgEditor: '#2e3440',
    text: '#eceff4',
    textMuted: '#d8dee9',
    border: '#4c566a',
    accent: '#88c0d0',
    accentHover: '#81a1c1',
  },
};

export function getThemeColors(theme: KiviTheme): ThemeColors {
  return themes[theme] ?? themes.dark;
}

export function applyTheme(
  root: HTMLElement,
  theme: KiviTheme,
  options?: { fontFamily?: string; fontSize?: number; lineHeight?: number },
): void {
  const colors = getThemeColors(theme);
  root.style.setProperty('--bg', colors.bg);
  root.style.setProperty('--bg-surface', colors.bgSurface);
  root.style.setProperty('--bg-editor', colors.bgEditor);
  root.style.setProperty('--text', colors.text);
  root.style.setProperty('--text-muted', colors.textMuted);
  root.style.setProperty('--border', colors.border);
  root.style.setProperty('--accent', colors.accent);
  root.style.setProperty('--accent-hover', colors.accentHover);

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
