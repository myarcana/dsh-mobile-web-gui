/**
 * The harness wire, as a client.
 *
 * Everything the standalone GUI needs already exists on the harness's own API,
 * so this module is a client of it rather than a new protocol: unary calls go to
 * `POST /api/<method>` as a `client-request` envelope, and the two browser
 * downlinks (`/api/events.mux`, `/api/events.host`) arrive as WebSockets.
 *
 * Two facts make this viable, both measured on this box rather than assumed:
 *
 * - `session.history` returns the **raw** `SessionEvent`s (`{event, view}`), and
 *   a durable `assistant/chunk` event is appended per token chunk, so a wire
 *   reader sees live text. The in-process plugin used `agent/assistant-stream`,
 *   which does not exist in this harness; the chunks are the real carrier.
 * - Reading a cold session does **not** wake an agent: `session.history` on a
 *   cold id left the harness's running-agent count unchanged.
 *
 * @module
 */

/** A failure the harness itself reported, as opposed to a transport fault. */
export class WireError extends Error {
  constructor (method, detail) {
    super(`${method}: ${detail}`)
    this.name = 'WireError'
    this.method = method
  }
}

/**
 * One connection to the harness, shared by every part of the GUI that needs it.
 *
 * The sockets are reconnected rather than replaced: a dropped downlink is the
 * normal case on a phone link, and the fix is to redial with backoff, not to
 * tear down the server that is already serving pages.
 */
export class Wire {
  #origin
  #listeners = new Map()
  #mux = undefined
  #host = undefined
  #closed = false
  #backoff = 1_000
  /** Per-session revision counter for the synthesized stream tier. */
  #revision = new Map()

  /**
   * @param origin - the harness's own origin, loopback by default.
   */
  constructor (origin) {
    this.#origin = origin.replace(/\/+$/, '')
  }

  /** The harness origin this wire dials. */
  get origin () {
    return this.#origin
  }

  /**
   * Subscribe to a forwarded wire event.
   * @param name - `session/event` or `agent/assistant-stream`.
   * @param fn - the listener.
   * @returns a disposer.
   */
  on (name, fn) {
    const list = this.#listeners.get(name) ?? []
    list.push(fn)
    this.#listeners.set(name, list)
    return () => {
      const current = this.#listeners.get(name) ?? []
      const at = current.indexOf(fn)
      if (at >= 0) current.splice(at, 1)
    }
  }

  #emit (name, ...args) {
    for (const fn of this.#listeners.get(name) ?? []) {
      try {
        fn(...args)
      } catch {
        // One bad listener must not stop the socket's message loop.
      }
    }
  }

  /**
   * Run one unary method.
   *
   * The envelope's `result.ok === false` branch is a real answer (the harness
   * refused the call), so it is raised as a `WireError` rather than a transport
   * error, and the caller's message is the harness's own words.
   * @param method - the wire method name, e.g. `session.list`.
   * @param payload - the method's payload.
   * @param signal - aborts the call.
   * @param rpcId - the call's id, defaulted when the caller does not care. A
   *   prompt supplies its own, because the harness stamps this exact value onto
   *   the durable `user/message` as `source.rpcId` — the only field of the
   *   browser's provenance that survives the gateway, whose prompt schema has no
   *   `clientMessageId` and mints `source.kind: 'user'` itself.
   * @returns the method's `value`.
   */
  async rpc (method, payload = {}, signal, rpcId = crypto.randomUUID()) {
    const res = await fetch(`${this.#origin}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      ...(signal === undefined ? {} : { signal }),
    })
    if (!res.ok) throw new WireError(method, `HTTP ${res.status}`)
    const body = await res.json().catch(() => undefined)
    const result = body?.result
    if (result === undefined) throw new WireError(method, 'no result in response')
    if (result.ok === false) {
      throw new WireError(method, `${result.error?.code ?? 'error'}: ${result.error?.message ?? ''}`)
    }
    return result.value
  }

  /** Open both downlinks and keep them open. */
  start () {
    this.#closed = false
    this.#openMux()
    this.#openHost()
    return this
  }

  /** Stop reconnecting and close both sockets. */
  stop () {
    this.#closed = true
    try { this.#mux?.close() } catch {}
    try { this.#host?.close() } catch {}
  }

  #schedule (open) {
    if (this.#closed) return
    const wait = this.#backoff
    this.#backoff = Math.min(this.#backoff * 2, 15_000)
    const timer = setTimeout(open, wait)
    timer.unref?.()
  }

  #openMux () {
    if (this.#closed) return
    let socket
    try {
      socket = new WebSocket(`${this.#origin.replace(/^http/, 'ws')}/api/events.mux`)
    } catch {
      this.#schedule(() => this.#openMux())
      return
    }
    this.#mux = socket
    socket.addEventListener('open', () => { this.#backoff = 1_000 })
    socket.addEventListener('message', event => {
      let envelope
      try {
        envelope = JSON.parse(event.data)
      } catch {
        return
      }
      const payload = envelope?.payload ?? envelope
      this.#dispatch(payload)
    })
    socket.addEventListener('close', () => this.#schedule(() => this.#openMux()))
    socket.addEventListener('error', () => {})
  }

  /**
   * Open the host downlink.
   *
   * Nothing consumes its frames yet; it is opened so the connection is warm for
   * the status pushes the list wants (`host/session-status`,
   * `host/archived-sessions-changed`) without a second round of work later.
   */
  #openHost () {
    if (this.#closed) return
    let socket
    try {
      socket = new WebSocket(`${this.#origin.replace(/^http/, 'ws')}/api/events.host`)
    } catch {
      this.#schedule(() => this.#openHost())
      return
    }
    this.#host = socket
    socket.addEventListener('message', event => {
      let envelope
      try {
        envelope = JSON.parse(event.data)
      } catch {
        return
      }
      this.#emit('host/frame', envelope?.payload ?? envelope)
    })
    socket.addEventListener('close', () => this.#schedule(() => this.#openHost()))
    socket.addEventListener('error', () => {})
  }

  /**
   * Fan one mux frame out.
   *
   * A `session/event` frame becomes both the durable event the plugin's corpus
   * folds and, when it is an `assistant/chunk`, a synthesized live-stream frame.
   * The plugin consumed `agent/assistant-stream`, which this harness never
   * emitted, so the token tier is rebuilt here from the chunks that do arrive:
   * that is the whole reason live text still streams after the split.
   * @param payload - the frame's payload.
   */
  #dispatch (payload) {
    if (payload === undefined || payload === null) return
    const type = payload.type
    if (type === 'session/event') {
      const session = { id: payload.sessionId }
      this.#emit('session/event', session, payload.event)
      this.#streamFrom(payload.sessionId, payload.event)
      return
    }
    // Everything else is passed through for whoever wants it; the corpus only
    // needs the durable event above.
    this.#emit(`mux/${type ?? 'unknown'}`, payload)
  }

  /**
   * Rebuild the live token tier from durable chunk events.
   * @param sessionId - the session producing text.
   * @param event - the durable event that arrived.
   */
  #streamFrom (sessionId, event) {
    if (event?.type !== 'assistant/chunk') return
    const chunk = event.data?.chunk
    if (chunk === undefined) return
    const agent = { session: { id: sessionId } }
    if (chunk.type === 'block-start') {
      // Only a text block produces live text; a reasoning or tool block has
      // nothing for the ephemeral line.
      if (chunk.blockType !== 'text') return
      const revision = (this.#revision.get(sessionId) ?? 0) + 1
      this.#revision.set(sessionId, revision)
      this.#emit('agent/assistant-stream', { agent, frame: { type: 'start', revision } })
      return
    }
    const revision = this.#revision.get(sessionId) ?? 0
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      this.#emit('agent/assistant-stream', {
        agent,
        frame: { type: 'chunk', revision, chunk: { type: 'text-delta', text: chunk.text } },
      })
      return
    }
    if (chunk.type === 'block-end') {
      this.#emit('agent/assistant-stream', { agent, frame: { type: 'end', revision } })
    }
  }
}
