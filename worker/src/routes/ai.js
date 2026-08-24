import { requireUser, sql } from '../db.js';
import { runAgent, executeTool } from '../ai/agent.js';

const AI_MIN_MESSAGES = 10;
const AI_MIN_WINDOW_MS = 60 * 1000;
const AI_DAY_MESSAGES = 60;
const AI_DAY_WINDOW_MS = 24 * 60 * 60 * 1000;

function errorResponse(c, error, fallback = 'AI request failed', code = 'AI_REQUEST_FAILED') {
  if (error instanceof Response) return error;
  const message = error?.message || fallback;
  return c.json({ error: message, code }, /Authentication required/i.test(message) ? 401 : 500);
}

async function enforceAiRateLimit(c, user) {
  if (!c.env.UPLOAD_PROGRESS) return null;
  const stub = c.env.UPLOAD_PROGRESS.get(c.env.UPLOAD_PROGRESS.idFromName(`ai-rate:${user.id}`));
  const buckets = [
    { bucket: 'min', limit: AI_MIN_MESSAGES, window: AI_MIN_WINDOW_MS },
    { bucket: 'day', limit: AI_DAY_MESSAGES, window: AI_DAY_WINDOW_MS },
  ];
  for (const entry of buckets) {
    const response = await stub.fetch(
      `https://rate-limit/rate-limit/ai?bucket=${entry.bucket}&limit=${entry.limit}&window=${entry.window}`,
      { method: 'POST' },
    );
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After') || '60';
      return c.json({ error: 'Has llegado al límite de mensajes del asistente. Inténtalo más tarde.', code: 'AI_RATE_LIMITED' }, 429, { 'Retry-After': retryAfter });
    }
    if (!response.ok) return c.json({ error: 'Rate limiter unavailable', code: 'RATE_LIMITER_UNAVAILABLE' }, 503);
  }
  return null;
}

export async function aiRoutes(app) {
  app.post('/api/ai/chat', async (c) => {
    try {
      const user = await requireUser(c);
      const db = sql(c.env);
      const body = await c.req.json().catch(() => ({}));
      const message = String(body.message || '').trim();
      if (!message) return c.json({ error: 'El mensaje no puede estar vacío', code: 'AI_MESSAGE_REQUIRED' }, 400);
      if (message.length > 8000) return c.json({ error: 'El mensaje es demasiado largo (máx. 8000 caracteres)', code: 'AI_MESSAGE_TOO_LONG' }, 400);

      const rateLimitResponse = await enforceAiRateLimit(c, user);
      if (rateLimitResponse) return rateLimitResponse;

      if (!c.env.GEMINI_API_KEY) {
        return c.json({ error: 'El asistente de IA no está configurado en el servidor.', code: 'AI_NOT_CONFIGURED' }, 503);
      }

      const userMsg = { id: crypto.randomUUID(), created_at: new Date().toISOString() };

      const cookie = c.req.header('cookie') || '';
      const internalFetch = async (path, options = {}) => {
        const request = new Request(`https://internal${path}`, {
          method: options.method || 'GET',
          headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { cookie } : {}),
          },
          body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        });
        const response = await app.fetch(request, c.env, c.executionCtx);
        let payload = null;
        try {
          payload = await response.json();
        } catch {}
        return { status: response.status, body: payload };
      };

      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        async start(controller) {
          const send = (event) => {
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            } catch {}
          };
          try {
            send({ type: 'message', id: userMsg.id, created_at: userMsg.created_at });

            const contents = [{ role: 'user', parts: [{ text: message }] }];

            const result = await runAgent({
              env: c.env,
              contents,
              onEvent: send,
              executeTool: (name, args) => executeTool({ env: c.env, user, db, internalFetch }, name, args),
            });

            const finalText = (result.text || '').trim();
            if (!finalText) {
              send({ type: 'text', delta: result.tooManyTools ? 'No pude completar la acción en este intento. Vuelve a pedírmelo de forma más concreta.' : 'Hecho.' });
            }
            send({ type: 'done', toolCount: result.toolCount, usage: result.usage });
          } catch (error) {
            console.error('[ai] chat stream failed:', error);
            send({ type: 'error', message: error.message || 'Error inesperado del asistente', code: error.code || 'AI_ERROR' });
          } finally {
            try {
              controller.close();
            } catch {}
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-store',
          'X-Accel-Buffering': 'no',
        },
      });
    } catch (error) {
      console.error('[ai] chat route failed:', error);
      return errorResponse(c, error, 'El asistente de IA falló', 'AI_ERROR');
    }
  });
}
