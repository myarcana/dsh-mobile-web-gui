// Going back to the list must land where the reader left it.
//
//   node scripts/verify-back-scroll.mjs [origin]   default http://127.0.0.1:7778
//
// The bug this exists for: routing to the list blanked the transcript log
// before the list was painted into it, so for one synchronous moment the
// document was a single viewport tall. The browser clamps the scroll offset to
// the new maximum the instant that happens — including the offset it is
// restoring for a popped history entry — and refilling the list does not undo
// the clamp. The reader pressed Back and arrived at the top.
//
// So this scrolls the list, opens a session, presses Back, and asks where it
// landed. It also measures the document height across the repaint directly,
// because a pass that came from the list simply being short would prove
// nothing.
//
// Exit code is the answer: 0 sound, 1 broken, 2 unreachable.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = (process.argv[2] ?? 'http://127.0.0.1:7778').replace(/\/+$/, '')

let failed = false
function check (what, ok, detail = '') {
  if (!ok) failed = true
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : `  — ${detail}`}`)
}

let browser
try {
  browser = await chromium.launch()
} catch (error) {
  console.error(`cannot launch a browser: ${error.message}`)
  process.exit(2)
}

const page = await browser.newPage({ viewport: { width: 390, height: 780 } })
const errors = []
page.on('pageerror', error => errors.push(String(error)))

const offset = () => page.evaluate(() => document.scrollingElement.scrollTop)
const height = () => page.evaluate(() => document.scrollingElement.scrollHeight)

// A list long enough to have somewhere to scroll to. Which groups are open
// lives in the URL, so every workspace is asked for open by id — the ids come
// from the running server rather than a fixture name, so this works against
// whatever box it is pointed at.
const listing = await (await fetch(`${origin}/api/sessions`)).json()
const open = listing.groups.map(group => group.id).join(' ')
await page.goto(`${origin}/sessions?open=${encodeURIComponent(open)}`, { waitUntil: 'domcontentloaded' })
const link = page.locator('#log a[href^="/s/"]').first()
try {
  await link.waitFor({ timeout: 20000 })
} catch {
  console.error('no session rows on the list; is the fixture corpus loaded?')
  await browser.close()
  process.exit(2)
}

check('the list is longer than the viewport', await height() > 900, `${Math.round(await height())}px tall`)

// Watch the document height across the next repaint. A scroll listener is
// banned in this app and would not see a synchronous collapse anyway, so the
// log is observed directly for mutations and the height sampled on each one.
await page.evaluate(() => {
  window.__heights = []
  const el = document.getElementById('log')
  new MutationObserver(() => {
    window.__heights.push(document.scrollingElement.scrollHeight)
  }).observe(el, { childList: true })
})

await page.evaluate(() => { document.scrollingElement.scrollTop = 600 })
// Let the list settle at the new offset before reading it: this list is live,
// and a summary frame arriving mid-measurement would be read as a scroll change.
await page.waitForTimeout(400)
const left = await offset()
check('the list was scrolled before leaving', left > 400, `scrollTop ${Math.round(left)}`)

// Tap a row that is actually on screen at this offset. Picking one blind and
// clicking it makes the driver scroll it into view first, which moves the very
// offset this test exists to preserve — the run then measures the driver's
// scrolling rather than the app's.
const href = await page.evaluate(() => {
  for (const a of document.querySelectorAll('#log a[href^="/s/"]')) {
    const box = a.getBoundingClientRect()
    if (box.top >= 0 && box.bottom <= innerHeight) return a.getAttribute('href')
  }
  return null
})
check('a session row is on screen at this offset', href !== null)
if (href === null) { await browser.close(); process.exit(1) }
await page.locator(`#log a[href="${href}"]`).first().click()
await page.waitForSelector('#log article', { timeout: 20000 })
check('the tap opened a session', new URL(page.url()).pathname === href, `${page.url()} vs ${href}`)
// Forward navigation still belongs at the top: this is the behaviour
// verify-open-at-top.mjs owns, restated here so a fix for Back cannot quietly
// trade one for the other.
check('the opened session is at the top', await offset() < 4, `scrollTop ${Math.round(await offset())}`)

// What the outgoing entry actually carries. This is the assertion that speaks
// for Firefox, and the reason the rest of this file is not enough on its own:
// Blink re-clamps a restored offset after layout settles, so it lands on the
// right answer even when the recorded one was wrong, and the bug is invisible
// in a Chromium run. Gecko restores once and keeps what it was given. So the
// recorded position is checked directly rather than inferred from where this
// browser happened to end up.
const pinned = await page.evaluate(() => new Promise(resolve => {
  addEventListener('popstate', event => resolve(event.state === null ? null : event.state.top), { once: true })
  history.back()
}))
check('the outgoing entry recorded the true position',
  typeof pinned === 'number' && Math.abs(pinned - left) < 40,
  `entry carries ${pinned}, reader left at ${Math.round(left)}`)

await link.waitFor({ timeout: 20000 })
check('Back returned to the list', new URL(page.url()).pathname === '/sessions')

// The repaint must never have shrunk the document to a viewport. This is the
// mechanism itself rather than its symptom, so it fails loudly even on a day
// when the browser's restoration happens to paper over it.
const seen = await page.evaluate(() => window.__heights ?? [])
const collapsed = seen.filter(h => h < 900)
check('the document never collapsed during the repaint',
  collapsed.length === 0, `saw ${collapsed.map(Math.round).join(', ') || 'none'}`)

// Restoration is the browser's, and it may land a frame or two after the
// repaint. Give it room before reading, so this measures the resting position
// rather than the race.
await page.waitForTimeout(600)
const back = await offset()
check('Back landed where the reader left the list',
  Math.abs(back - left) < 40, `scrollTop ${Math.round(back)}, left at ${Math.round(left)}`)

check('no page errors through the whole run', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
process.exit(failed ? 1 : 0)
