import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { toWebStream, toNodeReadable } from '../src/storage/streams.js';

test('stream normalization accepts Web ReadableStream', async () => {
  const web = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hello'));
      controller.close();
    },
  });
  const normalizedWeb = toWebStream(web);
  assert.equal(typeof normalizedWeb.getReader, 'function');
  assert.equal(new TextDecoder().decode((await normalizedWeb.getReader().read()).value), 'hello');
});

test('stream normalization converts Node Readable to Web ReadableStream', async () => {
  const node = Readable.from([Buffer.from('hello')]);
  const web = toWebStream(node);
  assert.equal(typeof web.getReader, 'function');
  const reader = web.getReader();
  const chunk = await reader.read();
  assert.equal(new TextDecoder().decode(chunk.value), 'hello');
});

test('stream normalization converts Web ReadableStream to Node Readable', async () => {
  const web = Readable.toWeb(Readable.from([Buffer.from('hello')]));
  const node = toNodeReadable(web);
  const chunks = [];
  for await (const chunk of node) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString('utf8'), 'hello');
});
