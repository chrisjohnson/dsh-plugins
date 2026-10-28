// Test-only dsh plugin for browser-live-check.mjs. NOT shipped (outside the package's
// `files` allowlist) and never part of a profile.
//
// It lets a script act as several DSH sessions without a model: it creates real
// agents (so `exec.agent.id` and the `agent/disposed` event are the real ones),
// and runs tool calls through the real tool runtime (`tools/execute`,
// `tools/post-execute` and every other listener included). The script talks to
// it over loopback HTTP.
//
//   POST   /agents       {"id": "a"}                         create a session
//   DELETE /agents/<id>                                      dispose it
//   POST   /call         {"agent": "a", "name": "browser_open", "arguments": {}}
//   GET    /health

import { createServer } from 'node:http'

export default function driver(ctx, config = {}) {
  const port = config.port
  if (!Number.isInteger(port)) throw new Error('live driver: config.port is required')
  const cwd = config.cwd ?? process.cwd()

  ctx.inject(['agents', 'tools'], (scope) => {
    const handles = new Map()
    let calls = 0

    async function body(request) {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const text = Buffer.concat(chunks).toString('utf8')
      return text === '' ? {} : JSON.parse(text)
    }

    async function route(request) {
      const url = new URL(request.url, 'http://127.0.0.1')
      if (request.method === 'GET' && url.pathname === '/health') return { ok: true, agents: [...handles.keys()] }
      if (request.method === 'POST' && url.pathname === '/agents') {
        const { id } = await body(request)
        if (handles.has(id)) throw new Error(`agent ${id} exists`)
        handles.set(id, await scope.agents.create({ sessionId: id, meta: { cwd } }))
        return { ok: true, id }
      }
      if (request.method === 'DELETE' && url.pathname.startsWith('/agents/')) {
        const id = decodeURIComponent(url.pathname.slice('/agents/'.length))
        const handle = handles.get(id)
        if (handle === undefined) throw new Error(`no agent ${id}`)
        handles.delete(id)
        await handle.dispose()
        return { ok: true, id }
      }
      if (request.method === 'POST' && url.pathname === '/call') {
        const { agent, name, arguments: args } = await body(request)
        const handle = handles.get(agent)
        if (handle === undefined) throw new Error(`no agent ${agent}`)
        calls += 1
        const result = await scope.tools.execute({
          callId: `live-${calls}`,
          name,
          arguments: args ?? {},
          agent: handle.agent,
          signal: AbortSignal.timeout(120000),
        })
        return {
          isError: result.isError,
          text: result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'),
          value: result.isError ? undefined : result.value,
        }
      }
      throw new Error(`no route ${request.method} ${url.pathname}`)
    }

    const server = createServer((request, response) => {
      route(request).then(
        (payload) => {
          response.writeHead(200, { 'content-type': 'application/json' })
          response.end(JSON.stringify(payload))
        },
        (error) => {
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
        },
      )
    })
    scope.effect(() => {
      server.listen(port, '127.0.0.1')
      return async () => {
        server.close()
        for (const handle of handles.values()) await handle.dispose().catch(() => undefined)
      }
    }, 'live driver')
  })
}
