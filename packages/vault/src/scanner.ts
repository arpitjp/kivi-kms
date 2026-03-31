import type { VaultHeading } from './types.js';

const WIKI_LINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const HEADING_RE = /^(#{1,6})\s+(.+)$/;
const TAG_RE = /(?:^|\s)#([a-zA-Z0-9_/][a-zA-Z0-9_/-]*)/g;
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const MD_LINK_RE = /\[([^\]]*)\]\(([^)]+)\)/g;
const ASSET_EXTS = /\.(png|jpe?g|gif|webp|svg|pdf|mp4|webm|mp3|ogg|wav|csv|xlsx?)$/i;

export interface ScanResult {
  title: string;
  wikiLinks: string[];
  markdownLinks: string[];
  assetRefs: string[];
  tags: string[];
  headings: VaultHeading[];
  frontmatter: Record<string, unknown>;
}

export function scanMarkdown(content: string): ScanResult {
  const wikiLinks = extractWikiLinks(content);
  const { markdownLinks, assetRefs } = extractMarkdownLinks(content);
  const tags = extractTags(content);
  const headings = extractHeadings(content);
  const frontmatter = extractFrontmatter(content);
  const title = deriveTitle(frontmatter, headings, '');

  return { title, wikiLinks, markdownLinks, assetRefs, tags, headings, frontmatter };
}

function extractWikiLinks(content: string): string[] {
  const links: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  WIKI_LINK_RE.lastIndex = 0;
  while ((match = WIKI_LINK_RE.exec(content)) !== null) {
    const target = match[1].trim();
    if (target && !seen.has(target)) {
      seen.add(target);
      links.push(target);
    }
  }

  return links;
}

function extractMarkdownLinks(content: string): { markdownLinks: string[]; assetRefs: string[] } {
  const markdownLinks: string[] = [];
  const assetRefs: string[] = [];
  const seenLinks = new Set<string>();
  const seenAssets = new Set<string>();

  MD_LINK_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MD_LINK_RE.exec(content)) !== null) {
    const href = match[2].trim();
    if (href.startsWith('http://') || href.startsWith('https://') || href.startsWith('#')) continue;

    if (ASSET_EXTS.test(href)) {
      if (!seenAssets.has(href)) { seenAssets.add(href); assetRefs.push(href); }
    } else {
      if (!seenLinks.has(href)) { seenLinks.add(href); markdownLinks.push(href); }
    }
  }

  // Also extract image references ![alt](path)
  const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  imgRe.lastIndex = 0;
  while ((match = imgRe.exec(content)) !== null) {
    const href = match[2].trim();
    if (href.startsWith('http://') || href.startsWith('https://')) continue;
    if (!seenAssets.has(href)) { seenAssets.add(href); assetRefs.push(href); }
  }

  return { markdownLinks, assetRefs };
}

function extractTags(content: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  const lines = content.split('\n');

  const fmMatch = FRONTMATTER_RE.exec(content);
  let fmEndLine = 0;
  if (fmMatch) {
    fmEndLine = fmMatch[0].split('\n').length;
  }

  for (let i = fmEndLine; i < lines.length; i++) {
    const line = lines[i];
    // Skip code blocks
    if (line.trimStart().startsWith('```')) {
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) i++;
      continue;
    }

    TAG_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = TAG_RE.exec(line)) !== null) {
      const tag = match[1];
      if (!seen.has(tag)) {
        seen.add(tag);
        tags.push(tag);
      }
    }
  }

  // Also extract from frontmatter `tags` field
  if (fmMatch) {
    const fm = parseFrontmatterYaml(fmMatch[1]);
    if (Array.isArray(fm.tags)) {
      for (const t of fm.tags) {
        const tag = String(t);
        if (!seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
        }
      }
    }
  }

  return tags;
}

function extractHeadings(content: string): VaultHeading[] {
  const headings: VaultHeading[] = [];
  const lines = content.split('\n');
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const match = HEADING_RE.exec(line);
    if (match) {
      headings.push({
        level: match[1].length,
        text: match[2].trim().replace(/\s+#+\s*$/, ''),
        line: i + 1,
      });
    }
  }

  return headings;
}

function extractFrontmatter(content: string): Record<string, unknown> {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) return {};
  return parseFrontmatterYaml(match[1]);
}

/**
 * Minimal YAML-ish parser for frontmatter (handles key: value and key: [list]).
 * Not a full YAML parser — covers the common PKM patterns.
 */
export function parseFrontmatterYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split('\n');
  let currentKey = '';
  let listValues: string[] | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // List continuation
    if (trimmed.startsWith('- ') && currentKey && listValues !== null) {
      listValues.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush any pending list
    if (listValues !== null && currentKey) {
      result[currentKey] = listValues;
      listValues = null;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    currentKey = key;

    if (rawValue === '') {
      listValues = [];
      continue;
    }

    // Inline array [a, b, c]
    if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
      result[key] = rawValue
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
      continue;
    }

    // Boolean/number coercion
    if (rawValue === 'true') { result[key] = true; continue; }
    if (rawValue === 'false') { result[key] = false; continue; }
    if (/^-?\d+(\.\d+)?$/.test(rawValue)) { result[key] = Number(rawValue); continue; }

    result[key] = rawValue.replace(/^["']|["']$/g, '');
  }

  // Flush trailing list
  if (listValues !== null && currentKey) {
    result[currentKey] = listValues;
  }

  return result;
}

function deriveTitle(
  frontmatter: Record<string, unknown>,
  headings: VaultHeading[],
  path: string,
): string {
  if (typeof frontmatter.title === 'string' && frontmatter.title) {
    return frontmatter.title;
  }
  const h1 = headings.find((h) => h.level === 1);
  if (h1) return h1.text;
  // Fall back to filename
  const parts = path.split('/');
  const filename = parts[parts.length - 1] || 'Untitled';
  return filename.replace(/\.md$/i, '');
}
