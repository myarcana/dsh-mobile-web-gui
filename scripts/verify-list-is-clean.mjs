// The session list holds the list, and nothing else.
//
// Leaving a session must not leave its transcript hanging off the bottom of
// `/sessions`. The list and the transcript share one `#log` element, and the
// list's repaint reconciles its children by `data-key` — it removes only the
// keyed rows it did not claim this pass. Transcript rows carry no key at all,
// so they are invisible to that sweep and survive it unless the view clears
// the log on the way out.
//
// That is a silent failure: the list still renders correctly at the top, and
// the leftovers sit below the fold where nothing draws attention to them. So
// this counts what is actually in the log rather than looking at the screen.
//
// Every route out of a session is checked, because they do not share a path:
// the in-app link calls the router, the back button goes through popstate, and
// a cold load of the list never renders a transcript at all.
//
//   LONG=1 PORT=7803 node mock/server.js
//   node scripts/verify-list-is-clean.mjs [origin]   default http://127.0.0.1:7803
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7803'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
// Transport failures are the sandbox this runs in, not the page.
const transport = /ERR_NETWORK_CHANGED|ERR_NETWORK_IO_SUSPENDED|ERR_CONNECTION_RESET|net::ERR_FAILED/
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => {
  if (message.type() !== 'error') return
  if (transport.test(message.text())) return
  errors.push(message.text())
})

// What the log holds. A transcript row is an `article`; the list is built from
// keyed rows and headings, so any article at all on the list is a leftover.
const inspect = () => page.evaluate(() => {
  const log = document.getElementById('log')
  return {
    articles: log.querySelectorAll('article').length,
    rows: log.children.length,
    unkeyed: [...log.children].filter(node => node.dataset.key === undefined)
      .map(node => node.tagName.toLowerCase() + (node.id === '' ? '' : '#' + node.id)).slice(0, 6),
  }
})

// A session with a long transcript, so a leak would be unmistakable.
const session = '/s/long-scrollback'

// Route one: the in-app "Sessions" link, which goes through the router.
await page.goto(origin + session, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
const loaded = await inspect()
check('the session itself renders a transcript', loaded.articles > 100, `${loaded.articles} articles`)

await page.locator('a[href="/sessions"]').first().click()
await page.waitForFunction(() => location.pathname === '/sessions', null, { timeout: 20000 })
// The list paints synchronously, but a summary frame can repaint it immediately
// after. Waiting lets any late paint land before the log is counted.
await page.waitForTimeout(2000)
const viaLink = await inspect()
check('no transcript survives onto the list via the Sessions link',
  viaLink.articles === 0, `${viaLink.articles} articles left, unkeyed: ${viaLink.unkeyed.join(', ')}`)
check('the list itself is rendered', viaLink.rows > 0, `${viaLink.rows} rows`)

// Route two: the back button, which goes through popstate rather than the
// router's own navigation.
await page.goto(`${origin}/sessions?open=ws-dmwg`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector(`#log a[href="${session}"]`, { timeout: 20000 })
await page.locator(`#log a[href="${session}"]`).click()
await page.waitForSelector('#log article', { timeout: 20000 })
await page.waitForTimeout(1500)
await page.goBack()
await page.waitForFunction(() => location.pathname === '/sessions', null, { timeout: 20000 })
await page.waitForTimeout(2000)
const viaBack = await inspect()
check('no transcript survives onto the list via the back button',
  viaBack.articles === 0, `${viaBack.articles} articles left, unkeyed: ${viaBack.unkeyed.join(', ')}`)
check('the list is rendered after going back', viaBack.rows > 0, `${viaBack.rows} rows`)

// The whole module has to be intact for any of this to mean anything. A view
// missing an export leaves the list empty and throws on every frame, which is
// what made the transcript appear to leak in the first place.
check('no page errors through the whole run', errors.length === 0, errors.slice(0, 3).join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nall passed' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
