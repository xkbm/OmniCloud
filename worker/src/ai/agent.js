import { normalizeVirtualPath } from '../utils/fileNames.js';

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_ITERATIONS = 8;
const MAX_CONTENT_LEN = 4000;

export const AI_SYSTEM_PROMPT = `Eres el asistente de IA de OmniCloud, un filesystem virtual unificado que reúne archivos de todos los servicios de almacenamiento conectados del usuario (Google Drive, Dropbox, OneDrive, S3, Mega, pCloud, Yandex, etc.). Para ti no existen servicios individuales: solo carpetas y archivos dentro de una única ruta virtual como /Musica/2026/cancion.mp3.

Reglas:
1. Responde siempre en el idioma del usuario (por defecto, español). Usa un tono natural y claro.
2. Para ver u organizar archivos usa SIEMPRE las herramientas disponibles, nunca inventes rutas ni archivos.
3. NUNCA borres ni muevas archivos sin confirmación explícita del usuario. Antes de borrar algo, pregunta y espera un "sí" inequívoco.
4. Para mover un archivo, primero comprueba (list_files) que la carpeta de destino existe; si no existe, propón crearla.
5. Si una operación falla, explica el error de forma comprensible y sugiere alternativas.
6. Sé conciso: 2-4 frases por respuesta salvo que el usuario pida más detalle.`;

export const AI_TOOL_DEFS = [
  {
    name: 'list_files',
    description: 'Lista los archivos y carpetas de una ruta virtual (por defecto la raíz "/").',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta virtual, p.ej. "/Musica" o "/" (raíz).' } },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Busca archivos y carpetas por nombre en todo el espacio de almacenamiento.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Texto a buscar en los nombres.' } },
      required: ['query'],
    },
  },
  {
    name: 'get_storage_summary',
    description: 'Resumen del espacio de almacenamiento: cuentas conectadas, espacio usado/disponible y recuento de archivos.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'create_folder',
    description: 'Crea una carpeta nueva en la ruta virtual indicada (crea también las carpetas intermedias si hacen falta).',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta completa de la carpeta nueva, p.ej. "/Musica/2026".' } },
      required: ['path'],
    },
  },
  {
    name: 'move_item',
    description: 'Mueve un archivo o carpeta a otra ruta virtual. OmniCloud resuelve automáticamente en qué servicio vive el archivo y lo mueve (incluso entre servicios distintos).',
    parameters: {
      type: 'object',
      properties: {
        source_path: { type: 'string', description: 'Ruta actual del archivo/carpeta, p.ej. "/Descargas/video.mp4".' },
        destination_path: { type: 'string', description: 'Ruta de la carpeta destino, p.ej. "/Videos" (no incluye el nombre del archivo).' },
      },
      required: ['source_path', 'destination_path'],
    },
  },
  {
    name: 'rename_item',
    description: 'Renombra un archivo o carpeta.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Ruta actual, p.ej. "/Documentos/borrador.txt".' },
        new_name: { type: 'string', description: 'Nuevo nombre, p.ej. "final.txt".' },
      },
      required: ['path', 'new_name'],
    },
  },
  {
    name: 'delete_item',
    description: 'Borra definitivamente un archivo o carpeta. IMPORTANTE: solo llama a esta herramienta después de que el usuario haya confirmado explícitamente que quiere borrar.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Ruta del archivo o carpeta a borrar.' } },
      required: ['path'],
    },
  },
];

function parentPathOf(path) {
  const trimmed = path.replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '/';
  const parts = trimmed.split('/');
  parts.pop();
  return parts.length ? `/${parts.join('/')}/` : '/';
}

async function resolveVirtualItem(db, userId, path) {
  const norm = normalizeVirtualPath(path);
  const bare = norm.replace(/\/+$/, '') || '/';
  const vf = await db`SELECT id FROM virtual_folders WHERE user_id=${userId} AND path=${norm} LIMIT 1`;
  if (vf[0]) return { type: 'vf', id: vf[0].id, path: norm };
  const fm = await db`SELECT id, is_folder FROM file_metadata WHERE user_id=${userId} AND virtual_path || file_name = ${bare} LIMIT 1`;
  if (fm[0]) return { type: 'fm', id: fm[0].id, path: bare };
  return null;
}

function compactRow(row) {
  return {
    name: row.file_name,
    is_folder: Boolean(row.is_folder),
    size: Number(row.size || 0),
    mime_type: row.mime_type || null,
    modified: row.remote_modified_time || row.updated_at || null,
  };
}

async function executeTool({ env, user, db, internalFetch }, name, args) {
  switch (name) {
    case 'list_files': {
      const path = normalizeVirtualPath(args.path || '/');
      const rows = await db`
        SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${user.id} AND fm.virtual_path = ${path} AND ca.status = 'active'
        ORDER BY fm.is_folder DESC, fm.file_name ASC
        LIMIT 100
      `;
      const vfs = await db`
        SELECT name FROM virtual_folders WHERE user_id = ${user.id} AND parent_path = ${path}
      `;
      const items = rows.map(compactRow);
      const existing = new Set(rows.map((r) => r.file_name));
      for (const vf of vfs) {
        if (!existing.has(vf.name)) items.push({ name: vf.name, is_folder: true, size: 0, mime_type: null, modified: null });
      }
      return { path, count: items.length, items: items.slice(0, 100) };
    }
    case 'search_files': {
      const query = String(args.query || '').trim().slice(0, 100);
      if (!query) return { error: 'La búsqueda no puede estar vacía' };
      const rows = await db`
        SELECT fm.file_name, fm.is_folder, fm.size, fm.mime_type, COALESCE(fm.remote_modified_time, fm.updated_at) AS modified, fm.virtual_path
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${user.id} AND ca.status = 'active' AND fm.file_name ILIKE ${`%${query}%`}
        ORDER BY fm.is_folder DESC, COALESCE(fm.remote_modified_time, fm.created_at) DESC, fm.file_name ASC
        LIMIT 30
      `;
      return { query, count: rows.length, items: rows.map((row) => ({ path: `${row.virtual_path}${row.file_name}`, ...compactRow(row) })) };
    }
    case 'get_storage_summary': {
      const accounts = await db`
        SELECT provider, email, status, total_space, used_space
        FROM cloud_accounts WHERE user_id = ${user.id}
        ORDER BY provider, email
      `;
      const stats = await db`
        SELECT ca.provider,
               COUNT(*) FILTER (WHERE fm.is_folder = FALSE) AS files,
               COALESCE(SUM(fm.size) FILTER (WHERE fm.is_folder = FALSE), 0)::bigint AS bytes
        FROM file_metadata fm
        JOIN cloud_accounts ca ON ca.id = fm.cloud_account_id
        WHERE fm.user_id = ${user.id} AND ca.status = 'active'
        GROUP BY ca.provider
        ORDER BY ca.provider
      `;
      return {
        accounts: accounts.map((a) => ({
          provider: a.provider,
          email: a.email,
          status: a.status,
          total_space: Number(a.total_space || 0),
          used_space: Number(a.used_space || 0),
        })),
        stats: stats.map((s) => ({ provider: s.provider, files: Number(s.files || 0), bytes: Number(s.bytes || 0) })),
      };
    }
    case 'create_folder': {
      const fullPath = normalizeVirtualPath(args.path || '');
      const name = fullPath.replace(/^\/+|\/+$/g, '').split('/').pop();
      if (!name) return { error: 'Ruta de carpeta no válida' };
      const parent = parentPathOf(fullPath);
      const { status, body } = await internalFetch('/api/files/folders', { method: 'POST', body: { name, virtual_path: parent } });
      if (status >= 400) return { error: body?.error || 'No se pudo crear la carpeta' };
      return { success: true, path: fullPath };
    }
    case 'move_item': {
      const item = await resolveVirtualItem(db, user.id, args.source_path);
      if (!item) return { error: 'No se encontró el archivo o carpeta de origen' };
      const dest = normalizeVirtualPath(args.destination_path);
      const { status, body } = await internalFetch(`/api/files/${item.id}/move`, { method: 'POST', body: { virtual_path: dest } });
      if (status >= 400) return { error: body?.error || 'No se pudo mover' };
      return { success: true, path: `${dest}${args.source_path.split('/').pop()}` };
    }
    case 'rename_item': {
      const item = await resolveVirtualItem(db, user.id, args.path);
      if (!item) return { error: 'No se encontró el archivo o carpeta' };
      const newName = String(args.new_name || '').trim();
      if (!newName) return { error: 'El nombre nuevo no puede estar vacío' };
      const { status, body } = await internalFetch(`/api/files/${item.id}/rename`, { method: 'PATCH', body: { name: newName } });
      if (status >= 400) return { error: body?.error || 'No se pudo renombrar' };
      return { success: true };
    }
    case 'delete_item': {
      const item = await resolveVirtualItem(db, user.id, args.path);
      if (!item) return { error: 'No se encontró el archivo o carpeta' };
      const { status, body } = await internalFetch(`/api/files/${item.id}`, { method: 'DELETE' });
      if (status >= 400) return { error: body?.error || 'No se pudo borrar' };
      return { success: true };
    }
    default:
      return { error: `Herramienta desconocida: ${name}` };
  }
}

async function geminiTurn({ env, model, contents, onEvent }) {
  const response = await fetch(`${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY },
    body: JSON.stringify({
      contents,
      systemInstruction: { parts: [{ text: AI_SYSTEM_PROMPT }] },
      tools: [{ functionDeclarations: AI_TOOL_DEFS }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    }),
  });

  if (!response.ok || !response.body) {
    let detail = '';
    try {
      const payload = await response.json();
      detail = payload?.error?.message || JSON.stringify(payload).slice(0, 500);
    } catch {}
    const error = new Error(`Error del proveedor de IA (${response.status}): ${detail || 'respuesta vacía'}`);
    error.code = response.status === 400 ? 'AI_BAD_REQUEST' : 'AI_PROVIDER_ERROR';
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let usage = null;
  const functionCalls = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload) continue;
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        continue;
      }
      if (data.error) {
        const error = new Error(`Error del proveedor de IA: ${data.error.message || 'desconocido'}`);
        error.code = 'AI_PROVIDER_ERROR';
        throw error;
      }
      if (data.usageMetadata) usage = data.usageMetadata;
      const parts = data.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.text) {
          text += part.text;
          onEvent({ type: 'text', delta: part.text });
        } else if (part.functionCall) {
          const call = part.functionCall;
          const existing = functionCalls.find((f) => f.name === call.name);
          if (existing && call.args && typeof call.args === 'object') {
            Object.assign(existing.args, call.args);
          } else {
            functionCalls.push({ name: call.name, args: call.args || {} });
          }
        }
      }
    }
  }

  return { text, functionCalls, usage };
}

export async function runAgent({ env, contents, onEvent, executeTool: toolExecutor }) {
  const model = env.AI_MODEL || 'gemini-3.5-flash-lite';
  let iterations = 0;
  let usage = null;

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const turn = await geminiTurn({ env, model, contents, onEvent });
    if (turn.usage) usage = turn.usage;

    contents.push({
      role: 'model',
      parts: turn.functionCalls.length
        ? turn.functionCalls.map((call) => ({ functionCall: call }))
        : [{ text: turn.text }],
    });

    if (!turn.functionCalls.length) {
      return { text: turn.text, toolCount: iterations - 1, usage };
    }

    const responses = [];
    for (const call of turn.functionCalls) {
      onEvent({ type: 'tool', name: call.name, status: 'running' });
      let result;
      try {
        result = { ok: true, ...(await toolExecutor(call.name, call.args)) };
      } catch (error) {
        result = { ok: false, error: error.message || 'Error de herramienta', code: error.code || 'TOOL_ERROR' };
      }
      onEvent({ type: 'tool', name: call.name, status: 'done', ok: Boolean(result.ok) });
      responses.push({ name: call.name, response: result });
    }

    contents.push({ role: 'user', parts: responses.map((r) => ({ functionResponse: { name: r.name, response: r.response } })) });
  }

  return { text: '', toolCount: MAX_ITERATIONS, usage, tooManyTools: true };
}

export function buildHistoryContents(messages) {
  const contents = [];
  for (const message of messages) {
    const role = message.role === 'assistant' ? 'model' : 'user';
    const content = String(message.content || '').slice(0, MAX_CONTENT_LEN);
    if (!content) continue;
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts[0].text += `\n${content}`;
    } else {
      contents.push({ role, parts: [{ text: content }] });
    }
  }
  return contents;
}

export { executeTool };
