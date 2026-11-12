# AURORA — Aarav Rao · Personal Landing Page

Fictional-developer personal page. **Built entirely through the Universal
Workspace MCP by three MCP agents working in one shared workspace.**

## View it
Open `index.html` in any browser — no build step, no dependencies.

## How it was built
- **agent-alpha** → `index.html` (semantic page, hero, projects grid, footer with #local-time)
- **agent-beta**  → `styles.css` (aurora dark theme, CSS variables, responsive)
- **agent-gamma** → `app.js` (canvas starfield, live clock, theme toggle)
- open race → this README + cross-file integration check

All coordination (task claims with compare-and-set, file locks, hash-checked
writes, audited events) happened over MCP. See `PLAN.md`,
`git log` and the workspace `events` table for the full trail.

## Files
- `index.html` — structure
- `styles.css` — theme (supports `body[data-theme="light"]`)
- `app.js` — starfield + clock + theme toggle
