import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import { z } from 'zod'
import { domainSchema, querySchema } from '../shared/records.ts'
import { RecordConflict, RecordMissing } from '../storage/records.ts'
import type { RecordStore } from '../storage/records.ts'

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
}

const revision = z.number().int().positive()
const edit = z.strictObject({ revision, data: z.unknown() })

class RequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function jsonBody(request: IncomingMessage) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RequestError(415, 'Send an application/json request')
  }
  const buffers: Buffer[] = []
  let size = 0
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > 128_000) {
      request.resume()
      throw new RequestError(413, 'Request is too large')
    }
    buffers.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown
  } catch {
    throw new RequestError(400, 'Invalid JSON')
  }
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(value))
}

export function dashboardServer(options: {
  store: RecordStore, directory: string, timezone: string, discordStatus: () => string,
  log: (message: string) => void,
}) {
  const { store, directory, timezone, discordStatus, log } = options
  const server = createServer({ requestTimeout: 15000 }, async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
    try {
      const host = request.headers.host ?? ''
      const address = server.address()
      if (!address || typeof address === 'string' || (host !== '127.0.0.1:' + address.port && host !== 'localhost:' + address.port)) {
        throw new RequestError(403, 'Use the local dashboard address')
      }
      const method = request.method
      if (request.headers.origin && request.headers.origin !== 'http://' + host) {
        throw new RequestError(403, 'Origin is outside the local dashboard')
      }
      const url = new URL(request.url ?? '/', 'http://' + host)
      if (url.pathname === '/api/overview' && method === 'GET') {
        json(response, 200, { ...store.overview(), timezone, discord: discordStatus() })
        return
      }
      const route = /^\/api\/records\/([a-z]+)(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname)
      if (route) {
        const domain = domainSchema.parse(route[1])
        const id = route[2]
        if (method === 'GET') {
          if (id) {
            const record = store.get(domain, id)
            if (!record) throw new RecordMissing('This entry no longer exists')
            json(response, 200, record)
          } else {
            const query = Object.fromEntries(url.searchParams)
            const filters = querySchema.parse({
              ...query, limit: query.limit === undefined ? undefined : Number(query.limit),
              offset: query.offset === undefined ? undefined : Number(query.offset),
            })
            json(response, 200, store.list(domain, filters))
          }
          return
        }
        if (method === 'POST' && !id) {
          json(response, 201, store.create(domain, await jsonBody(request)))
          return
        }
        if (method === 'PUT' && id) {
          const payload = edit.parse(await jsonBody(request))
          json(response, 200, store.update(domain, id, payload.revision, payload.data))
          return
        }
        if (method === 'DELETE' && id) {
          const payload = z.strictObject({ revision }).parse(await jsonBody(request))
          store.delete(domain, id, payload.revision)
          json(response, 200, { deleted: true })
          return
        }
        throw new RequestError(405, 'Method unavailable for this route')
      }
      if (method !== 'GET') throw new RequestError(405, 'Method unavailable for this route')
      const asset = url.pathname === '/' ? 'index.html'
        : /^\/assets\/[\w.-]+$/.test(url.pathname) ? url.pathname.slice(1) : undefined
      if (!asset) throw new RequestError(404, 'Page not found')
      try {
        const body = await readFile(join(directory, asset))
        response.writeHead(200, {
          'Content-Type': contentTypes[extname(asset)] ?? 'application/octet-stream',
          'Cache-Control': asset === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
        })
        response.end(body)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (asset === 'index.html') throw new RequestError(503, 'Build the dashboard with npm run build')
        throw new RequestError(404, 'Asset not found')
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        json(response, 400, { error: 'Review the highlighted fields', issues: error.issues.map(issue => ({
          path: issue.path.join('.').replace(/^data\./, ''), message: issue.message,
        })) })
      } else if (error instanceof RequestError || error instanceof RecordMissing || error instanceof RecordConflict) {
        const status = error instanceof RequestError ? error.status : error instanceof RecordMissing ? 404 : 409
        json(response, status, { error: error.message })
      } else {
        log('Dashboard request failed')
        json(response, 500, { error: 'The request could not be completed' })
      }
    }
  })
  return server
}
