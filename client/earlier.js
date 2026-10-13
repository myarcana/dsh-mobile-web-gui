// The link at the top of the log that reaches everything behind the tail.
//
// A cold read is bounded, so a long session opens in one small chunk on a bad
// link rather than one enormous one. This is what makes the rest reachable: each
// tap reads the chunk before the bound the server last reported and puts it
// above, so a reader can walk back to the first message of any session.
//
// The history it fetches is deliberately not written to the transcript cache.
// That cache is rewritten whole on every append, and letting it grow with the
// scrollback would turn one streamed token into a megabyte-scale write on a
// phone. History stays in the DOM for the life of the page and is re-read after
// a reload, which costs one request on a screen the reader has to ask for
// anyway.

import * as view from 'view'
import * as wire from 'wire'
import * as errors from 'errors'

const log = document.getElementById('log')

// The one link, or null when nothing older is known to exist.
let link = null
// Guards against a second read while one is in flight: a reader tapping twice on
// a slow link would otherwise fetch the same chunk twice and paint it twice.
let loading = false
// The bound the next backwards read starts from, as the *server* last reported
// it, and the session it belongs to.
//
// Deliberately not the oldest row on screen. Most event types render no frame,
// so a chunk can paint little or nothing while still covering hundreds of
// events; and the first paint keeps every prompt however far back it sits, so
// the oldest row is routinely the log's first message while the work behind it
// is still unread. Taking the bound from the page would therefore either leave
// it standing — every later tap re-requesting the identical chunk, the log
// replaced in place rather than extended — or jump it to the very start and
// strand everything in between.
let bound = -1
let boundFor = null

// Show or retire the link for the session now on screen.
//
// Called after any paint. `more` is the server's word on whether anything sits
// behind the window it painted, so the link disappears exactly at the first
// message rather than after a wasted request that comes back empty.
//
// `from` is the seq the next backwards read starts at, as the server reported
// it for that same window. It is adopted only when it reaches further back than
// the walk has already read, because the walk's progress outlives the paint.
//
// This used to restate the bound on every call, on the reasoning that a replace
// throws away any history already prepended. That stopped being true: a replace
// repaints from `transcript`, which deliberately excludes prepended history, so
// the rows go but the reader has already read them. Restating then moved the
// bound *backwards* — a reader who had walked to seq 1200 had it reset to the
// tail window's edge at ~1900 by the next reconnect or resumed stream, and the
// following tap re-requested the 1200..1900 range they already had. That is
// where the duplicated scrollback rows came from: not a rendering fault, but
// history being fetched twice and folded into a second run line beside the
// first. A monotonic bound cannot ask for the same range twice.
export function offer (more, from) {
  // A different session is a different walk; nothing about the old one carries.
  // Checked before the bound is touched, because switching sessions routinely
  // arrives here as `offer(false)` with no bound at all.
  const id = view.current()
  if (id !== boundFor) { boundFor = id; bound = -1 }
  const restated = typeof from === 'number' && Number.isFinite(from) ? from : view.from()
  // Only ever further back. `-1` means "nothing known", which is why the first
  // bound for a session is adopted whatever it says.
  if (bound < 0 || (restated >= 0 && restated < bound)) bound = restated
  mark(more, restated)
  if (!more) return retire()
  // Move the existing link back to the top: a repaint replaces the log's
  // contents wholesale, so the node has to be put back after one.
  if (link !== null) { link.textContent = 'Older messages'; log.prepend(link); return }
  // A button, not a link. This loads more of the screen the reader is already
  // on; it does not go anywhere, so there is no URL for it to carry and no
  // history entry it should push.
  link = document.createElement('button')
  link.id = 'earlier'
  link.type = 'button'
  link.textContent = 'Older messages'
  // Take focus without letting the browser scroll it into view. This button
  // sits at the very top of the log, so the focus a press brings with it
  // scrolls the page to the top before any handler runs — measured as the
  // reader being thrown 715px up the page on every tap, which no correction
  // afterwards can undo because the position it needed is already gone.
  //
  // `mousedown` rather than `pointerdown`: the focus-and-scroll is the default
  // action of `mousedown`, and cancelling `pointerdown` instead would suppress
  // the whole compatibility sequence, `click` included, so the button would
  // never fire. Focus is then taken explicitly, so tapping still moves it and
  // keyboard activation is untouched.
  link.addEventListener('mousedown', event => {
    event.preventDefault()
    link.focus({ preventScroll: true })
  })
  link.addEventListener('click', load)
  log.prepend(link)
}

function retire () {
  if (link !== null) { link.remove(); link = null }
}

// Read the chunk before the current bound and put it above.
//
// One tap reads until it has something to show. A chunk that renders no frame
// still moves the bound, so the loop crosses a quiet stretch of the log — a run
// of turn boundaries, say — instead of ending the tap having visibly done
// nothing and leaving the reader to tap again against a link that looks broken.
async function load () {
  const id = view.current()
  // The bound belongs to the session it was read from; a stale one would ask
  // this session for another session's seq range.
  if (id === null || boundFor !== id || bound < 0 || loading) return
  loading = true
  link.textContent = 'Loading older messages…'
  let painted = ''
  let more = true
  // Bounded rather than `while (true)`: a server that stopped moving the bound
  // would otherwise spin here forever. Each pass covers a whole window, so this
  // crosses a very long quiet stretch in a single tap, and a log quieter still
  // costs one more tap rather than a hung page.
  for (let pass = 0; pass < 20 && more && painted === ''; pass += 1) {
    const url = '/api/s/' + encodeURIComponent(id) + '/before/' + bound
    let response
    try {
      response = await fetch(url)
    } catch (error) {
      return failed(url, 'Could not load older messages', String(error) + '\nAt: ' + new Date().toString())
    }
    if (!response.ok) {
      loading = false
      if (link !== null) link.textContent = 'Older messages'
      return errors.fromResponse('GET', url, response, 'Session: ' + id)
    }
    let chunk
    try {
      chunk = wire.earlierFrames(await response.json())
    } catch (error) {
      return failed(url, 'Could not read older messages', String(error)
        + '\nThe page and the server are probably different versions of this GUI;'
        + ' reloading the page picks up the current one.'
        + '\nAt: ' + new Date().toString())
    }
    // The reader may have switched sessions while this was in flight. Painting it
    // now would put one session's history above another's transcript.
    if (view.current() !== id) { loading = false; return }
    // The bound must strictly decrease, or the next pass asks for the chunk just
    // read. A server that failed to move it is treated as exhausted rather than
    // trusted into a loop.
    if (chunk.oldest >= bound) { more = false; painted += chunk.html; break }
    bound = chunk.oldest
    painted += chunk.html
    more = chunk.more
  }
  loading = false
  if (view.current() !== id) return
  // The link stays the log's first child; history goes directly beneath it.
  view.prepend(painted, link)
  // The walk's own bound, explicitly: `offer` falls back to the page when it is
  // given none, and the page's oldest row is a kept prompt from the very start
  // of the log, which would end the walk here and strand everything between.
  offer(more, bound)
}

// The first paint keeps every prompt however far back it sits, but not what
// answered it, so a prompt above the unread stretch stands with no reply under
// it. Those prompts are marked, and tapping one reads its reply into place.
//
// `data-opened` lives on the row itself, so a replace that repaints the log
// brings the prompt back closed — which is true, because the reply read into it
// went with the repaint.
function mark (more, edge) {
  for (const el of log.querySelectorAll('article[data-role="user"][data-seq]')) {
    const closed = more && edge >= 0 && Number(el.dataset.seq) < edge && el.dataset.opened === undefined
    el.toggleAttribute('data-closed', closed)
  }
}

log.addEventListener('click', async event => {
  const el = event.target.closest('article[data-closed]')
  // A press that ended a text selection is a copy, not a tap; and a link or a
  // button inside the prompt does its own thing.
  if (el === null || !getSelection().isCollapsed || event.target.closest('a, button') !== null) return
  const id = view.current()
  if (id === null) return
  delete el.dataset.closed
  el.dataset.opened = ''
  // A spinner row straight under the prompt, before the request goes out, so the
  // tap visibly landed even when the reply takes a slow link a while to arrive.
  const spinner = document.createElement('article')
  spinner.dataset.loading = ''
  spinner.textContent = 'Loading the reply…'
  el.after(spinner)
  const url = '/api/s/' + encodeURIComponent(id) + '/reply/' + el.dataset.seq
  let body
  try {
    const response = await fetch(url)
    if (!response.ok) {
      spinner.remove()
      el.toggleAttribute('data-closed', true)
      delete el.dataset.opened
      return errors.fromResponse('GET', url, response, 'Session: ' + id)
    }
    body = wire.expandedEvent(await response.json())
  } catch (error) {
    spinner.remove()
    el.toggleAttribute('data-closed', true)
    delete el.dataset.opened
    return errors.show('Could not load the reply', 'GET ' + url + '\n' + String(error) + '\nAt: ' + new Date().toString())
  }
  // Gone before the merge, so it never sits among the rows the reply seats against.
  spinner.remove()
  if (view.current() !== id || !el.isConnected) return
  // Merged by seq, so the reply seats directly under its prompt and any row
  // already on screen is not drawn twice.
  view.prepend(body.html)
  // Put the prompt at the top of the screen so the reply is what the reader sees.
  const header = document.querySelector('header')
  const clearance = header === null || header.hidden ? 0 : header.getBoundingClientRect().height
  document.scrollingElement.scrollTop += el.getBoundingClientRect().top - clearance
})

// Full technical detail inline, and the link restored so the reader can retry.
function failed (url, summary, detail) {
  loading = false
  if (link !== null) link.textContent = 'Older messages'
  errors.show(summary, 'GET ' + url + '\n' + detail)
}
