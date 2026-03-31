import { describe, it, expect } from 'vitest';
import { createKiviEditor } from '../../src/index.js';
import { parseMarkdown } from '@kivi/markdown-parser';
import { Fragment, Slice, Node as PMNode } from '@tiptap/pm/model';

const STRESS_MD = `# Editor Stress Test Document

> This file is intentionally dense and varied for testing.

---

# Table of Contents

* [[Project Overview]]
* [[Daily Notes]]
* [[Meeting Notes]]

---

# Project Overview

Tags: #project #frontend #backend #golang #react

## Summary

This is a fake project called **Kivi**.

* [[Obsidian]]
* [[Logseq]]
* [[Roam Research]]

### Goals

1. Fast startup time
2. Smooth graph rendering
3. Rich markdown support

### Features

* Wikilinks: \`[[Page Name]]\`
* Tags: #tag-example
* Inline code: \`const x = 1\`
* Math: $E = mc^2$

---

## Code Blocks

\`\`\`ts
interface Note {
  id: string;
  title: string;
  content: string;
}

function getBacklinks(noteId: string): string[] {
  return [];
}
\`\`\`

\`\`\`go
package main

import "fmt"

func main() {
    fmt.Println("Hello, markdown world")
}
\`\`\`

---

## Formatting

**Bold text**

*Italic text*

~~Strikethrough~~

### Nested Lists

* Item 1
  * Item 1.1
    * Item 1.1.1
* Item 2
  1. Ordered Item A
  2. Ordered Item B

### Blockquotes

> Level 1 Quote
>
> > Level 2 Quote

---

## Table

| Risk              | Severity | Owner   |
| ----------------- | -------- | ------- |
| Slow graph render | High     | Alice   |
| Broken backlinks  | Medium   | Bob     |

---

## Tasks

* [ ] Fix graph zoom jitter
* [x] Add markdown table support
* [ ] Add nested backlinks panel
* [x] Add dark mode

---

## Links

* [OpenAI](https://openai.com)
* [MDN Web Docs](https://developer.mozilla.org)

---

# Final Section

Lorem ipsum dolor sit amet.

#end #stress-test #markdown
`;

describe('paste stress test', () => {
  it('parseMarkdown produces valid nodes for stress test content', () => {
    const result = parseMarkdown(STRESS_MD);
    expect(result.doc.content.length).toBeGreaterThan(10);

    const types = result.doc.content.map((n: { type: string }) => n.type);
    expect(types).toContain('heading');
    expect(types).toContain('bulletList');
    expect(types).toContain('horizontalRule');
    expect(types).toContain('codeBlock');
    expect(types).toContain('table');
    expect(types).toContain('taskList');
    expect(types).toContain('blockquote');
    expect(types).toContain('orderedList');
  });

  it('all parsed nodes convert to ProseMirror nodes via schema', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const editor = createKiviEditor({ element: el, editorClass: 'test' });
    const tiptap = editor.getTiptapEditor();
    const schema = tiptap.state.schema;

    const result = parseMarkdown(STRESS_MD);
    const docJson = result.doc as { content: unknown[] };

    const failedTypes: string[] = [];
    const nodes: PMNode[] = [];

    for (const nodeJson of docJson.content) {
      try {
        nodes.push(PMNode.fromJSON(schema, nodeJson));
      } catch {
        failedTypes.push((nodeJson as { type: string }).type);
      }
    }

    expect(failedTypes).toEqual([]);
    expect(nodes.length).toBe(docJson.content.length);

    tiptap.destroy();
    el.remove();
  });

  it('pasting stress test content via replaceSelection works', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);

    const editor = createKiviEditor({ element: el, editorClass: 'test' });
    const tiptap = editor.getTiptapEditor();
    const schema = tiptap.state.schema;

    const result = parseMarkdown(STRESS_MD);
    const docJson = result.doc as { content: unknown[] };

    const nodes: PMNode[] = [];
    for (const nodeJson of docJson.content) {
      try {
        nodes.push(PMNode.fromJSON(schema, nodeJson));
      } catch {
        // skip
      }
    }

    const fragment = Fragment.from(nodes);
    const slice = new Slice(fragment, 0, 0);
    const tr = tiptap.state.tr.replaceSelection(slice);
    tiptap.view.dispatch(tr);

    // Verify the document has the expected content
    const doc = tiptap.state.doc;
    expect(doc.childCount).toBeGreaterThan(10);

    // Check no escaped markdown in text content
    const text = doc.textContent;
    expect(text).not.toContain('\\#');
    expect(text).not.toContain('\\*');
    expect(text).not.toContain('\\[');
    expect(text).not.toContain('\\---');

    // Verify key content is present
    expect(text).toContain('Editor Stress Test Document');
    expect(text).toContain('Kivi');
    expect(text).toContain('Fast startup time');
    expect(text).toContain('Bold text');

    // Verify we can serialize back to markdown
    const md = editor.getMarkdown();
    expect(md).toContain('# Editor Stress Test Document');
    expect(md).toContain('**Kivi**');
    expect(md).toContain('```ts');
    expect(md).toContain('```go');

    tiptap.destroy();
    el.remove();
  });
});
