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
import type { SessionId } from '@deepseek-ai/dsh-session'
import { renderEvent, renderExpanded } from './render.ts'

/** Most events served for a cold transcript read. The tail is bounded; the log is not. */
export const TAIL_LIMIT = 400

/**
 * Render a bounded transcript tail.
 * @param ctx - the plugin context.
 * @param id - the session to read.
 * @param from - exclusive lower bound; `-1` reads from the beginning of the tail window.
 * @returns the frames' HTML, the last seq they cover, and whether the whole log holds nothing.
 */
export async function tail(
  ctx: Context,
  id: SessionId,
  from: number,
): Promise<{ html: string; renderedThrough: number; empty: boolean }> {
  const events = (await ctx.sessionQuery.readSession(id)).events
  const after = events.filter(event => event.seq > from)
  // Never materialize a full log for a client that asked for the tail.
  const window = after.length > TAIL_LIMIT ? after.slice(after.length - TAIL_LIMIT) : after
  let html = ''
  for (const event of window) html += renderEvent(event, id) ?? ''
  // A full read that produced no frame at all means the session has no
  // transcript, which is a different screen from one whose tail has not arrived
  // yet. Only a full read can answer it: a tail window that happened to hold no
  // frames says nothing about the log behind it. The second scan runs only in
  // that one case and stops at the first renderable event, so the ordinary
  // paths pay nothing for it.
  const empty = from < 0 && html === '' && !events.some(event => renderEvent(event, id) !== null)
  const last = events.at(-1)
  return { html, renderedThrough: last === undefined ? -1 : last.seq, empty }
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
