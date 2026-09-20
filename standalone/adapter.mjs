/**
 * The plugin's host context, rebuilt over the harness wire.
 *
 * The GUI was an in-process cordis plugin because three seams "only exist
 * in-process". Two of those claims do not hold on this harness, and the third
 * was already false:
 *
 * - `sessionQuery.readSession` is `session.history` on the wire, and it returns
 *   the same **raw** `SessionEvent`s, for a live or a cold session alike.
 * - `session/event` is the `session/event` mux frame, forwarded to every
 *   consumer of `/api/events.mux`.
 * - `agent/assistant-stream` is not a harness event at all. The token tier was
 *   rebuilt here from the durable `assistant/chunk` events that the agent loop
 *   really appends, so live text survives the split.
 *
 * This module is the mirror image of `mock/server.js`: the same duck-typed
 * context the plugin already runs against, backed by the real harness instead of
 * a fake. Nothing in `src/` changes.
 *
 * @module
 */

import { Wire } from './wire.mjs'
import { LogStore } from './logstore.mjs'

/** The harness's own default project directory, used when nothing names one. */
const NO_CWD = ''

/**
 * The shape a prompt key must have to be sent as an `rpcId`.
 *
 * Deliberately the same alphabet `src/accepted.ts` validates against, so a key
 * this forwards is one the renderer will echo rather than drop. A value outside
 * it falls back to a fresh random id: the prompt still sends, it simply carries
 * no key, which is a visible "Queued" rather than a silent mismatch.
 */
const RPC_KEY = /^[A-Za-z0-9-]{8,128}$/

/**
 * Build the context the plugin's own modules expect.
 *
 * @param options - where the harness lives, and where logs go.
 * @returns the context, plus the handles a caller needs to start and stop it.
 */
export function createContext ({ origin, logger = console, storeRoot = '/root/.dsh/sessions' }) {
  const wire = new Wire(origin)
  const logs = new LogStore(storeRoot)
  const hooks = new Map()
  /** Sessions the harness holds a live agent for. Optimistic on create/resume. */
  const live = new Set()
  /** Session id to the header the listing showed, so a read has a fallback. */
  const headers = new Map()
  /** Session ids currently running, from the list and from status frames. */
  const running = new Set()

  let workspaces = []
  let archived = new Set()

  const emit = (name, ...args) => {
    for (const fn of hooks.get(name) ?? []) {
      try {
        fn(...args)
      } catch (error) {
        logger.warn?.(`adapter: listener for ${name} failed: ${String(error)}`)
      }
    }
  }

  // The durable feed and the synthesized token tier both reach the plugin
  // through the same two names it subscribed to in-process, so `stream.ts` and
  // `corpus.ts` need no change.
  wire.on('session/event', (session, event) => emit('session/event', session, event))
  wire.on('agent/assistant-stream', payload => emit('agent/assistant-stream', payload))
  wire.on('host/frame', frame => {
    // Status pushes keep `running` honest between list refreshes.
    if (frame?.type === 'host/session-status' && typeof frame.sessionId === 'string') {
      if (frame.running === true) {
        running.add(frame.sessionId)
        live.add(frame.sessionId)
      } else if (frame.running === false) {
        running.delete(frame.sessionId)
      }
      emit('session/status', frame.sessionId, frame.running === true)
    }
    if (frame?.type === 'host/archived-sessions-changed' && Array.isArray(frame.archivedSessionIds)) {
      archived = new Set(frame.archivedSessionIds)
      emit('workspace/changed')
    }
  })

  /**
   * Map one wire list item to the header shape the plugin folds.
   *
   * `origin` is carried through as well as the identity fields, because the
   * listing filters subagent rows with it. Unlike `createdAt` and `cwd` — which
   * the wire summary only approximates, which is why the disk header is
   * preferred for those — the wire's `origin` is a straight `header.origin`
   * passthrough (measured against a live list: 73 items carried it, matching the
   * 73 logs carrying it on disk). So this path can and does stamp the
   * discriminator, which matters when a log is absent or unreadable and the disk
   * header is undefined: the wire fallback alone still hides the child.
   *
   * The harness's summary type has no `delegationDepth`, so the second signal is
   * only available from the disk header.
   */
  const headerOf = item => ({
    id: item.sessionId,
    // `createdAt` is not on the wire summary; `updatedAt` is the later of
    // creation and the last prompt, which is the better "when" for a row, and
    // an event-derived time supersedes it whenever the log is read.
    createdAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
    cwd: typeof item.cwd === 'string' ? item.cwd : NO_CWD,
    ...(item.origin === 'subagent' ? { origin: 'subagent' } : {}),
    // The listing's ancestor walk needs the parent link; the wire names it
    // `parentSessionId` where the durable header says `parentSession`.
    ...(typeof item.parentSessionId === 'string' ? { parentSession: item.parentSessionId } : {}),
  })

  /**
   * Re-read the workspace registry and the archive set.
   *
   * Fail-soft on purpose. The harness restarts on its own schedule, and this
   * process must survive that rather than exit and take the page down with it:
   * a failed refresh leaves the last known registry in place, and the next
   * successful call corrects it.
   * @returns true when the registry was re-read.
   */
  async function refreshWorkspaces () {
    try {
      const value = await wire.rpc('workspace.list', {})
      workspaces = (value?.items ?? []).map(w => ({
        id: w.workspaceId,
        title: w.title,
        path: w.path,
        sessionIds: [...(w.sessionIds ?? [])],
        // The harness files a session under its workspace itself when the create
        // names one, so there is nothing for this side to attach.
        async attachSession () {},
      }))
      archived = new Set(value?.archivedSessionIds ?? [])
      return true
    } catch (error) {
      logger.warn?.(`adapter: workspace.list failed, keeping the last known registry: ${String(error)}`)
      return false
    }
  }

  /**
   * Mark the sessions the harness is already running.
   *
   * Fail-soft and fire-and-forget: a failure leaves every row reading as idle,
   * which the next `host/session-status` frame corrects, and must never stop
   * this process from serving the list it can already build from disk.
   * @returns nothing; the result lands in `running` and is broadcast.
   */
  async function seedRunning () {
    try {
      const value = await wire.rpc('session.list', {})
      for (const item of value?.items ?? []) {
        if (item?.running !== true || typeof item.sessionId !== 'string') continue
        running.add(item.sessionId)
        live.add(item.sessionId)
      }
      // The rows were already served as idle, so the corrected running marks
      // have to be pushed. One broadcast for the whole seed, not one per
      // session: the listing is rebuilt from scratch either way.
      //
      // Deferred a tick because `ready()` starts this before the caller has
      // built the hub and subscribed; emitting synchronously would fire into no
      // listener and the seed would be silently invisible until the next event.
      setTimeout(() => emit('sessions/changed'), 0).unref?.()
    } catch (error) {
      logger.warn?.(`adapter: session.list failed while seeding running state: ${String(error)}`)
    }
  }

  const registry = {
    list: () => workspaces.slice(),
    get: id => workspaces.find(w => w.id === id),
    get archivedSessionIds () {
      return [...archived]
    },
    async refresh () {
      await refreshWorkspaces()
    },
    async create (path) {
      const value = await wire.rpc('workspace.create', { path })
      await refreshWorkspaces()
      return registry.get(value?.workspaceId) ?? {
        id: value?.workspaceId ?? '',
        title: path.split('/').filter(Boolean).pop() ?? path,
        path,
        sessionIds: [],
        async attachSession () {},
      }
    },
    async archiveSession (sessionId) {
      await wire.rpc('workspace.archiveSession', { sessionId })
      archived.add(sessionId)
    },
  }

  /**
   * One session's read, as the raw events the renderer consumes.
   *
   * Served from the log files on disk rather than over the wire. Both give the
   * same raw events (verified: this reader and `session.history` agree exactly
   * on event and chunk counts for the same session), but the wire path makes the
   * harness serialize every transcript it is asked for — 135 MB and 49 s of its
   * CPU across one 90-session listing, which is the starvation this process
   * exists to remove. A disk read costs this process a few milliseconds.
   *
   * The wire is still the fallback for a session with no log this process can
   * reach, so a mounted-elsewhere store degrades to slower rather than empty.
   */
  async function readSession (id) {
    const local = await logs.read(id)
    if (local.events.length > 0 || local.header !== undefined) {
      const header = local.header ?? headers.get(id) ?? { id, createdAt: Date.now(), cwd: NO_CWD }
      if (local.header !== undefined) headers.set(id, local.header)
      return { session: header, events: local.events }
    }
    const value = await wire.rpc('session.history', { sessionId: id })
    const events = (value?.events ?? []).map(entry => entry?.event ?? entry)
    const header = headers.get(id) ?? { id, createdAt: Date.now(), cwd: NO_CWD }
    return { session: header, events }
  }

  /**
   * The agent object the plugin asks for.
   *
   * `undefined` for a session with no live agent — which is every session after
   * a harness restart — because that is what makes `ensureLive` resume it. A
   * session this process has created or resumed is live immediately, matching
   * the harness, where the agent exists as soon as the call returns.
   */
  const agentFor = id => {
    if (!live.has(id)) return undefined
    const controller = new AbortController()
    return {
      session: {
        id,
        get header () {
          return headers.get(id) ?? { id, createdAt: Date.now(), cwd: NO_CWD }
        },
        // Deliberately absent: a live log is not readable from here, so the
        // corpus falls through to the wire read rather than to a stale object.
        get events () {
          return undefined
        },
      },
      get status () {
        return running.has(id) ? 'running' : 'idle'
      },
      get inbox () {
        return { nextTurn: [], nextStep: [] }
      },
      // `steer` is what `send` calls, so that a prompt typed while the session is
      // working reaches it at the next step boundary instead of after the whole
      // turn. Over the wire that is the gateway's own `mode`, which takes
      // 'queue' (its `agent.followup`) or 'steer' (its `agent.steer`) — so the
      // route survives the hop rather than being flattened back to queueing here.
      async steer (message) {
        const content = (message?.content ?? [{ type: 'text', text: '' }]).map(part =>
          part.type === 'text' ? { type: 'text', text: part.text } : part)
        // The browser's key has to come back on the durable message, or the page
        // can never retire the optimistic copy and the prompt sits under
        // "Queued" forever beside its own delivered twin.
        //
        // It cannot ride `source`: the gateway's prompt schema is a plain
        // `z.object` with no such field, and it mints `source.kind: 'user'`
        // itself, so anything passed here is dropped. What it *does* preserve is
        // the envelope's `rpcId`, stamped verbatim onto the event as
        // `source.rpcId`. So the key becomes the rpcId, and `sourceKey` reads it
        // back off the event — a round trip through the one field that survives.
        const key = message?.source?.clientMessageId
        await wire.rpc('session.prompt', { sessionId: id, mode: 'steer', content }, undefined,
          typeof key === 'string' && RPC_KEY.test(key) ? key : undefined)
      },
      cancel () {
        return wire.rpc('session.cancel', { sessionId: id }).catch(() => undefined)
      },
      signal: controller.signal,
    }
  }

  const ctx = {
    logger,
    wire,
    workspaces: registry,

    effect (fn) {
      const disposer = fn()
      return typeof disposer === 'function' ? disposer : () => {}
    },

    get (name) {
      return ctx[name]
    },

    inject (names, callback) {
      const child = Object.assign(Object.create(null), ctx)
      for (const name of names) child[name] = ctx[name]
      callback(child)
      return () => true
    },

    on (name, listener) {
      const list = hooks.get(name) ?? []
      list.push(listener)
      hooks.set(name, list)
      return () => {
        const current = hooks.get(name) ?? []
        const at = current.indexOf(listener)
        if (at >= 0) current.splice(at, 1)
      }
    },

    agents: {
      get: agentFor,
      // Every session the harness knows is already in `sessionQuery.listSessions`,
      // so there is no separate live-only roster to merge here.
      roots: () => [],
      create: async () => {
        throw new Error('adapter: agents.create is not the create path (use apiProxy.sessions.create)')
      },
      resume: async () => {
        throw new Error('adapter: agents.resume is not the resume path (use apiProxy.sessions.create)')
      },
    },

    sessionQuery: {
      /**
       * Every session that exists, read from the store on disk.
       *
       * The wire's `session.list` is deliberately **not** on this path. It
       * answers the same question far more slowly and far more expensively: it
       * costs the harness a serialization of every session's projections —
       * measured at 249 KB, 84% of it `sessionStats`, `tokenUsage` and
       * `contextPressure` that no row on this list renders — and it was measured
       * at 1.8 s idle and 7.9 s while the harness was running a turn, because
       * the call is served from the same loop the turn is using. Reading the
       * store answers it in ~100 ms without touching the harness at all.
       *
       * The store is the better authority anyway. The listing needs ids,
       * `createdAt`, `cwd`, `origin` and `parentSession`; the durable header
       * carries all five exactly, where the wire summary only approximates
       * `createdAt` (it sends `updatedAt`) and omits `delegationDepth`
       * altogether. Verified against this box: all 174 logs resolve a header,
       * and `origin`/`parentSession` land on the same 76 rows either way.
       *
       * Which sessions are *running* is the one fact a log cannot hold, and it
       * does not come from here: `host/session-status` frames maintain `running`
       * live, which is strictly fresher than a value sampled once per list.
       */
      async listSessions () {
        // Directory contents are the only thing that can have changed; parsed
        // headers survive it, because a header is written once and never rewritten.
        logs.rescan()
        const records = []
        for (const id of logs.ids()) {
          const header = logs.header(id) ?? headers.get(id)
          if (header === undefined) continue
          headers.set(id, header)
          records.push({ header, live: running.has(id), persisted: true })
        }
        // A session the harness holds but the store has not flushed a log for
        // yet — a just-created one — would otherwise vanish from the list until
        // its first write lands.
        const seen = new Set(records.map(record => record.header.id))
        for (const id of live) {
          if (seen.has(id)) continue
          const header = headers.get(id)
          if (header !== undefined) records.push({ header, live: running.has(id), persisted: false })
        }
        return records
      },
      readSession,
    },

    // The create/resume door, exactly as the harness exposes it. A create with a
    // known id is a resume, so this is both.
    apiProxy: {
      sessions: {
        async create ({ payload }) {
          const value = await wire.rpc('session.create', payload ?? {})
          const id = value?.sessionId
          if (typeof id === 'string') {
            // `live`, never `running`. A create composes an agent; it does not
            // start a turn. The session must stay addressable and must not
            // vanish from the list before its first write, but nothing has run
            // yet, so it reads idle until the reader prompts it.
            //
            // Marking it running here was optimistic and had nothing to clear
            // it: `host/session-status` reports *transitions*, so a session that
            // was never running announces no true→false and the row kept a
            // "Working" it never earned until this process restarted.
            live.add(id)
            if (!headers.has(id)) {
              headers.set(id, { id, createdAt: Date.now(), cwd: payload?.cwd ?? NO_CWD })
            }
          }
          return { rpcId: crypto.randomUUID(), result: { ok: true, value } }
        },
        async cancel ({ payload }) {
          return { rpcId: crypto.randomUUID(), result: { ok: true, value: await wire.rpc('session.cancel', payload ?? {}) } }
        },
      },
    },

    workspaceRegistry: registry,

    directoryPicker: {
      capability: () => ({
        kind: 'browse',
        list: path => wire.rpc('host.listDirectory', path === undefined ? {} : { path }),
        create: (path, name) => wire.rpc('host.createDirectory', { path, name }),
      }),
    },

    // `ask_user_question` has a single provider slot and the native UI holds it.
    // The GUI reaches questions through `Bridge` instead, so a registration here
    // would be a bug worth hearing about rather than a silent no-op.
    userQuestions: {
      registerProvider () {
        throw new Error('DUPLICATE_PROVIDER: the native UI holds the question provider slot')
      },
    },
  }

  return {
    ctx,
    wire,
    logs,
    /** Load the registry before the first page is served, and keep it fresh. */
    async ready () {
      wire.start()
      await refreshWorkspaces()
      // Which sessions are already running, once, at boot.
      //
      // `host/session-status` frames report *transitions*, so a session that was
      // already running before this process connected would never be announced
      // and would read as idle until it next changed state. This is the only
      // `session.list` call left, and it is off the request path: it is not
      // awaited, so a harness busy with a turn delays the running marks rather
      // than the first page.
      void seedRunning()
      // The registry is re-read on a timer as well as on a host frame, so a
      // dropped downlink cannot leave the workspace list permanently stale.
      const tick = setInterval(() => { void refreshWorkspaces() }, 60_000)
      tick.unref?.()
      return tick
    },
    async stop () {
      wire.stop()
    },
  }
}
