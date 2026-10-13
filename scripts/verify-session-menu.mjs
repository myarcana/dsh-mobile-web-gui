// The session title menu, measured in a real engine.
//
// Claims the markup alone cannot settle:
//
//  1. Tapping the title on a session opens a menu, and the URL becomes
//     `/s/<id>/menu` — a view change with its own address.
//  2. That URL is a deep link: opened cold in a fresh tab it shows the same
//     menu, over the same session's transcript.
//  3. The menu offers Archive, named for its session, without repeating the
//     session's name as a heading — the title it drops from already says it.
//  4. The back button closes it and leaves the reader on the session, not on
//     the list — the menu is a screen, so the way out is the way back.
//  5. Escape and a tap outside close it the same way.
//  6. Archiving from the menu removes the session from the list and lands the
//     reader on the list, with no way back into the hidden session.
//
// A menu is a position on screen and a URL is browser state; neither is visible
// in HTML, so this needs a browser.
//
//   node scripts/verify-session-menu.mjs [origin]   default http://localhost:7778
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7778'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// The last claim archives the session it runs against, so this makes its own
// rather than hiding one somebody is using. Pass an id as the second argument to
// measure a specific session instead — the destructive step is then skipped.
const given = process.argv[3]
let targetId = given
if (targetId === undefined) {
  const made = await (await fetch(`${origin}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({})
  })).json()
  targetId = made.sessionId
  console.log(`made session ${targetId} to measure against; it is archived at the end`)
}

// The list is what names a session, so the row is read from it rather than
// assumed. A session made moments ago appears immediately.
const listing = await (await fetch(`${origin}/api/sessions`)).json()
const row = (listing.rows ?? []).find(candidate => candidate.id === targetId)
if (row === undefined) {
  console.error(`session ${targetId} is not in the listing, so there is no title to tap`)
  await browser.close()
  process.exit(2)
}

await page.goto(`${origin}/s/${encodeURIComponent(row.id)}`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#title', { timeout: 15_000 })

// 1. The title opens the menu, and the URL says so.
check('the title is a real control', await page.$eval('#title', el => el.tagName) === 'BUTTON')
check('the menu is shut before the title is tapped', await page.$eval('#menu', el => el.hidden))
await page.click('#title')
await page.waitForSelector('#menu:not([hidden])', { timeout: 5_000 })
check('tapping the title opens the menu', await page.$eval('#menu', el => !el.hidden))
check(
  'opening the menu changes the URL',
  new URL(page.url()).pathname === `/s/${encodeURIComponent(row.id)}/menu`,
  page.url()
)

// 3. It offers archiving, without repeating the title it drops from.
check('the menu does not repeat the session name', await page.$('#menu h2') === null)
const labels = await page.$$eval('#menu button', els => els.map(el => el.textContent))
check('the menu offers archiving', labels.some(label => label.includes('Archive')), labels.join(' | '))
check('nothing in the menu is shouted', labels.every(label => label !== label.toUpperCase() || label.length < 2), labels.join(' | '))

// Every control is a real tap target.
const small = await page.$$eval('#menu button', els =>
  els.filter(el => el.getBoundingClientRect().height < 44).map(el => `${el.textContent}:${Math.round(el.getBoundingClientRect().height)}px`))
check('every menu control is at least 44px tall', small.length === 0, small.join(', '))

// The menu is pinned to the viewport, not parked in the document flow.
check('the menu is pinned to the viewport', await page.$eval('#menu', el => getComputedStyle(el).position === 'fixed'))

// 4. Back closes it and leaves the reader on the session.
await page.goBack()
await page.waitForSelector('#menu[hidden]', { state: 'attached', timeout: 5_000 })
check('the back button closes the menu', await page.$eval('#menu', el => el.hidden))
check(
  'closing the menu leaves the reader on the session',
  new URL(page.url()).pathname === `/s/${encodeURIComponent(row.id)}`,
  page.url()
)
check('the transcript is still there behind it', await page.$eval('#log', el => el.children.length > 0))

// 5. Escape closes it.
await page.click('#title')
await page.waitForSelector('#menu:not([hidden])', { timeout: 5_000 })
await page.keyboard.press('Escape')
await page.waitForSelector('#menu[hidden]', { state: 'attached', timeout: 5_000 })
check('Escape closes the menu', await page.$eval('#menu', el => el.hidden))

// ...and so does a tap outside it.
await page.click('#title')
await page.waitForSelector('#menu:not([hidden])', { timeout: 5_000 })
await page.mouse.click(20, 700)
await page.waitForSelector('#menu[hidden]', { state: 'attached', timeout: 5_000 })
check('a tap outside closes the menu', await page.$eval('#menu', el => el.hidden))

// 2. The menu URL is a deep link: a cold load shows the same screen.
const fresh = await browser.newPage({ viewport: { width: 390, height: 844 } })
await fresh.goto(`${origin}/s/${encodeURIComponent(row.id)}/menu`, { waitUntil: 'domcontentloaded' })
await fresh.waitForSelector('#menu:not([hidden])', { timeout: 15_000 })
check('the menu URL opens the menu in a fresh browser', await fresh.$eval('#menu', el => !el.hidden))
check('the deep link paints the session behind the menu', await fresh.$eval('#log', el => el.children.length > 0))
await fresh.waitForSelector('#menu button.danger', { timeout: 15_000 })
const freshName = await fresh.$eval('#menu button.danger', el => el.getAttribute('aria-label'))
check('the deep-linked menu names the session once the list lands', freshName === `Archive ${row.title}`, `showed "${freshName}"`)
await fresh.close()

// 6. Archiving hides the session and lands on the list.
await page.click('#title')
await page.waitForSelector('#menu:not([hidden])', { timeout: 5_000 })
const archive = given === undefined ? await page.$('#menu button.danger') : null
if (given !== undefined) {
  console.log('SKIP  archiving — measuring a session that was given, not made here')
} else if (archive === null) {
  check('archiving is offered on this server', false, 'no archive control, so the rest cannot be measured')
} else {
  await archive.click()
  await page.waitForFunction(() => location.pathname === '/sessions', undefined, { timeout: 10_000 })
  check('archiving lands the reader on the session list', new URL(page.url()).pathname === '/sessions')
  check('the menu is gone once the session is archived', await page.$eval('#menu', el => el.hidden))
  // The archived session is no longer offered.
  await page.waitForTimeout(500)
  const stillListed = await page.$$eval('#log a.row', (els, id) => els.some(el => el.getAttribute('href') === `/s/${id}`), row.id)
  check('the archived session is no longer in the list', !stillListed)
  // Back must not return to the hidden session.
  await page.goBack()
  await page.waitForTimeout(500)
  check(
    'the back button does not return to the archived session',
    !new URL(page.url()).pathname.startsWith(`/s/${encodeURIComponent(row.id)}`),
    page.url()
  )
}

await browser.close()

if (failures.length > 0) {
  console.error(`\n${failures.length} failure(s): ${failures.join(', ')}`)
  process.exit(1)
}
console.log('\nOK  the session title menu behaves')
