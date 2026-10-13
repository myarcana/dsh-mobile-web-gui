// Publish the on-screen keyboard's height as --kb, so CSS can cap the message
// box at a share of what is actually visible.
//
// Needed because iOS does not support `interactive-widget=resizes-content`:
// WebKit leaves the layout viewport at full height and covers the bottom of it
// with the keyboard, so 100dvh still means the whole screen.
//
// It is deliberately not used to position anything. iOS already pans the
// visible area up by the keyboard's height to reveal the focused box, which
// lands the sticky composer just above the keys on its own. Lifting the
// composer or padding the body by --kb as well counted the keyboard twice and
// threw the box off the top of the screen.
//
// On a browser that does honour the key, both viewports shrink together and
// the difference below is 0, so nothing is published and nothing is paid for.
//
// This listens to `resize` on the visual viewport, never to `scroll`. The
// scroll-handler ban exists because scroll-driven layout janks — a handler
// firing on every frame of a gesture. A resize handler fires when the keyboard
// opens or closes, a few times a session, and never during a scroll.
//
// The height is written with `style.setProperty`, which is a CSSOM write and
// so passes `style-src 'self'`; a `<style>` element or a `style` attribute
// would be refused by the policy.

// What --kb last had written to it, so an unchanged height costs nothing.
let published = 0

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
    // here; vv.height is what remains visible. Panning changes neither, so no
    // scroll signal is needed.
    const covered = typing ? Math.max(0, Math.round(window.innerHeight - vv.height)) : 0
    // Never write a value that is already there. A write to --kb invalidates
    // style for the whole document, and `resize` fires for things that leave
    // the covered height untouched.
    if (covered === published) return
    published = covered
    document.documentElement.style.setProperty('--kb', covered + 'px')
  }
  vv.addEventListener('resize', publish)
  // focusin fires before the keyboard has finished animating, so the resize
  // above is what lands the real height; these two make closing instant.
  composer.addEventListener('focusin', publish)
  composer.addEventListener('focusout', publish)
  publish()
}
