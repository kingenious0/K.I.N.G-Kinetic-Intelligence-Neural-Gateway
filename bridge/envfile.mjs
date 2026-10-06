/**
 * `bridge/.env`, loaded before anything else in the bridge reads the
 * environment.
 *
 * Why a file at all: the bridge used to take its settings only from the shell,
 * which is fine on a Unix box where `JARVIS_ALLOW_WRITES=1 npm run bridge`
 * works and on Windows, where it does not — cmd has no `NAME=value cmd` form,
 * so `npm run bridge:writes` fails there instead of enabling writes. A file
 * that is read the same way on every platform removes the difference, and it
 * gives the secrets a home that is next to the code that uses them and
 * gitignored like every other one.
 *
 * Two rules the loader keeps, both of which matter more than the parsing:
 *
 *   1. It must run before `./ops.mjs` and friends. ESM evaluates a module's
 *      imports in declaration order, which is why `server.mjs` imports this
 *      file first — `ops.mjs` reads `process.env.VERCEL_TOKEN` at module scope,
 *      and a value that arrives after that line is never seen.
 *   2. It never overwrites. A real environment variable wins, so
 *      `JARVIS_ALLOW_WRITES=1 npm run bridge` still beats whatever is in the
 *      file, and CI can override a committed default without editing it.
 *
 * Only `bridge/.env` is read — not the project root's `.env`, which belongs to
 * Vite and names its variables `VITE_*`. Keeping the two apart is what stops
 * one file from quietly configuring the other.
 *
 * No dotenv dependency: the subset worth supporting here is `KEY=value`, quotes
 * and comments, and pulling a package in to do that would be a supply-chain
 * surface on the one file that already contains the tokens.
 */
import { readFileSync } from 'node:fs'

function parse(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    const key = trimmed.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1)
    }
    out[key] = value
  }
  return out
}

try {
  const loaded = parse(readFileSync(new URL('./.env', import.meta.url), 'utf8'))
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
} catch {
  // No bridge/.env. That is the normal case for a fresh clone — everything
  // then comes from the real environment, exactly as it did before this file
  // existed.
}
