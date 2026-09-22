// A reader who has walked back through history keeps that progress across a
// whole-tail replace, in a real browser.
//
// The bug this exists for: the backwards walk's bound was restated on every
// paint, including the replace frame a reconnect or a resumed stream brings. A
// replace carries the *tail window's* edge, which sits far above where the walk
// has already read to, so adopting it moved the bound backwards — and the next
// tap re-requested a range the reader already had. Those re-fetched rows then
// folded into a second run line beside the first, which is what filled the
// scrollback with duplicates.
//
// `verify-scrollback.mjs` never caught it because an uninterrupted walk never
// takes a replace frame mid-flight. This drives that interruption directly.
//
//   LONG=1 PORT=7799 node mock/server.js
//   node scripts/verify-scrollback-resume.mjs [origin]   default http://127.0.0.1:7799
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7799'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

// Every bound a backwards read asked for, in order.
const requested = []
page.on('request', request => {
  const match = /\/api\/s\/[^/]+\/before\/(\d+)$/.exec(new URL(request.url()).pathname)
  if (match !== null) requested.push(Number(match[1]))
})

await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))

// The module's real URL, read from the page's own import map: every module is
// digest-stamped, so the specifier cannot be hard-coded here.
const earlierUrl = await page.evaluate(() => {
  const map = JSON.parse(document.querySelector('script[type=importmap]').textContent)
  return map.imports.earlier
})
check('the earlier module is named in the import map', typeof earlierUrl === 'string', String(earlierUrl))

// Tap "Older messages" and wait for rows to land.
//
// A tap that fetches only rows the log already holds paints nothing, so the
// count never grows. That is not a hang to crash on — it is the regression
// itself, and it has to be reported as a named failure rather than a stack
// trace, so `grew` is returned instead of thrown.
async function tap () {
  const rows = await page.evaluate(() => document.querySelectorAll('#log article').length)
  await page.evaluate(() => {
    document.getElementById('earlier')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  try {
    await page.waitForFunction(n => document.querySelectorAll('#log article').length > n, rows, { timeout: 15000 })
    return true
  } catch (error) {
    return false
  }
}

const firstPainted = await tap()
const secondPainted = await tap()
check('the walk paints on every tap before the interruption', firstPainted && secondPainted)
check('the walk made progress before the interruption', requested.length >= 2, requested.join(' -> '))
const reached = requested[requested.length - 1]

// What a replace frame would restate: the tail window's own edge, as the server
// reports it for a fresh whole-tail read.
const restated = await page.evaluate(async () => {
  const response = await fetch('/api/s/long-scrollback/before/999999')
  return (await response.json()).oldest
})
check('the tail window sits above where the reader walked to', restated > reached,
  `tail edge ${restated} vs walked to ${reached}`)

// The interruption itself: a reconnect re-sends the tail, and the page routes
// that replace frame to `earlier.offer(frame.more, frame.oldest)` (app.js:167).
await page.evaluate(async ([url, oldest]) => {
  const earlier = await import(url)
  earlier.offer(true, oldest)
}, [earlierUrl, restated])

const askedBefore = requested.length
const grew = await tap()
const askedAfter = requested[requested.length - 1]

check('the tap after the interruption reads further back, not back over old ground',
  askedAfter < reached, `walked to ${reached}, then asked for ${askedAfter}`)
// A tap that fetched only rows already on screen paints nothing. The reader
// sees a button that does nothing while the phone pays for the transfer.
check('the tap after the interruption actually painted something', grew,
  'the read returned only rows the log already held')
check('the interrupted walk issued exactly one new read',
  requested.length === askedBefore + 1, requested.join(' -> '))

// The visible consequence: no row drawn twice.
const duplicates = await page.evaluate(() => {
  const seen = new Map()
  const dupes = []
  for (const article of document.querySelectorAll('#log article[data-seq]')) {
    const seq = article.dataset.seq
    const count = (seen.get(seq) ?? 0) + 1
    seen.set(seq, count)
    if (count === 2) dupes.push(seq)
  }
  return dupes
})
check('no row is drawn twice after the interruption', duplicates.length === 0,
  `duplicated seqs: ${duplicates.slice(0, 10).join(', ')}`)

// And no duplicated folded run lines, which is how the reader actually saw it.
const runDupes = await page.evaluate(() => {
  const seen = new Map()
  const dupes = []
  for (const line of document.querySelectorAll('#log article[data-tools]')) {
    const key = `${line.dataset.seq}-${line.dataset.last}`
    const count = (seen.get(key) ?? 0) + 1
    seen.set(key, count)
    if (count === 2) dupes.push(key)
  }
  return dupes
})
check('no folded run line is drawn twice', runDupes.length === 0,
  `duplicated runs: ${runDupes.slice(0, 10).join(', ')}`)

check('no page errors through the interrupted walk', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nall passed' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
