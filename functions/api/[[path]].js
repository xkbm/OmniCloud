export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.OMNICLOUD_API) {
    return new Response('OMNICLOUD_API service binding is not configured', { status: 500 });
  }

  const path = Array.isArray(params.path) ? params.path.join('/') : '';
  const target = new URL(request.url);
  target.pathname = `/api/${path}`;

  const forwarded = new Request(target, request);
  return env.OMNICLOUD_API.fetch(forwarded);
}
