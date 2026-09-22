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
import { validKey } from './accepted.ts'
import { markdown } from './markdown.ts'
import { SafeUrl, type Node } from './node.ts'
import { serializeAll } from './serialize.ts'

/** Longest tool argument or result line kept in a collapsed transcript row. */
const COLLAPSED_MAX_CHARS = 200

/** Event types that carry durable progress rather than message content. */
const PROGRESS_TYPES: ReadonlySet<string> = new Set(['turn/start', 'turn/end', 'llm/retry'])

/**
 * Message sources that are a child agent speaking to its parent, not the person.
 *
 * A child's report — and the runtime's own account of it settling — arrive as
 * ordinary `user/message` events. They carry content the reader needs (a
 * delegated run's findings, and how it ended), but rendering them as `user`
 * would credit the child's words to the person reading the transcript. So they
 * get their own role, and the content itself names the child that sent it.
 *
 * The two kinds are deliberately distinct upstream: a report is what the child
 * chose to say, while a settled notice is the manager stating what became of it.
 */
const CHILD_KINDS: ReadonlySet<string> = new Set(['subagent-report', 'subagent-settled'])

/**
 * Whether an event is part of the conversation the reader had, rather than the
 * work done around it.
 *
 * These are the rows a transcript exists to show: what the person typed, every
 * question put to them, and the answer they gave. A bounded read keeps all of
 * them however far back they sit, so no amount of tool traffic in front can push
 * someone's own words off the screen they opened. Everything else — narration,
 * tool calls, progress — is bounded normally and stays reachable behind "Older
 * messages".
 *
 * Defined here, next to the rendering it mirrors, so the rule about what a
 * reader must always see cannot drift from the rule about how it is drawn.
 * @param event - an event from the session log.
 * @returns true when the event must survive truncation.
 */
export function isConversation(event: SessionEvent): boolean {
  if (event.type === 'user/message') {
    if (!isAppendSurfaceEvent(event)) return false
    const source: { kind?: unknown } = event.data.source
    // The person's own prompt. A child's report is conversation too, but it is
    // the child's, and it is bounded with the rest of the work it came from.
    return source.kind === 'user' || source.kind === 'webgui'
  }
  // A question put to the reader, drawn as the form that asked it — with the
  // answer ticked into that same form once one exists. Both halves of the
  // exchange live on this one row, so it is the only one to keep.
  if (event.type === 'tool/call') return event.data.name === ASK_TOOL
  // The words a question was asked with, which are part of the question.
  //
  // A model writes its reasoning as text and calls the ask tool in the *same*
  // assistant message, and a question routinely refers straight back to it —
  // "Given that…" names a "that" that exists only here. Keeping the call while
  // letting this be truncated preserved the question and dropped its subject,
  // which is how a transcript ends up showing a question nobody can answer.
  //
  // Only messages that actually made an ask are kept, so ordinary narration is
  // still bounded with the rest of the work.
  if (event.type === 'assistant/message') {
    if (!isAppendSurfaceEvent(event)) return false
    return event.data.message.content.some(block => block.type === 'tool-call' && block.name === ASK_TOOL)
  }
  return false
}

/**
 * Index every readable ask answer in a log by the call it answers.
 *
 * Built once per transcript read rather than per row: the answer lives in a
 * different event from the question, and pairing them by scanning from each call
 * would be quadratic on a long log.
 * @param events - the events being rendered, in any order.
 * @returns answers by the `callId` of the ask they belong to.
 */
export function answerIndex(events: readonly SessionEvent[]): ReadonlyMap<string, Answers> {
  const index = new Map<string, Answers>()
  for (const event of events) {
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    const [block] = event.data.message.content
    if (block === undefined || block.type !== 'tool-result') continue
    const answers = givenAnswers(event)
    if (answers !== null) index.set(block.toolCallId, answers)
  }
  return index
}

/**
 * The ask calls whose result is already in the log, answered or not.
 *
 * This is the "is it still waiting?" test, and it is deliberately answered from
 * the log alone rather than from the live pending set. The tool writes its
 * result the moment the answer reaches it — in a real log the result is the very
 * next seq after the call — so the log knows a question has been settled at the
 * same instant the waiting form is dropped. Reading it from the log keeps the
 * renderer pure and keeps a reload agreeing with the live stream, which a live
 * set held in one process could not promise after a restart.
 *
 * A cancelled or failed ask is settled too: it has a result, it simply carries
 * an error instead of answers ({@link givenAnswers} returns null for it), so it
 * is in this set but not in {@link answerIndex} — which is exactly the pair of
 * facts needed to draw it as asked-but-never-answered.
 * @param events - the events being rendered, in any order.
 * @returns the `callId` of every ask that has a result.
 */
export function settledAsks(events: readonly SessionEvent[]): ReadonlySet<string> {
  const settled = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result' || !isAppendSurfaceEvent(event)) continue
    const [block] = event.data.message.content
    if (block === undefined || block.type !== 'tool-result') continue
    settled.add(block.toolCallId)
  }
  return settled
}

/**
 * Read one just-arrived result into the pair of facts a question's row needs.
 *
 * The live counterpart to {@link answerIndex} and {@link settledAsks}, and it
 * exists because of a difference those two must keep enforcing: they scan a
 * *log*, where `isAppendSurfaceEvent` separates a landed event from a superseded
 * or rewritten one. An event straight off `session/event` has not been through
 * that yet — the surface op is stamped as it is persisted — so it fails that
 * test while being exactly the event whose answers are wanted.
 *
 * Feeding such an event to `answerIndex` therefore yielded an empty map, and the
 * question was redrawn with nothing ticked and the typed answer gone, until a
 * reload read the same result back from the log and drew it correctly.
 *
 * The caller has already established that this block is the result of the ask
 * being redrawn, so the surface test has nothing left to decide here.
 * @param event - a `tool/result` straight from the event bus.
 * @param toolCallId - the ask this result answers.
 * @returns the answers to tick, and the settled set naming this one ask.
 */
export function answeredNow(
  event: SessionEvent<'tool/result'>,
  toolCallId: string,
): { answers: ReadonlyMap<string, Answers>; settled: ReadonlySet<string> } {
  const given = givenAnswers(event)
  const answers = new Map<string, Answers>()
  if (given !== null) answers.set(toolCallId, given)
  // Settled either way: a cancelled or failed ask has a result too, and it is
  // that fact — not the presence of answers — that ends the question's wait.
  return { answers, settled: new Set([toolCallId]) }
}

/**
 * Render one durable event as a transcript frame.
 * @param event - an event from the session log.
 * @param sessionId - the session the frame belongs to, for expand-to-URL links.
 * @param answers - answers by ask `callId`, from {@link answerIndex}; an ask with
 *   no entry is drawn as the empty form it still is.
 * @returns the frame's HTML, or null when the event contributes nothing a reader should see.
 */
export function renderEvent(
  event: SessionEvent,
  sessionId: string,
  answers: ReadonlyMap<string, Answers> = new Map(),
  settled: ReadonlySet<string> = new Set(),
): string | null {
  if (event.type === 'user/message') {
    if (!isAppendSurfaceEvent(event)) return null
    // `inject`ed context and goal continuations share this type; only a direct
    // human prompt belongs in a transcript of what the person said.
    const source: { kind?: unknown; clientMessageId?: unknown; rpcId?: unknown } = event.data.source
    // A child's report is shown, but never as the person's own words.
    if (typeof source.kind === 'string' && CHILD_KINDS.has(source.kind)) {
      const reported = blocks(event.data.content)
      return reported.length === 0 ? null : frame(event, 'subagent', reported)
    }
    if (source.kind !== 'user' && source.kind !== 'webgui') return null
    // The browser's own key rides back on the durable frame, so the page can
    // retire the optimistic copy exactly rather than by guessing at its text.
    // Two carriers, because there are two ways this page reaches an agent.
    //
    // In-process (the harness plugin, and the mock) the message keeps the
    // `source` it was built with, so the key is read straight off it.
    //
    // Through the standalone server there is a gateway in between, and its
    // prompt schema has no `clientMessageId` and mints `source.kind: 'user'`
    // itself — so the key is sent as the call's `rpcId`, which the harness
    // stamps onto the event verbatim, and is read back here. It is validated
    // exactly like the other carrier, so a genuine harness-minted rpcId from
    // some other client is simply a key this page is not holding and matches
    // nothing; `reconcile` looks up keys it owns rather than trusting the
    // attribute.
    const carried = typeof source.clientMessageId === 'string'
      ? source.clientMessageId
      : typeof source.rpcId === 'string' ? source.rpcId : null
    const key = source.kind === 'webgui' || source.kind === 'user' ? carried : null
    return frame(event, 'user', blocks(event.data.content), key)
  }
  if (event.type === 'assistant/message') {
    if (!isAppendSurfaceEvent(event)) return null
    const nodes = blocks(event.data.message.content)
    return nodes.length === 0 ? null : frame(event, 'assistant', nodes)
  }
  if (event.type === 'tool/call') {
    // A question put to the reader is not tool traffic: it is half of a
    // conversation they took part in. Folding it away would hide the question
    // behind a count, so it keeps its own role and the whole question — headers,
    // detail and every option — drawn exactly as the form that asked it.
    //
    // While it is still waiting it draws nothing at all. The live answerable
    // form is on screen for exactly that period, and it is this same question in
    // the same shape, so drawing the row too showed every waiting question
    // twice — once answerable and once inert, directly above each other. The row
    // is the *record*, so it begins when there is something to record.
    //
    // The handover is the log's own ordering, not a guess: the row appears from
    // the result event, which is the same event that drops the waiting form. So
    // there is no moment where both are drawn and none where neither is.
    // A question still waiting has no result yet, so it draws nothing and
    // returns here — before `askedQuestions`, which would otherwise build the
    // very row this exists to withhold.
    if (event.data.name === ASK_TOOL && !settled.has(event.data.callId)) return null
    const asked = askedQuestions(
      event.data.name,
      event.data.arguments,
      answers.get(event.data.callId) ?? null,
    )
    if (asked !== null) {
      // A settled ask with no answers was cancelled or failed — it carries an
      // error rather than choices. It keeps its form, drawn empty, and says so,
      // because "asked and never answered" is a different fact from "never
      // asked" and the transcript is the only place it survives.
      const nodes: Node[] = [...asked]
      if (!answers.has(event.data.callId)) {
        nodes.push({ t: 'line', cls: 'detail', s: 'This question was not answered.' })
      }
      return frame(event, 'asked', nodes)
    }
    return frame(event, 'tool', [toolLine(event.data.name, event.data.arguments, sessionId, event.seq)], null, 'call')
  }
  if (event.type === 'tool/result') {
    if (!isAppendSurfaceEvent(event)) return null
    // An answer has no row of its own: it is drawn as the ticks and the filled
    // box on the question's own form above, which is the shape the reader
    // answered in. A second row repeating the chosen labels would state the same
    // decision twice, in a shape they never saw.
    if (givenAnswers(event) !== null) return null
    return frame(event, 'tool', [toolLine(resultLabel(event), text(event.data.message.content), sessionId, event.seq)], null, 'result')
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
 * @param kind - for a tool row, whether it is the call or its result, so the page can count actions rather than rows when it folds a run.
 * @returns one `<article>` element as HTML.
 */
function frame(
  event: SessionEvent,
  role: string,
  nodes: readonly Node[],
  clientKey: string | null = null,
  kind: 'call' | 'result' | null = null,
): string {
  // The key is a browser-minted opaque id, emitted verbatim or not at all.
  //
  // It used to be stripped of anything outside the id alphabet, which looks like
  // escaping but is not: a rewritten key is a *different* string, so it silently
  // stops matching the browser's own copy and the prompt reads as sending
  // forever with no error anywhere. A value that is not already a well-formed id
  // is dropped instead — the message still renders, it simply carries no key,
  // which is a visible absence rather than a quiet mismatch.
  const key = clientKey !== null && validKey(clientKey) ? ` data-client-id="${clientKey}"` : ''
  // A closed literal union, so this attribute cannot carry arbitrary text.
  const which = kind === null ? '' : ` data-kind="${kind}"`
  return `<article data-seq="${event.seq}" data-role="${role}" data-time="${event.time}"${key}${which}>`
    + `${serializeAll(nodes)}</article>`
}

/**
 * The tool whose "call" is a question put to the person reading the transcript.
 */
export const ASK_TOOL = 'ask_user_question'

/**
 * Read a JSON string the model produced, without trusting its shape.
 * @param raw - the raw JSON text.
 * @returns the parsed value, or null when it does not parse to an object.
 */
function parseObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? { ...value }
      : null
  } catch {
    return null
  }
}

/**
 * Render the questions an `ask_user_question` call put to the reader.
 *
 * One row carries the whole exchange. It is drawn as the form that asked it —
 * every question, its detail, every option, and the free-text box — and once an
 * answer exists the choices it names are ticked into that same form. So an
 * answered question in the scrollback is the unanswered form exactly, with the
 * controls disabled and no Answer button, which is the shape the reader acted in.
 *
 * Returns null for any other tool, and for an ask whose arguments do not parse
 * — which falls back to the ordinary collapsed tool row rather than dropping
 * the event, so a malformed call is still visible.
 * @param name - the tool being called.
 * @param raw - the call's raw JSON arguments.
 * @param given - what the reader answered, or null while the question is open.
 * @returns content nodes for the transcript row, or null when this is not a readable ask.
 */
function askedQuestions(name: string, raw: string, given: Answers | null): Node[] | null {
  if (name !== ASK_TOOL) return null
  const parsed = parseObject(raw)
  const list = parsed === null ? undefined : parsed['questions']
  if (!Array.isArray(list)) return null
  const nodes: Node[] = []
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, header, question, detail, options, multiSelect }: Record<string, unknown> = { ...entry }
    // The same line the form builds: "Header: question", or the question alone
    // when it has no header.
    const head = typeof header === 'string' ? header : ''
    const body = typeof question === 'string' ? question : ''
    const title = head === '' ? body : `${head}: ${body}`
    if (title !== '') nodes.push({ t: 'line', cls: 'question', s: title })
    if (typeof detail === 'string' && detail !== '') nodes.push({ t: 'line', cls: 'detail', s: detail })
    // What this particular question was answered with, matched by the id the
    // answer carries. Absent while the question is still open, and absent for a
    // question the result never mentioned.
    const answer = given === null || typeof id !== 'string' ? undefined : given.get(id)
    const picked = answer === undefined ? [] : answer.selected
    const typed = answer === undefined ? '' : answer.custom
    // Every option the reader was offered, drawn as the control they saw. The
    // options are the question: a record that lists only what was picked hides
    // what was rejected, and the two read as completely different decisions.
    const multi = multiSelect === true
    const shownOptions = Array.isArray(options) ? options : []
    for (const option of shownOptions) {
      if (typeof option !== 'object' || option === null) continue
      const { label, description }: Record<string, unknown> = { ...option }
      if (typeof label !== 'string' || label === '') continue
      const shown = typeof description === 'string' && description !== ''
        ? `${label} — ${description}`
        : label
      // Ticked where the answer names this option. An answer records the label
      // it chose, which is what the live form submits, so the match is on the
      // same string the reader saw on the control.
      nodes.push({ t: 'choice', multi, checked: picked.includes(label), s: shown })
    }
    // The free-text row the live form always builds, so an answered question in
    // the scrollback has the same shape as the one still waiting: the box is
    // there either way, and only its contents say whether it was used.
    nodes.push({
      t: 'typed',
      multi,
      checked: typed !== '',
      s: typed,
      hint: shownOptions.length === 0 ? 'Your answer' : 'Type your own answer',
    })
  }
  return nodes.length === 0 ? null : nodes
}

/** What one question was answered with, keyed by that question's id. */
type Answers = ReadonlyMap<string, { readonly selected: readonly string[]; readonly custom: string }>

/**
 * Read the durable `ask_user_question` result into per-question answers.
 *
 * A cancelled or failed question yields null: it carries an error string rather
 * than answers, and ticking anything from it would be a lie about what the
 * person did. Such a question keeps its form drawn empty, which is the honest
 * picture — it was asked, and never answered.
 * @param event - a `tool/result` event.
 * @returns the answers by question id, or null when this is not a readable answer.
 */
function givenAnswers(event: SessionEvent<'tool/result'>): Answers | null {
  const [block] = event.data.message.content
  if (block === undefined || block.type !== 'tool-result' || block.isError === true) return null
  const parsed = parseObject(text(event.data.message.content))
  const list = parsed === null ? undefined : parsed['answers']
  if (!Array.isArray(list)) return null
  const answers = new Map<string, { selected: readonly string[]; custom: string }>()
  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const { id, selected, custom }: Record<string, unknown> = { ...entry }
    if (typeof id !== 'string' || id === '') continue
    answers.set(id, {
      selected: Array.isArray(selected) ? selected.filter(one => typeof one === 'string') : [],
      custom: typeof custom === 'string' ? custom : '',
    })
  }
  return answers.size === 0 ? null : answers
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
