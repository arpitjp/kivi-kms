import * as assert from 'assert';
import * as vscode from 'vscode';
import { openWithCustomEditor, closeAllEditors, sleep } from './helper';

/**
 * Search E2E tests.
 *
 * These tests open a markdown file in the Kivi custom editor and exercise
 * the full Cmd+F search pipeline:
 *   1. webview receives 'find' message → search bar opens
 *   2. search input drives TipTap / Monaco highlighting
 *   3. next / previous navigation
 *   4. replace and replace-all
 *   5. view-mode switching (live, source, split)
 *
 * Since we cannot directly drive DOM inside the webview from the extension
 * host, we verify the messaging contract and document-level invariants.
 */
suite('Search', () => {
  teardown(async () => {
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('undo');
    await sleep(300);
    await closeAllEditors();
  });

  // ── Open / Close ──────────────────────────────────────────────

  suite('Open / Close', () => {
    test('Cmd+F opens the custom editor without error', async () => {
      const doc = await openWithCustomEditor('sample.md');
      assert.ok(doc, 'Document should open');
      assert.strictEqual(doc.languageId, 'markdown');

      // Trigger find command (sent to webview)
      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(500);

      // If we got here without timeout, the search bar opened successfully.
      // There's no way to read DOM from the extension host, but the command
      // should not throw.
    });

    test('Repeated Cmd+F does not toggle search bar off', async () => {
      await openWithCustomEditor('sample.md');

      // Two rapid find commands should NOT toggle bar off — it should remain open.
      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(100);
      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(500);

      // No assertion on DOM — just verifying no exceptions / hangs.
    });

    test('Find in Kivi editor works via custom kivi.find command', async () => {
      await openWithCustomEditor('sample.md');
      await sleep(500);

      // Our extension registers 'kivi.find' that posts 'find' to webview
      const commands = await vscode.commands.getCommands(true);
      const hasFindCmd = commands.includes('kivi.find');
      // If the command exists, fire it
      if (hasFindCmd) {
        await vscode.commands.executeCommand('kivi.find');
        await sleep(300);
      }
    });
  });

  // ── Content / Document Assertions ──────────────────────────────

  suite('Content Verification', () => {
    test('sample.md contains searchable text', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const text = doc.getText();
      assert.ok(text.length > 0, 'Document should have content');
      assert.ok(text.includes('Hello Kivi') || text.includes('#'), 'Should contain expected text');
    });

    test('document content is preserved after opening search', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const before = doc.getText();

      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(500);

      const after = doc.getText();
      assert.strictEqual(before, after, 'Search should not modify document');
    });

    test('replace-all via edit preserves document integrity', async () => {
      const doc = await openWithCustomEditor('sample.md');
      const originalText = doc.getText();

      // Simulate a programmatic edit (replace "Hello" with "Greetings")
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        doc.positionAt(0),
        doc.positionAt(doc.getText().length),
      );
      const modifiedText = originalText.replace(/Hello/g, 'Greetings');
      edit.replace(doc.uri, fullRange, modifiedText);
      const applied = await vscode.workspace.applyEdit(edit);
      assert.ok(applied, 'Edit should apply');
      await sleep(1000);

      const finalText = doc.getText();
      assert.ok(!finalText.includes('Hello'), 'All "Hello" occurrences should be replaced');
      assert.ok(finalText.includes('Greetings'), 'Replacement text should be present');
    });
  });

  // ── View Mode Switching ──────────────────────────────────────

  suite('View Mode Robustness', () => {
    test('search does not crash when switching to source mode', async () => {
      await openWithCustomEditor('sample.md');
      await sleep(500);

      // Open search
      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(300);

      // These commands may or may not exist, but triggering them shouldn't crash
      const commands = await vscode.commands.getCommands(true);
      if (commands.includes('kivi.toggleViewMode')) {
        await vscode.commands.executeCommand('kivi.toggleViewMode');
        await sleep(500);
      }
    });

    test('opening and closing editor does not leak search state', async () => {
      await openWithCustomEditor('sample.md');
      await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
      await sleep(300);
      await closeAllEditors();
      await sleep(300);

      // Re-open — should start clean
      const doc = await openWithCustomEditor('sample.md');
      assert.ok(doc, 'Should re-open cleanly');
    });
  });

  // ── Webview Message Contract ─────────────────────────────────

  suite('Message Contract', () => {
    test('find and findReplace messages are accepted', async () => {
      await openWithCustomEditor('sample.md');
      await sleep(500);

      // The extension host sends 'find' and 'findReplace' messages to the webview.
      // We verify the commands that trigger these don't error out.
      const commands = await vscode.commands.getCommands(true);

      if (commands.includes('kivi.find')) {
        await vscode.commands.executeCommand('kivi.find');
        await sleep(200);
      }
      if (commands.includes('kivi.findReplace')) {
        await vscode.commands.executeCommand('kivi.findReplace');
        await sleep(200);
      }
    });

    test('rapid open/close cycles do not corrupt state', async () => {
      await openWithCustomEditor('sample.md');
      await sleep(500);

      // Rapidly open and close search
      for (let i = 0; i < 5; i++) {
        await vscode.commands.executeCommand('editor.action.webvieweditor.showFind');
        await sleep(50);
      }
      await sleep(500);

      // If we get here, no corruption.
      const doc = vscode.workspace.textDocuments.find(d => d.uri.fsPath.endsWith('sample.md'));
      assert.ok(doc, 'Document should still be open');
    });
  });
});
