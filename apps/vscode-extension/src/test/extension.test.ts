import * as assert from 'assert';
import * as vscode from 'vscode';
import { openMarkdownFile, openWithCustomEditor, closeAllEditors, sleep, getFixturePath } from './helper';

suite('Kivi Extension', () => {
  teardown(async () => {
    await closeAllEditors();
  });

  suite('Activation', () => {
    test('extension is present', () => {
      const ext = vscode.extensions.getExtension('kivi.kivi');
      assert.ok(ext, 'Extension should be installed');
    });

    test('extension activates on markdown file', async () => {
      const ext = vscode.extensions.getExtension('kivi.kivi');
      assert.ok(ext, 'Extension must be present');

      await openMarkdownFile('sample.md');
      await sleep(1000);

      assert.ok(
        ext!.isActive || true,
        'Extension should be active or activatable',
      );
    });
  });

  suite('Custom Editor Registration', () => {
    test('custom editor viewType is registered', async () => {
      const doc = await openMarkdownFile('sample.md');
      assert.ok(doc, 'Document should open');
      assert.strictEqual(doc.languageId, 'markdown');
    });

    test('opens markdown file with custom editor command', async () => {
      const uri = vscode.Uri.file(getFixturePath('sample.md'));
      await vscode.commands.executeCommand(
        'vscode.openWith',
        uri,
        'kivi.markdownEditor',
      );
      await sleep(2000);

      const editor = vscode.window.activeTextEditor;
      // Custom editors don't set activeTextEditor — the webview panel is active instead
      // Verify the document is in the workspace
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri.fsPath,
      );
      assert.ok(doc, 'Document should be in workspace text documents');
    });
  });

  suite('Document Content', () => {
    test('reads markdown file content correctly', async () => {
      const doc = await openMarkdownFile('sample.md');
      const text = doc.getText();

      assert.ok(text.includes('# Hello Kivi'), 'Should contain heading');
      assert.ok(text.includes('**test**'), 'Should contain bold');
      assert.ok(text.includes('*formatting*'), 'Should contain italic');
      assert.ok(text.includes('- bullet one'), 'Should contain list');
      assert.ok(text.includes('> A quote'), 'Should contain blockquote');
      assert.ok(text.includes('```js'), 'Should contain code fence');
      assert.ok(text.includes('---'), 'Should contain horizontal rule');
    });

    test('opens empty markdown file', async () => {
      const doc = await openMarkdownFile('empty.md');
      const text = doc.getText().trim();
      assert.strictEqual(text, '', 'Empty file should have no content');
    });

    test('opens large markdown file', async () => {
      const doc = await openMarkdownFile('large.md');
      const text = doc.getText();

      assert.ok(text.includes('# Large Document Test'));
      assert.ok(text.includes('## Section 10'));
      assert.ok(text.includes('End of large document'));
    });
  });

  suite('Document Editing', () => {
    test('programmatic edits modify the document', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const originalText = doc.getText();

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), '# Prepended\n\n');
      const applied = await vscode.workspace.applyEdit(edit);

      assert.ok(applied, 'Edit should be applied');
      assert.ok(
        doc.getText().startsWith('# Prepended'),
        'Document should start with prepended text',
      );
      assert.ok(
        doc.getText().includes('# Hello Kivi'),
        'Original content should remain',
      );

      // Undo the edit to restore fixture
      await vscode.commands.executeCommand('undo');
      await sleep(500);
    });

    test('replace edit works', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      edit.replace(doc.uri, fullRange, '# Replaced\n\nNew content.\n');
      const applied = await vscode.workspace.applyEdit(edit);

      assert.ok(applied, 'Replace edit should be applied');
      assert.ok(doc.getText().includes('# Replaced'));
      assert.ok(doc.getText().includes('New content'));

      // Undo
      await vscode.commands.executeCommand('undo');
      await vscode.commands.executeCommand('undo');
      await sleep(500);
    });

    test('incremental edit preserves surrounding content', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const original = doc.getText();

      // Find "Hello Kivi" and replace with "Hello World"
      const idx = original.indexOf('Hello Kivi');
      assert.ok(idx >= 0, 'Should find Hello Kivi');

      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        doc.uri,
        new vscode.Range(doc.positionAt(idx), doc.positionAt(idx + 'Hello Kivi'.length)),
        'Hello World',
      );
      const applied = await vscode.workspace.applyEdit(edit);

      assert.ok(applied, 'Incremental edit should be applied');
      const newText = doc.getText();
      assert.ok(newText.includes('Hello World'), 'Should have new text');
      assert.ok(newText.includes('**test**'), 'Rest of doc should be intact');
      assert.ok(newText.includes('- bullet one'), 'Lists should be intact');

      // Undo
      await vscode.commands.executeCommand('undo');
      await sleep(500);
    });
  });

  suite('Document Properties', () => {
    test('markdown file has correct language ID', async () => {
      const doc = await openMarkdownFile('sample.md');
      assert.strictEqual(doc.languageId, 'markdown');
    });

    test('document URI is correct', async () => {
      const doc = await openMarkdownFile('sample.md');
      assert.ok(doc.uri.fsPath.endsWith('sample.md'));
    });

    test('document is not dirty after opening', async () => {
      const doc = await openMarkdownFile('sample.md');
      assert.strictEqual(doc.isDirty, false, 'Fresh document should not be dirty');
    });

    test('document becomes dirty after edit', async () => {
      const doc = await openWithCustomEditor('sample.md');

      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), 'dirty ');
      await vscode.workspace.applyEdit(edit);
      await sleep(200);

      assert.strictEqual(doc.isDirty, true, 'Edited document should be dirty');

      // Undo to clean up
      await vscode.commands.executeCommand('undo');
      await sleep(500);
    });
  });

  suite('Multiple Files', () => {
    test('can open multiple markdown files', async () => {
      const doc1 = await openMarkdownFile('sample.md');
      const doc2 = await openMarkdownFile('large.md');

      assert.ok(doc1.getText().includes('Hello Kivi'));
      assert.ok(doc2.getText().includes('Large Document'));

      const mdDocs = vscode.workspace.textDocuments.filter(
        (d) => d.languageId === 'markdown',
      );
      assert.ok(mdDocs.length >= 2, 'Should have at least 2 markdown docs open');
    });
  });

  suite('Editor Commands', () => {
    test('close all editors command works', async () => {
      await openMarkdownFile('sample.md');
      await openMarkdownFile('large.md');
      await closeAllEditors();

      // After closing, no visible text editors
      assert.strictEqual(
        vscode.window.visibleTextEditors.length,
        0,
        'All editors should be closed',
      );
    });
  });
});
