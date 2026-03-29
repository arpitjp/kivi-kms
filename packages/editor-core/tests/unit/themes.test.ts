import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { applyTheme, getThemeColors, allThemes } from '../../src/themes.js';
import type { KiviTheme } from '@kivi/shared-types';

describe('themes', () => {
  describe('allThemes', () => {
    it('contains all expected theme names', () => {
      expect(allThemes).toEqual(['dark', 'light', 'sepia', 'nord']);
    });
  });

  describe('getThemeColors', () => {
    it.each(allThemes)('returns colors for %s theme', (theme) => {
      const colors = getThemeColors(theme);
      expect(colors).toBeDefined();
      expect(colors.bg).toBeTruthy();
      expect(colors.bgSurface).toBeTruthy();
      expect(colors.bgEditor).toBeTruthy();
      expect(colors.text).toBeTruthy();
      expect(colors.textMuted).toBeTruthy();
      expect(colors.border).toBeTruthy();
      expect(colors.accent).toBeTruthy();
      expect(colors.accentHover).toBeTruthy();
    });

    it('falls back to dark for unknown theme', () => {
      const colors = getThemeColors('nonexistent' as KiviTheme);
      const dark = getThemeColors('dark');
      expect(colors.bg).toBe(dark.bg);
    });
  });

  describe('applyTheme', () => {
    let root: HTMLElement;

    beforeEach(() => {
      root = document.createElement('div');
      document.body.appendChild(root);
    });

    afterEach(() => {
      root.remove();
    });

    it('sets CSS custom properties on the root element', () => {
      applyTheme(root, 'dark');
      expect(root.style.getPropertyValue('--bg')).toBeTruthy();
      expect(root.style.getPropertyValue('--text')).toBeTruthy();
      expect(root.style.getPropertyValue('--accent')).toBeTruthy();
    });

    it('sets the data-theme attribute', () => {
      applyTheme(root, 'light');
      expect(root.getAttribute('data-theme')).toBe('light');
    });

    it('applies all CSS variables for each theme', () => {
      for (const theme of allThemes) {
        applyTheme(root, theme);
        expect(root.style.getPropertyValue('--bg')).toBeTruthy();
        expect(root.style.getPropertyValue('--bg-surface')).toBeTruthy();
        expect(root.style.getPropertyValue('--bg-editor')).toBeTruthy();
        expect(root.style.getPropertyValue('--text')).toBeTruthy();
        expect(root.style.getPropertyValue('--text-muted')).toBeTruthy();
        expect(root.style.getPropertyValue('--border')).toBeTruthy();
        expect(root.style.getPropertyValue('--accent')).toBeTruthy();
        expect(root.style.getPropertyValue('--accent-hover')).toBeTruthy();
        expect(root.style.getPropertyValue('--kivi-tag-color')).toBeTruthy();
        expect(root.style.getPropertyValue('--kivi-error')).toBeTruthy();
        expect(root.style.getPropertyValue('--kivi-success')).toBeTruthy();
      }
    });

    it('sets font options when provided', () => {
      applyTheme(root, 'dark', {
        fontFamily: 'Fira Code',
        fontSize: 16,
        lineHeight: 1.8,
      });
      expect(root.style.getPropertyValue('--kivi-font')).toBe('Fira Code');
      expect(root.style.getPropertyValue('--kivi-font-size')).toBe('16px');
      expect(root.style.getPropertyValue('--kivi-line-height')).toBe('1.8');
    });

    it('does not set font vars when options are not provided', () => {
      applyTheme(root, 'dark');
      // Font vars should not be explicitly set (they remain empty)
      expect(root.style.getPropertyValue('--kivi-font')).toBe('');
    });

    it('light theme has different colors than dark', () => {
      const dark = getThemeColors('dark');
      const light = getThemeColors('light');
      expect(dark.bg).not.toBe(light.bg);
      expect(dark.text).not.toBe(light.text);
    });
  });
});
