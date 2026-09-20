// Prove the permission UI in a real browser, through the real click path.
//
//   node scripts/verify-approval-ui.mjs [origin]     default http://localhost:7799
//
// The mock raises a permission at boot and again on a prompt containing
// "approve", so both outcomes are exercised without needing a real agent
// escalation. What is checked is what a reader would notice: a form on screen,
// zero console errors, a tap that the server accepts, and the form leaving.
//
// A 200 from /api/sessions proves nothing here — the page is client-rendered
// from a boot payload and a stream, so everything below waits on the content
// itself rather than on a network idle.
//
// The question block uses the `migration` fixture, not `billing`: the mock keeps
// ONE local answer callback (`onLocalAnswer`), so with several boot-time
// questions only the last raised is answerable and `billing`'s is orphaned. That
// is a limit of the mock, not of the GUI, and picking the one that works keeps
// this script a check on the GUI rather than on the fixture.
//
// The list block opens its workspace with `?open=`: `/sessions` starts every
// workspace shut by design, so the row is not in the DOM on a bare load and a
// presence check without it would fail on a healthy page.

import { chromium } from '/usr/lib/node_modules/playwright/index.mjs'

const origin = process.argv[2] ?? 'http://localhost:7799'
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const browser = await chromium.launch()

/** A cold context with console capture, so no cached module can hide a fault. */
async function cold () {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: true })
  const page = await context.newPage()
  const errors = []
  const decides = []
  const answers = []
  const sends = []
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()) })
  page.on('pageerror', error => errors.push(String(error)))
  page.on('response', response => {
    const at = new URL(response.url()).pathname
    if (at === '/api/decide') decides.push(response.status())
    if (at === '/api/answer') answers.push(response.status())
    if (at === '/api/send') sends.push(response.status())
  })
  page.on('requestfailed', request => errors.push('requestfailed ' + request.url()))
  return { context, page, errors, decides, answers, sends }
}

// --------------------------------------------- A. the list surfaces a decision
//  Deliberately first: it needs the mock's boot-time permission still pending,
//  and every later block settles one.
{
  const { context, page, errors } = await cold()
  await page.goto(`${origin}/sessions?open=ws-infra`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#log h2.group', { timeout: 15_000 })
  // The row for the session waiting on a permission must carry the "asking"
  // mark, exactly as a session waiting on a question does. The mark's accessible
  // name is the stable signal: it is derived from the pending set alone, whereas
  // the preview line also waits on the corpus to have folded the row's log.
  const mark = await page.evaluate(() => {
    const link = [...document.querySelectorAll('#log a')].find(a => (a.getAttribute('href') ?? '').endsWith('/s/deploy-staging'))
    const dot = link?.querySelector('.dot')
    return dot === null || dot === undefined ? null : dot.getAttribute('aria-label')
  })
  // Asserted on the *state* the mark carries, not on the session's name: a row's
  // title is folded from the log in the background and reads "New session" until
  // that lands, which is a fact about the corpus timing rather than about the
  // mark. What must be true is that the mark says a person is being waited on.
  check('the list marks a session waiting on a permission as asking',
    (mark ?? '').startsWith('Asking you a question or for permission'), String(mark))
  check('the mark is given an accessible name naming its session',
    (mark ?? '').includes(': ') && (mark ?? '').length > 'Asking you a question or for permission: '.length,
    String(mark))
  check('no console error on the list', errors.length === 0, errors.join(' | '))
  await context.close()
}

// ---------------------------------------------------------- B. cold deep link
{
  const { context, page, errors, decides } = await cold()
  await page.goto(`${origin}/s/deploy-staging`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#approval form', { timeout: 15_000 })

  const shape = await page.evaluate(() => {
    const form = document.querySelector('#approval form')
    return {
      session: form?.dataset.session ?? '',
      ask: form?.dataset.ask ?? '',
      text: form?.textContent ?? '',
      buttons: [...(form?.querySelectorAll('button') ?? [])].map(b => b.textContent),
      types: [...(form?.querySelectorAll('button') ?? [])].map(b => b.type),
    }
  })
  check('a cold deep link paints the permission form', shape.session === 'deploy-staging', JSON.stringify(shape))
  check('the form names the tool being asked about', shape.text.includes('Allow bash?'), shape.text)
  check('the form carries the agent\'s own reason', shape.text.includes('escalate sandbox'), shape.text)
  check('the one-shot nature is stated, not implied',
    shape.text.includes('Applies to this one request only'), shape.text)
  check('both outcomes are offered', shape.buttons.join(',') === 'Allow once,Reject', shape.buttons.join(','))
  check('the decisions are not submit buttons, so no implicit submit can grant access',
    shape.types.every(type => type === 'button'), shape.types.join(','))

  // The form must be reachable, not merely present: a control below the fold
  // passes a presence check while being untappable.
  const box = await page.$eval('#approval form', el => {
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), h: Math.round(r.height), inView: r.top < window.innerHeight && r.bottom > 0 }
  })
  check('the permission form is on screen', box.inView, JSON.stringify(box))

  await page.getByRole('button', { name: 'Allow once' }).click()
  await page.waitForSelector('#approval form', { state: 'detached', timeout: 15_000 })
  check('the decision reached the server and was accepted', decides.includes(200), JSON.stringify(decides))
  check('allowing removes the form', await page.$('#approval form') === null)
  check('no console error on the cold load and allow', errors.length === 0, errors.join(' | '))
  await context.close()
}

// ------------------------------------------- C. reject, raised through a send
{
  const { context, page, errors, decides } = await cold()
  await page.goto(`${origin}/s/deploy-staging`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#composer:not([hidden])', { timeout: 15_000 })
  await page.fill('#box', 'approve please')
  await page.click('#send')
  await page.waitForSelector('#approval form', { timeout: 15_000 })
  check('a permission raised during a turn reaches the page',
    (await page.textContent('#approval form')).includes('Allow bash?'))
  await page.getByRole('button', { name: 'Reject' }).click()
  await page.waitForSelector('#approval form', { state: 'detached', timeout: 15_000 })
  check('rejecting reaches the server and is accepted', decides.includes(200), JSON.stringify(decides))
  check('no console error raising and rejecting', errors.length === 0, errors.join(' | '))
  await context.close()
}

// ---------------------------------------- D. the question path is unbroken
{
  const { context, page, errors, answers } = await cold()
  await page.goto(`${origin}/s/migration`, { waitUntil: 'domcontentloaded' })
  // The `migration` fixture now carries TWO waits: the parent's own plan
  // question, and — attributed there by the child-report feature — the child
  // `audit-drift`'s. Both belong on this transcript, so the locator is scoped to
  // the plan form rather than assuming the screen holds exactly one. An
  // unscoped `Send answer` would be a strict-mode violation, not a UI failure.
  const plan = page.locator('#ask form').filter({ hasText: 'Approve this plan?' })
  await plan.waitFor({ timeout: 15_000 })
  await page.waitForSelector('#ask form', { timeout: 15_000 })
  check('the question form still renders', (await plan.textContent()).includes('Approve this plan?'),
    (await plan.textContent()).slice(0, 80))
  // This session now legitimately carries a second wait: the child `audit-drift`
  // is blocked on a permission, and that request is attributed here rather than
  // left on a hidden child row. So an approval form IS expected — but it must be
  // the child's, attributed and named, not the plan question's own.
  const approval = page.locator('#approval form')
  check('the child\'s permission is attributed to this transcript', await approval.count() === 1,
    `${await approval.count()} approval form(s)`)
  check('that permission names the child, not the parent',
    (await approval.textContent() ?? '').includes('Asked by'),
    (await approval.textContent() ?? '').slice(0, 80))
  check('the plan question did not gain an approval of its own',
    (await plan.textContent() ?? '').includes('Allow bash?') === false)
  await plan.getByRole('radio', { name: /Approve/ }).first().check()
  await plan.getByRole('button', { name: 'Send answer' }).click()
  await plan.waitFor({ state: 'detached', timeout: 15_000 })
  check('answering a question still reaches the server', answers.includes(200), JSON.stringify(answers))
  check('no console error on the question path', errors.length === 0, errors.join(' | '))
  await context.close()
}

// -------------------------------------------- E. the send path is unbroken
{
  const { context, page, errors, sends } = await cold()
  await page.goto(`${origin}/s/deploy-staging`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('#composer:not([hidden])', { timeout: 15_000 })
  await page.fill('#box', 'a plain message with no keyword')
  await page.click('#send')
  // Waiting on the log's text alone is not enough: the app renders the prompt
  // optimistically before the POST settles, so the text can be on screen while
  // the response has not arrived. The durable echo carries its own
  // `data-client-id`, which only the server's message can produce, so waiting on
  // that is waiting on the round trip actually having completed.
  await page.waitForSelector('#log article[data-client-id]', { timeout: 15_000 })
  check('a plain prompt still sends and is echoed', sends.includes(200), JSON.stringify(sends))
  check('no console error on the send path', errors.length === 0, errors.join(' | '))
  await context.close()
}

await browser.close()
console.log(`\n${failures.length === 0 ? 'All UI checks passed.' : `${failures.length} failed: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
