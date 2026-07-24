import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isClaudeTrusted,
  trustClaudeDirectory,
  isAgyTrusted,
  trustAgyDirectory,
  isGeminiTrusted,
  trustGeminiDirectory,
} from '../dist/trust.js';

/**
 * These edit the user's real ~/.claude.json in production: 100KB+ of state a
 * mistake would silently destroy. The tests assert that trusting one directory
 * touches nothing else, that a corrupt file is left alone, and that the write
 * stays byte-compatible with claude's own layout so it does not churn the file.
 */

function tmpConfig(t) {
  const dir = mkdtempSync(join(tmpdir(), 'orchestmux-trust-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, '.claude.json');
}

test('an absent config is created and the directory reads back trusted', (t) => {
  const cfg = tmpConfig(t);
  assert.equal(isClaudeTrusted('/repo/a', cfg), false);

  const r = trustClaudeDirectory('/repo/a', cfg);
  assert.equal(r.changed, true);
  assert.equal(isClaudeTrusted('/repo/a', cfg), true);
});

test('trusting one directory preserves every other key and project', (t) => {
  const cfg = tmpConfig(t);
  writeFileSync(
    cfg,
    JSON.stringify(
      { numStartups: 422, projects: { '/repo/x': { hasTrustDialogAccepted: true, allowedTools: ['Bash'] } } },
      null,
      2,
    ),
  );

  trustClaudeDirectory('/repo/y', cfg);
  const j = JSON.parse(readFileSync(cfg, 'utf8'));

  assert.equal(j.numStartups, 422);
  assert.deepEqual(j.projects['/repo/x'], { hasTrustDialogAccepted: true, allowedTools: ['Bash'] });
  assert.deepEqual(j.projects['/repo/y'], { hasTrustDialogAccepted: true });
});

test('trusting an already-trusted directory is a no-op that does not rewrite', (t) => {
  const cfg = tmpConfig(t);
  trustClaudeDirectory('/repo/a', cfg);
  const before = readFileSync(cfg, 'utf8');

  const r = trustClaudeDirectory('/repo/a', cfg);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(cfg, 'utf8'), before);
});

test('a malformed config is reported untrusted and never overwritten', (t) => {
  const cfg = tmpConfig(t);
  const garbage = '{ this is not json ';
  writeFileSync(cfg, garbage);

  assert.equal(isClaudeTrusted('/repo/a', cfg), false);
  const r = trustClaudeDirectory('/repo/a', cfg);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(cfg, 'utf8'), garbage);
});

test('the written file matches claude\'s 2-space, no-trailing-newline layout', (t) => {
  const cfg = tmpConfig(t);
  trustClaudeDirectory('/repo/a', cfg);
  const raw = readFileSync(cfg, 'utf8');

  assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2));
  assert.equal(raw.endsWith('\n'), false);
});

// ── agy ─────────────────────────────────────────────────────────────────────

test('agy appends to trustedWorkspaces without disturbing other settings', (t) => {
  const cfg = tmpConfig(t);
  writeFileSync(
    cfg,
    JSON.stringify({ model: 'Gemini 3.6 Flash', permissions: { allow: ['command(npx)'] }, trustedWorkspaces: ['/repo/x'] }, null, 2) + '\n',
  );
  assert.equal(isAgyTrusted('/repo/y', cfg), false);

  const r = trustAgyDirectory('/repo/y', cfg);
  const j = JSON.parse(readFileSync(cfg, 'utf8'));

  assert.equal(r.changed, true);
  assert.equal(j.model, 'Gemini 3.6 Flash');
  assert.deepEqual(j.permissions, { allow: ['command(npx)'] });
  assert.deepEqual(j.trustedWorkspaces, ['/repo/x', '/repo/y']);
  assert.equal(isAgyTrusted('/repo/y', cfg), true);
});

test('agy creates the file with a trailing newline like Antigravity does', (t) => {
  const cfg = tmpConfig(t);
  const r = trustAgyDirectory('/repo/a', cfg);
  const raw = readFileSync(cfg, 'utf8');

  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(raw).trustedWorkspaces, ['/repo/a']);
  assert.equal(raw.endsWith('\n'), true);
});

test('agy re-trusting an already-listed workspace is a no-op', (t) => {
  const cfg = tmpConfig(t);
  trustAgyDirectory('/repo/a', cfg);
  const before = readFileSync(cfg, 'utf8');

  const r = trustAgyDirectory('/repo/a', cfg);
  assert.equal(r.changed, false);
  assert.equal(readFileSync(cfg, 'utf8'), before);
});

// ── gemini / qwen (trustedFolders.json) ───────────────────────────────────────

test('gemini seeds an uncovered folder as TRUST_FOLDER', (t) => {
  const cfg = tmpConfig(t);
  assert.equal(isGeminiTrusted('/repo/a', cfg), false);

  const r = trustGeminiDirectory('/repo/a', cfg);
  assert.equal(r.changed, true);
  assert.equal(JSON.parse(readFileSync(cfg, 'utf8'))['/repo/a'], 'TRUST_FOLDER');
});

test('gemini treats a child of a TRUST_PARENT entry as already trusted', (t) => {
  const cfg = tmpConfig(t);
  writeFileSync(cfg, JSON.stringify({ '/repo': 'TRUST_PARENT' }, null, 2));

  assert.equal(isGeminiTrusted('/repo/nested/deep', cfg), true);
  const r = trustGeminiDirectory('/repo/nested/deep', cfg);
  assert.equal(r.changed, false);
  // The covering entry is untouched and no redundant child entry is added.
  assert.deepEqual(JSON.parse(readFileSync(cfg, 'utf8')), { '/repo': 'TRUST_PARENT' });
});

test('gemini does not treat a sibling prefix as a covered child', (t) => {
  const cfg = tmpConfig(t);
  writeFileSync(cfg, JSON.stringify({ '/repo/app': 'TRUST_PARENT' }, null, 2));

  // /repo/app-2 shares the string prefix "/repo/app" but is not under it.
  assert.equal(isGeminiTrusted('/repo/app-2', cfg), false);
});
