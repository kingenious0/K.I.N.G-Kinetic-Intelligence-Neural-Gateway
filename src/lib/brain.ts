import { BACKEND } from '../config'
import * as direct from './anthropic'
import * as bridge from './bridge'
import * as groq from './groq'
import type { AskHandlers, Msg } from './anthropic'
import type { Blade, Panel } from '../store'

export type { AskHandlers, Msg }
export type { ConnectionState } from './bridge'

export const usingBridge = BACKEND === 'bridge'
export const usingGroq = BACKEND === 'groq'

/** Conversation state lives in the bridge session, so history is threaded through on groq/direct paths. */
export async function ask(
  prompt: string,
  history: Msg[],
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  if (usingBridge) {
    return bridge.ask(prompt, handlers)
  }
  if (usingGroq) {
    const formatted = history.map((m) => ({
      role: m.role as string,
      content: typeof m.content === 'string' ? m.content : '',
    }))
    return groq.ask([...formatted, { role: 'user', content: prompt }], handlers)
  }
  return direct.ask([...history, { role: 'user', content: prompt }], handlers)
}

export async function warm(): Promise<void> {
  if (usingBridge) await bridge.warmBridge()
}

/** The bridge or groq reports its server list. */
export function watchServers(fn: (servers: string[]) => void): void {
  if (usingBridge) {
    bridge.watchServers(fn)
  } else if (usingGroq) {
    fn(groq.connectedLabels())
  }
}

/** The bridge's server list, read synchronously. Empty unless the socket has
 *  reported — `connectedLabels()` covers that case by falling back to it. */
export const bridgeServers = (): string[] => bridge.bridgeServers()

/** Whether the bridge permits effectful tools. Always false off the bridge,
 *  where every path is local and the question does not arise. */
export function watchWrites(fn: (writes: boolean) => void): void {
  if (usingBridge) bridge.watchWrites(fn)
  else fn(false)
}

/** HUD panels pushed mid-turn. */
export function watchPanels(fn: (panel: Panel) => void): void {
  if (usingBridge) bridge.watchPanels(fn)
  if (usingGroq) groq.watchPanels(fn)
}

/** Blades arrive mid-turn. */
export function watchBlades(fn: (blade: Blade) => void): void {
  if (usingBridge) bridge.watchBlades(fn)
}

/** Redressing the interface — theme, reactor, orbits, effects. */
export function watchUi(fn: (op: string, args: any) => void): void {
  if (usingBridge) bridge.watchUi(fn)
  if (usingGroq) groq.watchUi(fn)
}

export function watchCapture(
  fn: (req: bridge.CaptureRequest) => Promise<bridge.CaptureResult>,
): void {
  if (usingBridge) bridge.watchCapture(fn)
}

/** Barge-in / Interrupt */
export function cancel(): void {
  if (usingBridge) bridge.cancel()
  else if (usingGroq) groq.cancel()
  else direct.cancel()
}

export function interrupt(): void {
  cancel()
}

export function isConnected(): boolean {
  return usingBridge ? bridge.isConnected() : true
}

export function watchConnection(
  fn: (state: bridge.ConnectionState) => void,
): void {
  if (usingBridge) bridge.watchConnection(fn)
}

export function connectedLabels(): string[] {
  if (usingBridge) return bridge.bridgeServers()
  if (usingGroq) return groq.connectedLabels()
  return direct.connectedLabels()
}
