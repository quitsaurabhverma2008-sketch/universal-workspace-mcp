/**
 * Command policy for the execution engine.
 * Defense in depth — not a sandbox. See docs/ARCHITECTURE.md §14.
 *
 * Two gates:
 *   1. Denylist (always active in every mode except `disabled`)
 *   2. Allowlist (only when EXEC_MODE=allowlist)
 */

export interface PolicyDecision {
  allowed: boolean;
  reason?: string;
}

interface DenyRule {
  pattern: RegExp;
  reason: string;
}

const DENY_RULES: DenyRule[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s*)+(\/|~|\$\{?HOME\}?|\/data|\/sdcard|\/root|\/usr|\/etc|\/bin|\/var)(?=\s|$|\/|[;&|)])/, reason: "recursive force delete of a system, home or shared-storage location" },
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s*)+(\*|\.\*|\/\*)(?=\s|$|[;&|)])/, reason: "recursive force delete of wildcard or filesystem root glob" },
  { pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "fork bomb" },
  { pattern: /\bmkfs(\.[a-z0-9]+)?\b/, reason: "filesystem format" },
  { pattern: /\bdd\b[^|&;]*\bof=\/dev\//, reason: "raw write to block device" },
  { pattern: />\s*\/dev\/(sd|nvme|mmcblk|vd|sda)/, reason: "redirect to block device" },
  { pattern: /\b(shutdown|reboot|poweroff|halt|init\s+[06]|systemctl\s+(poweroff|reboot))\b/, reason: "system power/reboot control" },
  { pattern: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(ba|z|k|fi)?sh\b/, reason: "piping a network script directly into a shell" },
  { pattern: /\bchmod\s+(-R\s+)?0{3,4}\s+\/(\s|$)/, reason: "chmod lockout of root" },
  { pattern: /\bfind\s+\/(\s|$)[^;|&]*-delete\b/, reason: "find -delete from filesystem root" },
  { pattern: /\bpasswd\b/, reason: "password change" },
  { pattern: /\b(sudo|su)\b/, reason: "privilege escalation" },
  { pattern: /\bpkg\s+(uninstall|remove|purge)\b/, reason: "package removal" },
  { pattern: /\bgit\s+push\b[^;|&]*(--force(-with-lease)?|\s-f)\b[^;|&]*\b(main|master)\b/, reason: "force push to main/master (force before branch)" },
  { pattern: /\bgit\s+push\b[^;|&]*\b(main|master)\b[^;|&]*(--force(-with-lease)?|\s-f)\b/, reason: "force push to main/master (branch before force)" },
  { pattern: /\b(termux-reload-settings|am\s+(force-stop|start)|pm\s+(disable|uninstall|clear))\b/, reason: "android/termux app control" },
  { pattern: /\b(kill|killall)\s+-9\s+(-1|1)\b/, reason: "kill every process" },
  { pattern: /\bnc\b.*\s-e\s/, reason: "netcat exec shell" },
  { pattern: /\b(env|printenv|set)\s*$/, reason: "bare environment dump (may print secrets)" },
];

function normalizeCommand(command: string): string {
  // Collapse whitespace/newlines so denylist can't be evaded with line breaks or tabs.
  return command.replace(/\s+/g, " ").trim();
}

export function checkCommand(mode: "disabled" | "restricted" | "allowlist", command: string, allowedCommands: string[]): PolicyDecision {
  if (mode === "disabled") return { allowed: false, reason: "execution is disabled on this server" };

  const normalized = normalizeCommand(command);
  if (!normalized) return { allowed: false, reason: "empty command" };

  for (const rule of DENY_RULES) {
    if (rule.pattern.test(normalized)) {
      return { allowed: false, reason: `blocked by safety policy: ${rule.reason}` };
    }
  }

  if (mode === "allowlist") {
    const head = normalized.split(/\s+/)[0]?.toLowerCase() ?? "";
    const ok = allowedCommands.some((prefix) => head === prefix || head.startsWith(`${prefix}-`));
    if (!ok) {
      return { allowed: false, reason: `command "${head}" is not in the allowlist (EXEC_MODE=allowlist)` };
    }
  }

  return { allowed: true };
}

/** Keys that must not pass the base environment scrub. */
export const SENSITIVE_ENV_KEY = /^(.*_)?(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIAL|PEPPER)(_.*)?$/i;

/** Build the environment for a child process: minimal safe base + scrubbed user env. */
export function buildEnv(
  extra: Record<string, string> | undefined,
  allowSensitiveEnv: boolean,
  workspace: { slug: string; rootPath: string }
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: process.env.HOME ?? "/data/data/com.termux/files/home",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    TERM: process.env.TERM ?? "xterm-256color",
    TMPDIR: process.env.TMPDIR ?? "/data/data/com.termux/files/usr/tmp",
    UMCP_WORKSPACE_SLUG: workspace.slug,
    UMCP_WORKSPACE_ROOT: workspace.rootPath,
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (typeof value !== "string") continue;
    if (!allowSensitiveEnv && SENSITIVE_ENV_KEY.test(key)) continue; // silently dropped; caller sees it in audit detail
    if (key.length > 200) continue;
    env[key] = value.slice(0, 4096);
  }
  return env;
}
