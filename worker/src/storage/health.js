const TRANSIENT_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 523, 524]);

export function classifyStorageHealthError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.$metadata?.httpStatusCode);
  if (status === 401 || status === 403) return 'reauth_required';
  if (status === 429) return 'degraded';
  if (TRANSIENT_STATUS_CODES.has(status)) return 'offline';

  const message = String(error?.message || '').toLowerCase();
  if (/timeout|timed out|network|socket|connection|fetch failed|dns|econn|etimedout/.test(message)) return 'offline';
  return 'degraded';
}

export function nextHealthState(currentStatus, failureCount, error) {
  const observed = classifyStorageHealthError(error);
  const nextFailureCount = Math.max(0, Number(failureCount) || 0) + 1;
  if (observed === 'reauth_required') return { status: 'reauth_required', failureCount: nextFailureCount };
  if (observed === 'degraded') return { status: 'degraded', failureCount: nextFailureCount };
  if (observed === 'offline') return { status: nextFailureCount >= 3 ? 'offline' : (currentStatus === 'offline' ? 'offline' : 'degraded'), failureCount: nextFailureCount };
  return { status: 'degraded', failureCount: nextFailureCount };
}

export function healthyResult() {
  return { status: 'healthy', failureCount: 0 };
}
