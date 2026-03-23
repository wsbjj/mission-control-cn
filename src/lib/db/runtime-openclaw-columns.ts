import type Database from 'better-sqlite3';

let checked = false;

export function ensureOpenClawIsolationColumns(db: Database.Database): void {
  if (checked) return;

  const workspaceCols = db.prepare("PRAGMA table_info(workspaces)").all() as Array<{ name: string }>;
  if (!workspaceCols.some((c) => c.name === 'openclaw_root_agent_id')) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN openclaw_root_agent_id TEXT`);
  }
  if (!workspaceCols.some((c) => c.name === 'openclaw_root_agent_status')) {
    db.exec(`ALTER TABLE workspaces ADD COLUMN openclaw_root_agent_status TEXT DEFAULT 'pending'`);
  }

  const sessionCols = db.prepare("PRAGMA table_info(openclaw_sessions)").all() as Array<{ name: string }>;
  if (!sessionCols.some((c) => c.name === 'parent_openclaw_agent_id')) {
    db.exec(`ALTER TABLE openclaw_sessions ADD COLUMN parent_openclaw_agent_id TEXT`);
  }
  if (!sessionCols.some((c) => c.name === 'inherited_session_key_prefix')) {
    db.exec(`ALTER TABLE openclaw_sessions ADD COLUMN inherited_session_key_prefix TEXT`);
  }
  if (!sessionCols.some((c) => c.name === 'inherited_model')) {
    db.exec(`ALTER TABLE openclaw_sessions ADD COLUMN inherited_model TEXT`);
  }

  checked = true;
}

