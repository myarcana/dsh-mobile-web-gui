/**
 * One session's transcript, read as a single consistent cut.
 *
 * Every read here goes through `sessionQuery.readSession`, which returns a
 * detached, replay-validated log for a live or persisted session alike. That is
 * the property the GUI needs: a cold session opened from the list shows the same
 * transcript a live one does, with no agent alive to ask.
 *
 * The 0.1.1 API is what this is written against: the `observeSession`
 * observation form the plugin originally used does not exist on this host's
 * engine, and reading through it threw for any live session. Nothing here needs
 * it — `readSession` returns the events and the cursor in one call.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { answerIndex, isConversation, renderEvent, renderExpanded, settledAsks } from './render.ts'

/** Most events served for a cold transcript read. The tail is bounded; the log is not. */
export const TAIL_LIMIT = 400

/**
 * Render a bounded transcript tail.
 * @param ctx - the plugin context.
 * @param id - the session to read.
 * @param from - exclusive lower bound; `-1` reads from the beginning of the tail window.
 * @returns the frames' HTML, the last seq they cover, whether the whole log holds nothing, and whether older events remain behind the window.
 */
export async function tail(
  ctx: Context,
  id: SessionId,
  from: number,
): Promise<{ html: string; renderedThrough: number; empty: boolean; more: boolean; oldest: number }> {
  const events = (await ctx.sessionQuery.readSession(id)).events
  const after = events.filter(event => event.seq > from)
  // Never materialize a full log for a client that asked for the tail.
  const bounded = after.length > TAIL_LIMIT ? after.slice(after.length - TAIL_LIMIT) : after
  // The conversation itself is never truncated. A turn is mostly tool traffic,
  // so a purely positional window is spent on work and drops the prompts and
  // questions the reader came to read — on a busy session, within a single turn.
  // Those rows are kept however far back they sit, and the bounded window still
  // caps everything else, so a long session opens in one small chunk on a bad
  // link and that chunk always contains what the person actually said.
  const edge = bounded[0]
  const kept = edge === undefined
    ? after.filter(event => isConversation(event))
    : after.filter(event => event.seq < edge.seq && isConversation(event))
  // Merged in seq order, so the transcript stays chronological and there is no
  // second code path drawing the kept rows differently from the window's.
  const window = [...kept, ...bounded]
  // Whether this read left anything behind it. Both terms matter: the slice
  // above drops events, and `from` may itself sit above the start of the log.
  // Measured against the bounded edge rather than the merged one: a kept prompt
  // from early in the log does not mean everything between it and the window has
  // been shown, so the way back must stay offered.
  const more = after.length > bounded.length
    || (edge !== undefined && events.some(event => event.seq < edge.seq))
  // Built from the whole log rather than the window: a question inside the
  // window is routinely answered by a result outside it, and pairing only within
  // the window would draw that settled question as an empty form.
  const answers = answerIndex(events)
  // Read from the whole log for the same reason the answers are: a question in
  // the window is routinely settled by a result outside it, and a window-only
  // view of that would draw a long-settled question as though it were still
  // waiting — which is now the one state that renders nothing.
  const settled = settledAsks(events)
  let html = ''
  for (const event of window) html += renderEvent(event, id, answers, settled) ?? ''
  // A full read that produced no frame at all means the session has no
  // transcript, which is a different screen from one whose tail has not arrived
  // yet. Only a full read can answer it: a tail window that happened to hold no
  // frames says nothing about the log behind it. The second scan runs only in
  // that one case and stops at the first renderable event, so the ordinary
  // paths pay nothing for it.
  const empty = from < 0 && html === '' && !events.some(event => renderEvent(event, id, answers, settled) !== null)
  const last = events.at(-1)
  // Where a backwards read must start, which is the bounded window's edge and
  // not the oldest row drawn. A kept prompt from the very start of the log is on
  // screen without anything between it and the window having been shown, so
  // taking the edge from the page would ask for everything before the first
  // message — nothing — and strand the whole middle of the transcript.
  const oldest = edge === undefined ? -1 : edge.seq
  return { html, renderedThrough: last === undefined ? -1 : last.seq, empty, more, oldest }
}

/**
 * Render the chunk of transcript immediately before a seq.
 *
 * The counterpart to {@link tail}: that reads forward from a lower bound, this
 * reads backward from an upper one, so a reader who has reached the top of what
 * they were given can keep going. Between the two, every event in a log of any
 * length is reachable, while a first paint still costs one bounded chunk.
 * @param ctx - the plugin context.
 * @param id - the session to read.
 * @param before - exclusive upper bound; only events below this are considered.
 * @returns the frames' HTML, the lowest seq they cover, and whether anything remains behind them.
 */
export async function earlier(
  ctx: Context,
  id: SessionId,
  before: number,
  kept: boolean = false,
): Promise<{ html: string; oldest: number; more: boolean }> {
  const events = (await ctx.sessionQuery.readSession(id)).events
  const older = events.filter(event => event.seq < before)
  // The chunk nearest the reader's current top edge, which is the end of this
  // range rather than its beginning.
  const window = older.length > TAIL_LIMIT ? older.slice(older.length - TAIL_LIMIT) : older
  // As in `tail`: the answer to a question in this chunk usually sits after it,
  // and so does the result that says it is no longer waiting.
  const answers = answerIndex(events)
  const settled = settledAsks(events)
  let html = ''
  for (const event of window) {
    // A conversation row below the reader's top edge is already on screen: the
    // first paint keeps every one of them however far back it sits. Drawing it
    // again here would put a second copy of someone's own prompt above the one
    // they are looking at, so the backwards read skips exactly the rows the
    // forward read promised never to drop.
    if (kept && isConversation(event)) continue
    html += renderEvent(event, id, answers, settled) ?? ''
  }
  const first = window[0]
  // What was left behind, not what was rendered: an event that renders no frame
  // still sits in the log, and claiming exhaustion because the chunk happened to
  // render nothing would strand everything below it.
  const more = older.length > window.length
  // The lower edge of what was *examined*, which is what the next read must
  // start from. Deliberately not the lowest seq that produced a frame: most
  // event types render nothing, so a window that drew little — or nothing at
  // all — would otherwise report a bound at or above the one it was given, and
  // the reader's next tap would ask for the identical chunk forever. Reporting
  // the examined edge makes the bound strictly decrease while `more` holds, so
  // the walk always terminates at the first event in the log.
  return { html, oldest: first === undefined ? before : first.seq, more }
}

/**
 * Render one event's expanded view.
 * @param ctx - the plugin context.
 * @param id - the session holding the event.
 * @param seq - the event's position.
 * @returns the expanded HTML, or null when no such event exists.
 */
export async function expanded(ctx: Context, id: SessionId, seq: number): Promise<string | null> {
  const events = (await ctx.sessionQuery.readSession(id)).events
  const event = events.find(candidate => candidate.seq === seq)
  return event === undefined ? null : renderExpanded(event)
}

/**
 * Render every tool event in the uninterrupted run containing one seq.
 *
 * The collapsed transcript line names a run by the seq of its first tool event,
 * but a reader may also arrive at this URL holding a seq from the middle of one
 * — a link copied before the run grew, say — so the run is rediscovered here
 * from the log rather than trusted from the URL. The walk matches the client's
 * grouping rule: tool events accumulate, durable progress markers are passed
 * over without ending the run, and anything a reader would see as a message
 * ends it.
 * @param ctx - the plugin context.
 * @param id - the session holding the run.
 * @param seq - any tool event's position within the run.
 * @returns the expanded HTML for every call and result in the run, or null when that seq names no tool event.
 */
export async function expandedRun(
  ctx: Context,
  id: SessionId,
  seq: number,
  until: number | null = null,
): Promise<string | null> {
  const events = (await ctx.sessionQuery.readSession(id)).events
  const at = events.findIndex(candidate => candidate.seq === seq)
  if (at < 0 || !isToolEvent(events[at])) return null
  let first = at
  // Walk back to the run's first tool event, so a mid-run seq resolves to the
  // same run the transcript line collapsed.
  for (let index = at - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined) break
    if (isToolEvent(event)) { first = index; continue }
    if (isRunNeutral(event)) continue
    break
  }
  let html = ''
  // Narration seen since the last tool event. It is written out only once
  // another call proves it was interior to the run; narration trailing the last
  // call belongs to the transcript, where the reader can still see it under the
  // collapsed line, and printing it here as well would duplicate it.
  let pending = ''
  for (let index = first; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) break
    // The line that sent the reader here knows where its run ended. Honour it,
    // so a run the page drew and the screen behind it always agree.
    if (until !== null && event.seq > until) break
    if (isToolEvent(event)) {
      html += pending
      pending = ''
      html += renderExpanded(event)
      continue
    }
    if (isRunNeutral(event)) continue
    // A message between two calls is a preamble to the work, which the page
    // folded into the line. It belongs here, with the calls it introduced.
    if (isNarration(event)) { pending += renderExpanded(event); continue }
    break
  }
  return html
}

/**
 * Whether an event is assistant narration the page folds into a run.
 * @param event - the event to classify.
 * @returns true for an assistant message that renders something a reader sees.
 */
function isNarration(event: SessionEvent): boolean {
  return event.type === 'assistant/message' && renderEvent(event, SessionId('probe')) !== null
}

/**
 * Whether an event is one of the tool rows a collapsed run is built from.
 * @param event - the event to classify.
 * @returns true for a tool call or its result.
 */
function isToolEvent(event: SessionEvent | undefined): boolean {
  return event !== undefined && (event.type === 'tool/call' || event.type === 'tool/result')
}

/**
 * Whether an event sits inside a run without belonging to it or ending it.
 *
 * A turn boundary or a model retry lands between two tool calls routinely, and
 * treating one as a break would leave a long turn drawn as a string of
 * one-item groups — the exact clutter the collapsing exists to remove. An event
 * that renders no frame at all is likewise invisible, so it cannot end a run a
 * reader can see.
 * @param event - the event to classify.
 * @returns true when the run continues across it.
 */
function isRunNeutral(event: SessionEvent): boolean {
  if (event.type === 'turn/start' || event.type === 'turn/end' || event.type === 'llm/retry') return true
  return renderEvent(event, SessionId('probe')) === null
}
