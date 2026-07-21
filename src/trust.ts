import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Codex refuses to start in a directory it has not been told to trust, and the
 * prompt it shows ("Do you trust the contents of this directory?") is not
 * covered by --dangerously-bypass-approvals-and-sandbox. A worker launched in
 * an untrusted directory therefore sits at that prompt forever: it never reads
 * its task, never reports, and the coordinator waits on a `done` that cannot
 * come.
 *
 * Trust is per exact path — a trusted parent does not cover its children — so
 * every new worktree hits this on first use.
 */
const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml');

export interface TrustResult {
  changed: boolean;
  path: string;
}

/** True when codex already trusts `dir`. */
export function isCodexTrusted(dir: string, configPath = CODEX_CONFIG): boolean {
  let toml = '';
  try {
    toml = readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }
  return findProjectHeader(toml, resolve(dir)) !== -1;
}

/**
 * Adds a trust entry for `dir` if it is missing. Only ever appends; existing
 * entries and unrelated config are left untouched.
 */
export function trustCodexDirectory(dir: string, configPath = CODEX_CONFIG): TrustResult {
  const target = resolve(dir);
  let toml = '';
  try {
    toml = readFileSync(configPath, 'utf8');
  } catch {
    /* first run — the file is created below */
  }
  if (findProjectHeader(toml, target) !== -1) return { changed: false, path: target };

  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const block = [`[projects."${escapeToml(target)}"]`, `trust_level = "trusted"`].join(eol);
  const separator = toml.length === 0 || toml.endsWith(eol) ? '' : eol;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${toml}${separator}${eol}${block}${eol}`, { mode: 0o600 });
  return { changed: true, path: target };
}

/** Index of the `[projects."<dir>"]` header, or -1. */
function findProjectHeader(toml: string, dir: string): number {
  return toml.indexOf(`[projects."${escapeToml(dir)}"]`);
}

function escapeToml(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}
