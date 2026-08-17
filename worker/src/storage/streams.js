import { Readable } from 'node:stream';

export function toWebStream(body) {
  if (!body) return null;
  if (body instanceof Response) return body.body;
  if (typeof body.getReader === 'function') return body;
  if (typeof body.pipe === 'function') {
    return Readable.toWeb(body);
  }
  throw new TypeError('Unsupported storage stream type');
}

export function toNodeReadable(body) {
  if (!body) return null;
  if (typeof body.getReader === 'function') return Readable.fromWeb(body);
  if (typeof body.pipe === 'function') return body;
  throw new TypeError('Unsupported storage stream type');
}
