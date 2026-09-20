// Walk a long transcript back to its first message, in a real browser.
//
// The scrollback claims are only true on a rendered page: that the link is
// offered at all, that a prepend does not throw the reader to the top, and that
// tapping it repeatedly reaches the start of the log and then stops. None of
// that is visible in the markup, so this drives an engine at a phone viewport
// and measures the result.
//
//   LONG=1 PORT=7799 node mock/server.js
//   node scripts/verify-scrollback.mjs [origin]      default http://127.0.0.1:7799
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
// Every bound a backwards read asked the server for, in order. The walk is only
// correct if this strictly decreases: a bound that stands still is a tap that
// re-fetched the chunk it already had.
const requested = []
page.on('request', request => {
  const match = /\/api\/s\/[^/]+\/before\/(\d+)$/.exec(new URL(request.url()).pathname)
  if (match !== null) requested.push(Number(match[1]))
})

// Not networkidle: the page holds an SSE stream open for the life of the
// session, so the network is never idle and waiting for it always times out.
await page.goto(`${origin}/s/long-scrollback`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))

const link = page.locator('#earlier')
check('the link is offered on a long transcript', await link.count() === 1)
check('the link says "Older messages"', (await link.textContent()) === 'Older messages')
check('the link is the first thing in the log',
  await page.evaluate(() => document.getElementById('log').firstElementChild?.id === 'earlier'))
const box = await link.boundingBox()
check('the link meets the 44px tap target', box.height >= 44, `${Math.round(box.height)}px`)

const before = await page.evaluate(() => document.querySelectorAll('#log article').length)
// Park somewhere with content above and below, then prove that content does not
// move when history lands above it.
await page.evaluate(() => { document.scrollingElement.scrollTop = 500 })
// Park where a reader who wants older messages actually is: scrolled near the
// top, with the button on screen and content below it. Tapping a button that is
// off-screen is not something anyone can do, and scrolling to reach it would be
// a scroll of its own, masking the movement being measured.
//
// Then tag one specific row and follow that exact node. `#log article` is a
// moving target: after a prepend it names a different element, so measuring it
// would compare two unrelated rows and report drift nobody would ever see.
// Scroll so the button is on screen with the transcript below it.
//
// The page opens at the top and the button is the first thing in the log, so
// this settles at an offset of 0 — which is exactly where a reader who wants
// older messages stands, and the only place the button is tappable: the sticky
// header covers the top of the page, and any scroll down slides the button
// underneath it.
//
// Clear of the sticky header, not merely inside the viewport: the header covers
// the top of the page, so a button at `top: 0` is on screen and still untappable.
// The press below has to land on the button itself to prove anything.
await page.evaluate(() => {
  const header = document.querySelector('header').getBoundingClientRect().height
  document.getElementById('earlier').scrollIntoView({ block: 'start' })
  document.scrollingElement.scrollTop -= header + 8
})
await page.waitForFunction(() => {
  const box = document.getElementById('earlier').getBoundingClientRect()
  const header = document.querySelector('header').getBoundingClientRect().bottom
  return box.top >= header && box.bottom <= window.innerHeight
}, null, { timeout: 5000 })
const anchorTop = await page.evaluate(() => {
  const row = [...document.querySelectorAll('#log article')].find(
    candidate => candidate.getBoundingClientRect().top > 100)
  row.id = 'anchor-probe'
  return row.getBoundingClientRect().top
})
const scrollBefore = await page.evaluate(() => document.scrollingElement.scrollTop)

// A real press at the button's current position. `locator.click()` scrolls the
// element into view first, which is itself a scroll and would mask the very
// thing being measured here.
const target = await link.boundingBox()
await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2)
await page.mouse.down()
await page.mouse.up()
await page.waitForFunction(n => document.querySelectorAll('#log article').length > n, before, { timeout: 15000 })
const after = await page.evaluate(() => document.querySelectorAll('#log article').length)
check('older messages are prepended', after > before, `${before} -> ${after}`)
check('the link stays at the top after a load',
  await page.evaluate(() => document.getElementById('log').firstElementChild?.id === 'earlier'))

const scrollAfter = await page.evaluate(() => document.scrollingElement.scrollTop)
// The offset is expected to stay put rather than grow.
//
// This reads like a weaker claim than it is. The always-visible rule already
// puts every prompt on the first paint, including the session's very first, so
// the reader standing at the top of a long transcript is looking at message
// zero with the button just above it. What a backwards read fetches is the tool
// traffic *between* those prompts, and that lands below the row being held, not
// above it — the document grows downwards and the correct offset does not move.
//
// So the real proof that the reader kept their place is the anchor check below,
// which follows one tagged row across the insert. This one guards the other
// direction: the page must not wander off somewhere new on its own.
check('the reader is not thrown elsewhere', Math.abs(scrollAfter - scrollBefore) < 4,
  `${scrollBefore} -> ${scrollAfter}`)
const drift = await page.evaluate(
  top => Math.abs(document.getElementById('anchor-probe').getBoundingClientRect().top - top), anchorTop)
check('the reader keeps their place', drift < 4, `drifted ${Math.round(drift)}px`)

// The same claim from deep inside the transcript, where a backwards read really
// does land content above the viewport and the offset has to grow to compensate.
// The tap above is taken at the top of the page, where there is nothing above
// the reader to displace them; this is the case the correction exists for.
{
  await page.evaluate(() => { document.scrollingElement.scrollTop = 4000 })
  const deep = await page.evaluate(() => {
    const row = [...document.querySelectorAll('#log article')].find(
      candidate => candidate.getBoundingClientRect().top > 100)
    row.id = 'deep-probe'
    return {
      top: row.getBoundingClientRect().top,
      offset: document.scrollingElement.scrollTop,
      height: document.scrollingElement.scrollHeight,
    }
  })
  const rows = await page.evaluate(() => document.querySelectorAll('#log article').length)
  // Dispatched rather than pressed. The button sits at the top of the document,
  // far above a reader standing at 4000px, and `locator.click()` would scroll it
  // into view first — a scroll of its own, which is precisely the movement being
  // measured. Dispatching the event leaves the page exactly where it is.
  await page.evaluate(() => {
    document.getElementById('earlier').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await page.waitForFunction(n => document.querySelectorAll('#log article').length > n, rows, { timeout: 15000 })
  const moved = await page.evaluate(top => {
    const row = document.getElementById('deep-probe')
    return {
      drift: Math.abs(row.getBoundingClientRect().top - top),
      offset: document.scrollingElement.scrollTop,
      grew: document.scrollingElement.scrollHeight,
    }
  }, deep.top)
  // The row the reader was looking at has not moved on screen. Whether the
  // offset itself had to change to achieve that depends on where the fetched
  // rows were seated — this transcript keeps every prompt on the first paint,
  // so a backwards read fills in tool traffic below them as often as above —
  // and either way the reader seeing the same thing is the claim that matters.
  check('a deep prepend keeps the reader in place', moved.drift < 4, `drifted ${Math.round(moved.drift)}px`)
  check('a deep prepend actually added content', moved.grew > deep.height,
    `${Math.round(deep.height)} -> ${Math.round(moved.grew)}`)
}

// Keep tapping until the log is exhausted. The guard is generous enough for the
// fixture and small enough that a link which never retires fails the run.
let guard = 0
while (await page.locator('#earlier').count() === 1 && guard < 10) {
  guard += 1
  const n = await page.evaluate(() => document.querySelectorAll('#log article').length)
  await page.locator('#earlier').click()
  await page.waitForFunction(
    x => document.querySelectorAll('#log article').length > x || document.getElementById('earlier') === null,
    n, { timeout: 15000 },
  ).catch(() => {})
}
const total = await page.evaluate(() => document.querySelectorAll('#log article').length)
check('the link retires at the start of the log', await page.locator('#earlier').count() === 0)
check('the whole conversation is reachable', total >= 999, `${total} articles`)
check('the first message of the session is on screen',
  (await page.evaluate(() => document.querySelector('#log article p')?.textContent))
    === 'Question number 0 in a very long conversation.',
  await page.evaluate(() => document.querySelector('#log article p')?.textContent))
check('no page errors through the whole walk', errors.length === 0, errors.slice(0, 2).join(' | '))

// Every tap asked for a strictly older bound than the one before it. This is the
// regression that made the link stop working after the first press: the bound was
// read back off the page, and a chunk that rendered no frame left it standing, so
// each later tap re-fetched the identical chunk and the log was replaced in place
// rather than extended.
let monotonic = true
for (let i = 1; i < requested.length; i += 1) {
  if (requested[i] >= requested[i - 1]) monotonic = false
}
check('each tap reads strictly further back', monotonic, requested.join(' -> '))

// The transcript is one chronological list. The always-visible rule puts prompts
// from the start of the log on screen before the work behind them is read, so
// history fetched later belongs *below* rows already painted; a plain prepend
// would leave seq 1600 sitting between seq 2 and seq 1.
const order = await page.evaluate(() => {
  const seqs = [...document.querySelectorAll('#log article')]
    .map(a => Number(a.dataset.seq)).filter(Number.isSafeInteger)
  let bad = null
  for (let i = 1; i < seqs.length; i += 1) {
    if (seqs[i] < seqs[i - 1] && bad === null) bad = `${seqs[i - 1]} then ${seqs[i]} at row ${i}`
  }
  return bad
})
check('the transcript stays in order', order === null, order ?? '')

// No row is drawn twice. A backwards read that redrew the prompts the first paint
// already keeps would double them above the copy the reader is looking at.
const doubled = await page.evaluate(() => {
  const seen = new Map()
  for (const a of document.querySelectorAll('#log article[data-seq]')) {
    const seq = a.dataset.seq
    seen.set(seq, (seen.get(seq) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([seq]) => seq).slice(0, 3)
})
check('no row is drawn twice', doubled.length === 0, doubled.join(', '))

// The reader's own words and the questions put to them survive truncation. On a
// session whose turns are mostly tool traffic, a purely positional window is
// spent on work and drops them, so this opens a transcript deliberately built
// that way and measures the very first paint, with no tap at all.
await page.goto(`${origin}/s/buried-prompts`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
const buried = await page.evaluate(() => {
  const arts = [...document.querySelectorAll('#log article')]
  const text = arts.map(a => a.textContent)
  const asked = arts.filter(a => a.dataset.role === 'asked')
  return {
    prompts: [...new Set(text.flatMap(t => t.match(/Buried prompt number \d/g) ?? []))].length,
    asked: asked.length,
    // The answer is not a row of its own: it is the tick on the question's own
    // form. So "the answer survived" is asked of that row rather than of a
    // second one, and it is the chosen option being ticked that proves it.
    ticked: asked.filter(a => a.querySelector('input.pick:checked') !== null).length,
  }
})
check('every prompt is on the first paint, however buried', buried.prompts === 6, `${buried.prompts} of 6`)
check('every question put to the reader is on the first paint', buried.asked === 6, `${buried.asked} of 6`)
check('every answer the reader gave is on the first paint', buried.ticked === 6, `${buried.ticked} of 6`)
check('no page errors on the buried transcript', errors.length === 0, errors.slice(0, 2).join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nall passed' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
