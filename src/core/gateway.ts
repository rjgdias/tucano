// The gateway is a local MCP server and the only source of tools a CLI gets.
// Each turn opens a session with its own secret URL and its own tool list;
// the gateway answers tools/list with exactly that list and refuses any call
// outside it. The CLI never talks to connectors directly.
import { randomBytes } from 'node:crypto'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { L } from '../shared/lang'

export interface ToolDef {
  name: string
  description: string
  inputSchema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] }
}

export interface Session {
  tools: ToolDef[]
  call(name: string, args: Record<string, unknown>): Promise<CallToolResult>
}

export const textResult = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], isError })

export class Gateway {
  private http: HttpServer | null = null
  private port = 0
  private sessions = new Map<string, Session>()
  private routes = new Map<string, (url: URL) => Promise<string>>()

  async start(): Promise<void> {
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch((e: unknown) => {
        console.error('[gateway]', e)
        if (!res.headersSent) res.writeHead(500).end()
      })
    })
    await new Promise<void>((resolve) => this.http!.listen(0, '127.0.0.1', resolve))
    this.port = (this.http.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    this.http?.closeAllConnections() // don't wait for idle keep-alive sockets
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()))
    this.http = null
  }

  // Plain GET pages on the same local server (the OAuth callback); the handler returns the page text.
  route(path: string, handler: (url: URL) => Promise<string>): void {
    this.routes.set(path, handler)
  }

  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  // Returns the URL to hand to the CLI, and a function that revokes it.
  open(session: Session): { url: string; close: () => void } {
    const token = randomBytes(24).toString('hex')
    this.sessions.set(token, session)
    return { url: `http://127.0.0.1:${this.port}/mcp/${token}`, close: () => this.sessions.delete(token) }
  }

  private async handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = req.method === 'GET' ? this.routes.get(url.pathname) : undefined
    if (route) {
      const text = await route(url).catch((e: unknown) => `Erro: ${e instanceof Error ? e.message : String(e)}`)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(`<!doctype html><meta charset="utf-8"><title>Tucano</title><body style="font:16px system-ui;padding:48px;color:#222">${text.replace(/</g, '&lt;')}</body>`)
      return
    }

    const token = /^\/mcp\/([a-f0-9]{48})$/.exec(req.url ?? '')?.[1]
    const session = token ? this.sessions.get(token) : undefined
    if (!session) {
      res.writeHead(404).end()
      return
    }

    // Stateless: a fresh MCP server per request, bound to this session's tools.
    const server = new Server({ name: 'tucano', version: '0.1.0' }, { capabilities: { tools: {} } })
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: session.tools }))
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      const name = r.params.name
      // Defense in depth: a tool that was not listed for this turn never runs.
      if (!session.tools.some((t) => t.name === name)) return textResult(L(`Ferramenta não permitida: ${name}`, `Tool not allowed: ${name}`), true)
      return session.call(name, (r.params.arguments ?? {}) as Record<string, unknown>)
    })
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    res.on('close', () => {
      void transport.close()
      void server.close()
    })
    await server.connect(transport)
    await transport.handleRequest(req, res)
  }
}
