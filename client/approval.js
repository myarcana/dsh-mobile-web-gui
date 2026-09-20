// Permissions an agent is waiting on you to grant.
//
// The sibling of ask.js, against the harness's other pending table: a question
// is answered with a list of answers, a permission is decided with one word.
// They are held on the host and ride the session summaries, so a dropped signal,
// a slept radio or a reopened tab all come back to the same waiting request. A
// decision goes through the outbox like a prompt, so it survives all three too.
//
// A grant here is ONE-SHOT: the harness has no allow-always, no remembered rule
// and no revocation. The next time the same action needs permission it asks
// again. The controls say so, because a reader who believes they have granted
// standing access will be surprised by the next prompt.

import * as outbox from 'outbox'
import * as view from 'view'

const host = document.getElementById('approval')

// askId -> the outbox state of its decision, so a rebuilt form never comes back
// editable after it was already decided.
const states = new Map()

// Show the permissions one session is waiting on. `approvals` undefined means
// not known yet, so that session's forms stay. A form that already exists is
// kept, so a summary refresh never throws away a choice in progress.
export function render (sessionId, approvals) {
  for (const form of host.querySelectorAll('form')) {
    if (form.dataset.session !== sessionId || (approvals !== undefined && !approvals.some(approval => approval.askId === form.dataset.ask))) form.remove()
  }
  if (approvals === undefined) return
  const stick = view.nearBottom()
  for (const approval of approvals) {
    if (host.querySelector('[data-ask="' + CSS.escape(approval.askId) + '"]') === null) host.append(build(sessionId, approval))
  }
  view.toBottom(stick)
}

export function state (row) {
  states.set(row.askId, row.state)
  const form = host.querySelector('[data-ask="' + CSS.escape(row.askId) + '"]')
  if (form !== null) show(form, row.state)
}

function build (sessionId, approval) {
  const form = document.createElement('form')
  form.dataset.session = sessionId
  form.dataset.ask = approval.askId
  // See ask.js: a permission carried up from a hidden child says which one.
  if (approval.from !== undefined) form.append(line('from', 'Asked by ' + approval.from))
  form.append(line('question', 'Allow ' + (approval.toolName === '' ? 'this tool' : approval.toolName) + '?'))
  if (approval.reason !== '') form.append(line('detail', approval.reason))
  // The one-shot nature is stated rather than implied: the harness remembers no
  // grant, so a reader who reads this as standing permission would be wrong.
  form.append(line('oneshot', 'Applies to this one request only. The same action will ask again next time.'))
  for (const [outcome, label] of [['allowed-once', 'Allow once'], ['rejected', 'Reject']]) {
    const button = document.createElement('button')
    // Deliberately not a submit button: a permission has no field to fill in, so
    // there is nothing a submit event would add, and an implicit submission (a
    // hardware keyboard's Enter, a stray form submit) must never grant access.
    // The decision is a deliberate tap and nothing else.
    button.type = 'button'
    button.textContent = label
    button.addEventListener('click', () => decide(form, sessionId, approval.askId, outcome))
    form.append(button)
  }
  form.append(line('state', ''))
  if (states.has(approval.askId)) show(form, states.get(approval.askId))
  return form
}

// Queue one decision. Inert before the first await, so a double tap cannot queue
// two.
function decide (form, sessionId, askId, outcome) {
  show(form, 'Queued')
  outbox.queue(sessionId, { kind: 'approval', askId, outcome })
}

function line (className, text) {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

// While a decision is queued or sending the form is inert, so it cannot be sent
// twice. A rejected one opens again for another try.
function show (form, state) {
  form.inert = state !== 'Rejected'
  form.querySelector('.state').textContent = state === 'Rejected' ? 'Rejected — see the details below' : state
}
