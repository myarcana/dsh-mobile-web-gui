/**
 * Durable session events into transcript frames.
 *
 * A frame is one `<article>` the client appends verbatim. Only append-origin
 * surface events reach here: `isAppendSurfaceEvent` is what keeps a landed
 * compaction from erasing conversation someone already read, since the
 * model-visible surface deliberately shadows replaced ranges.
 * @module
 */

import type { ContentBlock, SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent } from '@deepseek-ai/dsh-session'
import { markdown } from './markdown.ts'
import { SafeUrl, type Node } from './node.ts'
import { serializeAll } from './serialize.ts'

/** Longest tool argument or result line kept in a collapsed transcript row. */
const COLLAPSED_MAX_CHARS = 200

/** Event types that carry durable progress rather than message content. */
const PROGRESS_TYPES: ReadonlySet<string> = new Set(['turn/start', 'turn/end', 'llm/retry'])

/**
 * Render one durable event as a transcript frame.
 * @param event - an event from the session log.
 * @param sessionId - the session the frame belongs to, for expand-to-URL links.
 * @returns the frame's HTML, or null when the event contributes nothing a reader should see.
 */
export function renderEvent(event: SessionEvent, sessionId: string): string | null {
  if (event.type === 'user/message') {
    if (!isAppendSurfaceEvent(event)) return null
    // `inject`ed context and goal continuations share this type; only a direct
    // human prompt belongs in a transcript of what the person said.
    const source: { kind?: unknown } = event.data.source
    if (source.kind !== 'user' && source.kind !== 'webgui') return null
    // The browser's own key rides back on the durable frame, so the page can
    // retire the optimistic copy exactly rather than by guessing at its text.
    const key = source.kind === 'webgui' && typeof source.clientMessageId === 'string'
      ? source.clientMessageId
      : null
    return frame(event, 'user', blocks(event.data.content), key)
  }
  if (event.type === 'assistant/message') {
    if (!isAppendSurfaceEvent(event)) return null
    const nodes = blocks(event.data.message.content)
    return nodes.length === 0 ? null : frame(event, 'assistant', nodes)
  }
  if (event.type === 'tool/call') {
    return frame(event, 'tool', [toolLine(event.data.name, event.data.arguments, sessionId, event.seq)])
  }
  if (event.type === 'tool/result') {
    if (!isAppendSurfaceEvent(event)) return null
    return frame(event, 'tool', [toolLine(resultLabel(event), text(event.data.message.content), sessionId, event.seq)])
  }
  if (PROGRESS_TYPES.has(event.type)) return progress(event, sessionId)
  return null
}

/**
 * Render a durable progress marker.
 * @param event - a turn boundary or retry event.
 * @param sessionId - the session the frame belongs to.
 * @returns the frame's HTML, or null for a marker with nothing to say.
 */
function progress(event: SessionEvent, sessionId: string): string | null {
  if (event.type === 'turn/start') return frame(event, 'progress', [{ t: 'text', s: 'Working' }])
  if (event.type === 'llm/retry') {
    return frame(event, 'progress', [{ t: 'text', s: 'Retrying the model request' }])
  }
  if (event.type === 'turn/end') {
    const reason: { kind?: unknown } = event.data.reason
    if (reason.kind === 'error' || reason.kind === 'aborted') {
      return frame(event, 'progress', [
        { t: 'text', s: reason.kind === 'error' ? 'The turn ended with an error' : 'The turn was stopped' },
        { t: 'text', s: ' · ' },
        expandLink(sessionId, event.seq, 'Full detail'),
      ])
    }
    return null
  }
  return null
}

/**
 * Wrap rendered content in the article the client appends.
 *
 * `data-time` carries epoch milliseconds rather than a formatted string: only
 * the browser knows the reader's timezone, and the rule is that every time
 * names its zone.
 * @param event - the event being framed, for its seq and timestamp.
 * @param role - the presentation role the stylesheet keys on.
 * @param nodes - already-built content nodes.
 * @param clientKey - the browser's `clientMessageId`, when this message came from the composer.
 * @returns one `<article>` element as HTML.
 */
function frame(event: SessionEvent, role: string, nodes: readonly Node[], clientKey: string | null = null): string {
  // The key is a browser-minted opaque id; it is escaped like any other value.
  const key = clientKey === null ? '' : ` data-client-id="${clientKey.replace(/[^A-Za-z0-9-]/g, '')}"`
  return `<article data-seq="${event.seq}" data-role="${role}" data-time="${event.time}"${key}>`
    + `${serializeAll(nodes)}</article>`
}

/**
 * Build the collapsed one-line row a tool call or result occupies.
 * @param name - the tool name or result label.
 * @param detail - arguments or result text, shown truncated.
 * @param sessionId - the session owning the event.
 * @param seq - the event's position, which the expanded view addresses.
 * @returns a link node whose href is the expanded view's URL.
 */
function toolLine(name: string, detail: string, sessionId: string, seq: number): Node {
  const line = detail.replace(/\s+/g, ' ').trim()
  const shown = line.length > COLLAPSED_MAX_CHARS ? `${line.slice(0, COLLAPSED_MAX_CHARS)}…` : line
  return {
    t: 'a',
    href: expandUrl(sessionId, seq),
    c: [{ t: 'strong', c: [{ t: 'text', s: name }] }, { t: 'text', s: shown === '' ? '' : ` ${shown}` }],
  }
}

/**
 * Name a tool result row by its outcome.
 * @param event - a `tool/result` event.
 * @returns the label shown at the head of the collapsed row.
 */
function resultLabel(event: SessionEvent<'tool/result'>): string {
  const [block] = event.data.message.content
  return block !== undefined && block.type === 'tool-result' && block.isError === true ? 'Failed' : 'Result'
}

/**
 * Build the expand-to-URL link node.
 * @param sessionId - the session owning the event.
 * @param seq - the event position addressed by the expanded view.
 * @param label - the link's visible text.
 * @returns the anchor node.
 */
function expandLink(sessionId: string, seq: number, label: string): Node {
  return { t: 'a', href: expandUrl(sessionId, seq), c: [{ t: 'text', s: label }] }
}

/**
 * Mint the route an expanded event lives at.
 * @param sessionId - the session owning the event.
 * @param seq - the event position.
 * @returns a root-relative safe URL, so the page works on any hostname.
 */
function expandUrl(sessionId: string, seq: number): ReturnType<typeof SafeUrl> {
  return SafeUrl(`/s/${encodeURIComponent(sessionId)}/e/${seq}`)
}

/**
 * Render model-facing content blocks as transcript nodes.
 * @param content - the message's blocks.
 * @returns block-level nodes; reasoning and internal blocks are omitted.
 */
function blocks(content: readonly ContentBlock[]): Node[] {
  const nodes: Node[] = []
  for (const block of content) {
    if (block.type === 'text') nodes.push(...markdown(block.text))
    else if (block.type === 'file') {
      nodes.push({ t: 'p', c: [{ t: 'mono', s: block.attachment.name }] })
    } else if (block.type === 'image') {
      // No image variant exists: rendering a remote reference would let a model
      // that has read your files exfiltrate them through a URL. It reads as a name.
      nodes.push({ t: 'p', c: [{ t: 'mono', s: block.attachment.name }] })
    }
  }
  return nodes
}

/**
 * Flatten content blocks to plain text for a collapsed row.
 * @param content - blocks from a tool result.
 * @returns their concatenated text.
 */
function text(content: readonly ContentBlock[]): string {
  let out = ''
  for (const block of content) {
    if (block.type === 'text') out += block.text
    else if (block.type === 'tool-result') out += text(block.content)
  }
  return out
}

/**
 * Render one event in full, for the expanded view its collapsed row links to.
 *
 * A collapsed transcript row is a summary; this is the record. Tool arguments
 * and results are shown verbatim in a code block rather than truncated.
 * @param event - the event to expand.
 * @returns the expanded view's HTML.
 */
export function renderExpanded(event: SessionEvent): string {
  const nodes: Node[] = [{ t: 'p', c: [{ t: 'strong', c: [{ t: 'text', s: heading(event) }] }] }]
  if (event.type === 'tool/call') {
    nodes.push({ t: 'code', lang: 'json', s: pretty(event.data.arguments) })
  } else if (event.type === 'tool/result') {
    nodes.push({ t: 'code', lang: null, s: text(event.data.message.content) })
  } else if (event.type === 'assistant/message') {
    nodes.push(...blocks(event.data.message.content))
  } else if (event.type === 'user/message') {
    nodes.push(...blocks(event.data.content))
  } else {
    nodes.push({ t: 'code', lang: 'json', s: JSON.stringify(event.data, null, 2) })
  }
  return `<article data-seq="${event.seq}" data-role="expanded" data-time="${event.time}">`
    + `${serializeAll(nodes)}</article>`
}

/**
 * Name the expanded event specifically, never with a generic label.
 * @param event - the event being expanded.
 * @returns the heading text.
 */
function heading(event: SessionEvent): string {
  if (event.type === 'tool/call') return `${event.data.name} call`
  if (event.type === 'tool/result') return `${resultLabel(event)} of the tool call`
  if (event.type === 'turn/end') return 'How the turn ended'
  return event.type
}

/**
 * Pretty-print a model-produced JSON argument string, or show it verbatim.
 * @param raw - the raw JSON string as the model produced it.
 * @returns indented JSON, or the original when it does not parse.
 */
function pretty(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
