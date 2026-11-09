import fs from "node:fs";
import { loadConfig, type AppConfig } from "./config/env.js";
import { openDatabase, pruneEvents, reapStaleState, type Db } from "./database/db.js";
import { logger } from "./utils/logger.js";

export interface AppServices {
  config: AppConfig;
  db: Db;
}

/** Create the service container: config → dirs → database → migrations → reaper. */
export function createAppServices(): AppServices {
  const config = loadConfig();

  for (const dir of [config.dataDir, config.workspacesDir, config.backupsDir, config.tmpDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = openDatabase(config.databasePath);
  reapStaleState(db);
  const pruned = pruneEvents(db, config.eventRetentionDays);
  if (pruned > 0) logger.info({ pruned }, "pruned old audit events");

  return { config, db };
}
