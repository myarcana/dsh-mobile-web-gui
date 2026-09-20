/**
 * The keys this server has accepted but the log does not show yet.
 *
 * Delivery state used to be inferred in two places at once. The browser held a
 * row in IndexedDB and called that "Sending"; the server held an event in the
 * log and called that "Delivered". Neither could see the other, so nothing
 * arbitrated when they disagreed — and a single missed reconciliation pass left
 * a prompt reading "Sending" forever, because the outbox row was already gone
 * and no later frame could ever revisit the key.
 *
 * This registry is the missing half of the server's own answer. `send` records
 * a key the moment it accepts the prompt, and the key is retired when the
 * durable `user/message` carrying it lands. Between those two points the server
 * can say, on every summary frame, "I am holding this key" — which is the
 * statement the client was previously forced to invent for itself.
 *
 * It is deliberately in-memory. It describes a message in flight inside *this*
 * process, and a restart ends every flight it could describe: the agent holding
 * the prompt is gone too. Nothing here is the durable dedup record — that stays
 * the log, which is what survives the restart the retries pile up after.
 * @module
 */

/**
 * The shape a key must have to be echoed into HTML or matched by the client.
 *
 * Both mint paths in the browser produce this: `crypto.randomUUID` on a secure
 * origin, and hex from `crypto.getRandomValues` everywhere else, because this
 * page is routinely opened over plain HTTP on a LAN address. A value outside
 * the shape is refused rather than repaired — a rewritten key silently stops
 * matching the browser's own copy, which is a stuck indicator with no error.
 */
const KEY = /^[A-Za-z0-9-]{8,128}$/

/**
 * Whether a key may be trusted as an identifier.
 * @param key - the browser-minted value, straight off the wire.
 * @returns true when the key can be stored, echoed, and matched unchanged.
 */
export function validKey(key: string): boolean {
  return KEY.test(key)
}

/** Keys accepted for one session but not yet visible in its log. */
export class Accepted {
  /** sessionId -> the keys in flight for it. */
  private readonly bySession = new Map<string, Set<string>>()

  /** Called whenever the held set changes, so clients are told without polling. */
  private readonly changed: () => void

  /**
   * @param changed - invoked after any mutation that a client would render differently.
   */
  constructor(changed: () => void) {
    this.changed = changed
  }

  /**
   * Record that this server has taken responsibility for a prompt.
   *
   * Called after the agent has the message, so the key is never advertised for
   * a prompt that failed to be accepted at all.
   * @param sessionId - the session the prompt was addressed to.
   * @param key - the browser's `clientMessageId`.
   */
  hold(sessionId: string, key: string): void {
    if (!validKey(key)) return
    const keys = this.bySession.get(sessionId) ?? new Set<string>()
    if (keys.has(key)) return
    keys.add(key)
    this.bySession.set(sessionId, keys)
    this.changed()
  }

  /**
   * Retire a key the log now carries.
   *
   * This is the only thing that ends a hold, which is what makes the two states
   * mutually exclusive rather than merely usually-consistent: a key is held
   * until the durable event exists, and shown as delivered from that event
   * alone. There is no window where both are true and none where neither is.
   * @param sessionId - the session whose log grew.
   * @param key - the key the durable message carried.
   */
  release(sessionId: string, key: string): void {
    const keys = this.bySession.get(sessionId)
    if (keys === undefined || !keys.delete(key)) return
    if (keys.size === 0) this.bySession.delete(sessionId)
    this.changed()
  }

  /**
   * The keys in flight for one session, for its summary row.
   * @param sessionId - the session being summarized.
   * @returns the held keys, oldest first by insertion.
   */
  held(sessionId: string): readonly string[] {
    const keys = this.bySession.get(sessionId)
    return keys === undefined ? [] : [...keys]
  }

  /**
   * Whether this key is in flight right now.
   *
   * Consulted by dedup as a third source alongside the log and the agent inbox:
   * a message claimed from the inbox but not yet appended to the log is in
   * neither of those, and a blind retry arriving in that window would otherwise
   * be accepted a second time.
   * @param sessionId - the session to check.
   * @param key - the key a retry is carrying.
   * @returns true when this server already accepted this key.
   */
  holds(sessionId: string, key: string): boolean {
    return this.bySession.get(sessionId)?.has(key) === true
  }

  /** Drop everything for a session, so an archived or reset row leaks no keys. */
  forget(sessionId: string): void {
    if (this.bySession.delete(sessionId)) this.changed()
  }
}
