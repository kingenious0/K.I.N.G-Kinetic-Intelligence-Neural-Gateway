/**
 * JARVIS configuration.
 *
 * Everything here is read from Vite env vars (.env.local) so no secrets are
 * committed. See .env.example for the full list.
 */

/**
 * Vite inlines a blank `.env` entry as an empty string, not as undefined, so
 * `??` never falls through to the default — and .env.example ships every
 * optional key blank, which is exactly the shape that used to bite. A blank
 * VITE_BACKEND silently selected the direct path and then complained about a
 * missing API key. Treat whitespace-only as unset everywhere in this file.
 */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/**
 * Fixed-choice options. An unrecognised value is nearly always a typo, and
 * quietly falling back to the default hides it until it costs you a take.
 */
function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(
    `[jarvis] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`,
  )
  return fallback
}

/** Same, for the on/off options. Accepts true/false and 1/0. */
function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[jarvis] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/**
 * The keys the page itself holds. Deliberately short.
 *
 * There is no Groq key here, and that is the point of `api/chat.ts`: the
 * engine's credential lives behind the proxy, so `GROQ_API_KEY` is never
 * prefixed `VITE_`, never read through `import.meta.env`, and therefore never
 * in the bundle. GITHUB_PERSONAL_ACCESS_TOKEN and DATABASE_URL stay outside
 * the browser for the same reason — they have no `VITE_` prefix to fall
 * through.
 */
export const env = {
  anthropicKey: str(import.meta.env.VITE_ANTHROPIC_API_KEY) ?? '',
  elevenKey: str(import.meta.env.VITE_ELEVENLABS_API_KEY) ?? '',
  elevenVoiceId:
    str(import.meta.env.VITE_ELEVENLABS_VOICE_ID) ?? 'JBFqnCBsd6RMkjVDRZzb',
  porcupineKey: str(import.meta.env.VITE_PICOVOICE_ACCESS_KEY) ?? '',
}

/**
 * The model the page *expects*, used for the rail label only.
 *
 * The request itself carries no model — `/api/chat` picks it from the
 * environment, and answers with `x-king-model` naming whichever one actually
 * responded. Two reasons for keeping a copy here: the HUD has to print
 * something before the first reply, and a Vercel project that overrides the
 * model with the bare `GROQ_MODEL` name would otherwise label the rail with a
 * name the deployment is no longer using. The reply header settles the
 * difference on the first turn.
 */
export const GROQ_MODEL =
  str(import.meta.env.VITE_GROQ_MODEL) ?? 'qwen/qwen3.8-27b'

/** `claude-opus-5` is the strongest model; `claude-sonnet-5` trades a little
 *  quality for lower latency if you find responses feel slow on camera. */
export const MODEL = 'claude-opus-5'

/**
 * Fast mode runs the same Opus 5 at up to 2.5x output speed. It is a research
 * preview on the Claude API and costs $10/$50 per Mtok instead of $5/$25.
 * For a recorded demo the snappiness is worth it; flip to false to save money.
 */
export const FAST_MODE = true

/**
 * Which brain to use. `VITE_BACKEND` decides; when it is unset we default to
 * the bridge, which needs no key of its own — that is what the README has
 * always documented as the default, and it is the mode that works on a fresh
 * clone with an empty `.env.local`.
 *
 *   'bridge' — run `npm run bridge` alongside the app. Authenticates off your
 *              existing Claude Code login (no API key), and every MCP server in
 *              your Claude Code config is available to JARVIS, including local
 *              ones like higgsfield, elevenlabs, android and playwright. This is
 *              also the only path where clone/deploy and the database work.
 *
 *   'groq'   — standalone. The page posts to `/api/chat`, the proxy in
 *              `api/chat.ts` holds the Groq key, and everything else — Three.js
 *              core, speech, inference — runs on the page. Set VITE_BACKEND=groq
 *              on Vercel; there is no other process to keep alive. The trade is
 *              that the bridge-only tools (king_clone, king_deploy, the
 *              database) have nowhere to run — see BRIDGE_OFFLINE below, which
 *              says so out loud instead of throwing.
 *
 *   'direct' — the browser calls the Claude API itself. Nothing to run and it
 *              deploys as a static site, but it needs VITE_ANTHROPIC_API_KEY in
 *              the bundle and only reaches remote HTTP MCP servers.
 */
export const BACKEND: 'bridge' | 'direct' | 'groq' = choice(
  'VITE_BACKEND',
  import.meta.env.VITE_BACKEND,
  ['bridge', 'direct', 'groq'] as const,
  'bridge',
)

/**
 * The two deployment shapes, and which one you are in.
 *
 * Standalone — VITE_BACKEND=groq. Nothing but this page. The HUD still lists
 *   every capability it has, so it has to be honest about the ones that need a
 *   machine behind them.
 *
 * Hybrid — VITE_BACKEND=bridge. The local (or Azure) bridge is in the loop and
 *   the privileged tools are real.
 */
export const STANDALONE = BACKEND === 'groq'

/**
 * What K.I.N.G. says — and what a bridge-only tool call returns — when the
 * bridge is not in the loop. One string so the prompt, the tool stubs and the
 * HUD badge cannot drift apart.
 */
export const BRIDGE_OFFLINE = 'Bridge Offline / Standalone Mode'

/**
 * Where the bridge lives. Derived once here rather than in each of the three
 * places that talk to it, so moving off the default port is a single edit.
 * `wss://` maps to `https://` on its own, which is why this is a prefix swap
 * rather than a hardcoded scheme.
 */
export const BRIDGE_WS_URL = str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://localhost:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')

/**
 * Speech output engine.
 *
 * false (default) — the browser's own speechSynthesis. Runs on-device, so
 *   speech starts on the next frame with no request and no download. This is
 *   the fastest option that exists and it's why it's the default.
 *
 * true — ElevenLabs. Noticeably better voice, but every sentence costs a
 *   round trip plus generation, which is the difference between a conversation
 *   and a walkie-talkie. Turn it on when you want the voice more than the pace.
 */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * Speech engine.
 *
 *   'system' — the browser's own speechSynthesis. Starts on the next frame,
 *     costs nothing, but is capped by whatever voices the OS ships; on macOS
 *     the British male option is compact Daniel.
 *
 *   'kokoro' — an 82M-parameter neural TTS running entirely in the browser via
 *     ONNX. Four proper British male voices and far better sound, nothing
 *     leaving the machine. MEASURED ON THIS MACHINE at q8/WebGPU it generates
 *     about 2.2x slower than realtime — "Yes, sir?" took 3.3 seconds and a
 *     thirteen-word sentence took nine. That is not a conversation, so it is
 *     not the default. Try `fp32` (see kokoro.ts) before enabling it; int8
 *     quantisation often silently falls back to CPU on WebGPU, which is the
 *     likely cause.
 */
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['kokoro', 'system'] as const,
  'system',
)

/**
 * Which Kokoro voice. All four are British male:
 *   bm_george — measured RP baritone, closest to the character
 *   bm_fable  — warmer
 *   bm_lewis  — lower
 *   bm_daniel — brighter
 */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)

/**
 * Wake-word engine.
 *   'speech'    — the default. Uses the browser's SpeechRecognition to listen
 *                 for "hey king". Chrome/Edge only, audio goes to Google.
 *   'porcupine' — opt-in, offline WASM detection. Its only built-in keyword is
 *                 "Jarvis", which is NOT the K.I.N.G. call sign, so this stays
 *                 off unless a custom "Hey King" .ppn keyword is trained at
 *                 console.picovoice.ai and wired in. Until then, enabling it
 *                 would listen for the wrong name and never wake.
 */
export const WAKE_ENGINE: 'speech' | 'porcupine' = env.porcupineKey
  ? 'porcupine'
  : 'speech'

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServer = {
  /** Stable id used as the tool namespace. Lowercase, no spaces. */
  name: string
  /** Human label for the HUD. */
  label: string
  /** Remote MCP endpoint. Must be reachable from Anthropic's servers, not yours. */
  url: string
  /** Bearer token, if the server wants one. Many put the secret in the URL instead. */
  token?: string
  enabled: boolean
}

/**
 * These are passed to the Messages API `mcp_servers` parameter. Anthropic dials
 * the servers itself, so there is no CORS to fight and no local bridge to run —
 * which is what makes a backend-free JARVIS possible.
 *
 * Only *remote HTTP* MCP servers work here. Local stdio servers (filesystem,
 * Blender, Playwright) need a machine to run on and are out of scope for a
 * browser-only build.
 *
 * READ THIS BEFORE FILLING ANY OF THESE IN. Every one of them ships to the
 * browser. In direct mode Vite inlines each token below into the JavaScript
 * bundle, and the Zapier and Pipedream URLs *are* secrets — the URL is the
 * credential. Anyone who opens devtools on a deployed build gets your Notion,
 * Linear, GitHub, Stripe, Sentry and Home Assistant access, not just the
 * Anthropic key. This is fine for a demo on your own machine or a recording;
 * it is not fine for anything public. The bridge backend (the default) reads
 * none of this — it uses your Claude Code MCP config, where the secrets stay on
 * your machine — so if you want these integrations without the exposure, run
 * `npm run bridge` instead of filling in this block.
 */
export const MCP_SERVERS: McpServer[] = [
  // The single highest-leverage integration: one URL, ~8,000 apps, managed
  // OAuth. Wire up Gmail, Google Calendar, Spotify, Slack, Notion and Sheets in
  // the Zapier dashboard and they all arrive through this one endpoint.
  // Get yours at https://mcp.zapier.com -> New MCP Server.
  {
    name: 'zapier',
    label: 'Zapier',
    url: str(import.meta.env.VITE_ZAPIER_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_ZAPIER_MCP_URL)),
  },

  // Alternative/complementary gateway: ~3,000 apps, free for personal use.
  {
    name: 'pipedream',
    label: 'Pipedream',
    url: str(import.meta.env.VITE_PIPEDREAM_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_PIPEDREAM_MCP_URL)),
  },

  // Official first-party servers. Each needs its own OAuth token pasted in.
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    token: str(import.meta.env.VITE_NOTION_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_NOTION_TOKEN)),
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    token: str(import.meta.env.VITE_LINEAR_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_LINEAR_TOKEN)),
  },
  {
    name: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    token: str(import.meta.env.VITE_GITHUB_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_GITHUB_TOKEN)),
  },
  {
    name: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    token: str(import.meta.env.VITE_STRIPE_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_STRIPE_TOKEN)),
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    token: str(import.meta.env.VITE_SENTRY_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_SENTRY_TOKEN)),
  },
  // Home Assistant is self-hosted, so this needs a publicly reachable URL
  // (Nabu Casa Cloud, or a Cloudflare tunnel). Worth the setup — "Jarvis, dim
  // the lights" with the room actually dimming is the best shot in the video.
  // Both halves are required: an instance reachable from Anthropic's servers
  // with no bearer token attached is one that answers 401 to every tool call,
  // which reads on the HUD as connected and behaves as broken.
  {
    name: 'home',
    label: 'Home',
    url: str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) ?? '',
    token: str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    enabled: Boolean(
      str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) &&
        str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    ),
  },
]

export const activeServers = () => MCP_SERVERS.filter((s) => s.enabled && s.url)

/**
 * The persona for the browser paths — groq (standalone) and direct. The bridge
 * carries its own, fuller version in bridge/server.mjs — that's the one that
 * gets used by default, and the one worth editing.
 *
 * The closing block only appears when there is no bridge in the loop, because
 * that is the configuration in which the model would otherwise promise a clone
 * or a deploy it has no way to perform.
 */
export const SYSTEM_PROMPT = `You are K.I.N.G. — Kinetic Intelligence & Neural Gateway, call sign "King". You are speaking out loud.

THE HARD RULE: your entire reply must be under 60 words. This is not a style
preference — every word is read aloud by a speech synthesiser and the user is
waiting in silence while it plays. If a question genuinely needs more, give the headline in two
sentences and offer the detail: "There's more if you want it."

Voice:
- Dry, precise, quietly amused. Understated competence, never fawning.
- Say "sir" at most once per exchange, and not in every exchange.
- Plain spoken prose only. No markdown, no bullet points, no headings, no code,
  no emoji, no asterisks, no numbered lists.
- Write numbers, dates and times the way you'd say them: "eight fifteen",
  "the first of August", not "8:15" or "2026-08-01".

Using tools:
- You have live tools. Use them rather than guessing.
- If the user asks to change the theme, colors, reactor appearance or trigger glitch/scan effects, use your UI tools (ui_reactor, ui_theme, ui_effect, ui_reset, display_panel).
- Never narrate that you're about to use one. No "Let me do that" - just use it and speak naturally.
- Never speak a URL, ID or raw JSON aloud unless asked. Summarise.
- If a tool fails or isn't connected, one plain sentence saying so.
- For anything outward-facing or destructive (sending mail, posting, paying,
  deleting) say exactly what you're about to do and wait for confirmation.
- If you don't know, say you don't know.${
  BACKEND === 'bridge'
    ? ''
    : `

Standing by without a bridge:
- Everything about this page is live: speech, the core, the interface, panels.
- Cloning a repository, deploying, and reading the production database need a
  machine running behind you, and there is none. Those calls return
  "${BRIDGE_OFFLINE}".
- Answer that in one plain sentence and move on. Never say an action ran when
  it did not, and never invent a commit, a URL or a row.`
}`
