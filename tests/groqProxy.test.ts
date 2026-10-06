import assert from 'node:assert/strict'
import { test } from 'node:test'
import { proxyChat } from '../server/groqProxy.js'

type Mode = 'search_web' | 'fork_repository'

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  })
}

for (const mode of ['search_web', 'fork_repository'] as const) {
  test(`${mode} executes server-side and returns a streamed synthesis`, async () => {
    const originalFetch = globalThis.fetch
    let groqTurn = 0
    let providerCalled = false

    globalThis.fetch = async (input, init) => {
      const url = String(input)
      if (url === 'https://api.groq.com/openai/v1/chat/completions') {
        groqTurn++
        const payload = JSON.parse(String(init?.body)) as {
          tool_choice: string
          tools: Array<{ function?: { name?: string } }>
          messages: Array<{ role: string; content?: string }>
        }
        assert.equal(payload.tool_choice, 'auto')
        assert.ok(payload.tools.some((tool) => tool.function?.name === 'search_web'))
        assert.ok(payload.tools.some((tool) => tool.function?.name === 'fork_repository'))

        if (groqTurn === 1) {
          const args = mode === 'search_web'
            ? { query: 'latest release notes' }
            : { owner: 'acme', repo: 'project' }
          return jsonResponse({
            id: 'test-completion',
            model: 'mock-model',
            created: 1,
            choices: [{
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call-1',
                  type: 'function',
                  function: { name: mode, arguments: JSON.stringify(args) },
                }],
              },
              finish_reason: 'tool_calls',
            }],
          })
        }

        const result = payload.messages.find((message) => message.role === 'tool')
        assert.ok(result?.content)
        if (mode === 'search_web') {
          assert.match(result.content, /https:\/\/one\.test/)
          assert.match(result.content, /https:\/\/three\.test/)
          assert.doesNotMatch(result.content, /https:\/\/four\.test/)
        } else {
          assert.match(result.content, /https:\/\/github\.com\/me\/project/)
        }
        return jsonResponse({
          id: 'test-final',
          model: 'mock-model',
          created: 2,
          choices: [{ message: { role: 'assistant', content: 'Final answer ready.' }, finish_reason: 'stop' }],
        })
      }

      if (url === 'https://api.tavily.com/search') {
        assert.equal(mode, 'search_web')
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        assert.equal(body.api_key, 'tavily-test')
        assert.equal(body.max_results, 3)
        providerCalled = true
        return jsonResponse({
          results: [1, 2, 3, 4].map((index) => ({
            title: `Release notes ${index}`,
            content: 'A useful snippet.',
            url: `https://${['one', 'two', 'three', 'four'][index - 1]}.test`,
          })),
        })
      }

      if (url === 'https://api.github.com/repos/acme/project/forks') {
        assert.equal(mode, 'fork_repository')
        assert.equal(init?.method, 'POST')
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer gh-test')
        providerCalled = true
        return jsonResponse({ html_url: 'https://github.com/me/project' })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }

    try {
      const response = await proxyChat(
        {
          apiKey: 'groq-test',
          primary: 'mock-model',
          fallback: '',
          tavilyApiKey: 'tavily-test',
          githubToken: 'gh-test',
        },
        { messages: [{ role: 'user', content: 'Run the tool.' }], tools: [], stream: true },
      )
      const body = await response.text()
      assert.equal(response.headers.get('content-type')?.startsWith('text/event-stream'), true)
      assert.match(body, /Final answer ready\./)
      assert.match(body, /data: \[DONE\]/)
      assert.equal(groqTurn, 2)
      assert.equal(providerCalled, true)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
}