// The same LLMAdapter, against Ollama on localhost.
//
// Why this exists alongside the WebGPU adapter rather than replacing it:
// WebLLM puts the model in the browser, which is the stronger privacy claim
// and is still the roadmap. But it costs a 20 to 29 second cold load per
// browser profile, and every automated test paid that cost again, which made
// measuring stage 1 slow enough that it stopped being measured often.
//
// Ollama moves the model to a process on the same machine. The privacy claim
// is unchanged in substance, and it should be stated precisely: the sentence
// goes to localhost, not to the internet. What changes is that extraction
// becomes an HTTP call, so it can be tested from node in seconds without a
// browser or a GPU.
//
// The constraint is not weakened. Ollama's `format` takes a JSON Schema and
// compiles it to a GBNF grammar in llama.cpp, which masks the sampler the same
// way XGrammar masks it in the browser. A term outside the condition map's
// vocabulary is unreachable, not discouraged. The refusal contract is the
// same too: if the runtime will not take the schema, this throws
// UnconstrainedDecodeError rather than decoding without it.

import type { ChatMessage } from '../domain/narration';
import type { CompletionOpts, LLMAdapter, LLMStats } from './llm';
import { UnconstrainedDecodeError } from './llm';

/** Ollama on the same machine, for local development and the CLI harness. */
export const OLLAMA_HOST = 'http://localhost:11434';

/**
 * Ollama proxied on this origin, which is how the deployed Space serves it.
 *
 * Same-origin removes two problems at once: no CORS to negotiate, and no
 * mixed-content question from an HTTPS page. The server that answers this path
 * is deploy/space/server.mjs.
 */
export const OLLAMA_PROXY = '/ollama';

/**
 * Granite 4 micro, the same family as the WebGPU path's Granite 4.0 1B.
 *
 * Kept in the family deliberately: the extraction numbers in HANDOFF.md were
 * measured on Granite, and swapping to an unrelated model would have made the
 * before-and-after on the schema change uninterpretable.
 */
export const OLLAMA_MODEL = 'granite4:micro';

type OllamaChunk = {
  message?: { content?: string };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  prompt_eval_duration?: number;
  eval_duration?: number;
};

export class OllamaAdapter implements LLMAdapter {
  private _ready = false;
  private _lastStats: LLMStats | null = null;
  private _lastConstrained = false;

  /** Resolved by the probe. Empty until then. */
  private host = '';

  constructor(
    /** Pin a host explicitly. Omit to let the probe find one. */
    private hostOverride?: string,
    private model: string = OLLAMA_MODEL,
    /** Optional so the CLI harness can construct this outside the app. */
    private log?: { z2(url: string, description: string): void },
  ) {}

  /**
   * Where to look for a model, in order.
   *
   * On the Space the proxy answers and localhost does not. On a laptop it is
   * the other way round. Trying both means one build works in both places and
   * neither needs to know which one it is.
   */
  private candidates(): string[] {
    if (this.hostOverride) return [this.hostOverride];
    if (typeof window === 'undefined') return [OLLAMA_HOST];
    return [OLLAMA_PROXY, OLLAMA_HOST];
  }

  /** True when the model is answering on this origin rather than on localhost. */
  get isRemote(): boolean {
    return this.host === OLLAMA_PROXY;
  }

  get ready(): boolean { return this._ready; }
  getLastStats(): LLMStats | null { return this._lastStats; }
  wasLastConstrained(): boolean { return this._lastConstrained; }

  /**
   * Named probeWebGPU because the interface is, and the app's boot sequence
   * calls it to decide whether the model can run at all. Here it asks whether
   * Ollama is up and has the model, which is the same question.
   */
  async probeWebGPU(): Promise<{ ok: boolean; info: string }> {
    const tried: string[] = [];
    for (const host of this.candidates()) {
      try {
        const res = await fetch(`${host}/api/tags`);
        if (!res.ok) { tried.push(`${host} answered ${res.status}`); continue; }
        const body = (await res.json()) as { models?: Array<{ name: string }> };
        const names = (body.models ?? []).map((m) => m.name);
        if (!names.includes(this.model)) {
          tried.push(`${host} is up but ${this.model} is not pulled`);
          continue;
        }
        this.host = host;
        return {
          ok: true,
          info: host === OLLAMA_PROXY ? `${this.model}, on the server` : `${this.model}, on this machine`,
        };
      } catch (e) {
        tried.push(`${host}: ${(e as Error).message}`);
      }
    }
    return { ok: false, info: `no Ollama found. ${tried.join('; ')}` };
  }

  /**
   * Load the weights into Ollama's memory.
   *
   * An empty prompt tells Ollama to resident the model without generating, so
   * the first real query does not pay the load. Nothing is downloaded: a model
   * that is not already pulled fails the probe above before this runs.
   */
  async load(onProgress: (msg: string) => void): Promise<void> {
    if (!this.host) {
      const probe = await this.probeWebGPU();
      if (!probe.ok) throw new Error(probe.info);
    }
    onProgress(`Loading ${this.model}…`);
    // Named precisely, and differently depending on where the model actually
    // is. "Nothing leaves the browser" is true of the WebGPU path and false of
    // both of these; the log should not blur that, and the two are not the
    // same claim as each other either.
    this.log?.z2(
      `${this.host}/api/chat`,
      this.isRemote
        ? 'The typed sentence, to Granite 4 running on the server that hosts this app.'
        : 'The typed sentence, to Granite 4 in Ollama on this machine. Not the internet.',
    );
    const res = await fetch(`${this.host}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, keep_alive: '30m' }),
    });
    if (!res.ok) throw new Error(`Ollama could not load ${this.model}: ${res.status}`);
    await res.json();
    this._ready = true;
    onProgress('Ready');
  }

  async *completion(messages: ChatMessage[], opts?: CompletionOpts): AsyncIterable<string> {
    if (!this.host) {
      const probe = await this.probeWebGPU();
      if (!probe.ok) throw new UnconstrainedDecodeError(probe.info);
    }
    const request: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      keep_alive: '30m',
      options: {
        temperature: opts?.temperature ?? 0,
        num_predict: opts?.max_tokens ?? 256,
        ...(opts?.stop ? { stop: Array.isArray(opts.stop) ? opts.stop : [opts.stop] } : {}),
      },
    };

    if (opts?.schema) {
      // Ollama takes the schema as an object and compiles it to GBNF. The
      // schema travels as a string everywhere else in this codebase because
      // web-llm wants one, so it is parsed back here rather than kept twice.
      request.format = JSON.parse(opts.schema);
      this._lastConstrained = true;
    } else if (opts?.grammar) {
      // No GBNF passthrough in Ollama's chat API. Refusing is the contract:
      // decoding this unconstrained would look identical and be wrong.
      throw new UnconstrainedDecodeError('Ollama does not accept raw GBNF; pass a schema');
    } else {
      this._lastConstrained = false;
    }

    let res: Response;
    try {
      res = await fetch(`${this.host}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (e) {
      if (opts?.schema) {
        throw new UnconstrainedDecodeError(`Ollama unreachable: ${(e as Error).message}`);
      }
      throw e;
    }
    if (!res.ok || !res.body) {
      const detail = `${res.status} ${await res.text().catch(() => '')}`.trim();
      if (opts?.schema) {
        throw new UnconstrainedDecodeError(`Ollama rejected the constrained request: ${detail}`);
      }
      throw new Error(`Ollama error: ${detail}`);
    }

    // NDJSON: one JSON object per line, the last one carrying the timings.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const chunk = JSON.parse(line) as OllamaChunk;
        if (chunk.message?.content) yield chunk.message.content;
        if (chunk.done) this._lastStats = statsFrom(chunk);
      }
    }
  }
}

/** Ollama reports durations in nanoseconds. */
function statsFrom(c: OllamaChunk): LLMStats {
  const rate = (tokens: number, ns: number) => (ns > 0 ? tokens / (ns / 1e9) : 0);
  const prefill_tokens = c.prompt_eval_count ?? 0;
  const decode_tokens = c.eval_count ?? 0;
  const prefill_tokps = rate(prefill_tokens, c.prompt_eval_duration ?? 0);
  const decode_tokps = rate(decode_tokens, c.eval_duration ?? 0);
  return {
    prefill_tokens,
    decode_tokens,
    prefill_tokps,
    decode_tokps,
    raw: `prefill: ${prefill_tokens} tok, ${prefill_tokps.toFixed(1)} tok/s, ` +
      `decode: ${decode_tokens} tok, ${decode_tokps.toFixed(1)} tok/s`,
  };
}
