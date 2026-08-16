import { DurableObject } from 'cloudflare:workers';

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

export class UploadProgress extends DurableObject {
  constructor(ctx) {
    super(ctx);
    this.ctx = ctx;
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/progress') {
      const payload = await request.json().catch(() => null);
      if (!payload) return new Response('Invalid progress payload', { status: 400 });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(JSON.stringify({ type: 'progress', ...payload })); } catch {}
      }
      return Response.json({ ok: true });
    }

    if (request.method === 'POST' && url.pathname === '/rate-limit/login') {
      const now = Date.now();
      const current = await this.ctx.storage.get('login-rate') || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      const windowOpen = current.resetAt > now;
      const next = windowOpen ? current : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      next.count += 1;
      await this.ctx.storage.put('login-rate', next);

      if (next.count > LOGIN_MAX_ATTEMPTS) {
        return Response.json({ allowed: false, retryAfter: Math.max(1, Math.ceil((next.resetAt - now) / 1000)) }, { status: 429 });
      }
      return Response.json({ allowed: true, remaining: Math.max(0, LOGIN_MAX_ATTEMPTS - next.count) });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uploadId: url.searchParams.get('uploadId') || '' });
    server.send(JSON.stringify({ type: 'connected' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === ws) continue;
      try { socket.send(message); } catch {}
    }
  }

  webSocketClose(ws) {
    try { ws.close(); } catch {}
  }
}
