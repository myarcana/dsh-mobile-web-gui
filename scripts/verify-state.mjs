// The claims about this list that are only true in a browser: every heading is
// uniquely anchored, the tree lines end where the branches do, and a row says
// what its session is doing.
//
//   node scripts/verify-state.mjs [origin]      default http://localhost:7788
//
// Nothing here opens anything first. The list does not collapse: every
// workspace, worktree and session is on screen from the first paint.

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

// ------------------------------------------------------- names with a space
// A worktree name may hold a space — the synthetic "Unknown worktree" bucket
// always does — and its anchor must still be a single usable id rather than
// something a space splits in half.
const spaced = await page.evaluate(() => {
  const h = [...document.querySelectorAll('#log h3.tree')]
    .find(el => (el.querySelector('.disclose span')?.textContent ?? '').includes(' '))
  return h === undefined ? null : { id: h.id, title: h.querySelector('.disclose span').textContent }
})
if (spaced === null) {
  console.log('      no worktree with a space in its name on this fixture; skipped')
} else {
  check('a worktree named with a space keeps the space out of its anchor',
    !spaced.id.includes(' '), `id="${spaced.id}"`)
  // It is showing, like every other worktree: a name with a space in it used to
  // be the one kind that could get stuck shut.
  const shows = await page.evaluate(title => {
    const h = [...document.querySelectorAll('#log h3.tree')]
      .find(el => (el.querySelector('.disclose span')?.textContent ?? '') === title)
    let node = h?.nextElementSibling ?? null
    while (node !== null && !node.matches('h2.group, h3.tree')) {
      if (node.matches('a.row, .rowline, .starter')) return true
      node = node.nextElementSibling
    }
    return false
  }, spaced.title)
  check(`"${spaced.title}" is open like every other worktree`, shows)
}

// A deep link into a group lands on it, and the hash it arrived with stays put.
const wsId = await page.evaluate(() => document.querySelector('#log h2.group')?.id ?? '')
if (wsId !== '') {
  await page.goto(`${origin}/sessions#${encodeURIComponent(wsId)}`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#log h2.group', { timeout: 15_000 })
  await page.waitForTimeout(300)
  const kept = await page.evaluate(() => location.hash)
  check('a deep link into a group keeps its hash', kept === `#${wsId}`, `hash="${kept}"`)
}

// --------------------------------------------------------------- tree tails
// The last leaf under a worktree ends the branch: nothing may carry on below it.
// Both lines are asserted because they come from different places — the row's
// own ::after continues the worktree's trunk, and its background gradient
// carries the workspace's — and a row with an Archive button arrives wrapped, so
// the flags that end them are easy to hang on the wrapper by mistake and lose.
await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })
await page.waitForTimeout(300)

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
    // Whatever leaf hangs below the heading. A worktree always leads with its
    // "New session" control, and that control is a leaf of the tree like a
    // session row is — it draws the same elbow — so the heading's stub has to
    // reach it.
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
await page.waitForTimeout(300)

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
