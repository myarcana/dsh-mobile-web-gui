// Questions an agent is waiting on you to answer.
//
// They are held on the host and ride the session summaries, so a dropped
// signal, a slept radio or a reopened tab all come back to the same waiting
// question. An answer goes through the outbox like a prompt, so it survives
// all three too.

import * as outbox from 'outbox'
import * as view from 'view'

const host = document.getElementById('ask')

// askId -> the outbox state of its answer, so a rebuilt form never comes back
// editable after it was already answered.
const states = new Map()

// Show the questions one session is waiting on. `asks` undefined means not
// known yet, so that session's forms stay. A form that already exists is kept,
// so a summary refresh never throws away a half-made choice.
export function render (sessionId, asks) {
  for (const form of host.querySelectorAll('form')) {
    if (form.dataset.session !== sessionId || (asks !== undefined && !asks.some(ask => ask.askId === form.dataset.ask))) form.remove()
  }
  if (asks === undefined) return
  const stick = view.nearBottom()
  for (const ask of asks) {
    if (host.querySelector('[data-ask="' + CSS.escape(ask.askId) + '"]') === null) host.append(build(sessionId, ask))
  }
  view.toBottom(stick)
}

export function state (row) {
  states.set(row.askId, row.state)
  const form = host.querySelector('[data-ask="' + CSS.escape(row.askId) + '"]')
  if (form !== null) show(form, row.state)
}

function build (sessionId, ask) {
  const form = document.createElement('form')
  form.dataset.session = sessionId
  form.dataset.ask = ask.askId
  for (const question of ask.questions) {
    form.append(line('question', question.header === '' ? question.question : question.header + ': ' + question.question))
    if (question.detail !== '') form.append(line('detail', question.detail))
    for (const option of question.options) {
      const choice = document.createElement('input')
      choice.type = question.multiSelect ? 'checkbox' : 'radio'
      choice.name = question.id
      choice.value = option.label
      const label = document.createElement('label')
      label.append(choice, option.description === '' ? option.label : option.label + ' — ' + option.description)
      form.append(label)
    }
    const other = document.createElement('input')
    other.className = 'other'
    other.name = 'custom:' + question.id
    other.placeholder = question.options.length === 0 ? 'Your answer' : 'Or type another answer'
    form.append(other)
  }
  const send = document.createElement('button')
  send.textContent = 'Send answer'
  form.append(send, line('state', ''))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const data = new FormData(form)
    const answers = ask.questions.map(question => {
      const custom = String(data.get('custom:' + question.id) ?? '').trim()
      const answer = { id: question.id, selected: data.getAll(question.id).map(String) }
      if (custom !== '') answer.custom = custom
      return answer
    })
    // Inert before the first await, so a double tap cannot queue two answers.
    show(form, 'Queued')
    outbox.queue(sessionId, { askId: ask.askId, answers })
  })
  if (states.has(ask.askId)) show(form, states.get(ask.askId))
  return form
}

function line (className, text) {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

// While an answer is queued or sending the form is inert, so it cannot be sent
// twice. A rejected one opens again for another try.
function show (form, state) {
  form.inert = state !== 'Rejected'
  form.querySelector('.state').textContent = state === 'Rejected' ? 'Rejected — see the details below' : state
}
