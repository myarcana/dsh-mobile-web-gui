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
import { Questions } from './questions.ts'
import { renderEvent } from './render.ts'
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

  /** Questions held for browsers to answer; a change reaches every client as a summary refresh. */
  readonly questions: Questions

  /** The session list, read from the whole corpus rather than from live agents. */
  readonly corpus: Corpus

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
   */
  constructor(ctx: Context) {
    this.ctx = ctx
    // A question arriving or settling appends nothing to the log, so it pushes
    // its own refresh — and must force one, because the rows it changes (the
    // ask badges) are not derived from any log and so move no corpus version.
    this.questions = new Questions(ctx, () => { void this.refreshSummaries(true) })
    // The corpus refreshes on its own when a background read fills in a row,
    // which is how a cold session's content reaches the list without the first
    // paint waiting on a disk read for every session on the box.
    this.corpus = new Corpus(ctx, () => { void this.refreshSummaries() })
    ctx.on('session/event', (session: Session, event: SessionEvent) => {
      this.corpus.noteEvent(session.id)
      this.onEvent(session.id, event)
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
   */
  private onEvent(id: SessionId, event: SessionEvent): void {
    const html = renderEvent(event, id)
    if (html !== null) {
      for (const client of this.clients) {
        if (client.focus !== id) continue
        // The durable event supersedes any partial text for this session.
        client.sentOff = 0
        this.send(client, 'e', { sessionId: id, seq: event.seq, html }, cursor(this.epoch, client, id, event.seq))
      }
    }
    this.live.delete(id)
    void this.refreshSummaries()
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
    if (this.clients.size === 0) return
    // A session event that changed no visible row (a tool event on a session
    // nobody has opened, say) must not cost every client a full re-list.
    if (!force && this.corpus.version === this.sentVersion) return
    this.sentVersion = this.corpus.version
    this.summarySeq += 1
    const listing = await this.corpus.listing(this.questions)
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
    const { html, renderedThrough } = await tail(this.ctx, id, from)
    this.send(client, 'e', { sessionId: id, seq: renderedThrough, html, replace: from < 0 },
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
