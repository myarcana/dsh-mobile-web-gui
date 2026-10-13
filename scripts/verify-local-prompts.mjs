// Prompts this device holds are drawn on the page, with an accurate state,
// whatever happened to the page in between.
//
//   node scripts/verify-local-prompts.mjs [origin]    default http://localhost:7788 (the mock)
//
// The bug this pins down: the outbox dropped a prompt the moment its POST was
// accepted, and drew nothing at boot. So a prompt queued offline vanished from
// the screen on reload, and one accepted but not yet logged vanished on reload
// even with a connection — the reader was left to guess whether it was sent.

import { webkit as chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7788'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
// Service workers blocked: headless WebKit crashes on registration, and the
// worker plays no part in sending.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
const page = await context.newPage()
const errors = []
// With the worker blocked, notification setup has no registration to read.
page.on('pageerror', error => { if (!/pushManager|\/api\/send/.test(String(error))) errors.push(String(error)) })

const local = () => page.evaluate(() => [...document.querySelectorAll('#log [data-pending]')]
  .map(el => ({ text: el.querySelector('p').textContent, state: el.querySelector('.state')?.textContent ?? '' })))

async function send (text) {
  await page.fill('#composer textarea', text)
  await page.click('#composer button[type=submit]')
}

await page.goto(`${origin}/s/billing`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#composer', { timeout: 15_000 })
await page.waitForTimeout(1000)

// ------------------------------------------------ queued offline, then reload
await context.setOffline(true)
const run = Date.now()
await send('offline first ' + run)
await page.waitForTimeout(100)
await send('offline second ' + run)
await page.waitForTimeout(300)
let rows = await local()
check('two offline prompts are drawn', rows.length === 2, JSON.stringify(rows))
check('an offline prompt says it is queued on this device',
  rows.every(r => r.state.startsWith('Queued on this device')), JSON.stringify(rows))

// Reload while still offline is not possible (no page to load), so the page is
// reopened with the network back but the send route blocked: the rows must be
// drawn from storage, still queued, before anything is sent.
// Blocked before the network returns, or the `online` event sends them first.
await page.route('**/api/send', route => route.abort())
await context.setOffline(false)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#composer', { timeout: 15_000 })
await page.waitForTimeout(800)
rows = await local()
check('queued prompts are drawn again after a reload', rows.length === 2, JSON.stringify(rows))
check('they are drawn in the order they were typed',
  rows.length === 2 && rows[0].text.startsWith('offline first') && rows[1].text.startsWith('offline second'),
  JSON.stringify(rows))
check('they still say queued', rows.every(r => r.state.startsWith('Queued on this device')), JSON.stringify(rows))

// ------------------------------------------------------ released, delivered
await page.unroute('**/api/send')
await page.evaluate(() => dispatchEvent(new Event('online')))
await page.waitForFunction(() => document.querySelectorAll('#log [data-pending]').length === 0, undefined, { timeout: 15_000 })
const order = await page.evaluate(run => [...document.querySelectorAll('#log article[data-client-id]')]
    .map(el => el.querySelector('p').textContent).filter(t => t.endsWith(' ' + run)), run)
check('both landed in the transcript, in order',
  order.length === 2 && order[0].startsWith('offline first') && order[1].startsWith('offline second'), JSON.stringify(order))

// --------------------------------- accepted but not logged, then page closed
await send('slowlog probe ' + Date.now())
await page.waitForFunction(() => [...document.querySelectorAll('#log [data-pending] .state')]
  .some(el => el.textContent.startsWith('Sent at')), undefined, { timeout: 10_000 })
rows = await local()
check('an accepted prompt says it was sent and is not in the transcript yet',
  rows.length === 1 && /^Sent at .+ — not in the transcript yet$/.test(rows[0].state), JSON.stringify(rows))
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#composer', { timeout: 15_000 })
await page.waitForTimeout(300)
rows = await local()
check('an accepted prompt is drawn again after a reload', rows.length === 1 && rows[0].state.startsWith('Sent'),
  JSON.stringify(rows))
await page.waitForFunction(() => document.querySelectorAll('#log [data-pending]').length === 0, undefined, { timeout: 15_000 })
check('it is retired once the transcript shows it', true)

// ------------------------------------------- nothing left behind in storage
const stored = await page.evaluate(() => new Promise(resolve => {
  const open = indexedDB.open('web-gui')
  open.onsuccess = () => {
    const request = open.result.transaction('outbox').objectStore('outbox').getAll()
    request.onsuccess = () => resolve(request.result.length)
  }
}))
check('the outbox is empty once everything is delivered', stored === 0, `${stored} row(s) left`)
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1000)
rows = await local()
check('a reload after delivery draws no local prompts', rows.length === 0, JSON.stringify(rows))

check('no error was raised on the page', errors.length === 0, errors.join(' | '))
await browser.close()
if (failures.length > 0) process.exit(1)
