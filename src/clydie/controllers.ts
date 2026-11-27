import {format, instructions, type Action, type Controller} from './protocol';

export function integer(name: string, n: number, min: number, max: number) {
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new RangeError(`${name} must be an integer in [${min}, ${max}].`);
  return n;
}

export function randomController(seed: number): Controller {
  integer('seed', seed, 0, 0x7fffffff);
  let state = seed;
  const draw = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const point = () => ({x: draw(), y: draw()});
  return {
    metadata: {type: 'random', policy: 'uniform-bouts-v1', seed},
    async decide(view) {
      let action: Action;
      const last = view.recent.at(-1);
      if (!last) state = seed;
      const p = draw();
      const active = last && ['beginTrace', 'beginDrag', 'move', 'mark'].includes(last.action.action)
        && !(last.action.action === 'beginDrag' && last.sense.outcome === 'rejected');
      if (active) {
        if (last?.sense.contact === 'intersection' && p < .25) action = {action: 'mark'};
        else if (p < .62) action = {action: 'move', at: point()};
        else action = {action: 'release'};
      } else if (p < .88) {
        action = {action: draw() < .5 ? 'beginTrace' : 'beginDrag', at: point()};
      } else action = {action: p < .94 ? 'flip' : 'unfold'};
      return {raw: JSON.stringify(action)};
    },
  };
}

export class ProviderError extends Error {
  constructor(message: string, readonly body: string, readonly truncated = false) { super(message); }
}

// Keep a bounded copy for diagnostics even when an Ollama-compatible server sends a broken envelope.
async function readBody(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const limit = 65536;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) return new Blob(chunks).text();
    chunks.push(new Uint8Array(value.subarray(0, limit - size)));
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new ProviderError('Ollama reply exceeds 64 KiB.', await new Blob(chunks).text(), true);
    }
  }
}

export function ollamaController(model: string, {
  endpoint = 'http://127.0.0.1:11434', seed = 1, temperature = .7, topP = .9, tokens = 128, context = 4096,
} = {}): Controller {
  if (!model.trim()) throw new Error('Choose an installed local model with --model.');
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Expected an HTTP model endpoint without credentials, query or fragment.');
  }
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2 || !Number.isFinite(topP) || topP <= 0 || topP > 1) {
    throw new Error('Expected temperature in [0, 2] and top-p in (0, 1].');
  }
  const options = {temperature, top_p: topP, seed: integer('seed', seed, 0, 0x7fffffff),
    num_predict: integer('tokens', tokens, 1, 512), num_ctx: integer('context', context, 512, 16384)};
  url.pathname = url.pathname.replace(/\/$/, '') + '/api/chat';
  return {
    metadata: {type: 'ollama', model, url: url.href, options, instructions, format},
    async decide(view, signal) {
      const messages = [{role: 'system', content: instructions}, {role: 'user', content: JSON.stringify(view)}];
      const response = await fetch(url, {method: 'POST', signal, redirect: 'error',
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({model, stream: false, messages, options, format})});
      const body = await readBody(response);
      if (!response.ok) {
        throw new ProviderError(`Ollama returned HTTP ${response.status} for ${model}. Check the endpoint and installed tag.`, body);
      }
      let reply;
      try { reply = JSON.parse(body); }
      catch { throw new ProviderError('Ollama returned invalid JSON.', body); }
      if (typeof reply?.message?.content !== 'string') throw new ProviderError('Ollama returned no message content.', body);
      return {raw: reply.message.content, generatedTokens: reply.eval_count};
    },
  };
}
