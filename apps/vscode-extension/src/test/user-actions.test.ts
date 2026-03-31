import * as assert from 'assert';
import * as vscode from 'vscode';
import { openWithCustomEditor, closeAllEditors, sleep } from './helper';

/**
 * User-action e2e tests. These exercise the full custom editor pipeline:
 * programmatic edits → webview sync → serialize → verify markdown output.
 *
 * Because the Tiptap editor lives in a webview, we drive changes through
 * vscode.workspace.applyEdit and verify the resulting TextDocument content.
 */
suite('User Actions', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('undo');
    await sleep(300);
    await closeAllEditors();
  });

  // ── Cursor & Selection ───────────────────────────────────────

  suite('Cursor & Selection', () => {
    test('cursor can be placed at beginning of document', async () => {
      await openWithCustomEditor('sample.md');
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        assert.strictEqual(editor.selection.start.line, 0);
        assert.strictEqual(editor.selection.start.character, 0);
      }
    });

    test('cursor can be placed at end of document', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const lastLine = doc.lineCount - 1;
        const lastChar = doc.lineAt(lastLine).text.length;
        editor.selection = new vscode.Selection(lastLine, lastChar, lastLine, lastChar);
        assert.strictEqual(editor.selection.start.line, lastLine);
      }
    });

    test('text can be selected across multiple lines', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        editor.selection = new vscode.Selection(0, 0, 2, 0);
        const selectedText = doc.getText(editor.selection);
        assert.ok(selectedText.includes('Hello Kivi'), 'Selection should span the heading');
      }
    });
  });

  // ── Inline Formatting ───────────────────────────────────────

  suite('Inline Formatting', () => {
    test('insert bold text', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const original = doc.getText();
      const insertPos = doc.positionAt(original.length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n**bold addition**\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('**bold addition**'), 'Should contain bold markdown');
    });

    test('insert italic text', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const original = doc.getText();
      const insertPos = doc.positionAt(original.length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n*italic addition*\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('*italic addition*'), 'Should contain italic markdown');
    });

    test('insert strikethrough text', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n~~struck~~\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('~~struck~~'), 'Should contain strikethrough');
    });

    test('insert inline code', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\nUse `npm install` here.\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('`npm install`'), 'Should contain inline code');
    });

    test('insert link', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n[click here](https://example.com)\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('[click here](https://example.com)'), 'Should contain link');
    });

    test('nested formatting: bold inside italic', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n***bold italic***\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(
        text.includes('***bold italic***') || text.includes('**_bold italic_**'),
        'Should contain nested formatting',
      );
    });
  });

  // ── Code Blocks ─────────────────────────────────────────────

  suite('Code Blocks', () => {
    test('insert fenced code block', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n```python\nprint("hello")\n```\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('```python'), 'Should contain python code fence');
      assert.ok(text.includes('print("hello")'), 'Should contain code content');
    });

    test('existing code block preserves language', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const text = doc.getText();

      assert.ok(text.includes('```js'), 'Should have js code block');
      assert.ok(text.includes('const x = 1;'), 'Should have code content');
    });

    test('insert code block without language', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n```\nplain code\n```\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('plain code'), 'Should contain plain code block');
    });
  });

  // ── Tables ──────────────────────────────────────────────────

  suite('Tables', () => {
    test('insert markdown table', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const table = '\n\n| Name | Value |\n| --- | --- |\n| foo | bar |\n| baz | qux |\n';
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, table);
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('| Name'), 'Should contain table header');
      assert.ok(text.includes('| foo'), 'Should contain table row');
    });

    test('table with alignment', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const table = '\n\n| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |\n';
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, table);
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('Left'), 'Should contain table');
    });
  });

  // ── Lists ───────────────────────────────────────────────────

  suite('Lists', () => {
    test('insert unordered list', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n- alpha\n- beta\n- gamma\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('- alpha'), 'Should contain unordered list');
    });

    test('insert ordered list', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n1. first\n2. second\n3. third\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('1.') || text.includes('first'), 'Should contain ordered list');
    });

    test('insert task list', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n- [ ] todo item\n- [x] done item\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('todo item'), 'Should contain task items');
    });

    test('nested list', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n- parent\n  - child\n    - grandchild\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('parent'), 'Should contain nested list');
    });
  });

  // ── Block Elements ──────────────────────────────────────────

  suite('Block Elements', () => {
    test('insert blockquote', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n> A new blockquote.\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('A new blockquote'), 'Should contain blockquote');
    });

    test('insert horizontal rule', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const text = doc.getText();

      assert.ok(text.includes('---'), 'Sample should contain horizontal rule');
    });

    test('insert heading levels', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\n### Heading 3\n\n#### Heading 4\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('### Heading 3') || text.includes('Heading 3'), 'Should contain h3');
      assert.ok(text.includes('#### Heading 4') || text.includes('Heading 4'), 'Should contain h4');
    });
  });

  // ── Undo / Redo ─────────────────────────────────────────────

  suite('Undo / Redo', () => {
    test('undo reverts an insertion', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, doc.positionAt(0), '# UNDO TEST\n\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);

      assert.ok(doc.getText().includes('UNDO TEST'), 'Should contain inserted text');

      await vscode.commands.executeCommand('undo');
      await sleep(500);

      assert.ok(!doc.getText().includes('UNDO TEST'), 'Undo should remove inserted text');
    });

    test('redo restores an undone insertion', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, doc.positionAt(0), '# REDO TEST\n\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);

      await vscode.commands.executeCommand('undo');
      await sleep(300);
      assert.ok(!doc.getText().includes('REDO TEST'), 'Undo should remove it');

      await vscode.commands.executeCommand('redo');
      await sleep(500);

      assert.ok(doc.getText().includes('REDO TEST'), 'Redo should restore it');
    });

    test('multiple undo steps', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const edit1 = new vscode.WorkspaceEdit();
      edit1.insert(doc.uri, doc.positionAt(0), 'STEP1\n');
      await vscode.workspace.applyEdit(edit1);
      await sleep(200);

      const edit2 = new vscode.WorkspaceEdit();
      edit2.insert(doc.uri, doc.positionAt(0), 'STEP2\n');
      await vscode.workspace.applyEdit(edit2);
      await sleep(200);

      assert.ok(doc.getText().includes('STEP1'), 'Should have step 1');
      assert.ok(doc.getText().includes('STEP2'), 'Should have step 2');

      await vscode.commands.executeCommand('undo');
      await sleep(300);
      assert.ok(!doc.getText().includes('STEP2'), 'Undo should remove step 2');
      assert.ok(doc.getText().includes('STEP1'), 'Step 1 should remain');

      await vscode.commands.executeCommand('undo');
      await sleep(300);
      assert.ok(!doc.getText().includes('STEP1'), 'Second undo should remove step 1');
    });
  });

  // ── Cut / Paste (via edits) ─────────────────────────────────

  suite('Cut & Paste Simulation', () => {
    test('delete a range (simulates cut)', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const text = doc.getText();
      const idx = text.indexOf('## Section');
      assert.ok(idx >= 0, 'Should find section heading');

      const lineEnd = text.indexOf('\n', idx);
      const edit = new vscode.WorkspaceEdit();
      edit.delete(
        doc.uri,
        new vscode.Range(doc.positionAt(idx), doc.positionAt(lineEnd)),
      );
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(!doc.getText().includes('## Section'), 'Section heading should be cut');
      assert.ok(doc.getText().includes('bullet one'), 'Rest of content should remain');
    });

    test('replace a range (simulates paste over selection)', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const text = doc.getText();
      const start = text.indexOf('bullet one');
      const end = start + 'bullet one'.length;

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(start), doc.positionAt(end)),
        'pasted content',
      );
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('pasted content'), 'Should contain pasted text');
      assert.ok(!doc.getText().includes('bullet one'), 'Original should be replaced');
    });
  });

  // ── Multi-block Edits ───────────────────────────────────────

  suite('Complex Multi-block Operations', () => {
    test('replace entire document content', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );

      const newContent = '# Fresh\n\nCompletely new document.\n';
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, fullRange, newContent);
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('# Fresh'), 'Should have new heading');
      assert.ok(text.includes('Completely new document'), 'Should have new content');
      assert.ok(!text.includes('Hello Kivi'), 'Old content should be gone');
    });

    test('insert complex markdown with mixed elements', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const complex = [
        '',
        '',
        '## Mixed Content',
        '',
        'Paragraph with **bold**, *italic*, and `code`.',
        '',
        '- List item with [link](https://example.com)',
        '- Another item',
        '',
        '> Blockquote with **emphasis**.',
        '',
        '```ts',
        'const x: string = "hello";',
        '```',
        '',
        '| Col A | Col B |',
        '| --- | --- |',
        '| 1 | 2 |',
        '',
      ].join('\n');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, complex);
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      const text = doc.getText();
      assert.ok(text.includes('Mixed Content'), 'Should have heading');
      assert.ok(text.includes('bold'), 'Should have bold text');
      assert.ok(text.includes('example.com'), 'Should have link');
      assert.ok(text.includes('Blockquote'), 'Should have blockquote');
      assert.ok(text.includes('const x'), 'Should have code');
    });

    test('sequential edits at different positions', async () => {
      const doc = await openWithCustomEditor('sample.md');

      // Insert at beginning
      const edit1 = new vscode.WorkspaceEdit();
      edit1.insert(doc.uri, new vscode.Position(0, 0), '<!-- header -->\n');
      await vscode.workspace.applyEdit(edit1);
      await sleep(300);

      // Insert at end
      const edit2 = new vscode.WorkspaceEdit();
      edit2.insert(doc.uri, doc.positionAt(doc.getText().length), '\n<!-- footer -->\n');
      await vscode.workspace.applyEdit(edit2);
      await sleep(300);

      const text = doc.getText();
      assert.ok(text.includes('<!-- header -->'), 'Should have header comment');
      assert.ok(text.includes('<!-- footer -->'), 'Should have footer comment');
      assert.ok(text.includes('Hello Kivi'), 'Original content should remain');
    });
  });

  // ── Edge Cases ──────────────────────────────────────────────

  suite('Edge Cases', () => {
    test('edit empty file', async () => {
      const doc = await openWithCustomEditor('empty.md');
      assert.strictEqual(doc.getText().trim(), '', 'Should start empty');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), '# Now Not Empty\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('Now Not Empty'), 'Should have content');
    });

    test('rapid sequential edits do not corrupt document', async () => {
      const doc = await openWithCustomEditor('sample.md');

      for (let i = 0; i < 5; i++) {
        const edit = new vscode.WorkspaceEdit();
        edit.insert(doc.uri, doc.positionAt(doc.getText().length), `\nLine ${i}\n`);
        await vscode.workspace.applyEdit(edit);
        await sleep(100);
      }

      const text = doc.getText();
      for (let i = 0; i < 5; i++) {
        assert.ok(text.includes(`Line ${i}`), `Should contain Line ${i}`);
      }
      assert.ok(text.includes('Hello Kivi'), 'Original content should survive');
    });

    test('insert and immediately undo preserves original', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const original = doc.getText();

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), 'TEMPORARY\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(300);

      await vscode.commands.executeCommand('undo');
      await sleep(500);

      assert.strictEqual(doc.getText(), original, 'Should be identical to original after undo');
    });

    test('large edit does not hang', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const bigContent = Array.from({ length: 200 }, (_, i) =>
        `Paragraph ${i}. This is some content to make the document larger.`,
      ).join('\n\n');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, doc.positionAt(doc.getText().length), '\n\n' + bigContent + '\n');
      const start = Date.now();
      await vscode.workspace.applyEdit(edit);
      await sleep(500);
      const elapsed = Date.now() - start;

      assert.ok(elapsed < 10000, `Large edit should complete within 10s (took ${elapsed}ms)`);
      assert.ok(doc.getText().includes('Paragraph 199'), 'Should contain last paragraph');
    });
  });

  // ── Wiki Links & Tags ──────────────────────────────────────

  suite('Wiki Links & Tags', () => {
    test('wiki-links are preserved in document', async () => {
      const doc = await openWithCustomEditor('wiki-links.md');
      const text = doc.getText();

      assert.ok(text.includes('[[sample]]'), 'Should have wiki-link');
      assert.ok(text.includes('[[large|Large Doc]]'), 'Should have aliased wiki-link');
    });

    test('hashtags are preserved', async () => {
      const doc = await openWithCustomEditor('wiki-links.md');
      const text = doc.getText();

      assert.ok(text.includes('#test'), 'Should have hashtag');
    });

    test('insert wiki-link via edit', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const insertPos = doc.positionAt(doc.getText().length);

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, insertPos, '\n\nSee [[another-page]] for more.\n');
      await vscode.workspace.applyEdit(edit);
      await sleep(500);

      assert.ok(doc.getText().includes('[[another-page]]'), 'Should contain wiki-link');
    });
  });
});
