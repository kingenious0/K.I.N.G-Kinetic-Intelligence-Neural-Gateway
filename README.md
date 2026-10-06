# K.I.N.G

A browser voice command station with an obsidian-and-gold holographic interface.
Say **"Hey King"**, he wakes, listens, and does real things through your tools —
searches the web, generates images, drives your phone, reads your mail. The face
is a web page (React + Vite + Three.js + custom GLSL). The brain is Claude Code,
run headless as a library.

**The only subscription you need is Claude Code.** No API keys, no OpenAI
account, no cloud bill — the brain runs on your existing Claude Code login, and
the heavy work (the model itself) runs on Anthropic's servers, so even a low-end
laptop only has to draw the interface. **ElevenLabs is an optional add-on** that
gives JARVIS a much better voice and sharper hearing; without it he speaks and
listens through the browser's own speech, and everything still works.

---

## Requirements

**In one line:** a Claude Code subscription, plus two free things every computer
can have — Node.js and Chrome. That's the whole list.

- **Claude Code, installed and logged in** — this is the only account you need.
  Install it with the official method — `npm install -g @anthropic-ai/claude-code`,
  or the platform installer at <https://docs.claude.com/en/docs/claude-code> —
  then run `claude` once and complete login. The bridge reuses that login. **No
  API key**, and usage is billed to your existing Claude account.
- **Node.js 20 or newer** — free, one installer from <https://nodejs.org>. This
  is a Node web app, so it is the one unavoidable tool.
- **Google Chrome or Microsoft Edge**, in a **real browser window** — not an
  embedded preview pane. Preview panes (including the one inside editors and
  Claude Code) block microphone access, so the page loads and looks right but
  never hears you. JARVIS also needs WebGL, which these browsers provide.
- **Optional: an ElevenLabs API key** — a good add-on, not a requirement. It
  gives a better voice and sharper transcription; the free tier is plenty for a
  demo. Without it, everything runs on the browser's own speech.

Run `npm run setup` after cloning and it checks all of this for you, in plain
language.

---

## Quick start

First, install, then start it:

```bash
npm install
npm start          # runs the brain and the face together
```

Then open the URL it prints (http://localhost:5173) in **Chrome**, click **INITIALISE**, and say **“Hey King”**.

Prefer two terminals? Run them separately instead:

```bash
npm install
```

Terminal 1 — the brain:

```bash
npm run bridge
```

Terminal 2 — the face:

```bash
npm run dev
```

Then open the app in a **real Chrome or Edge window**:

```bash
open http://localhost:5173
```

Click **INITIALISE**, allow the microphone when asked, and say **"Hey King"**.

> It has to be a real browser window. Embedded preview panes block the
> microphone, so JARVIS will look perfectly alive and simply never respond.

---

## How it works

JARVIS is two processes. The browser is the face and the voice; the bridge is
the brain and the hands.

```
  ┌─ browser (the face) ───────────────┐        ┌─ bridge (the brain) ─────────────┐
  │  "Hey King" wake word              │        │  Node · bridge/server.mjs        │
  │  local VAD  →  speech to text      │   ws   │  Claude Agent SDK                │
  │  reactor UI (Three.js + GLSL)      │◄─────► │   = Claude Code, headless        │
  │  text to speech                    │  8787  │  spawns your MCP servers         │
  │  heads-up display                  │        │  permission gate (decideTool)    │
  └────────────────────────────────────┘        └──────────────────────────────────┘
```

Everything you see and hear happens in the browser. The bridge is a single Node
process (`bridge/server.mjs`) that runs the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`) — this spawns the real `claude` CLI as a child
process, so **the brain literally is Claude Code, headless.** They talk over a
WebSocket (plus a few HTTP endpoints) on `ws://localhost:8787`.

**Why a bridge at all?** A browser tab cannot spawn the local stdio MCP servers —
`higgsfield`, `elevenlabs`, `android`, `playwright`, `exa`, `serper`, and the
rest. The bridge can. And because it is the Agent SDK, it authenticates off your
existing Claude Code login: no API key, billed to that same Claude account.

**The model.** `claude-opus-5` at effort `medium` by default. Override with the
`JARVIS_MODEL` and `JARVIS_EFFORT` environment variables. On startup the bridge
prints its choice, e.g. `[jarvis] model claude-opus-5 · effort medium`.

### The voice pipeline

The loop is designed so that nothing silently dies and barge-in feels natural.

- **Detection is local.** An energy-based voice-activity detector
  (`src/lib/vad.ts`) decides when you are speaking. It is instant, cannot quietly
  fail, and is what makes **barge-in** work — speak while JARVIS is talking and he
  stops.
- **Transcription has two tiers, chosen automatically at boot.** The browser asks
  the bridge `/health` and picks the best available:
  - **ElevenLabs key present** → ElevenLabs Scribe, via the bridge `/stt` endpoint.
  - **Nothing configured** → the browser's own `SpeechRecognition` (Chrome/Edge),
    guarded by a heartbeat so it recovers when Chrome throttles it.
- **Speaking** uses the **ElevenLabs voice when a key is present**, and the
  browser's `speechSynthesis` otherwise. If a cloud call fails it falls back to
  the browser voice, and if the OS voice itself is broken it latches over to the
  cloud voice.

So it works with no keys and auto-upgrades when a key appears — there is no flag
to set. Capability detection lives in `src/lib/capabilities.ts`, which probes the
bridge's `GET /health` (returning `{ ok, tts, stt }`, both tracking the
ElevenLabs key) once at boot and picks the engines.

---

## What JARVIS can do

Beyond answering, JARVIS reaches every MCP server in your Claude Code
configuration, and can drive his own interface.

### Your tools

Every server in your `~/.claude.json` is handed to the SDK explicitly. Depending
on what you have installed, that is roughly:

- **Web & search** — `exa`, `serper`, `serpapi`
- **Images & video** — `higgsfield`, `openrouter-image`, `palmier-pro`
- **Voice** — `elevenlabs`
- **Your phone** — `android`
- **The browser** — `playwright`

A few things you can say:

- _"What's happening in AI this week?"_
- _"Generate an image of the Mark VII suit."_
- _"Take a screenshot of my phone."_
- _"Open my GitHub notifications."_

> **Note on account connectors.** Servers you added through your **claude.ai
> account** are not stored on disk, so the bridge cannot see them — it works from
> the servers in `~/.claude.json` (about 14), not the claude.ai ones.

### JARVIS controls the interface

He drives the UI through MCP tools the bridge exposes:

- `ui_theme` — accent, background, per-phase colours
- `ui_reactor` — colour, scale, intensity, spin, and style (`ring` | `sphere` | `wire`), visibility
- `ui_orbit` — put images in orbit around the reactor
- `ui_chrome` — show or hide rails, transcript, badges
- `ui_effect` — `glitch` | `pulse` | `scan` | `shake` | `flash`
- `ui_screen` — clear
- `ui_reset` — back to defaults

So _"make it red, hide the systems list, put that render in orbit"_ is a spoken
command.

### The heads-up display

JARVIS authors panels with a `display` tool against a fixed `.hud-*` design
system. The browser sanitises the markup (DOMPurify, a class allowlist and a
strict CSP) before rendering. Rich media works — images, `<video>`, and
YouTube/Vimeo embeds. Remote images and video are fetched **server-side** through
the bridge (`/img` and `/media`, both SSRF-guarded), so hotlink-blocked news
thumbnails still appear and the page never beacons your IP to a host the model
chose.

---

## Controls

| Key / phrase     | Does                                  |
| ---------------- | ------------------------------------- |
| **"Hey King"**    | Wake him                              |
| **Space**        | Talk without the wake word            |
| Just speak       | Interrupt him mid-sentence (barge-in) |
| **V**            | Cycle the browser voice               |
| **Escape**       | Stand down                            |
| **D**            | Live diagnostics panel                |
| **T**            | One-line audio self-test              |

---

## The boot sequence

Power-up plays a four-beat Iron Man start-up (`src/ui/Boot.tsx`): an
"INITIATING SYSTEM" status bar with a segmented progress bar and boot log; then
concentric reticle rings resolving into "K . I . N . G ."; then a suit schematic;
then the triangular arc reactor lighting up — with a start-up sound under it
(`public/audio/boot-music.mp3`).

---

## Configuration

Everything is optional in bridge mode. Frontend settings live in `.env.local`
(copy `.env.example`); bridge settings live in `bridge/.env` (copy
`bridge/.env.example`) or in the shell that starts the bridge; deployment
settings live in the host's project environment. One rule covers all three —
**`VITE_` is the only prefix that can reach the browser**, and anything else
is read by a process that never ships to anyone.

### Bridge

| Variable                 | Default         | Effect                                          |
| ------------------------ | --------------- | ----------------------------------------------- |
| `JARVIS_BRIDGE_PORT`     | `8787`          | Port for the WebSocket + HTTP endpoints         |
| `JARVIS_MODEL`           | `claude-opus-5` | Model to run                                    |
| `JARVIS_EFFORT`          | `medium`        | Reasoning effort                                |
| `JARVIS_ALLOW_WRITES`    | off             | `1` allows effectful tools (see below)          |
| `JARVIS_ALLOWED_ORIGINS` | local dev       | Extra WebSocket origins to accept               |
| `JARVIS_ALLOW_NO_ORIGIN` | off             | Accept connections with no `Origin` header      |
| `JARVIS_FILE_ROOTS`      | —               | Roots the `/file` endpoint may serve from       |
| `JARVIS_VOICE_ID`        | —               | ElevenLabs voice id                             |
| `ELEVENLABS_API_KEY`     | —               | Optional; enables the ElevenLabs voice + Scribe |

### Frontend (`.env.local`)

| Variable                 | Effect                                          |
| ------------------------ | ----------------------------------------------- |
| `VITE_BACKEND`           | `bridge` (default), `groq` or `direct`          |
| `VITE_BRIDGE_URL`        | Where to reach the bridge                       |
| `VITE_TTS_ENGINE`        | `system` or `kokoro`                            |
| `VITE_KOKORO_VOICE`      | Voice for the Kokoro engine                     |
| `VITE_USE_ELEVENLABS`    | Force the ElevenLabs voice on                   |
| `VITE_ANTHROPIC_API_KEY` | Direct mode only                                |

### Standalone on Vercel (`VITE_BACKEND=groq`)

Standalone mode needs one thing bridge mode does not: somewhere to hold the
Groq key. That is `api/chat.ts`, a small function that the page posts to
instead of posting to Groq. `GROQ_API_KEY` is read there and nowhere else, so
it never has a `VITE_` prefix and never enters the bundle — you can grep
`dist/` after a build and find no key at all. `npm run dev` serves the same
route from a middleware in `vite.config.ts`, so development and production hit
one implementation.

| Variable                    | Where    | Effect                                        |
| --------------------------- | -------- | --------------------------------------------- |
| `VITE_BACKEND`              | Vercel   | `groq` — selects standalone mode              |
| `GROQ_API_KEY`              | Vercel   | **Server side only.** The proxy's credential  |
| `GROQ_MODEL`                | Vercel   | Primary model. Default `qwen/qwen3.8-27b`     |
| `GROQ_MODEL_FALLBACK`       | Vercel   | Used when the primary id is retired           |
| `VITE_GROQ_MODEL`           | Vercel   | The same model, for the HUD rail label        |

Deploy it with no build command, framework preset or output directory to
configure: Vercel detects Vite, runs `npm run build`, serves `dist/`, and turns
`api/` into functions.

Two things the proxy does on its own, so you do not have to configure them:

- **Fallback.** Groq retires model ids without notice (`qwen-2.5-32b` was the
  original default and is now decommissioned). If the primary is refused, the
  proxy retries once with the fallback and answers `x-king-model` /
  `x-king-fallback: 1`, which the page shows on the tool badge. One retry, not
  a loop — a rate limit or a malformed request would fail the same way twice.
- **Origin gate.** The endpoint holds a paid credential and cannot carry a
  secret of its own, so it refuses any request whose `Origin` header names a
  different host than the request. A browser on your own site passes; a page
  on somebody else's does not.

Locally, `GET /api/chat` answers `{ ok: true, hasKey: boolean }` — that is the
probe the page runs at boot to tell you the key is missing, rather than
finding out on the first message.

### MCP servers (`~/.claude.json`)

The bridge starts from the servers Claude Code already has configured: the
global `mcpServers` block and the one scoped to your home directory are read
from `~/.claude.json` and handed to the agent, so `npm run bridge` picks up
whatever you already use. Three entries deserve specific notes:

- **`elevenlabs`** — `mcpServers.elevenlabs.env.ELEVENLABS_API_KEY` is read
  directly, alongside the environment variable of the same name.
- **`github`** — the token is used: `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN`
  is what `king_deploy`'s `github` target authenticates with. The server entry
  itself is *not* used, because the bridge registers its own `github` server
  over the top of it — one built from the machine's own `gh` login, which is
  the read-only path. A PAT is only needed for the deploy target.
- **`postgres`** — used only when no connection string is in the environment.
  `SUPABASE_SESSION_DB_URL`, `SUPABASE_TRANSACTION_DB_URL` and `DATABASE_URL`
  are checked first and, if one is set, that server replaces this entry.

```jsonc
// ~/.claude.json — the entries the bridge understands
{
  "mcpServers": {
    "elevenlabs": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-elevenlabs"],
      "env": { "ELEVENLABS_API_KEY": "…" }
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_…" }
    },
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgres://…"]
    }
  }
}
```

Anything else in that block is passed through untouched, so a local stdio
server works here exactly as it does in Claude Code. The bridge only reads
those two scopes — project blocks for other directories are ignored, because
the bridge's working directory is your home directory.

### Adding an ElevenLabs key

You do not have to touch a flag. Either:

- Set `ELEVENLABS_API_KEY` on the bridge before starting it, **or**
- Add the key to your `elevenlabs` MCP server's env in `~/.claude.json` — the
  bridge reads it from there too.

Either way, `/health` starts reporting the capability, the browser picks it up on
the next boot, and both the voice and transcription upgrade automatically.

---

## Enabling actions

The tool gate starts **read-only**. Search, generation and lookups run freely;
anything effectful — send, tap, delete, install, pay — is denied. Voice is a poor
interface for a confirmation dialog, so the decision is made ahead of time in
`decideTool()` in `bridge/server.mjs`, not at the moment of use. The bridge sets
`settingSources: []`, which makes its own gate the only authority — filesystem
settings and any global `bypassPermissions` cannot override it.

To allow effectful tools (phone, browser driving, sending), run the bridge this
way instead:

```bash
npm run bridge:writes
```

> Read `decideTool()` before you do. _"Hey King, clone the monorepo into my
> workspace"_ means something rather different with writes enabled.

---

## Troubleshooting

**I can't hear him, or he can't hear me.** Press **D** for the diagnostics panel
— it states plainly whether he is hearing you and whether he is producing sound.
Press **T** for a one-line audio self-test.

**No voice at all.** You must be in **Chrome or Edge**, in a **real browser
window** (not an embedded preview), and you must have **allowed the microphone**.

**Bridge not reachable.** Check that `npm run bridge` is still running in its
terminal, and that nothing else is holding port `8787`.

---

## Security

All of this lives in `bridge/server.mjs`:

- The WebSocket accepts only local dev origins (add more with
  `JARVIS_ALLOWED_ORIGINS`).
- `/file`, `/img` and `/media` validate the scheme, confine to allowed roots,
  resolve the real path, and refuse private and loopback addresses (SSRF guard).
- The tool gate (`decideTool`) is default-deny for effectful MCP tools.
- A strict CSP in `index.html`; model-authored panel HTML is sanitised.

And the deployment side, in `server/groqProxy.ts` — shared by `api/chat.ts`
and the dev middleware, so there is one implementation to audit:

- `GROQ_API_KEY` is read by the function and never by `import.meta.env`. Vite's
  `envPrefix` is left at its default of `VITE_`, so nothing named `GROQ_*` can
  reach the bundle. Check a build with `grep -r gsk_ dist/` — it should find
  nothing.
- The model is chosen on the server. A request carries `messages`, `tools` and
  sampling parameters and not a model id, so the endpoint cannot be pointed at
  something you did not configure.
- The body is rebuilt field by field rather than forwarded, capped in size and
  in tool count, and a request whose `Origin` names a different host than the
  request is refused.
- `bridge/.env`, `.env` and `.env.local` are gitignored; only the
  `.env.example` templates are tracked.

---

## Credits & licence

MIT.

The boot sound and any tracks in `public/audio/` ship with the project for the
demo. If you go on to monetise something built on this, clearing the rights to
that audio is your responsibility.
