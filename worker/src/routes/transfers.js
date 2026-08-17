import { Hono } from 'hono';
import { requireUser } from '../db.js';
import { getTransferJob, updateTransferJob } from '../storage/jobs.js';
import { releaseStorageReservation } from '../storage/service.js';

export async function transferRoutes(app) {
  const routes = new Hono();

  routes.get('/api/transfers/:id', async (c) => {
    const user = await requireUser(c);
    const job = await getTransferJob(c.env, user.id, c.req.param('id'));
    if (!job) return c.json({ error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' }, 404);
    return c.json({ data: job });
  });

  routes.get('/api/transfers', async (c) => {
    const user = await requireUser(c);
    const limit = Math.min(100, Math.max(1, Number(c.req.query('limit') || 25)));
    const db = (await import('../db.js')).sql(c.env);
    const rows = await db`
      SELECT *
      FROM transfer_jobs
      WHERE user_id=${user.id}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return c.json({ data: rows });
  });

  routes.post('/api/transfers/:id/cancel', async (c) => {
    const user = await requireUser(c);
    const job = await getTransferJob(c.env, user.id, c.req.param('id'));
    if (!job) return c.json({ error: 'Transfer not found', code: 'TRANSFER_NOT_FOUND' }, 404);
    if (!['queued', 'paused'].includes(job.status)) {
      return c.json({ error: 'Transfer cannot be cancelled in its current state', code: 'TRANSFER_NOT_CANCELLABLE' }, 409);
    }

    const reservationId = job.payload?.reservationId || null;
    if (reservationId) await releaseStorageReservation(c.env, reservationId, user.id);

    const updated = await updateTransferJob(c.env, user.id, job.id, {
      status: 'cancelled',
      payload: { cancelRequestedAt: new Date().toISOString(), reservationReleased: Boolean(reservationId) },
    });
    return c.json({ data: updated });
  });

  app.route('/', routes);
}
