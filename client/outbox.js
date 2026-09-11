// Guaranteed send.
//
// The POST response is not the confirmation. A message is delivered when the
// stream shows its user/message. That closes the lost-response hole and makes
// the indicator honest rather than optimistic: a reply that never arrived
// cannot make the page claim delivery.
//
// Retries are blind and unconditional, because durable dedup on the server
// makes a duplicate POST harmless.

import * as store from 'store'
import * as wire from 'wire'
import * as errors from 'errors'

let draining = false
let onChange = () => {}

export function observe (fn) {
  onChange = fn
}

// Write to storage before anything touches the network, then render Queued.
// `fields` is { text } for a prompt or { askId, answers } for an answer.
export async function queue (sessionId, fields) {
  const row = {
    clientMessageId: store.mintId(),
    sessionId,
    createdAt: Date.now(),
    state: 'Queued',
    ...fields
  }
  await store.enqueue(row)
  onChange(row)
  drain()
  return row
}

export async function drain () {
  if (draining) return
  draining = true
  try {
    for (const row of await store.pending()) {
      if (!navigator.onLine) break
      row.state = 'Sending'
      onChange(row)
      const url = row.askId === undefined ? '/api/send' : '/api/answer'
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
      if (!response.ok) {
        row.state = 'Rejected'
        onChange(row)
        await errors.fromResponse('POST', url, response, 'Outbox row: ' + JSON.stringify(row))
        await store.dequeue(row.clientMessageId)
        continue
      }
      try {
        wire.sendAccepted(await response.json())
      } catch (error) {
        row.state = 'Rejected'
        onChange(row)
        errors.show('The server accepted the prompt but answered unexpectedly', String(error))
        await store.dequeue(row.clientMessageId)
        continue
      }
      // A prompt is accepted, not delivered: the row leaves storage because the
      // server now owns it durably, and the indicator stays Sending until the
      // stream shows it. An accepted answer is delivered, because accepting it
      // is what hands it to the waiting tool call.
      await store.dequeue(row.clientMessageId)
      row.state = row.askId === undefined ? 'Sending' : 'Answered'
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
