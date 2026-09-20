// Opening a session lands the reader at the top of it, never at the bottom.
//
// Two routes reach a transcript and both are measured here, because they paint
// through different paths: a cold deep link adopts the server's own first paint,
// while an in-app tap repaints from cache and then takes the tail over the
// stream. Either one landing at the bottom is the bug this guards.
//
// The tail is the subtle half. It arrives moments after the paint as a replace
// frame, and the append path decides whether to follow it by asking whether the
// reader is already near the bottom. Parked at the top that has to answer no, so
// the position is measured again after the transcript has settled rather than
// only on the frame the navigation happened in.
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

const offset = () => page.evaluate(() => document.scrollingElement.scrollTop)
// Proof the transcript is actually taller than the viewport. On a document that
// fits, top and bottom are the same number and every assertion below passes for
// no reason at all.
const scrollable = () => page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight - el.clientHeight
})

// A cold deep link: the server rendered the transcript and the client adopted it.
await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))
check('the deep-linked transcript is longer than the viewport',
  await scrollable() > 200, `${Math.round(await scrollable())}px of scroll`)
check('a deep link opens at the top', await offset() < 4, `scrollTop ${Math.round(await offset())}`)

// Let the tail land. The replace frame is what used to drag the page back down,
// and it arrives after the first paint, so a position read only on load would
// miss it entirely.
await page.waitForTimeout(2500)
check('the deep link is still at the top once the tail lands',
  await offset() < 4, `scrollTop ${Math.round(await offset())}`)
check('no page errors while the tail landed', errors.length === 0, errors.slice(0, 2).join(' | '))

// An in-app navigation: the list, then a tap into a session.
// The list opens as collapsed workspace headings, so a session link only exists
// once its group is expanded. Which group is expanded lives in the URL, so the
// one holding the long fixture is asked for directly — a short transcript could
// not tell top from bottom, and the expansion is a deep link like any other.
await page.goto(`${origin}/sessions?open=ws-dmwg`, { waitUntil: 'domcontentloaded' })
const target = page.locator('#log a[href="/s/long-scrollback"]')
await target.waitFor({ timeout: 20000 })
// Scroll the list down first, so "at the top" cannot be inherited from a page
// that simply never moved. This is the case that used to land at the bottom.
await page.evaluate(() => { document.scrollingElement.scrollTop = 300 })
const href = await target.getAttribute('href')
await target.click()
await page.waitForSelector('#log article', { timeout: 20000 })
check('the tap opened a session', new URL(page.url()).pathname === href, `${page.url()} vs ${href}`)
check('a tapped session opens at the top', await offset() < 4, `scrollTop ${Math.round(await offset())}`)

await page.waitForTimeout(2500)
// Only meaningful on a transcript with somewhere else to be. A session shorter
// than the viewport would pass this whatever the code did.
check('the tapped transcript is longer than the viewport',
  await scrollable() > 200, `${Math.round(await scrollable())}px of scroll`)
check('the tapped session is still at the top once the tail lands',
  await offset() < 4, `scrollTop ${Math.round(await offset())}`)

// Following the live end must still work: a reader sitting at the bottom is
// carried along by new messages. Removing the open-time jump must not have
// removed that, so it is proven rather than assumed.
await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
await page.evaluate(() => {
  const el = document.scrollingElement
  el.scrollTop = el.scrollHeight - el.clientHeight
})
const atBottom = await page.evaluate(() => {
  const el = document.scrollingElement
  return el.scrollHeight - el.scrollTop - el.clientHeight < 120
})
check('a reader can still reach the live end', atBottom)

check('no page errors through the whole run', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nall passed' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
