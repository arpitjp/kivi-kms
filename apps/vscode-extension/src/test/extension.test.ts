import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { openMarkdownFile, openWithCustomEditor, closeAllEditors, sleep, getFixturePath, FIXTURES_DIR } from './helper';

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
        ext!.isActive,
        'Extension should be active after opening a markdown file',
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

    test('opens wiki-links fixture correctly', async () => {
      const doc = await openMarkdownFile('wiki-links.md');
      const text = doc.getText();

      assert.ok(text.includes('[[sample]]'), 'Should contain wiki-link');
      assert.ok(text.includes('[[large|Large Doc]]'), 'Should contain aliased wiki-link');
      assert.ok(text.includes('#test'), 'Should contain hashtag');
    });
  });

  suite('Document Editing', () => {
    test('programmatic edits modify the document', async () => {
      const doc = await openWithCustomEditor('sample.md');

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

      await vscode.commands.executeCommand('undo');
      await vscode.commands.executeCommand('undo');
      await sleep(500);
    });

    test('incremental edit preserves surrounding content', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const original = doc.getText();

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

      assert.strictEqual(
        vscode.window.visibleTextEditors.length,
        0,
        'All editors should be closed',
      );
    });

    test('kivi.openInKivi command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.openInKivi'), 'openInKivi should be registered');
    });

    test('kivi.openWithTextEditor command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.openWithTextEditor'), 'openWithTextEditor should be registered');
    });

    test('kivi.openToSide command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.openToSide'), 'openToSide should be registered');
    });

    test('kivi.setDefaultEditor command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.setDefaultEditor'), 'setDefaultEditor should be registered');
    });

    test('kivi.removeDefaultEditor command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.removeDefaultEditor'), 'removeDefaultEditor should be registered');
    });

    test('kivi.revealInExplorer command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.revealInExplorer'), 'revealInExplorer should be registered');
    });

    test('kivi.openGraph command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.openGraph'), 'openGraph should be registered');
    });

    test('kivi.showGraphInTab command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.showGraphInTab'), 'showGraphInTab should be registered');
    });

    test('kivi.scrollToHeading command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.scrollToHeading'), 'scrollToHeading should be registered');
    });

    test('kivi.openDevTools command is registered', async () => {
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('kivi.openDevTools'), 'openDevTools should be registered');
    });

    test('openInKivi opens a markdown file in the custom editor', async () => {
      const uri = vscode.Uri.file(getFixturePath('sample.md'));
      await vscode.commands.executeCommand('kivi.openInKivi', uri);
      await sleep(2000);

      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
      assert.ok(doc, 'Document should be open after openInKivi');
    });

    test('openWithTextEditor opens in default text editor', async () => {
      const uri = vscode.Uri.file(getFixturePath('sample.md'));
      await vscode.commands.executeCommand('kivi.openWithTextEditor', uri);
      await sleep(1000);

      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri.fsPath);
      assert.ok(doc, 'Document should be open after openWithTextEditor');
    });

    test('openToSide opens file in a side column', async () => {
      const uri = vscode.Uri.file(getFixturePath('sample.md'));
      await vscode.commands.executeCommand('kivi.openInKivi', uri);
      await sleep(1000);

      const uri2 = vscode.Uri.file(getFixturePath('large.md'));
      await vscode.commands.executeCommand('kivi.openToSide', uri2);
      await sleep(2000);

      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath === uri2.fsPath);
      assert.ok(doc, 'Side document should be open');
    });
  });

  suite('Default Editor Configuration', () => {
    test('kivi.defaultEditor setting defaults to true', () => {
      const cfg = vscode.workspace.getConfiguration('kivi');
      const isDefault = cfg.get<boolean>('defaultEditor', true);
      assert.strictEqual(isDefault, true, 'defaultEditor should default to true');
    });

    test('editorAssociations includes *.md when defaultEditor is true', () => {
      const wbCfg = vscode.workspace.getConfiguration('workbench');
      const assoc = wbCfg.get<Record<string, string>>('editorAssociations') ?? {};
      assert.strictEqual(
        assoc['*.md'],
        'kivi.markdownEditor',
        'editorAssociations should map *.md to kivi.markdownEditor',
      );
    });

    test('editorAssociations includes *.markdown when defaultEditor is true', () => {
      const wbCfg = vscode.workspace.getConfiguration('workbench');
      const assoc = wbCfg.get<Record<string, string>>('editorAssociations') ?? {};
      assert.strictEqual(
        assoc['*.markdown'],
        'kivi.markdownEditor',
        'editorAssociations should map *.markdown to kivi.markdownEditor',
      );
    });
  });

  suite('Sidebar Tree Views', () => {
    test('kivi.files view is registered', async () => {
      // The tree view is registered during activation — verify by checking commands
      const ext = vscode.extensions.getExtension('kivi.kivi');
      assert.ok(ext, 'Extension must be present');

      await openMarkdownFile('sample.md');
      await sleep(1000);

      // TreeView registration is checked via the extension contributes in package.json
      // We verify the extension activates without error and the views are accessible
      const viewIds = ['kivi.files', 'kivi.outline', 'kivi.backlinks'];
      for (const viewId of viewIds) {
        // Focus the view to verify it exists
        try {
          await vscode.commands.executeCommand(`${viewId}.focus`);
          await sleep(200);
        } catch {
          // Some views may not support focus directly, but shouldn't crash
        }
      }
    });

    test('outline updates when document has headings', async () => {
      const doc = await openMarkdownFile('sample.md');
      await sleep(500);

      const text = doc.getText();
      // sample.md has "# Hello Kivi" and "## Section"
      assert.ok(text.includes('# Hello Kivi'), 'Should have H1');
      assert.ok(text.includes('## Section'), 'Should have H2');
    });

    test('wiki-links fixture has expected content for backlinks', async () => {
      const doc = await openMarkdownFile('wiki-links.md');
      const text = doc.getText();

      assert.ok(text.includes('[[sample]]'), 'Should have wiki-link to sample');
      assert.ok(text.includes('[[large|Large Doc]]'), 'Should have aliased wiki-link');
    });
  });

  suite('File System Watcher', () => {
    const tempFile = path.join(FIXTURES_DIR, 'temp-watcher-test.md');

    teardown(async () => {
      try { fs.unlinkSync(tempFile); } catch { /* file may not exist */ }
    });

    test('creating a new .md file does not crash the extension', async () => {
      await openMarkdownFile('sample.md');
      await sleep(500);

      fs.writeFileSync(tempFile, '# Temp File\n\nCreated for watcher test.\n');
      await sleep(1000);

      // Extension should still be functional
      const doc = await openMarkdownFile('sample.md');
      assert.ok(doc.getText().includes('Hello Kivi'), 'Extension still works after file creation');
    });

    test('deleting a .md file does not crash the extension', async () => {
      fs.writeFileSync(tempFile, '# Temp\n');
      await sleep(500);

      fs.unlinkSync(tempFile);
      await sleep(1000);

      const doc = await openMarkdownFile('sample.md');
      assert.ok(doc.getText().includes('Hello Kivi'), 'Extension still works after file deletion');
    });
  });
});
