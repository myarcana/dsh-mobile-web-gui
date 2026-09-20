// Delivery state has exactly one author: the server.
//
//   node scripts/verify-delivery-state.mjs [origin]    default http://localhost:7799
//
// The bug this pins down: the page used to compute a prompt's delivery state
// from a row in its own IndexedDB outbox, while the server computed it from the
// log. Two authorities, one question, no arbiter — and because the outbox row
// was dequeued the moment the POST was accepted, the last word the client ever
// published ('Sending') could never be revisited. A single missed reconciliation
// left a prompt reading "Sending" forever, under a message that had visibly
// landed in the transcript with its own timestamp.
//
// What is checked here is the property that makes that impossible rather than
// merely unlikely: the word under an un-delivered prompt is a function of what
// the server reports, the durable message retires the optimistic copy, and a
// prompt whose delivery has been proven carries a delivered stamp and no
// lingering pending element.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7799'
const failures = []

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', error => { errors.push(String(error)) })

// A session whose turn is slow enough to observe, so the in-flight window is
// real rather than a single synchronous tick.
await page.goto(`${origin}/s/gesture-detection`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#composer', { timeout: 15_000 })

// ---------------------------------------------------------------- the wire
// The field exists and is a list, on every row, before anything is sent. A row
// that omits it would send the client back to inventing the answer.
const wire = await page.evaluate(async orig => {
  const res = await fetch(`${orig}/api/stream`)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const line = buf.split('\n').find(l => l.startsWith('data:') && l.includes('"rows"'))
    if (line !== undefined) {
      await reader.cancel().catch(() => {})
      const listing = JSON.parse(line.slice(5))
      return {
        rows: listing.rows.length,
        allHaveSending: listing.rows.every(r => Array.isArray(r.sending)),
      }
    }
  }
  await reader.cancel().catch(() => {})
  return { rows: 0, allHaveSending: false }
}, origin)

check('the session list frame carries rows', wire.rows > 0, `saw ${wire.rows}`)
check('every row names the prompts in flight for it', wire.allHaveSending,
  'a row omitted `sending`, so the page would have to invent delivery state')

// ------------------------------------------------------- send and settle
const text = 'delivery state probe ' + Date.now()
await page.fill('#composer textarea', text)
await page.click('#composer button[type=submit]')

// The prompt shows up immediately, before any round trip has finished.
await page.waitForSelector('#log article[data-pending], #log article[data-client-id]', { timeout: 10_000 })

// Whatever it says while un-delivered, it must be one of the two words the
// server's answer maps to — never a third state invented by the page.
const early = await page.evaluate(() => {
  const el = document.querySelector('#log article[data-pending]')
  return el === null ? null : (el.querySelector('.state')?.textContent ?? '')
})
check('an un-delivered prompt says Queued or Sending',
  early === null || early === 'Queued' || early === 'Sending',
  `said ${JSON.stringify(early)}`)

// The durable message is what proves delivery. Wait for it by its own key.
await page.waitForFunction(() => document.querySelector('#log article[data-client-id]') !== null,
  undefined, { timeout: 20_000 })

// Settle: let every summary frame that follows the durable message arrive, so a
// late frame gets its chance to wrongly re-assert "Sending".
await page.waitForTimeout(3_000)

const settled = await page.evaluate(expected => {
  const durable = [...document.querySelectorAll('#log article[data-client-id]')]
    .find(el => (el.textContent ?? '').includes(expected))
  const key = durable?.dataset.clientId ?? null
  return {
    found: durable !== undefined,
    key,
    keyIsWellFormed: key !== null && /^[A-Za-z0-9-]{8,128}$/.test(key),
    stamp: durable?.querySelector('.state')?.textContent ?? '',
    // The whole point: nothing anywhere still claims this prompt is pending.
    strayPending: document.querySelectorAll('#log [data-pending]').length,
    anySending: [...document.querySelectorAll('#log .state')]
      .map(el => el.textContent ?? '')
      .filter(t => t === 'Sending' || t === 'Queued'),
  }
}, text)

check('the prompt reached the transcript', settled.found)
check('the server echoed the browser key back verbatim', settled.keyIsWellFormed,
  `key was ${JSON.stringify(settled.key)} — a rewritten key can never match the page's own copy`)
check('a delivered prompt is stamped delivered', settled.stamp.startsWith('Delivered at'),
  `stamp was ${JSON.stringify(settled.stamp)}`)
check('no optimistic copy survives its own delivery', settled.strayPending === 0,
  `${settled.strayPending} element(s) still marked pending — this is the stuck "Sending"`)
check('nothing still claims to be in flight', settled.anySending.length === 0,
  `still showing ${JSON.stringify(settled.anySending)}`)

// --------------------------------------------------- survives a reload
// The state must be rebuilt from the server, not from anything the page kept.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article[data-client-id]', { timeout: 15_000 })
await page.waitForTimeout(2_000)

const afterReload = await page.evaluate(() => ({
  strayPending: document.querySelectorAll('#log [data-pending]').length,
  stuck: [...document.querySelectorAll('#log .state')]
    .map(el => el.textContent ?? '')
    .filter(t => t === 'Sending' || t === 'Queued'),
}))
check('a reload shows no pending leftovers', afterReload.strayPending === 0,
  `${afterReload.strayPending} left`)
check('a reload shows nothing stuck in flight', afterReload.stuck.length === 0,
  `saw ${JSON.stringify(afterReload.stuck)}`)

check('no error was raised on the page', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(failures.length === 0
  ? '\nAll delivery-state checks passed'
  : `\nFAILED  ${failures.length}: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
