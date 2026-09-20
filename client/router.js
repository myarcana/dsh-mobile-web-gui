// Every full-screen change pushes history and changes the URL, and every URL
// opens the same screen when pasted into another browser. pushState plus a
// popstate listener: about fifteen lines, available everywhere, and its failure
// mode is never a full page navigation tearing down the stream.

let render = () => {}

export function start (fn) {
  render = fn
  addEventListener('popstate', event => {
    render(location.pathname)
    // Put the reader back where they were on this entry.
    //
    // Only for an entry `go` pinned a position onto, so a screen that never had
    // one — a cold deep link, a URL typed in — is left to the browser entirely.
    //
    // After `render`, because the screen has to exist before it can be scrolled,
    // and the list is painted synchronously from the cached listing. The tail of
    // a transcript arrives later and is not covered by this; a session opens at
    // its top, which is where `view.open` already puts it.
    const top = event.state === null ? undefined : event.state.top
    if (typeof top === 'number') restoreTop(top)
  })
  // One delegated listener for every internal link, including the ones the
  // server rendered inside transcript frames.
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    const link = event.target.closest('a')
    if (link === null || link.origin !== location.origin || link.hasAttribute('download')) return
    // A press that ended a text selection is a copy, not a navigation.
    if (!getSelection().isCollapsed) { event.preventDefault(); return }
    event.preventDefault()
    go(link.pathname + link.search + link.hash)
  })
  render(location.pathname)
}

// Hold the document at its current height across a navigation.
//
// The browser saves a history entry's scroll position as it leaves that entry,
// and it clamps every offset to the document's maximum the instant the document
// shrinks. Opening a session replaces a long list with a log that is empty until
// its tail arrives, so the sequence on a forward tap was: list 4800px tall at
// offset 600, log emptied, document collapses to one viewport, offset clamped to
// 0 — and 0 is what got written into the entry being left. Pressing Back then
// restored it faithfully. The wrong position was never produced on the way back;
// it was recorded on the way out.
//
// So the old height is pinned onto the body before the entry changes, and held
// until the new screen has a height of its own. The list already does exactly
// this for its own repaints — `commit` in chooser.js holds an identical floor —
// and this is that idea applied to the transition between screens, which had
// none.
//
// On the body rather than the log, because the log is a flex child and the
// padding and composer below it are part of the height being preserved.
//
// Which browsers this actually matters for is worth stating, because only one
// of them shows it. Blink re-clamps the restored offset again after layout
// settles, so a position saved against a collapsed document still comes back
// right and the bug is invisible there. Gecko restores the saved value once and
// does not revisit it, so on Firefox a bad save is permanent: Back lands at 0.
// The measurement that matters is therefore the offset standing at the moment
// the entry is left, not where a Chromium tab happens to end up.
//
// Released when the replacement is real rather than after a fixed delay: the
// tail of a session arrives over the network, and until it does the log holds
// only a notice one line tall. A timer would either fire before that and lose
// the position anyway, or sit there long after and strand dead space under a
// genuinely short screen. So the floor is dropped on the first frame where the
// document can stand without it, and given up on after a bounded number of
// frames so a session that really is one line tall cannot hold it forever.
// Scroll back to a pinned position once the document is tall enough to hold it.
//
// The list paints synchronously, so the first frame is usually enough. It is not
// always: a repaint driven by a summary frame can land immediately after and
// change the height, and a list restored before its rows have their final size
// would be scrolled against a document that then grows underneath it. So the
// write is repeated while the target is out of reach, and stops as soon as it
// lands — bounded, so a list that genuinely cannot reach it gives up rather than
// running forever.
//
// Never scrolls past what the document can hold: a session archived while the
// reader was away makes the list shorter than it was, and the closest honest
// answer is the new bottom.
function restoreTop (top) {
  let frames = 0
  const put = () => {
    const el = document.scrollingElement
    const target = Math.min(top, el.scrollHeight - el.clientHeight)
    if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
    // Reached it, or the document cannot grow any further towards it.
    if (Math.abs(el.scrollTop - top) <= 1 || frames >= 30) return
    frames += 1
    requestAnimationFrame(put)
  }
  put()
}

function holdHeight () {
  const floor = document.scrollingElement.scrollHeight
  document.body.style.minHeight = floor + 'px'
  let frames = 0
  const release = () => {
    // The height the document would have without the floor. It cannot be read
    // while the floor is applied — `scrollHeight` counts it, so the answer would
    // always be "tall enough" and the floor would lift on the very first frame,
    // which is precisely the bug this replaced. So it is lifted, measured, and
    // put back in the same frame; nothing paints in between.
    document.body.style.minHeight = ''
    const natural = document.body.scrollHeight
    if (natural >= floor || frames >= 30) return
    document.body.style.minHeight = floor + 'px'
    frames += 1
    requestAnimationFrame(release)
  }
  requestAnimationFrame(release)
}

export function go (path) {
  if (path === location.pathname + location.search + location.hash) return
  // Pin the position onto the entry being left, while that screen is still
  // standing and the offset is still true.
  //
  // The browser's own record of it is written at some point during the
  // navigation, and everything that happens next is hostile to it: the log is
  // emptied, the document shrinks, and the incoming screen scrolls itself to
  // the top. `holdHeight` keeps the document tall enough that the offset is not
  // clamped, but it cannot stop `view.open` from writing 0 — and on Gecko, that
  // 0 is what the entry keeps, because it saves once and never revisits.
  //
  // So the value is captured here, before any of that, and restored explicitly
  // on the way back. The browser's restoration still runs and is still correct
  // wherever it was already correct; this only supplies the answer for the case
  // where it recorded the wrong one.
  history.replaceState({ ...history.state, top: document.scrollingElement.scrollTop }, '')
  holdHeight()
  history.pushState(null, '', path)
  render(location.pathname)
}

// Go somewhere without leaving the current URL behind to come back to.
//
// For a screen that must not survive in history: archiving a session from its
// own menu takes both the menu and the transcript out of reach, because the
// session they name is no longer on the list. A pushState there would leave the
// back button pointing at a session that has been hidden.
export function replace (path) {
  history.replaceState(null, '', path)
  render(location.pathname)
}
