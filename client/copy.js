// A button that puts one string on the clipboard.
//
// The same control serves the worktree headings on the list and the worktree
// line above a session's title, so what "copy" means is decided once. What it
// copies is the worktree's plain name — the thing a reader pastes into a shell
// or a prompt — never a path or an id, which are not what the heading showed.
//
// The result is said on the button itself. A copy that silently succeeds and a
// copy the browser refused look identical otherwise, and this page is reached
// over plain http on bare IPs and .local names as often as over localhost —
// where `navigator.clipboard` is absent, because it is a secure-context API.
// So the fallback is not a nicety here, it is the common path.

// How long the button says what happened before going back to its label. Long
// enough to read, short enough that a second copy is not waiting on it.
const SAID_MS = 1200

// Put text on the clipboard, by whichever route this context allows.
//
// `navigator.clipboard` is undefined outside a secure context, so the older
// selection-and-execCommand path is kept for exactly that case. The textarea is
// positioned off-screen rather than hidden: a `display:none` element cannot be
// selected, and selection is the whole mechanism.
async function write (text) {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch (error) {
      // Refused (permissions, or a page that is not focused). Fall through to
      // the selection path, which asks the document rather than the platform.
    }
  }
  const field = document.createElement('textarea')
  field.value = text
  field.setAttribute('readonly', '')
  field.style.setProperty('position', 'fixed')
  field.style.setProperty('top', '-100px')
  document.body.append(field)
  field.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch (error) { ok = false }
  field.remove()
  return ok
}

// The two glyphs the control shows: two sheets for "copy", a tick for "copied".
//
// Drawn as inline SVG paths rather than as characters, because the obvious
// characters are not dependable. The clipboard emoji renders as a full-colour
// picture on one platform and a monochrome glyph on another, and both are the
// wrong size beside 12px text; the plain ones (⧉, ✓) are missing from enough
// fonts to come out as a replacement box. A path is the same two strokes
// everywhere and inherits the text colour.
//
// `currentColor` rather than a named colour, so the icon follows the label it
// sits beside — including through the dark-mode override, which never has to
// know this control exists.
// The mark renders about 17px across, and at that size an outline is not a
// picture of anything: a thin empty square with a thinner corner behind it
// reads as a small blank box — which is to say, as a button. Two sheets of
// paper only become legible when the front one is *solid*, because then the
// silhouette carries the meaning instead of the strokes.
//
// So the front sheet is filled and the back one is a stroked corner behind it.
// The contrast between the two is what makes the shape read as one thing
// overlapping another at a glance, rather than as a pair of rectangles.
const ICONS = {
  // The sheet behind: a corner peeking out, stroked.
  back: { d: 'M13 5.5H6.5V12', fill: 'none', stroke: true },
  // The sheet in front: solid, and the whole of the silhouette.
  front: { d: 'M8.5 8h7.5v8.5h-7.5z', fill: 'currentColor', stroke: false },
  // A tick, for the moment after it worked. A stroke, because a tick is a
  // gesture rather than a shape — filling it would make a wedge.
  done: { d: 'M4.5 10.5l3.5 3.5 7.5-7.5', fill: 'none', stroke: true },
}

/** Which paths make up each glyph, in paint order. */
const GLYPHS = {
  copy: ['back', 'front'],
  done: ['done'],
}

// Build one icon. Marked `aria-hidden` because the button already carries the
// accessible name — without it a screen reader would announce the graphic as
// well as the label, saying the same thing twice.
function icon (which) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  for (const name of GLYPHS[which]) svg.append(stroke(ICONS[name]))
  return svg
}

// One path of a glyph, filled or stroked as that path asks.
function stroke (shape) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', shape.d)
  path.setAttribute('fill', shape.fill)
  if (!shape.stroke) return path
  path.setAttribute('stroke', 'currentColor')
  // 1.5 in a 20-unit box: heavy enough to hold its colour at 17px, light enough
  // that the corner behind the front sheet stays a line rather than a slab.
  path.setAttribute('stroke-width', '1.5')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  return path
}

// The glue that keeps a copy mark on the same line as the text it copies.
//
// A worktree name may wrap mid-word, and the break opportunity that creates
// falls between the name's last fragment and the mark — so a name that filled
// the row left its mark stranded at the start of the next line, which is the
// one place it must never be. A word joiner immediately before the mark removes
// exactly that opportunity: if the mark does not fit, the fragment it is bound
// to comes down with it. Appended as `JOIN, button(...)` by every caller.
export const JOIN = '\u2060'

// One copy control for `text`.
//
// Inline beside a name, the face of the control is an icon: it sits next to a
// name that may wrap over several lines, and a word there competes with the
// name for the reader's eye and for the width the name needs. The icon is then
// the whole visible label, so what it copies has to be said in the accessible
// name — a page holding a dozen of these must tell a screen reader which is
// which, hence "Copy worktree name develop" rather than twelve identical
// "Copy"s.
//
// `worded` turns the same control into a menu row, where the opposite is true:
// a row among other rows is read as a list of options, and an option with no
// words is a guess. There it spells out what it does — "Copy session id" — and
// the icon becomes the decoration rather than the label. The id itself is not
// in the visible words: it is on screen already, as the heading above it.
export function button (text, what, worded = false) {
  const el = document.createElement('button')
  el.type = 'button'
  el.className = 'copy'
  el.append(icon('copy'))
  // Sentence case, so "Copy session id" reads as a sentence rather than as a
  // label: the words are the instruction, not a title for one.
  const words = 'Copy ' + what
  if (worded) el.append(words)
  const name = worded ? words : 'Copy ' + what + ' ' + text
  // The title is what a hover and a long press surface, and it is the only
  // place the word "copy" appears for a sighted reader now that the face of
  // the control is a glyph.
  el.title = name
  el.setAttribute('aria-label', name)
  let timer = null
  el.addEventListener('click', async event => {
    // On the list this button sits inside a heading whose own control toggles
    // the group, so without this a copy would also open or shut the worktree.
    event.preventDefault()
    event.stopPropagation()
    const ok = await write(text)
    // The outcome is shown by swapping the glyph, so the control never changes
    // width — a label growing from "Copy" to "Press and hold to copy" reflowed
    // the heading it sits in and pushed the name onto another line.
    // A worded row says the outcome where the reader is already looking, in the
    // same words the row was labelled with; an icon-only chip has nowhere to put
    // words, so the glyph carries it alone.
    el.replaceChildren(icon(ok ? 'done' : 'copy'))
    if (worded) el.append(ok ? 'Copied ' + what : 'Could not copy')
    const said = ok ? 'Copied ' + text : 'Could not copy ' + text + '. Press and hold to copy it by hand.'
    // Said as well as shown: a reader who cannot see the glyph change still
    // hears the outcome of their own tap.
    el.setAttribute('aria-label', said)
    el.title = said
    // Failure keeps the copy glyph, so the control still reads as something to
    // press; only the words change to explain what to do instead.
    if (ok) el.dataset.done = ''
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      el.replaceChildren(icon('copy'))
      if (worded) el.append(words)
      delete el.dataset.done
      el.setAttribute('aria-label', name)
      el.title = name
      timer = null
    }, SAID_MS)
  })
  return el
}
