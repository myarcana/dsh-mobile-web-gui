/**
 * Session summaries and transcript tails, read through one consistent cut.
 *
 * Every read here takes an observation with `using`, without exception. A
 * `SessionObservation` is `Disposable` and retains an immutable log cut in the
 * agent's heap; a handler that returned early on an aborted request would pin
 * it. A flaky mobile client aborts constantly, so this is the single most
 * likely real failure of the design.
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { Questions } from './questions.ts'
import { renderEvent, renderExpanded } from './render.ts'
import type { SessionSummary } from './types.ts'

/** Most events served for a cold transcript read. The tail is bounded; the log is not. */
export const TAIL_LIMIT = 400

/** Longest preview line kept on a chooser row. */
const LAST_LINE_MAX = 120

/**
 * Summarize every live session for the chooser and the summary stream tier.
 * @param ctx - the plugin context, for the agent registry and session query.
 * @param questions - the questions this server is holding.
 * @returns one row per live session, newest activity first.
 */
export async function summaries(ctx: Context, questions: Questions): Promise<SessionSummary[]> {
  const rows: SessionSummary[] = []
  for (const agent of ctx.agents.roots()) {
    rows.push(await summarize(ctx, agent.session.id, questions))
  }
  rows.sort((left, right) => right.time - left.time)
  return rows
}

/**
 * Summarize one session from a single consistent observation.
 * @param ctx - the plugin context.
 * @param id - the session to summarize.
 * @param questions - the questions this server is holding.
 * @returns the chooser row for that session.
 */
export async function summarize(ctx: Context, id: SessionId, questions: Questions): Promise<SessionSummary> {
  using observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  const events = observation.events
  const agent = ctx.agents.get(id)
  let title = ''
  let lastLine = ''
  let time = observation.header.createdAt
  for (const event of events) {
    if (event.type === 'session/title') title = event.data.title
    const line = preview(event)
    if (line !== null) {
      lastLine = line
      time = event.time
    }
  }
  return {
    id,
    title: title === '' ? (observation.header.cwd ?? 'Untitled session') : title,
    running: agent?.status === 'running',
    latestSeq: observation.cursor,
    workspace: observation.header.cwd ?? 'No working directory',
    lastLine,
    time,
    // Capability is decided here, from what this session can actually do, and
    // the client renders what it is handed. Nothing in the page branches on a role.
    actions: agent === undefined ? [] : agent.status === 'running' ? ['send', 'stop'] : ['send'],
    asks: questions.of(id),
  }
}

/**
 * Render a bounded transcript tail.
 * @param ctx - the plugin context.
 * @param id - the session to read.
 * @param from - exclusive lower bound; `-1` reads from the beginning of the tail window.
 * @returns the frames' HTML and the last seq they cover.
 */
export async function tail(
  ctx: Context,
  id: SessionId,
  from: number,
): Promise<{ html: string; renderedThrough: number }> {
  using observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  const events = observation.events
  const after = events.filter(event => event.seq > from)
  // Never materialize a full log for a client that asked for the tail.
  const window = after.length > TAIL_LIMIT ? after.slice(after.length - TAIL_LIMIT) : after
  let html = ''
  for (const event of window) html += renderEvent(event, id) ?? ''
  return { html, renderedThrough: observation.cursor }
}

/**
 * Reduce markdown to the words a reader would actually read.
 *
 * A chooser row is prose, not a document: fence markers and emphasis asterisks
 * are noise there, and a row full of backticks says nothing about the session.
 * @param source - the message's raw text.
 * @returns a single line of plain words.
 */
function plain(source: string): string {
  return source
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Reduce one event to a chooser preview line.
 * @param event - a durable event.
 * @returns the line, or null when the event says nothing a reader would recognize.
 */
function preview(event: SessionEvent): string | null {
  if (event.type === 'user/message' || event.type === 'assistant/message') {
    const message = event.type === 'user/message' ? event.data : event.data.message
    let out = ''
    for (const block of message.content) if (block.type === 'text') out += block.text
    const line = plain(out)
    if (line === '') return null
    return line.length > LAST_LINE_MAX ? `${line.slice(0, LAST_LINE_MAX)}…` : line
  }
  if (event.type === 'tool/call') return `${event.data.name}…`
  return null
}

/**
 * Render one event's expanded view.
 * @param ctx - the plugin context.
 * @param id - the session holding the event.
 * @param seq - the event's position.
 * @returns the expanded HTML, or null when no such event exists.
 */
export async function expanded(ctx: Context, id: SessionId, seq: number): Promise<string | null> {
  using observation = await ctx.sessionQuery.observeSession(id, { projectionMode: 'none' })
  const event = observation.events.find(candidate => candidate.seq === seq)
  return event === undefined ? null : renderExpanded(event)
}
