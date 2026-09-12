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

const log = document.getElementById('log')

let sessionId = null
let renderedThrough = -1
let partial = null
// The transcript html, kept so the cache can be written without reading the DOM
// back and so a replace frame can consult it. The state notice is deliberately
// not part of it: a notice is a claim about a session, not a message in one.
let transcript = ''
// The single notice element currently in the log, or null. A blank transcript is
// otherwise ambiguous — a session holding nothing and one whose content has not
// arrived yet look identical — so the log carries one of these, or nothing.
let noticeEl = null

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

// Show a standalone server-rendered fragment (the expanded event view). The
// transcript cursor is dropped, so returning to the session re-reads its tail.
export function showFragment (html) {
  sessionId = null
  renderedThrough = -1
  partial = null
  transcript = ''
  noticeEl = null
  log.innerHTML = html
  chrome()
  document.scrollingElement.scrollTop = 0
}

export function through () {
  return renderedThrough
}

// Paint a session. Never blanks, never spins: memory cache first, then whatever
// the summary tier already knows, then the tail when it lands. A session holding
// nothing says so, and one whose content has not arrived says it is loading, so
// the two are never the same blank screen.
export function open (id, cache, knownEmpty) {
  sessionId = id
  partial = null
  if (cache !== undefined) {
    transcript = withoutNotice(cache.html)
    renderedThrough = cache.renderedThrough
  } else {
    transcript = ''
    renderedThrough = -1
  }
  log.innerHTML = transcript
  // The list is not a transcript, so it reports neither state.
  setNotice(id === null ? null : stateFor(transcript, knownEmpty))
  chrome()
  reconcile()
  toBottom(true)
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
  if (frame.seq <= renderedThrough && !frame.replace) return
  const stick = nearBottom()
  dropPartial()
  if (frame.replace) {
    transcript = frame.html
    log.innerHTML = transcript
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
  // The notice is not cached: a stored transcript holds only the transcript.
  store.remember(sessionId, transcript, renderedThrough)
  toBottom(stick)
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

// A queued or sending prompt appears immediately, with its state in plain words
// under it. Never a badge.
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
    toBottom(stick)
  }
  let state = el.querySelector('.state')
  if (state === null) {
    state = document.createElement('p')
    state.className = 'state'
    el.append(state)
  }
  state.textContent = row.state === 'Rejected'
    ? 'Rejected — see the details below'
    : row.state
}

// The stream showing the durable user/message is what proves delivery — never
// the POST response, which can be lost after the server already accepted. So
// this is the only thing that retires a pending row, and it matches on the key
// the server echoed back rather than on the message text.
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

export function toBottom (should) {
  if (!should) return
  const el = document.scrollingElement
  const target = el.scrollHeight - el.clientHeight
  // Writing scrollTop when it already holds the target still invalidates
  // layout, and during a token stream that runs several times a second while
  // the composer has focus — fighting the browser as it keeps the caret in
  // view. Only write when the value actually changes.
  if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
}
