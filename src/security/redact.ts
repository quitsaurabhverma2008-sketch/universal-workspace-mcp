/**
 * Secret redaction for logs, events and command strings.
 * Not a guarantee — a safety net.
 */

const PATTERNS: RegExp[] = [
  /umcp_[A-Za-z0-9_-]{8,}/g,                    // our tokens
  /(token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|credential)\s*[=:]\s*["']?[^"'\s,}]{4,}/gi,
  /Bearer\s+[A-Za-z0-9._-]{8,}/gi,             // Authorization headers
  /ghp_[A-Za-z0-9]{20,}/g,                      // GitHub PAT
  /glpat-[A-Za-z0-9_-]{10,}/g,                  // GitLab PAT
  /sk-[A-Za-z0-9-]{16,}/g,                      // OpenAI-style
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,              // Slack
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

export function redactString(input: string): string {
  let out = input;
  for (const pattern of PATTERNS) {
    out = out.replace(pattern, (match) => {
      // Keep the key name readable where there is one, mask the value.
      const eq = match.indexOf("=") !== -1 ? match.indexOf("=") : match.indexOf(":");
      if (eq > 0) return match.slice(0, eq + 1) + " [redacted]";
      return "[redacted]";
    });
  }
  return out;
}

/** Redact an arbitrary detail payload (JSON-round-tripped, best effort). */
export function redactDetail(detail: unknown): unknown {
  try {
    const json = JSON.stringify(detail ?? {});
    return JSON.parse(redactString(json));
  } catch {
    return { note: "detail omitted: redaction failed" };
  }
}
