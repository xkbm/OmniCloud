import { requireUser, sql } from '../db.js';

export async function settingsRoutes(app) {
  app.get('/api/settings', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const rows = await db`
        SELECT key, value
        FROM user_settings
        WHERE user_id = ${user.id}
      `;
      return c.json({ data: Object.fromEntries(rows.map((row) => [row.key, row.value])) });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });

  app.patch('/api/settings', async (c) => {
    try {
      const user = await requireUser(c);
      const body = await c.req.json();
      const allowed = new Set(['language', 'theme']);
      const db = sql(c.env);
      const updated = {};

      for (const [key, value] of Object.entries(body || {})) {
        if (!allowed.has(key)) continue;
        await db`
          INSERT INTO user_settings (id, user_id, key, value, updated_at)
          VALUES (${crypto.randomUUID()}, ${user.id}, ${key}, ${String(value)}, NOW())
          ON CONFLICT (user_id, key) DO UPDATE
          SET value = EXCLUDED.value, updated_at = NOW()
        `;
        updated[key] = value;
      }

      return c.json({ data: updated });
    } catch (error) {
      return c.json({ error: error?.message || 'Request failed' }, error instanceof Response ? error.status : 400);
    }
  });
}
