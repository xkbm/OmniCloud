import { neon } from '@neondatabase/serverless';

export function sql(env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  return neon(env.DATABASE_URL);
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
