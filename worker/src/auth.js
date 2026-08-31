import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';

const PASSWORD_MIN_LENGTH = 8;
const SESSION_BYTES = 32;

// Cache the neon client at module level to avoid re-initialization on every request
let _authDbCache = null;

async function getSql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  
  // Reuse the same neon client across requests within the same Worker instance
  if (!_authDbCache || !_authDbCache._valid) {
    const { neon } = await import('@neondatabase/serverless');
    _authDbCache = neon(env.DATABASE_URL);
    _authDbCache._valid = true;
  }
  
  return _authDbCache;
}

function getAuthSecret(env) {
  if (!env.AUTH_SECRET) throw new Error('AUTH_SECRET is not configured');
  return env.AUTH_SECRET;
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, expectedHash] = storedHash.split(':');
  const actualHash = scryptSync(password, salt, 64).toString('hex');
  const expected = Buffer.from(expectedHash, 'hex');
  const actual = Buffer.from(actualHash, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sessionExpiry(hours) {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + Math.max(1, Number(hours || 336)));
  return expiresAt.toISOString();
}

function sessionHash(env, token) {
  return sha256(`omnicloud-session-v1:${getAuthSecret(env)}:${token}`);
}

export async function getUserByEmail(env, email) {
  const sql = await getSql(env);
  const normalizedEmail = normalizeEmail(email);
  const result = await sql`
    SELECT id, email, password_hash, is_local, created_at, updated_at
    FROM users
    WHERE email = ${normalizedEmail}
    LIMIT 1
  `;
  return result[0] || null;
}

export async function getUserBySession(env, token) {
  if (!token) return null;

  const sql = await getSql(env);
  const tokenHash = sessionHash(env, token);
  const result = await sql`
    SELECT u.id, u.email, u.password_hash, u.is_local, u.created_at, u.updated_at,
           s.id AS session_id, s.expires_at
    FROM auth_sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ${tokenHash}
    LIMIT 1
  `;

  const row = result[0];
  if (!row) return null;

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await sql`DELETE FROM auth_sessions WHERE id = ${row.session_id}`;
    return null;
  }

  await sql`
    UPDATE auth_sessions
    SET last_used_at = NOW()
    WHERE id = ${row.session_id}
  `;

  return row;
}

export function extractSessionToken(request, cookieName = '__Host-omnicloud_session') {
  const header = request.headers.get('Cookie') || '';
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function serializeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    isLocal: Boolean(user.is_local),
    createdAt: user.created_at,
  };
}

export function authSummary(env, user) {
  return {
    mode: env.APP_MODE || 'hosted',
    requiresAuth: true,
    authenticated: Boolean(user),
    user: serializeUser(user),
  };
}

export async function login(env, email, password) {
  if (env.APP_MODE !== 'hosted') throw new Error('Login is only available in hosted mode');

  const user = await getUserByEmail(env, email);
  if (!user || !verifyPassword(String(password || ''), user.password_hash)) {
    throw new Error('Invalid email or password');
  }

  const sql = await getSql(env);
  const token = randomBytes(SESSION_BYTES).toString('hex');
  const tokenHash = sessionHash(env, token);
  const sessionId = randomUUID();
  const expiresAt = sessionExpiry(env.AUTH_SESSION_TTL_HOURS);

  await sql`
    INSERT INTO auth_sessions (id, user_id, token_hash, expires_at)
    VALUES (${sessionId}, ${user.id}, ${tokenHash}, ${expiresAt})
  `;

  return { user, token, expiresAt };
}

export async function registerFirstUser(env, email, password) {
  if (env.APP_MODE !== 'hosted') throw new Error('Registration is only available in hosted mode');
  if (String(password || '').length < PASSWORD_MIN_LENGTH) throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);

  const sql = await getSql(env);
  const count = await sql`SELECT COUNT(*)::int AS total FROM users`;
  if ((count[0]?.total || 0) > 0) throw Object.assign(new Error('Registration is closed'), { status: 403 });

  const normalizedEmail = normalizeEmail(email);
  const existing = await sql`SELECT id FROM users WHERE email=${normalizedEmail} LIMIT 1`;
  if (existing.length) throw Object.assign(new Error('Email already in use'), { status: 409 });

  const userId = randomUUID();
  await sql`
    INSERT INTO users (id, email, password_hash, is_local)
    VALUES (${userId}, ${normalizedEmail}, ${hashPassword(password)}, TRUE)
  `;

  return login(env, normalizedEmail, password);
}

export async function logout(env, token) {
  if (!token) return;
  const sql = await getSql(env);
  const tokenHash = sessionHash(env, token);
  await sql`DELETE FROM auth_sessions WHERE token_hash = ${tokenHash}`;
}

export function authCookie(token, env, maxAgeSeconds) {
  const parts = [
    `${env.AUTH_COOKIE_NAME || '__Host-omnicloud_session'}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Secure',
  ];
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export { hashPassword };

export const PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;
