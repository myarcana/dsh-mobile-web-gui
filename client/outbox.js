// Guaranteed send.
//
// Every row is written to storage before anything touches the network, and a
// prompt stays there until the transcript shows its durable user/message — not
// merely until the POST is accepted. So a reload, a closed tab, or a week of no
// signal never loses a prompt, and never loses sight of one either: whatever this
// device still holds is drawn under the session it was typed in, with its state.
//
// A prompt row's state is what this device knows first-hand:
//   Queued    — saved here, not yet sent (no signal, or a send that dropped)
//   Sending   — a POST is in flight right now (memory only; a reload is Queued)
//   Accepted  — the server answered OK; kept until the transcript shows it
//   Rejected  — the server refused it and said why (memory only)
// The page combines this with the server's own `sending` list, which covers the
// one fact this device can miss: an acceptance whose response was lost.
//
// Retries are blind and unconditional, because durable dedup on the server
// makes a duplicate POST harmless. Answers and approvals settle on their POST
// response, because accepting them is what hands them to the waiting tool call.

import * as store from 'store'
import * as wire from 'wire'
import * as errors from 'errors'

// clientMessageId -> row. The memory copy of storage, read synchronously when a
// session paints, so its local prompts appear in the same frame as its transcript.
const rows = new Map()
let draining = false
let onChange = () => {}

export function observe (fn) {
  onChange = fn
}

export async function boot () {
  await adopt()
}

// Take in rows this tab has not seen — written before a reload, or by another
// tab. Never overwrites a row already held: this tab's copy is the newer one.
async function adopt () {
  for (const row of await store.pending()) {
    if (rows.has(row.clientMessageId)) continue
    // A stored row is either accepted or not sent yet. Anything else is a word
    // from a page that was closed mid-send, which is exactly "not sent yet".
    if (row.state !== 'Accepted') row.state = 'Queued'
    rows.set(row.clientMessageId, row)
  }
}

function isPrompt (row) {
  return row.kind !== 'approval' && row.askId === undefined
}

// This device's prompts for one session that the transcript has not shown yet,
// oldest first, so they draw in the order they were typed.
export function prompts (sessionId) {
  return [...rows.values()]
    .filter(row => row.sessionId === sessionId && isPrompt(row))
    .sort((a, b) => a.createdAt - b.createdAt)
}

// The transcript shows this prompt, so this device stops holding it. Called for
// every durable prompt on screen; a key this device never held is a no-op.
export function delivered (clientMessageId) {
  if (!rows.delete(clientMessageId)) return
  store.dequeue(clientMessageId)
}

// `fields` is { text } for a prompt, { askId, answers } for an answer, or
// { kind: 'approval', askId, outcome } for a permission decision.
export async function queue (sessionId, fields) {
  const row = {
    clientMessageId: store.mintId(),
    sessionId,
    createdAt: Date.now(),
    state: 'Queued',
    ...fields
  }
  rows.set(row.clientMessageId, row)
  await store.enqueue(row)
  onChange(row, true)
  drain()
  return row
}

export async function drain () {
  if (draining) return
  draining = true
  try {
    await adopt()
    const queued = [...rows.values()]
      .filter(row => row.state === 'Queued')
      .sort((a, b) => a.createdAt - b.createdAt)
    for (const row of queued) {
      if (!navigator.onLine) break
      row.state = 'Sending'
      onChange(row)
      // Three kinds of row share one outbox, and two of them carry an `askId`
      // (an answer names the question, a decision names the permission), so
      // `askId` alone cannot say which route to post to. A row that predates the
      // `kind` field falls back to the `askId === undefined` test.
      const url = row.kind === 'approval'
        ? '/api/decide'
        : row.askId === undefined ? '/api/send' : '/api/answer'
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(row)
        })
      } catch (error) {
        // No signal. Stay queued; the next drain trigger tries again.
        row.state = 'Queued'
        onChange(row)
        break
      }
      let refusal = null
      if (!response.ok) {
        refusal = () => errors.fromResponse('POST', url, response, 'Outbox row: ' + JSON.stringify(row))
      } else {
        try {
          wire.sendAccepted(await response.json())
        } catch (error) {
          refusal = () => errors.show('The server accepted the prompt but answered unexpectedly', String(error))
        }
      }
      if (refusal !== null) {
        row.state = 'Rejected'
        // A refused prompt stays drawn for the life of this page so its text is
        // not lost from sight; nothing will send it again.
        if (!isPrompt(row)) rows.delete(row.clientMessageId)
        await store.dequeue(row.clientMessageId)
        onChange(row)
        await refusal()
        continue
      }
      if (isPrompt(row)) {
        // Accepted, not delivered. Kept until the transcript shows it, so a page
        // closed in between still draws it on return. Not re-stored when the
        // transcript already retired it while this POST was in flight.
        row.state = 'Accepted'
        row.acceptedAt = Date.now()
        if (rows.has(row.clientMessageId)) await store.enqueue(row)
      } else {
        rows.delete(row.clientMessageId)
        await store.dequeue(row.clientMessageId)
        row.state = row.kind === 'approval' ? 'Decided' : 'Answered'
      }
      onChange(row)
    }
  } finally {
    draining = false
  }
}

// Drain on the events that mean the network may have come back. Never on
// unload, which costs the back/forward cache.
export function listen () {
  addEventListener('online', drain)
  addEventListener('pageshow', drain)
  addEventListener('visibilitychange', () => { if (!document.hidden) drain() })
}
