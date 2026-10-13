// A reconnect never draws a prompt a second time, in a real browser.
//
// The bug this exists for: the stream re-stated focus on every reconnect with
// the cursor the session was *opened* at rather than where the transcript stood.
// The server answered with every event since the open, and the page appended
// them under the copies already on screen — the same prompt and its work once
// more per dropped connection.
//
//   PORT=7799 node mock/server.js
//   node scripts/verify-reconnect-no-repeat.mjs [origin]   default http://127.0.0.1:7799

import { webkit } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7799'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await webkit.launch()
// Service worker blocked: headless WebKit here stops answering once one installs.
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' })
const page = await context.newPage()
await page.goto(origin + '/s/billing')
await page.waitForSelector('#log article')

// `tools` makes the mock agent keep working for a couple of seconds, so events
// land while the page is offline. That is the case that drew the copy: with
// nothing new, the stale read's frame was no newer than the page and was dropped.
const text = 'tools reconnect probe ' + Date.now()
// Through the form rather than a locator click, which hangs in this box's WebKit.
await page.evaluate(t => {
  document.getElementById('box').value = t
  document.getElementById('composer').requestSubmit()
}, text)
await page.waitForFunction(t => [...document.querySelectorAll('#log article[data-client-id]')]
  .some(el => el.textContent.includes(t)), text, { timeout: 20_000 })
// The phone sleeping mid-turn: the page goes hidden, the stream closes after its
// grace period, and it opens a fresh one on wake while the agent kept working.
const hide = hidden => page.evaluate(h => {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => h })
  document.dispatchEvent(new Event('visibilitychange'))
}, hidden)
await hide(true)
await page.waitForTimeout(21_000)
await hide(false)
// The rows under this run's prompt. The mock is shared across runs and every
// run's reply reads the same, so earlier runs' rows must not be counted.
const after = () => {
  const prompt = [...document.querySelectorAll('#log article[data-role="user"]')].find(el => el.textContent.includes(window.probe))
  const rows = []
  for (let el = prompt?.nextElementSibling; el != null; el = el.nextElementSibling) rows.push(el)
  return rows
}
await page.evaluate(t => { window.probe = t }, text)
await page.waitForFunction(`(${after})().some(el => !el.dataset.partial && el.textContent.includes('That is five calls.'))`, undefined, { timeout: 30_000 })
await page.waitForTimeout(2_000)

const counts = await page.evaluate(`(() => {
  const rows = (${after})()
  return {
    prompt: [...document.querySelectorAll('#log article[data-role="user"]')].filter(el => el.textContent.includes(window.probe)).length,
    reply: rows.filter(el => el.dataset.partial === undefined && el.textContent.includes('That is five calls.')).length,
    tools: rows.filter(el => el.dataset.tools !== undefined).map(el => el.textContent),
    seqs: [...document.querySelectorAll('#log article[data-seq]')].map(el => el.dataset.seq),
  }
})()`)
check('the prompt is drawn once after a reconnect', counts.prompt === 1, `drawn ${counts.prompt} times`)
check('its reply is drawn once after a reconnect', counts.reply === 1, `drawn ${counts.reply} times`)
const dupes = counts.seqs.filter((seq, i) => counts.seqs.indexOf(seq) !== i)
check('its tool calls are one line', counts.tools.length === 1, `drawn as: ${counts.tools.join(' | ')}`)
check('no seq is on screen twice', dupes.length === 0, `repeated: ${dupes.join(', ')}`)

await browser.close()
process.exit(failures.length === 0 ? 0 : 1)
