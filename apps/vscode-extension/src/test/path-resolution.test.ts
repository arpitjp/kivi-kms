import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { resolveDocRelativeFolder, computeRelativePathFromDoc } from '../utils.js';
import { FIXTURES_DIR } from './helper';

suite('Path Resolution', () => {
  // ── resolveDocRelativeFolder ──────────────────────────────

  suite('resolveDocRelativeFolder', () => {
    test('resolves assets folder next to document', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const result = resolveDocRelativeFolder(docUri, 'assets');
      assert.strictEqual(result.fsPath, path.join('/workspace/docs/notes', 'assets'));
    });

    test('resolves pages folder next to document', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const result = resolveDocRelativeFolder(docUri, 'pages');
      assert.strictEqual(result.fsPath, path.join('/workspace/docs/notes', 'pages'));
    });

    test('resolves folder at workspace root when doc is at root', () => {
      const docUri = vscode.Uri.file('/workspace/index.md');
      const result = resolveDocRelativeFolder(docUri, 'assets');
      assert.strictEqual(result.fsPath, path.join('/workspace', 'assets'));
    });

    test('resolves deeply nested document', () => {
      const docUri = vscode.Uri.file('/workspace/a/b/c/d/doc.md');
      const result = resolveDocRelativeFolder(docUri, 'images');
      assert.strictEqual(result.fsPath, path.join('/workspace/a/b/c/d', 'images'));
    });

    test('handles subfolder with path separators', () => {
      const docUri = vscode.Uri.file('/workspace/docs/readme.md');
      const result = resolveDocRelativeFolder(docUri, 'static/images');
      assert.strictEqual(result.fsPath, path.join('/workspace/docs', 'static', 'images'));
    });
  });

  // ── computeRelativePathFromDoc ────────────────────────────

  suite('computeRelativePathFromDoc', () => {
    test('computes relative path for file in sibling subfolder', () => {
      const docUri = vscode.Uri.file('/workspace/docs/readme.md');
      const targetUri = vscode.Uri.file('/workspace/docs/assets/image.png');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, 'assets/image.png');
    });

    test('computes relative path for file in same directory', () => {
      const docUri = vscode.Uri.file('/workspace/docs/readme.md');
      const targetUri = vscode.Uri.file('/workspace/docs/image.png');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, 'image.png');
    });

    test('computes relative path for file in parent directory', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const targetUri = vscode.Uri.file('/workspace/docs/image.png');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, '../image.png');
    });

    test('computes relative path for deeply nested target', () => {
      const docUri = vscode.Uri.file('/workspace/readme.md');
      const targetUri = vscode.Uri.file('/workspace/assets/images/photo.jpg');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, 'assets/images/photo.jpg');
    });

    test('computes relative path across sibling directories', () => {
      const docUri = vscode.Uri.file('/workspace/src/docs/readme.md');
      const targetUri = vscode.Uri.file('/workspace/public/images/logo.png');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, '../../public/images/logo.png');
    });

    test('document at root, target in subfolder', () => {
      const docUri = vscode.Uri.file('/workspace/index.md');
      const targetUri = vscode.Uri.file('/workspace/assets/img.png');
      const result = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(result, 'assets/img.png');
    });
  });

  // ── Integration: asset storage paths ──────────────────────

  suite('Asset storage produces correct relative path', () => {
    test('image stored in assets folder next to doc yields correct relative path', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const assetsFolder = resolveDocRelativeFolder(docUri, 'assets');
      const imageUri = vscode.Uri.joinPath(assetsFolder, 'screenshot.png');
      const relPath = computeRelativePathFromDoc(docUri, imageUri);
      assert.strictEqual(relPath, 'assets/screenshot.png');
    });

    test('page created in pages folder next to doc yields correct relative path', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const pagesFolder = resolveDocRelativeFolder(docUri, 'pages');
      const pageUri = vscode.Uri.joinPath(pagesFolder, 'new-note.md');
      const relPath = computeRelativePathFromDoc(docUri, pageUri);
      assert.strictEqual(relPath, 'pages/new-note.md');
    });

    test('nested doc: assets path stays local', () => {
      const docUri = vscode.Uri.file('/workspace/blog/2024/january/post.md');
      const assetsFolder = resolveDocRelativeFolder(docUri, 'assets');
      const imageUri = vscode.Uri.joinPath(assetsFolder, 'cover.jpg');
      const relPath = computeRelativePathFromDoc(docUri, imageUri);
      assert.strictEqual(relPath, 'assets/cover.jpg');
    });

    test('root doc: assets path stays local', () => {
      const docUri = vscode.Uri.file('/workspace/README.md');
      const assetsFolder = resolveDocRelativeFolder(docUri, 'assets');
      const imageUri = vscode.Uri.joinPath(assetsFolder, 'diagram.svg');
      const relPath = computeRelativePathFromDoc(docUri, imageUri);
      assert.strictEqual(relPath, 'assets/diagram.svg');
    });
  });

  // ── Webview image resolution ──────────────────────────────

  suite('Webview image URL resolution', () => {
    test('relative image path resolves correctly with docBaseUrl', () => {
      // Simulate what rewriteRelativeImages does
      const src = 'image.png';
      const docBaseUrl = 'vscode-webview://xxx/workspace/docs/notes/';
      const resolved = docBaseUrl + src.replace(/^\.\//, '');
      assert.strictEqual(resolved, 'vscode-webview://xxx/workspace/docs/notes/image.png');
    });

    test('dot-slash relative image path resolves correctly', () => {
      const src = './2022-06-27-09-49-03.png';
      const docBaseUrl = 'vscode-webview://xxx/workspace/docs/';
      const resolved = docBaseUrl + src.replace(/^\.\//, '');
      assert.strictEqual(resolved, 'vscode-webview://xxx/workspace/docs/2022-06-27-09-49-03.png');
    });

    test('subdirectory image path resolves correctly', () => {
      const src = 'assets/photo.jpg';
      const docBaseUrl = 'vscode-webview://xxx/workspace/docs/notes/';
      const resolved = docBaseUrl + src.replace(/^\.\//, '');
      assert.strictEqual(resolved, 'vscode-webview://xxx/workspace/docs/notes/assets/photo.jpg');
    });

    test('stored image relative path works end-to-end with webview', () => {
      const docUri = vscode.Uri.file('/workspace/docs/notes/readme.md');
      const assetsFolder = resolveDocRelativeFolder(docUri, 'assets');
      const imageUri = vscode.Uri.joinPath(assetsFolder, 'pasted-123.png');
      const relPath = computeRelativePathFromDoc(docUri, imageUri);

      // Simulate webview rewrite
      const docBaseUrl = 'vscode-webview://xxx/workspace/docs/notes/';
      const resolved = docBaseUrl + relPath.replace(/^\.\//, '');
      assert.strictEqual(resolved, 'vscode-webview://xxx/workspace/docs/notes/assets/pasted-123.png');
    });
  });

  // ── Real filesystem integration ───────────────────────────

  suite('Real filesystem paths', () => {
    test('resolves with actual test fixture directory', () => {
      const samplePath = path.join(FIXTURES_DIR, 'sample.md');
      const docUri = vscode.Uri.file(samplePath);
      const assetsFolder = resolveDocRelativeFolder(docUri, 'assets');
      assert.strictEqual(assetsFolder.fsPath, path.join(FIXTURES_DIR, 'assets'));
    });

    test('compute relative path with actual fixture paths', () => {
      const samplePath = path.join(FIXTURES_DIR, 'sample.md');
      const docUri = vscode.Uri.file(samplePath);
      const targetUri = vscode.Uri.file(path.join(FIXTURES_DIR, 'assets', 'image.png'));
      const relPath = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(relPath, 'assets/image.png');
    });

    test('fixture in subdirectory produces correct relative path', () => {
      const docUri = vscode.Uri.file(path.join(FIXTURES_DIR, 'subdir', 'nested.md'));
      const targetUri = vscode.Uri.file(path.join(FIXTURES_DIR, 'subdir', 'assets', 'img.png'));
      const relPath = computeRelativePathFromDoc(docUri, targetUri);
      assert.strictEqual(relPath, 'assets/img.png');
    });
  });
});
