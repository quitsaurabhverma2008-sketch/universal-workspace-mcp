#!/data/data/com.termux/files/usr/bin/bash
# Nightly-ish backup: consistent SQLite snapshot + tar.gz of all workspaces.
# Retention: keeps the newest N backups per kind (default 14).
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP="${1:-14}"
STAMP="$(date +%F-%H%M)"
mkdir -p data/backups

echo "== snapshot database =="
STAMP="$STAMP" node --input-type=module - <<'EOF'
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
const stamp = process.env.STAMP;
const src = path.resolve(process.cwd(), "data/database.sqlite");
const dest = path.resolve(process.cwd(), `data/backups/db-${stamp}.sqlite`);
const db = new DatabaseSync(src, { readOnly: true });
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();
console.log(`wrote ${dest}`);
EOF

echo "== tar workspaces =="
tar -czf "data/backups/workspaces-${STAMP}.tar.gz" -C data workspaces
echo "wrote data/backups/workspaces-${STAMP}.tar.gz"

echo "== prune old backups (keep ${KEEP}) =="
ls -1t data/backups/db-*.sqlite 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
ls -1t data/backups/workspaces-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm --
echo "backup complete"
