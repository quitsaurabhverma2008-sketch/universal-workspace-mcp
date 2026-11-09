import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { Err } from "./errors.js";

/**
 * Path safety for the workspace jail.
 *
 * Rules:
 *  - user paths must be relative, no NUL bytes
 *  - resolved path must stay inside the workspace root
 *  - realpath of the deepest existing ancestor must also stay inside (symlink defense)
 *  - reserved top-level names are immutable (root-anchored)
 */

export const RESERVED_TOP_LEVEL = new Set(["Brain.md", "PROJECT.md", "PLAN.md", "outputs", "logs"]);

export function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Normalize a user-supplied relative path to POSIX separators; reject absolutes and NULs. */
function normalizeUserPath(userPath: string): string {
  if (userPath.includes("\0")) throw Err.pathEscape(userPath);
  const trimmed = userPath.trim();
  if (path.isAbsolute(trimmed)) throw Err.pathEscape(userPath);
  // Strip leading ./ and collapse
  const normalized = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (normalized === ".") return ".";
  if (normalized.startsWith("..") || path.posix.isAbsolute(normalized)) throw Err.pathEscape(userPath);
  // Windows drive letters sneaking through via backslash conversion
  if (/^[A-Za-z]:/.test(normalized)) throw Err.pathEscape(userPath);
  return normalized;
}

function realpathSyncCached(p: string): string {
  // realpath needed only for containment verification; fall back to resolve on error
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Resolve a user path against the workspace root.
 * Returns an absolute, contained, symlink-checked path. Throws AppError otherwise.
 */
export function safeResolve(workspaceRoot: string, userPath = "."): string {
  const rel = normalizeUserPath(userPath || ".");
  const root = path.resolve(workspaceRoot);
  const candidate = path.resolve(root, rel);

  if (candidate !== root && !candidate.startsWith(root + path.sep)) {
    throw Err.pathEscape(userPath);
  }

  // Symlink containment: check deepest existing ancestor
  const realRoot = realpathSyncCached(root);
  let ancestor = candidate;
  const missing: string[] = [];
  while (!fs.existsSync(ancestor)) {
    missing.push(path.basename(ancestor));
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const realAncestor = realpathSyncCached(ancestor);
  if (realAncestor !== realRoot && !realAncestor.startsWith(realRoot + path.sep)) {
    throw Err.pathEscape(userPath);
  }
  return candidate;
}

/**
 * Reserved, untouchable entries — exactly the root-level ones:
 *   Brain.md / PROJECT.md / PLAN.md (files) and outputs/ / logs/ (directories).
 * Files *inside* outputs/ and logs/ are freely writable; only the reserved
 * entries themselves may not be written, moved or deleted via generic tools.
 */
export function isReservedTopLevel(relPathPosix: string): boolean {
  const normalized = normalizeUserPath(relPathPosix);
  if (normalized === ".") return false;
  const segments = normalized.split("/");
  if (segments.length !== 1) return false;
  const first = segments[0];
  return first !== undefined && RESERVED_TOP_LEVEL.has(first);
}

/** Workspace-relative POSIX path for storage in DB/events. */
export function toPosixRelative(workspaceRoot: string, absolutePath: string): string {
  const rel = path.relative(path.resolve(workspaceRoot), absolutePath);
  return rel.split(path.sep).join("/");
}

/** Atomic write: tmp file in data/tmp (same filesystem) -> fsync -> rename. */
export async function atomicWriteFile(
  targetPath: string,
  content: Buffer | string,
  tmpDir: string,
  mode = 0o644
): Promise<void> {
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const tmp = path.join(tmpDir, `w-${randomUUID()}.tmp`);
  const handle = await fsp.open(tmp, "w", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, targetPath);
}
