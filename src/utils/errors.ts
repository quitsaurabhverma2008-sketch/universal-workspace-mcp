/**
 * Application error with a stable, machine-readable code.
 * Tool layer converts these into MCP `isError` results; HTTP layer into JSON errors.
 */
export class AppError extends Error {
  readonly code: string;
  readonly detail?: unknown;

  constructor(code: string, message: string, detail?: unknown) {
    super(message);
    this.name = "AppError";
    this.code = code;
    this.detail = detail;
  }
}

export const Err = {
  unauthorized: (msg = "missing or invalid bearer token") => new AppError("UNAUTHORIZED", msg),
  forbidden: (msg = "insufficient permission for this operation") => new AppError("FORBIDDEN", msg),
  workspaceNotFound: (slug: string) => new AppError("WORKSPACE_NOT_FOUND", `workspace not found: ${slug}`),
  workspaceNotBound: () =>
    new AppError("WORKSPACE_NOT_BOUND", "no workspace bound to this session; call workspace_open first or pass workspace"),
  workspaceArchived: (slug: string) => new AppError("WORKSPACE_ARCHIVED", `workspace is archived: ${slug}`),
  validation: (msg: string, detail?: unknown) => new AppError("VALIDATION", msg, detail),
  notFound: (msg: string) => new AppError("NOT_FOUND", msg),
  hashConflict: () =>
    new AppError("HASH_CONFLICT", "file content hash does not match expected_hash; re-read the file and retry"),
  ambiguousMatch: (count: number) =>
    new AppError("AMBIGUOUS_MATCH", `old_string matched ${count} times; provide more context or set replace_all=true`),
  noMatch: () => new AppError("NO_MATCH", "old_string not found in file"),
  locked: (heldBy: string, expiresAt: string) =>
    new AppError("LOCKED", `file is locked by ${heldBy} until ${expiresAt}`, { held_by: heldBy, expires_at: expiresAt }),
  pathEscape: (p: string) => new AppError("PATH_ESCAPE", `path escapes the workspace root: ${p}`),
  reservedName: (p: string) => new AppError("RESERVED_NAME", `path is reserved and cannot be modified: ${p}`),
  tooLarge: (msg: string) => new AppError("TOO_LARGE", msg),
  execDenied: (msg: string) => new AppError("EXEC_DENIED", msg),
  execDisabled: () => new AppError("EXEC_DISABLED", "terminal execution is disabled on this server (EXEC_MODE=disabled)"),
  timeout: (ms: number) => new AppError("TIMEOUT", `process exceeded timeout of ${ms}ms and was killed`),
  concurrencyLimit: (n: number) => new AppError("CONCURRENCY_LIMIT", `max ${n} concurrent processes per workspace`),
  rateLimited: () => new AppError("RATE_LIMITED", "rate limit exceeded; slow down"),
  conflict: (msg: string) => new AppError("CONFLICT", msg),
  internal: (msg = "internal server error") => new AppError("INTERNAL", msg),
};

/** Convert any thrown value into a structured payload agents can parse. */
export function toErrorPayload(err: unknown): { code: string; message: string; detail?: unknown } {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, ...(err.detail !== undefined ? { detail: err.detail } : {}) };
  }
  if (err instanceof Error) {
    return { code: "INTERNAL", message: err.message };
  }
  return { code: "INTERNAL", message: String(err) };
}
