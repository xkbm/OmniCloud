import { DurableObject } from 'cloudflare:workers';

export class UploadProgress extends DurableObject {
  constructor(ctx) {
    super(ctx);
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.method === 'POST' && new URL(request.url).pathname === '/progress') {
      const payload = await request.json().catch(() => null);
      if (!payload) return new Response('Invalid progress payload', { status: 400 });
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send(JSON.stringify({ type: 'progress', ...payload })); } catch {}
      }
      return Response.json({ ok: true });
    }

    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uploadId: new URL(request.url).searchParams.get('uploadId') || '' });
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
