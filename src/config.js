import path from 'node:path';
import { fileURLToPath } from 'node:url';

const env = process.env;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : /^(1|true|yes|on)$/i.test(value.trim());
const list = (value) => (value || '').split(',').map((s) => s.trim()).filter(Boolean);
const simulate = process.argv.includes('--simulate') || bool(env.SIMULATE, false);

export const config = {
  port: Number(env.PORT || 3100),
  host: env.HOST || '127.0.0.1',
  simulate,

  brand: {
    name: env.BRAND_NAME || 'ACW',
    subtitle: env.BRAND_SUBTITLE || 'After-Call Work & PBX Intelligence',
  },

  db: {
    driver: (env.DB_DRIVER || 'sqlite').toLowerCase() === 'mysql' ? 'mysql' : 'sqlite',
    autoMigrate: bool(env.DB_AUTO_MIGRATE, true),
    sqlitePath: path.resolve(ROOT, env.DB_PATH || (simulate ? 'data/simulator.db' : 'data/acw.db')),
    mysql: {
      host: env.MYSQL_HOST || '127.0.0.1',
      port: Number(env.MYSQL_PORT || 3306),
      user: env.MYSQL_USER || 'acw_user',
      password: env.MYSQL_PASSWORD || '',
      database: env.MYSQL_DATABASE || 'acw_db',
    },
  },

  pbx: {
    baseUrl: (env.PBX_URL || '').trim().replace(/\/+$/, ''),
    clientId: (env.PBX_CLIENT_ID || '').trim(),
    clientSecret: (env.PBX_CLIENT_SECRET || '').trim(),
  },

  webhook: {
    url: (env.WEBHOOK_URL || '').trim(),
    secret: env.WEBHOOK_SECRET || '',
  },

  crm: {
    screenpopUrl: (env.CRM_SCREENPOP_URL || '').trim(), // e.g. "https://app.hubspot.com/contacts/123/search?query={PHONE}"
  },

  ai: {
    provider: (env.AI_PROVIDER || 'none').toLowerCase(), // 'openai', 'ollama', or 'none'
    apiKey: env.OPENAI_API_KEY || '',
    model: env.AI_MODEL || (env.AI_PROVIDER === 'ollama' ? 'llama3.2' : 'gpt-4o-mini'),
    ollamaUrl: env.OLLAMA_URL || 'http://localhost:11434',
  },

  monitoredExtensions: list(env.MONITORED_EXTENSIONS),
  enforce: bool(env.ENFORCE_DISPOSITION, true),
  requireUnansweredOutbound: bool(env.REQUIRE_UNANSWERED_OUTBOUND, true),
  skipInternal: bool(env.SKIP_INTERNAL_CALLS, true),
  internalNumberMaxLength: Number(env.INTERNAL_NUMBER_MAX_LENGTH || 4),
  guardIntervalMs: Math.max(5000, Number(env.GUARD_INTERVAL_MS || 20000)),

  auth: {
    sessionSecret: env.SESSION_SECRET || '',
    supervisorPassword: env.SUPERVISOR_PASSWORD || (simulate ? 'admin' : ''),
    sessionHours: Math.max(1, Number(env.SESSION_HOURS || 12)),
    cookieSecure: bool(env.COOKIE_SECURE, false),
  },
};
