import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Storage for calls and agents. Production uses MySQL; the simulator and local
// testing use a SQLite file. Both run the same queries through a small executor
// ({ all, get, run, script, close }) and get their schema from migrations/<driver>/.
//
// Call status lifecycle:
//   active       -> ringing / dialing / connected on the agent's extension
//   pending      -> call ended, agent owes an outcome
//   completed    -> outcome saved
//   not_required -> ended without needing one (e.g. missed inbound call)
//   waived       -> supervisor released the agent without an outcome

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const UPDATABLE = new Set([
  'agent_name', 'customer_number', 'customer_name', 'direction', 'status', 'answered_at', 'ended_at',
  'talk_seconds', 'category', 'disposition', 'sub_disposition', 'notes', 'follow_up_date', 'disposed_at',
  'waived_by', 'waived_reason',
]);

// ---- Executors -----------------------------------------------------------------
async function sqliteExecutor(file) {
  const { DatabaseSync } = await import('node:sqlite');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  const conv = (params = []) => params.map((x) =>
    x === undefined ? null : typeof x === 'boolean' ? (x ? 1 : 0) : x instanceof Date ? x.toISOString() : x);
  return {
    driver: 'sqlite',
    describe: file,
    all: async (sql, params) => db.prepare(sql).all(...conv(params)),
    get: async (sql, params) => db.prepare(sql).get(...conv(params)),
    run: async (sql, params) => {
      const r = db.prepare(sql).run(...conv(params));
      return { insertId: Number(r.lastInsertRowid), affected: Number(r.changes) };
    },
    script: async (sql) => {
      db.exec('BEGIN');
      try { db.exec(sql); db.exec('COMMIT'); } catch (err) { db.exec('ROLLBACK'); throw err; }
    },
    close: async () => db.close(),
  };
}

async function mysqlExecutor(cfg) {
  const mysql = await import('mysql2/promise');
  const base = {
    host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    timezone: 'Z', dateStrings: ['DATE'], decimalNumbers: true, charset: 'utf8mb4',
  };
  const pool = mysql.createPool({ ...base, connectionLimit: 10, waitForConnections: true });
  // ISO timestamps from the app are written as UTC DATETIME values.
  const conv = (params = []) => params.map((x) =>
    x === undefined ? null : typeof x === 'string' && ISO_RE.test(x) ? new Date(x) : x);
  return {
    driver: 'mysql',
    describe: `mysql://${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database}`,
    all: async (sql, params) => (await pool.query(sql, conv(params)))[0],
    get: async (sql, params) => (await pool.query(sql, conv(params)))[0][0],
    run: async (sql, params) => {
      const [r] = await pool.query(sql, conv(params));
      return { insertId: Number(r.insertId), affected: Number(r.affectedRows) };
    },
    script: async (sql) => {
      const conn = await mysql.createConnection({ ...base, multipleStatements: true });
      try { await conn.query(sql); } finally { await conn.end(); }
    },
    close: () => pool.end(),
  };
}

// ---- Migrations ----------------------------------------------------------------
export async function migrate(exec, log = console) {
  const dir = path.join(ROOT, 'migrations', exec.driver);
  const timeType = exec.driver === 'mysql' ? 'DATETIME(3)' : 'TEXT';
  await exec.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(100) NOT NULL PRIMARY KEY, applied_at ${timeType} NOT NULL)`);
  const done = new Set((await exec.all('SELECT version FROM schema_migrations')).map((r) => r.version));
  const files = fs.readdirSync(dir).filter((f) => /^\d+_[\w-]+\.sql$/.test(f)).sort();
  let applied = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (done.has(version)) continue;
    log.info(`[db] applying migration ${file}`);
    await exec.script(fs.readFileSync(path.join(dir, file), 'utf8'));
    await exec.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, new Date()]);
    applied++;
  }
  log.info(`[db] ${exec.describe}: schema up to date (${applied} migration${applied === 1 ? '' : 's'} applied)`);
}

// ---- Repository ----------------------------------------------------------------
export async function openDatabase(dbConfig, log = console) {
  const exec = dbConfig.driver === 'mysql'
    ? await mysqlExecutor(dbConfig.mysql)
    : await sqliteExecutor(dbConfig.sqlitePath);
  if (dbConfig.autoMigrate) await migrate(exec, log);
  return createRepo(exec);
}

export async function openExecutor(dbConfig) {
  return dbConfig.driver === 'mysql' ? mysqlExecutor(dbConfig.mysql) : sqliteExecutor(dbConfig.sqlitePath);
}

function createRepo(db) {
  const getCall = (id) => db.get('SELECT * FROM calls WHERE id = ?', [Number(id)]);
  const getAgent = (ext) => db.get('SELECT * FROM agents WHERE extension = ?', [ext]);

  const repo = {
    driver: db.driver,
    now: () => new Date().toISOString(),
    close: () => db.close(),

    async createCall(c) {
      const r = await db.run(`INSERT INTO calls
        (call_key, pbx_call_id, participant_id, extension, agent_name, customer_number, customer_name, direction, status, started_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`, [
        c.callKey, c.pbxCallId, c.participantId, c.extension, c.agentName,
        c.customerNumber, c.customerName, c.direction || 'unknown', c.startedAt || repo.now(),
      ]);
      return getCall(r.insertId);
    },
    getCall,
    getCallByKey: (key) => db.get('SELECT * FROM calls WHERE call_key = ?', [key]),
    callsFor: (ext, status) => db.all('SELECT * FROM calls WHERE extension = ? AND status = ? ORDER BY started_at, id', [ext, status]),
    callsWithStatus: (status) => db.all('SELECT * FROM calls WHERE status = ? ORDER BY started_at, id', [status]),

    async updateCall(id, fields) {
      const keys = Object.keys(fields).filter((k) => UPDATABLE.has(k));
      if (keys.length) {
        await db.run(`UPDATE calls SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
          [...keys.map((k) => fields[k]), Number(id)]);
      }
      return getCall(id);
    },

    listCalls({ status, ext, limit = 100, since } = {}) {
      const where = [];
      const params = [];
      if (status) { where.push('status = ?'); params.push(status); }
      if (ext) { where.push('extension = ?'); params.push(ext); }
      if (since) { where.push('started_at >= ?'); params.push(since); }
      params.push(Math.min(Math.max(Math.floor(Number(limit)) || 100, 1), 5000));
      return db.all(`SELECT * FROM calls ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY started_at DESC, id DESC LIMIT ?`, params);
    },

    async upsertAgent(ext, name) {
      const now = repo.now();
      const r = await db.run('UPDATE agents SET name = COALESCE(?, name), last_seen = ? WHERE extension = ?', [name, now, ext]);
      if (r.affected) return;
      try {
        await db.run('INSERT INTO agents (extension, name, last_seen) VALUES (?, ?, ?)', [ext, name, now]);
      } catch {
        await db.run('UPDATE agents SET name = COALESCE(?, name), last_seen = ? WHERE extension = ?', [name, now, ext]);
      }
    },
    getAgent,
    listAgents: () => db.all('SELECT * FROM agents ORDER BY extension'),
    async setHeld(ext, held) {
      await repo.upsertAgent(ext, null);
      await db.run('UPDATE agents SET held = ?, held_since = ? WHERE extension = ?', [held ? 1 : 0, held ? repo.now() : null, ext]);
    },
    heldAgents: () => db.all('SELECT * FROM agents WHERE held = 1 ORDER BY extension'),
    async setPin(ext, pinHash) {
      await repo.upsertAgent(ext, null);
      const at = repo.now();
      await db.run('UPDATE agents SET pin_hash = ?, pin_set_at = ? WHERE extension = ?', [pinHash, pinHash ? at : null, ext]);
      return at;
    },
    async setAgentName(ext, name) {
      await repo.upsertAgent(ext, name);
      await db.run('UPDATE agents SET name = ? WHERE extension = ?', [name || null, ext]);
    },
    deleteAgent: (ext) => db.run('DELETE FROM agents WHERE extension = ?', [ext]),

    listDispositions: () => db.all('SELECT * FROM dispositions ORDER BY category, display_order, id'),
    async addDisposition({ category, name, requiresFollowUp = false, isConversion = false, isUnanswered = false, displayOrder = 0 }) {
      const now = repo.now();
      const r = await db.run(`INSERT INTO dispositions
        (category, name, requires_follow_up, is_conversion, is_unanswered, display_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [category.trim(), name.trim(), requiresFollowUp ? 1 : 0, isConversion ? 1 : 0, isUnanswered ? 1 : 0, Number(displayOrder) || 0, now]);
      return { id: r.insertId, category: category.trim(), name: name.trim(), requires_follow_up: requiresFollowUp ? 1 : 0 };
    },
    deleteDisposition: (id) => db.run('DELETE FROM dispositions WHERE id = ?', [Number(id)]),
    async seedDispositionsIfEmpty(catalog) {
      if (!catalog?.categories?.length) return;
      const countRow = await db.get('SELECT COUNT(*) AS count FROM dispositions');
      if (Number(countRow?.count || 0) > 0) return;
      const now = repo.now();
      for (const cat of catalog.categories) {
        for (let i = 0; i < (cat.outcomes || []).length; i++) {
          const o = cat.outcomes[i];
          try {
            await db.run(`INSERT INTO dispositions
              (category, name, requires_follow_up, is_conversion, is_unanswered, display_order, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [cat.name, o.name, o.requiresFollowUp ? 1 : 0, o.conversion ? 1 : 0, o.unanswered ? 1 : 0, i, now]);
          } catch {}
        }
      }
    },

    async stats({ todayStart, since, conversionOutcomes }) {
      const today = await db.get(`SELECT
          COUNT(*) AS total,
          COALESCE(SUM(status IN ('pending','completed','waived')), 0) AS needing,
          COALESCE(SUM(status = 'completed'), 0) AS done,
          COALESCE(SUM(status = 'pending'), 0) AS pending,
          COALESCE(SUM(status = 'waived'), 0) AS waived
        FROM calls WHERE started_at >= ?`, [todayStart]);

      const outcomes = await db.all(`SELECT category, disposition, COUNT(*) AS n FROM calls
        WHERE started_at >= ? AND disposition IS NOT NULL AND status = 'completed'
        GROUP BY category, disposition ORDER BY n DESC, disposition`, [since]);

      const conv = conversionOutcomes.length ? conversionOutcomes : ['__none__'];
      const agents = await db.all(`SELECT extension, MAX(agent_name) AS name,
          COUNT(*) AS calls,
          COALESCE(SUM(status = 'completed'), 0) AS dispositioned,
          COALESCE(SUM(status = 'pending'), 0) AS pending,
          COALESCE(SUM(status = 'waived'), 0) AS waived,
          COALESCE(SUM(status = 'completed' AND disposition IN (${conv.map(() => '?').join(',')})), 0) AS conversions,
          ROUND(AVG(CASE WHEN talk_seconds > 0 THEN talk_seconds END)) AS avg_talk
        FROM calls WHERE started_at >= ? AND status NOT IN ('not_required', 'active')
        GROUP BY extension ORDER BY extension`, [...conv, since]);

      const num = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]));
      return {
        today: num(today),
        outcomes: outcomes.map(num),
        agents: agents.map((a) => ({ ...num(a), avg_talk: a.avg_talk == null ? null : Math.round(Number(a.avg_talk)) })),
      };
    },
  };
  return repo;
}
