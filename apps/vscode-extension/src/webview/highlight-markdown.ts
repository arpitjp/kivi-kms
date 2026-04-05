function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightInline(text: string): string {
  const safe = esc(text);
  return safe.replace(
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(~~[^~]+~~)|(\[\[[^\]]+\]\])|(\[[^\]]*\]\([^)]*\))|(!\[[^\]]*\]\([^)]*\))|(#[a-zA-Z][\w/-]*)|(https?:\/\/\S+)/g,
    (match, code, bold1, bold2, italic1, italic2, strike, wikiLink, mdLink, image, tag, url) => {
      if (code) return `<span class="md-inline-code">${match}</span>`;
      if (bold1 || bold2) return `<span class="md-bold">${match}</span>`;
      if (italic1 || italic2) return `<span class="md-italic">${match}</span>`;
      if (strike) return `<span class="md-strike">${match}</span>`;
      if (wikiLink) return `<span class="md-wiki-link">${match}</span>`;
      if (mdLink) return `<span class="md-link">${match}</span>`;
      if (image) return `<span class="md-image">${match}</span>`;
      if (tag) return `<span class="md-tag">${match}</span>`;
      if (url) return `<span class="md-url">${match}</span>`;
      return match;
    },
  );
}

export function highlightMarkdown(text: string): string {
  const lines = text.split('\n');
  const result: string[] = [];
  let inCodeBlock = false;
  let inFrontmatter = false;
  const firstLine = lines[0]?.trim();
  if (firstLine === '---') inFrontmatter = true;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (inFrontmatter) {
      if (i > 0 && trimmed === '---') {
        result.push(`<span class="md-frontmatter">${esc(line)}</span>`);
        inFrontmatter = false;
        continue;
      }
      result.push(`<span class="md-frontmatter">${esc(line)}</span>`);
      continue;
    }

    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      result.push(`<span class="md-code-fence">${esc(line)}</span>`);
      continue;
    }

    if (inCodeBlock) {
      result.push(`<span class="md-code-content">${esc(line)}</span>`);
      continue;
    }

    const headingMatch = /^(#{1,6}\s)(.*)$/.exec(line);
    if (headingMatch) {
      result.push(`<span class="md-heading-marker">${esc(headingMatch[1])}</span><span class="md-heading">${highlightInline(headingMatch[2])}</span>`);
      continue;
    }

    if (/^(\s*[-*_]\s*){3,}$/.test(trimmed)) {
      result.push(`<span class="md-hr">${esc(line)}</span>`);
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const qMatch = /^(>\s?)(.*)$/.exec(line);
      if (qMatch) {
        result.push(`<span class="md-blockquote-marker">${esc(qMatch[1])}</span><span class="md-blockquote">${highlightInline(qMatch[2])}</span>`);
        continue;
      }
    }

    const taskMatch = /^(\s*[-*+]\s)(\[[ xX]\]\s)(.*)$/.exec(line);
    if (taskMatch) {
      result.push(`<span class="md-list-marker">${esc(taskMatch[1])}</span><span class="md-task-marker">${esc(taskMatch[2])}</span>${highlightInline(taskMatch[3])}`);
      continue;
    }

    const ulMatch = /^(\s*)([-*+]\s)(.*)$/.exec(line);
    if (ulMatch) {
      result.push(`${esc(ulMatch[1])}<span class="md-list-marker">${esc(ulMatch[2])}</span>${highlightInline(ulMatch[3])}`);
      continue;
    }
    const olMatch = /^(\s*)(\d+\.\s)(.*)$/.exec(line);
    if (olMatch) {
      result.push(`${esc(olMatch[1])}<span class="md-list-marker">${esc(olMatch[2])}</span>${highlightInline(olMatch[3])}`);
      continue;
    }

    result.push(highlightInline(line));
  }

  return result.join('\n');
}
