// Opening a session lands the reader at the top of whatever it wants from them.
//
// A waiting question if there is one, and the newest message otherwise. Not the
// top of the transcript, and not the bottom of it. The newest message is what
// someone opens a session to read, so its first line sits just under the sticky
// header and earlier conversation runs upwards from there — but a question the
// agent has stopped on outranks it, because nothing moves until it is answered
// and the newest message is routinely the preface to the question rather than
// the point of it.
//
// Two routes reach a transcript and both are measured here, because they paint
// through different paths: a cold deep link adopts the server's own first paint,
// while an in-app tap repaints from cache and then takes the tail over the
// stream. Either one landing somewhere else is the bug this guards.
//
// The tail is the subtle half. It arrives moments after the paint as a replace
// frame, and the append path decides whether to follow it by asking whether the
// reader is already near the bottom. Anchored mid-document that has to answer
// no, so the position is measured again after the transcript has settled rather
// than only on the frame the navigation happened in.
//
// The fallback is the other half. A session whose newest message begins less
// than one viewport from the end cannot put that message at the top of the
// screen — there is no scroll position past the document bottom — so the
// browser's own clamp lands it at the bottom with the message fully visible.
// That is measured too, because it is the case the rule was written around.
//
//   LONG=1 PORT=7801 node mock/server.js
//   node scripts/verify-open-at-top.mjs [origin]    default http://127.0.0.1:7801
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7801'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const errors = []
// Transport failures are the sandbox this runs in, not the page: a dropped
// asset fetch says nothing about where the transcript is scrolled to, and
// letting it fail the run would make the check report weather.
const transport = /ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_RESET|net::ERR_FAILED/
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => {
  if (message.type() !== 'error') return
  if (transport.test(message.text())) return
  errors.push(message.text())
})

// The rows that count as a message. A tool call, a progress line, and the folded
// run they collapse into are the working-out either side of a message, so none
// of them is an anchor — the same set the client itself anchors on.
const MESSAGES = '#log article[data-role="user"], #log article[data-role="assistant"], #log article[data-role="subagent"]'

const offset = () => page.evaluate(() => document.scrollingElement.scrollTop)
// Proof the transcript is actually taller than the viewport. On a document that
// fits, top and bottom are the same number and every assertion below passes for
// no reason at all.
const scrollable = () => page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight - el.clientHeight
})

// Where the newest message sits relative to the header's lower edge. Zero means
// its first line is exactly clear of the header, which is the target; a negative
// number means the sticky header is covering it.
const gap = () => page.evaluate(selector => {
  const messages = document.querySelectorAll(selector)
  const newest = messages[messages.length - 1]
  if (newest === undefined) return null
  const header = document.querySelector('header')
  const under = header === null || header.hidden ? 0 : header.getBoundingClientRect().bottom
  return newest.getBoundingClientRect().top - under
}, MESSAGES)

// Whether the document is parked at its own end, which is the only honest answer
// when the newest message is too close to the bottom to reach the top.
const atEnd = () => page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight - el.scrollTop - el.clientHeight < 4
})

// How much document sits below the top of the newest message. This is what
// decides which half of the rule applies: more than a viewport and the message
// can reach the top of the screen, less and the clamp parks it at the bottom.
const belowNewest = () => page.evaluate(selector => {
  const messages = document.querySelectorAll(selector)
  const newest = messages[messages.length - 1]
  if (newest === undefined) return null
  let top = 0
  for (let at = newest; at !== null; at = at.offsetParent) top += at.offsetTop
  return document.scrollingElement.scrollHeight - top
}, MESSAGES)

// A cold deep link: the server rendered the transcript and the client adopted it.
//
// `still-working` is the fixture with work below its newest message, so the
// anchor is actually reachable here. A session ending on a message could not
// prove this: its newest message is within a viewport of the document end, so
// the clamp would land it at the bottom and the check would pass for the wrong
// reason. That case is measured further down, deliberately and separately.
await page.goto(`${origin}/s/still-working`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))
check('the deep-linked transcript is longer than the viewport',
  await scrollable() > 200, `${Math.round(await scrollable())}px of scroll`)
// Let the tail land. The replace frame is what actually anchors the position,
// and it arrives after the first paint, so a position read only on load would
// miss it entirely.
await page.waitForTimeout(2500)
// The anchor has to be reachable for the next check to mean anything: enough
// work below the newest message that it can sit at the top with the document
// still able to scroll further.
check('the deep-linked session has more than a viewport of work below its newest message',
  await belowNewest() > 844, `${Math.round(await belowNewest())}px below it`)
check('the deep link opens at the top of its newest message',
  Math.abs(await gap()) < 4, `${Math.round(await gap())}px from the header`)
check('the deep link is not parked at the transcript top',
  await offset() > 100, `scrollTop ${Math.round(await offset())}`)
check('no page errors while the tail landed', errors.length === 0, errors.slice(0, 2).join(' | '))

// An in-app navigation: the list, then a tap into a session.
// The list opens as collapsed workspace headings, so a session link only exists
// once its group is expanded. Which group is expanded lives in the URL, so the
// one holding the long fixture is asked for directly — a short transcript could
// not tell one position from another, and the expansion is a deep link like any
// other.
await page.goto(`${origin}/sessions?open=ws-dmwg`, { waitUntil: 'domcontentloaded' })
const target = page.locator('#log a[href="/s/still-working"]')
await target.waitFor({ timeout: 20000 })
// Scroll the list down first, so the position cannot be inherited from a page
// that simply never moved.
await page.evaluate(() => { document.scrollingElement.scrollTop = 300 })
const href = await target.getAttribute('href')
await target.click()
await page.waitForSelector('#log article', { timeout: 20000 })
check('the tap opened a session', new URL(page.url()).pathname === href, `${page.url()} vs ${href}`)

await page.waitForTimeout(2500)
// Only meaningful on a transcript with somewhere else to be. A session shorter
// than the viewport would pass this whatever the code did.
check('the tapped transcript is longer than the viewport',
  await scrollable() > 200, `${Math.round(await scrollable())}px of scroll`)
check('a tapped session opens at the top of its newest message',
  Math.abs(await gap()) < 4, `${Math.round(await gap())}px from the header`)

// The fallback: a session whose newest message cannot reach the top of the
// screen. `long-scrollback` ends on a message, so that message sits within a
// viewport of the document end — there is no scroll position that would put it
// at the top, and the browser's clamp is the whole of the fallback. What must
// be true is that the document sits at its end with the message wholly visible.
await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
await page.waitForTimeout(2500)
check('the fallback session keeps its newest message within a viewport of the end',
  await belowNewest() < 844, `${Math.round(await belowNewest())}px below it`)
check('a newest message too near the end parks the document at its bottom',
  await atEnd(), `scrollTop ${Math.round(await offset())} of ${Math.round(await scrollable())}`)
check('that newest message is still wholly on screen',
  await page.evaluate(selector => {
    const messages = document.querySelectorAll(selector)
    const box = messages[messages.length - 1].getBoundingClientRect()
    return box.top >= 0 && box.bottom <= innerHeight + 4
  }, MESSAGES), `${Math.round(await gap())}px below the header`)

// Following the live end must still work: a reader sitting at the bottom is
// carried along by new messages. Anchoring on open must not have removed that,
// so it is proven rather than assumed.
await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
await page.evaluate(() => {
  const el = document.scrollingElement
  el.scrollTop = el.scrollHeight - el.clientHeight
})
check('a reader can still reach the live end', await page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
}))

// A session waiting on a question opens at the top of that question.
//
// `waiting-on-you` is the fixture shaped to tell the two anchors apart. Its
// transcript runs on past its last message, and its form is taller than the
// viewport, so anchoring on the form and anchoring on the message land in
// different places. A one-question form could not prove this: it is short
// enough to fall inside the document-bottom clamp, where both answers coincide
// and the check would pass whatever the code did.
//
// Both paint paths are measured, because they anchor through different code.
// The cold deep link is the one that had this wrong: the forms live outside the
// log and are rendered after it, so the opening anchor ran when there was no
// form in the document yet and settled on the message.
const askGap = () => page.evaluate(() => {
  const form = document.querySelector('#ask form')
  if (form === null) return null
  const header = document.querySelector('header')
  const under = header === null || header.hidden ? 0 : header.getBoundingClientRect().bottom
  return form.getBoundingClientRect().top - under
})

for (const route of ['deep link', 'tap']) {
  if (route === 'deep link') {
    await page.goto(`${origin}/s/waiting-on-you`, { waitUntil: 'domcontentloaded' })
  } else {
    await page.goto(`${origin}/sessions?open=ws-dmwg`, { waitUntil: 'domcontentloaded' })
    const waiting = page.locator('#log a[href="/s/waiting-on-you"]')
    await waiting.waitFor({ timeout: 20000 })
    await page.evaluate(() => { document.scrollingElement.scrollTop = 300 })
    await waiting.click()
  }
  await page.waitForSelector('#ask form', { timeout: 20000 })
  await page.waitForTimeout(2500)
  // The anchor has to be genuinely reachable, or the clamp is what is being
  // measured rather than the rule.
  check(`the ${route} session waiting on a question can reach that question`,
    await offset() < await scrollable() - 4,
    `scrollTop ${Math.round(await offset())} of ${Math.round(await scrollable())}`)
  check(`the ${route} opens at the top of the waiting question`,
    Math.abs(await askGap()) < 4, `${Math.round(await askGap())}px from the header`)
  // The point of preferring the form: the message it would otherwise have
  // chosen is above the fold now.
  check(`the ${route} put the waiting question above the newest message`,
    await gap() < -4, `newest message ${Math.round(await gap())}px from the header`)
}

// The anchor survives the header growing underneath it.
//
// The worktree line above the title arrives with the session list, so on a cold
// deep link it lands *after* the transcript. Un-hiding it grows the sticky
// header from one line to two, and because the header paints over the top of
// the document that buries the first line of whatever was anchored on by
// exactly the height it gained — the offset having been perfectly correct at
// the moment it was written.
//
// Measured once the name is actually on screen rather than on a timer. This is
// the case no fixture caught on its own: it appears only when a session reports
// a checkout, which is the ordinary state of every real session.
await page.goto(`${origin}/s/waiting-on-you`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#ask form', { timeout: 20000 })
const named = () => page.evaluate(() => {
  const where = document.getElementById('where')
  return where !== null && !where.hidden && where.textContent.trim() !== ''
})
// The worktree line becoming visible is the reflow this guards against.
await page.waitForFunction(() => {
  const where = document.getElementById('where')
  return where !== null && !where.hidden && where.textContent.trim() !== ''
}, undefined, { timeout: 20000 })
await page.waitForTimeout(2500)
check('the worktree name is on screen, so the header has taken its full height', await named())
check('the anchor still holds the question under the grown header',
  Math.abs(await askGap()) < 4, `${Math.round(await askGap())}px from the header`)

// The reader always outranks the anchor.
//
// The loop tolerates a band of drift so the browser's own scroll anchoring is
// not mistaken for the reader, and that band must stay far too small to swallow
// a real gesture. A scroll to the top during the opening frames has to stick.
await page.goto(`${origin}/s/waiting-on-you`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
await page.waitForTimeout(120)
await page.evaluate(() => { document.scrollingElement.scrollTop = 0 })
await page.waitForTimeout(2500)
check('a reader who scrolls during the opening frames keeps control',
  await offset() < 200, `scrollTop ${Math.round(await offset())}`)

// Earlier conversation above the anchor must be reachable: the whole point of
// landing mid-document is that history is above the reader, not lost.
await page.goto(`${origin}/s/still-working`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
await page.waitForTimeout(2500)
const anchored = await offset()
await page.evaluate(() => { document.scrollingElement.scrollTop = 0 })
check('earlier conversation above the anchor is reachable',
  anchored > 0 && await offset() < 4, `anchored at ${Math.round(anchored)}`)

check('no page errors through the whole run', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nall passed' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
