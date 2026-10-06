import type { ServerResponse } from 'node:http'
import { originAllowed, pipeToNode, proxySpeech, readProxyEnv, simpleJson } from '../server/groqProxy.js'

type HandlerRequest = {
  method?: string
  headers: Record<string, string | string[] | undefined>
  body?: unknown
}

function normalizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return body
  if (typeof body !== 'string' && !Buffer.isBuffer(body)) return body
  try {
    return JSON.parse(typeof body === 'string' ? body : body.toString('utf8'))
  } catch {
    return { error: 'Body is not valid JSON.' }
  }
}

export default async function handler(req: HandlerRequest, res: ServerResponse): Promise<void> {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST')
    simpleJson(res, 405, { error: { message: 'Only POST requests are allowed.' } })
    return
  }
  if (!originAllowed(req.headers.origin, req.headers.host ?? req.headers['x-forwarded-host'])) {
    simpleJson(res, 403, { error: { message: 'Cross-origin requests are refused.' } })
    return
  }

  try {
    const response = await proxySpeech(readProxyEnv(process.env), normalizeBody(req.body))
    await pipeToNode(response, res)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Speech request failed.'
    if (!res.headersSent) simpleJson(res, 502, { error: { message } })
    else if (!res.writableEnded) res.end()
  }
}