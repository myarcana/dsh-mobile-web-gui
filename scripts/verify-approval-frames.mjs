// Prove the approval frame path against the real `Bridge`.
//
//   node scripts/verify-approval-frames.mjs
//
// The question bridge is proven against the live harness in verify-bridge.mjs.
// This file is the approval half, and it cannot lean on the live box the same
// way: an approval only appears when a real agent hits a real escalation, which
// is not something a check can conjure. So the harness's own side is faked —
// a WebSocket mux and `/api/respond` with the exact shapes read out of the
// installed apiproxy — while the code under test is the shipped `Bridge`
// imported from `src/bridge.ts`, unmodified.
//
// What it proves, in order:
//   1. `approval/requested` is admitted at `take()` and surfaced to a session.
//   2. The decision POSTs the host's own body: the envelope `rpcId` addresses
//      `respond` while the *payload* `approvalId` is echoed in the value.
//   3. `approval/resolved` (which names the payload id, not the envelope one)
//      drops the waiting request, so a form settled elsewhere leaves the screen.
//   4. A resend of the same decision is a duplicate; an unknown id is not-ok.
//
// Read-only in spirit: it touches nothing on the box but its own loopback port.

import { createServer } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { Bridge } from '../src/bridge.ts'

const failures = []
let checks = 0

function check (name, ok, detail) {
  checks += 1
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/** Encode one unmasked server-to-client text frame (RFC 6455, server side). */
function encodeText (text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/** The settle bodies the fake host received, in order. */
const received = []
/** Live mux sockets, so a frame can be pushed on demand. */
const sockets = []
/**
 * The one request the fake host currently holds, or undefined when settled.
 *
 * A record rather than a bare id: the host validates the body against the
 * entry's *own* session and approval ids, so a check that compared against one
 * hardcoded pair would pass the first request and wrongly reject the next.
 */
let pending

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/respond') {
    const parts = []
    req.on('data', chunk => parts.push(chunk))
    req.on('end', () => {
      let body
      try {
        body = JSON.parse(Buffer.concat(parts).toString('utf8'))
      } catch {
        body = undefined
      }
      received.push(body)
      // The host's real answer, including the id-keyed routing: only the id it
      // holds is pending. Anything else is `not-pending`, which is what the
      // bridge must read as "already decided" rather than as a failure.
      if (body?.rpcId !== pending?.rpcId) return void res.end(JSON.stringify({ accepted: false, reason: 'not-pending' }))
      const value = body?.result?.value
      const shapeOk = body?.type === 'client-response'
        && body?.result?.ok === true
        && value?.approvalId === pending.approvalId
        && value?.sessionId === pending.sessionId
        && (value?.outcome === 'allowed-once' || value?.outcome === 'rejected')
      if (!shapeOk) return void res.end(JSON.stringify({ accepted: false, reason: 'bad-response' }))
      // A real settle is one-shot: the pending entry is gone afterwards.
      pending = undefined
      res.end(JSON.stringify({ accepted: true }))
    })
    return
  }
  res.writeHead(404)
  res.end()
})

server.on('upgrade', (req, socket) => {
  if (req.url !== '/api/events.mux') return socket.destroy()
  const key = req.headers['sec-websocket-key']
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))
  sockets.push(socket)
  socket.on('error', () => {})
})

/** Push one JSON frame down every mux socket. */
function push (frame) {
  const encoded = encodeText(JSON.stringify(frame))
  for (const socket of sockets) socket.write(encoded)
}

const SESSION_ID = 'session-775c37db-9731-47b2-8dec-f293e0ebf054'
const APPROVAL_ID = '4e98e5ba-44ef-4f81-9f84-a33b2b323f0d'
// The envelope id and the payload id are deliberately different, exactly as the
// captured frame on the live mux has them: conflating the two is the mistake
// that earns a silent `bad-response`.
const ENVELOPE_RPC_ID = 'ccfc9d80-37d3-4de6-98d9-ea8ed280928e'
pending = { rpcId: ENVELOPE_RPC_ID, approvalId: APPROVAL_ID, sessionId: SESSION_ID }

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

let changes = 0
const ctx = {
  logger: { info: () => {}, warn: () => {} },
  // The bridge ties its cleanup to the context; the test owns teardown instead.
  effect: () => () => {},
}

const bridge = new Bridge(ctx, origin, () => { changes += 1 })

// The socket dials in the constructor; give it a moment to handshake, then push
// the frame. Polling a real fact (the socket being open) rather than sleeping a
// guessed interval.
const deadline = Date.now() + 5_000
while (sockets.length === 0 && Date.now() < deadline) {
  await new Promise(resolve => setTimeout(resolve, 25))
}
check('the bridge dials the mux and upgrades', sockets.length === 1, `${sockets.length} socket(s)`)

// ---------------------------------------------------------------- 1. intake
push({
  type: 'server-request',
  rpcId: ENVELOPE_RPC_ID,
  method: 'approval/requested',
  payload: {
    type: 'approval/requested',
    sessionId: SESSION_ID,
    approvalId: APPROVAL_ID,
    toolName: 'bash',
    callId: 'toolu_01TBwvQzhBMM5amgYqWoT6BX',
    reason: 'escalate sandbox to danger-full-access: Restarting the dsh-web-gui service requires access to the systemd bus outside the workspace sandbox, which the user explicitly asked for.',
  },
})
await new Promise(resolve => setTimeout(resolve, 150))

const waiting = bridge.approvalsOf(SESSION_ID)
check('the approval/requested frame is admitted', waiting.length === 1, `${waiting.length} waiting`)
check('the request is filed under its own session',
  bridge.approvalsOf('session-somewhere-else').length === 0)
check('the tool name survives intake', waiting[0]?.toolName === 'bash', JSON.stringify(waiting[0]))
check('the reason survives intake', typeof waiting[0]?.reason === 'string' && waiting[0].reason.startsWith('escalate sandbox'),
  JSON.stringify(waiting[0]?.reason))
check('the waiting request is keyed by the envelope id', waiting[0]?.askId === ENVELOPE_RPC_ID,
  `${waiting[0]?.askId} vs ${ENVELOPE_RPC_ID}`)
check('the summary changed when the request arrived', changes >= 1, `${changes} change(s)`)

// A question frame must still be untouched by the approval path: the same
// socket carries both, and the two maps are separate.
push({
  type: 'server-request',
  rpcId: 'question-envelope-id',
  method: 'question/requested',
  payload: { type: 'question/requested', sessionId: SESSION_ID, questions: [{ id: 'q1', question: 'Which?' }] },
})
await new Promise(resolve => setTimeout(resolve, 100))
check('a question frame on the same socket still lands', bridge.of(SESSION_ID).length === 1,
  `${bridge.of(SESSION_ID).length} question(s)`)
check('the question did not leak into the approvals map', bridge.approvalsOf(SESSION_ID).length === 1)

// ---------------------------------------------------------------- 2. settle
const settled = await bridge.settle(ENVELOPE_RPC_ID, 'outbox-key-1', 'allowed-once')
check('an allow is accepted by the host', settled.ok === true && settled.duplicate === false, JSON.stringify(settled))
const body = received[received.length - 1]
check('the decision addresses respond with the envelope rpcId', body?.rpcId === ENVELOPE_RPC_ID,
  JSON.stringify(body?.rpcId))
check('the response value echoes the payload approvalId, not the envelope id',
  body?.result?.value?.approvalId === APPROVAL_ID, JSON.stringify(body?.result?.value))
check('the response value carries the session and the outcome',
  body?.result?.value?.sessionId === SESSION_ID && body?.result?.value?.outcome === 'allowed-once',
  JSON.stringify(body?.result?.value))
check('the settled request leaves the waiting set', bridge.approvalsOf(SESSION_ID).length === 0)

// ------------------------------------------------------- 3. duplicate + races
const again = await bridge.settle(ENVELOPE_RPC_ID, 'outbox-key-1', 'allowed-once')
check('a resend of the same decision is a duplicate, not a refusal',
  again.ok === true && again.duplicate === true, JSON.stringify(again))
const beforeDup = received.length
await bridge.settle(ENVELOPE_RPC_ID, 'outbox-key-2', 'allowed-once')
// The host no longer holds the id, so nothing should have been posted a second
// time for a request this bridge already saw settled.
check('a second, different decision is answered from the bridge, not re-posted',
  received.length === beforeDup, `${received.length - beforeDup} extra POST(s)`)

const unknown = await bridge.settle('no-such-request', 'outbox-key-3', 'rejected')
check('an unknown id is refused with the bridge\'s own words',
  unknown.ok === false && typeof unknown.reason === 'string' && unknown.reason.includes('no longer waiting'),
  JSON.stringify(unknown))

// ------------------------------------------------------------- 4. resolution
// A second request, settled from *elsewhere* this time: the frame names the
// payload approvalId, which is the field the bridge must match on.
const OTHER_RPC = 'aaaa1111-2222-4333-8444-555566667777'
const OTHER_APPROVAL = 'bbbb9999-8888-4777-8666-555544443333'
pending = { rpcId: OTHER_RPC, approvalId: OTHER_APPROVAL, sessionId: SESSION_ID }
push({
  type: 'server-request',
  rpcId: OTHER_RPC,
  method: 'approval/requested',
  payload: { type: 'approval/requested', sessionId: SESSION_ID, approvalId: OTHER_APPROVAL, toolName: 'bash' },
})
await new Promise(resolve => setTimeout(resolve, 120))
check('a request with no reason or call id is still admitted',
  bridge.approvalsOf(SESSION_ID).length === 1, `${bridge.approvalsOf(SESSION_ID).length} waiting`)
check('the missing reason degrades to a blank, not a dropped request',
  bridge.approvalsOf(SESSION_ID)[0]?.reason === '', JSON.stringify(bridge.approvalsOf(SESSION_ID)[0]))

push({
  type: 'server-request',
  rpcId: randomUUID(),
  method: 'approval/resolved',
  payload: { type: 'approval/resolved', sessionId: SESSION_ID, approvalId: OTHER_APPROVAL, outcome: 'cancelled' },
})
await new Promise(resolve => setTimeout(resolve, 120))
check('approval/resolved drops the request it names by payload id',
  bridge.approvalsOf(SESSION_ID).length === 0, `${bridge.approvalsOf(SESSION_ID).length} still waiting`)
check('the question raised earlier is untouched by the approval resolution',
  bridge.of(SESSION_ID).length === 1, `${bridge.of(SESSION_ID).length} question(s)`)

// A reject travels the same road as an allow and must reach the host too.
const REJECT_RPC = 'dddd0000-1111-4222-8333-444455556666'
const REJECT_APPROVAL = 'eeee7777-6666-4555-8444-333322221111'
pending = { rpcId: REJECT_RPC, approvalId: REJECT_APPROVAL, sessionId: SESSION_ID }
push({
  type: 'server-request',
  rpcId: REJECT_RPC,
  method: 'approval/requested',
  payload: { type: 'approval/requested', sessionId: SESSION_ID, approvalId: REJECT_APPROVAL, toolName: 'bash', reason: 'why' },
})
await new Promise(resolve => setTimeout(resolve, 120))
const rejected = await bridge.settle(REJECT_RPC, 'outbox-key-reject', 'rejected')
check('a reject is accepted by the host too', rejected.ok === true, JSON.stringify(rejected))
check('the reject travels as its own word',
  received[received.length - 1]?.result?.value?.outcome === 'rejected',
  JSON.stringify(received[received.length - 1]?.result?.value))

server.close()
for (const socket of sockets) socket.destroy()

console.log(`\n${checks - failures.length}/${checks} checks passed.`)
if (failures.length > 0) console.log(`failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
