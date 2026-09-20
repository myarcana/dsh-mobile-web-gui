// The menu behind a session's title.
//
// It is a view, not a popover that lives in a variable: `/s/<id>/menu` is the
// screen the reader is looking at, so it pushes history, survives a reload, and
// opens the same thing when pasted into another browser. Closing is `history.back`
// for the same reason — the way out of a screen is the way back.
//
// What it offers is what the server said this session supports. The row's own
// `actions` list decides whether Archive is here at all, exactly as it does on
// the list, so this page can never offer a control the host would refuse.

import * as errors from 'errors'
import * as copy from 'copy'
import * as stop from 'stop'

const sheet = document.getElementById('menu')

// The session whose archive POST is in flight. Held here rather than on the
// button because closing the menu throws the button away, and a second tap after
// reopening must not send a second request.
let archiving = null

// Draw the menu for one session, or take it down.
//
// `row` is the session's summary, or undefined when the list has not arrived
// yet — on a cold deep link the menu is open before the first list frame lands.
// The menu is still drawn in that case, saying what it knows and nothing more,
// because a blank screen behind an opened menu reads as a broken page.
export function render (id, row) {
  if (id === null) {
    sheet.hidden = true
    sheet.dataset.drawn = ''
    sheet.replaceChildren()
    // The buttons are gone, so whatever they were waiting on is finished with.
    // Clearing unconditionally is what keeps a later stop possible — holding the
    // id of a session the reader has closed the menu on would refuse every
    // future tap.
    stop.forget()
    return
  }
  // Rebuilt only when what it would say actually changes. Every list frame
  // redraws the open menu, several times a minute on a busy box, and replacing
  // the controls each time would reset a "Copied" the reader is still reading —
  // or, worse, swap out the Archive button under a finger already on it.
  const drawn = id + '\n' + (row === undefined ? '' : row.title + '\n' + row.actions.join(' ')) + '\n' + (archiving === id) + '\n' + stop.busy(id)
  if (sheet.dataset.drawn === drawn) return
  sheet.dataset.drawn = drawn
  sheet.hidden = false
  const heading = document.createElement('h2')
  // Specific, never "Session options": this session's own name.
  heading.textContent = row === undefined ? 'This session' : row.title
  const items = [heading]
  // Only what the server offered. A session that is not working sends no stop
  // action, a profile with no workspace registry sends no archive action, and
  // then there is no such control here.
  //
  // Stop comes first: it is the one thing here that is ever urgent, and it is
  // the only control whose moment passes — the turn it interrupts ends on its
  // own soon enough. Archive sits below it, away from the finger that came for
  // the common case.
  if (stop.offered(id, row)) items.push(stop.button(id, row))
  if (row !== undefined && row.actions.includes('archive')) items.push(archiveButton(id, row))
  items.push(copy.button(id, 'session id', true), close())
  sheet.replaceChildren(...items)
  // After the controls are in, never before: the clamp measures how wide the
  // sheet actually is, and an empty sheet measures narrower than the one the
  // reader ends up looking at.
  anchor()
}

// Line the sheet up with the left edge of the title that opened it.
//
// The title sits in the header's second grid column, and where that column
// starts depends on how wide the Sessions link happens to be — a width no CSS
// length here can name. So the edge is measured from the title itself and
// handed to the stylesheet as a custom property, which is the one thing that
// keeps the menu under the word it drops from instead of guessing.
//
// Clamped so a narrow viewport cannot push the sheet off the right. The sheet
// has a minimum width of its own — wide enough to say "Archive this session" on
// one line — and on a small phone the title's edge plus that minimum is wider
// than the screen. Where the two disagree the screen wins: the menu slides back
// left until it fits, losing the alignment rather than running off the edge,
// because a control the reader cannot reach is worse than one slightly out of
// line with the word above it.
// Done in two steps, because the sheet's width depends on where it is put: it
// stretches to whatever is left of the viewport, so measuring it while a stale
// anchor is still applied measures the wrong box and the answer feeds back into
// itself. So the title's edge is set first and the result read back — by then
// the browser has laid the sheet out and clamped it — and only a sheet that
// still runs past the gutter is pulled left by however far it overhangs.
function anchor () {
  const title = document.getElementById('title')
  if (title === null) return
  const left = Math.max(0, title.getBoundingClientRect().left)
  sheet.style.setProperty('--anchor', left + 'px')
  // The gutter is read from `--gap` rather than restated, so changing it in the
  // stylesheet cannot leave this arithmetic behind.
  const gutter = parseFloat(getComputedStyle(document.body).getPropertyValue('--gap')) || 0
  const over = sheet.getBoundingClientRect().right - (document.documentElement.clientWidth - gutter)
  if (over > 0) sheet.style.setProperty('--anchor', Math.max(0, left - over) + 'px')
}

// The measurement is only true for the width it was taken at. A rotation or a
// window resize moves the column, so it is taken again — but only while the
// menu is on screen, since there is nothing to line up otherwise.
addEventListener('resize', () => { if (!sheet.hidden) anchor() })

function close () {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = 'Close'
  button.addEventListener('click', () => { history.back() })
  return button
}

// Archive this session and leave. Named for the session it hides, so what a
// screen reader announces says which session is about to go.
function archiveButton (id, row) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'danger'
  const busy = archiving === id
  button.disabled = busy
  button.textContent = busy ? 'Archiving' : 'Archive this session'
  const name = 'Archive ' + row.title
  button.title = name
  button.setAttribute('aria-label', name)
  button.addEventListener('click', () => { archive(id, row, button) })
  return button
}

// Hide one session, then go back to the list.
//
// The list is where the reader is sent because the session they were reading is
// no longer on it: staying on the transcript of a session that has just been
// hidden leaves them on a screen they cannot navigate back to.
async function archive (id, row, button) {
  if (archiving !== null) return
  archiving = id
  button.disabled = true
  button.textContent = 'Archiving'
  // The control was changed here rather than by a render, so the record of what
  // is on screen no longer matches it. Cleared so the next list frame redraws
  // instead of deciding nothing has changed and leaving a stale button.
  sheet.dataset.drawn = ''
  let response
  try {
    response = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: id })
    })
  } catch (error) {
    release(button)
    errors.show('Could not archive ' + row.title, 'POST /api/archive\nSession: ' + id + '\n' + error + '\nAt: ' + new Date().toString())
    return
  }
  if (!response.ok) {
    release(button)
    await errors.fromResponse('POST', '/api/archive', response, 'Session: ' + id)
    return
  }
  archiving = null
  onArchived()
}

// Give the control back after a failure, so the reader can try again. The error
// itself is already on the page in full, so this says nothing further.
function release (button) {
  archiving = null
  button.disabled = false
  button.textContent = 'Archive this session'
  sheet.dataset.drawn = ''
}

// Escape closes it, the same as Close and the same as the back button: one way
// out, spelled three ways. Bound once at the document rather than per render,
// so reopening the menu does not stack listeners.
addEventListener('keydown', event => {
  if (event.key === 'Escape' && !sheet.hidden) history.back()
})

// A tap anywhere off the menu closes it, which is what a menu is expected to do.
// The title itself is excluded: it has its own handler that already closes an
// open menu, and letting both fire would close it and immediately reopen it.
document.addEventListener('click', event => {
  if (sheet.hidden) return
  if (event.target.closest('#menu, #title') !== null) return
  history.back()
})

let onArchived = () => {}

// Where to go once a session is hidden. The app owns navigation, so it decides;
// this module only says that it happened.
export function observe (fn) {
  onArchived = fn
}
