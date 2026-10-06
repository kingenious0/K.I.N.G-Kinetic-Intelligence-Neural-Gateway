import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite only hands variables matching this prefix to `import.meta.env`, and
  // the default is `VITE_`. The Groq engine is configured with the bare
  // GROQ_API_KEY / GROQ_MODEL names so the same file can be read by a non-Vite
  // consumer (a script, or the bridge), so both prefixes are listed here.
  // Anything else — GITHUB_PERSONAL_ACCESS_TOKEN, DATABASE_URL, ELEVENLABS_API_KEY —
  // keeps no GROQ_ prefix and therefore still never reaches the bundle.
  envPrefix: ['VITE_', 'GROQ_'],
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
})
