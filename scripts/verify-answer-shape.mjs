// An answer the harness will actually accept, and a refusal that leaves the
// question answerable.
//
//   PORT=7802 node mock/server.js
//   node scripts/verify-answer-shape.mjs [origin]     default http://127.0.0.1:7802
//
// Two failures are checked here, and they compounded into a real blocked turn:
//
//   1. The form let a single-select question carry *both* a chosen label and
//      free text. Typing an answer and then tapping a listed option left the
//      words behind, and the harness refuses such an item as `bad-response` —
//      the whole batch with it, so one leftover word cost every answer.
//   2. A `bad-response` refusal is not a lost question: the harness never
//      claimed it, so it is still waiting. The GUI forgot it anyway, which took
//      the form off every screen and left the turn blocked with nothing left to
//      answer. That is what made a recoverable refusal unrecoverable.
//
// So the assertions are about the *body* the browser sends and about what
// survives a refusal — not about a status code, which was 409 both when the
// question was still there and when it was gone.
//
// The mock refuses the same shapes the harness does (`matchesQuestions`), so a
// regression fails this check rather than someone's turn.
//
// Exits non-zero with a named failure, so it can be trusted in a check.

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://127.0.0.1:7802'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const root = fileURLToPath(new URL('..', import.meta.url))

// The mock is this script's own harness, so it is started here and stopped at
// the end rather than expected to be running already: a check that silently
// tested yesterday's process would be worth nothing.
const mock = spawn(process.execPath, ['mock/server.js'], {
  cwd: root,
  env: { ...process.env, PORT: new URL(origin).port || '7802' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let mockLog = ''
mock.stdout.on('data', chunk => { mockLog += chunk })
mock.stderr.on('data', chunk => { mockLog += chunk })

/** Poll the mock until it answers, so the browser never races its boot. */
async function ready () {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${origin}/api/sessions`)
      if (response.ok) return true
    } catch {
      // Not up yet.
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return false
}

function done (code) {
  mock.kill()
  console.log(code === 0 ? '\nAll answer-shape checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
  process.exit(code)
}

if (!await ready()) {
  console.error(`FAIL  the mock never answered on ${origin}\n${mockLog}`)
  done(1)
}

// The two questions the `migration` fixture asks, in the order the form renders
// them: `plan` is single-select with options, `envs` is multi-select. That pair
// is the whole point — one either/or, one several-at-once — because the rule
// under test differs between them.
const ASK = 'mock-ask-2'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 })
const errors = []
page.on('pageerror', error => errors.push(String(error)))
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })

/** Every answer body the page posted, so the shape can be read rather than inferred. */
const posted = []
page.on('request', request => {
  if (new URL(request.url()).pathname !== '/api/answer') return
  try { posted.push(JSON.parse(request.postData() ?? '')) } catch { posted.push(null) }
})

await page.goto(`${origin}/s/migration`, { waitUntil: 'domcontentloaded' })
const form = page.locator(`#ask form[data-ask="${ASK}"]`)
await form.waitFor({ timeout: 20000 })
check('no page errors on load', errors.length === 0, errors.join(' | '))

// ------------------------------------------------------------ A. single-select
// Exactly the sequence that produced the refusal: write an answer, then tap a
// listed option instead. The tap is the answer; the words are residue.
const TYPED = 'Do it on a fresh replica instead'
await form.locator('input.other[name="custom:plan"]').fill(TYPED)
await form.locator('input.pick[name="plan"]').first().check()

check('tapping a listed option clears the free text left behind',
  await form.locator('input.other[name="custom:plan"]').inputValue() === '',
  await form.locator('input.other[name="custom:plan"]').inputValue())

// ------------------------------------------------------------ B. multi-select
// The other half of the rule: on a multi-select, a label and free text are two
// independent choices, so both must survive. Dropping the text here would be
// the fix overreaching.
await form.locator('input.pick[name="envs"]').first().check()
await form.locator('input.other[name="custom:envs"]').fill('and roll back if replication lags')

await form.locator('button').first().click()

// The answer settles into the question's own row once the turn resumes.
await page.waitForFunction(() => {
  const row = document.querySelector('#log article[data-role="asked"]')
  return row !== null && row.querySelector('input.pick:checked') !== null
}, undefined, { timeout: 30000 })

const body = posted[posted.length - 1]
const byId = id => body?.answers?.find(answer => answer.id === id)

check('the answer was posted', Array.isArray(body?.answers), JSON.stringify(body))
check('a single-select answer carries the label and NOT the leftover text',
  byId('plan')?.selected?.[0] === 'Approve' && byId('plan')?.custom === undefined,
  JSON.stringify(byId('plan')))
check('a multi-select answer keeps both its label and its text',
  byId('envs')?.selected?.includes('Staging') && byId('envs')?.custom === 'and roll back if replication lags',
  JSON.stringify(byId('envs')))
check('no page errors after answering', errors.length === 0, errors.join(' | '))

// The mock refuses what the harness refuses, so acceptance here is evidence the
// batch was well-formed rather than evidence the mock is permissive.
check('the mock accepted the batch (it would refuse the old shape)',
  await page.locator(`#ask form[data-ask="${ASK}"]`).count() === 0,
  'the form is still waiting, so the answer was refused')

// What a refusal then costs is a bridge question, not a page one — the mock
// holds a single answer callback, so it cannot answer a second question and
// would fail these for its own reason. They live in `verify-settle-routing.mjs`,
// against a fake host that really does reply `bad-response`.

await browser.close()
done(failures.length === 0 ? 0 : 1)
