// Typing must not move the transcript.
//
// The report: every key press scrolls the log, even while the box is still one
// row and its height is not changing. That rules out the grow-the-box path,
// which only writes a height when the text wraps onto a new line, so this
// measures the two things separately — the box's own height and the document's
// scroll offset — across a run of keystrokes, and fails if the second moves
// while the first stands still.
//
//   LONG=1 PORT=7799 node mock/server.js
//   node scripts/verify-typing-scroll.mjs [origin]   default http://127.0.0.1:7799
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

await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))

const box = page.locator('#box')
await box.focus()
// Settle: focusing opens the action row, which moves the document legitimately. The measurement starts after that has landed.
await page.waitForTimeout(400)

const read = () => page.evaluate(() => ({
  top: document.scrollingElement.scrollTop,
  height: document.getElementById('box').getBoundingClientRect().height
}))

// Park mid-transcript, so movement in either direction is visible. A reader at
// the very bottom could not show an upward drift.
await page.evaluate(() => { document.scrollingElement.scrollTop = 600 })
await page.waitForTimeout(150)

const start = await read()
const samples = []
// Short single-line text: at 390px wide this cannot wrap, so the box height is
// expected to hold still for the whole run.
for (const ch of 'hello world') {
  await page.keyboard.type(ch, { delay: 60 })
  samples.push(await read())
}

const moved = samples.filter(s => Math.abs(s.top - start.top) > 1)
const grew = samples.filter(s => Math.abs(s.height - start.height) > 1)

check('the box height does not change while typing one line',
  grew.length === 0, `${grew.length} of ${samples.length} samples changed height`)
check('the transcript does not scroll while typing',
  moved.length === 0,
  `${moved.length} of ${samples.length} keystrokes moved the page; ` +
  `start ${Math.round(start.top)} → ${samples.map(s => Math.round(s.top)).join(', ')}`)

// The case the report is actually about: typing while the agent is streaming a
// reply into the same transcript. Every token is an append, and an append is
// where the page has a reason to move. The guard in `toBottom` is supposed to
// decline all of them while the composer holds focus.
await page.evaluate(() => { document.getElementById('box').value = '' })
await box.focus()
await box.fill('trigger a reply')
await page.locator('#composer button[type=submit]').click()
// Sending deliberately blurs the box and scrolls to the bottom. Wait for the
// stream to be under way, then put the reader back in the middle and type.
await page.waitForTimeout(600)
await box.focus()
await page.evaluate(() => { document.scrollingElement.scrollTop = 600 })
await page.waitForTimeout(150)

const liveStart = await read()
const live = []
for (const ch of 'typing while it streams') {
  await page.keyboard.type(ch, { delay: 40 })
  live.push(await read())
}
const liveMoved = live.filter(s => Math.abs(s.top - liveStart.top) > 1)
const liveGrew = live.filter(s => Math.abs(s.height - liveStart.height) > 1)

check('the transcript does not scroll while typing during a live stream',
  liveMoved.length === 0,
  `${liveMoved.length} of ${live.length} keystrokes moved the page; ` +
  `start ${Math.round(liveStart.top)} → ${live.map(s => Math.round(s.top)).join(', ')}`)
check('the box height is stable during the live-stream run',
  liveGrew.length === 0, `${liveGrew.length} of ${live.length} samples changed height`)

await browser.close()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
