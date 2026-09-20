// Prove a subagent session is off the list and still in the store.
//
//   node scripts/verify-hidden-subagents.mjs [origin]     default http://localhost:7788
//
// A fixture, not live data: the mock builds children at boot, and each one
// carries a different part of the claim.
//
//   subagent-audited-copy   an ordinary child — absent from the list
//   subagent-stray-review   a child in a directory no record owns — absent, and
//                           it must not mint a `cwd:` heading of its own
//   subagent-unnamed-child  a child with no `origin`, only `delegationDepth` —
//                           absent, proving the second signal stands alone
//   audit-drift             a child with a question AND a permission — absent,
//                           with both carried onto its parent `migration` and
//                           labelled with the child's name
//   subagent-blocked-on-you a child with a request and no visible ancestor — its
//                           own row is kept, the one case the hiding does not win
//
// Absence alone is also what a deletion looks like, so each hidden child is then
// fetched at its own URL. Hiding is display-only: the transcript must still
// render. A check that stopped at "not in the list" would pass just as happily
// against a store that had dropped the session.
//
// The mock's `origin` is set explicitly on the header rather than inferred, so
// this exercises the same discriminator the server filters on
// (`SessionHeader.origin === 'subagent'`, with `delegationDepth > 0` as the
// second signal) instead of a stand-in for it.

const origin = (process.argv[2] ?? 'http://localhost:7788').replace(/\/+$/, '')
const failures = []

function check (name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : ` — ${detail}`}`)
  if (!ok) failures.push(name)
}

const listing = await (await fetch(`${origin}/api/sessions`)).json()
const ids = new Set(listing.rows.map(row => row.id))

// ------------------------------------------------------------------ absent
check('an ordinary subagent child is off the list', !ids.has('subagent-audited-copy'))
check('a subagent child in an unowned directory is off the list', !ids.has('subagent-stray-review'))
// No `origin`, so `delegationDepth` is the only thing marking it a child.
check('a child carrying only delegationDepth is off the list', !ids.has('subagent-unnamed-child'))

// The child's cwd is `/home/dev/nowhere`, which no workspace record owns. Left
// visible it would be grouped by that directory and create a `cwd:` heading; the
// filter has to reach the heading pass too, not only the row pass.
const strays = listing.groups.filter(group => group.id.includes('nowhere') || group.id.includes('unrecorded'))
check('a hidden child cannot mint a heading of its own', strays.length === 0,
  strays.map(group => group.id).join(', ') || 'none')

// ------------------------------------------------- attribution to the parent
// A blocked child is not left visible as its own row: its request is carried
// onto its parent's row instead, labelled so it reads as the child asking rather
// than as the parent's own question. `audit-drift` is that child.
check('a child whose parent is visible is off the list', !ids.has('audit-drift'))
const parent = listing.rows.find(row => row.id === 'migration')
check('the parent keeps its own row', parent !== undefined)
const carriedAsk = parent?.asks.find(ask => ask.askId === 'mock-ask-child')
const carriedApproval = parent?.approvals.find(approval => approval.askId === 'mock-approval-child')
check('the child\'s question is carried onto the parent\'s row', carriedAsk !== undefined,
  JSON.stringify(parent?.asks.map(ask => ask.askId)))
check('the child\'s permission is carried onto the parent\'s row', carriedApproval !== undefined,
  JSON.stringify(parent?.approvals.map(approval => approval.askId)))
// The label must identify the CHILD, never the parent, or a carried request
// would read as the parent's own. It is the child's derived name once its log
// has been folded, and the child's id on the pass before that lands — both are
// the child, and the load-bearing claim is that neither is the parent.
const labels = [carriedAsk?.from, carriedApproval?.from]
check('every carried request names the child',
  labels.every(from => typeof from === 'string' && from !== '' && from !== 'migration' && from !== parent?.title),
  JSON.stringify(labels))
check('the carried question is labelled with the child\'s own name',
  labels[0] === 'audit-drift' || /audit drift/i.test(labels[0] ?? ''), String(labels[0]))
// The parent's own pending work is untouched by the carry: the two are different
// requests, filed under different children, and conflating them would let an
// answer reach the wrong tool call.
check('the parent\'s own question is still its own',
  parent?.asks.some(ask => ask.askId === 'mock-ask-2' && ask.from === undefined) === true,
  JSON.stringify(parent?.asks.map(ask => ({ id: ask.askId, from: ask.from ?? null }))))

// --------------------------------------------- no-ancestor reachability
// A child whose `parentSession` names no row on the list can be carried
// nowhere. Its own row is kept in that case: a waiting decision with no row
// anywhere is unreachable, which is worse than a child row the hiding would
// rather drop.
check('a blocked child with no visible ancestor keeps its row', ids.has('subagent-blocked-on-you'))
const stranded = listing.rows.find(row => row.id === 'subagent-blocked-on-you')
check('the kept row carries the request it could not hand up',
  stranded !== undefined && stranded.approvals.length === 1,
  stranded === undefined ? 'row absent' : `${stranded.approvals.length} approval(s)`)

// ------------------------------------------------------- still in the store
// Absence from the list must not mean absence from the store. The transcript URL
// is the store's own answer, so a 200 carrying rendered frames is the proof that
// nothing was deleted.
for (const [id, expected] of [
  ['subagent-audited-copy', 'Audit the copy build'],
  ['subagent-stray-review', 'Review the module'],
  ['subagent-unnamed-child', 'Check the unstamped child'],
  ['audit-drift', 'Audit the drift'],
]) {
  const response = await fetch(`${origin}/s/${id}`)
  const html = await response.text()
  check(`the hidden child ${id} still renders at its own URL`,
    response.ok && html.includes(expected) && !/Could not load/.test(html),
    `HTTP ${response.status}, carries its prompt: ${html.includes(expected)}`)
}

// ------------------------------------------------------------ the headings
// Hiding the children must not take the reader's own workspaces with them.
check('the reader\'s workspaces are still headings', listing.groups.length >= 3,
  `${listing.groups.length} heading(s): ${listing.groups.map(group => group.title).join(', ')}`)

await Promise.resolve()
console.log(failures.length === 0 ? '\nAll checks passed.' : `\n${failures.length} failed: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
