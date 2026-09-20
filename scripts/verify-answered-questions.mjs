// A question put to the reader, and the answer they gave, stay in the scrollback.
//
// Two separate mechanisms used to take this exchange off the screen, and both
// are invisible in the markup of a single event:
//
//   1. the live answer form lives outside the transcript and is *removed* once
//      the question stops being pending, leaving nothing behind;
//   2. the durable `ask_user_question` call and result are ordinary tool rows,
//      so the client's fold pass collapses them into an "n tool calls" link.
//
// So the claim is a rendered-page claim: after answering, the question and the
// answer must both still be readable in `#log`, and must still be there after a
// reload — which is what proves the record is durable rather than a form that
// happens not to have been cleared yet.
//
// The answer is not a row of its own. It is drawn as the ticks and the filled
// free-text box on the question's own form, so an answered question in the
// scrollback is the unanswered form exactly — same questions, same detail, same
// options, same free-text box — with the controls disabled and the Answer button
// gone. That equality is asserted directly below.
//
//   PORT=7799 node mock/server.js
//   node scripts/verify-answered-questions.mjs [origin]   default http://127.0.0.1:7799
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7799'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

// `migration` asks two questions mid-turn — one single-select, one multi-select
// — and settles them into a durable result, which is the whole shape under test.
//
// It is deliberately the session used rather than `billing`, which also asks:
// the mock holds a single `onLocalAnswer` settler, and `migration` registers
// last, so it is the one whose turn can actually resume once answered.
//
// Not networkidle: the page holds a stream open for the life of the session, so
// the network is never idle.
await page.goto(`${origin}/s/migration`, { waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })

const asked = page.locator('#log article[data-role="asked"]')
await asked.first().waitFor({ timeout: 20000 })
check('the question is a transcript row, not only a form', await asked.count() >= 1)
const questionText = await asked.first().innerText()
check('the question text is shown in full',
  questionText.includes('Approve this plan?'), questionText)
check('every question in the ask is shown, not just the first',
  questionText.includes('Which environments go first?'), questionText)
// The record has to look like the question that was asked, which means the parts
// a summary would have thrown away: the detail block, and every option offered —
// including the ones that were turned down.
check('the detail text is kept, not summarised away',
  questionText.includes('Snapshot the primary'), questionText)
check('the options that were not chosen are still shown',
  questionText.includes('Refuse') && questionText.includes('Production'), questionText)
// Each option is a real label with its own control, exactly as the form draws
// it, rather than a line of prose listing what was on offer.
check('each option is a control with a label, as in the form',
  await asked.first().locator('label input.pick').count() >= 5,
  `${await asked.first().locator('label input.pick').count()} option controls`)

// Answer it the way a person would: through the form, not the API.
//
// Selected by ask rather than by session: a hidden child's question is surfaced
// on its parent's row, so this session shows two forms and only one of them is
// the turn's own question.
const form = page.locator(`#ask form[data-ask="mock-ask-2"]`)
await form.waitFor({ timeout: 20000 })

// The shape of the question while it is still open, so "renders exactly the same
// once answered" can be compared against something rather than asserted. Text is
// taken from the live form and the control inventory from the transcript row,
// which is the row that has to keep matching it.
const openShape = await page.evaluate(() => {
  const live = document.querySelector('#ask form[data-ask="mock-ask-2"]')
  const row = document.querySelector('#log article[data-role="asked"]')
  const shape = node => ({
    questions: [...node.querySelectorAll('.question')].map(p => p.textContent),
    details: [...node.querySelectorAll('.detail')].map(p => p.textContent),
    // Type and label per control, in order: this is what "the same form" means.
    controls: [...node.querySelectorAll('label')].map(label => ({
      type: label.querySelector('input.pick')?.type ?? null,
      text: label.textContent.trim(),
      hasBox: label.querySelector('input.other') !== null,
      placeholder: label.querySelector('input.other')?.placeholder ?? null,
    })),
  })
  return { live: shape(live), row: shape(row) }
})
check('the open question already renders as the live form does',
  JSON.stringify(openShape.live.controls) === JSON.stringify(openShape.row.controls),
  JSON.stringify(openShape))

// The amber rule marks the one place the reader was asked to act, and answering
// does not change what the question was. So the waiting form and the kept row
// must carry the same bar — measured as the browser computes it, since the two
// are styled through different selectors and could drift apart silently.
const bars = await page.evaluate(() => {
  const bar = selector => {
    const el = document.querySelector(selector)
    if (el === null) return null
    const s = getComputedStyle(el)
    return [s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor, s.paddingLeft].join(' ')
  }
  return {
    waiting: bar('#ask form[data-ask="mock-ask-2"]'),
    kept: bar('#log article[data-role="asked"]'),
  }
})
check('the waiting form and the kept row carry the same left bar',
  bars.waiting !== null && bars.waiting === bars.kept, JSON.stringify(bars))
check('that bar is actually drawn, not merely equal',
  /^3px solid/.test(bars.kept ?? ''), JSON.stringify(bars))

await form.locator('input.pick[name="plan"]').first().check()
// Two options on the multi-select, so the record has to show both ticks. Picking
// one would leave the multiple-answer path untested.
await form.locator('input.pick[name="envs"]').nth(0).check()
await form.locator('input.pick[name="envs"]').nth(1).check()
// And type an answer of our own, so the record has to carry words the reader
// wrote rather than only labels they picked. Without this the free-text box is
// only ever asserted empty, and a box that never shows what was typed would
// pass every other check in this file.
const TYPED = 'and roll back if replication lags'
await form.locator('input.other[name="custom:envs"]').fill(TYPED)
await form.locator('button').first().click()

// The answer settles into the question's own row. Wait for the tick to appear
// there rather than for a new row: there is no second row to wait for.
await page.waitForFunction(() => {
  const row = document.querySelector('#log article[data-role="asked"]')
  return row !== null && row.querySelector('input.pick:checked') !== null
}, undefined, { timeout: 30000 })

check('the answer opened no second transcript row',
  await page.locator('#log article[data-role="answered"]').count() === 0)

const answerText = await asked.first().innerText()
check('the answered row names what was actually chosen',
  answerText.includes('Approve'), answerText)
check('every choice on a multi-select answer is kept',
  answerText.includes('Staging') && answerText.includes('Preview'), answerText)
check('the answered row still shows the options that were turned down',
  answerText.includes('Refuse') && answerText.includes('Production'), answerText)

// The heart of it: answering changed which controls are ticked, and nothing
// else about the row.
const settledShape = await page.evaluate(() => {
  const row = document.querySelector('#log article[data-role="asked"]')
  return {
    questions: [...row.querySelectorAll('.question')].map(p => p.textContent),
    details: [...row.querySelectorAll('.detail')].map(p => p.textContent),
    controls: [...row.querySelectorAll('label')].map(label => ({
      type: label.querySelector('input.pick')?.type ?? null,
      text: label.textContent.trim(),
      hasBox: label.querySelector('input.other') !== null,
      placeholder: label.querySelector('input.other')?.placeholder ?? null,
    })),
  }
})
check('the answered question renders exactly the same form as the unanswered one',
  JSON.stringify(settledShape) === JSON.stringify(openShape.row),
  `open ${JSON.stringify(openShape.row)}\n  settled ${JSON.stringify(settledShape)}`)

const settledBar = await page.evaluate(() => {
  const s = getComputedStyle(document.querySelector('#log article[data-role="asked"]'))
  return [s.borderLeftWidth, s.borderLeftStyle, s.borderLeftColor, s.paddingLeft].join(' ')
})
check('answering did not change the row\'s left bar', settledBar === bars.kept,
  `before ${bars.kept} / after ${settledBar}`)

// The whole point of the rework: the record is the form, minus the ability to
// act on it. Anything still enabled would be a control the reader could try to
// use on a question that is already settled.
const controls = await page.evaluate(() => {
  const all = selector => [...document.querySelectorAll(`#log article[data-role="asked"] ${selector}`)]
  const picks = all('input.pick')
  const fields = all('input.other')
  let enabled = 0
  let checked = 0
  for (const pick of picks) {
    if (!pick.disabled) enabled += 1
    if (pick.checked) checked += 1
  }
  return {
    picks: picks.length,
    enabled,
    checked,
    buttons: all('button').length,
    fields: fields.length,
    fieldsEnabled: fields.filter(field => !field.disabled).length,
  }
})
check('the kept question draws real controls, as the form does', controls.picks > 0, JSON.stringify(controls))
check('every kept radio and checkbox is disabled', controls.enabled === 0, JSON.stringify(controls))
check('the chosen options are ticked', controls.checked >= 3, JSON.stringify(controls))
check('no Answer button is left on a settled question', controls.buttons === 0, JSON.stringify(controls))
// The free-text box is part of the form's shape, so it stays — disabled, exactly
// like the radios and checkboxes beside it.
check('the free-text box is still drawn on a settled question', controls.fields > 0, JSON.stringify(controls))
check('every kept free-text box is disabled', controls.fieldsEnabled === 0, JSON.stringify(controls))

// What the reader typed is their answer in their own words, so the box has to
// carry it back — and carry it legibly. A disabled input is greyed by the
// browser (Chromium dims `color` itself to about rgb(84,84,84); WebKit uses
// `-webkit-text-fill-color`), so the answer is compared against the transcript
// text beside it. Matching the surrounding prose is the claim that matters: a
// box holding the right words in unreadable grey is a lost answer.
const typedBack = await page.evaluate(() => {
  const row = document.querySelector('#log article[data-role="asked"]')
  const boxes = [...row.querySelectorAll('input.other')]
  const filled = boxes.find(box => box.value !== '')
  if (filled === undefined) return { values: boxes.map(box => box.value) }
  const paint = el => {
    const s = getComputedStyle(el)
    // What is actually painted: the fill colour wins where it is set to
    // anything other than the default of following `color`.
    return s.webkitTextFillColor === '' ? s.color : s.webkitTextFillColor
  }
  return {
    value: filled.value,
    ticked: filled.parentElement.querySelector('input.pick')?.checked === true,
    box: paint(filled),
    prose: paint(row.querySelector('.question')),
  }
})
check('the free-text box carries what the reader typed',
  typedBack.value === TYPED, JSON.stringify(typedBack))
check('the typed answer\'s own control is ticked beside it',
  typedBack.ticked === true, JSON.stringify(typedBack))
check('the typed answer is as readable as the question above it',
  typedBack.box === typedBack.prose, JSON.stringify(typedBack))

// A ticked control the reader cannot SEE is the same to them as a lost answer,
// and `checked` alone does not catch that: a disabled control is painted a
// washed-out grey by the browser, which once made a selected radio all but
// indistinguishable from an empty one. So the mark is measured in pixels — the
// ticked control must actually differ from its unticked neighbour.
const marks = await page.evaluate(async () => {
  const picks = [...document.querySelectorAll('#log article[data-role="asked"] input.pick')]
  const on = picks.find(pick => pick.checked)
  const off = picks.find(pick => !pick.checked)
  if (on === undefined || off === undefined) return null
  // The drawn mark is a pseudo-element, so it is read through the computed style
  // of ::before rather than from the control's own box.
  const mark = el => {
    const s = getComputedStyle(el, '::before')
    return { content: s.content, width: s.width, background: s.backgroundColor }
  }
  return { on: mark(on), off: mark(off) }
})
check('a ticked control is drawn differently from an unticked one',
  marks !== null && JSON.stringify(marks.on) !== JSON.stringify(marks.off), JSON.stringify(marks))
check('the tick is an actual drawn mark, not an empty box',
  marks !== null && marks.on.content !== 'none' && parseFloat(marks.on.width) > 0, JSON.stringify(marks))

// A disabled control must also refuse a real tap, not merely look inert.
const firstPick = page.locator('#log article[data-role="asked"] input.pick').first()
const before = await firstPick.isChecked()
await firstPick.click({ force: true, timeout: 3000 }).catch(() => {})
check('tapping a kept control does not change it', await firstPick.isChecked() === before)

// The fold pass is what used to eat this exchange, and it runs again on every
// append. Neither row may ever be inside a folded run.
check('the exchange was not folded into a tool count', await page.evaluate(() => {
  const rows = document.querySelectorAll('#log article[data-tools]')
  for (const row of rows) if (row.dataset.role === 'asked') return false
  return true
}))

// The real test of durability: a reload throws away every bit of client state,
// so anything still on the screen came from the session log.
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForSelector('#log article', { timeout: 20000 })
check('the question survives a reload',
  await page.locator('#log article[data-role="asked"]').count() >= 1)
// A reload renders from the log alone, with no live frame to amend, so this is
// what proves the ticks come from the durable result rather than from the
// in-page update that ran when the answer landed.
const reloaded = await page.evaluate(() => {
  const row = document.querySelector('#log article[data-role="asked"]')
  return {
    checked: [...row.querySelectorAll('input.pick')].filter(pick => pick.checked).length,
    boxes: row.querySelectorAll('input.other').length,
    buttons: row.querySelectorAll('button').length,
  }
})
check('the answer survives a reload, ticked into the question',
  reloaded.checked >= 3, JSON.stringify(reloaded))
check('the reloaded row keeps the free-text box and no Answer button',
  reloaded.boxes > 0 && reloaded.buttons === 0, JSON.stringify(reloaded))

check('no page errors', errors.length === 0, errors.join(' | '))

await browser.close()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
