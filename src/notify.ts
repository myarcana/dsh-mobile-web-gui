/**
 * Notifications for a session that has stopped and wants the reader.
 *
 * ## What "waiting" means
 *
 * Exactly what the session list already means by it, and deliberately not a
 * second opinion. `client/chooser.js` decides the dot beside every row and the
 * tally in every heading with one function: a session with questions or
 * permission requests is `asking`, one that is `running` is `working`, and
 * anything else is `done`. {@link stateOf} is that same function, and
 * {@link waiting} is the heading's own "everything that is not working".
 *
 * Writing a fresh rule here — "notify when the agent stops" — would have been
 * easy and wrong: it would drift from the amber count the moment either side
 * was touched, and a reader would get a notification for a session the list
 * showed as working, or none for a session showing amber. One definition, two
 * consumers.
 *
 * ## Why the transition and not the state
 *
 * A summary frame is recomputed on every corpus bump, several times a second
 * while anything is running. Notifying on the *state* would re-notify the same
 * finished session forever. So the previous state of every session is held, and
 * a notification is raised only on the edge from working to not-working.
 *
 * The first listing after a restart therefore teaches the map without notifying
 * anything: every session on a freshly started server would otherwise look like
 * it had just finished, and a reader who restarts the harness would be handed a
 * notification for every idle session on the box.
 * @module
 */

import type { SessionSummary } from './types.ts'

/** What one session wants from the reader. The three states the dots name. */
export type SessionState = 'asking' | 'working' | 'done'

/**
 * Classify one session exactly as the session list does.
 *
 * Mirrors `state(row)` in `client/chooser.js`. The order matters: a session can
 * be running *and* holding a question — an agent that asked and is still
 * technically live — and in that case the question is what the reader must act
 * on, so `asking` wins.
 * @param row - the summary row, as the list renders it.
 * @returns the state the dot beside this row would show.
 */
export function stateOf(row: SessionSummary): SessionState {
  if (row.asks.length > 0 || row.approvals.length > 0) return 'asking'
  if (row.running) return 'working'
  return 'done'
}

/**
 * Whether a state is one the reader is being waited on for.
 *
 * The heading's definition: everything that is not working. A finished turn
 * wants the reader exactly as much as a question does — it just wants the next
 * instruction rather than an answer.
 * @param state - the classification from {@link stateOf}.
 * @returns true when nothing moves until a person acts.
 */
export function waiting(state: SessionState): boolean {
  return state !== 'working'
}

/** One notification to deliver, already worded for a person. */
export interface Notice {
  /** The session that wants attention. */
  readonly sessionId: string
  /** The session's title, which is what the reader recognises it by. */
  readonly title: string
  /** Why it is waiting, so the wording and the icon can differ. */
  readonly state: SessionState
  /** The notification's first line. */
  readonly heading: string
  /** The line under it: the session's own last words, where it has any. */
  readonly body: string
}

/**
 * The edge detector.
 *
 * Holds the last known state of every session and reports only the crossings
 * into waiting. One instance per server; it is pure bookkeeping, so nothing
 * here does I/O or can fail.
 */
export class Transitions {
  private readonly previous = new Map<string, SessionState>()

  /**
   * Whether any listing has been seen yet.
   *
   * The first one only seeds the map. See the module note: without this, every
   * restart notifies for every idle session on the box.
   */
  private seeded = false

  /**
   * Fold one listing and report which sessions just started waiting.
   * @param rows - every visible session, as the list would render it.
   * @returns the notices to deliver, in listing order.
   */
  fold(rows: readonly SessionSummary[]): readonly Notice[] {
    const notices: Notice[] = []
    const live = new Set<string>()
    for (const row of rows) {
      live.add(row.id)
      const now = stateOf(row)
      const before = this.previous.get(row.id)
      this.previous.set(row.id, now)
      if (!this.seeded) continue
      // Only a crossing counts. `before === undefined` is a session this server
      // has not seen before — an archived session restored, or one created
      // while nobody was connected. It is not evidence that work just stopped,
      // so it seeds silently like the first listing does.
      if (before === undefined || !waiting(now) || waiting(before)) continue
      notices.push(notice(row, now))
    }
    // A session that vanished from the listing (archived, deleted) must not
    // keep its entry, or restoring it later would look like a transition.
    for (const id of this.previous.keys()) {
      if (!live.has(id)) this.previous.delete(id)
    }
    this.seeded = true
    return notices
  }
}

/**
 * Word one notice for a person.
 *
 * The two waiting states need different sentences because they need different
 * actions: one is a question that blocks the agent, the other is a turn that
 * ended and wants a next instruction. Saying "waiting" for both would make the
 * reader open the session to find out which.
 * @param row - the session that stopped.
 * @param state - its classification.
 * @returns the notice to deliver.
 */
function notice(row: SessionSummary, state: SessionState): Notice {
  // The title is the session's own, never a generic "A session": a phone shows
  // these stacked, and three notifications reading the same thing are useless.
  const title = row.title === '' ? 'Untitled session' : row.title
  const heading = state === 'asking'
    ? `${title} is asking you`
    : `${title} has finished`
  return {
    sessionId: row.id,
    title,
    state,
    heading,
    // The agent's last line is the most useful thing available: for a question
    // it is usually the question, and for a finished turn it is the conclusion.
    body: row.lastLine,
  }
}
