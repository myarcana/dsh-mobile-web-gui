// Publish the on-screen keyboard's height as --kb, so CSS can keep the
// document and the composer above it.
//
// Needed because iOS does not support `interactive-widget=resizes-content`:
// WebKit leaves the layout viewport at full height and simply covers the
// bottom of it with the keyboard, so anything pinned to the viewport bottom
// ends up behind the keyboard, and the browser then scrolls past the end of
// the document trying to reveal the focused field.
//
// This listens to `resize` on the visual viewport, never to `scroll`. The
// scroll-handler ban exists because scroll-driven layout janks — a handler
// firing on every frame of a gesture. A resize handler fires when the keyboard
// opens or closes, a few times a session, and never during a scroll.
//
// The height is written with `style.setProperty`, which is a CSSOM write and
// so passes `style-src 'self'`; a `<style>` element or a `style` attribute
// would be refused by the policy.

export function track (composer) {
  const vv = window.visualViewport
  if (!vv) return
  const publish = () => {
    // Gated on focus, because the same difference appears with no keyboard at
    // all: Safari's expanded toolbar also shrinks the visual viewport below
    // innerHeight, and treating that as a keyboard would lift the composer off
    // the bottom for no reason. A keyboard only exists while a field has focus.
    const typing = composer.contains(document.activeElement)
    // innerHeight is the layout viewport, which the keyboard does not shrink
    // on iOS; vv.height is what remains visible. Panning changes neither, so
    // no scroll signal is needed.
    const covered = typing ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0
    document.documentElement.style.setProperty('--kb', covered + 'px')
  }
  vv.addEventListener('resize', publish)
  // focusin fires before the keyboard has finished animating, so the resize
  // above is what lands the real height; these two make closing instant.
  composer.addEventListener('focusin', publish)
  composer.addEventListener('focusout', publish)
  publish()
}
