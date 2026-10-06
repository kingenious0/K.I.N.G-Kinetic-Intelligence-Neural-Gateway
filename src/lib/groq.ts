import { env, GROQ_MODEL, SYSTEM_PROMPT } from '../config'
import type { AskHandlers } from './anthropic'
import type { Panel } from '../store'

export type GroqMsg = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: any[]
}

let activeAbort: AbortController | null = null
let onUiListener: ((op: string, args: any) => void) | null = null
let onPanelListener: ((panel: Panel) => void) | null = null

export function watchUi(fn: (op: string, args: any) => void) {
  onUiListener = fn
}

export function watchPanels(fn: (panel: Panel) => void) {
  onPanelListener = fn
}

export function cancel(): void {
  if (activeAbort) {
    activeAbort.abort()
    activeAbort = null
  }
}

export const connectedLabels = (): string[] => [
  'groq-cloud',
  GROQ_MODEL.replace(/^openai\//, '').replace(/^meta-llama\//, '').replace(/^qwen\//, '').replace(/^canopylabs\//, ''),
  'core-ui',
]

const UI_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'ui_reactor',
      description: 'Change the 3D holographic Arc Reactor core color, spin, scale, intensity, or style.',
      parameters: {
        type: 'object',
        properties: {
          color: { type: 'string', description: 'Hex or color name like red, #ff0000, cyan, gold, green, blue' },
          style: { type: 'string', enum: ['ring', 'sphere', 'wire'], description: 'Reactor 3D mesh geometry style' },
          spin: { type: 'number', description: 'Rotation speed multiplier between 0.2 and 5' },
          scale: { type: 'number', description: 'Scale multiplier between 0.5 and 2.5' },
          intensity: { type: 'number', description: 'Glow intensity between 0.5 and 3' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_theme',
      description: 'Change the interface accent color or dark background color.',
      parameters: {
        type: 'object',
        properties: {
          accent: { type: 'string', description: 'Accent color name or hex code' },
          background: { type: 'string', description: 'Background hex color or null for default' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_effect',
      description: 'Trigger a visual HUD holographic effect.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['glitch', 'pulse', 'scan', 'shake', 'flash'], description: 'Visual effect kind' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_reset',
      description: 'Reset all UI colors, theme, and Arc Reactor to standard defaults.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'ui_screen',
      description: 'Clear parts of the interface screen.',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: ['all', 'panels', 'transcript'] },
        },
        required: ['what'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'display_panel',
      description: 'Display an informative HUD panel card on the holographic display.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Panel card title' },
          html: { type: 'string', description: 'HTML content for the panel body' },
          accent: { type: 'string', enum: ['default', 'amber', 'violet', 'green', 'red'] },
          slot: { type: 'string', enum: ['right', 'left', 'wide'] },
        },
        required: ['title', 'html'],
      },
    },
  },
]

function executeUiTool(name: string, rawArgs: string): string {
  let args: any = {}
  try {
    args = JSON.parse(rawArgs || '{}')
  } catch {
    args = {}
  }

  switch (name) {
    case 'ui_reactor': {
      onUiListener?.('patch', {
        reactor: {
          ...(args.color ? { color: args.color } : {}),
          ...(args.style ? { style: args.style } : {}),
          ...(typeof args.spin === 'number' ? { spin: args.spin } : {}),
          ...(typeof args.scale === 'number' ? { scale: args.scale } : {}),
          ...(typeof args.intensity === 'number' ? { intensity: args.intensity } : {}),
        },
      })
      return JSON.stringify({ status: 'success', message: 'Reactor adjusted' })
    }
    case 'ui_theme': {
      onUiListener?.('patch', {
        accent: args.accent ?? null,
        background: args.background ?? null,
      })
      return JSON.stringify({ status: 'success', message: 'Theme applied' })
    }
    case 'ui_effect': {
      onUiListener?.('effect', { kind: args.kind })
      return JSON.stringify({ status: 'success', message: `Effect ${args.kind} fired` })
    }
    case 'ui_reset': {
      onUiListener?.('reset', {})
      return JSON.stringify({ status: 'success', message: 'UI reset to defaults' })
    }
    case 'ui_screen': {
      onUiListener?.('screen', { what: args.what ?? 'all' })
      return JSON.stringify({ status: 'success', message: 'Screen cleared' })
    }
    case 'display_panel': {
      onPanelListener?.({
        id: `p_${Date.now()}`,
        title: args.title || 'SYSTEM',
        html: args.html || '',
        anim: 'sweep',
        slot: args.slot || 'right',
        accent: args.accent || 'default',
        hold: 'turn',
      })
      return JSON.stringify({ status: 'success', message: 'Panel displayed' })
    }
    default:
      return JSON.stringify({ status: 'unknown_tool' })
  }
}

/**
 * Ask Groq with streaming response and UI tool calling.
 */
export async function ask(
  history: Array<{ role: string; content?: string }>,
  handlers: AskHandlers,
): Promise<{ text: string; tools: string[] }> {
  cancel()
  const abortController = new AbortController()
  activeAbort = abortController

  const apiKey = env.groqKey
  if (!apiKey) {
    throw new Error('No Groq API key configured. Please set VITE_GROQ_API_KEY in .env.local.')
  }

  const usedTools: string[] = []
  let fullText = ''

  const messages: any[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history.filter((m) => m.content && (m.role === 'user' || m.role === 'assistant')),
  ]

  async function callApi(currentMessages: any[]): Promise<string> {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: currentMessages,
        tools: UI_TOOLS,
        tool_choice: 'auto',
        temperature: 0.6,
        max_tokens: 400,
        stream: true,
      }),
      signal: abortController.signal,
    })

    if (!response.ok) {
      const errText = await response.text()
      let errMsg = `Groq API error (${response.status})`
      try {
        const errJson = JSON.parse(errText)
        if (errJson.error?.message) errMsg = errJson.error.message
      } catch {
        if (errText) errMsg += `: ${errText}`
      }
      throw new Error(errMsg)
    }

    const reader = response.body?.getReader()
    if (!reader) throw new Error('Response body stream not available')

    const decoder = new TextDecoder()
    let buffer = ''
    const toolCallsMap: Map<number, { id: string; name: string; args: string }> = new Map()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        if (!trimmed.startsWith('data: ')) continue

        try {
          const json = JSON.parse(trimmed.slice(6))
          const choice = json.choices?.[0]
          if (!choice) continue

          const delta = choice.delta
          if (delta?.content) {
            fullText += delta.content
            handlers.onText(delta.content)
          }

          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0
              if (!toolCallsMap.has(idx)) {
                toolCallsMap.set(idx, {
                  id: tc.id || `call_${idx}`,
                  name: tc.function?.name || '',
                  args: tc.function?.arguments || '',
                })
              } else {
                const existing = toolCallsMap.get(idx)!
                if (tc.id) existing.id = tc.id
                if (tc.function?.name) existing.name = tc.function.name
                if (tc.function?.arguments) existing.args += tc.function.arguments
              }
            }
          }
        } catch {
          // ignore chunk parse errors
        }
      }
    }

    // If tools were called, execute them
    if (toolCallsMap.size > 0) {
      const toolResults: any[] = []
      const toolCallMessages: any[] = []

      for (const [, tc] of toolCallsMap.entries()) {
        if (!tc.name) continue
        usedTools.push(tc.name)
        handlers.onTool(tc.name.replace(/_/g, ' · '))

        const result = executeUiTool(tc.name, tc.args)
        toolCallMessages.push({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.args },
        })
        toolResults.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: result,
        })
      }

      // If the model spoke nothing while calling tools, do one more stream turn to get spoken response
      if (!fullText.trim()) {
        const nextMessages = [
          ...currentMessages,
          { role: 'assistant', content: null, tool_calls: toolCallMessages },
          ...toolResults,
        ]
        return await callApi(nextMessages)
      }
    }

    return fullText
  }

  try {
    const text = await callApi(messages)
    return { text: text.trim(), tools: usedTools }
  } finally {
    if (activeAbort === abortController) {
      activeAbort = null
    }
  }
}
