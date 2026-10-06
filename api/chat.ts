/**
 * The Groq proxy, deployed as a Vercel function.
 *
 * The page posts here instead of to Groq, so `GROQ_API_KEY` never has to be
 * named `VITE_GROQ_API_KEY` and therefore never enters the bundle. Set the key
 * in the Vercel project's environment variables and it stays on this side of
 * the request.
 *
 * Vercel turns every file in `api/` into an endpoint, which is why the shared
 * implementation lives one directory up in `server/groqProxy.ts` — `api/` holds
 * hosts, `server/` holds the logic they share with the dev middleware. Keeping
 * them apart is what stops the two from drifting into subtly different proxies
 * that behave differently in development and in production.
 *
 *   GET  /api/chat  → { ok: true, hasKey: boolean }   a key probe, not a test
 *   POST /api/chat  → the Groq response, streamed through
 */

import type { ServerResponse } from 'node:http'
import {
  healthReport,
  originAllowed,
  pipeToNode,
  proxyChat,
  readProxyEnv,
  simpleJson,
} from '../server/groqProxy.ts'

/**
 * A local shape rather than `@vercel/node`. The package would only ever be
 * used for these two properties, and adding a dependency to describe a
 * function that is already typed by this file is how types start to drift
 * from the code they describe.
 */
type HandlerRequest = {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

/**
 * Vercel parses `application/json` into `req.body` before we see it. The
 * client always sends that content type, so the string/Buffer branches are
 * only here for a request from something that did not — a curl with a body and
 * no header, say. Handing `proxyChat` an unparsed string would surface as
 * "body must be a JSON object", which is true but not helpful.
 */
function normalizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return body
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) return body
  const text = typeof body === 'string' ? body : body.toString('utf8')
  try {
    return JSON.parse(text)
  } catch {
    return { error: 'Body is not valid JSON.' }
  }
}

export default async function handler(
  req: HandlerRequest,
  res: ServerResponse,
): Promise<void> {
  const env = readProxyEnv(process.env)

  if (req.method === 'GET') {
    simpleJson(res, 200, healthReport(env))
    return
  }

  if (req.method !== 'POST') {
    res.setHeader('allow', 'GET, POST')
    simpleJson(res, 405, { error: { message: `${req.method ?? 'Requests'} are not allowed.` } })
    return
  }

  if (!originAllowed(req.headers.origin, req.headers.host ?? req.headers['x-forwarded-host'])) {
    simpleJson(res, 403, { error: { message: 'Cross-origin requests are refused.' } })
    return
  }

  try {
    const response = await proxyChat(env, normalizeBody(req.body))
    await pipeToNode(response, res)
  } catch (err) {
    // A thrown fetch — DNS, TLS, a socket that reset mid-answer. Groq's own
    // errors arrive as responses and are passed through by proxyChat; this is
    // the path where we never got a response at all, so the shape has to be
    // written here or the client falls back to `err.message` on a bare 500.
    const message = err instanceof Error ? err.message : 'Upstream request failed.'
    if (!res.headersSent) {
      simpleJson(res, 502, { error: { message } })
    } else if (!res.writableEnded) {
      res.end()
    }
  }
}
