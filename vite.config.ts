import { defineConfig, loadEnv } from 'vite'
import type { Plugin } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import react from '@vitejs/plugin-react'
import {
  healthReport,
  originAllowed,
  pipeToNode,
  proxyChat,
  readJsonBody,
  readProxyEnv,
  simpleJson,
  type ProxyEnv,
} from './server/groqProxy.ts'

/**
 * `/api/chat` while developing.
 *
 * A Vite server does not run the functions in `api/` — those belong to the
 * deployment — so without this the exact route the page depends on would work
 * in production and 404 on the laptop. Both hosts import the same
 * `server/groqProxy.ts`, so the only thing that differs between `npm run dev`
 * and a deploy is who reads the environment, not what the endpoint does.
 *
 * The key is loaded here from `loadEnv()` rather than `import.meta.env`,
 * because the whole point of the proxy is that it is the one place that sees
 * `GROQ_API_KEY`.
 */
function chatProxy(env: ProxyEnv): Plugin {
  return {
    name: 'king:groq-proxy',
    configureServer(server) {
      server.middlewares.use('/api/chat', (req: IncomingMessage, res: ServerResponse) => {
        void handle(req, res, env).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : 'Upstream request failed.'
          if (!res.headersSent) {
            simpleJson(res, 502, { error: { message } })
          } else if (!res.writableEnded) {
            res.end()
          }
        })
      })
    },
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  env: ProxyEnv,
): Promise<void> {
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

  const response = await proxyChat(env, await readJsonBody(req))
  await pipeToNode(response, res)
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Bare `GROQ_*` names are read here and nowhere else. Vite's own envPrefix
  // stays at its default of `VITE_`, so what this returns never reaches
  // `import.meta.env` — that separation is the entire reason the key cannot
  // end up in the bundle.
  const proxyEnv = readProxyEnv(loadEnv(mode, process.cwd(), ['VITE_', 'GROQ_']))

  return {
    plugins: [react(), chatProxy(proxyEnv)],
    server: {
      // Honour PORT so a second instance can run alongside the first. The bridge
      // only accepts sockets from localhost:5173-5199, so stay inside that range
      // or set JARVIS_ALLOWED_ORIGINS to match.
      port: Number(process.env.PORT) || 5173,
    },
    optimizeDeps: {
      // kokoro-js pulls in `phonemizer`, which carries espeak-ng as inline WASM.
      // Vite's dependency pre-bundler rewrites that initialisation and the
      // language table ends up empty — the symptom is
      // `Invalid language identifier: "en". Should be one of: .` at generate()
      // time, long after the model has loaded successfully. Serving these
      // untouched fixes it.
      exclude: ['kokoro-js', 'phonemizer', '@huggingface/transformers'],
    },
  }
})
