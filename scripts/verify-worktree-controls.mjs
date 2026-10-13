// The worktree controls, measured in a real engine.
//
// Four claims, none of which the markup alone can settle:
//
//  1. Every open worktree offers "New session" as its FIRST item — above the
//     sessions already in it, not after them.
//  2. Every real worktree heading carries a copy button, and the synthetic
//     "Unknown worktree" bucket does not.
//  3. Tapping a starter creates a session, lands on it, and leaves the message
//     box holding the opening line with the caret at the end.
//  4. On a session, the worktree sits ABOVE the title, the title is smaller
//     than it used to be, and the worktree line carries its own copy button.
//
// Layout claims need a browser: "first item" is a position on screen and
// "above" is a geometric fact, neither of which is visible in HTML.
//
//   node scripts/verify-worktree-controls.mjs [origin]   default http://localhost:7778
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7778'
const failures = []

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
// A small phone: this GUI is mobile-first, and a control that only fits on a
// desktop viewport does not fit.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })

// Never `networkidle`: this page holds an SSE stream open for its whole life,
// so it is never idle by design. Wait for content instead.
await page.goto(`${origin}/sessions`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log h2.group', { timeout: 15_000 })

// Nothing has to be opened first: this list does not collapse, so every
// worktree and every session is painted on arrival.
await page.waitForSelector('#log h3.tree', { timeout: 15_000 })

// ------------------------------------------------- the starter is first
// Read the painted list as a flat sequence, so "first item under a heading" is
// answered by position rather than by structure.
const layout = await page.evaluate(() => {
  const out = []
  for (const node of document.querySelectorAll('#log h3.tree, #log button.starter, #log a.row, #log p.tree-state')) {
    out.push({
      kind: node.matches('h3.tree') ? 'tree'
        : node.matches('button.starter') ? 'starter'
          : node.matches('a.row') ? 'row' : 'state',
      text: (node.querySelector('.disclose span')?.textContent ?? node.textContent ?? '').trim().slice(0, 60),
      hasCopy: node.querySelector('button.copy') !== null,
      // Which level a starter sits at. A workspace now carries one of its own,
      // one step in rather than two, so "the starter" names two controls at two
      // depths and every check below has to say which of them it means.
      level: node.dataset.level ?? '',
      // Where the LABEL starts, not where the box does. A starter is a
      // full-width control whose border box reaches the page edge exactly as a
      // session row's does; what carries the hierarchy for both is the padding
      // that holds the text clear of the tree gutter.
      indent: Math.round(node.getBoundingClientRect().left + parseFloat(getComputedStyle(node).paddingLeft)),
    })
  }
  return out
})

const trees = layout.filter(n => n.kind === 'tree')
check('the list shows worktree headings at all', trees.length > 0, `${trees.length} found`)

// Every heading must be followed immediately by its own starter.
let firstItemFailures = []
for (let i = 0; i < layout.length; i++) {
  if (layout[i].kind !== 'tree') continue
  const next = layout[i + 1]
  if (next === undefined || next.kind !== 'starter' || next.level !== 'worktree') {
    firstItemFailures.push(`${layout[i].text} -> ${next?.kind ?? 'end of list'}`)
  }
}
check('New session is the first item under every open worktree',
  firstItemFailures.length === 0, firstItemFailures.join('; '))

// The worktree starter must be indented like the sessions it sits above — the
// same two steps in — so it reads as a leaf of that checkout rather than as
// something belonging to the workspace above it.
const starters = layout.filter(n => n.kind === 'starter' && n.level === 'worktree')
const workspaceStarters = layout.filter(n => n.kind === 'starter' && n.level === 'workspace')
const rows = layout.filter(n => n.kind === 'row')
const rowIndent = rows[0]?.indent
const wrong = starters.filter(s => s.indent !== rowIndent)
check('each New session button is indented level with its worktree\'s sessions',
  starters.length > 0 && rowIndent !== undefined && wrong.length === 0,
  `${starters.length} starters at ${[...new Set(starters.map(s => s.indent))].join('/')}px, rows at ${rowIndent}px`)

// The workspace's own starter sits one step in, not two: it hangs off the
// workspace trunk as a sibling of the worktree headings, so it must be clearly
// shallower than the checkouts' starters rather than level with them.
const treeIndent = layout.find(n => n.kind === 'tree')?.indent
check('every open workspace offers its own New session button',
  workspaceStarters.length > 0, `${workspaceStarters.length} found`)
check('the workspace New session button is shallower than its worktrees\' ones',
  workspaceStarters.length > 0 && workspaceStarters.every(s => s.indent < rowIndent),
  `workspace starters at ${[...new Set(workspaceStarters.map(s => s.indent))].join('/')}px, worktree starters at ${rowIndent}px`)

// It must also be followed by the workspace's first worktree heading, which is
// what puts it above the checkouts rather than buried among them.
check('the workspace New session button sits above that workspace\'s worktrees',
  layout.every((n, i) => n.kind !== 'starter' || n.level !== 'workspace' ||
    layout[i + 1] === undefined || layout[i + 1].kind === 'tree' || layout[i + 1].kind === 'state'),
  'a workspace starter is followed by something other than a worktree heading')

// A workspace and a checkout inside it routinely share a name, so the two
// starters must not both read "New session in <name>" — the reader has to be
// able to tell which level a press would start work in.
const starterLabels = await page.evaluate(() =>
  [...document.querySelectorAll('#log button.starter')].map(b => b.getAttribute('aria-label')))
check('no two New session buttons carry the same label',
  new Set(starterLabels).size === starterLabels.length,
  starterLabels.filter((l, i) => starterLabels.indexOf(l) !== i).join('; '))

// A starter has to look like a button, not like a line of text that happens to
// respond to a tap. The chrome sits on the inner `.face` rather than on the
// full-width row, which owns the tree gutter — so that is where it is checked.
const faces = await page.evaluate(() => {
  const el = document.querySelector('#log button.starter .face')
  if (el === null) return null
  const style = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  const row = el.closest('button.starter').getBoundingClientRect()
  // Relative luminance, so "is this edge visible" is answered in the way a
  // reader's eye answers it rather than by comparing two colour strings.
  const channel = v => {
    const n = v / 255
    return n <= 0.03928 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4
  }
  const luminance = colour => {
    const [r, g, b] = colour.match(/\d+(\.\d+)?/g).slice(0, 3).map(Number)
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
  }
  const ratio = (one, two) => {
    const a = luminance(one)
    const b = luminance(two)
    return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 10) / 10
  }
  const page = getComputedStyle(document.body).backgroundColor
  return {
    border: parseFloat(style.borderTopWidth),
    radius: parseFloat(style.borderTopLeftRadius),
    background: style.backgroundColor,
    borderColor: style.borderTopColor,
    pageColor: page,
    borderContrast: ratio(style.borderTopColor, page),
    weight: style.fontWeight,
    height: Math.round(box.height),
    // Hugs its words rather than stretching the full width of the list, which
    // would draw a frame around the hierarchy instead of around a control.
    narrowerThanRow: box.width < row.width - 20,
  }
})
check('the New session control is drawn as a button',
  faces !== null && faces.border > 0 && faces.radius > 0
    && faces.background !== 'rgba(0, 0, 0, 0)' && faces.background !== 'transparent',
  JSON.stringify(faces))
// A border that exists is not the same as a border anyone can see. A hairline
// in the divider colour on a near-page-coloured fill passed the check above and
// still read as a line of text, so the edge has to be a real step in value
// against the page behind it.
check('the New session button has an edge that actually reads as one',
  faces !== null && faces.borderContrast >= 3,
  faces === null ? '' : `border ${faces.borderColor} on page ${faces.pageColor}, contrast ${faces.borderContrast}:1`)
// And the label carries a control's weight rather than body text's.
check('the New session button labels itself as an action',
  faces !== null && Number(faces.weight) >= 600, `font-weight ${faces?.weight}`)
check('the New session button keeps a 44px tap height',
  faces !== null && faces.height >= 44, `${faces?.height}px`)
check('the New session button hugs its label rather than the whole row',
  faces !== null && faces.narrowerThanRow, JSON.stringify(faces))

// ------------------------------------------------- copy on the headings
const unknown = trees.filter(t => t.text === 'Unknown worktree')
const real = trees.filter(t => t.text !== 'Unknown worktree')
check('every real worktree heading carries a copy button',
  real.length > 0 && real.every(t => t.hasCopy),
  `${real.filter(t => !t.hasCopy).map(t => t.text).join(', ')} missing`)
check('the Unknown worktree bucket carries no copy button',
  unknown.every(t => !t.hasCopy),
  `${unknown.filter(t => t.hasCopy).length} unknown buckets wrongly offer one`)
// The bucket still gets a way to start work, which is what was asked for.
check('the Unknown worktree bucket still offers New session',
  unknown.length === 0 || layout.some((n, i) =>
    n.kind === 'tree' && n.text === 'Unknown worktree' && layout[i + 1]?.kind === 'starter'),
  'no starter under the unknown bucket')

// Copy controls must still be a real tap target despite being visually small.
const target = await page.evaluate(() => {
  const el = document.querySelector('#log button.copy')
  if (el === null) return null
  const after = getComputedStyle(el, '::after')
  const style = getComputedStyle(el)
  const box = el.getBoundingClientRect()
  return {
    height: after.height,
    width: after.width,
    // The face of the control: an icon, never a word.
    text: (el.textContent ?? '').trim(),
    svgs: el.querySelectorAll('svg').length,
    // An icon with no chip around it: no border, no filled background.
    border: style.borderTopWidth,
    background: style.backgroundColor,
    // Inline with the name rather than a block of its own.
    box: { w: Math.round(box.width), h: Math.round(box.height) },
    // The accessible name has to carry what the glyph cannot say.
    label: el.getAttribute('aria-label') ?? '',
  }
})
check('the copy control meets the 44px tap floor',
  target !== null && parseFloat(target.height) >= 44 && parseFloat(target.width) >= 44,
  target === null ? 'no copy button found' : `::after is ${target.width} x ${target.height}`)
check('the copy control is an icon, not the word "Copy"',
  target !== null && target.text === '' && target.svgs === 1,
  target === null ? '' : `text=${JSON.stringify(target.text)} svgs=${target.svgs}`)
// The glyph has to be a picture of something at the ~17px it renders at, not a
// small empty box — an empty box is what a button looks like, which is the
// complaint this guards against. What makes it legible is contrast: the front
// sheet is filled, so the silhouette carries the meaning, and the sheet behind
// it is a stroked corner. A glyph that is entirely outline reads as a box.
const glyph = await page.evaluate(() => {
  const paths = [...document.querySelectorAll('#log button.copy svg path')]
  if (paths.length === 0) return null
  return paths.map(path => ({
    fill: path.getAttribute('fill'),
    strokeWidth: Number(path.getAttribute('stroke-width') ?? 0),
  }))
})
check('the copy glyph has a solid shape, so it reads as an icon not an empty box',
  glyph !== null && glyph.some(path => path.fill === 'currentColor'),
  JSON.stringify(glyph))
check('the copy glyph keeps its strokes thin enough not to merge',
  glyph !== null && glyph.every(path => path.strokeWidth === 0 || path.strokeWidth <= 1.75),
  JSON.stringify(glyph))

// Every colour in the mark comes from the text around it, so it follows the
// dark-mode override without that override knowing this control exists.
const inherits = await page.evaluate(() => {
  const paths = [...document.querySelectorAll('#log button.copy svg path')]
  return paths.every(path => {
    const fill = path.getAttribute('fill')
    const stroke = path.getAttribute('stroke')
    return (fill === 'none' || fill === 'currentColor')
      && (stroke === null || stroke === 'currentColor')
  })
})
check('the copy glyph takes its colour from the text beside it', inherits)

check('the copy icon carries no chip of its own',
  target !== null && parseFloat(target.border) === 0
    && (target.background === 'rgba(0, 0, 0, 0)' || target.background === 'transparent'),
  target === null ? '' : `border=${target.border} background=${target.background}`)
check('the copy icon stays small enough to sit inline',
  target !== null && target.box.h <= 28 && target.box.w <= 28,
  target === null ? '' : `${target.box.w}x${target.box.h}`)
check('the copy icon still says what it copies, for a screen reader',
  target !== null && target.label.startsWith('Copy worktree name '),
  target === null ? '' : JSON.stringify(target.label))

// The mark sits on the name's own line, not floating above or below the words
// it belongs to — which is what "inline, not on its own line" means in layout.
const inline = await page.evaluate(() => {
  const out = []
  for (const tree of document.querySelectorAll('#log h3.tree')) {
    const label = tree.querySelector('.disclose span')
    const mark = tree.querySelector('button.copy')
    if (label === null || mark === null) continue
    // The LAST rendered line of the name, not its whole box: a wrapped name's
    // box is full width, so measuring against it would call a mark parked out
    // in the whitespace past the final word "beside the name".
    const lines = [...label.getClientRects()]
    const last = lines[lines.length - 1]
    const m = mark.getBoundingClientRect()
    out.push({
      text: (label.textContent ?? '').trim(),
      lines: lines.length,
      // Sharing the last line's band, so the mark is on that line.
      onSameLines: m.top < last.bottom && m.bottom > last.top,
      // Immediately after the final word. A negative gap means it wrapped to
      // the next line and landed left of the text; a large one means it was
      // pushed to the end of the row instead of hugging the word.
      gap: Math.round(m.left - last.right),
    })
  }
  return out
})
check('every copy icon sits directly after the last word of its name',
  inline.length > 0 && inline.every(i => i.onSameLines && i.gap >= 0 && i.gap <= 16),
  inline.filter(i => !i.onSameLines || i.gap < 0 || i.gap > 16)
    .map(i => `${i.text} (${i.lines} lines, gap ${i.gap}px)`).join('; '))

// ------------------------------------------------- names are never cut
// A worktree name is what the reader pastes into a shell or types into a
// prompt, so half of one is useless. It wraps onto as many lines as it needs
// and is never truncated: no ellipsis, no clipping to a fixed width.
const names = await page.evaluate(() => {
  const out = []
  for (const el of document.querySelectorAll('#log h3.tree .disclose span')) {
    const style = getComputedStyle(el)
    out.push({
      text: (el.textContent ?? '').trim(),
      // Clipped horizontally: the rendered text is wider than the box showing it.
      clipped: el.scrollWidth > el.clientWidth + 1,
      ellipsis: style.textOverflow === 'ellipsis',
      nowrap: style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre',
    })
  }
  return out
})
check('no worktree name is clipped to its box',
  names.length > 0 && names.every(n => !n.clipped),
  names.filter(n => n.clipped).map(n => n.text).join(', '))
check('no worktree name is given an ellipsis',
  names.every(n => !n.ellipsis),
  names.filter(n => n.ellipsis).map(n => n.text).join(', '))
check('every worktree name is allowed to wrap',
  names.every(n => !n.nowrap),
  names.filter(n => n.nowrap).map(n => n.text).join(', '))

// ------------------------------------------------- nothing hides the name
// The workspace heading is sticky and opaque, so it covers whatever scrolls
// level with it. A worktree heading is wider than its own name — the copy mark
// and the count sit out to the right — so a partial cover hid the words while
// leaving the mark on screen, which read as a mark floating beside nothing.
//
// Scanned down the whole list rather than at one offset, because the overlap
// only happens while a row is passing behind the sticky heading.
const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight)
const hidden = []
for (let y = 0; y < pageHeight; y += 120) {
  await page.evaluate(to => window.scrollTo(0, to), y)
  await page.waitForTimeout(30)
  const found = await page.evaluate(() => {
    const cover = document.querySelector('#log h2.group')
    if (cover === null) return []
    const c = cover.getBoundingClientRect()
    const out = []
    for (const tree of document.querySelectorAll('#log h3.tree')) {
      const label = tree.querySelector('.disclose span')
      const mark = tree.querySelector('button.copy')
      if (label === null || mark === null) continue
      const l = label.getBoundingClientRect()
      const m = mark.getBoundingClientRect()
      // Both must be on screen at all. A row scrolled off the top is not being
      // "covered" — it is simply above the viewport — and counting it made this
      // report a fault at a position where nothing was visible to be wrong.
      const onScreen = box => box.bottom > 0 && box.top < window.innerHeight
      if (!onScreen(l) || !onScreen(m)) continue
      const nameHidden = l.top < c.bottom && l.bottom > c.top
      const markShowing = !(m.top < c.bottom && m.bottom > c.top)
      if (nameHidden && markShowing) out.push(label.textContent.trim())
    }
    return out
  })
  for (const name of found) hidden.push(`${name} at ${y}px`)
}
await page.evaluate(() => window.scrollTo(0, 0))
await page.waitForTimeout(80)
check('no worktree name is ever hidden while its copy icon stays visible',
  hidden.length === 0, hidden.slice(0, 4).join('; '))

// ------------------------------------------------- the heading is not a control
// The heading names its worktree and nothing more: there is nothing to open, so
// it must not pose as a control. A screen reader announcing a button here, or a
// tab stop that does nothing when pressed, would promise an action that no
// longer exists. The element itself stays, because the copy mark sits inside
// its text flow.
const control = await page.evaluate(() => {
  const el = document.querySelector('#log h3.tree .disclose')
  if (el === null) return null
  return {
    role: el.getAttribute('role'),
    hasTabStop: el.hasAttribute('tabindex'),
    expanded: el.getAttribute('aria-expanded'),
    // The mark copies the name, so it must still live beside the name.
    holdsCopy: el.querySelector('button.copy') !== null,
  }
})
check('the worktree heading is not announced as a control',
  control !== null && control.role === null && !control.hasTabStop
    && control.expanded === null,
  JSON.stringify(control))
check('the copy mark sits inside the name it copies',
  control !== null && control.holdsCopy,
  'the mark is outside the element holding the name')

// Tapping a heading does nothing at all: it does not navigate, and it does not
// change what is on screen.
const inert = await page.evaluate(async () => {
  const el = document.querySelector('#log h3.tree .disclose')
  if (el === null) return null
  const url = location.href
  const before = document.querySelectorAll('#log a.row').length
  el.click()
  await new Promise(resolve => setTimeout(resolve, 250))
  return {
    sameUrl: location.href === url,
    sameRows: document.querySelectorAll('#log a.row').length === before,
  }
})
check('tapping a worktree heading changes nothing',
  inert !== null && inert.sameUrl && inert.sameRows, JSON.stringify(inert))

// ------------------------------------------------- the pre-fill
// Tap the first starter under a *named* worktree and follow it to the session.
const named = await page.evaluate(() => {
  const nodes = [...document.querySelectorAll('#log h3.tree, #log button.starter')]
  for (let i = 0; i < nodes.length; i++) {
    if (!nodes[i].matches('h3.tree')) continue
    const title = nodes[i].querySelector('.disclose span')?.textContent?.trim() ?? ''
    if (title === '' || title === 'Unknown worktree') continue
    if (nodes[i + 1]?.matches('button.starter')) return title
  }
  return null
})

if (named === null) {
  check('a named worktree with a starter exists to tap', false, 'none on this box')
} else {
  await page.click(`#log button.starter[aria-label="New session in ${named}"]`)
  // Creating a session is a real POST to the host; give it room.
  await page.waitForURL(/\/s\//, { timeout: 40_000 })
  await page.waitForTimeout(400)
  const box = await page.evaluate(() => {
    const el = document.getElementById('box')
    return { value: el.value, start: el.selectionStart, end: el.selectionEnd, focused: document.activeElement === el }
  })
  const want = `Work in the ${named} worktree. `
  check('the message box is pre-filled with the worktree instruction',
    box.value === want, `got ${JSON.stringify(box.value)}, wanted ${JSON.stringify(want)}`)
  check('the caret sits after the pre-fill, ready to type',
    box.start === want.length && box.end === want.length, `caret at ${box.start}-${box.end}`)
  check('nothing was sent on the reader\'s behalf',
    await page.evaluate(() => document.querySelectorAll('#log article[data-role="user"]').length) === 0,
    'a user message already exists in the new session')

  // ------------------------------------------------- the session header
  const header = await page.evaluate(() => {
    const where = document.getElementById('where')
    const title = document.getElementById('title')
    if (where === null || title === null) return null
    return {
      hidden: where.hidden,
      worktree: where.querySelector('span')?.textContent ?? '',
      hasCopy: where.querySelector('button.copy') !== null,
      whereBottom: where.getBoundingClientRect().bottom,
      titleTop: title.getBoundingClientRect().top,
      titleSize: parseFloat(getComputedStyle(title).fontSize),
    }
  })
  check('the session header names its worktree', header !== null && !header.hidden && header.worktree === named,
    header === null ? 'no #where element' : `hidden=${header.hidden} text=${JSON.stringify(header.worktree)}`)
  check('the worktree sits above the session title',
    header !== null && header.whereBottom <= header.titleTop + 1,
    header === null ? '' : `where ends ${header.whereBottom}, title starts ${header.titleTop}`)
  check('the session title is smaller than the 17px it was',
    header !== null && header.titleSize < 17, `${header?.titleSize}px`)
  check('the worktree line carries its own copy button', header !== null && header.hasCopy)
  const headerName = await page.evaluate(() => {
    const el = document.querySelector('#where span')
    if (el === null) return null
    const style = getComputedStyle(el)
    return {
      clipped: el.scrollWidth > el.clientWidth + 1,
      ellipsis: style.textOverflow === 'ellipsis',
      nowrap: style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre',
    }
  })
  check('the header worktree name is never truncated',
    headerName !== null && !headerName.clipped && !headerName.ellipsis && !headerName.nowrap,
    JSON.stringify(headerName))

  // The session's own title, beneath it, wraps and is never cut sideways, but
  // stops at three lines: a long title would otherwise eat the transcript under
  // a sticky header. Measured with a long title swapped in, then put back.
  const titleCut = await page.evaluate(() => {
    const el = document.getElementById('title')
    if (el === null) return null
    const was = el.textContent
    el.textContent = 'a very long session title that keeps going '.repeat(20)
    const style = getComputedStyle(el)
    const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
    const out = {
      clipped: el.scrollWidth > el.clientWidth + 1,
      ellipsis: style.textOverflow === 'ellipsis',
      nowrap: style.whiteSpace === 'nowrap' || style.whiteSpace === 'pre',
      lines: Math.round(el.clientHeight / line),
    }
    el.textContent = was
    return out
  })
  check('the session title wraps, never cut sideways',
    titleCut !== null && !titleCut.clipped && !titleCut.ellipsis && !titleCut.nowrap,
    JSON.stringify(titleCut))
  check('a long session title stops at three lines',
    titleCut !== null && titleCut.lines === 3, JSON.stringify(titleCut))

  // Nothing anywhere on either screen may clip its text horizontally. A blanket
  // sweep rather than a list of elements, so a rule added later to some other
  // label cannot quietly reintroduce an ellipsis nobody is checking for.
  const anyCut = await page.evaluate(() => {
    const bad = []
    for (const el of document.querySelectorAll('#log *, header *')) {
      if (el.children.length > 0) continue
      const style = getComputedStyle(el)
      const clipped = el.scrollWidth > el.clientWidth + 1 && style.overflowX !== 'visible'
      if (style.textOverflow === 'ellipsis' || clipped) {
        bad.push(`${el.tagName.toLowerCase()}.${el.className || '?'}: ${(el.textContent ?? '').trim().slice(0, 30)}`)
      }
    }
    return bad
  })
  check('no text anywhere on the session screen is clipped or ellipsised',
    anyCut.length === 0, anyCut.slice(0, 4).join('; '))
}

await browser.close()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 1 * 0 : 1)
