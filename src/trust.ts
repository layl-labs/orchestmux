import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';

/**
 * An autonomous flag (--yolo and friends) silences per-action tool approval, but
 * several agents guard a SEPARATE, one-time "do you trust this folder?" gate that
 * the flag does not touch. A headless worker parked at that gate never reads its
 * task, never reports, and the coordinator waits on a `done` that cannot come.
 *
 * Each backend below pre-seeds the trust state the agent would otherwise stop to
 * ask for. Verified against the real config each installed agent writes; codex is
 * TOML, the rest are JSON.
 */

const CODEX_CONFIG = join(homedir(), '.codex', 'config.toml');
const CLAUDE_CONFIG = join(homedir(), '.claude.json');
const AGY_CONFIG = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const GEMINI_TRUSTED_FOLDERS = join(homedir(), '.gemini', 'trustedFolders.json');
const QWEN_TRUSTED_FOLDERS = join(homedir(), '.qwen', 'trustedFolders.json');

export interface TrustResult {
  changed: boolean;
  path: string;
}

export type TrustKind = 'codex' | 'claude' | 'agy' | 'gemini' | 'qwen';

interface TrustBackend {
  /** Where the trust state lives, for the message shown when we seed it. */
  where: string;
  isTrusted(dir: string): boolean;
  trust(dir: string): TrustResult;
}

const BACKENDS: Record<TrustKind, TrustBackend> = {
  codex: { where: '~/.codex/config.toml', isTrusted: isCodexTrusted, trust: trustCodexDirectory },
  claude: { where: '~/.claude.json', isTrusted: isClaudeTrusted, trust: trustClaudeDirectory },
  agy: { where: '~/.gemini/antigravity-cli/settings.json', isTrusted: isAgyTrusted, trust: trustAgyDirectory },
  gemini: { where: '~/.gemini/trustedFolders.json', isTrusted: isGeminiTrusted, trust: trustGeminiDirectory },
  qwen: { where: '~/.qwen/trustedFolders.json', isTrusted: isQwenTrusted, trust: trustQwenDirectory },
};

/**
 * Seeds trust for `dir` under `kind` if it is not already trusted. Returns the
 * result plus where it was written (for the caller's log line), or `undefined`
 * when the directory was already trusted and nothing had to change.
 */
export function ensureTrusted(kind: TrustKind, dir: string): (TrustResult & { where: string }) | undefined {
  const backend = BACKENDS[kind];
  if (backend.isTrusted(dir)) return undefined;
  return { ...backend.trust(dir), where: backend.where };
}

// ── codex (TOML) ────────────────────────────────────────────────────────────
//
// Codex refuses to start in a directory it has not been told to trust, and the
// prompt it shows ("Do you trust the contents of this directory?") is not
// covered by --dangerously-bypass-approvals-and-sandbox. Trust is per exact path
// — a trusted parent does not cover its children — so every new worktree hits
// this on first use.

/** True when codex already trusts `dir`. */
export function isCodexTrusted(dir: string, configPath = CODEX_CONFIG): boolean {
  let toml = '';
  try {
    toml = readFileSync(configPath, 'utf8');
  } catch {
    return false;
  }
  return hasProjectHeader(toml, resolve(dir));
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
  if (hasProjectHeader(toml, target)) return { changed: false, path: target };

  const eol = toml.includes('\r\n') ? '\r\n' : '\n';
  const block = [`[projects."${escapeToml(target)}"]`, `trust_level = "trusted"`].join(eol);
  const separator = toml.length === 0 || toml.endsWith(eol) ? '' : eol;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${toml}${separator}${eol}${block}${eol}`, { mode: 0o600 });
  return { changed: true, path: target };
}

/**
 * True when a `[projects."<dir>"]` header for exactly `dir` is present.
 * Tolerates the formatting codex itself may write — whitespace inside the
 * brackets and either quote style — so an existing entry is never duplicated
 * just because it was not byte-identical to what we would append.
 */
function hasProjectHeader(toml: string, dir: string): boolean {
  const rx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const header = new RegExp(
    `^\\s*\\[\\s*projects\\s*\\.\\s*("${rx(escapeToml(dir))}"|'${rx(dir)}')\\s*\\]`,
    'm',
  );
  return header.test(toml);
}

function escapeToml(s: string): string {
  return s.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

// ── claude (~/.claude.json) ───────────────────────────────────────────────────
//
// --dangerously-skip-permissions removes tool-approval prompts but not the
// one-time "Do you trust the files in this folder?" dialog. Trust is recorded per
// absolute path under `projects[<dir>].hasTrustDialogAccepted`.

/** True when claude already has the trust dialog accepted for `dir`. */
export function isClaudeTrusted(dir: string, configPath = CLAUDE_CONFIG): boolean {
  const config = readJsonObject(configPath);
  if (config === undefined || config === MALFORMED) return false;
  const projects = config.projects as Record<string, { hasTrustDialogAccepted?: boolean }> | undefined;
  return projects?.[resolve(dir)]?.hasTrustDialogAccepted === true;
}

/**
 * Marks the trust dialog accepted for `dir` in ~/.claude.json if it is not
 * already. Reads, mutates only that project's `hasTrustDialogAccepted`, and
 * writes the whole object back — every other project and top-level setting is
 * preserved untouched. Matches claude's own 2-space, no-trailing-newline layout.
 *
 * A missing file is created; a present-but-unparseable file is left alone (it is
 * claude's own 100KB+ of state and overwriting it would lose real settings), and
 * the returned `changed: false` lets the caller surface the block instead.
 */
export function trustClaudeDirectory(dir: string, configPath = CLAUDE_CONFIG): TrustResult {
  const target = resolve(dir);
  const config = readJsonObject(configPath);
  if (config === MALFORMED) return { changed: false, path: target };

  const root = config ?? {};
  const projects = (root.projects ??= {}) as Record<string, { hasTrustDialogAccepted?: boolean }>;
  const project = (projects[target] ??= {});
  if (project.hasTrustDialogAccepted === true) return { changed: false, path: target };

  project.hasTrustDialogAccepted = true;
  writeJsonObject(configPath, root, { trailingNewline: false });
  return { changed: true, path: target };
}

// ── agy / Google Antigravity (~/.gemini/antigravity-cli/settings.json) ────────
//
// -p auto-approves tool calls and --dangerously-skip-permissions covers command
// execution, but neither answers Antigravity's first-launch workspace-trust gate.
// Trusted directories are absolute paths in the `trustedWorkspaces` array.

/** True when agy already trusts `dir` as a workspace. */
export function isAgyTrusted(dir: string, configPath = AGY_CONFIG): boolean {
  const config = readJsonObject(configPath);
  if (config === undefined || config === MALFORMED) return false;
  const trusted = config.trustedWorkspaces;
  return Array.isArray(trusted) && trusted.includes(resolve(dir));
}

/**
 * Appends `dir` to agy's `trustedWorkspaces` if missing, preserving every other
 * key (model, permissions, statusLine, …). Antigravity writes this file with a
 * trailing newline, so we match it. A malformed file is left untouched.
 */
export function trustAgyDirectory(dir: string, configPath = AGY_CONFIG): TrustResult {
  const target = resolve(dir);
  const config = readJsonObject(configPath);
  if (config === MALFORMED) return { changed: false, path: target };

  const root = config ?? {};
  const trusted = Array.isArray(root.trustedWorkspaces) ? (root.trustedWorkspaces as string[]) : [];
  if (trusted.includes(target)) return { changed: false, path: target };

  root.trustedWorkspaces = [...trusted, target];
  writeJsonObject(configPath, root, { trailingNewline: true });
  return { changed: true, path: target };
}

// ── gemini / qwen (trustedFolders.json) ───────────────────────────────────────
//
// Folder trust is off by default in gemini-cli (and its qwen-code fork), so
// --yolo usually reaches the task uninterrupted. But if the user has enabled it,
// --yolo does NOT clear the trust gate and the worker hangs. Seeding the folder
// here is a no-op when folder trust is off and a save when it is on. The file
// maps an absolute path to "TRUST_FOLDER"; a "TRUST_PARENT" entry on any ancestor
// already covers the directory, so we never re-seed a covered path.

/** True when `dir` is trusted directly, or covered by an ancestor's TRUST_PARENT. */
function isFolderTrusted(dir: string, configPath: string): boolean {
  const config = readJsonObject(configPath);
  if (config === undefined || config === MALFORMED) return false;
  const target = resolve(dir);
  if (typeof config[target] === 'string') return true;
  for (const [path, level] of Object.entries(config)) {
    if (level === 'TRUST_PARENT' && isAncestorOrSame(resolve(path), target)) return true;
  }
  return false;
}

/** Adds `{ <dir>: "TRUST_FOLDER" }` if `dir` is not already trusted or covered. */
function trustFolder(dir: string, configPath: string): TrustResult {
  const target = resolve(dir);
  if (isFolderTrusted(dir, configPath)) return { changed: false, path: target };

  const config = readJsonObject(configPath);
  if (config === MALFORMED) return { changed: false, path: target };
  const root = config ?? {};
  root[target] = 'TRUST_FOLDER';
  writeJsonObject(configPath, root, { trailingNewline: false });
  return { changed: true, path: target };
}

export function isGeminiTrusted(dir: string, configPath = GEMINI_TRUSTED_FOLDERS): boolean {
  return isFolderTrusted(dir, configPath);
}
export function trustGeminiDirectory(dir: string, configPath = GEMINI_TRUSTED_FOLDERS): TrustResult {
  return trustFolder(dir, configPath);
}
export function isQwenTrusted(dir: string, configPath = QWEN_TRUSTED_FOLDERS): boolean {
  return isFolderTrusted(dir, configPath);
}
export function trustQwenDirectory(dir: string, configPath = QWEN_TRUSTED_FOLDERS): TrustResult {
  return trustFolder(dir, configPath);
}

/** True when `ancestor` is `target` or a parent directory of it. */
function isAncestorOrSame(ancestor: string, target: string): boolean {
  if (ancestor === target) return true;
  const base = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return target.startsWith(base);
}

// ── shared JSON helpers ───────────────────────────────────────────────────────

type JsonObject = Record<string, unknown>;

/** Sentinel for a present file whose JSON we could not parse. */
const MALFORMED = Symbol('malformed-json-config');

/** Returns the parsed object, `undefined` if absent, or MALFORMED if unparseable. */
function readJsonObject(configPath: string): JsonObject | undefined | typeof MALFORMED {
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return undefined; // absent — safe to create
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as JsonObject) : MALFORMED;
  } catch {
    return MALFORMED;
  }
}

/** Writes `obj` as 2-space JSON (the layout every agent here uses), 0600. */
function writeJsonObject(configPath: string, obj: JsonObject, opts: { trailingNewline: boolean }): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const body = JSON.stringify(obj, null, 2) + (opts.trailingNewline ? '\n' : '');
  writeFileSync(configPath, body, { mode: 0o600 });
}
