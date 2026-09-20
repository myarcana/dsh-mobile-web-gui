/**
 * Delivery: joins the edge detector to the subscribed browsers.
 *
 * Kept apart from {@link module:notify} (which decides *what* happened) and
 * {@link module:push} (which knows *how* to seal a message) so that the policy
 * questions all live here: who gets told, how often, and what happens when a
 * push service is unreachable.
 *
 * ## Why this is not chatty
 *
 * A notification is the most expensive thing this GUI can do to a reader: it
 * lights a screen and makes a noise, possibly at night. Three rules keep it
 * rare:
 *
 * - Only the *edge* into waiting notifies, never the state (see `notify.ts`).
 * - A session that transitions repeatedly is rate-limited, so a flapping agent
 *   cannot ring a phone ten times a minute.
 * - Delivery to a browser is skipped while that browser has the page in the
 *   foreground, because a reader looking at the screen does not need to be told
 *   what is on it.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { sendPush } from './push.ts'
import { Transitions, type Notice } from './notify.ts'
import type { Subscribers } from './subscribers.ts'
import type { SessionSummary } from './types.ts'

/**
 * Shortest gap between two notifications for the same session.
 *
 * An agent that asks a question, has it answered, and asks another within
 * seconds is one conversation, not three events worth interrupting for.
 */
const REPEAT_MS = 60_000

/**
 * How long a browser is considered "watching" after it last said so.
 *
 * The page reports itself visible on a timer far shorter than this, so a value
 * this size means a reader who closed the tab stops being considered present
 * quickly, while a brief network gap does not make the server start notifying a
 * phone whose screen is on.
 */
const WATCHING_MS = 90_000

/**
 * The `sub` claim in every VAPID token.
 *
 * The spec wants a way to contact whoever operates the server. This one runs on
 * someone's own machine and has no operator address, so it names the project
 * instead — which is what every push service in practice accepts.
 */
const SUBJECT = 'https://github.com/deepseek-ai/dsh'

/** Decides who to notify about what, and sends it. */
export class Notifier {
  private readonly transitions = new Transitions()
  private readonly lastSent = new Map<string, number>()
  /** endpoint to the last time that browser reported the page visible. */
  private readonly watching = new Map<string, number>()
  private readonly ctx: Context
  private readonly subscribers: Subscribers

  /**
   * @param ctx - the plugin context, for logging.
   * @param subscribers - the durable subscription set.
   */
  constructor(ctx: Context, subscribers: Subscribers) {
    this.ctx = ctx
    this.subscribers = subscribers
  }

  /**
   * Note that one browser currently has the page in the foreground.
   *
   * Called from the stream: a connected client with the page visible is looking
   * at the session list, so notifying it would duplicate what it can already
   * see. It is keyed by endpoint because that is the only identifier shared
   * between a push subscription and a connected page.
   * @param endpoint - the browser's push endpoint, as it reported.
   */
  present(endpoint: string): void {
    if (endpoint === '') return
    this.watching.set(endpoint, Date.now())
  }

  /**
   * Fold a listing and deliver whatever it implies.
   *
   * Never throws and never blocks the caller: it is invoked from the summary
   * broadcast, which must not be delayed by a push service on the far side of
   * the reader's network.
   * @param rows - the listing just broadcast.
   */
  observe(rows: readonly SessionSummary[]): void {
    const notices = this.transitions.fold(rows)
    if (notices.length === 0) return
    void this.deliver(notices).catch((error: unknown) => {
      this.ctx.logger.warn(`web-gui: notification delivery failed: ${errorChain(error)}`)
    })
  }

  /**
   * Send one round of notices to every eligible browser.
   * @param notices - what just started waiting.
   */
  private async deliver(notices: readonly Notice[]): Promise<void> {
    const now = Date.now()
    const due = notices.filter(notice => {
      const last = this.lastSent.get(notice.sessionId)
      if (last !== undefined && now - last < REPEAT_MS) return false
      this.lastSent.set(notice.sessionId, now)
      return true
    })
    if (due.length === 0) return
    const keys = await this.subscribers.keys()
    const rows = await this.subscribers.all()
    if (keys === undefined || rows.length === 0) return
    const dead: string[] = []
    // Every browser and every notice, in parallel: one slow push service must
    // not delay the rest, and there are only ever a handful of each.
    await Promise.all(rows.flatMap(row => {
      const seen = this.watching.get(row.endpoint)
      // Looking at the page right now — the list in front of them already shows
      // the dot going amber, so a notification would be noise.
      if (seen !== undefined && now - seen < WATCHING_MS) return []
      return due.map(async notice => {
        const result = await sendPush(keys, SUBJECT, row, {
          sessionId: notice.sessionId,
          title: notice.heading,
          body: notice.body,
          state: notice.state,
        })
        if (result.gone) dead.push(row.endpoint)
        else if (!result.ok) {
          // Logged rather than swallowed: a push that never arrives is
          // otherwise completely invisible from this side.
          this.ctx.logger.warn(`web-gui: push to ${new URL(row.endpoint).origin} failed: ${result.detail}`)
        }
      })
    }))
    await this.subscribers.removeAll(dead)
    // The rate-limit map would otherwise grow for the life of the process, one
    // entry per session ever notified.
    for (const [id, when] of this.lastSent) {
      if (now - when > REPEAT_MS * 10) this.lastSent.delete(id)
    }
  }
}
