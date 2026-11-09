import { pino } from "pino";

const level = process.env.LOG_LEVEL ?? "info";

export const logger = pino({
  level,
  base: { service: "universal-workspace-mcp" },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    // Never let token-like strings hit the logs, even from error paths.
    paths: ["*.authorization", "*.token", "*.pepper", "*.TOKEN_PEPPER"],
    censor: "[redacted]",
  },
});

export type Logger = typeof logger;
