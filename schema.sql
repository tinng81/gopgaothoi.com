-- #!zh: RSVP 提交记录表。执行：npx wrangler d1 execute rsvp-db --remote --file=schema.sql
--       （本地调试加 --local）
-- #!en: RSVP submissions table. Apply with:
--       npx wrangler d1 execute rsvp-db --remote --file=schema.sql  (add --local for dev)

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  data TEXT NOT NULL,            -- JSON: { <input-uuid>: <value>, ... }
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',   -- CF-Connecting-IP，按 IP 限流用 / caller IP for per-IP rate limiting
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rsvps_work ON rsvps (work);
CREATE INDEX IF NOT EXISTS idx_rsvps_ip_time ON rsvps (ip, created_at);

-- #!zh: 祝福留言（lbp-wish 组件，与 RSVP 刻意分离、独立数据表）
-- #!en: wishes/guestbook (lbp-wish widget — deliberately separate from RSVP, own table)
CREATE TABLE IF NOT EXISTS wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL,
  user_agent TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',   -- CF-Connecting-IP，按 IP 限流用 / caller IP for per-IP rate limiting
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wishes_work ON wishes (work);
CREATE INDEX IF NOT EXISTS idx_wishes_ip_time ON wishes (ip, created_at);
