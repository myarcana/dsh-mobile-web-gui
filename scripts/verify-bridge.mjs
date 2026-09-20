// Prove the question bridge against the harness that is actually running.
//
// The seam this exercises is not the one the plugin was written against, and the
// difference is invisible from the outside: a question simply never arrives. So
// this drives the real thing — the live mux socket on the host API and its
// /api/respond — rather than a stand-in that would agree with whatever we built.
//
//   node scripts/verify-bridge.mjs [origin]      default http://127.0.0.1:3080
//
// Read-only: it opens the stream, reports what is waiting, and settles nothing.

const origin = (process.argv[2] ?? 'http://127.0.0.1:3080').replace(/\/+$/, '')
const failures = []

function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

// 1. The settle half answers over plain HTTP, and says so for an id it does not
//    hold. `not-pending` is the proof it routed the id through the pending table
//    rather than rejecting the request shape.
let receipt
try {
  const response = await fetch(`${origin}/api/respond`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-response',
      rpcId: '00000000-0000-4000-8000-000000000000',
      result: { ok: true, value: {} },
    }),
  })
  receipt = await response.json()
  check('POST /api/respond answers', response.ok, `HTTP ${response.status}`)
} catch (error) {
  check('POST /api/respond answers', false, String(error))
}
check('an unknown rpcId is reported not-pending', receipt?.accepted === false && receipt?.reason === 'not-pending',
  JSON.stringify(receipt))

// 2. The intake half is a WebSocket, and it speaks the envelope the bridge parses.
const socket = new WebSocket(`${origin.replace(/^http/, 'ws')}/api/events.mux`)
const frames = []
const opened = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(false), 8_000)
  socket.addEventListener('open', () => { clearTimeout(timer); resolve(true) })
  socket.addEventListener('error', () => { clearTimeout(timer); resolve(false) })
})
check('GET /api/events.mux upgrades to a WebSocket', opened)

if (opened) {
  socket.addEventListener('message', event => {
    try {
      frames.push(JSON.parse(String(event.data)))
    } catch {
      // A frame that is not JSON is not this bridge's to read.
    }
  })
  // Listen briefly: the host announces its live sessions on attach, which is
  // enough to prove the envelope shape without waiting for a question to happen.
  await new Promise(resolve => setTimeout(resolve, 4_000))

  check('the stream delivers envelopes', frames.length > 0, `${frames.length} frames`)
  const shaped = frames.filter(f => typeof f.rpcId === 'string' && typeof f.payload === 'object' && f.payload !== null)
  check('envelopes carry rpcId and payload, as the bridge expects', shaped.length > 0,
    `${shaped.length} of ${frames.length}`)

  const questions = frames.filter(f => f.payload?.type === 'question/requested')
  console.log(`\n${questions.length} question(s) waiting right now.`)
  for (const frame of questions) {
    console.log(`  rpcId=${frame.rpcId} session=${frame.payload.sessionId}`)
    for (const q of frame.payload.questions ?? []) console.log(`    - ${q.question}`)
  }
  if (questions.length === 0) {
    console.log('  (none — ask_user_question is not waiting on anything on this harness)')
  }
  const kinds = [...new Set(frames.map(f => f.payload?.type).filter(Boolean))]
  console.log(`\nFrame types seen: ${kinds.join(', ') || '(none)'}`)
  socket.close()
}

console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
