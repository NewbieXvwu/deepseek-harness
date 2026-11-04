/** Loopback provider endpoint shared by the anonymous-provider specs. */
import { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import Translator, { type Config } from '../src/index.ts'

export type Reply = (req: IncomingMessage, res: ServerResponse, body: string) => void
/** Fixture config as the profile stores it: the volatile fields are written as their values. */
export type RawConfig = Partial<Omit<Config, 'deeplxEndpoint' | 'llmProvider' | 'llmModel'>>
  & { readonly deeplxEndpoint?: string; readonly llmProvider?: string; readonly llmModel?: string }

/**
 * Start a loopback endpoint and mount a translator pointed at it.
 * @param cleanups - caller-owned list that closes the listener and disposes the fiber after the test.
 * @param reply - response writer for each received request.
 * @param overrides - translator configuration fields.
 * @returns the Host context, service, recorded requests, accepted config and listener origin.
 */
export async function fixture(cleanups: Array<() => Promise<void>>, reply: Reply, overrides: RawConfig = {}) {
  const requests: Array<{ url: URL; method: string | undefined; headers: IncomingMessage['headers']; body: string }> = []
  const server = createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => { body += chunk })
    req.on('end', () => {
      requests.push({ url: new URL(req.url!, 'http://localhost'), method: req.method, headers: req.headers, body })
      reply(req, res, body)
    })
  })
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error === undefined) resolve()
      else reject(error)
    }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing loopback listener')
  const base = `http://127.0.0.1:${address.port}`
  const ctx = new Context()
  cleanups.push(async () => { await ctx.fiber.dispose() })
  const raw = { googleEndpoint: `${base}/google?client=legacy&q=stale&sl=fr&tl=ja&dt=x&fixture=retained`,
    bingEndpoint: `${base}/bing?from=fr`, deeplxEndpoint: `${base}/deeplx?authKey=fixture-key`,
    chatjimmyEndpoint: `${base}/chat`, ...overrides }
  const config = Translator.Config(raw)
  const fiber = ctx.plugin(Translator, raw)
  await fiber
  return { ctx, fiber, base, config, requests, translator: ctx.translator }
}

/** Reply with a JSON body. */
export function json(res: ServerResponse, payload: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
}

/** Reply with a plain-text body. */
export function text(res: ServerResponse, payload: string): void {
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end(payload)
}
