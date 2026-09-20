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
  // A request carried up from a hidden child names it here. Without this the
  // form would read as this session's own question, which is the confusion
  // that hiding the child's row would otherwise create.
  if (ask.from !== undefined) form.append(line('from', 'Asked by ' + ask.from))
  for (const question of ask.questions) {
    form.append(line('question', question.header === '' ? question.question : question.header + ': ' + question.question))
    if (question.detail !== '') form.append(line('detail', question.detail))
    const choices = []
    for (const option of question.options) {
      const choice = document.createElement('input')
      choice.type = question.multiSelect ? 'checkbox' : 'radio'
      choice.name = question.id
      choice.value = option.label
      choice.className = 'pick'
      choices.push(choice)
      const label = document.createElement('label')
      label.append(choice, option.description === '' ? option.label : option.label + ' — ' + option.description)
      form.append(label)
    }
    // Typing your own answer is an option like any other, so it carries the
    // same control as the listed ones: one of several on a multi-select, and
    // one *instead* of them on a single-select, where the browser unticks the
    // listed options for us.
    const pick = document.createElement('input')
    pick.type = question.multiSelect ? 'checkbox' : 'radio'
    pick.name = question.id
    pick.value = ''
    pick.className = 'pick'
    const other = document.createElement('input')
    other.className = 'other'
    other.name = 'custom:' + question.id
    other.placeholder = question.options.length === 0 ? 'Your answer' : 'Type your own answer'
    // Typing is the choice; the tick only shows what typing already meant, so
    // nobody writes an answer that is silently dropped for want of a tap.
    other.addEventListener('input', () => { pick.checked = other.value.trim() !== '' })
    // Enter in a one-line field would otherwise submit the form implicitly.
    // Here it only finishes the field, leaving the answer to a deliberate tap
    // on Send answer.
    other.addEventListener('keydown', event => {
      if (event.key !== 'Enter') return
      event.preventDefault()
      other.blur()
    })
    const label = document.createElement('label')
    label.append(pick, other)
    form.append(label)
    // A single-select question is answered by exactly one control, so picking a
    // listed option clears the typed one. The browser already unticks the
    // free-text control for us; leaving its words behind would send a
    // single-select answer carrying *both* a label and free text, and the
    // harness refuses such an item as malformed — the whole batch with it, so
    // one leftover word costs every answer on the form.
    if (!question.multiSelect) {
      for (const choice of choices) {
        choice.addEventListener('change', () => { if (choice.checked) other.value = '' })
      }
    }
  }
  const send = document.createElement('button')
  send.textContent = 'Send answer'
  form.append(send, line('state', ''))
  form.addEventListener('submit', event => {
    event.preventDefault()
    const data = new FormData(form)
    const answers = ask.questions.map(question => {
      const custom = String(data.get('custom:' + question.id) ?? '').trim()
      // The free-text option's own control votes with an empty value, so it
      // marks the choice without ever becoming a selected label.
      const selected = data.getAll(question.id).map(String).filter(label => label !== '')
      const answer = { id: question.id, selected }
      // One control answers a single-select question, so only the ticked one
      // contributes: free text left behind by a later tap on a listed option is
      // residue, not a second answer. A multi-select admits both, because there
      // they are two independent choices rather than one either/or.
      if (custom !== '' && (question.multiSelect || selected.length === 0)) answer.custom = custom
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
