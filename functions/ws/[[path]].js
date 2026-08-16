export async function onRequest(context) {
  const { request, env, params } = context;
  if (!env.OMNICLOUD_API) {
    return new Response('OMNICLOUD_API service binding is not configured', { status: 500 });
  }

  const path = Array.isArray(params.path) ? params.path.join('/') : '';
  const url = new URL(request.url);
  const target = new URL(`/ws/${path}`, url.origin);
  target.search = url.search;

  const forwarded = new Request(target, request);
  return env.OMNICLOUD_API.fetch(forwarded);
}
