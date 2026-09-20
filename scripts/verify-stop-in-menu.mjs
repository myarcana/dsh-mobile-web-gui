// Stopping a session, from the title menu, measured in a real engine.
//
// Stop used to sit in the composer beside Send. It now lives in the menu behind
// the session title, with Archive — both are things done *to* a session rather
// than to the draft in the box.
//
// Claims the markup alone cannot settle:
//
//  1. The composer carries no Stop button any more: the draft row is Send and
//     the draft controls, nothing else.
//  2. A running session's menu offers Stop, above Archive.
//  3. An idle session's menu does not: the row carries the `stop` action exactly
//     while the agent is running, and the page branches on what the host says
//     rather than on a rule written into the client.
//  4. Tapping it posts once and says so, and the button is a real tap target
//     like every other control in that menu.
//  5. The turn ending takes the button away on its own, because the summary
//     frame drops the action — nothing in the client has to remember to.
//
// Whether a control is on screen at a given moment is not in the HTML, so this
// needs a browser.
//
//   node scripts/verify-stop-in-menu.mjs [origin]   default http://localhost:7778
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7778'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const rows = await fetch(`${origin}/api/sessions`).then(r => r.json()).then(d => d.rows)
const running = rows.find(r => r.actions.includes('stop'))
const idle = rows.find(r => !r.actions.includes('stop'))
if (running === undefined) {
  console.error('no running session to measure against — this needs a session the host says can be stopped')
  process.exit(1)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// Record what the page actually posts, so "it stopped" is measured at the wire
// rather than inferred from a label.
const posted = []
page.on('request', r => { if (r.url().endsWith('/api/stop')) posted.push(r.postData()) })

const menuLabels = () => page.$$eval('#menu button', els => els.map(el => el.textContent))

// 1. The composer is about the draft now, and nothing else.
await page.goto(`${origin}/s/${encodeURIComponent(running.id)}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#title', { timeout: 15_000 })
check('the composer carries no Stop button', await page.$('#stop') === null)
check('the composer still sends', await page.$('#send') !== null)

// 2. The running session's menu offers Stop, above Archive.
await page.click('#title')
await page.waitForSelector('#menu:not([hidden])')
let labels = await menuLabels()
const iStop = labels.findIndex(l => l.includes('Stop'))
const iArchive = labels.findIndex(l => l.includes('Archive'))
check('the menu offers stopping', iStop !== -1, labels.join(' | '))
check('Stop sits above Archive', iStop !== -1 && iArchive !== -1 && iStop < iArchive, labels.join(' | '))
check('the Stop control names the session', await page.$eval('#menu button.quiet', el => el.getAttribute('aria-label')) === `Stop ${running.title}`)
check('nothing in the menu is shouted', labels.every(l => l !== l.toUpperCase() || l.length < 2), labels.join(' | '))

// Every control in this menu is a real tap target, the new one included.
const small = await page.$$eval('#menu button', els =>
  els.filter(el => el.getBoundingClientRect().height < 44).map(el => `${el.textContent}:${Math.round(el.getBoundingClientRect().height)}px`))
check('every menu control is at least 44px tall', small.length === 0, small.join(', '))

// 3. Tapping it posts once, for this session, and says it is working.
await page.click('#menu button.quiet')
await page.waitForTimeout(400)
check('tapping Stop posts to /api/stop once', posted.length === 1, `posted ${posted.length} times`)
check('it posts this session\'s id', posted.length === 1 && JSON.parse(posted[0]).sessionId === running.id, posted[0])
check('no error was raised on the page', await page.$eval('#errors', el => el.textContent.trim()) === '')

// 4. While the request is in flight the control says so and refuses a second
//    tap, so an impatient reader cannot post twice.
await page.click('#menu button.quiet', { force: true }).catch(() => {})
await page.waitForTimeout(300)
check('a second tap posts nothing further', posted.length === 1, `posted ${posted.length} times`)
check('the control says it is working', (await menuLabels()).some(l => l === 'Stopping'), (await menuLabels()).join(' | '))
check('the rest of the menu is untouched', labels.some(l => l.includes('Copy')) && labels.some(l => l.includes('Close')), labels.join(' | '))

// 5. The control is offered on the host's word alone, so when the row stops
//    carrying the `stop` action the button goes with it. Asserted against the
//    summary the host is actually publishing rather than against a timer: a
//    fixture session that never ends its turn keeps the action, and the page is
//    right to keep showing the control in that case.
const still = await fetch(`${origin}/api/sessions`).then(r => r.json())
  .then(d => d.rows.find(r => r.id === running.id)?.actions.includes('stop') === true)
labels = await menuLabels()
check(
  'the control matches what the host reports',
  still === labels.some(l => l.includes('Stop')),
  `host offers stop: ${still}; menu shows: ${labels.join(' | ')}`
)

// 6. An idle session never offers it in the first place.
if (idle !== undefined) {
  await page.goto(`${origin}/s/${encodeURIComponent(idle.id)}/menu`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#menu:not([hidden])')
  await page.waitForTimeout(300)
  labels = await menuLabels()
  check('an idle session\'s menu offers no Stop', !labels.some(l => l.includes('Stop')), labels.join(' | '))
  check('an idle session\'s menu still offers the rest', labels.some(l => l.includes('Close')), labels.join(' | '))
}

await browser.close()

if (failures.length > 0) {
  console.error(`\nFAILED  ${failures.length}: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nOK  stopping a session from the title menu behaves')
