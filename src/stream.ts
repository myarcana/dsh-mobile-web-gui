/**
 * One EventSource per client, multiplexed across every session.
 *
 * On a lossy link, N connections is N chances to be the one that fails, so
 * there is exactly one. Two tiers share it:
 *
 * - **Durable** `e` and `s` frames carry an SSE `id:`. The browser re-sends the
 *   last one as `Last-Event-ID` forever with no code on our side, so a dropped
 *   signal, a slept radio, and a discarded tab are one resume path.
 * - **Ephemeral** `t` token frames deliberately carry no `id:`. EventSource only
 *   advances its last-event-id on frames that have one, so live token text can
 *   never drag the durable cursor backwards. That is protocol behaviour, not a trick.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ServerResponse } from 'node:http'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { Corpus } from './corpus.ts'
import { Bridge } from './bridge.ts'
import { Notifier } from './notifier.ts'
import { Subscribers } from './subscribers.ts'
import { answeredNow, ASK_TOOL, renderEvent } from './render.ts'
import { tail } from './sessions.ts'

/** Live token flushes per second are what hurt on a bad link; coalesce to this. */
const FLUSH_MS = 250

/** Comment frames keep intermediaries from reaping an idle connection. */
const HEARTBEAT_MS = 15_000

/** One connected browser. */
interface Client {
  readonly res: ServerResponse
  /** The session whose durable frames and token text this client is being sent. */
  focus: SessionId | null
  /** Live token characters already sent for {@link focus}; reset on switch and resync. */
  sentOff: number
  /** Live revision this client's partial text belongs to. */
  revision: number
  /** Last summary watermark sent, which the compound cursor carries. */
  summarySeq: number
}

/** Live, un-committed assistant text for one session. Never durable, never replayed. */
interface Live {
  revision: number
  text: string
}

/**
 * The SSE hub: one subscription to the harness, fanned out to every client.
 */
export class StreamHub {
  /** Boot id. Durable seqs survive a restart; summary watermarks do not. */
  readonly epoch = Date.now().toString(36)

  /**
   * Questions browsers may answer; a change reaches every client as a summary refresh.
   *
   * The {@link Bridge} reads them from the harness's own provider seam rather
   * than holding them here, because on this harness the single provider slot
   * belongs to the native UI. The property keeps its name because every reader
   * of it asks the same two questions either way.
   */
  readonly questions: Bridge

  /** The session list, read from the whole corpus rather than from live agents. */
  readonly corpus: Corpus

  /** The browsers that asked to be told when a session stops and wants them. */
  readonly subscribers: Subscribers

  /** Turns listing changes into notifications for those browsers. */
  readonly notifier: Notifier

  private readonly clients = new Set<Client>()
  private readonly live = new Map<string, Live>()
  private summarySeq = 0
  /** Corpus version last broadcast, so an event that changed no row is not re-sent to every phone. */
  private sentVersion = -1
  private readonly ctx: Context
  private flushTimer: NodeJS.Timeout | undefined
  private beatTimer: NodeJS.Timeout | undefined

  /**
   * Subscribe to the harness once and fan out to connected clients.
   * @param ctx - the plugin context, whose disposal unsubscribes.
   * @param hostOrigin - the harness API's origin, which the question bridge attaches to.
   */
  constructor(ctx: Context, hostOrigin: string) {
    this.ctx = ctx
    // A question arriving or settling appends nothing to the log, so it pushes
    // its own refresh — and must force one, because the rows it changes (the
    // ask badges) are not derived from any log and so move no corpus version.
    this.questions = new Bridge(ctx, hostOrigin, () => { void this.refreshSummaries(true) })
    // The corpus refreshes on its own when a background read fills in a row,
    // which is how a cold session's content reaches the list without the first
    // paint waiting on a disk read for every session on the box.
    this.corpus = new Corpus(ctx, () => { void this.refreshSummaries() })
    this.subscribers = new Subscribers()
    this.notifier = new Notifier(ctx, this.subscribers)
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.corpus.noteEvent(session.id)
      this.onEvent(session.id, event, session)
    })
    ctx.on('agent/assistant-stream', payload => {
      this.onStreamFrame(payload.agent.session.id, payload.frame)
    })
    ctx.effect(() => () => {
      if (this.flushTimer !== undefined) clearInterval(this.flushTimer)
      if (this.beatTimer !== undefined) clearInterval(this.beatTimer)
      for (const client of this.clients) client.res.end()
      this.clients.clear()
    }, 'webGui.streamHub()')
  }

  /**
   * Attach one client and replay whatever its cursor says it missed.
   * @param res - the response to stream into.
   * @param lastEventId - the browser's `Last-Event-ID`, if it is resuming.
   * @param signal - aborted when the client goes away.
   */
  async attach(res: ServerResponse, lastEventId: string | undefined, signal: AbortSignal): Promise<void> {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      // SSE is never compressed: a compressor buffers, and a buffered frame is
      // an undelivered frame.
      'content-encoding': 'identity',
      'x-accel-buffering': 'no',
    })
    const resumed = parseCursor(lastEventId, this.epoch)
    const client: Client = {
      res,
      focus: resumed.focus,
      sentOff: 0,
      revision: 0,
      summarySeq: resumed.summarySeq,
    }
    this.clients.add(client)
    signal.addEventListener('abort', () => {
      this.clients.delete(client)
      res.end()
    }, { once: true })
    // The stream id lets the client move its focus without reopening the stream.
    res.write(`event: epoch\ndata: ${JSON.stringify({ epoch: this.epoch, streamId: idOf(res) })}\n\n`)
    // An epoch mismatch drops only the client's watermarks, so a server restart
    // becomes a visible non-event rather than a quiet divergence.
    await this.sendSummaries(client)
    if (client.focus !== null) await this.sendTail(client, client.focus, resumed.focusSeq)
    this.ensureTimers()
  }

  /**
   * Point one client's durable and token tiers at a different session.
   *
   * Focus moves in place rather than by reopening the stream: a reconnect is
   * the one thing you cannot afford on the link this design is built for.
   * @param res - the response identifying the client.
   * @param id - the session to focus.
   * @param from - the client's own `renderedThrough` for that session.
   */
  async focus(res: ServerResponse, id: SessionId, from: number): Promise<void> {
    for (const client of this.clients) {
      if (client.res !== res) continue
      client.focus = id
      client.sentOff = 0
      await this.sendTail(client, id, from)
    }
  }

  /**
   * Find the client owning a response, so a focus request can address it.
   * @param streamId - the id handed to the client when it attached.
   * @returns the matching response, or undefined when that stream is gone.
   */
  clientById(streamId: string): ServerResponse | undefined {
    for (const client of this.clients) {
      if (idOf(client.res) === streamId) return client.res
    }
    return undefined
  }

  /**
   * Fan one durable event out: a rendered frame to whoever is focused on that
   * session, and a summary refresh to everyone.
   * @param id - the session whose log grew.
   * @param event - the appended event.
   * @param session - the session it landed in, for pairing an answer to its question.
   */
  private onEvent(id: SessionId, event: SessionEvent, session: Session): void {
    // The durable message is the only thing that ends a hold. Released before
    // the frame is written, so the summary refresh below already reflects it and
    // no client can be told "sending" and "delivered" in the same breath.
    this.releaseAccepted(id, event)
    // No settled set: a call arriving live is by definition not settled yet, and
    // an ask therefore renders nothing here. Its row arrives from
    // `amendAnswered` below, on the result event that also drops the form.
    const html = renderEvent(event, id)
    if (html !== null) {
      for (const client of this.clients) {
        if (client.focus !== id) continue
        // The durable event supersedes any partial text for this session.
        client.sentOff = 0
        this.send(client, 'e', { sessionId: id, seq: event.seq, html }, cursor(this.epoch, client, id, event.seq))
      }
    }
    // An answer renders no frame of its own: it belongs on the question's form,
    // which is already on screen. Re-send that row with the choices ticked, so a
    // question answered while someone is watching settles into exactly the shape
    // a reload would give it.
    this.amendAnswered(id, event, session)
    this.live.delete(id)
    void this.refreshSummaries()
  }

  /**
   * Retire the in-flight key a durable message carries.
   *
   * This is the handover that makes the two states mutually exclusive: the key
   * stops being held at exactly the moment the transcript can show the message
   * as delivered. Nothing else releases a hold, so the page can never be left
   * rendering a prompt that is in neither state.
   * @param id - the session whose log grew.
   * @param event - the appended event, acted on only when it is a composed prompt.
   */
  private releaseAccepted(id: SessionId, event: SessionEvent): void {
    if (event.type !== 'user/message') return
    const source: { kind?: unknown; clientMessageId?: unknown } = event.data.source
    if (source.kind !== 'webgui' || typeof source.clientMessageId !== 'string') return
    this.questions.accepted.release(id, source.clientMessageId)
  }

  /**
   * Re-send an answered question's row once its result lands.
   * @param id - the session the answer landed in.
   * @param event - the appended event, which is only acted on when it is an ask result.
   * @param session - the session, read to find the call the answer belongs to.
   */
  private amendAnswered(id: SessionId, event: SessionEvent, session: Session): void {
    if (event.type !== 'tool/result') return
    const [block] = event.data.message.content
    if (block === undefined || block.type !== 'tool-result') return
    // The question is an earlier event in this same log, found by the call id the
    // result carries rather than by position: a nested run can put any number of
    // events between the two.
    const call = session.events.find(
      candidate => candidate.type === 'tool/call' && candidate.data.callId === block.toolCallId,
    )
    if (call === undefined) return
    // Only an ask has a row that changes when its result lands. Every other tool
    // call was already drawn as its own row when it arrived, and re-sending it
    // here made the client apply that row a second time: `append`'s amend branch
    // seats a row the log has no `data-seq` match for, so a call already folded
    // into a run was re-seated *beside* the line standing for it and counted
    // twice. A five-call run drew as nine, growing with every call.
    //
    // The old guard was `renderEvent(call, …) === null`, which reads as "only an
    // ask survives" but is the wrong test: it is passed the *call*, and an
    // ordinary tool call renders a perfectly good row. Ask the question the
    // frame actually depends on instead — is this the tool whose row is the
    // exchange itself?
    if (call.data.name !== ASK_TOOL) return
    // Read through `answeredNow` rather than `answerIndex`: this event has not
    // been persisted yet, so it carries no surface op and the log-scanning index
    // would reject it — redrawing the question with nothing ticked and the typed
    // answer missing until a reload. Not gated on there being answers either: a
    // cancelled or failed ask has been drawing nothing until now too, so it
    // needs this frame just as much. The guard above is what keeps this to asks
    // alone.
    const { answers, settled } = answeredNow(event, block.toolCallId)
    const html = renderEvent(call, id, answers, settled)
    if (html === null) return
    for (const client of this.clients) {
      if (client.focus !== id) continue
      // `amends` is still correct when the client has no such row yet: a waiting
      // ask renders nothing, so this is the row's first appearance and the
      // client inserts it at the call's own seq rather than at the bottom, which
      // is where a reload would put it. No cursor either way — the seq is behind
      // the stream's resume point and must not drag it back.
      this.send(client, 'e', { sessionId: id, seq: call.seq, amends: call.seq, html })
    }
  }

  /**
   * Accumulate live assistant text for the ephemeral tier.
   * @param id - the session producing the stream.
   * @param frame - one start, chunk, or end publication.
   */
  private onStreamFrame(id: SessionId, frame: AssistantStreamFrame): void {
    if (frame.type === 'start') {
      this.live.set(id, { revision: frame.revision, text: '' })
      return
    }
    if (frame.type === 'end') {
      // A committed end means the durable event is arriving; drop the partial
      // and let `session/event` render the real thing.
      this.live.delete(id)
      return
    }
    const entry = this.live.get(id)
    if (entry === undefined) return
    if (frame.revision !== entry.revision) {
      // Replacement restarted the revision; older text is invalid.
      entry.revision = frame.revision
      entry.text = ''
      for (const client of this.clients) if (client.focus === id) client.sentOff = 0
    }
    if (frame.chunk.type === 'text-delta') entry.text += frame.chunk.text
  }

  /**
   * Send each client the live text it has not seen yet, as an offset snapshot.
   *
   * Snapshots rather than deltas: a dropped frame then costs nothing, because
   * the next one re-states its own starting offset and the client resyncs.
   */
  private flush(): void {
    for (const client of this.clients) {
      if (client.focus === null) continue
      const entry = this.live.get(client.focus)
      if (entry === undefined || entry.text.length <= client.sentOff) continue
      const off = client.sentOff
      this.send(client, 't', {
        sessionId: client.focus,
        revision: entry.revision,
        off,
        s: entry.text.slice(off),
      })
      client.sentOff = entry.text.length
    }
  }

  /**
   * Push the session list to every client now.
   *
   * For a change that happened outside the log: a session or workspace was just
   * created, so the corpus version did not move and the next no-op event would
   * not have carried it. The reader who tapped the button is owed the row that
   * answers their tap, on this frame rather than the next unrelated one.
   */
  notify(): void {
    void this.refreshSummaries(true)
  }

  /**
   * Recompute and broadcast session summaries.
   */
  private async refreshSummaries(force = false): Promise<void> {
    // Notifications are the reason this no longer returns early on an empty
    // client set. The whole point of a push notification is to reach a reader
    // who has *no page open*, which is precisely when `clients` is empty — so
    // skipping the fold here would have switched the feature off in exactly the
    // case it exists for. The listing is still only recomputed when something
    // actually changed, and with nobody connected there is nothing to send it
    // to, so the cost of getting here is one corpus read.
    const watching = this.clients.size > 0
    // A session event that changed no visible row (a tool event on a session
    // nobody has opened, say) must not cost every client a full re-list.
    if (!force && this.corpus.version === this.sentVersion) return
    this.sentVersion = this.corpus.version
    this.summarySeq += 1
    const listing = await this.corpus.listing(this.questions)
    // Before the send, so a reader whose phone is asleep and whose tab is long
    // gone is told at the same moment a connected one would have seen the dot
    // change. Never awaited: delivery crosses the public internet to a push
    // service, and the broadcast below must not wait on it.
    this.notifier.observe(listing.rows)
    if (!watching) return
    for (const client of this.clients) {
      client.summarySeq = this.summarySeq
      this.send(client, 's', listing, cursor(this.epoch, client, client.focus, null))
    }
  }

  /**
   * Send one client the current summary set.
   * @param client - the client to update.
   */
  private async sendSummaries(client: Client): Promise<void> {
    client.summarySeq = this.summarySeq
    // This client just received the current rows, so the next no-op event must
    // not re-broadcast them to everyone.
    this.sentVersion = this.corpus.version
    this.send(client, 's', await this.corpus.listing(this.questions), cursor(this.epoch, client, client.focus, null))
  }

  /**
   * Send one client the durable frames it is missing for a session.
   * @param client - the client to catch up.
   * @param id - the session being read.
   * @param from - exclusive lower bound the client already holds.
   */
  private async sendTail(client: Client, id: SessionId, from: number): Promise<void> {
    const { html, renderedThrough, empty, more, oldest } = await tail(this.ctx, id, from)
    // `more` rides the replace frame for the same reason `empty` does: only a
    // whole-tail read repaints the log, and only it can say what sits behind
    // the window it just painted. `oldest` rides with it because a replace
    // throws away any history already prepended, so the page's bound for reading
    // further back has to be restated from the window that replaced it — and the
    // page cannot derive it, since a kept prompt puts the log's first message on
    // screen with the work behind it still unread.
    this.send(client, 'e', { sessionId: id, seq: renderedThrough, html, replace: from < 0, empty, more, oldest },
      cursor(this.epoch, client, id, renderedThrough))
  }

  /**
   * Write one frame.
   * @param client - the recipient.
   * @param event - the SSE event name.
   * @param data - the payload, serialized as JSON.
   * @param id - the compound cursor, omitted for ephemeral frames.
   */
  private send(client: Client, event: string, data: unknown, id?: string): void {
    const head = id === undefined ? '' : `id: ${id}\n`
    client.res.write(`${head}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  /**
   * Start the shared flush and heartbeat timers once a client exists.
   *
   * Both are shared across every client and stop when the last one leaves, so
   * an idle server holds no timers at all.
   */
  private ensureTimers(): void {
    this.flushTimer ??= setInterval(() => {
      if (this.clients.size === 0) return
      this.flush()
    }, FLUSH_MS)
    this.beatTimer ??= setInterval(() => {
      for (const client of this.clients) client.res.write(':hb\n\n')
    }, HEARTBEAT_MS)
  }
}

/**
 * Build the compound cursor.
 *
 * Compound rather than per-session so it does not grow with session count.
 * @param epoch - the server's boot id.
 * @param client - the client whose watermarks are encoded.
 * @param focus - the focused session, if any.
 * @param seq - the focused session's position, or null to keep the client's.
 * @returns the `id:` value for a durable frame.
 */
function cursor(epoch: string, client: Client, focus: SessionId | null, seq: number | null): string {
  const focusSeq = seq ?? -1
  return `${epoch}.${client.summarySeq}.${focus ?? ''}:${focusSeq}`
}

/**
 * Parse a resuming client's `Last-Event-ID`.
 * @param raw - the header value, absent on a first connection.
 * @param epoch - the server's current boot id.
 * @returns the watermarks to resume from; an epoch mismatch keeps the transcript cursor and drops the rest.
 */
function parseCursor(
  raw: string | undefined,
  epoch: string,
): { focus: SessionId | null; focusSeq: number; summarySeq: number } {
  const empty = { focus: null, focusSeq: -1, summarySeq: 0 }
  if (raw === undefined || raw === '') return empty
  const [head, summary, rest] = raw.split('.')
  if (head === undefined || summary === undefined || rest === undefined) return empty
  const separator = rest.lastIndexOf(':')
  if (separator < 0) return empty
  const id = rest.slice(0, separator)
  const seq = Number.parseInt(rest.slice(separator + 1), 10)
  return {
    focus: id === '' ? null : SessionId(id),
    focusSeq: Number.isSafeInteger(seq) ? seq : -1,
    // Durable seqs survive a restart; summary watermarks do not.
    summarySeq: head === epoch ? Number.parseInt(summary, 10) || 0 : 0,
  }
}

/**
 * Identify one connected response, so focus requests can name their own stream.
 * @param res - the streaming response.
 * @returns a stable per-connection id.
 */
export function idOf(res: ServerResponse): string {
  const carrier: { webGuiStreamId?: string } = res
  carrier.webGuiStreamId ??= Math.random().toString(36).slice(2)
  return carrier.webGuiStreamId
}
