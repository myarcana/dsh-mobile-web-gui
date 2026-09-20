// The two claims that are only true in a browser: a collapsed group opens where
// it was tapped, and a row says what its session is doing.
//
//   node scripts/verify-state.mjs [origin]      default http://localhost:7788
//
// Both were reported as broken together. The first is a URL bug that only shows
// when the same heading text repeats across workspaces — the "Unknown worktree"
// bucket, which is synthetic and carries one id everywhere — so the check drives
// several workspaces rather than one.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7788'
const failures = []

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })

// Open every workspace, so the worktree level is on screen to be tapped.
await page.evaluate(() => {
  for (const b of document.querySelectorAll('#log h2.group .disclose')) {
    if (b.getAttribute('aria-expanded') === 'false') b.click()
  }
})
await page.waitForTimeout(300)

// ------------------------------------------------------------------ anchors
// A duplicate id is what made a tap resolve to a different element than the one
// under the finger. Every anchored heading on the page must be unique.
const dupes = await page.evaluate(() => {
  const seen = new Map()
  for (const el of document.querySelectorAll('#log [id]')) {
    seen.set(el.id, (seen.get(el.id) ?? 0) + 1)
  }
  return [...seen].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`)
})
check('every heading anchor on the list is unique', dupes.length === 0, dupes.join(', '))

// ----------------------------------------------------------------- toggling
// Tap a shut worktree and assert that *that* heading opened. The scroll position
// is asserted too: the reported symptom was the page jumping to the top.
// Everything here is done by name rather than through an element handle: a live
// server streams listings that repaint the whole list, which detaches any handle
// taken a moment earlier.
const label = await page.evaluate(() => {
  const el = document.querySelector('#log h3.tree .disclose[aria-expanded="false"]')
  return el === null ? null : (el.querySelector('.disclose span')?.textContent ?? '')
})
if (label === null) {
  check('a shut worktree exists to toggle', false, 'none on this fixture')
} else {
  // Scroll it into view first, so "did the page jump to the top?" is a question
  // with a meaningful answer.
  await page.evaluate(title => {
    [...document.querySelectorAll('#log h3.tree')]
      .find(el => (el.querySelector('.disclose span')?.textContent ?? '') === title)
      ?.scrollIntoView({ block: 'center' })
  }, label)
  await page.waitForTimeout(150)
  const before = await page.evaluate(() => window.scrollY)
  // Tap the FIRST shut heading with this label and remember which one that was,
  // by its heading's anchor id. A name is not unique on this page — the
  // synthetic "Unknown worktree" bucket exists once per workspace that has one —
  // so re-finding it by name afterwards can answer about a different heading
  // entirely, which reads as "the tap did nothing" when it worked perfectly.
  const tapped = await page.evaluate(title => {
    const heading = [...document.querySelectorAll('#log h3.tree')]
      .find(el => (el.querySelector('.disclose')?.getAttribute('aria-expanded') === 'false')
        && (el.querySelector('.disclose span')?.textContent ?? '') === title)
    if (heading === undefined) return null
    heading.querySelector('.disclose').click()
    return heading.id
  }, label)
  await page.waitForTimeout(400)

  const after = await page.evaluate(() => window.scrollY)
  const open = await page.evaluate(id => {
    if (id === null) return 'not found'
    // The very heading that was tapped, by its own anchor, so the answer cannot
    // come from a namesake elsewhere on the page.
    const el = document.getElementById(id)?.querySelector('.disclose')
    return el?.getAttribute('aria-expanded') ?? 'gone'
  }, tapped)

  check(`tapping "${label}" expands that worktree`, open === 'true', `aria-expanded=${open}`)
  check('tapping a worktree does not jump the page to the top',
    !(before > 50 && after === 0), `scrollY ${before} -> ${after}`)
}

// ------------------------------------------------------- keys with a space
// A worktree whose name holds a space must open like any other. The list of
// open groups is space separated, so such a key used to split in half on the
// way back out of the URL and match nothing — the group could then be neither
// opened nor removed from the list. The synthetic "Unknown worktree" bucket is
// always in this shape, which is why it alone was stuck shut.
const spaced = await page.evaluate(() => {
  const h = [...document.querySelectorAll('#log h3.tree')]
    .find(el => (el.querySelector('.disclose span')?.textContent ?? '').includes(' '))
  return h === undefined ? null : { id: h.id, title: h.querySelector('.disclose span').textContent }
})
if (spaced === null) {
  console.log('      no worktree with a space in its name on this fixture; skipped')
} else {
  check('a worktree named with a space keeps its key out of the separator',
    !spaced.id.includes(' '), `id="${spaced.id}"`)

  const opened = await page.evaluate(async title => {
    const pick = () => [...document.querySelectorAll('#log h3.tree')]
      .find(el => (el.querySelector('.disclose span')?.textContent ?? '') === title)
    const was = pick().querySelector('.disclose').getAttribute('aria-expanded')
    pick().querySelector('.disclose').click()
    await new Promise(r => setTimeout(r, 600))
    const now = pick().querySelector('.disclose').getAttribute('aria-expanded')
    // Shut it again: the old bug could write the key but never take it back out.
    pick().querySelector('.disclose').click()
    await new Promise(r => setTimeout(r, 600))
    return { was, now, back: pick().querySelector('.disclose').getAttribute('aria-expanded') }
  }, spaced.title)

  check(`"${spaced.title}" changes state when tapped`, opened.was !== opened.now,
    `${opened.was} -> ${opened.now}`)
  check(`"${spaced.title}" can be put back as it was`, opened.back === opened.was,
    `${opened.now} -> ${opened.back}`)
}

// The same, starting from a URL that carries a hash, which is how a deep link
// lands the reader here. Dropping the hash on toggle is what scrolled the page.
const wsId = await page.evaluate(() => document.querySelector('#log h2.group')?.id ?? '')
if (wsId !== '') {
  await page.goto(`${origin}/sessions#${encodeURIComponent(wsId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#log h2.group', { timeout: 15_000 })
  await page.evaluate(() => document.querySelector('#log h2.group .disclose')?.click())
  await page.waitForTimeout(300)
  const kept = await page.evaluate(() => location.hash)
  check('toggling keeps the hash the reader arrived with', kept === `#${wsId}`, `hash="${kept}"`)
}

// --------------------------------------------------------------- tree tails
// The last leaf under a worktree ends the branch: nothing may carry on below it.
// Both lines are asserted because they come from different places — the row's
// own ::after continues the worktree's trunk, and its background gradient
// carries the workspace's — and a row with an Archive button arrives wrapped, so
// the flags that end them are easy to hang on the wrapper by mistake and lose.
await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })
await page.evaluate(() => {
  for (const b of document.querySelectorAll('#log .disclose')) {
    if (b.getAttribute('aria-expanded') === 'false') b.click()
  }
})
await page.waitForTimeout(600)

const tails = await page.evaluate(() => {
  const out = []
  // Group the painted rows by the worktree heading above them, so "the last one"
  // is asked of each branch rather than of the page.
  let branch = null
  for (const el of document.querySelectorAll('#log h3.tree, #log a.row')) {
    if (el.tagName === 'H3') { branch = []; out.push(branch); continue }
    branch?.push(el)
  }
  return out.filter(rows => rows.length > 0).map(rows => {
    const last = rows[rows.length - 1]
    const size = getComputedStyle(last).backgroundSize
    return {
      flagged: last.hasAttribute('data-last'),
      // The wrapper must never be the thing carrying the flag.
      onWrapper: last.parentElement?.hasAttribute('data-last') === true,
      trunkBelow: getComputedStyle(last, '::after').display !== 'none',
      middles: rows.slice(0, -1).every(r => !r.hasAttribute('data-last')),
      // The workspace trunk is a background gradient, so "does it run the whole
      // row?" is read off its height. A last leaf must stop at its own arm; a
      // percentage here means it ran to the bottom edge instead.
      outerSize: size,
      middlesOuterFull: rows.slice(0, -1)
        .every(r => getComputedStyle(r).backgroundSize.includes('100%')),
    }
  })
})

check('every branch marks its last leaf', tails.every(t => t.flagged),
  `${tails.filter(t => !t.flagged).length} of ${tails.length} branches unmarked`)
check('the end-of-branch flag is on the row, not its wrapper',
  tails.every(t => !t.onWrapper))
check('no line continues below a last leaf', tails.every(t => !t.trunkBelow),
  `${tails.filter(t => t.trunkBelow).length} of ${tails.length} branches trailed a line`)
check('rows that are not last keep their connecting line', tails.every(t => t.middles))
check('the workspace trunk still passes rows that are not last',
  tails.every(t => t.middlesOuterFull))

// A worktree that is showing sessions carries its own trunk down to the first of
// them. Without it a row's arm began at the row's top edge with nothing above,
// so every connector read as a vertical line floating in the gutter. A heading
// with no rows under it must not draw one, or the stub points at nothing.
const stubs = await page.evaluate(() => {
  const out = []
  for (const h of document.querySelectorAll('#log h3.tree')) {
    // Whatever leaf hangs below the heading. An open worktree now always opens
    // with its "New session" control, and that control is a leaf of the tree
    // like a session row is — it draws the same elbow — so the heading's stub
    // has to reach it. A shut worktree has no sibling of any of these kinds.
    const next = h.nextElementSibling
    const hasRows = next !== null
      && (next.classList.contains('rowline') || next.classList.contains('row')
        || next.classList.contains('starter'))
    out.push({
      title: h.querySelector('.disclose span')?.textContent ?? '',
      hasRows,
      draws: getComputedStyle(h).backgroundImage !== 'none',
    })
  }
  return out
})

check('a worktree showing sessions joins down to the first of them',
  stubs.filter(s => s.hasRows).every(s => s.draws),
  stubs.filter(s => s.hasRows && !s.draws).map(s => s.title).join(', '))
check('a worktree showing no sessions draws no stub',
  stubs.filter(s => !s.hasRows).every(s => !s.draws),
  stubs.filter(s => !s.hasRows && s.draws).map(s => s.title).join(', '))

// ------------------------------------------------------------------- states
// Every row says which of the three states it is in, and says it in words as
// well as colour.
await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })
await page.evaluate(() => {
  for (const b of document.querySelectorAll('#log .disclose')) {
    if (b.getAttribute('aria-expanded') === 'false') b.click()
  }
})
await page.waitForTimeout(400)

const rows = await page.evaluate(() => {
  const out = []
  for (const row of document.querySelectorAll('#log a.row')) {
    const dot = row.querySelector('.dot')
    out.push({
      state: row.dataset.state ?? null,
      hasDot: dot !== null,
      title: dot?.getAttribute('title') ?? null,
      colour: dot === null ? null : getComputedStyle(dot).backgroundColor,
      border: dot === null ? null : getComputedStyle(dot).borderTopColor,
      animated: dot === null ? null : getComputedStyle(dot).animationName,
    })
  }
  return out
})

check('the list rendered some sessions', rows.length > 0, `${rows.length} rows`)
check('every session row carries a state', rows.every(r => r.state !== null))
check('every session row draws its dot', rows.every(r => r.hasDot))
check('every dot names its state in words', rows.every(r => r.title !== null && r.title !== ''))
check('every state is one of the three', rows.every(r => ['done', 'working', 'asking'].includes(r.state)),
  [...new Set(rows.map(r => r.state))].join(', '))

const working = rows.filter(r => r.state === 'working')
const asking = rows.filter(r => r.state === 'asking')
const done = rows.filter(r => r.state === 'done')
console.log(`      states seen: ${done.length} finished, ${working.length} working, ${asking.length} asking`)

// The dot is drawn differently per state, which is the whole point: a reader
// must be able to tell them apart without reading.
if (working.length > 0) {
  check('a working session spins', working.every(r => r.animated === 'spin'),
    working.map(r => r.animated).join(', '))
  check('a working session is a ring, not a filled dot',
    working.every(r => r.colour === 'rgba(0, 0, 0, 0)'), working.map(r => r.colour).join(', '))
}
if (done.length > 0) {
  check('a finished session is green and still',
    done.every(r => r.colour === 'rgb(46, 125, 50)' && r.animated === 'none'),
    done.map(r => `${r.colour}/${r.animated}`).join(', '))
}
if (asking.length > 0) {
  check('a session waiting on the reader is amber and still',
    asking.every(r => r.colour === 'rgb(178, 106, 0)' && r.animated === 'none'),
    asking.map(r => `${r.colour}/${r.animated}`).join(', '))
}

await browser.close()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
