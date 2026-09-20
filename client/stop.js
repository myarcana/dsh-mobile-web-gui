// Stop the turn a session is working on.
//
// The control is offered only while the server says this session can be
// stopped: the row's own `actions` list carries `stop` exactly while its agent
// is running, so the page branches on what the host actually reports rather
// than on a rule written into the client. A cold session, or a host that cannot
// cancel, sends no `stop` action and there is simply no button — instead of one
// that appears and then fails.
//
// It lives in the title menu, beside Archive, because both are things done *to*
// a session rather than to the draft in the box. That also means the button is
// built on demand and thrown away when the menu closes, so no state worth
// keeping can live on it — `stopping` below is held at module scope for exactly
// that reason.
//
// Deliberately not an outbox row. A queued prompt is worth delivering an hour
// late, but "stop what you are doing now" is not: replayed after a reconnect it
// would kill whatever turn happens to be running by then. So this posts once,
// live, and says plainly when it could not get through.

import * as errors from 'errors'

// The session whose stop is in flight. Held here rather than on the button so
// closing and reopening the menu cannot lose it and let a second tap send a
// second request.
let stopping = null

// Whether this session is one the host says can be stopped right now.
//
// `row` is the session's summary, or undefined before the first list frame
// lands. Undefined offers nothing: the page has not been told this session is
// running, and offering to stop something it knows nothing about would be a
// guess.
export function offered (id, row) {
  return id !== null && row !== undefined && row.actions.includes('stop')
}

// Whether a stop for this session is still in flight, which is what the menu
// folds into its redraw key so the button's own busy state survives a repaint.
export function busy (id) {
  return stopping === id
}

// The control, built for one session. Named for the session it acts on, so what
// a screen reader announces says which session is about to be interrupted.
export function button (id, row) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'quiet'
  const working = stopping === id
  button.disabled = working
  button.textContent = working ? 'Stopping' : 'Stop this session'
  const name = 'Stop ' + title(row)
  button.title = name
  button.setAttribute('aria-label', name)
  button.addEventListener('click', () => { stop(id, row, button) })
  return button
}

// Ask the host to cancel this session's current turn.
//
// Nothing here paints the result. The turn ending is a fact about the session,
// so it arrives the way every other such fact does — the next summary frame
// drops the `stop` action and the menu redraws without this button.
async function stop (id, row, button) {
  if (id === null || stopping !== null) return
  stopping = id
  button.disabled = true
  button.textContent = 'Stopping'
  let response
  try {
    response = await fetch('/api/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id })
    })
  } catch (error) {
    release(button)
    errors.show('Could not stop ' + title(row), 'POST /api/stop\nSession: ' + id + '\n' + error + '\nAt: ' + new Date().toString())
    return
  }
  if (!response.ok) {
    release(button)
    await errors.fromResponse('POST', '/api/stop', response, 'Session: ' + id)
    return
  }
  stopping = null
}

// Give the control back after a failure, so the reader can try again. The error
// is already on the page in full, so this adds nothing to it.
function release (button) {
  stopping = null
  button.disabled = false
  button.textContent = 'Stop this session'
}

// Forget any stop in flight for a session that is no longer on screen.
//
// Holding the id of a session the reader has left would refuse every future tap
// on it, and the reply it was waiting on can no longer paint anything.
export function forget () {
  stopping = null
}

// This session's own name, never "this session": the error is meant to be read
// away from the screen it happened on.
function title (row) {
  return row === undefined ? 'this session' : row.title
}
