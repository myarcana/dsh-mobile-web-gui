// Grow the message box with its contents, where the browser will not.
//
// `field-sizing: content` in app.css does this with no JavaScript at all, and
// is the path every current Chrome takes. It landed in Safari 26.2 and Firefox
// 152, so the browsers that predate those — notably an iPhone a version or two
// behind — get a box frozen at one row that scrolls inside itself instead.
// This measures the same thing by hand for those, and does nothing elsewhere.
//
// The height is written with `style.setProperty`, which is a CSSOM write and so
// passes `style-src 'self'`; a `<style>` element would be refused by the policy.

// Asked once. Support does not change while the page is open, and asking per
// keystroke would invite the two halves of one box to disagree.
const native = CSS.supports('field-sizing', 'content')

export function track (box) {
  if (native) return
  // `input` covers typing, paste, autocomplete and undo alike. Every other
  // route into the box sets `.value` directly, which fires nothing, so those
  // call `fit` themselves.
  box.addEventListener('input', () => fit(box))
  // A box pre-filled while its composer was still hidden could not be measured
  // at the time, so the height it carries is a guess. Taking focus is the first
  // moment the reader looks at it closely, and by then it is certainly on
  // screen. Blur re-measures for the same reason after the keyboard closes: the
  // max-height is a fraction of the *visible* viewport, so the cap it was
  // measured against changes as the keyboard comes and goes.
  box.addEventListener('focus', () => fit(box))
  box.addEventListener('blur', () => fit(box))
  fit(box)
}

export function fit (box) {
  if (native) return
  // A box with no layout boxes cannot be measured: scrollHeight reads 0 and the
  // measurement below would freeze it at one row. That is exactly what a session
  // created with an opening line hits — its draft is planted by the route
  // handler, which runs while the composer is still `hidden` from the previous
  // screen and only reveals it a few lines later. Deferring to the next frame
  // measures after the handler has finished and the composer is on screen.
  //
  // `offsetParent` is null precisely when the element or an ancestor is
  // `display: none`, which is what `[hidden]` resolves to here.
  if (box.offsetParent === null) {
    requestAnimationFrame(() => { if (box.offsetParent !== null) measure(box) })
    return
  }
  measure(box)
}

function measure (box) {
  // Collapse first: scrollHeight only ever reports the taller of content and
  // current height, so measuring without this makes the box a one-way ratchet
  // that never shrinks back after the text is cut or sent.
  //
  // The collapse momentarily shortens the document, because the composer sits
  // in normal flow inside a 100dvh flex column. Where an engine clamps
  // scrollTop to that shorter maximum, writing the height back restores the
  // document but not the offset, and the reader sees the transcript jump on a
  // keystroke that changed nothing. Chromium was measured not to clamp here;
  // this restores the offset for engines that do rather than asserting none do.
  //
  // Both reads are one-shot, inside an input handler; no scroll listener.
  const el = document.scrollingElement
  const before = el.scrollTop
  box.style.setProperty('height', 'auto')
  // max-height in the stylesheet still caps it, and overflow takes over there.
  box.style.setProperty('height', box.scrollHeight + 'px')
  if (el.scrollTop !== before) el.scrollTop = before
}
