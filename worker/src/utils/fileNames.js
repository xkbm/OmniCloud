const CONTROL_CHARS = /[\u0000-\u001F\u007F]/g;

export function sanitizeFileName(input, { fallback = 'untitled', maxLength = 255 } = {}) {
  const raw = String(input ?? '').trim();
  const basename = raw.replace(/^.*[\\/]/, '');
  const cleaned = basename
    .replace(CONTROL_CHARS, '')
    .replace(/[\\/]/g, '')
    .trim()
    .slice(0, maxLength);

  if (!cleaned || cleaned === '.' || cleaned === '..') return fallback;
  return cleaned;
}

export function normalizeVirtualPath(input = '/') {
  if (!input || input === '/') return '/';
  const clean = String(input)
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\/+/, '/')
    .replace(/\0/g, '')
    .trim();
  if (!clean || clean === '/') return '/';
  return clean.endsWith('/') ? clean : `${clean}/`;
}
