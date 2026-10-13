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
import { manifest, MANIFEST_URL } from './manifest.ts'
import { browse, createSession, createWorkspace, makeDirectory } from './create.ts'
import { toAnswers } from './questions.ts'
import { toOutcome } from './approvals.ts'
import { send } from './send.ts'
import { earlier, expanded, expandedRun, reply, tail } from './sessions.ts'
import { policy, shell, unresolvedImports, SERVICE_WORKER, SERVICE_WORKER_URL, type ShellState } from './shell.ts'
import { idOf, StreamHub } from './stream.ts'
import type { AskSource, Corpus } from './corpus.ts'
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
    // The manifest names digest-stamped icons, so it is refreshed with the table
    // before it is built; an install that captured an older icon url would
    // otherwise keep asking for bytes this server no longer has.
    if (req.method === 'GET' && path === MANIFEST_URL) {
      await assets.refresh().catch((error: unknown) => {
        ctx.logger.warn(`web-gui: client asset refresh failed: ${errorChain(error)}`)
      })
      const body = Buffer.from(manifest(assets), 'utf8')
      res.writeHead(200, {
        'content-type': 'application/manifest+json; charset=utf-8',
        // Revalidated rather than immutable: this url is stable, and it is how
        // an installed app picks up a changed name or icon.
        'cache-control': 'no-cache',
        'content-length': body.byteLength,
      })
      res.end(body)
      return
    }
    // The service worker, at the one url it can usefully live at. A worker
    // controls only pages at or below its own path, so the stamped `/m/` url
    // every other client file uses would scope it to `/m/` and leave the app
    // uncontrolled. Refreshed from disk first, for the same reason the manifest
    // is: this url is stable, so the bytes behind it must be current.
    if (req.method === 'GET' && path === SERVICE_WORKER_URL) {
      await assets.refresh().catch((error: unknown) => {
        ctx.logger.warn(`web-gui: client asset refresh failed: ${errorChain(error)}`)
      })
      const worker = assets.modules.get(SERVICE_WORKER)
      if (worker === undefined) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('No service worker')
        return
      }
      const { body, encoding } = encoded(worker, req.headers['accept-encoding'])
      res.writeHead(200, {
        'content-type': worker.type,
        // Revalidated, never immutable: the url cannot carry a digest, so this
        // is how a changed worker is ever picked up.
        'cache-control': 'no-cache',
        'content-length': body.byteLength,
        ...(encoding === undefined ? {} : { 'content-encoding': encoding, 'vary': 'accept-encoding' }),
      })
      res.end(body)
      return
    }
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
      // A caller may name the id, so a retry after a lost response resolves to
      // the session it already made instead of making a second one. Shape is
      // checked in `createSession`, which owns the id's meaning.
      const sessionId = typeof body['sessionId'] === 'string' && body['sessionId'] !== '' ? body['sessionId'] : undefined
      const created = await createSession(ctx, {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        ...(sessionId === undefined ? {} : { sessionId }),
      })
      // The new session is not a log event, so nothing would carry it to the
      // list on its own. Expire the corpus first — a `notify` alone would
      // rebroadcast the cached rows, which do not have this session in them
      // yet — then push the listing, or the reader's tap has no answer.
      await hub.corpus.invalidate()
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
    // The chunk of transcript before a seq: what the "Older messages" link at the
    // top of the log asks for. The tail is bounded, and this is how everything
    // behind it stays reachable.
    const before = /^\/api\/s\/([^/]+)\/before\/(\d+)$/.exec(path)
    if (req.method === 'GET' && before !== null) {
      const id = SessionId(decodeURIComponent(before[1] ?? ''))
      // The first paint keeps every conversation row in the log, so by default
      // this read skips them rather than drawing a second copy above the ones
      // already on screen. A client that painted from a cache written before
      // that rule existed says so, and gets the unfiltered chunk.
      return json(res, await earlier(ctx, id, Number(before[2]), url.searchParams.get('kept') !== '0'))
    }
    // The reply to one prompt, which a tap on that prompt merges in beneath it.
    const answered = /^\/api\/s\/([^/]+)\/reply\/(\d+)$/.exec(path)
    if (req.method === 'GET' && answered !== null) {
      const html = await reply(ctx, SessionId(decodeURIComponent(answered[1] ?? '')), Number(answered[2]))
      if (html === null) return json(res, { error: true, message: 'No such prompt', detail: path }, 404)
      return json(res, { html })
    }
    // `/t/12` is one run from its first tool event; `/t/12-30` also says where
    // that run ended, which a run that swallowed the narration between its calls
    // needs, since its extent is not derivable from its first seq alone.
    const runExpand = /^\/api\/s\/([^/]+)\/t\/(\d+)(?:-(\d+))?$/.exec(path)
    if (req.method === 'GET' && runExpand !== null) {
      const until = runExpand[3] === undefined ? null : Number(runExpand[3])
      const html = await expandedRun(ctx, SessionId(decodeURIComponent(runExpand[1] ?? '')), Number(runExpand[2]), until)
      if (html === null) return json(res, { error: true, message: 'No such tool call', detail: path }, 404)
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
        hub.questions.accepted,
      )
      return json(res, result)
    }
    if (req.method === 'POST' && path === '/api/answer') {
      const body = await readJson(req)
      const askId = String(body['askId'] ?? '')
      const result = await hub.questions.answer(askId, String(body['clientMessageId'] ?? ''), toAnswers(body['answers']))
      if (!result.ok) {
        return json(res, {
          error: true,
          // The refusal is not always a lost question, and the two cases read
          // completely differently to the person who just tapped Send. A
          // payload the harness would not accept leaves the question waiting,
          // so saying it is gone would send the reader away from a form that is
          // still open and still needs them.
          message: result.stillWaiting
            ? 'That answer was refused — the question is still waiting'
            : 'That question is no longer waiting for this answer',
          // The bridge's own words: it knows whether the harness refused it,
          // whether someone else answered first, or whether it could not be
          // reached at all, and a reader handing this to a developer needs which.
          detail: `ask ${askId}: ${result.reason}`,
          // Named rather than left for the page to infer from the status: a
          // refusal that leaves the ask pending must not clear the form, and
          // only the settling side knows which kind this was.
          stillWaiting: result.stillWaiting,
        }, 409)
      }
      return json(res, { accepted: true, duplicate: result.duplicate })
    }
    // The permission half of the same idea, against the host's other pending
    // table. Same style, same refusals: the bridge's own words travel out, so a
    // reader can tell a lost race from an unreachable harness.
    if (req.method === 'POST' && path === '/api/decide') {
      const body = await readJson(req)
      const askId = String(body['askId'] ?? '')
      const result = await hub.questions.settle(askId, String(body['clientMessageId'] ?? ''), toOutcome(body['outcome']))
      if (!result.ok) {
        return json(res, {
          error: true,
          message: result.stillWaiting
            ? 'That decision was refused — the request is still waiting'
            : 'That permission request is no longer waiting for this decision',
          detail: `approval ${askId}: ${result.reason}`,
          stillWaiting: result.stillWaiting,
        }, 409)
      }
      return json(res, { accepted: true, duplicate: result.duplicate })
    }
    // What a session is waiting on, named rather than rendered: the ids an
    // external tool needs to drive `/api/answer` and `/api/decide` without
    // scraping the page or opening the harness's own socket.
    //
    // The session is required even though the parameter is optional to supply,
    // because the alternative — every waiting question on the box — would make
    // this a wider disclosure than the page it mirrors, which reads asks one
    // session at a time. Read-only: nothing here settles or forgets an ask.
    if (req.method === 'GET' && path === '/api/pending') {
      const sessionId = url.searchParams.get('sessionId') ?? ''
      if (sessionId === '') {
        return json(res, {
          error: true,
          message: 'A sessionId is required to list pending questions',
          detail: 'GET /api/pending?sessionId=… — this endpoint is scoped to one session rather than listing every waiting question on this host',
        }, 400)
      }
      const { asks, approvals } = hub.questions.pendingOf(sessionId)
      return json(res, {
        sessionId,
        asks: asks.map(ask => ({
          askId: ask.askId,
          sessionId: ask.sessionId,
          // Which seam settles it: `onLocalAnswer` here, or `/api/respond` at
          // the harness. Nothing in the questions themselves says which.
          local: ask.local,
          questions: ask.questions.map(question => ({
            // The answer is one item per question keyed by this id, so it is
            // the one field a caller cannot do without.
            id: question.id,
            header: question.header ?? '',
            question: question.question,
            detail: question.detail ?? '',
            multiSelect: question.multiSelect === true,
            options: (question.options ?? []).map(option => option.label),
          })),
        })),
        approvals,
      })
    }
    if (req.method === 'POST' && path === '/api/archive') {
      const body = await readJson(req)
      // Hides the row; deletes nothing. The transcript stays readable at its own
      // URL, and an id already archived resolves without writing, so a retry
      // after a lost response is a no-op rather than an error.
      await hub.corpus.archive(String(body['sessionId'] ?? ''))
      return json(res, { accepted: true })
    }
    if (req.method === 'POST' && path === '/api/stop') {
      const body = await readJson(req)
      ctx.agents.get(SessionId(String(body['sessionId'] ?? '')))?.cancel({ kind: 'user' })
      return json(res, { accepted: true })
    }
    // ---- notifications ------------------------------------------------------
    //
    // The VAPID public key a browser needs to subscribe. Generated once and
    // persisted: a browser pins the key it subscribed with, so a key that
    // changed would silently orphan every install.
    if (req.method === 'GET' && path === '/api/push/key') {
      return json(res, { key: await hub.subscribers.publicKey() })
    }
    // Whether *this exact browser* is registered here. The page renders its
    // control from this and from nothing else, so a subscription the browser
    // kept but this server never recorded reads as off — which it is.
    if (req.method === 'GET' && path === '/api/push/status') {
      const endpoint = url.searchParams.get('endpoint') ?? ''
      return json(res, { subscribed: endpoint !== '' && await hub.subscribers.has(endpoint) })
    }
    if (req.method === 'POST' && path === '/api/push/subscribe') {
      const body = await readJson(req)
      const subscription = body['subscription']
      if (typeof subscription !== 'object' || subscription === null) {
        return json(res, { error: true, message: 'A push subscription is required', detail: 'body.subscription was not an object' }, 400)
      }
      const endpoint = String(Reflect.get(subscription, 'endpoint') ?? '')
      const keys = Reflect.get(subscription, 'keys')
      const p256dh = typeof keys === 'object' && keys !== null ? String(Reflect.get(keys, 'p256dh') ?? '') : ''
      const auth = typeof keys === 'object' && keys !== null ? String(Reflect.get(keys, 'auth') ?? '') : ''
      if (endpoint === '' || p256dh === '' || auth === '') {
        return json(res, {
          error: true,
          message: 'That push subscription is missing its keys',
          detail: `endpoint=${endpoint === '' ? '(empty)' : 'present'} p256dh=${p256dh === '' ? '(empty)' : 'present'} auth=${auth === '' ? '(empty)' : 'present'}`,
        }, 400)
      }
      // A rotated subscription names the endpoint it replaces, so the dead row
      // goes with the same write rather than lingering until it 410s.
      const replaces = String(body['replaces'] ?? '')
      if (replaces !== '' && replaces !== endpoint) await hub.subscribers.remove(replaces)
      await hub.subscribers.add({ endpoint, p256dh, auth, created: Date.now(), label: String(body['label'] ?? '') })
      return json(res, { subscribed: true })
    }
    if (req.method === 'POST' && path === '/api/push/unsubscribe') {
      const body = await readJson(req)
      await hub.subscribers.remove(String(body['endpoint'] ?? ''))
      return json(res, { subscribed: false })
    }
    // "This browser is looking at the page." Suppresses a notification for
    // something the reader can already watch happening in front of them.
    if (req.method === 'POST' && path === '/api/push/present') {
      const body = await readJson(req)
      hub.notifier.present(String(body['endpoint'] ?? ''))
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
  // Pick up a rebuild before rendering, so a client change is live on the next
  // page load instead of at the next process restart — a restart interrupts
  // every turn in flight. A scan that fails (a file vanishing mid-edit) must not
  // take the page down: the previous table is still consistent, so log and use it.
  await assets.refresh().catch((error: unknown) => {
    ctx.logger.warn(`web-gui: client asset refresh failed: ${errorChain(error)}`)
  })
  // A page whose client code cannot run is logged here as well as rendered into
  // the document: the notice is what the reader sees, and this is what an
  // operator watching the service sees. Logged per request rather than once,
  // because the condition persists until the missing module exists and a
  // silence after the first line is how it was missed before.
  for (const problem of unresolvedImports(assets)) {
    ctx.logger.warn(`web-gui: the page cannot run: no client/${problem.specifier}.js for the import map, which ${problem.module}.js imports`)
  }
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
 * @param questions - the source of questions sessions are waiting on.
 * @param url - the requested URL.
 * @returns the shell state for that route.
 */
async function resolve(ctx: Context, questions: AskSource, url: URL, corpus: Corpus): Promise<ShellState> {
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
      renderedThrough: -1,
      empty: false,
      // One event is not a transcript, so there is no history above it.
      more: false,
      oldest: -1,
      asks: [],
      approvals: [],
      showTools: false,
    }
  }
  const run = /^\/s\/([^/]+)\/t\/(\d+)(?:-(\d+))?$/.exec(url.pathname)
  if (run !== null) {
    const id = SessionId(decodeURIComponent(run[1] ?? ''))
    const seq = Number(run[2])
    const row = rows.find(candidate => candidate.id === id)
    const html = await expandedRun(ctx, id, seq, run[3] === undefined ? null : Number(run[3]))
    return {
      frames: html ?? '',
      sessionId: null,
      title: `Tool calls in ${row?.title ?? 'this session'}`,
      renderedThrough: -1,
      empty: false,
      // One run of tool calls is not a transcript either.
      more: false,
      oldest: -1,
      asks: [],
      approvals: [],
      showTools: false,
    }
  }
  const transcript = /^\/s\/([^/]+)/.exec(url.pathname)
  if (transcript === null) {
    return {
      frames: '',
      sessionId: null,
      title: 'Sessions',
      renderedThrough: -1,
      empty: false,
      // The list is not a transcript, so there is no history behind it.
      more: false,
      oldest: -1,
      asks: [],
      approvals: [],
      showTools: true,
    }
  }
  return await transcriptState(ctx, SessionId(decodeURIComponent(transcript[1] ?? '')), rows)
}

/**
 * Build the shell state for a transcript route.
 * @param ctx - the plugin context.
 * @param id - the focused session.
 * @param rows - the current summaries, for the title.
 * @returns the shell state.
 */
async function transcriptState(
  ctx: Context,
  id: SessionId,
  rows: readonly SessionSummary[],
): Promise<ShellState> {
  const row = rows.find(candidate => candidate.id === id)
  const { html, renderedThrough, empty, more, oldest } = await tail(ctx, id, -1)
  const asks = row?.asks ?? []
  return {
    frames: html,
    sessionId: id,
    title: row?.title ?? 'Session',
    renderedThrough,
    empty,
    more,
    oldest,
    asks,
    approvals: row?.approvals ?? [],
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
