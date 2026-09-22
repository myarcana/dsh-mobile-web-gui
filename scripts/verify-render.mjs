// Render the two things that are only true in a browser, and assert them.
//
// The hierarchy and the newline fix are both *layout* claims: the HTML can be
// perfectly correct and the screen still wrong, because indentation comes from a
// stylesheet and collapsed newlines are invisible in the markup. So this drives a
// real engine at a phone viewport and measures the result.
//
//   node scripts/verify-render.mjs [origin]      default http://localhost:7799
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7799'
const shots = new URL('../.fixtures/', import.meta.url).pathname
const failures = []

/**
 * Record a pass or a failure without stopping the run: one broken assertion
 * should not hide the state of the others.
 */
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
// A small phone, because this GUI is mobile-first and indentation that only
// survives on a desktop viewport is not indentation that survives.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// -------------------------------------------------------------- always open
// A bare /sessions shows the whole tree. Nothing on this page collapses, so
// every workspace, every worktree and every session is on screen from the
// first paint without the reader tapping anything.
// Never `networkidle`: this page holds an SSE stream open for the life of the
// session, so it is never idle by design. Wait for the content instead.
await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })

const open = await page.evaluate(() => ({
  workspaces: document.querySelectorAll('#log h2.group').length,
  worktrees: document.querySelectorAll('#log h3.tree').length,
  rows: document.querySelectorAll('#log a.row').length,
  // Whatever is left of the old disclosure must not still be a control: no
  // button role, no tab stop, no open/shut state for anything to read.
  controls: document.querySelectorAll(
    '#log [aria-expanded], #log .disclose[role="button"], #log .disclose[tabindex]').length,
}))
check('workspaces render on a bare /sessions', open.workspaces > 0)
check('worktrees show without tapping anything', open.worktrees > 0,
  `${open.worktrees} worktrees were on screen`)
check('sessions show without tapping anything', open.rows > 0,
  `${open.rows} rows were on screen`)
check('no heading is a disclosure control', open.controls === 0,
  `${open.controls} element(s) still carried open/shut state`)

// Every worktree is open, including a crowded one — more than three siblings
// and more than two sessions — which used to start shut.
const trees = await page.evaluate(() => [...document.querySelectorAll('#log h3.tree')]
  .map(el => (el.querySelector('.disclose span')?.textContent ?? '').trim()))
const hasRowsUnder = async title => await page.evaluate(name => {
  const heading = [...document.querySelectorAll('#log h3.tree')]
    .find(el => (el.querySelector('.disclose span')?.textContent ?? '').trim() === name)
  if (heading === undefined) return null
  // Walk forward to the next heading: whatever lies between is what this
  // worktree is currently showing.
  let node = heading.nextElementSibling
  while (node !== null && !node.matches('h2.group, h3.tree')) {
    if (node.matches('a.row') || node.querySelector?.('a.row') !== null) return true
    node = node.nextElementSibling
  }
  return false
}, title)
check('the crowded worktree is open', trees.includes('develop') && await hasRowsUnder('develop'),
  'develop showed no sessions')
check('a quiet worktree is open',
  trees.includes('student-error-insights') && await hasRowsUnder('student-error-insights'),
  'student-error-insights showed no sessions')

// ---------------------------------------------------------------- hierarchy

// The page in document order. A row is matched wherever it sits rather than as
// a direct child of #log, because a row may be wrapped for layout — the claim
// being tested is which heading it falls under, not its parent element.
const shape = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('#log h2.group, #log h3.tree, #log a.row, #log button.starter')) {
    const box = el.getBoundingClientRect()
    out.push({
      tag: el.tagName.toLowerCase(),
      // The heading's own title, not everything inside it. A heading carries
      // controls beside its label — the count, and the copy button — and
      // folding their text into this made the title unmatchable by prefix.
      text: (el.querySelector('.disclose span')?.textContent ?? el.textContent ?? '').trim().split('\n')[0],
      nested: el.hasAttribute('data-nested'),
      // Where the reader sees the level start: the left edge of the *text*, not
      // of the border box. A row indents with padding and stays full-bleed so
      // its tap target still spans the screen, so its box never moves and
      // measuring it would report a hierarchy that is plainly on screen as absent.
      //
      // A heading's indent is carried by the line inside it rather than by the
      // heading itself, so the label is measured where there is one and the
      // box only otherwise.
      left: Math.round((() => {
        const label = el.querySelector('.disclose span')
        if (label !== null) return label.getBoundingClientRect().left
        return box.left + parseFloat(getComputedStyle(el).paddingLeft)
      })()),
    })
  }
  return out
})

// Matched on a prefix: a heading's text is its title followed by what it holds
// ("develop3 sessions"), and an open worktree is the one whose rows are visible.
const workspace = shape.find(n => n.tag === 'h2' && n.text.startsWith('language-boss-and-choc'))
const treeIndex = shape.findIndex(n => n.tag === 'h3' && n.text.startsWith('pre-term-sign-in'))
check('workspace heading renders', workspace !== undefined)
check('worktree heading renders under it', treeIndex > -1)

if (treeIndex > -1) {
  const tree = shape[treeIndex]
  // The first *session* under the heading. A worktree now opens with its "New
  // session" control, so the row after the heading is that button rather than a
  // session — the claim being tested is that a session follows its own worktree
  // and not some other heading, which the control sitting between does not change.
  const child = shape.slice(treeIndex + 1, treeIndex + 3).find(n => n.tag !== 'button')
  check('session follows its worktree heading', child?.tag === 'a' && child.nested === true,
    `saw ${child?.tag} "${child?.text}" nested=${child?.nested}`)
  // The visual hierarchy itself: each level must sit strictly right of the last.
  check('worktree is indented past its workspace', tree.left > (workspace?.left ?? 0),
    `workspace left=${workspace?.left} worktree left=${tree.left}`)
  check('session is indented past its worktree', (child?.left ?? 0) > (workspace?.left ?? 0),
    `workspace left=${workspace?.left} session left=${child?.left}`)
}

// The structural invariant: the page is always three levels, and a session is
// always a leaf. Every row must therefore have a worktree heading above it with
// no workspace heading in between — a row directly under an h2 would mean a
// session had been promoted to the second level.
// Only *sessions* are counted. A workspace now carries its own "New session"
// control directly under its h2, and a control is not a session: the invariant
// being tested is that no session is ever promoted to the second level, which a
// button sitting there does not breach — exactly as the worktree starter above
// already sits between a heading and the rows without being one of them.
let lastHeading = null
let orphans = 0
for (const node of shape) {
  if (node.tag === 'h2' || node.tag === 'h3') { lastHeading = node.tag; continue }
  if (node.tag !== 'a') continue
  if (lastHeading !== 'h3') orphans += 1
}
check('every session is a leaf under a worktree', orphans === 0,
  `${orphans} row(s) sat directly under a workspace`)

// The remaining claims are about other workspaces, which are already on screen:
// nothing here has to be opened first.
const all = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('#log h2.group, #log h3.tree, #log a.row, #log button.starter')) {
    out.push({
      tag: el.tagName.toLowerCase(),
      text: (el.querySelector('.disclose span')?.textContent ?? el.textContent ?? '').trim(),
      nested: el.hasAttribute('data-nested'),
    })
  }
  return out
})

// A session whose worktree cannot be determined still gets a heading rather
// than being hoisted: the "Unknown worktree" bucket is what keeps it a leaf.
const unknownIndex = all.findIndex(n => n.tag === 'h3' && n.text === 'Unknown worktree')
check('an unplaceable session gets an Unknown worktree heading', unknownIndex > -1)
if (unknownIndex > -1) {
  // Past the "New session" control the bucket now opens with, exactly as a real
  // checkout does. The claim is that the unplaceable sessions hang under this
  // heading, not which element is adjacent to it.
  const child = all.slice(unknownIndex + 1, unknownIndex + 3).find(n => n.tag !== 'button')
  check('the unknown bucket holds its sessions', child?.tag === 'a' && child.nested === true,
    `saw ${child?.tag} "${child?.text}"`)
}

// A checkout with no sessions keeps its heading, so the list describes the
// project rather than only this week's activity.
const empty = await page.evaluate(() =>
  [...document.querySelectorAll('#log h3.tree')].some(h => {
    // Past the "New session" control, which is now the first thing under every
    // open worktree. What is being checked is that an empty checkout still says
    // so, not which element happens to be adjacent to the heading.
    let next = h.nextElementSibling
    if (next?.classList.contains('starter') === true) next = next.nextElementSibling
    return next?.classList.contains('tree-state') === true
  }))
check('a worktree with no sessions still shows', empty)

await page.screenshot({ path: `${shots}sessions.png`, fullPage: true })

// ----------------------------------------------------------------- newlines
await page.goto(`${origin}/s/suggestion-bar-layout`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article p', { timeout: 15_000 })

const lines = await page.evaluate(() => {
  const p = [...document.querySelectorAll('#log article p')]
    .find(el => (el.textContent ?? '').startsWith('Measurements taken:'))
  if (p === undefined) return null
  const style = getComputedStyle(p)

  // Count *visual rows* rather than client rects: a rect is produced per line
  // box, and a long line that wraps makes more of them than the author typed.
  // Distinct top offsets answer the question actually being asked — how many
  // rows of text does the reader see.
  const rows = () => {
    const range = document.createRange()
    range.selectNodeContents(p)
    return new Set([...range.getClientRects()].map(r => Math.round(r.top))).size
  }

  const withRule = rows()
  // The counterfactual, measured rather than assumed: force the collapsing
  // behaviour back on and see whether the shape actually depends on the rule.
  // If these agree, the rule is decorative and this check proves nothing.
  const previous = p.style.whiteSpace
  p.style.whiteSpace = 'normal'
  const collapsed = rows()
  p.style.whiteSpace = previous

  return { whiteSpace: style.whiteSpace, withRule, collapsed, text: p.textContent ?? '' }
})

check('multi-line paragraph is present', lines !== null)
if (lines !== null) {
  check('paragraph preserves whitespace', lines.whiteSpace === 'pre-wrap', `white-space: ${lines.whiteSpace}`)
  // Four authored lines, so at least four rows must survive to the screen.
  check('every authored line survives to the screen', lines.withRule >= 4,
    `saw ${lines.withRule} rows of text`)
  // And the rule is what does it: collapsed, the same text occupies fewer rows.
  check('newlines would collapse without the rule', lines.collapsed < lines.withRule,
    `pre-wrap=${lines.withRule} rows, normal=${lines.collapsed} rows`)
}

await page.screenshot({ path: `${shots}transcript.png`, fullPage: true })
await browser.close()

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
