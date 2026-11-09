import fs from "node:fs/promises";
import { existsSync, createReadStream } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { Err } from "../utils/errors.js";
import { atomicWriteFile, isReservedTopLevel, safeResolve, sha256, toPosixRelative } from "../utils/paths.js";

/**
 * Workspace filesystem service. All paths flow through safeResolve —
 * nothing outside the workspace root is ever touched.
 */

export interface DirEntryInfo {
  name: string;
  path: string; // workspace-relative posix
  type: "file" | "directory" | "symlink" | "other";
  bytes: number;
  mtime: string;
  hash?: string;
}

const SKIP_ALWAYS = new Set([".git"]);

export async function listDir(
  root: string,
  userPath: string,
  opts: { recursive?: boolean; maxEntries?: number; skipGit?: boolean } = {}
): Promise<DirEntryInfo[]> {
  const abs = safeResolve(root, userPath || ".");
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw Err.notFound(`path not found: ${userPath}`);
  if (!stat.isDirectory()) throw Err.validation(`not a directory: ${userPath}`);

  const maxEntries = Math.min(opts.maxEntries ?? 1000, 2000);
  const skipGit = opts.skipGit ?? true;
  const entries: DirEntryInfo[] = [];

  async function walk(dirAbs: string, depth: number): Promise<void> {
    if (entries.length >= maxEntries) return;
    if (opts.recursive && depth > 20) return;
    const children = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const child of children) {
      if (entries.length >= maxEntries) return;
      if (skipGit && SKIP_ALWAYS.has(child.name)) continue;
      const childAbs = path.join(dirAbs, child.name);
      const rel = toPosixRelative(root, childAbs);
      let bytes = 0;
      let mtime = "";
      try {
        const st = await fs.lstat(childAbs);
        bytes = st.size;
        mtime = st.mtime.toISOString();
        const type = child.isDirectory() ? "directory" : child.isSymbolicLink() ? "symlink" : child.isFile() ? "file" : "other";
        entries.push({ name: child.name, path: rel, type, bytes, mtime });
        if (opts.recursive && child.isDirectory()) await walk(childAbs, depth + 1);
      } catch {
        entries.push({ name: child.name, path: rel, type: "other", bytes: 0, mtime });
      }
    }
  }

  await walk(abs, 0);
  entries.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1));
  return entries;
}

export interface FileReadResult {
  path: string;
  content?: string;
  binary?: boolean;
  hash: string;
  bytes: number;
  truncated: boolean;
  offset: number;
  lines: number;
}

export async function readFileContent(
  root: string,
  userPath: string,
  opts: { offset?: number; limit?: number; maxFileBytes: number }
): Promise<FileReadResult> {
  const abs = safeResolve(root, userPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw Err.notFound(`file not found: ${userPath}`);
  if (stat.isDirectory()) throw Err.validation(`path is a directory: ${userPath}`);
  if (!stat.isFile()) throw Err.validation(`not a regular file: ${userPath}`);

  const hash = sha256(await fs.readFile(abs));
  const bytes = stat.size;

  if (bytes > opts.maxFileBytes) {
    throw Err.tooLarge(`file is ${bytes} bytes; maximum readable is ${opts.maxFileBytes}`);
  }

  // Binary sniff: NUL in the first 8 KB
  const probe = Buffer.alloc(Math.min(bytes, 8192));
  const handle = await fs.open(abs, "r");
  await handle.read(probe, 0, probe.length, 0);
  await handle.close();
  if (probe.includes(0)) {
    return { path: toPosixRelative(root, abs), binary: true, hash, bytes, truncated: false, offset: 0, lines: 0 };
  }

  const raw = await fs.readFile(abs, "utf8");
  const allLines = raw.split("\n");
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.max(1, Math.min(opts.limit ?? 2000, 10_000));
  const slice = allLines.slice(offset, offset + limit);
  return {
    path: toPosixRelative(root, abs),
    content: slice.join("\n"),
    hash,
    bytes,
    truncated: offset + limit < allLines.length,
    offset,
    lines: slice.length,
  };
}

export interface WriteResult {
  path: string;
  hash: string;
  bytes: number;
  created: boolean;
}

async function assertNoExistingHashMismatch(abs: string, expectedHash?: string): Promise<void> {
  if (!expectedHash) return;
  if (!existsSync(abs)) throw Err.hashConflict();
  const current = sha256(await fs.readFile(abs));
  if (current !== expectedHash) throw Err.hashConflict();
}

export async function writeFileContent(
  root: string,
  userPath: string,
  content: string,
  opts: { expectedHash?: string | undefined; createDirs?: boolean | undefined; maxFileBytes: number; tmpDir: string }
): Promise<WriteResult> {
  const rel = toPosixRelative(root, safeResolve(root, userPath));
  if (isReservedTopLevel(rel)) throw Err.reservedName(rel);

  const buffer = Buffer.from(content, "utf8");
  if (buffer.byteLength > opts.maxFileBytes) {
    throw Err.tooLarge(`content is ${buffer.byteLength} bytes; maximum is ${opts.maxFileBytes}`);
  }

  const abs = safeResolve(root, userPath);
  await assertNoExistingHashMismatch(abs, opts.expectedHash);

  const existed = existsSync(abs);
  if (opts.createDirs === false && !existed && !existsSync(path.dirname(abs))) {
    throw Err.notFound(`parent directory does not exist: ${path.dirname(userPath)}`);
  }

  await atomicWriteFile(abs, buffer, opts.tmpDir);
  return { path: rel, hash: sha256(buffer), bytes: buffer.byteLength, created: !existed };
}

export interface EditResult {
  path: string;
  hash: string;
  bytes: number;
  replacements: number;
}

export async function editFileContent(
  root: string,
  userPath: string,
  oldString: string,
  newString: string,
  opts: { expectedHash?: string | undefined; replaceAll?: boolean | undefined; maxFileBytes: number; tmpDir: string }
): Promise<EditResult> {
  if (!oldString) throw Err.validation("old_string must not be empty");
  const rel = toPosixRelative(root, safeResolve(root, userPath));
  if (isReservedTopLevel(rel)) throw Err.reservedName(rel);

  const abs = safeResolve(root, userPath);
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) throw Err.notFound(`file not found: ${userPath}`);
  if (!stat.isFile()) throw Err.validation(`not a regular file: ${userPath}`);

  const original = await fs.readFile(abs, "utf8");
  if (opts.expectedHash && sha256(original) !== opts.expectedHash) throw Err.hashConflict();

  const occurrences = countOccurrences(original, oldString);
  if (occurrences === 0) throw Err.noMatch();
  if (occurrences > 1 && !opts.replaceAll) throw Err.ambiguousMatch(occurrences);

  const updated = opts.replaceAll ? original.split(oldString).join(newString) : original.replace(oldString, newString);
  const buffer = Buffer.from(updated, "utf8");
  if (buffer.byteLength > opts.maxFileBytes) {
    throw Err.tooLarge(`edited file would be ${buffer.byteLength} bytes; maximum is ${opts.maxFileBytes}`);
  }
  await atomicWriteFile(abs, buffer, opts.tmpDir);
  return { path: rel, hash: sha256(buffer), bytes: buffer.byteLength, replacements: opts.replaceAll ? occurrences : 1 };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

export async function deletePath(
  root: string,
  userPath: string,
  opts: { recursive?: boolean | undefined; expectedHash?: string | undefined }
): Promise<{ path: string; deleted: "file" | "directory" }> {
  const rel = toPosixRelative(root, safeResolve(root, userPath));
  if (isReservedTopLevel(rel)) throw Err.reservedName(rel);
  if (rel === ".") throw Err.reservedName(".");

  const abs = safeResolve(root, userPath);
  const stat = await fs.lstat(abs).catch(() => null);
  if (!stat) throw Err.notFound(`path not found: ${userPath}`);

  if (stat.isFile() && opts.expectedHash) {
    if (sha256(await fs.readFile(abs)) !== opts.expectedHash) throw Err.hashConflict();
  }
  if (stat.isDirectory()) {
    if (!opts.recursive) throw Err.validation(`path is a directory; set recursive=true: ${userPath}`);
    await fs.rm(abs, { recursive: true, force: false });
    return { path: rel, deleted: "directory" };
  }
  await fs.rm(abs, { force: false });
  return { path: rel, deleted: "file" };
}

export async function movePath(
  root: string,
  fromUserPath: string,
  toUserPath: string,
  opts: { overwrite?: boolean | undefined; expectedHash?: string | undefined; tmpDir: string }
): Promise<{ from: string; to: string; hash?: string }> {
  const fromRel = toPosixRelative(root, safeResolve(root, fromUserPath));
  const toRel = toPosixRelative(root, safeResolve(root, toUserPath));
  if (isReservedTopLevel(fromRel) || isReservedTopLevel(toRel)) throw Err.reservedName(isReservedTopLevel(fromRel) ? fromRel : toRel);

  const fromAbs = safeResolve(root, fromUserPath);
  const toAbs = safeResolve(root, toUserPath);

  if (!existsSync(fromAbs)) throw Err.notFound(`source not found: ${fromUserPath}`);
  if (existsSync(toAbs) && !opts.overwrite) throw Err.conflict(`destination exists: ${toUserPath}`);

  const fromStat = await fs.stat(fromAbs);
  if (fromStat.isFile() && opts.expectedHash) {
    if (sha256(await fs.readFile(fromAbs)) !== opts.expectedHash) throw Err.hashConflict();
  }

  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  if (existsSync(toAbs)) await fs.rm(toAbs, { recursive: true, force: false });
  await fs.rename(fromAbs, toAbs);

  const result: { from: string; to: string; hash?: string } = { from: fromRel, to: toRel };
  if (fromStat.isFile()) result.hash = sha256(await fs.readFile(toAbs));
  return result;
}

/** Simple glob -> RegExp: supports *, **, ? ; matched against the workspace-relative posix path. */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  const escape = (ch: string) => ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      re += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      re += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += escape(glob[i]!);
      i += 1;
    }
  }
  return new RegExp(re + "$");
}

export interface SearchResult {
  path: string;
  type: "file" | "directory";
  bytes: number;
  line?: number;
  preview?: string;
}

export async function searchFiles(
  root: string,
  opts: { pattern: string; path?: string | undefined; contentQuery?: string | undefined; maxResults?: number | undefined; skipGit?: boolean }
): Promise<{ results: SearchResult[]; truncated: boolean }> {
  const baseAbs = safeResolve(root, opts.path ?? ".");
  const baseRel = toPosixRelative(root, baseAbs);
  const stat = await fs.stat(baseAbs).catch(() => null);
  if (!stat) throw Err.notFound(`path not found: ${opts.path}`);

  // Normalize pattern: bare "foo" becomes "**/*foo*"; "*.ts" becomes "**/*.ts"
  let pattern = opts.pattern.trim();
  if (!pattern.includes("/")) pattern = `**/${pattern.includes("*") || pattern.includes("?") ? pattern : `*${pattern}*`}`;
  if (!/[*?]/.test(pattern)) pattern = pattern + "*";
  const regex = globToRegex(pattern);

  const contentNeedle = opts.contentQuery;
  const maxResults = Math.min(opts.maxResults ?? 100, 500);
  const results: SearchResult[] = [];
  const skipGit = opts.skipGit ?? true;

  const candidates: { abs: string; rel: string; bytes: number }[] = [];
  async function collect(dirAbs: string, depth: number): Promise<void> {
    if (depth > 25 || candidates.length > 20_000) return;
    const children = await fs.readdir(dirAbs, { withFileTypes: true });
    for (const child of children) {
      if (skipGit && SKIP_ALWAYS.has(child.name)) continue;
      const childAbs = path.join(dirAbs, child.name);
      const rel = toPosixRelative(root, childAbs);
      if (child.isDirectory()) {
        if (regex.test(rel + "/") || regex.test(rel)) {
          // directories can match name patterns
          const st = await fs.stat(childAbs);
          if (results.length < maxResults) results.push({ path: rel, type: "directory", bytes: 0 });
          void st;
        }
        await collect(childAbs, depth + 1);
      } else if (child.isFile()) {
        const st = await fs.stat(childAbs);
        if (regex.test(rel) || regex.test(child.name)) candidates.push({ abs: childAbs, rel, bytes: st.size });
      }
    }
  }

  if (stat.isDirectory()) await collect(baseAbs, 0);
  else if (stat.isFile()) candidates.push({ abs: baseAbs, rel: baseRel, bytes: stat.size });

  if (!contentNeedle) {
    for (const c of candidates) {
      if (results.length >= maxResults) break;
      results.push({ path: c.rel, type: "file", bytes: c.bytes });
    }
    return { results, truncated: results.length >= maxResults };
  }

  // Content scan: substring by default, or /regex/ when wrapped in slashes
  const isRegex = contentNeedle.length > 2 && contentNeedle.startsWith("/") && contentNeedle.endsWith("/");
  let needleRegex: RegExp | null = null;
  if (isRegex) {
    try {
      needleRegex = new RegExp(contentNeedle.slice(1, -1));
    } catch {
      throw Err.validation("invalid content regular expression");
    }
  }
  const needle = contentNeedle.toLowerCase();

  for (const c of candidates) {
    if (results.length >= maxResults) break;
    if (c.bytes > 2_000_000) continue;
    let foundLine = 0;
    let preview = "";
    let hit = false;
    const stream = createReadStream(c.abs, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      const hay = isRegex ? line : line.toLowerCase();
      const match = needleRegex ? needleRegex.test(line) : hay.includes(needle);
      if (match) {
        foundLine = lineNo;
        preview = line.trim().slice(0, 200);
        hit = true;
        break;
      }
    }
    rl.close();
    stream.destroy();
    if (hit) results.push({ path: c.rel, type: "file", bytes: c.bytes, line: foundLine, preview });
  }

  return { results, truncated: results.length >= maxResults };
}
