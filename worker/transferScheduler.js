import { DurableObject } from 'cloudflare:workers';
import { claimNextTransferJob, hasQueuedTransferJobs } from './src/storage/jobs.js';
import { runTransferJob, failTransferJob } from './src/storage/runner.js';

const ALARM_DELAY_MS = 1000;

export class TransferScheduler extends DurableObject {
  constructor(state, env) {
    super(state, env);
    this.ctx = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/schedule') {
      const payload = await request.json().catch(() => ({}));
      await this.ctx.storage.put('lastJobId', payload?.jobId || null);
      await this.ctx.storage.setAlarm(Date.now() + 25);
      return Response.json({ ok: true });
    }
    if (request.method === 'GET' && url.pathname === '/status') {
      return Response.json({ ok: true, alarm: await this.ctx.storage.getAlarm(), lastJobId: await this.ctx.storage.get('lastJobId') });
    }
    return new Response('Not found', { status: 404 });
  }

  async alarm() {
    const job = await claimNextTransferJob(this.env);
    if (!job) return;

    try {
      await runTransferJob(this.env, job);
    } catch (error) {
      console.error('[transfer-scheduler] job failed:', error);
      await failTransferJob(this.env, job, error);
    }

    if (await hasQueuedTransferJobs(this.env)) {
      await this.ctx.storage.setAlarm(Date.now() + ALARM_DELAY_MS);
    }
  }
}
