const TRANSIENT_STATUS_CODES = new Set([429, 502, 503, 504]);

export function isTransientStorageError(error) {
  if (!error) return false;
  if (error.code === 'STORAGE_TRANSIENT') return true;
  return TRANSIENT_STATUS_CODES.has(Number(error.status));
}

export function toTransientStorageError(error, fallback = 'Storage provider temporarily unavailable') {
  if (error?.code === 'STORAGE_TRANSIENT') return error;
  if (!isTransientStorageError(error)) return error;
  const wrapped = new Error(fallback);
  wrapped.code = 'STORAGE_TRANSIENT';
  wrapped.status = 503;
  wrapped.cause = error;
  return wrapped;
}
