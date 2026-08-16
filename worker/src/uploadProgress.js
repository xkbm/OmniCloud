import { DurableObject } from 'cloudflare:workers';

export class UploadProgress extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ uploadId: new URL(request.url).searchParams.get('uploadId') || '' });

    server.send(JSON.stringify({ type: 'connected' }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    try {
      const payload = typeof message === 'string' ? JSON.parse(message) : null;
      if (!payload) return;

      if (payload.type === 'progress') {
        this.ctx.getWebSockets().forEach((socket) => {
          try {
            socket.send(JSON.stringify({
              type: 'progress',
              uploadId: payload.uploadId,
              uploaded: Number(payload.uploaded || 0),
              total: Number(payload.total || 0),
            }));
          } catch {}
        });
      }
    } catch {}
  }

  webSocketClose(ws) {
    try { ws.close(); } catch {}
  }
}
