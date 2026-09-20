// Prove which `user/message` sources reach the transcript, over real logs.
//
//   node --experimental-strip-types scripts/verify-transcript-sources.mjs [storeRoot]
//
// The defect this guards: a child agent's report reaches its parent as an
// ordinary `user/message` event whose `source.kind` is not `user`, so a naive
// `kind !== 'user'` predicate discards it and the reader never sees the
// delegated run's findings. The fix admits exactly the child-agent kinds and
// gives them their own role, because crediting a child's words to the person is
// as wrong as dropping them.
//
// Two claims are checked, and both need real data:
//   - admission: each child kind actually occurring in a real log renders.
//   - no false positive: a human prompt still renders as `user`, and the
//     injected/instruction kinds are still dropped.
//
// It reads the real durable store because the shapes are its ground truth: a
// fixture would only assert what we already believe the log looks like.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { LogStore } from '../standalone/logstore.mjs'
import { renderEvent } from '../src/render.ts'

const root = process.argv[2] ?? '/root/.dsh/sessions'
const failures = []
function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

if (!existsSync(root)) {
  console.log(`SKIP  no durable store at ${root} — nothing to read`)
  process.exit(0)
}

const store = new LogStore(root)
/** The first real event seen for each source kind, with the log it came from. */
const sample = new Map()
for (const workspace of readdirSync(root)) {
  let ids; try { ids = readdirSync(join(root, workspace)) } catch { continue }
  for (const id of ids) {
    let record; try { record = await store.read(id) } catch { continue }
    if (record?.events === undefined) continue
    for (const event of record.events) {
      if (event.type !== 'user/message') continue
      const kind = String(event.data?.source?.kind)
      if (!sample.has(kind)) sample.set(kind, { event, sessionId: String(record.header.id) })
    }
  }
}

/** The role each real kind must render under, or null when it must be dropped. */
const EXPECTED = new Map([
  ['user', 'user'],
  ['webgui', 'user'],
  ['subagent-report', 'subagent'],
  ['subagent-settled', 'subagent'],
  ['agent-instructions', null],
  ['plugin', null],
  ['skill-catalog', null],
  ['skill-invocation', null],
  ['coordinator', null],
])

console.log(`source kinds observed in the real store (${sample.size}):`)
for (const [kind, { event, sessionId }] of [...sample].sort()) {
  const html = renderEvent(event, sessionId)
  const role = html === null ? null : /data-role="([a-z]+)"/.exec(html)?.[1] ?? '??'
  const expected = EXPECTED.get(kind)
  console.log(`  ${kind.padEnd(20)} -> ${role === null ? 'dropped' : `data-role="${role}"`}`
    + (expected === undefined ? '   [unclassified — add an expectation]' : ''))
  if (expected !== undefined) check(`real kind ${kind} renders as ${expected ?? 'dropped'}`, role === expected, `got ${role}`)
}

const child = sample.get('subagent-report') ?? sample.get('subagent-settled')
check('a real child report is admitted to the transcript', child !== undefined)
if (child !== undefined) {
  const html = renderEvent(child.event, child.sessionId)
  check('the child frame carries its own role, not the person\'s',
    /data-role="subagent"/.test(html ?? '') && !/data-role="user"/.test(html ?? ''))
  const body = (child.event.data.content ?? []).map(block => block.text ?? '').join('')
  check('the child frame keeps the report text', body.length === 0 || (html ?? '').includes(body.slice(0, 40)))
}

if (sample.has('webgui')) {
  const { event, sessionId } = sample.get('webgui')
  const html = renderEvent(event, sessionId) ?? ''
  check('the composer path still rides back as the person', /data-role="user"/.test(html))
}
for (const kind of ['agent-instructions', 'plugin', 'skill-catalog']) {
  if (!sample.has(kind)) continue
  const { event, sessionId } = sample.get(kind)
  check(`injected kind ${kind} is still dropped`, renderEvent(event, sessionId) === null)
}

console.log(failures.length === 0 ? '\nAll transcript-source checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
