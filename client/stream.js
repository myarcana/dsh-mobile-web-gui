// One EventSource, multiplexed across every session.
//
// EventSource re-sends the last id: as Last-Event-ID forever, with no code on
// our side. Dropped signal, slept radio, discarded tab — one path.
//
// Battery: the stream is closed while the page is hidden and resumed from its
// cursor on return. A backgrounded tab holds no socket, wakes no radio, and
// runs no timer; correctness is untouched because resume is only ever a slice
// by seq. Nothing here polls.

import * as wire from 'wire'
import * as errors from 'errors'

const HIDDEN_GRACE_MS = 20000
const STALE_MS = 40000

let source = null
let streamId = null
let epoch = null
let lastFrameAt = 0
let hideTimer = null
let handlers = {}
let wanted = null

export function connect (on) {
  handlers = on
  start()
  addEventListener('pageshow', revive)
  addEventListener('online', revive)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // A brief app switch should not cost a reconnect; a real background does.
      hideTimer = setTimeout(stop, HIDDEN_GRACE_MS)
    } else {
      clearTimeout(hideTimer)
      revive()
    }
  })
}

function start () {
  if (source !== null) return
  source = new EventSource('/api/stream')
  lastFrameAt = Date.now()
  source.addEventListener('epoch', event => {
    lastFrameAt = Date.now()
    const data = JSON.parse(event.data)
    // Durable seqs survive a restart; summary watermarks do not. A restart is a
    // visible non-event rather than a quiet divergence.
    if (epoch !== null && epoch !== data.epoch) handlers.restarted()
    epoch = data.epoch
    streamId = data.streamId
    // Where the transcript stands *now*, never where it stood when the session
    // was opened. Re-sending that first cursor on every reconnect asked for
    // everything since the open again, and it was drawn once more under the copy
    // already on screen — the same prompt repeated once per reconnect.
    if (wanted !== null) send(wanted, handlers.through())
  })
  source.addEventListener('e', event => {
    lastFrameAt = Date.now()
    handlers.event(wire.eventFrame(JSON.parse(event.data)))
  })
  source.addEventListener('s', event => {
    lastFrameAt = Date.now()
    handlers.summaries(wire.listing(JSON.parse(event.data)))
  })
  source.addEventListener('t', event => {
    lastFrameAt = Date.now()
    handlers.token(wire.tokenFrame(JSON.parse(event.data)))
  })
  source.addEventListener('message', () => { lastFrameAt = Date.now() })
  source.onerror = () => { lastFrameAt = Date.now() }
}

function stop () {
  if (source === null) return
  source.close()
  source = null
  streamId = null
}

// A stream can be dead while the browser believes it is open, and no browser
// reliably fires error. So check a fact we own rather than trusting the event.
function revive () {
  if (source === null) { start(); return }
  if (Date.now() - lastFrameAt > STALE_MS) { stop(); start() }
}

// Move the durable and token tiers to another session without reopening the
// stream — a reconnect is the one thing you cannot afford on a bad link.
export function focus (sessionId, from) {
  wanted = sessionId
  if (streamId === null) { start(); return }
  send(sessionId, from)
}

function send (sessionId, from) {
  fetch('/api/focus', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ streamId, sessionId, from })
  }).then(response => {
    if (response.status === 409) { stop(); start(); return }
    if (!response.ok) return errors.fromResponse('POST', '/api/focus', response, 'Session: ' + sessionId)
  }).catch(() => {
    // No signal. The stream's own resume will re-establish focus on return.
  })
}
