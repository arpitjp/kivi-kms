import * as assert from 'assert';
import * as path from 'path';
import * as fs from 'fs';
import { Vault } from '@kivi/vault';

const FIXTURES = path.resolve(__dirname, '..', '..', '..', 'test-fixtures');
function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

/**
 * Graph e2e tests. These exercise the full Vault indexing → graph generation
 * pipeline with realistic markdown files from test-fixtures.
 */
suite('Graph — Vault Integration', () => {
  let vault: Vault;

  setup(() => {
    vault = new Vault();
    vault.addFile('graph-hub.md', readFixture('graph-hub.md'));
    vault.addFile('graph-child-a.md', readFixture('graph-child-a.md'));
    vault.addFile('graph-child-b.md', readFixture('graph-child-b.md'));
    vault.addFile('graph-leaf.md', readFixture('graph-leaf.md'));
    vault.addFile('graph-orphan.md', readFixture('graph-orphan.md'));
    vault.addFile('sample.md', readFixture('sample.md'));
    vault.addFile('wiki-links.md', readFixture('wiki-links.md'));
    vault.addFile('large.md', readFixture('large.md'));
  });

  teardown(() => {
    vault.destroy();
  });

  // ── Node generation ──────────────────────────────────────────

  suite('Node Generation', () => {
    test('creates a node for every file in the vault', () => {
      const { nodes } = vault.getGraph();
      const noteNodes = nodes.filter(n => n.nodeType === 'note');
      assert.strictEqual(noteNodes.length, 8);
      const ids = noteNodes.map(n => n.id);
      assert.ok(ids.includes('graph-hub.md'));
      assert.ok(ids.includes('graph-child-a.md'));
      assert.ok(ids.includes('graph-child-b.md'));
      assert.ok(ids.includes('graph-leaf.md'));
      assert.ok(ids.includes('graph-orphan.md'));
    });

    test('node labels match file titles from frontmatter or headings', () => {
      const { nodes } = vault.getGraph();
      const byId = new Map(nodes.map(n => [n.id, n]));
      assert.strictEqual(byId.get('graph-hub.md')!.label, 'Graph Hub');
      assert.strictEqual(byId.get('graph-child-a.md')!.label, 'Child A');
      assert.strictEqual(byId.get('graph-child-b.md')!.label, 'Child B');
      assert.strictEqual(byId.get('graph-leaf.md')!.label, 'Leaf Page');
    });

    test('node tags are extracted correctly from frontmatter and body', () => {
      const { nodes } = vault.getGraph();
      const hub = nodes.find(n => n.id === 'graph-hub.md')!;
      assert.ok(hub.tags.includes('architecture'));
      assert.ok(hub.tags.includes('performance'));
    });

    test('node outgoingCount reflects the number of wiki-links', () => {
      const { nodes } = vault.getGraph();
      const hub = nodes.find(n => n.id === 'graph-hub.md')!;
      assert.ok(hub.outgoingCount >= 3, `Expected >=3 outgoing, got ${hub.outgoingCount}`);
    });

    test('node backlinkCount is computed from inbound links', () => {
      const { nodes } = vault.getGraph();
      const hub = nodes.find(n => n.id === 'graph-hub.md')!;
      assert.ok(hub.backlinkCount >= 2, `Hub should have >=2 backlinks, got ${hub.backlinkCount}`);
    });

    test('orphan node has isOrphan=true', () => {
      const { nodes } = vault.getGraph();
      const orphan = nodes.find(n => n.id === 'graph-orphan.md')!;
      assert.strictEqual(orphan.isOrphan, true);
    });

    test('connected nodes have isOrphan=false', () => {
      const { nodes } = vault.getGraph();
      const hub = nodes.find(n => n.id === 'graph-hub.md')!;
      assert.strictEqual(hub.isOrphan, false);
    });

    test('node childCount reflects hierarchy children', () => {
      const { nodes } = vault.getGraph();
      const hub = nodes.find(n => n.id === 'graph-hub.md')!;
      assert.strictEqual(hub.childCount, 2);
    });

    test('child nodes have parent field set', () => {
      const { nodes } = vault.getGraph();
      const childA = nodes.find(n => n.id === 'graph-child-a.md')!;
      assert.ok(childA.parent, 'Child A should have a parent');
    });
  });

  // ── Link edges ───────────────────────────────────────────────

  suite('Link Edges', () => {
    test('wiki-links produce "link" type edges', () => {
      const { edges } = vault.getGraph();
      const linkEdges = edges.filter(e => e.type === 'link');
      assert.ok(linkEdges.length > 0, 'Should have link edges');
      const hubToChildA = linkEdges.find(
        e => e.source === 'graph-hub.md' && e.target === 'graph-child-a.md',
      );
      assert.ok(hubToChildA, 'Hub should link to Child A');
    });

    test('hub links to child-a, child-b, and leaf', () => {
      const { edges } = vault.getGraph();
      const hubLinks = edges.filter(e => e.type === 'link' && e.source === 'graph-hub.md');
      const targets = hubLinks.map(e => e.target);
      assert.ok(targets.includes('graph-child-a.md'));
      assert.ok(targets.includes('graph-child-b.md'));
      assert.ok(targets.includes('graph-leaf.md'));
    });

    test('child-a links back to hub', () => {
      const { edges } = vault.getGraph();
      const childALinks = edges.filter(e => e.type === 'link' && e.source === 'graph-child-a.md');
      const targets = childALinks.map(e => e.target);
      assert.ok(targets.includes('graph-hub.md'));
    });

    test('cross-sibling links exist (child-a to child-b)', () => {
      const { edges } = vault.getGraph();
      const aToB = edges.find(
        e => e.type === 'link' && e.source === 'graph-child-a.md' && e.target === 'graph-child-b.md',
      );
      assert.ok(aToB, 'Child A should link to Child B');
    });

    test('unresolvable wiki-links do not produce edges', () => {
      const { edges } = vault.getGraph();
      const broken = edges.filter(e => e.target === 'nonexistent.md' || e.target === 'nonexistent');
      assert.strictEqual(broken.length, 0);
    });

    test('wiki-links with aliases resolve correctly', () => {
      const { edges } = vault.getGraph();
      const wikiToLarge = edges.find(
        e => e.source === 'wiki-links.md' && e.target === 'large.md',
      );
      // wiki-links.md has [[large|Large Doc]] — should resolve to large.md if it exists
      // large.md exists in fixtures
      if (fs.existsSync(path.join(FIXTURES, 'large.md'))) {
        assert.ok(wikiToLarge, 'Aliased wiki-link should resolve');
      }
    });
  });

  // ── Hierarchy edges ──────────────────────────────────────────

  suite('Hierarchy Edges', () => {
    test('parent frontmatter produces "parent" type edges', () => {
      const { edges } = vault.getGraph();
      const parentEdges = edges.filter(e => e.type === 'parent');
      assert.ok(parentEdges.length >= 2, `Expected >=2 parent edges, got ${parentEdges.length}`);
    });

    test('hub is parent of child-a', () => {
      const { edges } = vault.getGraph();
      const hubToA = edges.find(
        e => e.type === 'parent' && e.source === 'graph-hub.md' && e.target === 'graph-child-a.md',
      );
      assert.ok(hubToA, 'Should have parent edge from hub to child-a');
    });

    test('hub is parent of child-b', () => {
      const { edges } = vault.getGraph();
      const hubToB = edges.find(
        e => e.type === 'parent' && e.source === 'graph-hub.md' && e.target === 'graph-child-b.md',
      );
      assert.ok(hubToB, 'Should have parent edge from hub to child-b');
    });

    test('orphan has no parent edges', () => {
      const { edges } = vault.getGraph();
      const orphanParent = edges.find(
        e => e.type === 'parent' && (e.source === 'graph-orphan.md' || e.target === 'graph-orphan.md'),
      );
      assert.strictEqual(orphanParent, undefined);
    });
  });

  // ── Shared-tag edges ─────────────────────────────────────────

  suite('Shared-Tag Edges', () => {
    test('pages sharing #architecture get shared-tag edges', () => {
      const { edges } = vault.getGraph();
      const tagEdges = edges.filter(e => e.type === 'shared-tag');
      assert.ok(tagEdges.length > 0, 'Should have shared-tag edges');
      const archEdge = tagEdges.find(
        e => (e.source === 'graph-hub.md' && e.target === 'graph-child-a.md') ||
             (e.source === 'graph-child-a.md' && e.target === 'graph-hub.md'),
      );
      assert.ok(archEdge, 'Hub and Child A share #architecture');
    });

    test('shared-tag edges carry a human-readable reason', () => {
      const { edges } = vault.getGraph();
      const tagEdges = edges.filter(e => e.type === 'shared-tag');
      for (const e of tagEdges) {
        assert.ok(e.reason, `shared-tag edge ${e.source} → ${e.target} should have a reason`);
        assert.ok(e.reason!.includes('#'), 'Reason should include the tag name');
      }
    });

    test('pages sharing #performance are connected', () => {
      const { edges } = vault.getGraph();
      const perfEdge = edges.find(
        e => e.type === 'shared-tag' &&
          ((e.source === 'graph-hub.md' && e.target === 'graph-child-b.md') ||
           (e.source === 'graph-child-b.md' && e.target === 'graph-hub.md')),
      );
      assert.ok(perfEdge, 'Hub and Child B share #performance');
    });

    test('pages with no shared tags have no shared-tag edges between them', () => {
      const { edges } = vault.getGraph();
      const orphanTagEdge = edges.find(
        e => e.type === 'shared-tag' &&
          (e.source === 'graph-orphan.md' || e.target === 'graph-orphan.md'),
      );
      assert.strictEqual(orphanTagEdge, undefined);
    });
  });

  // ── Sibling edges ────────────────────────────────────────────

  suite('Sibling Edges', () => {
    test('children of the same parent get sibling edges', () => {
      const { edges } = vault.getGraph();
      const sibEdges = edges.filter(e => e.type === 'sibling');
      const abSibling = sibEdges.find(
        e => (e.source === 'graph-child-a.md' && e.target === 'graph-child-b.md') ||
             (e.source === 'graph-child-b.md' && e.target === 'graph-child-a.md'),
      );
      assert.ok(abSibling, 'Child A and Child B should be siblings');
    });

    test('sibling edges carry a reason', () => {
      const { edges } = vault.getGraph();
      const sibEdges = edges.filter(e => e.type === 'sibling');
      for (const e of sibEdges) {
        assert.ok(e.reason, 'Sibling edge should have a reason');
      }
    });

    test('non-sibling pages do not have sibling edges', () => {
      const { edges } = vault.getGraph();
      const badSibling = edges.find(
        e => e.type === 'sibling' &&
          (e.source === 'graph-hub.md' || e.target === 'graph-hub.md'),
      );
      assert.strictEqual(badSibling, undefined, 'Hub should not be a sibling');
    });
  });

  // ── Local graph mode ─────────────────────────────────────────

  suite('Local Graph Mode', () => {
    test('local mode depth=1 from hub includes direct neighbors only', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-hub.md', depth: 1,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const ids = data.nodes.map(n => n.id);
      assert.ok(ids.includes('graph-hub.md'), 'Focus node must be present');
      assert.ok(ids.includes('graph-child-a.md'), 'Direct child should be present');
      assert.ok(ids.includes('graph-child-b.md'), 'Direct child should be present');
      assert.ok(ids.includes('graph-leaf.md'), 'Direct link should be present');
      assert.ok(!ids.includes('graph-orphan.md'), 'Orphan should NOT be present at depth=1');
    });

    test('local mode depth=0 returns only the focus node', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-hub.md', depth: 0,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      assert.strictEqual(data.nodes.length, 1);
      assert.strictEqual(data.nodes[0].id, 'graph-hub.md');
    });

    test('local mode from leaf with depth=1', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-leaf.md', depth: 1,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const ids = data.nodes.map(n => n.id);
      assert.ok(ids.includes('graph-leaf.md'));
      assert.ok(ids.includes('graph-hub.md'), 'Leaf links to hub');
    });

    test('local mode depth=2 reaches further neighbors', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-leaf.md', depth: 2,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const ids = data.nodes.map(n => n.id);
      assert.ok(ids.includes('graph-child-a.md'), 'Should reach child-a at depth 2');
    });

    test('local mode from orphan returns only the orphan', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-orphan.md', depth: 2,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      assert.strictEqual(data.nodes.length, 1);
      assert.strictEqual(data.nodes[0].id, 'graph-orphan.md');
    });

    test('edges are filtered to only include visible nodes', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-hub.md', depth: 1,
        edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const nodeIds = new Set(data.nodes.map(n => n.id));
      for (const e of data.edges) {
        assert.ok(nodeIds.has(e.source), `Edge source ${e.source} should be a visible node`);
        assert.ok(nodeIds.has(e.target), `Edge target ${e.target} should be a visible node`);
      }
    });
  });

  // ── Global graph mode ────────────────────────────────────────

  suite('Global Graph Mode', () => {
    test('global mode returns all note nodes', () => {
      const data = vault.getGraph({ mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: '' });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      assert.strictEqual(noteNodes.length, 8);
    });

    test('global mode returns all edge types', () => {
      const data = vault.getGraph({ mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: '' });
      const types = new Set(data.edges.map(e => e.type));
      assert.ok(types.has('link'), 'Should have link edges');
      assert.ok(types.has('parent'), 'Should have parent edges');
      assert.ok(types.has('shared-tag'), 'Should have shared-tag edges');
    });
  });

  // ── Parent edge filtering (replaces old hierarchy mode) ──────

  suite('Parent Edge Filtering', () => {
    test('filtering to only parent edges works', () => {
      const data = vault.getGraph({ mode: 'global', depth: 10, edgeTypes: ['parent'], tags: [], orphansOnly: false, query: '' });
      for (const e of data.edges) {
        assert.strictEqual(e.type, 'parent', `Expected parent edge, got ${e.type}`);
      }
    });

    test('global mode with parent filter still includes all note nodes', () => {
      const data = vault.getGraph({ mode: 'global', depth: 10, edgeTypes: ['parent'], tags: [], orphansOnly: false, query: '' });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      assert.strictEqual(noteNodes.length, 8);
    });
  });

  // ── Edge type filtering ──────────────────────────────────────

  suite('Edge Type Filtering', () => {
    test('filtering to only "link" edges excludes tag/parent/sibling', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: ['link'], tags: [], orphansOnly: false, query: '',
      });
      for (const e of data.edges) {
        assert.strictEqual(e.type, 'link');
      }
    });

    test('filtering to only "shared-tag" edges works', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: ['shared-tag'], tags: [], orphansOnly: false, query: '',
      });
      assert.ok(data.edges.length > 0);
      for (const e of data.edges) {
        assert.strictEqual(e.type, 'shared-tag');
      }
    });

    test('filtering to only "parent" edges works', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: ['parent'], tags: [], orphansOnly: false, query: '',
      });
      for (const e of data.edges) {
        assert.strictEqual(e.type, 'parent');
      }
    });

    test('filtering with multiple edge types includes both', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: ['link', 'parent'], tags: [], orphansOnly: false, query: '',
      });
      const types = new Set(data.edges.map(e => e.type));
      assert.ok(types.size <= 2);
      for (const e of data.edges) {
        assert.ok(e.type === 'link' || e.type === 'parent');
      }
    });

    test('empty edgeTypes array returns all edge types', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const types = new Set(data.edges.map(e => e.type));
      assert.ok(types.size >= 3, 'Should have multiple edge types');
    });
  });

  // ── Text query filtering ─────────────────────────────────────

  suite('Text Query Filtering', () => {
    test('query filters nodes by label', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: 'Child',
      });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      assert.strictEqual(noteNodes.length, 2);
      assert.ok(noteNodes.every(n => n.label.includes('Child')));
    });

    test('query filters nodes by tag', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: 'database',
      });
      assert.ok(data.nodes.some(n => n.id === 'graph-child-b.md'));
    });

    test('query is case-insensitive', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: 'GRAPH HUB',
      });
      assert.ok(data.nodes.some(n => n.id === 'graph-hub.md'));
    });

    test('empty query returns all note nodes', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: false, query: '',
      });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      assert.strictEqual(noteNodes.length, 8);
    });
  });

  // ── Tag filtering ────────────────────────────────────────────

  suite('Tag Filtering', () => {
    test('filtering by tag returns only note nodes with that tag', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: ['architecture'], orphansOnly: false, query: '',
      });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      for (const n of noteNodes) {
        assert.ok(n.tags.includes('architecture'), `Node ${n.id} should have #architecture`);
      }
      assert.ok(noteNodes.length > 0, 'Should have at least one note with #architecture');
    });

    test('filtering by #performance includes hub and child-b', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: ['performance'], orphansOnly: false, query: '',
      });
      const ids = data.nodes.map(n => n.id);
      assert.ok(ids.includes('graph-hub.md'));
      assert.ok(ids.includes('graph-child-b.md'));
    });
  });

  // ── Orphan filtering ─────────────────────────────────────────

  suite('Orphan Filtering', () => {
    test('orphansOnly=true returns only orphan note nodes', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: true, query: '',
      });
      const noteNodes = data.nodes.filter(n => n.nodeType === 'note');
      for (const n of noteNodes) {
        assert.ok(n.isOrphan, `Node ${n.id} should be an orphan`);
      }
    });

    test('orphansOnly includes graph-orphan.md', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [], tags: [], orphansOnly: true, query: '',
      });
      assert.ok(data.nodes.some(n => n.id === 'graph-orphan.md'));
    });
  });

  // ── Dynamic updates ──────────────────────────────────────────

  suite('Dynamic Updates', () => {
    test('adding a new file updates the graph', () => {
      const before = vault.getGraph();
      vault.addFile('new-page.md', '# New\n[[graph-hub]]');
      const after = vault.getGraph();
      assert.strictEqual(after.nodes.length, before.nodes.length + 1);
      const newLinks = after.edges.filter(e => e.source === 'new-page.md' && e.type === 'link');
      assert.ok(newLinks.length >= 1);
    });

    test('removing a file updates the graph', () => {
      const before = vault.getGraph();
      vault.removeFile('graph-orphan.md');
      const after = vault.getGraph();
      assert.strictEqual(after.nodes.length, before.nodes.length - 1);
      assert.ok(!after.nodes.some(n => n.id === 'graph-orphan.md'));
    });

    test('updating file content updates edges', () => {
      vault.updateFile('graph-leaf.md', '# Leaf Updated\n[[graph-child-a]]');
      vault.flush();
      const { edges } = vault.getGraph();
      const leafToA = edges.find(
        e => e.type === 'link' && e.source === 'graph-leaf.md' && e.target === 'graph-child-a.md',
      );
      assert.ok(leafToA, 'Updated link should appear');
    });

    test('adding a tag to a file creates shared-tag edges', () => {
      vault.updateFile('graph-orphan.md', '# Orphan\n#architecture');
      vault.flush();
      const { edges } = vault.getGraph();
      const tagEdge = edges.find(
        e => e.type === 'shared-tag' &&
          (e.source === 'graph-orphan.md' || e.target === 'graph-orphan.md'),
      );
      assert.ok(tagEdge, 'Orphan should now share #architecture with other pages');
    });

    test('changing parent updates hierarchy edges', () => {
      vault.updateFile('graph-leaf.md', '---\nparent: graph-hub\n---\n# Leaf\n');
      vault.flush();
      const { edges } = vault.getGraph();
      const parentEdge = edges.find(
        e => e.type === 'parent' && e.source === 'graph-hub.md' && e.target === 'graph-leaf.md',
      );
      assert.ok(parentEdge, 'Hub should now be parent of leaf');
    });
  });

  // ── Combined filters ─────────────────────────────────────────

  suite('Combined Filters', () => {
    test('local mode + edge type filter', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-hub.md', depth: 1,
        edgeTypes: ['link'], tags: [], orphansOnly: false, query: '',
      });
      for (const e of data.edges) {
        assert.strictEqual(e.type, 'link');
      }
      assert.ok(data.nodes.length >= 2);
    });

    test('local mode + query filter', () => {
      const data = vault.getGraph({
        mode: 'local', focusNode: 'graph-hub.md', depth: 2,
        edgeTypes: [], tags: [], orphansOnly: false, query: 'Child',
      });
      for (const n of data.nodes) {
        assert.ok(n.label.toLowerCase().includes('child'));
      }
    });

    test('global mode + tag + query combined', () => {
      const data = vault.getGraph({
        mode: 'global', depth: 10, edgeTypes: [],
        tags: ['architecture'], orphansOnly: false, query: 'Hub',
      });
      assert.strictEqual(data.nodes.length, 1);
      assert.strictEqual(data.nodes[0].id, 'graph-hub.md');
    });
  });

  // ── Edge deduplication ───────────────────────────────────────

  suite('Edge Integrity', () => {
    test('no duplicate edges (same source, target, type)', () => {
      const { edges } = vault.getGraph();
      const seen = new Set<string>();
      for (const e of edges) {
        const key = `${e.source}\0${e.target}\0${e.type}`;
        assert.ok(!seen.has(key), `Duplicate edge: ${e.source} → ${e.target} (${e.type})`);
        seen.add(key);
      }
    });

    test('all edge sources and targets reference existing nodes', () => {
      const { nodes, edges } = vault.getGraph();
      const ids = new Set(nodes.map(n => n.id));
      for (const e of edges) {
        assert.ok(ids.has(e.source), `Edge source ${e.source} not in nodes`);
        assert.ok(ids.has(e.target), `Edge target ${e.target} not in nodes`);
      }
    });

    test('shared-tag edges are undirected (no reverse duplicate)', () => {
      const { edges } = vault.getGraph();
      const tagEdges = edges.filter(e => e.type === 'shared-tag');
      for (const e of tagEdges) {
        const reverse = tagEdges.find(r => r.source === e.target && r.target === e.source);
        assert.ok(!reverse, `Should not have both A→B and B→A for shared-tag`);
      }
    });
  });
});
