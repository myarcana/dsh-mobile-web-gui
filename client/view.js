// The transcript. Append-only, permanently.
//
// The renderer is a cursor over a log holding renderedThrough; there is no diff
// anywhere. A live event on a background session advances a cursor and does zero
// DOM work. A cold deep link is renderedThrough = -1 and one append.
//
// It is append-only because the server filters to append-origin surface events:
// the model-visible surface deliberately shadows replaced ranges, so rendering
// it would let a landed compaction erase conversation someone had already read.

import { stamp, inline } from 'time'
import * as store from 'store'
import { fold } from 'group'

const log = document.getElementById('log')

let sessionId = null
let renderedThrough = -1
// The lowest seq on screen, and the bound the next backwards read starts from.
// -1 means nothing is painted, so there is no top edge to read behind yet.
let renderedFrom = -1
let partial = null
// The transcript html, kept so the cache can be written without reading the DOM
// back and so a replace frame can consult it. The state notice is deliberately
// not part of it: a notice is a claim about a session, not a message in one.
let transcript = ''
// The single notice element currently in the log, or null. A blank transcript is
// otherwise ambiguous — a session holding nothing and one whose content has not
// arrived yet look identical — so the log carries one of these, or nothing.
let noticeEl = null
// The keys the server says it is holding for the session on screen: prompts it
// has accepted but not yet written to the log.
//
// Replaced wholesale on every summary frame rather than mutated, so the page
// cannot accumulate a key the server has stopped naming. This is the whole of
// the client's delivery-state model — a set the server owns and the page reads.
let sending = new Set()
// Whether anything has been painted into the session since it was opened.
//
// `false` means the next whole-tail read is this session's first paint, and
// that paint belongs at the top — however empty the log looked on arrival, and
// whatever `nearBottom` would say about a document that was one viewport tall
// at the moment it was asked.
let landed = true

// Show, replace, or clear the one line that says what an empty log means.
// `null` clears it. There is only ever one, so the log cannot hold two claims.
function setNotice (kind) {
  if (noticeEl !== null) { noticeEl.remove(); noticeEl = null }
  if (kind === null) return
  const el = document.createElement('p')
  el.className = 'state'
  el.dataset.notice = kind
  el.textContent = kind === 'empty' ? 'This session has no messages yet.' : 'Loading…'
  log.append(el)
  noticeEl = el
}

// Choose what a transcript that has just been replaced means. A transcript is
// proof of content, so it always beats a stale flag; and emptiness is only ever
// claimed when the server said so after reading the whole log.
function stateFor (html, knownEmpty) {
  if (html !== '') return null
  return knownEmpty === true ? 'empty' : 'loading'
}

// Drop any notice out of an html string. The server paints one into the document
// on a cold deep link and that html is adopted as the transcript, but a notice is
// a claim about a session rather than part of it, so it must never be stored as
// one — a cache would otherwise keep announcing emptiness after a message landed.
function withoutNotice (html) {
  const holder = document.createElement('template')
  holder.innerHTML = html
  for (const node of holder.content.querySelectorAll('[data-notice]')) node.remove()
  return holder.innerHTML
}

export function current () {
  return sessionId
}

// Whether the session on screen is known to hold nothing. Read from the notice
// rather than a flag of its own, because the notice is already the one place
// that knows: every path that paints content clears it, so this can never claim
// a session is blank after something has landed in it.
export function blank () {
  return noticeEl !== null && noticeEl.dataset.notice === 'empty'
}

// Show a standalone server-rendered fragment (the expanded event view). The
// transcript cursor is dropped, so returning to the session re-reads its tail.
export function showFragment (html) {
  sessionId = null
  renderedThrough = -1
  renderedFrom = -1
  partial = null
  transcript = ''
  noticeEl = null
  // This screen is its own content, already painted. Nothing is waiting to fill
  // it, so it is not a session's first paint and must not claim to be one.
  landed = true
  log.innerHTML = html
  chrome()
  document.scrollingElement.scrollTop = 0
}

export function through () {
  return renderedThrough
}

// The oldest seq painted, which the backwards read uses as its upper bound.
export function from () {
  return renderedFrom
}

// The topmost row with any part of it on screen: what the reader is looking at,
// and so the thing a prepend must not move. Falls back to the first row when
// nothing qualifies, which happens only when the log is shorter than the
// viewport and there is nothing to hold still anyway.
//
// A one-shot read during a tap. Not a scroll handler; none exists in this app.
function visibleRow () {
  for (const article of log.querySelectorAll('article')) {
    if (article.getBoundingClientRect().bottom > 0) return article
  }
  return log.querySelector('article')
}

// How far one row sits from the top of the document, by layout rather than by
// scroll. `offsetTop` is measured against the offset parent, so the chain is
// walked to the root; nothing here consults the scroll offset, which is the
// whole point — the value stays true while the browser is clamping it.
function documentTop (node) {
  let total = 0
  for (let at = node; at !== null; at = at.offsetParent) total += at.offsetTop
  return total
}

// The lowest seq the log currently holds, read from the rows themselves. A
// folded run reports the seq it was built with, so this is stable across the
// fold rather than drifting as runs collapse.
function oldestOnScreen () {
  let lowest = -1
  for (const article of log.querySelectorAll('article[data-seq]')) {
    const seq = Number(article.dataset.seq)
    if (!Number.isSafeInteger(seq)) continue
    if (lowest === -1 || seq < lowest) lowest = seq
  }
  return lowest
}

// Seat one row at its seq, before the first row that is newer than it.
//
// For a frame that is not an append: an answered question's row is older than
// the work the agent did while it waited, so it belongs above that work rather
// than at the bottom. Falls back to appending when every row on screen is older,
// which is the ordinary case of a question answered promptly.
function placeBySeq (seq, html) {
  const holder = document.createElement('template')
  holder.innerHTML = html
  const row = holder.content.firstElementChild
  if (row === null) return
  for (const article of log.querySelectorAll('article[data-seq]')) {
    const at = Number(article.dataset.seq)
    if (Number.isSafeInteger(at) && at > seq) {
      article.before(row)
      return
    }
  }
  log.append(row)
}

// Merge a chunk of history into the log in seq order.
//
// A plain prepend is wrong once the transcript keeps rows the bounded window did
// not cover: the first paint holds every prompt and answered question however
// far back it sits, so rows older than the incoming chunk are already on screen,
// and the chunk's own range straddles them. Inserting it as one block would read
// as seq 1600 sitting between seq 2 and seq 1, whichever end it was put at.
//
// So each frame is seated individually, against a cursor that only ever moves
// forward through the rows already present. That makes the merge one pass over
// each list rather than a scan per frame, and it is stable: a frame already on
// screen is dropped rather than drawn twice, which is what keeps a re-read of an
// overlapping range from doubling the transcript.
function merge (html, after) {
  const holder = document.createElement('template')
  holder.innerHTML = html
  const incoming = [...holder.content.children]
  if (incoming.length === 0) return
  // The rows already on screen, in document order, with their seqs.
  const present = []
  for (const article of log.children) {
    if (article === after) continue
    const seq = Number(article.dataset.seq)
    present.push({ node: article, seq: Number.isSafeInteger(seq) ? seq : null })
  }
  const seen = new Set()
  for (const { seq } of present) if (seq !== null) seen.add(seq)
  let at = 0
  for (const frame of incoming) {
    const raw = Number(frame.dataset.seq)
    const seq = Number.isSafeInteger(raw) ? raw : null
    // Already drawn: an overlapping re-read must not double a row.
    if (seq !== null && seen.has(seq)) continue
    // Walk forward to the first row this frame belongs before. A row with no seq
    // of its own (a pending prompt, a partial) is never a boundary, so it keeps
    // whatever neighbours it had.
    while (at < present.length && (present[at].seq === null || seq === null || present[at].seq < seq)) at += 1
    if (at < present.length) present[at].node.insertAdjacentElement('beforebegin', frame)
    else log.append(frame)
    if (seq !== null) seen.add(seq)
  }
}

// Put older frames above everything on screen, holding the reader's place.
//
// A prepend pushes every row below it down by the height of what arrived, so
// without a correction the reader's content flies off the bottom of the screen.
//
// The correction measures one real row rather than the document: browsers
// implement scroll anchoring and move `scrollTop` themselves when content is
// inserted above the viewport, by an amount that is neither guaranteed nor
// equal to the height delta. Adding the delta on top of that correction applies
// it twice — measured at 10900px of drift on a 400-row prepend. So a row that
// exists on both sides of the insert is measured before and after, and only the
// distance it actually moved is taken out. If the browser already did the work,
// that distance is zero and nothing further happens.
//
// Both reads are one-shot, during a tap. No scroll listener exists here.
export function prepend (html, after) {
  if (html === '') return
  const el = document.scrollingElement
  // The row to keep still is one the reader can actually see. The log's first
  // article is the wrong choice: after scrolling down it sits above the
  // viewport, and the browser's own anchoring works from something on screen,
  // so correcting against an off-screen row fights it and lands the reader
  // somewhere neither of them intended.
  const anchor = visibleRow()
  // Where the anchor sits in the viewport: the distance from the top of the
  // screen that has to be preserved.
  const top = anchor === null ? 0 : anchor.getBoundingClientRect().top
  // Seated in seq order rather than simply put on top: rows older than this
  // chunk are routinely already on screen, because the first paint keeps every
  // prompt and answered question however far back it sits.
  merge(html, after)
  // The link belongs at the very top, above the oldest thing on screen, or each
  // tap would bury it further down the page.
  if (after !== undefined && after !== null && after.parentNode === log) log.prepend(after)
  // History is content, so a notice claiming there is none is spent.
  if (noticeEl !== null) setNotice(null)
  chrome()
  // Folding collapses runs of tool rows into single lines, which changes the
  // height of what was just inserted. Correcting before that would hold the
  // reader against a layout that no longer exists a line later, so the anchor is
  // settled only once the rows above it have taken their final size.
  fold(log, sessionId)
  // Put the anchor back where the reader had it: scroll to its position in the
  // document, less the offset down the screen it started at.
  //
  // `offsetTop` is used rather than `getBoundingClientRect().top + scrollTop`,
  // because the second is only a document position while `scrollTop` holds the
  // live value — and inserting this much content above the viewport makes the
  // browser clamp the offset to 0 mid-update, which silently drops exactly the
  // distance being corrected for. `offsetTop` is a layout property and owes
  // nothing to the current scroll, so it survives the clamp.
  if (anchor !== null) el.scrollTop = documentTop(anchor) - top
  renderedFrom = oldestOnScreen()
}

// Re-read the open session's tail without disturbing what is on screen.
//
// Dropping a cache is a statement about storage, not about the rows the reader
// is looking at: those are still the bytes the server sent. Repainting through
// `open` with no cache would blank the log and spin, so the cursor alone is
// rewound and the incoming replace frame swaps the content in one paint.
export function rewind () {
  if (sessionId === null) return
  renderedThrough = -1
}

// Paint a session. Never blanks, never spins: memory cache first, then whatever
// the summary tier already knows, then the tail when it lands. A session holding
// nothing says so, and one whose content has not arrived says it is loading, so
// the two are never the same blank screen.
export function open (id, cache, knownEmpty) {
  sessionId = id
  partial = null
  // Delivery state belongs to the session being left, not the one being opened.
  // The next summary frame refills this for the new session; until it lands, an
  // unproven prompt reads as Queued, which is the truthful thing to say about a
  // prompt this page has not been told anything about.
  sending = new Set()
  if (cache !== undefined) {
    transcript = withoutNotice(cache.html)
    renderedThrough = cache.renderedThrough
  } else {
    transcript = ''
    renderedThrough = -1
  }
  // Always written, including the empty string that clears the log on the way to
  // the list.
  //
  // Leaving the transcript in place for the list to sweep up does not work: the
  // list's reconcile matches children by `data-key` and removes only the keyed
  // ones it did not claim. Transcript rows carry no key at all, so they are
  // invisible to that sweep and survive it — the list then renders with a whole
  // transcript hanging off the bottom of it.
  //
  // The height a navigation needs held is preserved by the router instead, which
  // pins it across the transition rather than asking this function to leave
  // content on screen to prop the document up.
  log.innerHTML = transcript
  renderedFrom = oldestOnScreen()
  // The list is not a transcript, so it reports neither state.
  setNotice(id === null ? null : stateFor(transcript, knownEmpty))
  chrome()
  reconcile()
  // Folding is a presentation pass over the painted rows. `transcript` keeps the
  // server's unfolded html, so what the cache stores and what a later replace
  // frame compares against are unaffected by it.
  fold(log, sessionId)
  // Arriving at a session puts the reader at the top of it, not the bottom.
  // Opening a session is a navigation, and a navigation lands at the start of
  // the page it went to — the same as every other route this app serves.
  //
  // This is written rather than merely left alone because the reader arrives
  // from somewhere they had scrolled, and the browser keeps that offset across
  // a repaint that never moved the scroll position itself.
  //
  // Only for a session. Routing to the list is the one case where somebody else
  // owns the offset: a tap forward is a fresh history entry that starts at the
  // top by itself, and a step back is a restoration the browser is performing
  // from the entry it saved. Writing zero here would overwrite that restoration
  // with the very value the collapse used to produce.
  if (id !== null) document.scrollingElement.scrollTop = 0
  // The tail arrives moments later as a replace frame. `append` decides whether
  // to follow it to the bottom by asking `nearBottom()`, and that question is
  // meaningless here: a switch routinely paints from an empty cache, so the log
  // is empty, the document is one viewport tall, and "near the bottom" is
  // trivially true of a page with no bottom to be near. Answering it honestly
  // would send the reader to the end of a transcript they just opened.
  //
  // So the first paint of a session is marked as such, and the frame that fills
  // it lands at the top instead of asking.
  landed = false
}

// Store the adopted first paint. Separate from {@link open} because only the
// caller knows whether that html came from the server or from the cache.
export function rememberCurrent () {
  if (sessionId === null) return
  store.remember(sessionId, transcript, renderedThrough)
}

// Append durable frames. `replace` means the server sent a whole tail rather
// than an increment.
export function append (frame) {
  if (frame.sessionId !== sessionId) return
  // A frame that names a row already on screen restates that row rather than
  // adding one. An answered question is the case: the answer belongs on the
  // question's own form, so the server re-sends that frame with the choices
  // ticked instead of opening a second row below it.
  if (frame.amends !== undefined) {
    const standing = log.querySelector('article[data-seq="' + CSS.escape(String(frame.amends)) + '"]')
    const stuck = nearBottom()
    // A question draws no row while it is still waiting — the answerable form is
    // on screen instead, and a row as well would be the same question twice. So
    // this frame is routinely the row's *first* appearance, not an edit to one,
    // and it has to be placed rather than dropped.
    //
    // It goes at its own seq, which is where a reload would put it: the ask is
    // older than whatever the agent did while waiting, so appending it at the
    // bottom would file the question after work that happened after it.
    if (standing === null) {
      placeBySeq(frame.amends, frame.html)
      // Only a newly seated row needs this. `asked` ends a run, so a question
      // landing between tool rows has to split the line they were folded into —
      // which is what a reload would show. Re-folding is idempotent, so the two
      // agree. A replaced row was already standing and already split its run.
      fold(log, sessionId)
    } else {
      standing.outerHTML = frame.html
    }
    // The stored copy is the log's own markup, so it follows the same edit
    // rather than being rebuilt from a string this function no longer holds.
    transcript = log.innerHTML
    store.remember(sessionId, transcript, renderedThrough)
    toBottom(stuck)
    return
  }
  if (frame.seq <= renderedThrough && !frame.replace) return
  // A whole-tail read that fills a session's first paint is the navigation
  // finishing, not the reader being carried along by new work, so it lands at
  // the top. `nearBottom` cannot answer this: the log it would measure is the
  // empty one a switch paints from cache, where there is no bottom to be near.
  const first = frame.replace === true && !landed
  const stick = first ? false : nearBottom()
  dropPartial()
  if (frame.replace) {
    transcript = frame.html
    log.innerHTML = transcript
    // A whole-tail read repaints the log, so any history prepended above it is
    // gone and the top edge moves back to whatever the tail starts at.
    renderedFrom = oldestOnScreen()
    // Only a whole-tail read can answer emptiness, which is why the flag rides
    // on a replace frame and never on a live one.
    setNotice(stateFor(transcript, frame.empty))
  } else {
    transcript += frame.html
    log.insertAdjacentHTML('beforeend', frame.html)
    // Content just landed, so a notice about there being none is spent.
    if (frame.html !== '') setNotice(null)
  }
  renderedThrough = Math.max(renderedThrough, frame.seq)
  chrome()
  reconcile()
  // Re-fold after the append. The pass is idempotent, so a run that just grew by
  // one call absorbs it into the line already standing for the rest.
  fold(log, sessionId)
  // The notice is not cached: a stored transcript holds only the transcript.
  store.remember(sessionId, transcript, renderedThrough)
  // Content exists now, so later frames are ordinary appends and go back to
  // asking where the reader is standing.
  if (frame.html !== '') landed = true
  // The first paint is put at the top here rather than in `open`, because only
  // now does the document have the height for that write to mean anything: the
  // log `open` wrote against was empty and the browser had nowhere to put it.
  if (first) document.scrollingElement.scrollTop = 0
  else toBottom(stick)
}

// Live, uncommitted assistant text. Offset snapshots, so a dropped frame costs
// nothing: a mismatched offset resyncs instead of corrupting.
export function token (frame) {
  if (frame.sessionId !== sessionId) return
  const stick = nearBottom()
  // Streaming text is proof of content, so a notice saying there is none would
  // contradict it. Clearing here keeps the paint order right.
  if (noticeEl !== null) setNotice(null)
  if (partial === null || partial.revision !== frame.revision) {
    partial = document.createElement('article')
    partial.dataset.role = 'assistant'
    partial.dataset.partial = ''
    partial.revision = frame.revision
    partial.textContent = ''
    log.append(partial)
  }
  if (frame.off === partial.textContent.length) partial.textContent += frame.s
  else if (frame.off === 0) partial.textContent = frame.s
  toBottom(stick)
}

function dropPartial () {
  if (partial !== null) { partial.remove(); partial = null }
}

// A prompt that has not reached the transcript yet appears immediately, with its
// state in plain words under it. Never a badge.
//
// The words come from the server wherever the server has an opinion. This
// element exists only so the reader sees their own prompt before the round trip
// finishes; what it *says* about delivery is decided by `sending` (see
// `deliveryState`), never by the outbox's private view of its own queue.
export function pending (row) {
  if (row.sessionId !== sessionId) return
  // The durable message can beat the outbox's own state update on a fast link.
  // Once the log holds it, the optimistic copy must never come back.
  if (log.querySelector('article[data-client-id="' + CSS.escape(row.clientMessageId) + '"]') !== null) return
  // A prompt is content, so a notice claiming the session is empty is spent.
  if (noticeEl !== null) setNotice(null)
  let el = log.querySelector('[data-pending="' + CSS.escape(row.clientMessageId) + '"]')
  if (el === null) {
    const stick = nearBottom()
    el = document.createElement('article')
    el.dataset.role = 'user'
    el.dataset.pending = row.clientMessageId
    const body = document.createElement('p')
    body.textContent = row.text
    el.append(body)
    log.append(el)
    // Forced past the typing guard: this row is the reader's own prompt, landing
    // because they just pressed Send. The composer still has focus — sending
    // does not take it — so the guard would otherwise decline exactly the one
    // append the reader is waiting to see.
    toBottom(stick, true)
  }
  // Rejection is the one state the server cannot express, because a refused
  // prompt is one it never took responsibility for. Everything else defers.
  if (row.state === 'Rejected') el.dataset.rejected = ''
  else delete el.dataset.rejected
  paintState(el)
}

// Write the one line under an un-delivered prompt.
//
// Three states, one author: rejected is local (the server refused it and said
// why, in full, elsewhere on the page); sending means the server says it is
// holding the key; queued means it does not. "Queued" is therefore the honest
// default for a prompt the server has never heard of — including one sitting in
// the outbox with no signal to send it over.
function paintState (el) {
  let state = el.querySelector('.state')
  if (state === null) {
    state = document.createElement('p')
    state.className = 'state'
    el.append(state)
  }
  if (el.dataset.rejected !== undefined) {
    state.textContent = 'Rejected — see the details below'
    return
  }
  state.textContent = sending.has(el.dataset.pending) ? 'Sending' : 'Queued'
}

// Adopt the server's in-flight set for the focused session and repaint.
//
// Called on every summary frame, which is what makes the indicator self-healing:
// a missed frame is corrected by the next one, and there is no state the page
// can get stuck in because nothing here is remembered across frames.
export function delivery (rows) {
  if (sessionId === null) return
  const row = rows.find(candidate => candidate.id === sessionId)
  sending = new Set(row === undefined ? [] : row.sending)
  for (const el of log.querySelectorAll('[data-pending]')) paintState(el)
}

// The stream showing the durable user/message is what proves delivery — never
// the POST response, which can be lost after the server already accepted. So
// this is the only thing that retires a pending row, and it matches on the key
// the server echoed back rather than on the message text.
//
// The second loop is the reconciliation of last resort. The first loop can only
// retire an optimistic copy whose durable twin is on screen right now, so a
// transcript that was replaced — or a frame applied without a matching pass —
// used to strand the copy forever, because the outbox row had already been
// dequeued and nothing would ever revisit that key. Anything still claiming to
// be pending is therefore checked against the transcript directly.
function reconcile () {
  for (const durable of log.querySelectorAll('article[data-client-id]')) {
    const key = durable.dataset.clientId
    const optimistic = log.querySelector('[data-pending="' + CSS.escape(key) + '"]')
    if (optimistic !== null) optimistic.remove()
    if (durable.querySelector('.state') !== null) continue
    const state = document.createElement('p')
    state.className = 'state'
    state.textContent = 'Delivered at ' + inline(Number(durable.dataset.time))
    durable.append(state)
  }
  for (const optimistic of log.querySelectorAll('[data-pending]')) {
    const key = optimistic.dataset.pending
    if (log.querySelector('article[data-client-id="' + CSS.escape(key) + '"]') !== null) optimistic.remove()
  }
}

// Client-built chrome: the server never sends a formatted time, because only
// this browser knows the reader's zone.
function chrome () {
  for (const article of log.querySelectorAll('article[data-time]')) {
    if (article.dataset.stamped === '') continue
    article.dataset.stamped = ''
    article.append(stamp(Number(article.dataset.time)))
  }
}

// A one-shot read during an append. Not a scroll handler; no scroll or wheel
// listener exists anywhere in this app.
export function nearBottom () {
  const el = document.scrollingElement
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}

// `sent` is the reader's own prompt arriving, which scrolls even while the
// composer has focus.
export function toBottom (should, sent) {
  if (!should) return
  // Not while the reader is typing. A caret in the composer is the browser's to
  // keep in view, and it re-reveals the field after anything that moves the
  // document. Writing scrollTop underneath that starts a fight the reader sees
  // as the transcript shuffling on every keypress: the write scrolls the page,
  // the browser scrolls it back to the caret, and a streaming session runs that
  // exchange several times a second.
  //
  // Nothing is lost by declining. The composer is pinned to the bottom of the
  // viewport, so someone typing is already looking at the newest end of the
  // transcript; and the next append after the box loses focus lands them there
  // anyway. Sending re-anchors explicitly, because `pending` appends a row.
  if (sent !== true && typing()) return
  const el = document.scrollingElement
  const target = el.scrollHeight - el.clientHeight
  // Writing scrollTop when it already holds the target still invalidates
  // layout, and during a token stream that runs several times a second. Only
  // write when the value actually changes.
  if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
}

// Whether the reader has the message box open and focused.
//
// Read from `document.activeElement` at the moment of the append rather than
// tracked with focus listeners, so it cannot disagree with where focus actually
// is — the same reason the action row uses `:focus-within` rather than a flag.
function typing () {
  const active = document.activeElement
  return active !== null && active.closest('#composer') !== null
}
