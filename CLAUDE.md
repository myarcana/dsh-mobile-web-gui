we must write a very simple server that serves a web HTML/JS/CSS GUI for interacting with the harness, commanding and orchestrating sessions etc.

The GUI must be as simple and barebones as possible. The most important thing is that it must work well on flakey, lossy, slow internet connections. So it needs to be as small and lightweight as possible. So it needs to be lightweight vanilla HTML, JavaScript, and CSS, and have minimal dependencies, and minimal lines of code

Never nest HTML elements deeply.
Never write unnecessary CSS.
Never write unnecessary JavaScript.
The HTML file must be as small and as simple as possible. Basically beginner programmer day 1 source code, that simple. The point is to make it free of technical debt and complexity, and also to make it fewer bytes to send down the wire.

The whole point is to write as little code as possible.

The requirements are a mobile-first design, a super touch friendly super responsive and lagless zero-lag design that works well on mobile viewports and touchscreens.

The design is simple: a message box at the bottom that lets the user type a prompt to send to the session. A button in the top left that opens the session chooser. The rest of the screen is the output of the session, with user messages then agent messages.

Use as much of the screen as possible, both user messages and agent messages should be full width. Remember don't unnecessarily nest HTML elements.

Requirements:
- it doesn't matter if internet drops, if the device goes to sleep, if the tab is closed and reopened, etc., the page must always show to the user the most current state of things, the latest messages that came from the session.
- similarly, it doesn't matter if internet drops etc., sending a message, must always guarantee that that message will eventually be sent to the correct session, and it must be clearly indicated in the UI
- switching from one session to another session in the GUI should show the latest state of the new session as soon as possible without needing to wait for it to load after asking for the navigation
- several sessions can be running at once
- must use minimal battery on the client, must use minimal energy
- must not drain the client device's battery
- the hostname must NEVER matter, it must be possible to access the site via localhost:PORT, 192.168.1.1:PORT, something.local:PORT, something.test, customdns.com, etc., and it must never break







- All view changes must also push history and change the URL: anything that looks like a fullscreen view change to a user must have its own unique url. And copypasting that URL around must function like a deep link; copying the URL of the page and opening it in a second browser must open exactly the same stuff on the screen.
- There must be no conditional branching in the UI based on the role of a user; only do conditional branching based on what endpoints are actually returning for the logged-in user. This will stop it from being possible for the site to drift, the intention of this rule is to prevent it from ever being the case again that teachers will not have access to something they should have access to that a developer saw show up in the admin view of the site.
- all times (and dates) must always show timezones explicitly; it must ALWAYS show the detailed time with explicit timezone on hover, and if there is enough space, it must also always inline the timezone right there on the page
- never use all-caps, it is unfriendly. Use title case instead.
- do not use type assertions or casting in the new frontend code. Only use types package shared zod validators to convert API responses into a typed object.
- any errors must be presented with FULL technical details inlined into the page itself so that staff members can copy paste them directly to developers, or so that developers can read them easily during a screenshare without opening the console.
- scroll/mousewheel event listeners are banned, never use them
- never use containers that scroll inside of themselves (except for modals, which must be pinned to the viewport not the document), always use document (page) scrolling
- All view changes must also push history and change the URL: anything that looks like a fullscreen view change to a user, including opening or closing or navigating inside of modals, must have its own unique url. And copypasting that URL around must function like a deep link; copying the URL of the page and opening it in a second browser must open exactly the same stuff on the screen.
- There must be no conditional branching in the UI based on the role of a user; only do conditional branching based on what endpoints are actually returning for the logged-in user. This will stop it from being possible for the site to drift, the intention of this rule is to prevent it from ever being the case again that teachers will not have access to something they should have access to that a developer saw show up in the admin view of the site.
- never use all-caps in UI, it is unfriendly. Use title case instead.
- do not use type assertions or casting in source code. Only use types package shared zod validators to convert API responses into a typed object.
- any errors must be presented with FULL technical details inlined into the page itself so that staff members can copy paste them directly to developers, or so that developers can read them easily during a screenshare without opening the console.
- scroll/mousewheel event listeners are banned, never use them
- never use containers that scroll inside of themselves (except for modals, which must be pinned to the viewport not the document), always use document (page) scrolling
- do not use badge-like UI elements. Make minimal use of small elements that look like badges or pills. They are normally ugly and just arise as a symptom of cognitive overload from a poor UI.
- be very specific and unambiguous all the time in labels and titles. Instead of writing out something like "This class' schedule" use the specific class' name like "B1 Speaking and Listening's schedule"
- use the type system to make it impossible to add something somewhere that doesn't fall in line with requirements of the project
- use the type system to make drift between dependencies and consumers impossible
- use the type system to make it impossible to call a function/method/object/export in a way it doesn't support
- never register a scroll handler unless explicitly instructed to do so. Scroll handlers lead to bad UX.
- never truncate worktree names, always just wrap. No ellipsis, no `text-overflow`, no middle-elision, no clipping to a fixed width: the full name is always readable in full, wrapping onto as many lines as it needs.

We want zero packages, zero plugins, we want #NoBuild, basic HTML, JavaScript, and CSS.

npm install whatever costs you nothing at the moment you type it. Not a second of your day, not one visible byte. The bundler swallows the package, its forty-three transitive dependencies,
the plugin you needed to make it compile, and the polyfill runtime that plugin dragged along — and hands you back a single file with a single number next to it. That number creeps up. It
never really goes down. Eventually you stop reading it.

Watch someone load your app on a genuinely bad connection some time. Not slow. Bad. The kind where it gets 80% of the way through your 900KB bundle, the signal blinks, and you're back to
zero. So they try again. And again.

That's the part that never makes it into the performance blog posts. A bundle is one file, and one file is one bet. All of it or none of it. On a flaky connection you get none of it far
more often than your dashboards would have you believe, because your dashboards are mostly measuring people on fast connections who successfully loaded the thing.

Break the same app into forty small modules and the whole shape of the failure changes. A dropped request costs you one module. Retry it. The other thirty-nine are already sitting in the
browser, minding their own business. You're not starting over, you're filling in a gap.

Caching is where the bundle really stings. Ship a one-line fix and every user downloads the entire thing again. On my laptop, whatever, who cares. On a metered connection where megabytes
cost actual money, that's an app that simply doesn't open. With separate modules, one file expires and thirty-nine don't. Same fix, one percent of the bytes.

HTTP/3 piles on. QUIC recovers from packet loss per stream, so one lost packet stalls one response instead of everything queued behind it. Small files love that.

Now the fine print, because there is some. Import chains cost round trips, and round trips are exactly what a bad link makes you pay dearly for. Don't nest your imports six levels deep.
Hand the browser a modulepreload list so it can go fetch the whole set at once instead of discovering your app one file at a time. That's tuning, though. The default is already the better
default.

Sounds like a modulepreload list is important.

# Touchscreen & Mobile Interaction

This document defines the patterns and rules for building touch-friendly interfaces. It covers event handling, gesture control, browser APIs, and CSS techniques specific to touch devices.

For visual styling (colors, glass materials, animations, dark mode), see `docs/ui.md`.

---

## 1. Hover Handling

Hover does not exist on touch devices. The browser simulates hover on tap, but the state often "sticks" after the finger lifts.

### `@media (hover: hover)`

Wrap every `:hover` rule in `@media (hover: hover)`. This means hover styles only fire on devices with a real hover capability (mouse, trackpad). On touch-only devices, the rules inside are completely inert.

```css
/* Safe: hover only applies on devices that support it */
@media (hover: hover) {
  .button:hover { background-color: var(--brand-100); }
}
```

**Rules:**
- Keep hover effects **purely decorative** — subtle opacity, color, or scale shifts. Never gate important information or state changes behind hover.
- Never use hover to reveal content that touch users need to access (e.g., tooltips with critical info, action buttons that only appear on hover).
- If hover reveals supplementary content on desktop, provide an alternative interaction on mobile (e.g., tap-to-expand).

### Runtime touch detection

Where a CSS media query cannot express the choice — picking between two interaction models in JavaScript — a surface asks once whether the device reports touch support and caches the answer for the life of the page. Touch capability does not change while someone is using a page, so re-asking per interaction costs work and invites two parts of the same screen to disagree.

Use it to switch interaction models: tap-to-expand where the device reports touch, hover-to-preview where it does not.

### Responsive breakpoint guards

Some hover effects are restricted to desktop with a min-width media query:

```css
.card__resting { opacity: 1; }  /* Always visible on mobile */
.card__revealed { opacity: 0; }

/* Hover effect only above the small breakpoint */
@media (min-width: 640px) and (hover: hover) {
  .card:hover .card__resting { opacity: 0; }
  .card:hover .card__revealed { opacity: 1; } /* Shown on desktop hover */
}
```

This is appropriate when the mobile layout is fundamentally different. It does not replace the plain `@media (hover: hover)` guard for elements that appear at all breakpoints.

---

## 2. Press Feedback

Touch users need confirmation that their tap registered. However, **do not use CSS `:active` pseudo-class** for this (see `docs/ui.md` section 2, "Never Use `:active`"). On mobile, `:active` fires during scrolling, causing visual glitches.

**Non-negotiable rule: while the user is scrolling there must be no touch-down interaction or effect whatsoever.** A scroll frequently begins with the first finger contact landing on a card, button, or other interactive element. That contact must never make the element shrink, flash, bloom, change colour, or otherwise react. Press feedback is reserved for a *deliberate* press — a finger that comes down and stays put — never for a finger that is on its way to scrolling.

The mechanism that guarantees this: a touch-down only **arms** the press; the pressed state is applied only after a short hold, and any finger travel past a small distance threshold disarms it. Because a scroll starts the finger moving (and the browser also fires `pointercancel` when it claims the gesture), the press never lands on a scrolling finger, while a still finger still bounces. Do not apply the pressed state synchronously on `pointerdown`. All shared interactive primitives (`Button`, `IconButton`, the press-bounce hook the cards use) implement this contract centrally, so build on them rather than hand-rolling per-element press effects.

Pair press feedback with **haptic feedback** — every tap/click interaction on mobile must trigger haptics via the shared `haptic(style)` utility (see `docs/specs/component-library-frontend.md`).

---

## 3. Pointer Events API

Use the **Pointer Events API** for all drag, gesture, and custom interaction handling. Pointer Events unify mouse, touch, and stylus input into a single event model — no coordinate branching needed.

```tsx
const handlePointerDown = (e: React.PointerEvent) => { /* ... */ };
const handlePointerMove = (e: React.PointerEvent) => { /* ... */ };
const handlePointerUp = (e: React.PointerEvent) => { /* ... */ };

<div
  onPointerDown={handlePointerDown}
  onPointerMove={handlePointerMove}
  onPointerUp={handlePointerUp}
/>
```

Coordinates are available directly on the event object (`e.clientX`, `e.clientY`) regardless of input type.

### Pointer Capture

Call `setPointerCapture()` on drag start so events keep flowing to your element even if the finger/cursor slides outside it:

```tsx
const handlePointerDown = (e: React.PointerEvent) => {
  if (e.target instanceof HTMLElement) {
    e.target.setPointerCapture(e.pointerId);
  }
  // start tracking...
};
```

### Handling `pointercancel`

The browser fires `pointercancel` when it takes over a gesture (e.g., for native scrolling). Use this to avoid accidental actions — if a `pointerdown` started but the browser cancelled it, do not treat the interaction as a tap:

```tsx
const pendingRef = useRef(false);

const handlePointerDown = () => { pendingRef.current = true; };
const handlePointerUp = () => {
  if (pendingRef.current) doAction(); // user tapped
};
const handlePointerCancel = () => {
  pendingRef.current = false; // browser took over — don't act
};
```

### When to use `isTouchDevice()` vs Pointer Events

- **Pointer Events**: Use for all drag, gesture, and custom interaction code. This is the primary approach.
- **`isTouchDevice()`**: Use only for switching between fundamentally different interaction *models* (e.g., tap-to-classify on mobile vs drag-and-drop on desktop, hover-to-preview on desktop vs tap-to-expand on mobile). Do not use it for coordinate handling or event binding — Pointer Events handle that.

---

## 4. `touch-action` CSS Property

The browser intercepts touch gestures for scrolling, zooming, and other default behaviours. Use `touch-action` to control which gestures the browser handles vs which your code handles.

### `touch-action: none`

Apply on elements where your code handles all gestures (drag surfaces, crop areas, canvases, zoom containers):

```css
.drag-surface { touch-action: none; }
```

Apply as **narrowly as possible** — putting it on `body` prevents all native scrolling. Prefer per-element.

### `touch-action: manipulation`

Apply on buttons and tappable elements. This kills the 300ms double-tap-to-zoom delay while still allowing normal scrolling:

```css
button, .tappable { touch-action: manipulation; }
```

### `touch-action: pan-y`

Apply on horizontally-swipeable containers where vertical scrolling should still work (e.g., carousels and page flippers):

```css
.swipe-container { touch-action: pan-y; }
```

---

## 5. Text Selection on Gesture Surfaces

Text stays selectable everywhere. `docs/ui.md` § 10 (Selectable Text) owns that rule and names the
one carve-out; the mechanics belong here.

Each app's global stylesheet names the elements a browser would otherwise exclude (`button`, `label`,
`summary`, `a`, `[role="button"]`) `user-select: text`, since that exclusion is what would make an ID
or a timestamp rendered inside one uncopyable. The declaration is honoured unevenly: WebKit still
starts no selection from a press inside a form element whatever it says, while Chromium obeys it.
Because the gap shows up on Safari and not in the browser most of this code is written in, selection
beginning where the reader put the pointer down is treated as a question of which element is used
rather than which classes it carries.

Three consequences, all structural:

- **Staff-portal controls are containers carrying the button role, never `<button>` elements**, so a
  press inside one starts a selection. They take focus and activate on Enter and Space, submit their
  form when they are the submit control, and treat the pointer release that ends a selection as a
  copy rather than a press. The shared button and card primitives implement this once.
- **A link and its descendants decline the link-drag** (`-webkit-user-drag: none`), which a browser
  otherwise takes before a sweep inside it can begin. The property does not inherit, and a card's
  text sits in elements *within* the link, so naming the link alone leaves the drag armed exactly
  where the reader presses. An image keeps its own drag. The click that ends such a sweep is refused
  once at the document rather than at each link, and a press with no selection behind it still
  travels.
- **A hover-detail trigger over readable text is not a control at all** — a `<span>`, `<div>`, or
  `<time>` carrying the trigger's handlers and `aria-describedby`, since nothing happens when it is
  pressed.

A surface whose drag *is* the interaction — pan, crop, region draw, reorder, scrub, press-and-hold —
sets `user-select: none` (plus the `-webkit-user-select` prefix) on the element that
receives the pointer, and calls `e.preventDefault()` during the drag so the browser neither scrolls
nor selects.

Two constraints on where it goes:

- **As narrow as the gesture.** Put it on the element handling the pointer, never on a container
  that also holds readable labels.
- **Bound to the tool.** Where the gesture belongs to a tool that can be put down, scope the rule to
  a state class the surface carries only while that tool is active, so it returns to selectable the
  moment the tool is put down.

---

## 6. `pointer-events` for Layered UIs

When overlays, wrappers, or decorative layers sit on top of interactive elements, use CSS `pointer-events` to let taps pass through non-interactive layers:

```css
.overlay { pointer-events: none; }
.overlay .button { pointer-events: auto; }
```

Use it for non-interactive backdrops and decorative layers: the layer itself is `pointer-events: none` while the interactive controls inside it are `pointer-events: auto`, so taps reach the intended target.

---

## 7. Touch Targets

All interactive elements must have a minimum tap area of **44x44pt**. This is non-negotiable.

For drag handles and frequently-used controls, go larger (56pt+).

If the visual element is smaller than 44pt (e.g., a small icon), extend the tap area with padding or an invisible hit area.

An inline target only a few px wide (a single character, a thin toggle) still needs a 44x44pt hit
area — extend it with padding or an invisible inset without disturbing the surrounding flow or overlapping
neighbouring targets' hit areas. Where an inner target sits inside an outer tap surface, call both
behaviours explicitly from the inner handler rather than relying on event bubbling, and fire haptics once
per physical tap, not once per action.

---

## 8. Viewport and Safe Areas

### Viewport meta tag

Both the `frontend/` web app and the `capacitor-app/` set `width=device-width, initial-scale=1` and nothing that blocks zoom — no `maximum-scale`, `minimum-scale`, or `user-scalable=no` on any viewport meta. Keeping the app browser-zoomable is a deliberate, protected accessibility decision; the rationale and the rule never to revert it live in `docs/ui.md` § 10 (User Zoom).

`capacitor-app/src/styles/index.css` sets `touch-action: manipulation` on `html, body`. This suppresses only the legacy double-tap-to-zoom gesture (and its 300ms tap delay), keeping taps responsive; pinch-zoom stays available. Because that rule is global, individual components do not repeat `touch-action: manipulation` on tappable elements.

A surface that owns a two-finger gesture itself (pinch-zooming its own content rather than the document) must set `touch-action: none` so the browser never claims that gesture and races the custom handler — on Android an unclaimed pinch resolves inconsistently. `touch-action: none` hands the surface the full pointer stream on every device; single-finger text selection and OCR still reach the OS because those are not governed by `touch-action`.

### Dynamic viewport height

Use `dvh` instead of `vh` to account for the mobile address bar appearing and disappearing:

```css
.screen { min-height: 100dvh; }  /* Full screen on mobile */
.panel { max-height: 33dvh; }    /* One third of visible area */
```

For JavaScript, use the Visual Viewport API when you need the actual visible height (e.g., when the on-screen keyboard is open):

```ts
const height = window.visualViewport?.height ?? window.innerHeight;
```

When the learner app runs in a mobile browser, a bottom address bar that retracts and re-expands on scroll makes viewport-bottom-anchored chrome (the tab bar) jitter — the browser repositions the `fixed` element every frame to track the changing visual viewport. This is inherent to browsing with a dynamic toolbar and is not fully removable in-page. The sanctioned answer is to install the app to the home screen: the standalone launch has no browser toolbar to animate, so the jitter disappears. The app surfaces that install directly (`docs/specs/capacitor-app-install.md`).

### Safe area insets (notched devices)

The project handles safe areas via CSS custom properties defined in `frontend/src/styles/index.css`:

```css
:root {
  --safe-area-inset-top: env(safe-area-inset-top, 0px);
  --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px);
  /* ... */
}
```

The same stylesheet defines utility classes `pt-safe`, `pb-safe`, `pl-safe`, `pr-safe` that apply the corresponding safe area padding:

```css
.pb-safe { padding-bottom: var(--safe-area-inset-bottom); }
```

The `Page` component handles safe area insets automatically.

For custom layouts that sit outside the `Page` component, use the safe area utilities directly on toolbars and bottom-fixed elements:

```html
<div class="pb-safe">Bottom toolbar content</div>
```

### Keyboard handling

A focused input and any bottom-fixed chrome are kept above the on-screen keyboard, so per-field work is neither needed nor wanted:

- Inputs and textareas need no per-field handling — do not add `scrollIntoView`, `onFocus` scroll, or keyboard listeners, and do not change the platform keyboard resize mode.
- Use `dvh`, `margin-top: auto`, `pb-safe`, sticky positioning, and `position: fixed` normally. In a mobile browser the browser itself compensates; in the native WebView the app lifts the whole layout as one group, so fixed elements do not jump or reflow.

---

## 9. Touch-Specific CSS

Applied globally in `frontend/src/styles/index.css`:
- `-webkit-tap-highlight-color: transparent` — removes the default blue/grey tap highlight on iOS/Android.

Applied on specific components:
- `overscroll-behavior: contain` — on bottom sheets and scrollable panels, prevents the page behind from scrolling when the user reaches the edge of the panel.

---

## 10. Mobile Safari Quirks

Mobile Safari occasionally computes layout offsets differently from other browsers and needs a UA-gated fix. When you hit a Safari-only rendering issue, detect it by UA string and apply a targeted adjustment rather than changing the shared layout:

```ts
const isMobileSafari = (): boolean => {
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua);
  const isSafari = /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  return isIOS && isSafari;
};
```

---

## 11. Native Share API

When sharing content on mobile, use the built-in share sheet instead of building a custom share dialog:

```ts
async function share(file: File) {
  if (navigator.share) {
    await navigator.share({ files: [file], title: 'Check this out' });
  } else {
    downloadFile(file); // fallback for desktop
  }
}
```

Feature-detect with `navigator.share` before calling. The API is available on iOS Safari, Android Chrome, and some desktop browsers.

---

## 12. Async Image Decoding

When doing heavy image work (canvas rendering, cropping, image processing), use `img.decode()` to avoid blocking the main thread:

```ts
const img = new Image();
img.src = url;
await img.decode();
ctx.drawImage(img, 0, 0);
```

This prevents jank on lower-powered mobile devices during image-heavy operations.

---

## Checklist for New Interactive Components

1. Wrap hover effects in `@media (hover: hover)` so they only fire on hover-capable devices.
2. Keep hover effects purely decorative. Provide alternative interactions for content revealed on hover.
3. Do not use the `:active` pseudo-class. Use JS press handlers for tap feedback, and never apply a pressed state synchronously on `pointerdown` — arm on down, apply only after a short hold, and disarm on any finger travel so scrolling never triggers a touch-down effect (section 2).
4. Trigger haptic feedback on every tap via the `haptic()` utility.
5. Use the Pointer Events API for all drag/gesture handling. Call `setPointerCapture()` on drag start.
6. Handle `pointercancel` to avoid accidental actions when the browser takes over a gesture.
7. Set `touch-action` appropriately: `none` on custom gesture surfaces, `manipulation` on buttons, `pan-y` on horizontally-swipeable containers.
8. Does this component keep its text selectable? It must (`docs/ui.md` § 10). `user-select: none` goes only on an element whose drag is the interaction, and only while that gesture tool is active (section 5).
9. Use `pointer-events: none` / `pointer-events: auto` on layered UIs to ensure taps hit the right target.
10. All tap targets must be at least 44x44pt.
11. Use `dvh` units instead of `vh` for viewport-relative sizing.
12. Use safe area utilities (`pb-safe`, etc.) on bottom-fixed elements.
13. Use `navigator.share` for sharing on mobile, with a download fallback.
14. Use `img.decode()` before heavy canvas work.
15. Test on a real touch device or browser devtools touch simulation.


I didn't much care for vanilla JavaScript prior to ES6. Through all of the
2000s, I chased different approaches to avoid writing too much of it. First
there was RJS (Ruby-to-JavaScript). Then there was CoffeeScript. Both
transpiling approaches that turned more enjoyable-to-write source code into the
kind of JavaScript that browsers would execute. It sorta worked.

But it was clearly a clutch. A stop-gap while we waited for browsers to
understand a better JavaScript. Though for a while it looked like that might
never happen, and we'd forever be stuck with these clutches!

Thankfully that wasn't so. JavaScript *was* improving, and by 2015, the huge
jump that is ES6 was finalized. Yet well before that – and well after that!
– the Babel transpiler was letting us write this JavaScript of the future.

It was a revelation. Being able to program using this much better JavaScript,
well before broad browser support was available. It kinda felt like cheating.
Like we were getting something for nothing. That wasn't quite right, though.

Transpiling with Babel ushered in the era of horrendously complicated
transpiling pipelines and tooling. Writing the JavaScript of the future wasn't
free. The price was an ever expanding web of complexity. This clearly wasn't
the finish line.

I'm grateful that tools like Webpack made this transition possible, though.
Despite the complexity, it felt worth the bargain. So back in 2016, I created
[Webpacker](https://github.com/rails/webpacker/), and in 2017, we shipped
[Rails 5.2](https://weblog.rubyonrails.org/2017/2/23/Rails-5-1-beta1/), which
embraced this approach to managing JavaScript with Rails.

Five years later, the facts on the ground have finally changed. I no longer
believe that this bargain is worth it for most new applications. It's not
a dead-end, and there are still certain types of applications where it does
make sense (hello react!), but it's no longer a good default for Rails.

The first crucial change is that ES6 is now supported by all browsers that
matter. Chrome, Edge, Safari, and Firefox fully support ES6.

This means we don't need a transpiling step to turn ES6 into something that'll
run in the browser. It runs just fine, no changes needed. That's huge.

The second crucial change is that HTTP2 is now the norm. With HTTP2, you no
longer pay a large penalty for sending many small files instead of one big
file. A single connection can multiplex all the responses you need. No more
managing multiple connections, paying for multiple SSL handshakes. This means
that bundling all your JavaScript into a single file loses many of its
performance benefits (yes, yes, tree-shaking is still one).

In fact, the single-big-bundle pattern is now worse in several ways, not just
developer ergonomics (like long bundling times!). When you bundle all your
JavaScript modules in a single file, any change to any module will expire the
entire bundle. Forcing the browser to download the whole thing anew, parsing
everything again. That's bad.

When you keep each module separate, they can expire independently. So if you
have 20 modules, and only one change, the other 19 remain cached. This is the
kind of caching dynamics that performance enthusiasts crave.

But more importantly for our overall argument is that if you no longer need
bundling for performance, you can get rid of the bundler entirely! Simply serve
each module directly, as their own file, directly to the browser.

Can you see where we're getting to? No need for transpiling to write the kind
of JavaScript that makes you smile, no need for bundling to package all your
modules. Taken together: No need for any JavaScript toolchain to turn your
source code into anything else. An entire class of complexity stands at the
precipice.

The final piece that's pushing the two first crucial changes over the paradigm
hill is import maps. They allow the use of logical references for modules in
ES6 (also known as ESM), rather than explicit file references. The problem with
explicit file references is that they pair poorly with the standard approach of
long-life caches with digest-stamped file names.

When you see a filename like main-a6d26cef87d241eba5fa.js, that last bit is
a digest of the entire file. It's unique for that specific file, so if we
change anything in the file, the digest changes too. This means that we can
tell the browser to cache the file with the digest *forever* because it'll
never change. If it changes, it gets a new file name. This is critical to get
good performance with cache expiration dynamics you control.

But imagine if you had 50 files that all had an opening import like "import
{ Controller } from './javascript/stimulus-a6d26cef87d241eba5fa.js'"? That
would suck. You'd have to update each of those files every time you bumped your
Stimulus dependency, and all of those files would individually expire when you
did!

The answer to this problem is called [import
maps](https://github.com/WICG/import-maps).

With import maps, you define the mapping of imports. So instead of
"./javascript/stimulus-a6d26cef87d241eba5fa.js", it's just "stimulus", and then
the import map says "stimulus": "/javascript/stimulus-a6d26cef87d241eba5fa.js".
If you bump Stimulus, you just change the map, not the references. Voila!

Maintaining the import map by hand is still a bit of a chore, so for Rails,
I've created the
[importmap-rails](https://github.com/rails/importmap-rails/) gem, which allows
you to build the map programmatically. A complete package.

Take the pillars of transpiler-less and bundler-less progress, pair it with
a generated import map, and you now have an environment that does not even
require you to install node locally to create modern, awesome web apps.

The [Hotwire](https://hotwired.dev) gems for Rails, both for
[Stimulus](https://github.com/hotwired/stimulus-rails) and
[Turbo](https://github.com/hotwired/turbo-rails), have already been altered to
rely on this setup. The gems use the programmatic access to setup the import
map behind the scenes, and in your application.js, you can thus just import the
modules directly.

It's hard to convey what a difference it makes to the development experience to
cut out this massive tumor of complexity. It feels like a new lease on life.
But there are still some unanswered questions and concessions.

As mentioned, the first is that certain popular frameworks like React, which
rely on compiling for JSX, just won't work with any of this (yet?). Anything
that requires an explicit transpiling or compiling step obviously need
a transpiler or compiler. And then you're back to square one.

The second is that while Hotwire, together with the JavaScript in Rails for
things like Action Text, Active Storage, and Action Cable, can be made
available through Ruby gems and the asset pipeline, there's a great big
JavaScript ecosystem we still need better answers for.

So despite how promising this all is, what a real leap forward ES6 everywhere,
ubiquitous HTTP2, and import maps combine to present, there's clearly still
a class of applications that'll need Webpack. At least for now.
And that's fine. We're moving forward by taking things out. Not everyone can
take these things out yet, but those who can will be mightily pleased.

We're way overdue a correction back to simplicity for the frontend.
ES6/HTTP2/Import maps looks like they'll deliver just that. Yay hurray!
