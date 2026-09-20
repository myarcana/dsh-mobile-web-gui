// The control that turns notifications on for this device, and the screen
// behind it.
//
// It sits at the top of the session list because that is where a reader looks
// to find out what wants them — the same question a notification answers when
// they are not looking at all.
//
// `/sessions/notifications` is a screen of its own, as every full-screen change
// here is: it pushes history, survives a reload, and opens the same thing when
// pasted into another browser.
//
// Everything it says comes from the server's answer for this exact device, not
// from `Notification.permission`. Permission granted once, on a device whose
// subscription this server never recorded, is not "on" — and showing it as on
// would promise notifications that never arrive.

import * as notify from 'notify'
import * as errors from 'errors'
import * as router from 'router'

// Its own container rather than the shared `#dialog`, which `create.reset()`
// empties on every route change — including the one that opens this screen.
const host = document.getElementById('alerts')

// The last status the server gave, so the row can be drawn before a fresh ask
// resolves. Null until the first one lands.
let state = null

// Whether the full screen is open. Held so a status refresh repaints whatever
// is currently on screen without the caller having to say which.
let open = false

// Draw or take down the notifications screen.
//
// `mount(false)` is called on every route that is not this one, which is what
// makes the back button the way out — the same contract the session menu keeps.
export function mount (wanted) {
  open = wanted
  if (host === null) return
  if (!open) {
    host.hidden = true
    host.replaceChildren()
    return
  }
  host.hidden = false
  host.replaceChildren(screen())
}

// True while a subscribe or unsubscribe is in flight, so a second tap cannot
// start a second one.
let busy = false

let onChange = () => {}

// Tell the caller when to repaint, since the list owns its own rendering.
export function observe (fn) {
  onChange = fn
}

// Repaint whatever this module currently has on screen, then let the list
// repaint its own row. One call site for both, so the row and the screen can
// never be drawn from different answers.
function changed () {
  if (open) mount(true)
  onChange()
}

// Ask the server what it holds for this device and repaint when it answers.
//
// Called once at boot and after every change. Never throws: a failure to read
// status leaves the control saying what it last knew, and the error itself is
// already rendered into the page by `notify`.
export async function refresh () {
  if (!notify.supported()) {
    state = { supported: false, blocked: false, enabled: false, endpoint: '' }
    changed()
    return
  }
  try {
    state = await notify.status()
  } catch (error) {
    errors.show('Could not read notification status', String(error && error.stack ? error.stack : error) + '\nAt: ' + new Date().toString())
    state = { supported: true, blocked: false, enabled: false, endpoint: '' }
  }
  changed()
  // The server suppresses a notification for a device that is watching the
  // page, and this is how it is told. Sent after status so it is only ever sent
  // by a device that actually has a subscription to name.
  await notify.present()
}

// One line for the top of the session list: what this device will be told, and
// the way to the screen that changes it.
//
// Deliberately a link to a URL rather than a button that toggles in place. The
// permission prompt it leads to is a decision worth a screen of its own, and a
// toggle that silently fails because the browser refused permission is exactly
// the drift this project's rules exist to prevent.
export function row () {
  const line = document.createElement('a')
  line.className = 'alerts'
  line.href = '/sessions/notifications'
  // No branching on what the reader "should" be able to do — only on what the
  // server and the browser actually reported.
  if (state === null) line.textContent = 'Notifications'
  else if (!state.supported) line.textContent = 'Notifications are not available in this browser'
  else if (state.blocked) line.textContent = 'Notifications are blocked for this site'
  else if (state.enabled) line.textContent = 'Notifications are on for this device'
  else line.textContent = 'Notifications are off for this device'
  return line
}

// The screen itself: what this is, what it will do, and the one control.
function screen () {
  const box = document.createElement('div')
  box.className = 'sheet'
  const heading = document.createElement('h2')
  heading.textContent = 'Notifications on this device'
  box.append(heading)
  const explain = document.createElement('p')
  // Says exactly what it will do and when, because a reader granting a
  // permission deserves to know what they are agreeing to be interrupted for.
  explain.textContent = 'Get told when a session stops and wants you — either because it is asking a question or because its turn has finished. This works when this site is in the background and when it is closed entirely.'
  box.append(explain)
  if (state !== null && !state.supported) {
    box.append(note('This browser does not support push notifications. On an iPhone, add this app to the Home Screen first — Safari only delivers notifications to an installed app.'))
    box.append(back())
    return box
  }
  if (state !== null && state.blocked) {
    // A denied permission cannot be re-requested by any button, so offering one
    // would be a control that does nothing. Say where the switch actually is.
    box.append(note('Notifications are blocked for this site, so this has to be changed in the browser rather than here. Open the site settings for this page — in most browsers, the icon at the left of the address bar — and allow notifications, then come back.'))
    box.append(back())
    return box
  }
  box.append(toggle())
  if (state !== null && state.enabled) {
    box.append(note('Only this device is subscribed by this button. A phone and a laptop each need turning on once.'))
  }
  box.append(back())
  return box
}

function toggle () {
  const button = document.createElement('button')
  button.type = 'button'
  const on = state !== null && state.enabled
  button.disabled = busy
  button.textContent = busy
    ? (on ? 'Turning off' : 'Turning on')
    : (on ? 'Turn off notifications on this device' : 'Turn on notifications for this device')
  button.addEventListener('click', () => { flip(on) })
  return button
}

async function flip (on) {
  if (busy) return
  busy = true
  changed()
  try {
    state = on ? await notify.disable() : await notify.enable()
  } catch (error) {
    // In full, in the page: a subscribe failure is otherwise invisible, and the
    // reason (a missing key, a refused permission, an unreachable push service)
    // is exactly what a developer needs.
    errors.show(on ? 'Could not turn notifications off' : 'Could not turn notifications on',
      String(error && error.stack ? error.stack : error) + '\nAt: ' + new Date().toString())
  }
  busy = false
  changed()
}

function note (text) {
  const p = document.createElement('p')
  p.className = 'state'
  p.textContent = text
  return p
}

// The way out is the way back, as everywhere else here.
function back () {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Close'
  button.addEventListener('click', () => { router.go('/sessions') })
  return button
}
