# PR: Database Safety Safeguards

## Summary

Two targeted safety improvements to `src/lib/db/migrations.ts` that protect production databases from accidental data loss.

---

## Changes

### 1. Pre-migration backup (`runMigrations`)

**File:** `src/lib/db/migrations.ts`

**What it does:**
- Before running any pending migrations, creates a timestamped backup of the `.db` file
- Uses SQLite's `VACUUM INTO` command — the correct mechanism for WAL-mode databases (a raw `cp` is NOT safe in WAL mode because `.db` and `.wal` files are written independently)
- Stores backups in a `db-backups/` subdirectory next to the database file (created automatically if it doesn't exist)
- Keeps the last 5 backups, automatically removes older ones
- If backup creation fails, **aborts the migration run entirely** and throws — protecting data takes priority over applying schema changes; operators must resolve the underlying cause (disk space, permissions) before migrations will run
- Backup cleanup failures (old file deletion) are reported separately and do not falsely signal that the backup itself failed

**Why:**
The migration system has no rollback (`down` functions). If a migration corrupts or loses data, the only recovery path is restoring from a backup. Since there was no automated backup mechanism, any migration failure on a database with real data was an unrecoverable event. This change closes that gap.

**Backup is only created when there are pending migrations** (i.e., on first run after an upgrade). Normal startups with no pending migrations are unaffected.

---

### 2. Data guard in migration 013 (`reset_fresh_start`)

**File:** `src/lib/db/migrations.ts`

**What it does:**
- Before the destructive `DELETE FROM` loop, checks both `SELECT COUNT(*) FROM tasks` AND `SELECT COUNT(*) FROM agents WHERE source = 'local'`
- If the database has any existing tasks **or** any locally-configured agents, **skips all destructive deletes** and logs a prominent warning
- Non-destructive operations (workflow template configuration) still run safely regardless
- Agent bootstrap still runs, but `bootstrapCoreAgentsRaw` is already idempotent (it checks agent count before inserting)

**Why:**
Migration 013 was committed as a developer convenience "fresh start" — it deletes all operational data across 13 tables on startup. On a brand-new database this is harmless. But if a user upgrades Mission Control after accumulating months of tasks, knowledge entries, and agent history, migration 013 would silently wipe everything on the next startup with zero warning.

The guard makes the destructive behavior conditional: it only runs on databases that have no tasks and no locally-configured agents (i.e., genuinely fresh installs). Checking both tables closes an edge case where a user who bootstrapped agents but hadn't yet submitted any tasks would still have their agent configuration wiped.

---

## Testing

- App boots cleanly: `npm run dev -- --port 4001` ✅
- API responds correctly: `GET /api/agents` returns full agent list ✅
- TypeScript compiles without errors in `migrations.ts` ✅
- Backup mechanism verified via isolated test: `VACUUM INTO` creates a consistent, readable copy with data intact ✅
- No changes to existing behavior for databases with all migrations already applied ✅
- Backup failure now aborts migration run (fatal); verified by code review ✅
- Backup cleanup failure isolated to its own try/catch; won't shadow successful backup ✅
- Migration 013 guard checks both `tasks` and `agents` tables ✅

---

## Files Changed

| File | Change |
|------|--------|
| `src/lib/db/migrations.ts` | Added `import fs from 'fs'` and `import path from 'path'` |
| `src/lib/db/migrations.ts` | Added `MAX_BACKUPS = 5` constant |
| `src/lib/db/migrations.ts` | Added `createPreMigrationBackup(db)` helper function |
| `src/lib/db/migrations.ts` | Modified `runMigrations()` to detect pending migrations, call backup, and iterate `pending` array |
| `src/lib/db/migrations.ts` | Modified migration 013 `up` function to check task count before destructive deletes |

No other files were modified.

---

## Backward Compatibility

- **Existing databases:** No behavior change on startup when all migrations are already applied
- **Fresh installs:** Migration 013 runs the full wipe as before (task count is 0)
- **Upgraded databases with data:** Migration 013 now preserves data instead of silently wiping it
- **Public API:** `runMigrations()` and `getMigrationStatus()` signatures unchanged
