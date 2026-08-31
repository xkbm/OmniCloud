import { neon } from '@neondatabase/serverless';

// Global connection cache for the Worker instance lifetime
// This avoids creating new HTTP connections on every request
let _dbCache = null;

export function sql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  
  // Reuse the same neon client across requests within the same Worker instance
  // Neon's client is already optimized for serverless, but caching at the
  // module level reduces initialization overhead
  if (!_dbCache || !_dbCache._valid) {
    _dbCache = neon(env.DATABASE_URL);
    _dbCache._valid = true;
  }
  
  return _dbCache;
}

export async function requireUser(c) {
  const user = c.get('user');
  if (!user) throw new Response(JSON.stringify({ error: 'Authentication required' }), {
    status: 401,
    headers: { 'Content-Type': 'application/json' },
  });
  return user;
}

export function jsonError(error) {
  if (error instanceof Response) return error;
  const message = error?.message || 'Request failed';
  const status = /Authentication required/i.test(message) ? 401 : 400;
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
