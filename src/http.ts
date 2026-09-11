/**
 * Routing and the socket.
 *
 * The handler signature is `(req, res)` and nothing here reaches for the
 * listener, so mounting inside a host-provided web server later is an adapter
 * rather than a rewrite.
 *
 * Nothing validates the `Host` header and no absolute URL is ever emitted, so
 * the same server answers correctly on `localhost:PORT`, `192.168.1.8:PORT`,
 * `something.local:PORT`, or any name pointed at it. The hostname never matters.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { encoded, type AssetTable } from './assets.ts'
import { browse, createSession, createWorkspace, makeDirectory } from './create.ts'
import { toAnswers, type Questions } from './questions.ts'
import { send } from './send.ts'
import { expanded, tail } from './sessions.ts'
import { policy, shell, type ShellState } from './shell.ts'
import { idOf, StreamHub } from './stream.ts'
import type { Corpus } from './corpus.ts'
import type { SessionSummary } from './types.ts'

/** Largest prompt body accepted, so a hostile or broken client cannot exhaust memory. */
const MAX_BODY = 1_000_000

/** A route handler. Every one of them runs inside {@link guard}. */
type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void> | void

/**
 * Build the request handler.
 * @param ctx - the plugin context.
 * @param assets - the digest table for static delivery.
 * @param hub - the SSE hub.
 * @returns a handler suitable for `node:http` or any host web server.
 */
export function handler(ctx: Context, assets: AssetTable, hub: StreamHub): Handler {
  return async (req, res, url) => {
    const path = url.pathname
    if (req.method === 'GET' && path.startsWith('/m/')) return serveAsset(assets, req, res, path)
    if (req.method === 'GET' && path === '/api/stream') {
      const controller = new AbortController()
      req.on('close', () => { controller.abort() })
      const header = req.headers['last-event-id']
      return hub.attach(res, typeof header === 'string' ? header : undefined, controller.signal)
    }
    // The complete listing, headings included: a client that asked for the list
    // needs to know which workspaces exist even when none of them holds a
    // visible session, and the headings are not derivable from the rows.
    if (req.method === 'GET' && path === '/api/sessions') return json(res, await hub.corpus.listing(hub.questions))
    if (req.method === 'POST' && path === '/api/sessions') {
      const body = await readJson(req)
      const workspaceId = typeof body['workspaceId'] === 'string' && body['workspaceId'] !== '' ? body['workspaceId'] : undefined
      const created = await createSession(ctx, { ...(workspaceId === undefined ? {} : { workspaceId }) })
      // The new session is not a log event, so nothing would carry it to the
      // list on its own. Push the listing now, or the reader's tap has no answer.
      hub.notify()
      return json(res, created)
    }
    if (req.method === 'POST' && path === '/api/workspaces') {
      const body = await readJson(req)
      const created = await createWorkspace(ctx, String(body['path'] ?? ''))
      hub.notify()
      return json(res, created)
    }
    if (req.method === 'GET' && path === '/api/browse') {
      const at = url.searchParams.get('path')
      return json(res, await browse(ctx, at === null || at === '' ? undefined : at))
    }
    if (req.method === 'POST' && path === '/api/directory') {
      const body = await readJson(req)
      const created = await makeDirectory(ctx, String(body['path'] ?? ''), String(body['name'] ?? ''))
      hub.notify()
      return json(res, { path: created })
    }
    const expand = /^\/api\/s\/([^/]+)\/e\/(\d+)$/.exec(path)
    if (req.method === 'GET' && expand !== null) {
      const html = await expanded(ctx, SessionId(decodeURIComponent(expand[1] ?? '')), Number(expand[2]))
      if (html === null) return json(res, { error: true, message: 'No such event', detail: path }, 404)
      return json(res, { html })
    }
    if (req.method === 'POST' && path === '/api/focus') {
      const body = await readJson(req)
      const target = hub.clientById(String(body['streamId'] ?? ''))
      if (target === undefined) return json(res, { error: true, message: 'That stream is no longer connected', detail: 'reopen' }, 409)
      await hub.focus(target, SessionId(String(body['sessionId'] ?? '')), toSeq(body['from']))
      return json(res, { accepted: true })
    }
    if (req.method === 'POST' && path === '/api/send') {
      const body = await readJson(req)
      const result = await send(
        ctx,
        SessionId(String(body['sessionId'] ?? '')),
        String(body['clientMessageId'] ?? ''),
        String(body['text'] ?? ''),
      )
      return json(res, result)
    }
    if (req.method === 'POST' && path === '/api/answer') {
      const body = await readJson(req)
      const askId = String(body['askId'] ?? '')
      const result = hub.questions.answer(askId, String(body['clientMessageId'] ?? ''), toAnswers(body['answers']))
      if (result === null) {
        return json(res, {
          error: true,
          message: 'That question is no longer waiting for this answer',
          detail: `ask ${askId} was answered from another browser, cancelled by its agent, or lost when the harness restarted`,
        }, 409)
      }
      return json(res, result)
    }
    if (req.method === 'POST' && path === '/api/stop') {
      const body = await readJson(req)
      ctx.agents.get(SessionId(String(body['sessionId'] ?? '')))?.cancel({ kind: 'user' })
      return json(res, { accepted: true })
    }
    if (req.method === 'GET' && path === '/') {
      // `/` is a shortcut, not a view. Redirect so every screen has exactly one
      // canonical, deep-linkable URL and the client router never has to guess
      // which one `/` meant.
      const rows = await hub.corpus.rows(hub.questions)
      // Newest first, which the corpus guarantees, so this is the session the
      // reader most likely meant. `/` is a shortcut, not a view.
      const latest = rows[0]
      res.writeHead(302, {
        location: latest === undefined ? '/sessions' : `/s/${encodeURIComponent(latest.id)}`,
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (req.method === 'GET') return document(ctx, assets, hub, res, url)
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Method not allowed')
  }
}

/**
 * Render the document for a navigable route.
 *
 * Every full-screen state resolves here from server state alone, so pasting a
 * URL into a second browser opens exactly the same screen.
 * @param ctx - the plugin context.
 * @param assets - the digest table.
 * @param questions - the questions this server is holding.
 * @param res - the response.
 * @param url - the requested URL.
 */
async function document(
  ctx: Context,
  assets: AssetTable,
  hub: StreamHub,
  res: ServerResponse,
  url: URL,
): Promise<void> {
  const state = await resolve(ctx, hub.questions, url, hub.corpus)
  const { html, nonce } = shell(assets, state)
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-cache',
    'content-security-policy': policy(nonce),
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(html)
}

/**
 * Resolve one URL to the view it names.
 * @param ctx - the plugin context.
 * @param questions - the questions this server is holding.
 * @param url - the requested URL.
 * @returns the shell state for that route.
 */
async function resolve(ctx: Context, questions: Questions, url: URL, corpus: Corpus): Promise<ShellState> {
  const rows = await corpus.rows(questions)
  const event = /^\/s\/([^/]+)\/e\/(\d+)$/.exec(url.pathname)
  if (event !== null) {
    const id = SessionId(decodeURIComponent(event[1] ?? ''))
    const seq = Number(event[2])
    const row = rows.find(candidate => candidate.id === id)
    const html = await expanded(ctx, id, seq)
    return {
      frames: html ?? '',
      sessionId: null,
      title: `One event in ${row?.title ?? 'this session'}`,
      crumbs: [
        { label: 'Sessions', href: '/sessions' },
        ...(row === undefined ? [] : [{ label: row.workspace, href: `/sessions#${encodeURIComponent(row.workspaceId)}` }]),
        ...(row === undefined ? [] : [{ label: row.title, href: `/s${'/'}${encodeURIComponent(row.id)}` }]),
        { label: `Event ${seq}`, href: url.pathname },
      ],
      renderedThrough: -1,
      canSend: false,
      asks: [],
      showTools: false,
    }
  }
  const transcript = /^\/s\/([^/]+)/.exec(url.pathname)
  if (transcript === null) {
    return {
      frames: '',
      sessionId: null,
      title: 'Sessions',
      crumbs: [{ label: 'Sessions', href: '/sessions' }],
      renderedThrough: -1,
      canSend: false,
      asks: [],
      showTools: true,
    }
  }
  return await transcriptState(ctx, SessionId(decodeURIComponent(transcript[1] ?? '')), rows)
}

/**
 * Build the shell state for a transcript route.
 * @param ctx - the plugin context.
 * @param id - the focused session.
 * @param rows - the current summaries, for the title and breadcrumbs.
 * @returns the shell state.
 */
async function transcriptState(
  ctx: Context,
  id: SessionId,
  rows: readonly SessionSummary[],
): Promise<ShellState> {
  const row = rows.find(candidate => candidate.id === id)
  const { html, renderedThrough } = await tail(ctx, id, -1)
  const asks = row?.asks ?? []
  return {
    frames: html,
    sessionId: id,
    title: row?.title ?? 'Session',
    // Built from workspace membership, not from how the reader arrived.
    crumbs: [
      { label: 'Sessions', href: '/sessions' },
      ...(row === undefined ? [] : [{ label: row.workspace, href: `/sessions#${encodeURIComponent(row.workspaceId)}` }]),
      ...(row === undefined ? [] : [{ label: row.title, href: `/s${'/'}${encodeURIComponent(row.id)}` }]),
    ],
    renderedThrough,
    // A session with no live agent still reads; it just cannot be prompted.
    canSend: (row?.actions ?? []).includes('send'),
    asks,
    // Creating is a list-level action, so it lives on the list.
    showTools: false,
  }
}

/**
 * Serve one digest-stamped asset.
 * @param assets - the digest table.
 * @param req - the request, for its accepted encodings.
 * @param res - the response.
 * @param path - the stamped path.
 */
function serveAsset(assets: AssetTable, req: IncomingMessage, res: ServerResponse, path: string): void {
  const asset = assets.byUrl.get(path)
  if (asset === undefined) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('No such module')
    return
  }
  const { body, encoding } = encoded(asset, req.headers['accept-encoding'])
  res.writeHead(200, {
    'content-type': asset.type,
    // The digest is in the name, so this response can never go stale.
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': body.byteLength,
    ...(encoding === undefined ? {} : { 'content-encoding': encoding, 'vary': 'accept-encoding' }),
  })
  res.end(body)
}

/**
 * Read and parse a JSON request body.
 * @param req - the request.
 * @returns the parsed object.
 * @throws Error when the body exceeds {@link MAX_BODY} or is not a JSON object.
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const parts: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error(`request body exceeds ${MAX_BODY} bytes`)
    parts.push(chunk)
  }
  const parsed: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('request body must be a JSON object')
  }
  return { ...parsed }
}

/**
 * Admit a client-supplied cursor value.
 * @param value - the raw JSON value.
 * @returns the seq, or -1 when absent or malformed.
 */
function toSeq(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : -1
}

/**
 * Send a JSON response.
 * @param res - the response.
 * @param body - the payload.
 * @param status - the status code.
 */
function json(res: ServerResponse, body: unknown, status = 200): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * Wrap one handler so no request can take the process down.
 *
 * A sync throw in a `node:http` handler is an `uncaughtException` and an async
 * rejection crashes modern Node by default. In-process means an HTTP bug could
 * otherwise take live agents with it, so the catch-all is the price of the hop
 * we are not paying.
 * @param ctx - the plugin context, for logging.
 * @param inner - the route handler.
 * @returns a handler that always answers.
 */
export function guard(ctx: Context, inner: Handler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    let url: URL
    try {
      // A fixed base: the real hostname is never consulted, so every hostname works.
      url = new URL(req.url ?? '/', 'http://web-gui.invalid')
    } catch {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Bad request target')
      return
    }
    void (async () => {
      try {
        await inner(req, res, url)
      } catch (error: unknown) {
        ctx.logger.warn(`web-gui: ${req.method ?? 'GET'} ${url.pathname} failed: ${errorChain(error)}`)
        if (res.headersSent) {
          res.end()
          return
        }
        // Full technical detail travels to the page: a staff member copies it
        // straight to a developer, and a developer reads it during a screenshare
        // without opening a console.
        json(res, {
          error: true,
          message: error instanceof Error ? error.message : String(error),
          detail: [
            `${req.method ?? 'GET'} ${url.pathname}${url.search}`,
            error instanceof Error && error.stack !== undefined ? error.stack : String(error),
            error instanceof Error && error.cause !== undefined ? `cause: ${String(error.cause)}` : '',
            `at ${new Date().toISOString()}`,
          ].filter(line => line !== '').join('\n'),
        }, 500)
      }
    })()
  }
}

/**
 * Open the listener.
 * @param ctx - the plugin context.
 * @param assets - the digest table.
 * @param hub - the SSE hub.
 * @param port - the TCP port to bind.
 * @param host - the interface to bind; the default answers on every interface so a phone on the LAN reaches it.
 * @returns the listening server.
 */
export function listen(
  ctx: Context,
  assets: AssetTable,
  hub: StreamHub,
  port: number,
  host: string,
): Promise<Server> {
  const server = createServer(guard(ctx, handler(ctx, assets, hub)))
  // An SSE client that vanishes mid-turn must not hold a socket open forever,
  // and a live stream must never be reaped as idle.
  server.keepAliveTimeout = 72_000
  server.headersTimeout = 75_000
  server.requestTimeout = 0
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { resolve(server) })
  })
}

export { idOf }
