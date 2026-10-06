/**
 * K.I.N.G. visual identity — the Kingenious luxury obsidian-and-gold system.
 *
 * This is the single source of truth for the palette. Everything else reads
 * from it: the reactor shader defaults (Core.tsx), the phase map (store.ts),
 * the CSS custom properties (:root in index.css, mirrored by Hud.tsx at
 * runtime), and the bridge-side ui_theme tool defaults.
 *
 * The old build was anchored on generic sci-fi cyan. The PRD is explicit that
 * the anchor is Imperial Amber Gold on Deep Obsidian Black, with Electric
 * Violet reserved for energy shockwaves so that tool use reads as a surge of
 * power rather than as a change of brand.
 */

export const KING_THEME = {
  /** Imperial Amber Gold — the primary neural core. */
  accent: '#FFB703',
  /** Radiant Solar Gold — corona / core highlight. */
  corona: '#FFE28A',
  /** Chromatic Surge — energy shockwaves, tool/thinking phases. */
  energyViolet: '#7C3AED',
  /** Electric Violet — the brighter sibling used for live effects. */
  energy: '#8B5CF6',
  /** Deep Obsidian Black — canvas. */
  background: '#050508',
  /** Deeper still, for the outer vignette. */
  backgroundDeep: '#030305',
  /** HUD framing — frosted glass / translucent obsidian. */
  border: 'rgba(255, 183, 3, 0.15)',
  /** The same, dimmer, for rails that should not draw the eye. */
  borderSoft: 'rgba(255, 183, 3, 0.08)',
} as const

/** Telemetry typography — JetBrains Mono / Space Grotesk. */
export const KING_TYPE = {
  mono: '"JetBrains Mono", "Space Grotesk", ui-monospace, monospace',
  display: '"Space Grotesk", "JetBrains Mono", system-ui, sans-serif',
  primary: '#FFFFFF',
  dim: '#A1A1AA',
} as const

/**
 * Phase palette.
 *
 * Replaces the cyan/teal anchor wholesale. The rule that governs the map:
 * idle and listening states are gold (the brand at rest), thinking and tooling
 * states surge violet (the brand under load), speaking returns to gold-hot so
 * the answer lands back on the identity.
 */
export const KING_PHASE = {
  offline: '#3A2A05',
  boot: '#8A6A18',
  dormant: '#7A5F14',
  waking: '#FFD772',
  listening: '#FFB703',
  thinking: '#FFB703',
  tooling: '#7C3AED',
  speaking: '#FFE28A',
} as const satisfies Record<string, string>

export type KingPhase = keyof typeof KING_PHASE

/**
 * Shader uniforms, named the way the PRD calls them.
 *
 * Core.tsx declares `uColor` / `uHot` in GLSL — those names are the shader's
 * own vocabulary and renaming them would touch every reference for no gain.
 * These aliases are the bridge between the PRD's naming and the GLSL's, and
 * they are what a theme tool should write to.
 */
export const KING_UNIFORMS = {
  /** PRD `u_coreColor` → GLSL `uColor`: the ring body hue. */
  u_coreColor: KING_THEME.accent,
  /** PRD `u_coronaColor` → GLSL `uHot`: the highlight tint riding on it. */
  u_coronaColor: KING_THEME.corona,
} as const

/** Hex → THREE.Color-ready string, tolerating already-normalised input. */
export function hex(value: string): string {
  return value.trim()
}
