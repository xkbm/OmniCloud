export async function onRequest(context) {
  const { request, env, params } = context;
  const apiOrigin = env.OMNICLOUD_API_ORIGIN;

  if (!apiOrigin) {
    return new Response('OMNICLOUD_API_ORIGIN is not configured', { status: 500 });
  }

  const path = Array.isArray(params.path) ? params.path.join('/') : '';
  const target = new URL(`/api/${path}`, apiOrigin);
  target.search = new URL(request.url).search;

  const headers = new Headers(request.headers);
  headers.delete('host');

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
  });

  const responseHeaders = new Headers(upstream.headers);
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
}
