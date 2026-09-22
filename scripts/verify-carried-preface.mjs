// Prove a carried question arrives whole, in a real browser.
//
//   node scripts/verify-carried-preface.mjs [origin]     default http://localhost:7788
//
// A question carried up from a hidden subagent has three parts, and the reader
// needs all three: the question, the words it was asked with, and a way back to
// the child that asked it. They travel together and they broke separately, so
// each is checked on the rendered form rather than on the payload.
//
// The failure this exists to catch was invisible from either end. `client/wire.js`
// rebuilds every ask field by field, and `preface` was simply not among the
// fields it copied — so the server sent it correctly, `client/ask.js` was ready
// to render it, and the validator between them dropped it on every single load.
// Both halves looked right in isolation; only the rendered form showed the hole.
// Checking the API payload here would therefore have passed while the reader saw
// nothing, which is exactly the bug.
//
// Why it matters that the preface survives: the fixture's question opens with
// "Given that" and refers back to reasoning that exists nowhere else, so a form
// without its preface is not merely thinner — it cannot be answered at all.
//
// The second failure mode is quieter and the text checks alone could not see it:
// the preface arrived whole but as its own markdown source, so a reader met
// backticks, list dashes and asterisks instead of code spans and bullets. The
// transcript renders the same prose properly two inches above, which is what
// made it read as a rendering bug rather than as the agent's own punctuation.
// It is checked on the elements, because "legacy_id" spells the same either way.
//
// Why the link matters: the parent's log never receives the child's question,
// its preface or its answer. The child's own transcript is the only durable
// record, and it is left off the listing, so once the question is answered and
// the form goes away the link is the only route back to what was asked.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7788'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
// A phone viewport, because this form is read on one.
const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', e => errors.push(String(e)))
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })

// `migration` is the visible parent; `audit-drift` is the hidden subagent whose
// question is carried onto it. Not `networkidle`: the page holds an event stream
// open, so the network never goes idle and waiting for it would always time out.
await page.goto(`${origin}/s/migration`, { waitUntil: 'domcontentloaded' })
const form = page.locator('#ask form[data-ask="mock-ask-child"]')
await form.waitFor({ timeout: 10_000 })

const seen = await form.evaluate(el => {
  const preface = el.querySelector('.preface')
  const link = el.querySelector('.from a')
  return {
    // `offsetHeight` rather than presence: a node that is in the DOM but not
    // laid out is still a preface the reader cannot see.
    prefaceVisible: preface !== null && preface.offsetHeight > 0,
    prefaceText: preface === null ? '' : preface.textContent,
    // The agent writes this half of the message in markdown, like every other
    // half. Checking the text alone cannot tell rendered markup from the raw
    // source: both spell "legacy_id", one of them surrounded by backticks the
    // reader has to read past. So the elements are checked too.
    prefaceCode: preface === null ? [] : [...preface.querySelectorAll('code')].map(c => c.textContent),
    attribution: el.querySelector('.from')?.textContent ?? '',
    href: link === null ? null : link.getAttribute('href'),
    question: el.querySelector('.question')?.textContent ?? ''
  }
})

check('the question is on the form', seen.question.includes('Given that'), seen.question)
check('the preface is rendered and visible', seen.prefaceVisible)
check(
  'the preface carries the reasoning the question refers back to',
  seen.prefaceText.includes('legacy_id'),
  JSON.stringify(seen.prefaceText.slice(0, 80))
)
// The fixture's preface names two fields as code spans. Rendered, they are
// `code` elements; unrendered, they are backticks sitting in the prose.
check(
  'the preface renders its markdown rather than showing the source',
  seen.prefaceCode.includes('legacy_id'),
  JSON.stringify(seen.prefaceCode)
)
check(
  'no markdown source leaks into the words the reader reads',
  !seen.prefaceText.includes('`'),
  JSON.stringify(seen.prefaceText.slice(0, 80))
)
check('the form names the child that asked', seen.attribution.startsWith('Asked by '), seen.attribution)
check('the child is linked by id', seen.href === '/s/audit-drift', String(seen.href))

// The link must actually reach the child's transcript, in-page, and that
// transcript must hold the preface as a durable frame — that frame is what
// survives the question being answered.
await form.locator('.from a').click()
await page.waitForFunction(() => location.pathname === '/s/audit-drift', { timeout: 10_000 })
const fossil = await page.evaluate(() =>
  [...document.querySelectorAll('#log article')].some(a => a.textContent.includes('legacy_id')))
check('the link opens the child transcript', true)
check('the child transcript keeps the preface as a durable frame', fossil)

check('no page errors', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} check(s) failed.`)
process.exit(failures.length === 0 ? 0 : 1)
