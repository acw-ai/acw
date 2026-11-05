import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const COOKIE = 'acw_session';
const SCRYPT = { N: 16384, r: 8, p: 1 };

// ---- PINs ----------------------------------------------------------------------
export async function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(pin), salt, 32, SCRYPT);
  return `scrypt$${SCRYPT.N}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPin(pin, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') {
    await scrypt(String(pin), 'no-pin-set', 32, SCRYPT); // same timing whether or not a PIN exists
    return false;
  }
  const key = await scrypt(String(pin), Buffer.from(parts[2], 'base64url'), 32, { ...SCRYPT, N: Number(parts[1]) });
  const want = Buffer.from(parts[3], 'base64url');
  return want.length === key.length && crypto.timingSafeEqual(want, key);
}

export function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---- Signed session cookie -----------------------------------------------------
export function createSessions({ secret, hours, secure, cookieName = COOKIE }) {
  const key = secret || crypto.randomBytes(32).toString('hex');
  const maxAge = Math.round(hours * 3600);
  const sign = (data) => crypto.createHmac('sha256', key).update(data).digest('base64url');
  const cookie = (value, age) => {
    const exp = age === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0' : `; Max-Age=${age}`;
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax${exp}${secure ? '; Secure' : ''}`;
  };

  return {
    generatedSecret: !secret,
    cookieName,
    issue(res, payload) {
      const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + maxAge * 1000 })).toString('base64url');
      res.setHeader('Set-Cookie', cookie(`${body}.${sign(body)}`, maxAge));
    },
    clear(res) {
      res.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0${secure ? '; Secure' : ''}`);
    },
    read(req) {
      const raw = (req.headers.cookie || '').split(/;\s*/).find((c) => c.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
      if (!raw) return null;
      const [body, sig] = raw.split('.');
      if (!body || !sig) return null;
      const expected = sign(body);
      if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
      try {
        const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
        return payload.exp > Date.now() ? payload : null;
      } catch {
        return null;
      }
    },
  };
}

// ---- Brute-force protection ----------------------------------------------------
export function createLoginLimiter({ maxFailures, lockMinutes }) {
  const entries = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of entries) if ((e.until || e.first + lockMinutes * 60_000) < now) entries.delete(k);
  }, 60_000).unref();

  return {
    lockedMinutes(key) {
      const e = entries.get(key);
      return e?.until && e.until > Date.now() ? Math.ceil((e.until - Date.now()) / 60_000) : 0;
    },
    fail(key) {
      const e = entries.get(key) || { n: 0, first: Date.now() };
      e.n++;
      if (e.n >= maxFailures) e.until = Date.now() + lockMinutes * 60_000;
      entries.set(key, e);
    },
    reset(key) { entries.delete(key); },
  };
}
