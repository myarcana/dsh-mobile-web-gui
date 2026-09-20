/**
 * The link to the harness's own question seam.
 *
 * `ask_user_question` on this harness (0.1.1-rc.1) is a *service* with a single
 * provider slot — `ctx.userQuestions.registerProvider({ ask })` — and that slot
 * is already held by `@deepseek-ai/dsh-host-apiproxy`, which serves the native
 * web UI. Registering a second provider throws `DUPLICATE_PROVIDER`, and
 * winning the race instead would take every question away from the native UI.
 * So this GUI is a *second head on the same seam* rather than a competing
 * provider: it reads the questions apiproxy is already broadcasting and settles
 * them through the same endpoint the native UI posts to.
 *
 * Two halves, both on the host's own API:
 *
 * - **Intake** is `GET /api/events.mux`, a WebSocket on this deployment
 *   (`dsh-client-connection` answers a plain GET with 426). It carries
 *   `question/requested` frames naming an `rpcId`, the session, and the
 *   questions — and, on the same socket, `approval/requested` frames naming an
 *   `rpcId`, the session, the tool, and the reason.
 * - **Settling** is `POST /api/respond` with a `client-response` envelope
 *   echoing that `rpcId`. Questions and permissions are two pending tables on
 *   the host, so `respond` routes on the `rpcId` and then validates each against
 *   its own payload shape.
 *
 * A permission request carries **two** ids and they are not interchangeable:
 * the envelope `rpcId` keys the host's pending table and is what `respond` is
 * addressed with, while the payload `approvalId` is the host's own audit id and
 * is what the response value must echo back. The captured frame on this box has
 * them different (`ccfc9d80…` against `4e98e5ba…`), so both are kept: the client
 * answers with the envelope id, and the payload id is quoted in the response
 * body and used to match the `approval/resolved` frame, whose payload carries
 * `approvalId` rather than the envelope id. Sending the envelope id where the
 * payload id belongs is exactly the kind of mistake the host answers with
 * `bad-response`, silently, so the difference is spelled out here rather than
 * guessed at.
 *
 * The `rpcId` lives only in apiproxy's memory and appears in no session log, so
 * a waiting question cannot survive a harness restart. That is the harness's
 * limit, not this plugin's, and the UI must not promise otherwise.
 *
 * Whoever answers first wins: apiproxy deletes the pending entry before
 * settling it, so this GUI and the native UI answering at once is safe. The
 * loser is told `not-pending`, which reads as "already answered" rather than as
 * a failure.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswerItem } from '@deepseek-ai/dsh-user-questions'
import { Accepted } from './accepted.ts'
import type { PendingApproval, PendingAsk } from './types.ts'

/** How long a dropped socket waits before redialling, and the ceiling it backs off to. */
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 15_000

/**
 * The only two outcomes a client may send.
 *
 * The host's own vocabulary also has `cancelled` and `unavailable`, but those
 * arise from the request's own signal and from a missing answerer, never from a
 * tap, so a client cannot send them and the UI must not offer them.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected'

/** One question this GUI has seen and not yet seen settled. */
interface Live extends PendingAsk {
  readonly sessionId: string
}

/**
 * One permission this GUI has seen and not yet seen settled.
 *
 * Holds both ids the host sends, because they do different jobs: {@link askId}
 * (the envelope `rpcId`) addresses `respond`, and {@link approvalId} is echoed
 * in the response value and named by the `approval/resolved` frame.
 */
interface LiveApproval extends PendingApproval {
  readonly sessionId: string
  /** The host's own approval id, distinct from the envelope {@link PendingApproval.askId}. */
  readonly approvalId: string
}

/**
 * One waiting ask, as {@link Bridge.pendingOf} describes it.
 *
 * Carries what {@link PendingAsk} leaves out because the browser does not need
 * it: the session, and which seam settles the ask.
 */
export interface PendingAskIdentity {
  /** The harness's rpcId, which is the value `/api/answer` takes. */
  readonly askId: string
  readonly sessionId: string
  /** True when it settles via `onLocalAnswer` here; false when it goes to `/api/respond`. */
  readonly local: boolean
  readonly questions: PendingAsk['questions']
}

/** One waiting permission, as {@link Bridge.pendingOf} describes it. */
export interface PendingApprovalIdentity {
  /** The envelope rpcId, which is the value `/api/decide` takes. */
  readonly askId: string
  readonly sessionId: string
  /** The host's own audit id, distinct from {@link askId}. */
  readonly approvalId: string
}

/** What {@link Bridge.answer} reports back to the route. */
export type Settled =
  | { readonly ok: true; readonly duplicate: boolean }
  | {
      readonly ok: false
      readonly reason: string
      /**
       * Whether the ask is still waiting after this refusal.
       *
       * A refusal is not always a lost question. The host answers
       * `bad-response` when it will not accept the *payload* — the question is
       * untouched and still waiting — and `not-pending` when it no longer holds
       * the question at all. Those two want opposite things from the reader:
       * correct the answer and resend, versus give up because it is gone. The
       * route words its message from this rather than from the failure alone,
       * because telling someone a still-open question has gone is worse than
       * saying nothing.
       */
      readonly stillWaiting: boolean
    }

/**
 * Mirror of the questions the harness is waiting on, and the way to settle them.
 *
 * Deliberately shaped like the `Questions` class it replaces, so the rest of the
 * plugin keeps asking the same two things: what is this session waiting on, and
 * settle this ask. The difference is only where the truth lives — here it is the
 * host's, not this process's.
 */
export class Bridge {
  private readonly ctx: Context
  private readonly origin: string
  private readonly changed: () => void
  /** askId (the host's rpcId) to the question waiting under it. */
  private readonly live = new Map<string, Live>()
  /**
   * Asks already settled from this GUI, and the outbox key that settled each.
   *
   * A resend after a lost response must read as a duplicate rather than as a
   * refusal, exactly as the prompt path does — the network dropping a response
   * is not the user asking twice.
   */
  private readonly settled = new Map<string, string>()
  /**
   * Asks raised in this process by {@link hold} rather than mirrored from a host.
   *
   * Answered by calling {@link onLocalAnswer} instead of posting to the host,
   * because there is no host to post to: the promise is here.
   */
  private readonly local = new Set<string>()
  /** How a locally-held ask is settled; set by the host that raised it. */
  onLocalAnswer: ((askId: string, answers: AskUserQuestionAnswerItem[]) => boolean) | undefined
  /** askId (the host's rpcId) to the permission waiting under it. */
  private readonly approvals = new Map<string, LiveApproval>()
  /** Permissions already settled from this GUI, keyed by the outbox key that settled them. */
  private readonly settledApprovals = new Map<string, string>()
  /** Permissions raised in this process by {@link holdApproval} rather than mirrored from a host. */
  private readonly localApprovals = new Set<string>()
  /** How a locally-held permission is settled; set by the host that raised it. */
  onLocalApproval: ((askId: string, outcome: ApprovalOutcome) => boolean) | undefined
  /**
   * Prompts accepted by this server but not yet visible in a log.
   *
   * Lives here because this class is already the live half of a session's row:
   * the things a reader is waiting on that no log has recorded yet. A summary
   * refresh reads all of them through one seam, so a prompt in flight reaches
   * the page by the same path a waiting question does.
   */
  readonly accepted: Accepted
  private socket: WebSocket | undefined
  private retry = RETRY_MIN_MS
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  /**
   * @param ctx - the plugin context, for logging and lifetime.
   * @param origin - the host API's origin, e.g. `http://127.0.0.1:3080`. Empty
   *   attaches to nothing, for a host that raises its own questions in-process
   *   (the mock): dialling an origin that is not there would log a retry every
   *   few seconds for the life of the run.
   * @param changed - called when the waiting set changes, so summaries refresh.
   */
  constructor(ctx: Context, origin: string, changed: () => void) {
    this.ctx = ctx
    this.origin = (origin ?? '').replace(/\/+$/, '')
    this.changed = changed
    // Holding and releasing a key changes what a row renders, so it refreshes
    // summaries through the same callback a question does.
    this.accepted = new Accepted(changed)
    ctx.effect(() => () => {
      this.stopped = true
      if (this.timer !== undefined) clearTimeout(this.timer)
      // Closing the socket must not be the thing that throws on shutdown.
      try {
        this.socket?.close()
      } catch {
        // Already closing or never opened; either way there is nothing to undo.
      }
      this.live.clear()
    }, 'webGui.bridge()')
    if (this.origin !== '') this.dial()
  }

  /**
   * Raise a question this process owns, rather than one mirrored from a host.
   *
   * The escape hatch for a host that *is* the harness — the mock — where the
   * question is a live promise here and there is no `/api/respond` to forward an
   * answer to. Returns the settle function so the caller keeps ownership of its
   * own promise; this class only remembers that the question is waiting.
   * @param askId - the caller's id for the question.
   * @param sessionId - the session waiting on it.
   * @param questions - the questions as asked.
   * @returns a function that drops the ask, for the caller to run once it settles.
   */
  hold(askId: string, sessionId: string, questions: PendingAsk['questions']): () => void {
    this.local.add(askId)
    this.live.set(askId, { askId, sessionId, questions })
    this.changed()
    return () => {
      this.local.delete(askId)
      this.forget(askId)
    }
  }

  /**
   * The questions one session is waiting on, oldest first.
   * @param sessionId - the session.
   * @returns what the browser renders.
   */
  of(sessionId: string): PendingAsk[] {
    const asks: PendingAsk[] = []
    for (const entry of this.live.values()) {
      if (entry.sessionId === sessionId) asks.push({ askId: entry.askId, questions: entry.questions })
    }
    return asks
  }

  /**
   * Raise a permission this process owns, rather than one mirrored from a host.
   *
   * The approval half of {@link hold}, for the mock, which is the harness and so
   * holds the grant decision itself. Returns the settle function so the caller
   * keeps ownership of its own promise.
   * @param askId - the caller's envelope id for the request.
   * @param sessionId - the session waiting on it.
   * @param approval - the tool and reason being asked about.
   * @returns a function that drops the approval, for the caller to run once it settles.
   */
  holdApproval(askId: string, sessionId: string, approval: PendingApproval): () => void {
    this.localApprovals.add(askId)
    this.approvals.set(askId, { ...approval, askId, sessionId, approvalId: askId })
    this.changed()
    return () => {
      this.localApprovals.delete(askId)
      this.forgetApproval(askId)
    }
  }

  /**
   * The permissions one session is waiting on, oldest first.
   * @param sessionId - the session.
   * @returns what the browser renders.
   */
  approvalsOf(sessionId: string): PendingApproval[] {
    const pending: PendingApproval[] = []
    for (const entry of this.approvals.values()) {
      if (entry.sessionId === sessionId) {
        pending.push({ askId: entry.askId, toolName: entry.toolName, reason: entry.reason })
      }
    }
    return pending
  }

  /**
   * Everything one session is waiting on, with the identity a caller needs to
   * answer it.
   *
   * The introspection half of {@link of} and {@link approvalsOf}, which answer
   * what the *browser renders* and so drop two things an external caller needs:
   * which session an ask belongs to, and whether it settles here or at the host.
   * That second one is not cosmetic — a local ask is settled by
   * {@link onLocalAnswer} and a mirrored one by `POST /api/respond`, and nothing
   * in the rendered shape distinguishes them.
   *
   * Scoped to one session on purpose. The page reads asks a session at a time,
   * and a whole-box dump would make this a wider disclosure than the page it
   * mirrors, so the route requires the session and this method takes it.
   *
   * Strictly a read: no entry is created, dropped, or marked settled, because a
   * lookup that quietly forgot a pending ask would destroy the very thing it
   * was asked to describe.
   * @param sessionId - the session.
   * @returns the asks and approvals waiting under it, oldest first.
   */
  pendingOf(sessionId: string): { asks: PendingAskIdentity[]; approvals: PendingApprovalIdentity[] } {
    const asks: PendingAskIdentity[] = []
    for (const entry of this.live.values()) {
      if (entry.sessionId !== sessionId) continue
      asks.push({
        askId: entry.askId,
        sessionId: entry.sessionId,
        local: this.local.has(entry.askId),
        questions: entry.questions,
      })
    }
    const approvals: PendingApprovalIdentity[] = []
    for (const entry of this.approvals.values()) {
      if (entry.sessionId !== sessionId) continue
      approvals.push({ askId: entry.askId, sessionId: entry.sessionId, approvalId: entry.approvalId })
    }
    return { asks, approvals }
  }

  /**
   * The prompts this server has accepted for a session but not yet logged.
   *
   * The third member of {@link AskSource}, and the one that ended the page's
   * private opinion about delivery: the browser renders "Sending" from this
   * list rather than from a queue only it can see.
   * @param sessionId - the session.
   * @returns the browser-minted keys in flight, which the page matches against
   *   its own optimistic copies.
   */
  sendingOf(sessionId: string): readonly string[] {
    return this.accepted.held(sessionId)
  }

  /**
   * Settle one waiting permission through the host.
   *
   * The same shape as {@link answer}, against the host's other pending table: a
   * one-shot grant or a rejection, addressed by the envelope id and echoing the
   * payload id. A resend of the same decision is a duplicate rather than a
   * refusal, because the network dropping a response is not the reader
   * deciding twice.
   * @param askId - the request being decided, which is the host's rpcId.
   * @param clientMessageId - the browser's outbox key, so a resend is idempotent.
   * @param outcome - `allowed-once` or `rejected`.
   * @returns whether the host accepted it.
   */
  async settle(
    askId: string,
    clientMessageId: string,
    outcome: ApprovalOutcome,
  ): Promise<Settled> {
    const already = this.settledApprovals.get(askId)
    // The same browser resending its own decision is a duplicate, not a refusal.
    if (already === clientMessageId) return { ok: true, duplicate: true }
    const entry = this.approvals.get(askId)
    if (entry === undefined) {
      return { ok: false, stillWaiting: false, reason: 'this permission request is no longer waiting — it may have been decided in another window, cancelled by its agent, or lost when the harness restarted' }
    }
    // Raised in this process, so it is settled here: there is no host holding
    // the promise and nothing to post a decision to.
    if (this.localApprovals.has(askId)) {
      if (this.onLocalApproval?.(askId, outcome) !== true) {
        // The settler refused it, so nothing claimed the request: it is still here.
        return { ok: false, stillWaiting: true, reason: 'this permission request was not settled by the answerer that holds it' }
      }
      this.settledApprovals.set(askId, clientMessageId)
      return { ok: true, duplicate: false }
    }
    const body = {
      type: 'client-response',
      rpcId: askId,
      // `approvalId` is the payload id, not the envelope id: the host's schema
      // compares it against its own pending entry and answers `bad-response`
      // when they differ.
      result: { ok: true, value: { sessionId: entry.sessionId, approvalId: entry.approvalId, outcome } },
    }
    let receipt: { accepted?: unknown; reason?: unknown }
    try {
      const response = await fetch(`${this.origin}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) return { ok: false, stillWaiting: true, reason: `the harness refused the decision with HTTP ${response.status}` }
      receipt = await response.json() as { accepted?: unknown; reason?: unknown }
    } catch (error) {
      return { ok: false, stillWaiting: true, reason: `could not reach the harness at ${this.origin}: ${String(error)}` }
    }
    if (receipt.accepted !== true) {
      // `not-pending` is the ordinary race: someone else decided first.
      const reason = receipt.reason === 'not-pending'
        ? 'this permission request was already decided somewhere else'
        : `the harness rejected the decision (${String(receipt.reason)})`
      // The question path's rule, for the same reason: a payload refusal leaves
      // the request pending, so only a genuinely absent request is forgotten.
      const stillWaiting = receipt.reason !== 'not-pending'
      if (!stillWaiting) this.forgetApproval(askId)
      return { ok: false, stillWaiting, reason }
    }
    this.settledApprovals.set(askId, clientMessageId)
    this.forgetApproval(askId)
    return { ok: true, duplicate: false }
  }

  /**
   * Settle one waiting question through the host.
   * @param askId - the ask being answered, which is the host's rpcId.
   * @param clientMessageId - the browser's outbox key, so a resend is idempotent.
   * @param answers - one answer per question.
   * @returns whether the host accepted it.
   */
  async answer(askId: string, clientMessageId: string, answers: AskUserQuestionAnswerItem[]): Promise<Settled> {
    const already = this.settled.get(askId)
    // The same browser resending its own answer is a duplicate, not a refusal.
    if (already === clientMessageId) return { ok: true, duplicate: true }
    const entry = this.live.get(askId)
    if (entry === undefined) {
      return { ok: false, stillWaiting: false, reason: 'this question is no longer waiting — it may have been answered in another window, cancelled by its agent, or lost when the harness restarted' }
    }
    // Raised in this process, so it is settled here: there is no host holding
    // the promise and nothing to post an answer to.
    if (this.local.has(askId)) {
      if (this.onLocalAnswer?.(askId, answers) !== true) {
        // The settler refused it, so nothing claimed the ask: it is still here.
        return { ok: false, stillWaiting: true, reason: 'this question was not settled by the answerer that holds it' }
      }
      this.settled.set(askId, clientMessageId)
      return { ok: true, duplicate: false }
    }
    const body = {
      type: 'client-response',
      rpcId: askId,
      result: { ok: true, value: { sessionId: entry.sessionId, answer: { answers } } },
    }
    let receipt: { accepted?: unknown; reason?: unknown }
    try {
      const response = await fetch(`${this.origin}/api/respond`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) return { ok: false, stillWaiting: true, reason: `the harness refused the answer with HTTP ${response.status}` }
      receipt = await response.json() as { accepted?: unknown; reason?: unknown }
    } catch (error) {
      return { ok: false, stillWaiting: true, reason: `could not reach the harness at ${this.origin}: ${String(error)}` }
    }
    if (receipt.accepted !== true) {
      // `not-pending` is the ordinary race: someone else answered first.
      const reason = receipt.reason === 'not-pending'
        ? 'this question was already answered somewhere else'
        : `the harness rejected the answer (${String(receipt.reason)})`
      // Only `not-pending` means the host has let the question go. A
      // `bad-response` refusal is the host declining the *payload* — it never
      // claimed the question, so it is still waiting. Forgetting it here would
      // take a still-open question off every screen and leave the turn blocked
      // with nothing left to answer, which is exactly the state a malformed
      // answer must not be able to produce.
      const stillWaiting = receipt.reason !== 'not-pending'
      if (!stillWaiting) this.forget(askId)
      return { ok: false, stillWaiting, reason }
    }
    this.settled.set(askId, clientMessageId)
    this.forget(askId)
    return { ok: true, duplicate: false }
  }

  /** Drop one ask and tell the listeners, so the form leaves every screen. */
  private forget(askId: string): void {
    if (this.live.delete(askId)) this.changed()
  }

  /** Drop one permission and tell the listeners, so its form leaves every screen. */
  private forgetApproval(askId: string): void {
    if (this.approvals.delete(askId)) this.changed()
  }

  /**
   * Hold one socket open to the host, redialling with backoff when it drops.
   *
   * A dropped socket is expected rather than exceptional — the harness restarts,
   * the machine sleeps — so this never gives up, and never spins either.
   */
  private dial(): void {
    if (this.stopped) return
    let socket: WebSocket
    try {
      socket = new WebSocket(`${this.origin.replace(/^http/, 'ws')}/api/events.mux`)
    } catch (error) {
      return this.later(`could not open the question stream: ${String(error)}`)
    }
    this.socket = socket
    socket.addEventListener('open', () => {
      this.retry = RETRY_MIN_MS
      this.ctx.logger.info('web-gui: watching the harness for questions')
    })
    socket.addEventListener('message', event => {
      this.take(event.data)
    })
    socket.addEventListener('error', () => {
      // The close event carries the retry; an error alone would double it.
    })
    socket.addEventListener('close', () => {
      // Questions and permissions alike were the other end's to remember.
      // Keeping them after the socket dropped would leave forms on screen for
      // asks that may already be gone, and the reconnect re-announces whatever
      // is genuinely still waiting.
      if (this.live.size > 0 || this.approvals.size > 0) {
        this.live.clear()
        this.approvals.clear()
        this.changed()
      }
      this.later('the question stream closed')
    })
  }

  /**
   * Schedule the next dial.
   * @param why - what happened, logged once per attempt rather than per frame.
   */
  private later(why: string): void {
    if (this.stopped) return
    this.ctx.logger.warn(`web-gui: ${why}; retrying in ${Math.round(this.retry / 1000)}s`)
    const wait = this.retry
    this.retry = Math.min(this.retry * 2, RETRY_MAX_MS)
    this.timer = setTimeout(() => { this.dial() }, wait)
    // A pending reconnect must never hold the process open by itself.
    this.timer.unref?.()
  }

  /**
   * Admit one frame from the host.
   *
   * Everything that is not a question is ignored rather than refused: the mux
   * stream carries the whole host protocol, and this GUI is a guest on it.
   * @param raw - the frame's payload.
   */
  private take(raw: unknown): void {
    if (typeof raw !== 'string') return
    let frame: unknown
    try {
      frame = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof frame !== 'object' || frame === null) return
    const { rpcId, payload } = frame as { rpcId?: unknown; payload?: unknown }
    if (typeof rpcId !== 'string' || typeof payload !== 'object' || payload === null) return
    const body = payload as {
      type?: unknown
      sessionId?: unknown
      questions?: unknown
      questionRpcId?: unknown
      approvalId?: unknown
      toolName?: unknown
      reason?: unknown
    }
    if (body.type === 'question/requested') {
      if (typeof body.sessionId !== 'string' || !Array.isArray(body.questions)) return
      this.live.set(rpcId, {
        askId: rpcId,
        sessionId: body.sessionId,
        questions: body.questions as PendingAsk['questions'],
      })
      this.changed()
      return
    }
    // Settled elsewhere: another window answered, or the agent gave up waiting.
    // The id rides in the payload here, not in the envelope's own rpcId.
    if (body.type === 'question/resolved' && typeof body.questionRpcId === 'string') {
      this.forget(body.questionRpcId)
    }
    if (body.type === 'approval/requested') {
      if (typeof body.sessionId !== 'string' || typeof body.approvalId !== 'string') return
      this.approvals.set(rpcId, {
        askId: rpcId,
        sessionId: body.sessionId,
        approvalId: body.approvalId,
        // A tool with no name and a request with no stated reason are both real:
        // the harness makes both fields optional, so they degrade to blanks
        // rather than dropping a request the reader still has to decide.
        toolName: typeof body.toolName === 'string' ? body.toolName : '',
        reason: typeof body.reason === 'string' ? body.reason : '',
      })
      this.changed()
      return
    }
    // Settled elsewhere. Like the question frame, the id rides in the payload —
    // but here it is the *approval* id the payload names, not the envelope rpcId
    // the request arrived under, so the match is made against that field.
    if (body.type === 'approval/resolved' && typeof body.approvalId === 'string') {
      for (const [askId, entry] of this.approvals) {
        if (entry.approvalId === body.approvalId) {
          this.forgetApproval(askId)
          break
        }
      }
    }
  }
}
