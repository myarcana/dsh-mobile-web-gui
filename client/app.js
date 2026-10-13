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
import * as approval from 'approval'
import * as create from 'create'
import * as earlier from 'earlier'
import * as grow from 'grow'
import * as copy from 'copy'
import * as menu from 'menu'
import * as alerts from 'alerts'

const boot = JSON.parse(document.getElementById('boot').textContent)
const log = document.getElementById('log')
const composer = document.getElementById('composer')
const box = document.getElementById('box')
const heading = document.getElementById('title')
const where = document.getElementById('where')
const bar = document.querySelector('header')
// The composer's action row. Looked up here with the rest of the shared
// elements rather than beside the handlers that use them, because `router.start`
// renders the opening screen while this module is still being evaluated — and
// that first render calls both `showWorktreeActions` and `forgetUndo`. A `const`
// declared further down is in the temporal dead zone at that moment, so reading
// it from either one throws before the page has painted.
const undo = document.getElementById('undo')
const insertWorktree = document.getElementById('insert-worktree')
const rebase = document.getElementById('rebase')
const merge = document.getElementById('merge')
const actions = document.getElementById('actions')

// The action row used to exist only while the composer held focus, as
// `#composer:focus-within #actions`. Tying a control's existence to focus is what
// made these buttons unpressable on Safari, in two different ways.
//
// WebKit does not focus a <button> when it is pressed, on macOS or iOS. So the
// press blurred the box, `:focus-within` stopped matching, and the row was set to
// `display: none` between the finger landing and lifting. WebKit synthesises a
// click only when press and release land on the same rendered element, so the
// click was never dispatched. Chrome and Firefox focus the button, keep the row up
// and fire the click, which is why this only ever reproduced in Safari.
//
// Cancelling the mousedown to hold focus in the box fixed that press and broke the
// next one: with focus kept in the textarea, Safari took the press as the start of
// its own text-selection gesture, dropped the programmatic selection to (0,0) and
// then swallowed the following pointerup entirely — so the second press produced a
// pointerdown with no release and no click, for good.
//
// So the row no longer asks where focus is. `composing` is set while the reader is
// writing and stays set across a press, because a button in the row is part of
// writing rather than an interruption of it. Nothing about the row changes while a
// press is in flight, so there is no race for WebKit to lose, and focus is left to
// behave normally — no cancelled mousedown, no suppressed default, and the browser
// is free to focus the button exactly as it prefers.
function showComposing (on) {
  composer.classList.toggle('composing', on)
}

box.addEventListener('focus', () => { showComposing(true) })

// Focus leaving the composer entirely ends the act of writing. Checked on the next
// frame because focus moves in two steps — the old element blurs before the new one
// focuses — so reading it synchronously would see the gap between them and close
// the row on its own buttons.
//
// `activeElement` alone is not enough to say focus left, and trusting it is what
// kept these buttons dead on Safari after the row stopped using :focus-within.
// WebKit does not focus a <button> when it is pressed, so a finger landing on
// Merge blurs the box and moves focus to nothing — `activeElement` is <body>,
// which the composer does not contain. The row was hidden one frame into the
// press, and a click is only synthesised when press and release land on the same
// rendered element, so the release landed on nothing and no click was ever
// dispatched. The box losing its caret is the visible half of that; the dead
// button is the other half of the same event.
//
// So a press in flight inside the composer is what is consulted, and focus only
// decides the case where no press is happening. `pressing` is set on pointerdown
// and outlives the frame this check runs in, which is precisely the window
// WebKit's unfocused press falls through.
box.addEventListener('blur', () => {
  requestAnimationFrame(() => {
    if (pressing) return
    if (!composer.contains(document.activeElement)) showComposing(false)
  })
})

// Whether a finger or cursor is currently down on the composer. Held from
// pointerdown until the press ends, so the blur that WebKit fires on the way
// into a button press can tell "the reader is using this row" apart from "the
// reader has left". Capture, so it is set before the blur handler's frame runs
// even if something inside stops the event bubbling; `pointercancel` clears it
// alongside `pointerup` so a gesture the browser claims does not leave the row
// pinned open forever.
let pressing = false
composer.addEventListener('pointerdown', () => { pressing = true }, true)
const endPress = () => {
  pressing = false
  // Re-run the decision a press may have deferred: if things have settled with
  // focus outside the composer — a press that left, or WebKit never focusing
  // the button it landed on — the row closes, but only once nothing is in
  // flight. A press that ended on a button leaves focus back in the box,
  // because every one of these handlers ends by focusing it.
  //
  // Run for every press, not only one that began inside the composer. A tap on
  // the transcript blurs the box without focusing anything, and the blur can
  // land after this pointerup; skipping the re-check when the press started
  // elsewhere is what left the row open for a reader who had plainly left it.
  requestAnimationFrame(() => {
    if (pressing) return
    if (!composer.contains(document.activeElement)) showComposing(false)
  })
}
document.addEventListener('pointerup', endPress, true)
document.addEventListener('pointercancel', endPress, true)

// Per session, keyed by id: the composer draft.
const drafts = new Map()

// The draft the last Clear, Rebase or Merge displaced, or null when there is
// nothing to put back. Declared up here for the same reason the buttons are:
// the first render reaches `forgetUndo` during module evaluation.
let undone = null

// The session whose pre-filled box has not been handed to the reader yet. A
// created session opens with an opening line already typed, and the caret
// belongs after it — but only on that first arrival, so returning to the
// session later does not steal focus or move a caret the reader has placed.
let opening = null

// The checkout a just-created session was started for, keyed by session id.
//
// The server derives a session's worktree from where it has actually written,
// so a session created a second ago belongs to none: it has done nothing yet.
// The reader nonetheless chose the checkout by name when they tapped, and a
// header that says nothing about it until the first file is written would be
// this page forgetting something it was just told. The server's own answer
// replaces this as soon as it has one.
//
// Kept in `localStorage` rather than only in memory, because the window this
// covers outlives the page that opened it. A session started in a checkout and
// left empty — the reader tapped "New session in develop", then reloaded, or
// sent the URL to a phone — has nothing on the server to place it by, so an
// in-memory map would answer for the tab that made it and nowhere else. The
// name is also what Rebase and Merge write into their prompts, so losing it
// turns two working buttons into a question the reader has to answer again.
const WORKTREE_KEY = 'worktree:'

// Memory backs the store rather than deferring to it. A browser that refuses
// `localStorage` — private mode, blocked third-party storage, a quota already
// full — throws on both read and write, and a store that only ever consulted
// disk would answer `null` to the very name it was handed a moment ago. That
// turns a recorded checkout back into a question, which is what made Rebase and
// Merge re-ask for something the page had already been told.
//
// So the map is the answer and the disk is the durable copy of it: writes go to
// both, reads prefer the map and fall back to disk for a name this page did not
// see recorded (a reload, or another tab's create).
const remembered = new Map()

const started = {
  get (id) {
    if (remembered.has(id)) return remembered.get(id)
    try {
      const name = localStorage.getItem(WORKTREE_KEY + id)
      // Cache the disk's answer so a store that starts refusing mid-session does
      // not lose a name this page has already read successfully.
      if (name !== null) remembered.set(id, name)
      return name
    } catch (error) { return null }
  },
  set (id, name) {
    remembered.set(id, name)
    try { localStorage.setItem(WORKTREE_KEY + id, name) } catch (error) { /* full or refused: memory still answers for this page */ }
  },
  delete (id) {
    remembered.delete(id)
    try { localStorage.removeItem(WORKTREE_KEY + id) } catch (error) { /* nothing to drop */ }
  }
}

errors.mount(document.getElementById('errors'))
keyboard.track(composer)
grow.track(box)
errors.listen()
create.mount()

// The server already rendered this route's transcript into the document, so the
// first paint happened before any of this ran. Adopt it rather than repaint it.
if (boot.sessionId !== null) {
  // The server rendered this route, notice and all. Adopt it, then store it
  // without the notice so a cache never claims a session is empty after it has
  // been given a message.
  view.open(boot.sessionId, { html: log.innerHTML, renderedThrough: boot.renderedThrough }, boot.empty)
  view.rememberCurrent()
  // The first paint is one bounded chunk. The server already said whether
  // anything sits behind it, so the way back is offered without spending a
  // request to discover there is nothing there.
  earlier.offer(boot.more === true, typeof boot.oldest === 'number' ? boot.oldest : -1)
}
ask.render(boot.sessionId, wire.asks(boot.asks))
approval.render(boot.sessionId, wire.approvals(boot.approvals))
// The waiting question outranks the newest message as the thing to open at, and
// it only exists as of the line above. `view.open` ran before it and anchored on
// the transcript, so on a cold deep link the anchor is taken again now that the
// form it should have chosen is actually in the document.
//
// Only on the first paint, and only where the session is already standing: an
// in-app tap reaches this through the route handler instead, where the tail
// lands after the forms and anchors itself.
if (boot.sessionId !== null) view.reanchor()
create.show(boot.showTools === true)

// A created session is not a log event, so nothing else would take the reader
// there. Land on the thing they just made; the server pushes the list row.
create.observe((sessionId, opened) => {
  if (sessionId === null) return
  const prefill = opened?.prefill ?? ''
  // What the reader chose, so the header can name it before the session has
  // written anything for the server to derive it from.
  if (opened?.worktree !== undefined && opened.worktree !== '') started.set(sessionId, opened.worktree)
  // The draft is planted before the navigation, because the route handler fills
  // the box from `drafts`. Writing to the box afterwards would race that same
  // handler, which clears it for a session holding no draft.
  if (prefill !== '') {
    drafts.set(sessionId, prefill)
    // The pre-fill is an opening, not a message: the reader is meant to carry on
    // typing after it. Marked so the route handler puts the caret at the end
    // once, rather than every time this session is opened later.
    opening = sessionId
  }
  router.go('/s/' + encodeURIComponent(sessionId))
})

await store.boot()
await outbox.boot()
// The first paint ran before storage was open, so the prompts this device still
// holds for the session on screen are drawn now that they can be read.
view.local()

outbox.observe((row, fresh) => {
  if (row.kind === 'approval') approval.state(row)
  else if (row.askId === undefined) view.pending(row, fresh)
  else ask.state(row)
})
outbox.listen()

stream.connect({
  event (frame) {
    if (frame.sessionId !== view.current()) return
    view.append(frame)
    // A replace frame repaints the log, taking any history above it with it, so
    // the link has to be re-offered on the server's fresh word. A live append
    // adds at the bottom and leaves the top edge alone.
    if (frame.replace) earlier.offer(frame.more, frame.oldest)
  },
  token (frame) { view.token(frame) },
  through () { return view.through() },
  summaries (listing) {
    chooser.update(listing)
    create.update(listing)
    // The s frames carry each session's last durable seq, so a stale cached
    // render is detected before the reader ever taps it.
    //
    // The session on screen is exempt because the stream is already watching
    // it: every event lands as a frame, so its cache cannot fall behind while
    // it is open, and a real reset arrives as a replace frame. Nothing here
    // could tell this page anything the stream has not already told it.
    for (const row of listing.rows) {
      if (row.id === view.current()) continue
      store.invalidateIfAhead(row.id, row.latestSeq)
    }
    ask.render(view.current(), chooser.find(view.current())?.asks)
    approval.render(view.current(), chooser.find(view.current())?.approvals)
    // Delivery state, restated by the server on every frame. This is what makes
    // a stuck "Sending" impossible: the page holds no opinion of its own to get
    // stuck, so a frame missed for any reason is corrected by the next one.
    view.delivery(listing.rows)
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
  // The screen a collapsed run of tool calls opens. Checked before the plain
  // transcript match, which would otherwise swallow it.
  // `12` is the run's first tool event; `12-30` also carries where it ended.
  const run = /^\/s\/([^/]+)\/t\/(\d+(?:-\d+)?)$/.exec(path)
  if (run !== null) return expandRun(run[1], run[2])
  // The title menu is a screen of its own, drawn over the session it belongs
  // to. The transcript underneath is rendered by the same path that renders it
  // without the menu, so opening the menu never tears the session down — and a
  // cold deep link to this URL paints the transcript first, exactly as the
  // server already resolves it.
  const opened = /^\/s\/([^/]+)\/menu$/.exec(path)
  const match = opened ?? /^\/s\/([^/]+)/.exec(path)
  if (match === null) {
    // Opening or shutting a group re-renders this route, and the reader stays on
    // the same screen while it happens — so they must not lose their place. The
    // offset is read before the view blanks the log, because an empty document
    // is one viewport tall and the browser clamps the offset to zero the moment
    // it becomes one.
    const wasList = view.current() === null
    const place = wasList ? chooser.place() : 0
    view.open(null, undefined)
    // The list is not a transcript and has nothing behind it.
    earlier.offer(false)
    ask.render(null, undefined)
    approval.render(null, undefined)
    menu.render(null, undefined)
    chooser.show()
    composer.hidden = true
    create.show(true)
    // A screen of its own over the list, on its own URL, so it survives a
    // reload and opens the same thing when pasted into another browser.
    alerts.mount(path === '/sessions/notifications')
    // The list needs no header: the Sessions link would point at the page
    // already open, and the title would repeat the list's own heading.
    bar.hidden = true
    heading.textContent = 'Sessions'
    // The list is not one session, so there is no single checkout to name.
    showWorktree(null)
    // Only when the reader was already on the list. Arriving from a session is a
    // real navigation and belongs at the top of the page.
    if (wasList) chooser.restore(place)
    return
  }
  const id = decodeURIComponent(match[1])
  chooser.hide()
  create.show(false)
  bar.hidden = false
  // Synchronous read: the switch paints in this frame, with no spinner and no
  // blank. The tail arrives afterwards and appends. Repainting the session
  // already on screen would throw away the server-rendered first paint.
  // A switch repaints from cache, which carries no word about what sits behind
  // it. The link is retired until the tail lands and the server says, so it can
  // never be offered against the previous session's top edge.
  // The list already knows whether this session holds anything, so a switch into
  // an empty one says so instead of saying "Loading…" about a log that is never
  // going to fill. A session the list has not named yet passes `undefined`,
  // which still reads as loading.
  if (view.current() !== id) {
    const cache = store.cached(id)
    view.open(id, cache, chooser.find(id)?.empty)
    earlier.offer(false)
    // What this page painted last time, against what the list says the log
    // actually holds now. Both are the same `event.seq`, so the comparison is
    // exact rather than a guess.
    //
    // A session that moved while the reader was somewhere else got none of its
    // events: the stream only sends frames for the session in focus, so ten
    // background sessions never stream into this device. The cursor therefore
    // stands where the last visit left it while the log has run on ahead, and
    // asking the server for everything after that cursor returns an increment
    // the page then refuses, because it is not a replace and not ahead of what
    // is already painted. That is what left a green row opening onto a frozen
    // transcript that only a hard reload would shift.
    //
    // Rewinding drops the cursor so the focus below asks for the whole tail and
    // the server answers with a replace, which repaints in one go. The cached
    // rows stay on screen throughout, so this costs a moment of slightly stale
    // text rather than a blank screen or a spinner — and a cache that is level
    // with the log skips it entirely and keeps the cheap increment.
    if (cache !== undefined && (chooser.find(id)?.latestSeq ?? -1) > cache.renderedThrough) view.rewind()
  }
  ask.render(id, chooser.find(id)?.asks)
  approval.render(id, chooser.find(id)?.approvals)
  // Open only on the menu URL. Every other session route closes it, which is
  // what makes the back button the way out of the menu.
  menu.render(opened === null ? null : id, chooser.find(id))
  stream.focus(id, view.through())
  box.value = drafts.get(id) ?? ''
  // Setting `.value` fires no `input`, so a restored multi-line draft would
  // otherwise come back one row tall.
  grow.fit(box)
  // The displaced draft belongs to the session it was typed in. Carrying it
  // across would let Undo here paste another session's text.
  forgetUndo()
  // A session just created with an opening line hands the reader a box they can
  // type straight into, caret after the text rather than before it. Spent on
  // use, so this happens once and never on a later visit.
  if (opening === id) {
    opening = null
    box.focus()
    box.setSelectionRange(box.value.length, box.value.length)
  } else if (opened === null && view.blank() && box.value === '') {
    // A session with nothing in it yet has exactly one thing to do, so the box
    // takes focus on arrival and the keyboard is already up. Only when it is
    // genuinely blank and holds no draft: a session with a transcript is there
    // to be read, and opening the keyboard over it would cover what the reader
    // came for. Not on the menu URL either — that screen is the sheet, and
    // focus belongs to it rather than to a box behind it.
    // `preventScroll` because focus must not move the log.
    box.focus({ preventScroll: true })
  }
  retitle()
  outbox.drain()
})

// The expanded event view is its own screen with its own URL, fetched as a
// fragment so opening one never tears down the stream.
function expand (id, seq) {
  return fragment(id, '/api/s/' + encodeURIComponent(id) + '/e/' + seq, 'One event in ', 'event ' + seq)
}

// The screen behind a collapsed run: every call and result in that run, in full.
//
// `seq` may be `12` or `12-30`. A server that predates the ranged form answers
// only the first, so the range is dropped and retried rather than shown as an
// error: the client half of this GUI reloads with the page while the host half
// is only replaced when the process is, so the two are routinely one version
// apart and the older pair still has to work.
function expandRun (id, seq) {
  const base = '/api/s/' + encodeURIComponent(id) + '/t/'
  const fallback = seq.includes('-') ? base + seq.slice(0, seq.indexOf('-')) : null
  return fragment(id, base + seq, 'Tool calls in ', 'the tool calls at ' + seq, fallback)
}

// Whether a response carries JSON. A route this server does not know falls
// through to the document handler, which answers 200 with HTML.
function isJson (response) {
  return (response.headers.get('content-type') ?? '').includes('json')
}

// Load one server-rendered fragment into its own screen.
async function fragment (id, url, lead, what, fallback = null) {
  chooser.hide()
  // Reached from the list, which leaves the header hidden behind it. This screen
  // belongs to one session and carries both its title and the way back.
  bar.hidden = false
  ask.render(null, undefined)
  approval.render(null, undefined)
  // The title menu goes with them: this screen is one event rather than the
  // session, so the controls that act on the session have nothing to act on
  // here. Taking it down also releases any stop still in flight.
  menu.render(null, undefined)
  composer.hidden = true
  // This screen is one event, not a transcript, so there is no history above it.
  earlier.offer(false)
  // Name the session this belongs to rather than saying "one event": the same
  // screen is reached from several sessions, and which one it is, is the part a
  // reader cannot otherwise recover. On a cold deep link the list has not
  // arrived yet, so the server's own heading stands until it does.
  const row = chooser.find(id)
  if (row !== undefined) heading.textContent = lead + row.title
  // The event belongs to a session, and that session is in a checkout, so the
  // line above the title still answers the same question it does on the
  // transcript itself.
  showWorktree(worktreeOf(id, row))
  let response
  try {
    response = await fetch(url)
    // A host half that predates this route shape does not refuse the path: it
    // falls through to the document handler and answers 200 with the whole page.
    // So what says "this server does not know this route" is the content type,
    // not the status, and the narrower form is what to retry.
    if (fallback !== null && !isJson(response)) {
      url = fallback
      response = await fetch(fallback)
    }
  } catch (error) {
    errors.show('Could not load ' + what, 'GET ' + url + '\n' + error + '\nAt: ' + new Date().toString())
    return
  }
  if (!response.ok) return errors.fromResponse('GET', url, response, 'Session: ' + id)
  if (!isJson(response)) {
    // Every form answered with a document. Say so in full, rather than letting
    // a JSON parse failure surface as an unreadable syntax error.
    errors.show('Could not load ' + what, 'GET ' + url
      + '\nThe server answered ' + response.status + ' with '
      + (response.headers.get('content-type') ?? 'no content type')
      + ', where JSON was expected. The page and the server are probably'
      + ' different versions of this GUI; reloading the page picks up the'
      + ' current one.\nAt: ' + new Date().toString())
    return
  }
  view.showFragment(wire.expandedEvent(await response.json()).html)
}

function retitle () {
  const id = view.current()
  // The box is offered for every session, never gated on a capability: a cold
  // session is resumed when its first prompt arrives. It is hidden only where
  // there is no session to address — the list and the single-event view.
  composer.hidden = id === null
  if (id === null) return showWorktree(null)
  const row = chooser.find(id)
  heading.textContent = row === undefined ? 'Session' : row.title
  // An open menu is redrawn as the list arrives: on a cold deep link to
  // `/s/<id>/menu` the row is not known at the first paint, so the menu opens
  // knowing neither the session's name nor whether it may be archived, and this
  // is what fills both in the moment the server says.
  //
  // This is also what follows the server's word on Stop: the row carries the
  // `stop` action exactly while the agent is running, so an open menu grows the
  // button when a turn starts and drops it the moment the turn ends.
  if (menuOpen()) menu.render(id, row)
  showWorktree(worktreeOf(id, row))
}

// Whether the menu URL is the one on screen. Read from the location rather than
// tracked in a variable, so the menu and the address bar cannot disagree.
function menuOpen () {
  return /^\/s\/[^/]+\/menu$/.test(location.pathname)
}

// The checkout to name for one session.
//
// The server's own answer wins whenever it has one, because it is derived from
// where the session actually wrote and so stays true as the session moves on.
// A session created moments ago has written nothing, so the server can place it
// nowhere — and for exactly that window the checkout the reader picked when
// they tapped "New session in X" is the better answer than silence.
function worktreeOf (id, row) {
  // `wt:unknown` is the server saying it could not place the session, not a
  // checkout it placed it in. Its title reads as a real answer ("Unknown
  // worktree"), so testing the title alone would treat that admission as a
  // placement and throw away the checkout the reader actually picked — which is
  // exactly the window this fallback exists for.
  if (row !== undefined && row.worktree !== '' && row.worktreeId !== 'wt:unknown') {
    // The server has placed it, so this page's memory of the tap is spent.
    started.delete(id)
    return row.worktree
  }
  return started.get(id) ?? null
}

// The checkout this session is working in, above its title.
//
// It sits above rather than below because it is the coarser fact: which of a
// dozen checkouts this is, then which session within it. A reader returning to
// a tab after an hour needs the place before the name.
//
// The name arrives with the session list, so on a cold deep link there is a
// moment before it lands. The line is hidden rather than blank until then: an
// empty strip above the title reads as a broken render, while nothing at all
// reads as a header that has not finished loading.
function showWorktree (name) {
  if (name === null || name === undefined || name === '') {
    where.hidden = true
    where.replaceChildren()
    // Forget the name the line was built for along with the line itself.
    // Leaving it set would make a later paint of that same name a no-op against
    // an empty strip — which is exactly what happens when the reader answers the
    // prompt with the name this session had before the list said otherwise.
    delete where.dataset.worktree
    showWorktreeActions(null)
    return
  }
  showWorktreeActions(name)
  // Rebuilt only when the name actually changes. Every list frame calls retitle,
  // several times a minute on a busy box, and replacing the button each time
  // would reset a "Copied" that the reader is still reading.
  if (where.dataset.worktree === name) return
  where.dataset.worktree = name
  const label = document.createElement('span')
  label.textContent = name
  where.replaceChildren(label, copy.JOIN, copy.button(name, 'worktree name'))
  where.hidden = false
}

// The title opens the menu for the session it names. A navigation, so it pushes
// history and the menu has its own URL — and tapping the title again while the
// menu is open goes back rather than pushing the same screen twice.
heading.addEventListener('click', () => {
  const id = view.current()
  if (id === null) return
  if (menuOpen()) return history.back()
  router.go('/s/' + encodeURIComponent(id) + '/menu')
})

// An archived session is gone from the list, so both the screens it owns — the
// menu, and the transcript the menu was opened from — are dead ends.
//
// Stepping back off the menu first and only then replacing is what removes
// both. Replacing where we stand would overwrite the menu entry alone and leave
// the transcript behind it, so the back button would land the reader on a
// session that is no longer in the list and cannot be reached any other way.
//
// The step back is a popstate, which the router renders, so the replacement
// waits for it to land rather than racing it.
menu.observe(() => {
  addEventListener('popstate', () => { router.replace('/sessions') }, { once: true })
  history.back()
})

// The notifications row lives in the list, so a change to what this device is
// subscribed to has to repaint it.
alerts.observe(() => { chooser.repaint() })

// What the server holds for this device, asked once at boot. Also re-asked when
// the page becomes visible: a subscription can be revoked from the browser's own
// settings while the tab is in the background, and the row must not go on
// claiming notifications are on after that.
void alerts.refresh()
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void alerts.refresh()
})

composer.addEventListener('submit', async event => {
  event.preventDefault()
  const text = box.value.trim()
  const id = view.current()
  if (text === '' || id === null) return
  box.value = ''
  // A sent message empties the box; without this it keeps the height the text
  // it no longer holds had earned.
  grow.fit(box)
  drafts.delete(id)
  // The message is on its way, so the empty box is not damage to undo.
  forgetUndo()
  // Sending ends the act of writing, so the action row goes: those controls edit
  // a draft, and there is no longer a draft to edit. Said outright rather than
  // left to follow from focus, because the row no longer tracks focus. Focus is
  // still dropped so the keyboard closes with it, which is the point: the reply
  // is what the reader wants to see next, not the composer. Blur whatever the
  // composer holds, covering both the box (Enter to send) and the button (tap).
  showComposing(false)
  if (composer.contains(document.activeElement)) document.activeElement.blur()
  await outbox.queue(id, { text })
})

box.addEventListener('input', () => {
  const id = view.current()
  if (id !== null) drafts.set(id, box.value)
})

// Clear empties the draft the same way sending it does: the box, the height it
// had grown to, and the stored draft, which would otherwise put the text back
// on the next visit to this session. Unlike sending, it is recoverable.
document.getElementById('clear').addEventListener('click', () => { replaceDraft('') })

// Rebase and Merge are always offered; only the button that *is* the name comes
// and goes.
//
// The two prompt-writers do not need the name in advance — they need it at
// press time, and where the page does not have one they ask for it. Hiding them
// instead made the checkout the page happened to know about the gate on an
// action the reader could perfectly well name themselves, which is how a
// session started from "New session in develop" and then left empty — nothing
// written, so nothing for the server to derive a checkout from — offered no
// Merge at all.
//
// Insert stays conditional, because it is different in kind: its whole content
// is the name. A button labelled with an empty string is not a control, and
// asking for a name in order to type that name into the box is a longer way of
// typing it.
function showWorktreeActions (name) {
  const known = name !== null
  insertWorktree.hidden = !known
  if (known) insertWorktree.textContent = name
}

// The checkout these prompts are about: the name when the page has it, asked
// for when it does not.
//
// Read from the Insert button's own label whenever it is showing, so what is
// written is always what the reader can see, and no question is put to a reader
// who would only be retyping what is already on screen.
//
// Where the page has no name, ask for it outright. These prompts name the
// checkout several times over — Merge names it three times — so the name has to
// be known *before* the draft is written; a placeholder left in the text for the
// reader to type over only ever replaced the first of them, and the draft went
// out still claiming to rebase a branch called WORKTREE.
//
// `null` means the reader cancelled, and cancelling writes nothing at all.
function askWorktreeName () {
  if (!insertWorktree.hidden) return insertWorktree.textContent
  const answer = window.prompt('Which worktree?')
  if (answer === null) return null
  const name = answer.trim()
  return name === '' ? null : name
}

// Insert at the caret, replacing whatever is selected — the bare name, no
// spacing of its own, because the caret is where the reader already decided the
// spacing. The caret lands after the inserted name so typing carries on from
// there, and the draft is stored because `input` does not fire for a
// programmatic value change.
insertWorktree.addEventListener('click', () => {
  const name = insertWorktree.textContent
  const at = box.selectionStart
  const end = box.selectionEnd
  box.value = box.value.slice(0, at) + name + box.value.slice(end)
  const after = at + name.length
  box.setSelectionRange(after, after)
  grow.fit(box)
  keepDraft()
  box.focus()
})

rebase.addEventListener('click', () => {
  const name = askWorktreeName()
  if (name === null) return
  replaceDraft('Pull develop, then rebase ' + name
    + ' onto develop, then review develop..' + name)
})

merge.addEventListener('click', () => {
  const name = askWorktreeName()
  if (name === null) return
  replaceDraft('pull develop, rebase ' + name
    + ' onto develop, then apply all the work of ' + name
    + ' onto develop, then push develop, then clean up and remove the '
    + name + ' worktree')
})

// What Clear, Rebase and Merge all do: put a new draft in the box, keeping the
// one they displaced so a stray tap is recoverable. Focus returns to the box
// rather than staying on the button, because the keyboard is open and the
// reader's next act is typing.
//
// Pressing the same button twice is deliberately a no-op: it writes the prompt it
// always writes, which the box already holds, so the second press changes nothing
// on screen. That is correct, not a failure to fire — the draft is already what
// the button is for.
function replaceDraft (text) {
  // Only a replacement that actually displaces something is worth undoing;
  // clearing an empty box would otherwise arm Undo to restore nothing.
  if (box.value !== text) {
    undone = box.value
    undo.disabled = false
  }
  box.value = text
  grow.fit(box)
  keepDraft()
  box.focus()
}

// Nothing left to put back: the draft that was displaced is gone, or belongs to
// a session that is no longer on screen.
function forgetUndo () {
  undone = null
  undo.disabled = true
}

// Restores exactly one step: the draft the last Clear, Rebase or Merge
// displaced. The text being displaced now becomes the next thing to restore, so
// a reader who undoes by mistake can press it again and get back.
undo.addEventListener('click', () => {
  if (undone === null) return
  const back = undone
  undone = box.value
  box.value = back
  grow.fit(box)
  keepDraft()
  box.focus()
})

// Store the box against the session it belongs to, or forget an emptied draft
// so it is not put back on the next visit.
function keepDraft () {
  const id = view.current()
  if (id === null) return
  if (box.value === '') drafts.delete(id)
  else drafts.set(id, box.value)
}

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


