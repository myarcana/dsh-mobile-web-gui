// The entry point imports every leaf directly, and the document carries a full
// modulepreload list, so the browser fetches the whole set at once instead of
// discovering the app one file at a time. Import chains cost round trips, and
// round trips are what a bad link charges most for.

import * as router from 'router'
import * as stream from 'stream'
import * as outbox from 'outbox'
import * as store from 'store'
import * as view from 'view'
import * as chooser from 'chooser'
import * as errors from 'errors'
import * as keyboard from 'keyboard'
import * as wire from 'wire'
import * as ask from 'ask'
import * as create from 'create'

const boot = JSON.parse(document.getElementById('boot').textContent)
const log = document.getElementById('log')
const composer = document.getElementById('composer')
const box = document.getElementById('box')
const heading = document.getElementById('title')
const crumbs = document.getElementById('crumbs')

// Per session, keyed by id: the composer draft.
const drafts = new Map()

errors.mount(document.getElementById('errors'))
keyboard.track(composer)
errors.listen()
create.mount()

// The server already rendered this route's transcript into the document, so the
// first paint happened before any of this ran. Adopt it rather than repaint it.
if (boot.sessionId !== null) {
  view.open(boot.sessionId, { html: log.innerHTML, renderedThrough: boot.renderedThrough })
  store.remember(boot.sessionId, log.innerHTML, boot.renderedThrough)
}
ask.render(boot.sessionId, wire.asks(boot.asks))
create.show(boot.showTools === true)

// A created session is not a log event, so nothing else would take the reader
// there. Land on the thing they just made; the server pushes the list row.
create.observe(sessionId => {
  if (sessionId !== null) router.go('/s/' + encodeURIComponent(sessionId))
})

await store.boot()

outbox.observe(row => {
  if (row.askId === undefined) view.pending(row)
  else ask.state(row)
})
outbox.listen()

stream.connect({
  event (frame) {
    if (frame.sessionId === view.current()) view.append(frame)
  },
  token (frame) { view.token(frame) },
  summaries (listing) {
    chooser.update(listing)
    create.update(listing)
    // The s frames carry each session's latest seq, so a stale cached render is
    // detected before the reader ever taps it.
    for (const row of listing.rows) {
      if (store.invalidateIfAhead(row.id, row.latestSeq) && row.id === view.current()) {
        view.open(row.id, undefined)
        stream.focus(row.id, -1)
      }
    }
    ask.render(view.current(), chooser.find(view.current())?.asks)
    retitle()
  },
  restarted () {
    // Only the watermarks are gone. Ask for this session's tail from where the
    // transcript actually stands.
    if (view.current() !== null) stream.focus(view.current(), view.through())
  }
})

router.start(path => {
  // The dialog element is shared by every route, so a status line left behind
  // by a finished create would otherwise survive the navigation and appear on
  // whichever session opens next.
  create.reset()
  const event = /^\/s\/([^/]+)\/e\/(\d+)$/.exec(path)
  if (event !== null) return expand(event[1], event[2])
  const match = /^\/s\/([^/]+)/.exec(path)
  if (match === null) {
    view.open(null, undefined)
    ask.render(null, undefined)
    chooser.show()
    composer.hidden = true
    create.show(true)
    heading.textContent = 'Sessions'
    crumbs.textContent = ''
    return
  }
  const id = decodeURIComponent(match[1])
  chooser.hide()
  create.show(false)
  // Synchronous read: the switch paints in this frame, with no spinner and no
  // blank. The tail arrives afterwards and appends. Repainting the session
  // already on screen would throw away the server-rendered first paint.
  if (view.current() !== id) view.open(id, store.cached(id))
  ask.render(id, chooser.find(id)?.asks)
  stream.focus(id, view.through())
  box.value = drafts.get(id) ?? ''
  retitle()
  outbox.drain()
})

// The expanded event view is its own screen with its own URL, fetched as a
// fragment so opening one never tears down the stream.
async function expand (id, seq) {
  chooser.hide()
  ask.render(null, undefined)
  composer.hidden = true
  const url = '/api/s/' + encodeURIComponent(id) + '/e/' + seq
  heading.textContent = 'One event'
  crumbs.textContent = ''
  const up = document.createElement('a')
  up.href = '/s/' + encodeURIComponent(id)
  up.textContent = 'Back to the session'
  crumbs.append(up)
  let response
  try {
    response = await fetch(url)
  } catch (error) {
    errors.show('Could not load event ' + seq, 'GET ' + url + '\n' + error + '\nAt: ' + new Date().toString())
    return
  }
  if (!response.ok) return errors.fromResponse('GET', url, response, 'Session: ' + id)
  view.showFragment(wire.expandedEvent(await response.json()).html)
}

function retitle () {
  const id = view.current()
  // A cold session has no live agent to receive a prompt, so it is read-only.
  // The row's own capability list decides, and the route's server-rendered
  // answer stands in until the first summary frame arrives.
  composer.hidden = !canPrompt(id)
  if (id === null) return
  const row = chooser.find(id)
  heading.textContent = row === undefined ? 'Session' : row.title
  crumbs.textContent = ''
  const home = document.createElement('a')
  home.href = '/sessions'
  home.textContent = 'Sessions'
  crumbs.append(home)
  if (row !== undefined) {
    // Links back to this session's group on the list, by the group's stable id
    // rather than its title, which two workspaces may share.
    const where = document.createElement('a')
    where.href = '/sessions#' + encodeURIComponent(row.workspaceId)
    where.textContent = row.workspace
    crumbs.append(where)
  }
}

function canPrompt (id) {
  if (id === null) return false
  const row = chooser.find(id)
  if (row === undefined) return id === boot.sessionId && boot.canSend === true
  return row.actions.includes('send')
}

composer.addEventListener('submit', async event => {
  event.preventDefault()
  const text = box.value.trim()
  const id = view.current()
  if (text === '' || id === null) return
  box.value = ''
  drafts.delete(id)
  await outbox.queue(id, { text })
})

box.addEventListener('input', () => {
  const id = view.current()
  if (id !== null) drafts.set(id, box.value)
})

// Enter sends on a hardware keyboard; a phone's return key uses enterkeyhint.
box.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    composer.requestSubmit()
  }
})

// Press feedback arms on pointerdown and applies only after a hold, so a finger
// on its way to scrolling never lights up a control. Any travel disarms it, and
// so does the browser claiming the gesture.
let armed = null
document.addEventListener('pointerdown', event => {
  const target = event.target.closest('a, button')
  if (target === null) return
  armed = { target, x: event.clientX, y: event.clientY, timer: setTimeout(() => {
    target.dataset.pressed = ''
  }, 100) }
}, { passive: true })
document.addEventListener('pointermove', event => {
  if (armed === null) return
  if (Math.abs(event.clientX - armed.x) > 10 || Math.abs(event.clientY - armed.y) > 10) disarm()
}, { passive: true })
document.addEventListener('pointerup', disarm)
document.addEventListener('pointercancel', disarm)

function disarm () {
  if (armed === null) return
  clearTimeout(armed.timer)
  delete armed.target.dataset.pressed
  armed = null
}
