/**
 * The Groq proxy core — one implementation, two hosts.
 *
 *   api/chat.ts     the deployed function (Vercel)
 *   vite.config.ts  the dev middleware, so `npm run dev` has the same route
 *
 * Why a proxy exists at all: the browser can only reach Groq by putting the key
 * in the bundle, and anything in the bundle is readable by anyone who opens
 * devtools. Holding the key here means the deployed page carries a model id and
 * nothing else — the same shape as a normal OpenAI-compatible app, where the
 * key lives on the server and the page only knows the URL.
 *
 * Two rules follow from that, and both are enforced below rather than left to
 * the caller:
 *
 *   1. The client never chooses the model. It posts `messages`, `tools` and
 *      sampling parameters; the model comes from the environment. Otherwise a
 *      public endpoint becomes a dial for whatever Groq account has capacity.
 *   2. The body is rebuilt field by field rather than forwarded. Groq ignores
 *      what it does not recognise, but "forwards whatever arrived" is how a
 *      proxy grows a second, undocumented API.
 *
 * The primary/fallback swap lives here too. It used to be in the client, which
 * meant every browser had to know which model ids Groq had retired this week —
 * and the fallback only worked for a build that already had the key. Here it
 * happens once, next to the key, and the page is told which model actually
 * answered via `x-king-model`.
 */

import { once } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'

/**
 * Both defaults are live ids from GET /openai/v1/models, checked rather than
 * remembered. Groq retires models without notice — `qwen-2.5-32b` was the
 * original fallback and is now "decommissioned and no longer supported" — so a
 * hardcoded id is a time bomb, and the fallback below is what turns that into a
 * footnote instead of an outage.
 */
const PRIMARY_MODEL = 'qwen/qwen3.8-27b'
const FALLBACK_MODEL = 'openai/gpt-oss-20b'

/** Generous enough for a long turn, small enough that one request cannot be a
 *  denial-of-service on somebody else's turn. */
const MAX_MESSAGES = 400
const MAX_TOOLS = 32
const MAX_BODY_BYTES = 1_000_000

const MESSAGE_KEYS = new Set(['role', 'content', 'tool_call_id', 'tool_calls'])
const TOOL_CHOICES = new Set(['auto', 'none', 'required'])

export type ProxyEnv = {
  apiKey: string | undefined
  primary: string
  fallback: string
}

type Problem = { error: string }

const isProblem = (v: unknown): v is Problem =>
  !!v && typeof v === 'object' && typeof (v as Problem).error === 'string'

function clean(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * Read the environment for both hosts. Vercel hands us `process.env` with the
 * project's own settings already in it; the dev middleware hands us what
 * `loadEnv()` returned from `.env` / `.env.local`. Either way the bare
 * `GROQ_*` names win over the `VITE_GROQ_*` ones, because on a deployed site
 * only the bare names are configured — `VITE_*` exists purely so a local
 * `.env.local` can override without editing code.
 */
export function readProxyEnv(raw: Record<string, string | undefined>): ProxyEnv {
  return {
    apiKey: clean(raw.GROQ_API_KEY) ?? clean(raw.VITE_GROQ_API_KEY),
    primary: clean(raw.GROQ_MODEL) ?? clean(raw.VITE_GROQ_MODEL) ?? PRIMARY_MODEL,
    fallback:
      clean(raw.GROQ_MODEL_FALLBACK) ?? clean(raw.VITE_GROQ_MODEL_FALLBACK) ?? FALLBACK_MODEL,
  }
}

/**
 * What `GET /api/chat` answers. Deliberately 200 either way: the page is
 * asking "are you there, and is a key configured?", and an unconfigured key is
 * an answer rather than a fault. Only a network failure throws, which the
 * client swallows.
 */
export function healthReport(env: ProxyEnv): { ok: boolean; hasKey: boolean } {
  return { ok: true, hasKey: !!env.apiKey }
}

/**
 * Cross-origin gate.
 *
 * The endpoint is unauthenticated by design — a public page cannot hold a
 * secret — so the cheapest thing standing between this and somebody else's
 * website spending the key is the `Origin` a browser is required to send. A
 * same-origin POST carries the page's own host and passes; a POST from
 * `evil.example` carries that host and is refused. No `Origin` at all (curl,
 * an older browser's same-origin POST) passes, because there is nothing to
 * contradict and this is not authentication.
 */
export function originAllowed(
  origin: string | string[] | undefined,
  host: string | string[] | undefined,
): boolean {
  const value = Array.isArray(origin) ? origin[0] : origin
  if (!value) return true
  if (value === 'null') return false

  let originHost: string
  try {
    originHost = new URL(value).host
  } catch {
    return false
  }

  const requestHost = (Array.isArray(host) ? host[0] : host)?.toLowerCase()
  return !!requestHost && originHost === requestHost
}

/**
 * Rebuild the request from the fields we actually use.
 *
 * Returned as `{ error }` rather than thrown so both hosts can turn it into a
 * 400 with the same shape the client already parses.
 */
export function parseChatRequest(body: unknown): Record<string, unknown> | Problem {
  if (!isPlainObject(body)) return { error: 'Body must be a JSON object.' }

  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return { error: '`messages` must be a non-empty array.' }
  }
  if (messages.length > MAX_MESSAGES) {
    return { error: `\`messages\` is limited to ${MAX_MESSAGES} entries.` }
  }

  const cleanedMessages: Record<string, unknown>[] = []
  for (const message of messages) {
    if (!isPlainObject(message) || typeof message.role !== 'string') {
      return { error: 'Every message needs a string `role`.' }
    }
    const cleaned: Record<string, unknown> = {}
    for (const key of Object.keys(message)) {
      if (MESSAGE_KEYS.has(key)) cleaned[key] = message[key]
    }
    cleanedMessages.push(cleaned)
  }

  const tools = cleanTools(body.tools)
  if (tools === null) return { error: '`tools` must be an array of function declarations.' }

  const request: Record<string, unknown> = {
    messages: cleanedMessages,
    // Never false unless the client asked for it: a streamed answer is what
    // makes the reply feel spoken, and a non-streaming one changes the wire
    // format the client parses.
    stream: body.stream !== false,
    temperature: clampNumber(body.temperature, 0, 2, 0.6),
    max_tokens: Math.round(clampNumber(body.max_tokens, 1, 16384, 400)),
  }
  // `tool_choice` only makes sense alongside `tools`; Groq rejects one without
  // the other, and a request that offered no tools has no choice to prefer.
  if (tools && tools.length > 0) {
    request.tools = tools
    request.tool_choice = cleanToolChoice(body.tool_choice)
  }
  return request
}

/**
 * Tool declarations are the one place where an unvalidated field reaches a
 * model. Name and parameters are kept, description is trimmed, and anything
 * that is not a function declaration is dropped rather than passed through.
 * Returns `null` only when the value is present and is not an array — that is
 * a malformed request, distinct from "no tools offered".
 */
function cleanTools(value: unknown): Record<string, unknown>[] | null {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  return value.slice(0, MAX_TOOLS).flatMap((tool) => {
    if (!isPlainObject(tool)) return []
    const fn = tool.function
    if (!isPlainObject(fn) || typeof fn.name !== 'string' || fn.name.length === 0) return []
    const parameters = isPlainObject(fn.parameters)
      ? fn.parameters
      : { type: 'object', properties: {} }
    return [
      {
        type: 'function',
        function: {
          name: fn.name.slice(0, 64),
          ...(typeof fn.description === 'string'
            ? { description: fn.description.slice(0, 4000) }
            : {}),
          parameters,
        },
      },
    ]
  })
}

function cleanToolChoice(value: unknown): unknown {
  if (typeof value === 'string' && TOOL_CHOICES.has(value)) return value
  if (isPlainObject(value)) {
    const fn = value.function
    if (isPlainObject(fn) && typeof fn.name === 'string') {
      return { type: 'function', function: { name: fn.name } }
    }
  }
  return 'auto'
}

/** Groq answers 404 for a removed id, and 400/410 with the reason in prose
 *  rather than a code — hence the text as well as the status. */
function isModelUnavailable(status: number, text: string): boolean {
  if (status === 404 || status === 410) return true
  return /model_not_found|model.{0,20}not (found|supported|available)|does not exist|unknown model|decommissioned|invalid model id/i.test(
    text,
  )
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

async function send(
  env: ProxyEnv,
  model: string,
  request: Record<string, unknown>,
): Promise<Response> {
  return fetch(GROQ_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model, ...request }),
  })
}

/**
 * One call, with the fallback decided here rather than by the page.
 *
 * The first attempt is always the primary. A second attempt happens only when
 * the first failed *because the model is gone* — a rate limit or a malformed
 * request would fail identically on the fallback, and retrying it would only
 * double the wait before the same error. The model that finally answered is
 * carried in `x-king-model`, and `x-king-fallback: 1` says it was not the one
 * that was asked for, which is the only case worth showing to a person.
 */
export async function proxyChat(env: ProxyEnv, body: unknown): Promise<Response> {
  if (!env.apiKey) {
    return jsonError(500, 'GROQ_API_KEY is not configured for this deployment.')
  }

  // `readJsonBody` reports a malformed or oversized body as `{ error }` too,
  // so that message survives instead of being flattened into "not an object".
  if (isProblem(body)) return jsonError(400, body.error)

  const request = parseChatRequest(body)
  if (isProblem(request)) return jsonError(400, request.error)

  const attempts = env.fallback && env.fallback !== env.primary
    ? [env.primary, env.fallback]
    : [env.primary]

  let lastStatus = 502
  let lastMessage = 'Groq did not answer.'

  for (let i = 0; i < attempts.length; i++) {
    const model = attempts[i]
    const upstream = await send(env, model, request)

    if (upstream.ok) {
      const headers = new Headers({
        'content-type':
          upstream.headers.get('content-type') ??
          (request.stream ? 'text/event-stream' : 'application/json'),
        'cache-control': 'no-store',
        'x-king-model': model,
      })
      if (i > 0) headers.set('x-king-fallback', '1')
      return new Response(upstream.body, { status: 200, headers })
    }

    const text = await upstream.text()
    lastStatus = upstream.status
    lastMessage = extractMessage(text) ?? `Groq API error (${upstream.status})`
    if (i + 1 >= attempts.length || !isModelUnavailable(upstream.status, text)) break
  }

  // Upstream errors are already `{ error: { message } }`, but a proxy that can
  // emit any other shape makes every client write two error paths. One shape,
  // always.
  return jsonError(lastStatus >= 400 && lastStatus < 600 ? lastStatus : 502, lastMessage)
}

function extractMessage(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text)
    const message = parsed?.error?.message
    if (typeof message === 'string' && message.trim()) return message
  } catch {
    // Not JSON — fall through to the caller's generic wording.
  }
  return text.trim().slice(0, 500) || undefined
}

/**
 * Read a JSON body off a plain Node request. The Vercel function never needs
 * this — its `req.body` is already parsed — but the dev middleware runs before
 * anything has looked at the body, so the two hosts differ at exactly this
 * point and nowhere else.
 */
export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      req.destroy()
      return { error: `Body exceeds ${MAX_BODY_BYTES} bytes.` }
    }
    chunks.push(chunk)
  }
  if (chunks.length === 0) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return { error: 'Body is not valid JSON.' }
  }
}

/**
 * Web `Response` → Node `ServerResponse`, streaming.
 *
 * Written as a pipe rather than buffered, because the whole point of
 * `stream: true` is that the first token reaches the screen while the model is
 * still writing the last one. The backpressure branch matters more than it
 * looks: without it a fast model outruns the socket and the process buffers
 * the difference in memory. Racing `drain` against `close` is what keeps a
 * client that hangs up mid-sentence from leaving the handler waiting for a
 * drain event that will never come.
 */
export async function pipeToNode(web: Response, res: ServerResponse): Promise<void> {
  const headers: Record<string, string> = {}
  web.headers.forEach((value, key) => {
    headers[key] = value
  })

  res.writeHead(web.status, headers)

  if (!web.body) {
    res.end()
    return
  }

  const reader = web.body.getReader()
  const onClientGone = () => {
    void reader.cancel().catch(() => {})
  }
  res.once('close', onClientGone)

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      if (!res.write(value)) {
        await Promise.race([once(res, 'drain'), once(res, 'close')])
        if (res.destroyed || res.writableEnded) break
      }
    }
    res.end()
  } catch {
    // The upstream stream broke, or the client vanished. Either way there is
    // nothing left to write — the reader has already been cancelled, and a
    // half-answer that stops is better than a handler that hangs.
    if (!res.writableEnded) res.end()
  } finally {
    res.off('close', onClientGone)
  }
}

/** The health answer and the 404 a plain static host gives instead of the
 *  function, written once so both hosts answer identically. */
export function simpleJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}
