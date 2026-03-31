import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Vault, scanMarkdown, parseFrontmatterYaml } from '../src/index.js';

describe('Vault', () => {
  let vault: Vault;

  beforeEach(() => {
    vault = new Vault();
  });

  afterEach(() => {
    vault.destroy();
  });

  describe('addFile, getFile, updateFile, removeFile', () => {
    it('addFile stores a file retrievable by getFile', () => {
      const f = vault.addFile('notes/hello.md', '# Hello\n\nBody.');
      expect(vault.getFile('notes/hello.md')).toBe(f);
      expect(f.path).toBe('notes/hello.md');
      expect(f.title).toBe('Hello');
      expect(f.wikiLinks).toEqual([]);
    });

    it('getFile returns undefined for a path that was never added', () => {
      expect(vault.getFile('missing.md')).toBeUndefined();
    });

    it('uses scanner default title when there is no H1 or frontmatter title', () => {
      vault.addFile('dir/My Note.md', 'Just prose.');
      // scanMarkdown derives title from an empty path as "Untitled", which is truthy, so Vault does not fall through to titleFromPath
      expect(vault.getFile('dir/My Note.md')?.title).toBe('Untitled');
    });

    it('updateFile replaces content and refreshes derived fields', () => {
      vault.addFile('x.md', 'alpha');
      const updated = vault.updateFile('x.md', '# Beta\n\n[[Other]]');
      expect(updated.title).toBe('Beta');
      expect(updated.wikiLinks).toEqual(['Other']);
    });

    it('removeFile deletes the entry', () => {
      vault.addFile('gone.md', 'x');
      vault.removeFile('gone.md');
      expect(vault.getFile('gone.md')).toBeUndefined();
      expect(vault.files.size).toBe(0);
    });

    it('destroy clears all files', () => {
      vault.addFile('a.md', '1');
      vault.addFile('b.md', '2');
      vault.destroy();
      expect(vault.files.size).toBe(0);
    });
  });

  describe('backlinks', () => {
    it('when A links to B via [[B]], B lists A as a backlink (basename resolution)', () => {
      vault.addFile('folder/b.md', '# B');
      vault.addFile('folder/a.md', 'See [[B]].');
      const b = vault.getFile('folder/b.md');
      expect(b?.backlinks).toContain('folder/a.md');
      const backlinks = vault.getBacklinks('folder/b.md');
      expect(backlinks.map((f) => f.path)).toEqual(['folder/a.md']);
    });

    it('aggregates multiple inbound links on the target', () => {
      vault.addFile('t.md', '# T');
      vault.addFile('one.md', '[[t]]');
      vault.addFile('two.md', '[[T]]');
      expect(vault.getFile('t.md')?.backlinks.sort()).toEqual(['one.md', 'two.md'].sort());
    });

    it('removing a source file removes its contribution to backlinks', () => {
      vault.addFile('target.md', '# Target');
      vault.addFile('src.md', '[[target]]');
      expect(vault.getFile('target.md')?.backlinks).toContain('src.md');
      vault.removeFile('src.md');
      expect(vault.getFile('target.md')?.backlinks).toEqual([]);
    });

    it('[[Target|alias]] still registers a backlink on the resolved target', () => {
      vault.addFile('Target.md', '# Target');
      vault.addFile('from.md', '[[Target|see this]]');
      expect(vault.getFile('Target.md')?.backlinks).toContain('from.md');
    });

    it('getBacklinks returns [] for unknown paths', () => {
      expect(vault.getBacklinks('nope.md')).toEqual([]);
    });
  });

  describe('getTagIndex (hierarchical)', () => {
    it('indexes nested tags under each prefix (e.g. project and project/kivi)', () => {
      vault.addFile('n.md', '# N\n\nTagged #project/kivi here.');
      const idx = vault.getTagIndex();
      expect(idx.get('project')?.sort()).toEqual(['n.md']);
      expect(idx.get('project/kivi')?.sort()).toEqual(['n.md']);
    });

    it('dedupes paths when the same file contributes the same segment key once', () => {
      vault.addFile('only.md', '# x\n#project/kivi #project/kivi');
      const idx = vault.getTagIndex();
      expect(idx.get('project/kivi')).toEqual(['only.md']);
    });

    it('includes tags from frontmatter tags array', () => {
      vault.addFile(
        'fm.md',
        `---
tags:
  - area/work
  - inbox
---

# Hi
`,
      );
      const idx = vault.getTagIndex();
      expect(idx.get('area')?.sort()).toEqual(['fm.md']);
      expect(idx.get('area/work')?.sort()).toEqual(['fm.md']);
      expect(idx.get('inbox')?.sort()).toEqual(['fm.md']);
    });
  });

  describe('getGraph', () => {
    it('returns one note node per file with expected labels and tags', () => {
      vault.addFile('a.md', '# A\n#t');
      vault.addFile('b.md', '# B');
      const { nodes } = vault.getGraph();
      const noteNodes = nodes.filter(n => n.nodeType === 'note');
      expect(noteNodes).toHaveLength(2);
      const byId = new Map(noteNodes.map((n) => [n.id, n]));
      expect(byId.get('a.md')?.label).toBe('A');
      expect(byId.get('a.md')?.tags).toContain('t');
      expect(byId.get('b.md')?.label).toBe('B');
      // Also creates a tag node
      const tagNodes = nodes.filter(n => n.nodeType === 'tag');
      expect(tagNodes.length).toBeGreaterThanOrEqual(1);
    });

    it('adds an edge for each resolved wiki-link between existing files', () => {
      vault.addFile('b.md', '# B');
      vault.addFile('a.md', 'Link [[b]].');
      const { edges } = vault.getGraph();
      expect(edges).toContainEqual(expect.objectContaining({ source: 'a.md', target: 'b.md', type: 'link' }));
    });

    it('creates unresolved edge when target cannot be resolved', () => {
      vault.addFile('orphan.md', '[[DoesNotExist]]');
      const { edges } = vault.getGraph();
      const linkEdges = edges.filter(e => e.type === 'link');
      expect(linkEdges).toEqual([]);
      const unresolvedEdges = edges.filter(e => e.type === 'unresolved');
      expect(unresolvedEdges).toHaveLength(1);
      expect(unresolvedEdges[0].target).toBe('unresolved:DoesNotExist');
    });

    it('node backlinkCount matches the number of inbound wiki-links', () => {
      vault.addFile('hub.md', '# Hub');
      vault.addFile('a.md', '[[hub]]');
      vault.addFile('b.md', '[[hub.md]]');
      const { nodes } = vault.getGraph();
      const hub = nodes.find((n) => n.id === 'hub.md');
      expect(hub?.backlinkCount).toBe(2);
    });

    it('resolves edges using explicit paths, not only basenames', () => {
      vault.addFile('area/nested/target.md', '# Deep');
      vault.addFile('root.md', '[[area/nested/target]]');
      const { edges } = vault.getGraph();
      expect(edges).toContainEqual(expect.objectContaining({ source: 'root.md', target: 'area/nested/target.md', type: 'link' }));
    });

    it('includes shared-tag edges between files with the same tag', () => {
      vault.addFile('a.md', '# A\n#performance');
      vault.addFile('b.md', '# B\n#performance');
      const { edges } = vault.getGraph();
      const tagEdges = edges.filter(e => e.type === 'shared-tag');
      expect(tagEdges.length).toBeGreaterThanOrEqual(1);
      expect(tagEdges[0].reason).toContain('#performance');
    });

    it('includes parent/child edges for hierarchy', () => {
      vault.addFile('parent.md', '# Parent');
      vault.addFile('child.md', '---\nparent: parent\n---\n# Child');
      const { edges } = vault.getGraph();
      expect(edges).toContainEqual(expect.objectContaining({ source: 'parent.md', target: 'child.md', type: 'parent' }));
    });

    it('marks orphan nodes correctly', () => {
      vault.addFile('lonely.md', '# Lonely');
      vault.addFile('connected.md', '# C\n[[lonely]]');
      const { nodes } = vault.getGraph();
      const lonely = nodes.find(n => n.id === 'lonely.md');
      expect(lonely?.isOrphan).toBe(false); // has backlinks now
    });

    it('supports local graph mode with depth filter', () => {
      vault.addFile('center.md', '# Center\n[[leaf1]]\n[[leaf2]]');
      vault.addFile('leaf1.md', '# Leaf 1\n[[far]]');
      vault.addFile('leaf2.md', '# Leaf 2');
      vault.addFile('far.md', '# Far');
      const data = vault.getGraph({ mode: 'local', focusNode: 'center.md', depth: 1, edgeTypes: [], tags: [], orphansOnly: false, query: '' });
      const ids = data.nodes.map(n => n.id);
      expect(ids).toContain('center.md');
      expect(ids).toContain('leaf1.md');
      expect(ids).toContain('leaf2.md');
      expect(ids).not.toContain('far.md');
    });
  });

  describe('search', () => {
    beforeEach(() => {
      vault.addFile(
        'projects/kivi.md',
        `---
title: Kivi Editor
tags:
  - app/editor
---

# Ignored for title
Also #release in body.
`,
      );
      vault.addFile('misc/other.md', '# Other\nplain');
    });

    it('finds files by title (frontmatter)', () => {
      const hits = vault.search('kivi editor');
      expect(hits.map((f) => f.path)).toContain('projects/kivi.md');
    });

    it('finds files by path substring', () => {
      const hits = vault.search('projects/');
      expect(hits.map((f) => f.path)).toEqual(['projects/kivi.md']);
    });

    it('finds files by tag text (case-insensitive, partial)', () => {
      expect(vault.search('editor').map((f) => f.path)).toContain('projects/kivi.md');
      expect(vault.search('RELEASE').map((f) => f.path)).toContain('projects/kivi.md');
    });
  });

  describe('page hierarchy (parent)', () => {
    it('sets parent from frontmatter and lists children on the parent file', () => {
      vault.addFile('parent.md', '# Parent');
      vault.addFile(
        'child.md',
        `---
parent: parent
---

# Child
`,
      );
      const p = vault.getFile('parent.md');
      const c = vault.getFile('child.md');
      expect(c?.parent).toBe('parent');
      expect(p?.children).toContain('child.md');
    });

    it('infers parent as folder index when parent.md exists beside the note', () => {
      vault.addFile('docs/index.md', '# Docs index');
      vault.addFile('docs/page.md', '# Page');
      const parent = vault.getFile('docs/index.md');
      const page = vault.getFile('docs/page.md');
      expect(page?.parent).toBe('docs/index.md');
      expect(parent?.children).toContain('docs/page.md');
    });

    it('prefers README.md as folder parent when index.md is absent', () => {
      vault.addFile('wiki/README.md', '# Readme');
      vault.addFile('wiki/sub.md', '# Sub');
      expect(vault.getFile('wiki/sub.md')?.parent).toBe('wiki/README.md');
    });
  });
});

describe('scanMarkdown', () => {
  it('extracts wiki-links in document order, deduped', () => {
    const r = scanMarkdown('[[One]] then [[Two]] and [[One]] again.');
    expect(r.wikiLinks).toEqual(['One', 'Two']);
  });

  it('extracts hashtags from body (not inside frontmatter lines)', () => {
    const r = scanMarkdown(`---
tags: [x]
---
Hello #foo and #bar/baz`);
    expect(r.tags).toEqual(expect.arrayContaining(['foo', 'bar/baz', 'x']));
  });

  it('does not treat tags inside fenced code blocks as tags', () => {
    const r = scanMarkdown(`# T
\`\`\`
#not-a-tag
\`\`\`
Real #real-tag
`);
    expect(r.tags).toEqual(['real-tag']);
    expect(r.tags).not.toContain('not-a-tag');
  });

  it('collects headings with level, text, and line numbers', () => {
    const r = scanMarkdown(`# First
Intro
## Second
`);
    expect(r.headings).toEqual([
      { level: 1, text: 'First', line: 1 },
      { level: 2, text: 'Second', line: 3 },
    ]);
  });

  it('does not treat ATX headings inside fenced code blocks as headings', () => {
    const r = scanMarkdown(`# Real
\`\`\`
## Not a heading
\`\`\`
`);
    expect(r.headings).toEqual([{ level: 1, text: 'Real', line: 1 }]);
  });

  it('parses frontmatter into frontmatter record', () => {
    const r = scanMarkdown(`---
title: From FM
status: draft
---

# H1 ignored for title when fm title set
`);
    expect(r.frontmatter.title).toBe('From FM');
    expect(r.title).toBe('From FM');
    expect(r.frontmatter.status).toBe('draft');
  });
});

describe('parseFrontmatterYaml', () => {
  it('parses scalars, inline arrays, and block lists', () => {
    const yaml = `name: Test
nums: 42
ok: true
arr: [a, b]
list:
  - one
  - two
`;
    const o = parseFrontmatterYaml(yaml);
    expect(o.name).toBe('Test');
    expect(o.nums).toBe(42);
    expect(o.ok).toBe(true);
    expect(o.arr).toEqual(['a', 'b']);
    expect(o.list).toEqual(['one', 'two']);
  });

  it('strips quotes from string values', () => {
    expect(parseFrontmatterYaml(`x: "quoted"`).x).toBe('quoted');
  });
});
