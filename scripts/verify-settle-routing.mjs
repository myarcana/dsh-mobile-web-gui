// Prove an answer tapped on the PARENT's screen settles the CHILD's ask.
//
//   node scripts/verify-settle-routing.mjs
//
// Attribution is display only. Once a hidden child's question is carried onto an
// ancestor's row, the form the reader taps is identical to the parent's own — so
// the thing that must not break is the routing underneath it: the settle has to
// address the request by its own id and name the CHILD's session. If it named the
// parent's, the answer would land on the wrong session and the child would hang
// forever, which is invisible from the screen that looks correct.
//
// This drives the shipped `Bridge` (imported unmodified) against a fake host that
// records the body it receives. The host is faked because a real approval only
// appears when a real agent escalates, which a check cannot conjure; the code
// under test is the real one.
//
// Read-only in spirit: it touches nothing on the box but its own loopback port.

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { Bridge } from '../src/bridge.ts'

const failures = []
function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

/** Encode one unmasked server-to-client text frame (RFC 6455, server side). */
function encodeText (text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) header = Buffer.from([0x81, len])
  else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2) }
  return Buffer.concat([header, payload])
}

/** The settle bodies the fake host received, in order. */
const received = []
/** Live mux sockets, so a frame can be pushed on demand. */
const sockets = []
/** The request the fake host currently holds, or undefined once settled. */
let pending
/**
 * Whether the fake host should refuse the next payload as malformed.
 *
 * The real host answers `bad-response` when it will not accept the *payload*,
 * which is a different thing from `not-pending` — the request is untouched and
 * still waiting. A check needs to be able to produce that refusal on demand.
 */
let refuse = false

const server = createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/respond') {
    const parts = []
    req.on('data', chunk => parts.push(chunk))
    req.on('end', () => {
      let body
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { body = undefined }
      received.push(body)
      if (body?.rpcId !== pending?.rpcId) return void res.end(JSON.stringify({ accepted: false, reason: 'not-pending' }))
      if (refuse) return void res.end(JSON.stringify({ accepted: false, reason: 'bad-response' }))
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

function push (frame) {
  const encoded = encodeText(JSON.stringify(frame))
  for (const socket of sockets) socket.write(encoded)
}

// The child that holds the request, and the PARENT whose row the reader answers
// from. Different ids on purpose: if the settle used the parent's, the answer
// would be routed to the wrong session and the child would never wake.
const CHILD = 'child-audit-drift-0001'
const PARENT = 'parent-migration-0002'
const ENVELOPE_RPC = 'ccfc9d80-37d3-4de6-98d9-ea8ed280928e'
// The fake host holds exactly this request until it is settled. Set before the
// server listens, because a settle arriving with nothing pending is answered
// `not-pending` — the race the bridge must read as "already decided".
pending = { rpcId: ENVELOPE_RPC }

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const ctx = { logger: { info: () => {}, warn: () => {} }, effect: () => () => {} }
const bridge = new Bridge(ctx, origin, () => {})

const deadline = Date.now() + 5_000
while (sockets.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
check('the bridge dials the mux and upgrades', sockets.length === 1, `${sockets.length} socket(s)`)

// The harness raises the question against the CHILD's session id, exactly as it
// would for a child resumed as its own root.
push({
  type: 'server-request',
  rpcId: ENVELOPE_RPC,
  method: 'question/requested',
  payload: { type: 'question/requested', sessionId: CHILD, questions: [{ id: 'scope', question: 'Which modules?' }] },
})
await new Promise(r => setTimeout(r, 150))

const onChild = bridge.of(CHILD)
const onParent = bridge.of(PARENT)
check('the question is filed under the CHILD, not the parent',
  onChild.length === 1 && onParent.length === 0, `child=${onChild.length} parent=${onParent.length}`)
check('the ask is addressed by the envelope rpc id', onChild[0]?.askId === ENVELOPE_RPC, String(onChild[0]?.askId))

// Exactly what the browser does when the reader taps Send answer on the PARENT's
// screen: the askId comes from the form, which carries the child's request.
const result = await bridge.answer(ENVELOPE_RPC, 'outbox-key-1', [{ id: 'scope', selected: ['All of them'] }])
check('the answer is accepted', result.ok === true, JSON.stringify(result))

const body = received[received.length - 1]
check('the settle names the CHILD session, not the parent',
  body?.result?.value?.sessionId === CHILD, JSON.stringify(body?.result?.value?.sessionId))
check('the settle does not name the parent anywhere',
  JSON.stringify(body ?? {}).includes(PARENT) === false, JSON.stringify(body))
check('the settle addresses respond by the request id', body?.rpcId === ENVELOPE_RPC, String(body?.rpcId))

// ------------------------------------------- a refusal is not a lost question
// The failure this guards: the host refuses the *payload* (`bad-response`) and
// the bridge forgot the ask anyway, so the form left every screen and the turn
// stayed blocked with nothing left to answer. A malformed answer must not be
// able to destroy the question it failed to answer.
//
// A fresh question on its own id, because the one above is settled.
const REFUSED_RPC = '4bb903fa-e580-432c-8e09-b0428397f074'
pending = { rpcId: REFUSED_RPC }
refuse = true
push({
  type: 'server-request',
  rpcId: REFUSED_RPC,
  method: 'question/requested',
  payload: {
    type: 'question/requested',
    sessionId: CHILD,
    questions: [{ id: 'label', question: 'How should this read?', options: [{ label: 'Keep as-is' }, { label: 'Rewrite it' }] }],
  },
})
await new Promise(r => setTimeout(r, 150))

// Exactly the shape the browser used to send: a chosen label *and* free text on
// a single-select question.
const refused = await bridge.answer(REFUSED_RPC, 'outbox-key-2', [
  { id: 'label', selected: ['Keep as-is'], custom: 'Students do this before the lesson' },
])
check('a payload refusal is reported as a failure', refused.ok === false, JSON.stringify(refused))
check('and it says the question is STILL waiting, not gone',
  refused.stillWaiting === true, JSON.stringify(refused))
check('the refused ask is still on the session, so its form stays on screen',
  bridge.of(CHILD).some(ask => ask.askId === REFUSED_RPC),
  JSON.stringify(bridge.of(CHILD).map(ask => ask.askId)))
check('the refusal quotes the host\'s own reason',
  /bad-response/.test(refused.reason ?? ''), refused.reason)

// The reader corrects the answer and resends, which is the recovery the refusal
// has to leave open. `not-pending` still means the question is gone, so the two
// refusals must not be conflated.
refuse = false
const corrected = await bridge.answer(REFUSED_RPC, 'outbox-key-3', [{ id: 'label', selected: ['Keep as-is'] }])
check('the corrected answer settles after a refusal', corrected.ok === true, JSON.stringify(corrected))
check('a settled ask leaves the session',
  bridge.of(CHILD).every(ask => ask.askId !== REFUSED_RPC),
  JSON.stringify(bridge.of(CHILD).map(ask => ask.askId)))

// And the other refusal, unchanged: a question someone else already answered is
// genuinely gone, so it must be dropped rather than left on screen forever.
pending = { rpcId: 'envelope-elsewhere' }
refuse = false
const absent = await bridge.answer('envelope-absent', 'outbox-key-4', [{ id: 'label', selected: ['Keep as-is'] }])
check('an ask the bridge never held is reported gone, not still-waiting',
  absent.ok === false && absent.stillWaiting === false, JSON.stringify(absent))

server.close()
for (const socket of sockets) socket.destroy()

console.log(failures.length === 0 ? '\nAll routing checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
