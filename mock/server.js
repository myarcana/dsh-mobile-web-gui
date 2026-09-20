// A stand-in harness, for trying the GUI without one. The real server code runs
// against a fake of the few context members it touches: three sessions, two of
// them already waiting on questions.
//
//   node mock/server.js    then open http://localhost:7788 (any hostname works)
//
// A prompt gets a streamed echo. A prompt with the word "ask" in it makes the
// agent ask a free-text question. Stop cancels a waiting question.

import { fileURLToPath } from 'node:url'
import { loadAssets } from '../src/assets.ts'
import { listen } from '../src/http.ts'
import { StreamHub } from '../src/stream.ts'

const PORT = Number(process.env.PORT ?? 7788)
const hooks = new Map()
const sessions = new Map()
// The registry-global archive set. Starts empty, so every fixture session is
// visible until one is archived through the GUI.
const archivedSessions = new Set()
// Two records sharing a display title, which is legal, plus one session no
// record owns — the three grouping cases worth seeing on screen. `ws-new` is
// deliberate: a workspace holding no sessions must still render a heading, so
// the case the real box hit (a registered project with no work in it yet) is
// exercised here rather than only in production.
// Real checkouts on disk, made by scripts/make-fixtures.sh, so the worktree
// level is read from git the same way it is on the real box rather than from a
// table of pretend answers. Absent until that script has run, in which case
// those workspaces simply list no sessions — the mock still boots.
const FIXTURES = fileURLToPath(new URL('../.fixtures/', import.meta.url))
const workspaces = new Map([
  ['ws-new', { id: 'ws-new', title: 'new-project', path: '/home/dev/new-project', sessionIds: [] }],
  ['ws-billing', { id: 'ws-billing', title: 'billing', path: '/home/dev/billing', sessionIds: [] }],
  ['ws-infra', { id: 'ws-infra', title: 'infra', path: '/home/dev/infra', sessionIds: [] }],
  ['ws-other', { id: 'ws-other', title: 'billing', path: '/home/dev/other-billing', sessionIds: [] }],
  // The three-level case: one workspace over two working trees over their
  // sessions. The workspace path is the project directory holding the bare repo
  // and its worktrees, which is how the real box is laid out.
  ['ws-lbc', { id: 'ws-lbc', title: 'language-boss-and-choc', path: FIXTURES + 'language-boss-and-choc', sessionIds: [] }],
  ['ws-dmwg', { id: 'ws-dmwg', title: 'dsh-mobile-web-gui', path: FIXTURES + 'dsh-mobile-web-gui', sessionIds: [] }],
  ['ws-mak', { id: 'ws-mak', title: 'my-android-keyboard', path: FIXTURES + 'my-android-keyboard', sessionIds: [] }]
])

const ctx = {
  logger: { info: console.log, warn: console.warn },
  effect () {},
  // Cordis' safe service accessor: undefined for an unregistered name, which is
  // how the plugin detects a profile that mounts no gateway or picker.
  get (name) { return ctx[name] },
  // The optional-dependency idiom the host uses for services a profile may not
  // install. The mock answers it eagerly so grouping and archive filtering are
  // exercised, exactly as they are on the real box.
  inject (names, callback) {
    const child = Object.assign(Object.create(null), ctx)
    for (const name of names) child[name] = ctx[name]
    callback(child)
    return () => true
  },
  on (name, listener, prepend) {
    const list = hooks.get(name) ?? []
    if (prepend) list.unshift(listener)
    else list.push(listener)
    hooks.set(name, list)
    return () => true
  },
  agents: {
    get: id => sessions.get(id),
    roots: () => [...sessions.values()]
  },
  sessionQuery: {
    // The installed 0.1.1 engine exposes readSession/listSessions; the mock
    // mirrors that surface so the GUI cannot pass against a shape the real host
    // does not have.
    async readSession (id) {
      const s = sessions.get(id)
      if (s === undefined) throw new Error('No mock session ' + id)
      return { session: { id, createdAt: s.createdAt, cwd: s.cwd, ...subagentOf(s) }, events: s.events.slice() }
    },
    async listSessions () {
      return [...sessions.values()].map(s => ({
        header: { id: s.id, createdAt: s.createdAt, cwd: s.cwd, ...subagentOf(s) },
        live: true,
        persisted: false
      }))
    }
  },
  workspaceRegistry: {
    list: () => [...workspaces.values()]
      .map(w => ({ id: w.id, title: w.title, path: w.path, sessionIds: [...w.sessionIds] })),
    get: id => workspaces.get(id),
    // Mirrors the real registry: adopts an existing directory, idempotently.
    async create (path) {
      for (const w of workspaces.values()) if (w.path === path) return w
      const id = 'ws-' + path.split('/').filter(Boolean).pop()
      const record = {
        id,
        title: path.split('/').filter(Boolean).pop() ?? '/',
        path,
        sessionIds: [],
        async attachSession (sessionId) { this.sessionIds.unshift(sessionId) }
      }
      workspaces.set(id, record)
      return record
    },
    // The registry-global archive set, mirrored from the real registry: hiding a
    // session never touches workspace accounting, so the id keeps its slot and
    // only the listing filter reacts.
    get archivedSessionIds () { return [...archivedSessions] },
    // Idempotent, like the real one: archiving an id twice resolves without
    // writing, which is what makes a retry after a lost response harmless. An
    // unknown session is refused, so the error path is reachable here too.
    async archiveSession (sessionId) {
      if (!sessions.has(sessionId)) throw new Error('mock: no such session ' + sessionId)
      archivedSessions.add(sessionId)
    }
  },
  // Stands in for the host API face, so the create path is exercised rather
  // than the no-gateway fallback.
  apiProxy: {
    sessions: {
      async create (request) {
        const payload = request.payload
        const id = payload.sessionId
        const cwd = payload.cwd ?? '/home/dev'
        session(id, 'New session', cwd)
        if (payload.workspaceId !== undefined) owns(payload.workspaceId, id)
        return { rpcId: request.rpcId, result: { ok: true, value: { sessionId: id } } }
      }
    }
  },
  // The browse backend: one level at a time, paths never joined by the client.
  directoryPicker: {
    capability: () => ({
      kind: 'browse',
      async list (path) {
        const at = path ?? '/home/dev'
        const here = LISTING[at]
        if (here === undefined) throw new Error('mock: no listing for ' + at)
        return {
          path: at,
          home: '/home/dev',
          crumbs: (here.crumbs ?? []).map(name => ({ name, path: name, hidden: false })),
          entries: here.entries.map(name => ({
            name,
            path: at + (at.endsWith('/') ? '' : '/') + name,
            hidden: name.startsWith('.')
          })),
          truncated: false
        }
      },
      async createDirectory (path, name) { return path + (path.endsWith('/') ? '' : '/') + name }
    })
  }
}

/** A tiny fake filesystem for the browse backend. */
const LISTING = {
  '/': { entries: ['home'], crumbs: ['/'] },
  '/home': { entries: ['dev'], crumbs: ['/', '/home'] },
  '/home/dev': { entries: ['.config', 'billing', 'infra', 'new-project', 'other-billing'], crumbs: ['/', '/home', '/home/dev'] },
  '/home/dev/billing': { entries: [], crumbs: ['/', '/home', '/home/dev', '/home/dev/billing'] },
  '/home/dev/infra': { entries: [], crumbs: ['/', '/home', '/home/dev', '/home/dev/infra'] },
  '/home/dev/new-project': { entries: [], crumbs: ['/', '/home', '/home/dev', '/home/dev/new-project'] },
  '/home/dev/other-billing': { entries: [], crumbs: ['/', '/home', '/home/dev', '/home/dev/other-billing'] }
}

function emit (name, ...args) {
  for (const listener of hooks.get(name) ?? []) listener(...args)
}

// Each listener wraps the rest of the chain, as cordis runs a waterfall.
function waterfall (name, request) {
  const list = hooks.get(name) ?? []
  const run = i => i < list.length
    ? list[i](request, () => run(i + 1))
    : Promise.reject(new Error('NO_PROVIDER: no answerer claimed the question'))
  return run(0)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/**
 * Whether an answer batch is one the harness would accept.
 *
 * The harness's own rule (`matchesQuestions` in `dsh-host-apiproxy`): one answer
 * per question in order, ids matching, no duplicate or unknown labels, no empty
 * custom text — and for a **single-select** question, a chosen label and free
 * text are mutually exclusive, because one control answers it. A multi-select
 * may carry both, since there they are two independent choices. A refusal is
 * `bad-response` and costs the whole batch, so this is a guard on the shape the
 * browser sends rather than a detail of one question.
 * @param answers - the batch the browser sent.
 * @param questions - the questions it was answering.
 * @returns true when the harness would accept it.
 */
function matchesQuestions (answers, questions) {
  if (!Array.isArray(answers) || answers.length !== questions.length) return false
  return answers.every((answer, index) => {
    const question = questions[index]
    if (answer?.id !== question.id) return false
    const selected = answer.selected ?? []
    if (!Array.isArray(selected) || new Set(selected).size !== selected.length) return false
    const custom = answer.custom?.trim()
    if (custom !== undefined && custom === '') return false
    if (question.multiSelect !== true) {
      if (custom !== undefined && selected.length > 0) return false
      if (selected.length > 1) return false
    }
    const labels = new Set((question.options ?? []).map(option => option.label))
    return selected.every(label => labels.has(label))
  })
}

function session (id, title, cwd, meta = {}) {
  const s = {
    id,
    cwd,
    // Present only on a subagent child, absent on a session the reader started —
    // the same shape the harness writes, so the filter is exercised against the
    // real discriminator rather than a stand-in for it.
    origin: meta.origin,
    delegationDepth: meta.delegationDepth,
    parentSession: meta.parentSession,
    createdAt: Date.now() - 3_600_000,
    events: [],
    status: 'idle',
    turn: 0,
    inbox: { nextTurn: [], nextStep: [] },
    question: null,
    steer (message) { prompt(s, message) },
    cancel () { s.question?.abort() }
  }
  // The live-session shape the real host exposes: `agent.session.id/.header/.events`.
  // Getters, because the log is appended in place and a snapshot would go stale.
  s.session = {
    id,
    get header () { return { id, createdAt: s.createdAt, cwd: s.cwd, ...subagentOf(s) } },
    get events () { return s.events }
  }
  sessions.set(id, s)
  add(s, 'session/title', { title })
  return s
}

/**
 * The subagent fields of one session's header, spread into it only when set.
 *
 * Absent rather than `undefined`, because that is what a top-level session's
 * header looks like: a key present with an undefined value would make every
 * ordinary session carry the subagent discriminator.
 * @param s - the mock session.
 * @returns the `origin`/`delegationDepth` pair, or nothing for a top-level one.
 */
function subagentOf (s) {
  const out = {}
  if (s.origin !== undefined) out.origin = s.origin
  if (s.delegationDepth !== undefined) out.delegationDepth = s.delegationDepth
  // The listing walks this link to carry a hidden child's pending request onto
  // the ancestor that answers it, so a fixture without it would exercise the
  // filter but never the attribution.
  if (s.parentSession !== undefined) out.parentSession = s.parentSession
  return out
}

/** File a session under a workspace record, the way the registry does. */
function owns (workspaceId, id) {
  workspaces.get(workspaceId)?.sessionIds.push(id)
}

function add (s, type, data) {
  const event = { type, seq: s.events.length, time: Date.now(), data }
  if (type === 'user/message' || type === 'assistant/message' || type === 'tool/result') event.surfaceOp = 'append'
  s.events.push(event)
  emit('session/event', s, event)
}

function user (s, text) {
  add(s, 'user/message', { content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function say (s, text) {
  add(s, 'assistant/message', { turn: s.turn, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }] }, stream: [] })
}

function call (s, name, args) {
  const callId = 'call-' + s.events.length
  add(s, 'tool/call', { turn: s.turn, step: 0, callId, name, arguments: JSON.stringify(args) })
  return callId
}

function result (s, callId, text, isError) {
  add(s, 'tool/result', {
    turn: s.turn,
    step: 0,
    // `toolCallId` is the field a real `ToolResultBlock` carries, and it is what
    // pairs an answer with the question it settles. The mock used to say
    // `callId`, which nothing could match, so the fixture quietly failed to
    // exercise that pairing at all.
    message: { role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, isError, content: [{ type: 'text', text }] }] }
  })
}

// The ask_user_question tool: a durable call, a wait for a person, then a
// durable result.
//
// The question is registered with the hub's bridge rather than pushed through an
// event. On the real box the bridge mirrors questions from the harness's own
// provider (which this GUI does not own) and answers them over its HTTP API;
// this mock *is* the harness, so it holds the promise itself and hands the
// bridge the pair of callbacks that settle it. Either way the browser sees one
// waiting question and answers it through `POST /api/answer`.
let nextAskId = 0

async function ask (s, questions) {
  const callId = call(s, 'ask_user_question', { questions })
  const controller = new AbortController()
  s.question = controller
  const askId = 'mock-ask-' + (nextAskId += 1)
  let settle
  const waiting = new Promise((resolve, reject) => { settle = { resolve, reject } })
  const release = hub.questions.hold(askId, s.id, questions)
  const onAbort = () => { settle.reject(new Error('the question was cancelled')) }
  controller.signal.addEventListener('abort', onAbort, { once: true })
  // One settler per waiting question; the bridge refuses a second answer for it.
  hub.questions.onLocalAnswer = (id, answers) => {
    if (id !== askId) return false
    // Refuse what the harness refuses. A mock that accepts anything turns a
    // malformed answer into a green check, which is how the shape below reached
    // a real turn: the harness answers `bad-response` for a single-select item
    // carrying both a chosen label and free text, and nothing here said so.
    if (!matchesQuestions(answers, questions)) return false
    settle.resolve({ answers })
    return true
  }
  try {
    const answer = await waiting
    result(s, callId, JSON.stringify(answer), false)
    return answer
  } catch (error) {
    result(s, callId, String(error), true)
    return null
  } finally {
    controller.signal.removeEventListener('abort', onAbort)
    release()
    s.question = null
  }
}

// The approval seam: the same durable-call-then-wait shape, against the host's
// other pending table.
//
// On the real box `Bridge` mirrors `approval/requested` frames the host's
// apiproxy broadcasts and settles them through `/api/respond`. Here the mock is
// the harness, so it raises the request through `holdApproval` and keeps the
// promise itself; the browser sees one waiting permission and decides it through
// `POST /api/decide`. Both outcomes are reachable, so allow and reject are
// exercised rather than only the one that keeps the turn moving.
async function approve (s, toolName, reason) {
  const callId = call(s, 'escalate', { toolName, reason })
  const askId = 'mock-approval-' + (nextAskId += 1)
  let settle
  const waiting = new Promise(resolve => { settle = resolve })
  const release = hub.questions.holdApproval(askId, s.id, { askId, toolName, reason })
  hub.questions.onLocalApproval = (id, outcome) => {
    if (id !== askId) return false
    settle(outcome)
    return true
  }
  try {
    const outcome = await waiting
    result(s, callId, JSON.stringify({ outcome }), outcome !== 'allowed-once')
    return outcome
  } finally {
    release()
  }
}

// `work` resolves true when the turn completed and false when it was stopped.
async function turn (s, work) {
  s.turn += 1
  s.status = 'running'
  add(s, 'turn/start', { turn: s.turn })
  const completed = await work()
  s.status = 'idle'
  add(s, 'turn/end', { turn: s.turn, reason: completed ? { kind: 'completed' } : { kind: 'aborted', reason: { kind: 'user' } } })
}

async function stream (s, text) {
  const agent = { session: s.session }
  emit('agent/assistant-stream', { agent, frame: { type: 'start', revision: 1 } })
  for (const word of text.split(/(?= )/)) {
    await sleep(150)
    emit('agent/assistant-stream', { agent, frame: { type: 'chunk', revision: 1, chunk: { type: 'text-delta', text: word } } })
  }
  emit('agent/assistant-stream', { agent, frame: { type: 'end', revision: 1 } })
  say(s, text)
}

function words (answer) {
  return answer.custom ?? (answer.selected.join(' and ') || 'nothing')
}

// What a real agent does with steering: log it, then run a turn.
function prompt (s, message) {
  add(s, 'user/message', { content: message.content, source: message.source })
  const text = message.content.map(block => block.text ?? '').join('')
  turn(s, async () => {
    // A run that arrives one event at a time, so the folding can be watched
    // growing rather than only read back from a finished log.
    if (/\btools\b/i.test(text)) {
      say(s, 'Running a few tools.')
      for (let n = 1; n <= 5; n += 1) {
        await sleep(400)
        result(s, call(s, 'Read', { file_path: 'src/file' + n + '.ts' }), 'line one\nline two', false)
      }
      await stream(s, 'That is five calls.')
      return true
    }
    // A permission request, which the browser renders and settles through the
    // approval form rather than the question form.
    if (/\bapprove\b/i.test(text)) {
      const outcome = await approve(s, 'bash', 'escalate sandbox to danger-full-access: Restarting the dsh-web-gui service requires access to the systemd bus outside the workspace sandbox, which the user explicitly asked for.')
      await stream(s, 'Permission was ' + outcome + '.')
      return true
    }
    // A question raised in the middle of a run of tool calls, with more work
    // after the answer. This is the ordinary shape on a real box, and the only
    // one that puts the ask's row inside a foldable run of tool rows.
    if (/\bmidturn\b/i.test(text)) {
      say(s, 'Looking around first.')
      for (let n = 1; n <= 3; n += 1) {
        await sleep(200)
        result(s, call(s, 'Read', { file_path: 'src/before' + n + '.ts' }), 'line one', false)
      }
      const picked = await ask(s, [{ id: 'name', header: 'Name', question: 'What should the new file be called?' }])
      if (picked === null) return false
      for (let n = 1; n <= 3; n += 1) {
        await sleep(200)
        result(s, call(s, 'Read', { file_path: 'src/after' + n + '.ts' }), 'line one', false)
      }
      await stream(s, 'Calling it ' + words(picked.answers[0]) + '.')
      return true
    }
    if (!/\bask\b/i.test(text)) {
      await stream(s, 'You said: ' + text)
      return true
    }
    const answer = await ask(s, [{ id: 'name', header: 'Name', question: 'What should the new file be called?' }])
    if (answer === null) return false
    await stream(s, 'Calling it ' + words(answer.answers[0]) + '.')
    return true
  })
}

// The hub carries the question bridge, so it must exist before any agent asks.
// No origin: this mock *is* the harness, and its questions are raised in this
// process by `ask()` below rather than mirrored from a real one. Passing an
// origin here would dial a harness that is not there and log a retry every few
// seconds for the whole run.
const hub = new StreamHub(ctx, '')

const billing = session('billing', 'Split the invoice module', '/home/dev/billing')
owns('ws-billing', 'billing')
user(billing, 'Split `invoice.ts` into smaller modules.')
turn(billing, async () => {
  say(billing, 'I read `invoice.ts`: 900 lines mixing **tax**, discounts and totals. It splits two ways.')
  result(billing, call(billing, 'read_file', { path: 'src/invoice.ts' }), 'export function total (lines, rules) {\n  // 900 lines\n}', false)
  const answer = await ask(billing, [{
    id: 'split',
    header: 'Approach',
    question: 'How should invoice.ts be split?',
    options: [
      { label: 'By feature (Recommended)', description: 'Tax, discounts and totals each get a file' },
      { label: 'By layer', description: 'Types, pure logic and IO each get a file' }
    ]
  }])
  if (answer === null) return false
  await stream(billing, 'Splitting it: ' + words(answer.answers[0]) + '.')
  return true
})

const migration = session('migration', 'Upgrade Postgres to 17', '/home/dev/infra')
owns('ws-infra', 'migration')
user(migration, 'Plan the Postgres 17 upgrade.')
turn(migration, async () => {
  const answer = await ask(migration, [{
    id: 'plan',
    header: 'Plan',
    question: 'Approve this plan?',
    detail: '1. Snapshot the primary.\n2. Upgrade one replica and run the test suite against it.\n3. Promote the replica during the Sunday window.\n4. Keep the old primary for 48 hours as a fallback.',
    options: [{ label: 'Approve' }, { label: 'Refuse' }],
    intent: { kind: 'plan-review', approve: 'Approve' }
  }, {
    id: 'envs',
    header: 'Order',
    question: 'Which environments go first?',
    multiSelect: true,
    options: [{ label: 'Staging' }, { label: 'Preview' }, { label: 'Production' }]
  }])
  if (answer === null) return false
  await stream(migration, 'Plan: ' + words(answer.answers[0]) + '. First: ' + words(answer.answers[1]) + '.')
  return true
})

const scratch = session('scratch', 'Scratch', '/home/dev')
// Deliberately unowned: it must still appear, grouped after every record.

// A hidden subagent child holding a request a person must answer.
//
// The child itself is filtered off the list, so its question has to arrive on
// its parent's row or a live blocker would become unreachable — the one case
// the harness's own rules leave open (a child resumed as its own runtime root
// may ask, where an ordinary delegated child is refused with DELEGATED_CALLER).
// The question and the permission are held directly rather than through `ask()`
// and `approve()`, because those install a settler on the bridge's single
// callback; this fixture only has to be *waiting*.
const audit = session('audit-drift', 'Audit drift', '/home/dev/infra', {
  origin: 'subagent',
  delegationDepth: 1,
  parentSession: 'migration'
})
user(audit, 'Audit the drift between the schema and the handlers.')
hub.questions.hold('mock-ask-child', 'audit-drift', [{
  id: 'scope',
  header: 'Scope',
  question: 'Which modules should the audit cover?',
  options: [{ label: 'All of them' }, { label: 'Just the auth surface' }]
}])
hub.questions.holdApproval('mock-approval-child', 'audit-drift', {
  askId: 'mock-approval-child',
  toolName: 'bash',
  reason: 'rewrite the audit fixtures in place so the drift check can run end to end'
})

// A session waiting on a permission rather than a question, raised at boot and
// left waiting: it is what lets a cold deep link to /s/deploy-staging paint a
// decision form from the server-rendered HTML alone, before any module runs or
// the stream connects. Only one local approval is outstanding at a time — the
// bridge exposes one `onLocalApproval` callback, mirroring `onLocalAnswer` — so
// this is the only boot-time approval the fixture set raises.
const deploy = session('deploy-staging', 'Deploy to staging', '/home/dev/infra')
owns('ws-infra', 'deploy-staging')
user(deploy, 'Deploy the current main branch to staging.')
turn(deploy, async () => {
  say(deploy, 'Staging needs the release script to write outside the sandbox. Asking for that first.')
  const outcome = await approve(deploy, 'bash', 'escalate sandbox to danger-full-access: Deploying to staging runs the release script, which writes outside the workspace sandbox.')
  await stream(deploy, 'Permission was ' + outcome + '.')
  return true
})

// A turn that is mostly tool traffic, which is the ordinary shape of real work
// and the case the transcript folds into one line. Two runs separated by a
// message, so both the fold and the thing that ends a run are on screen.
const busy = session('refactor-parser', 'Refactor the config parser', '/home/dev/infra')
owns('ws-infra', 'refactor-parser')
user(busy, 'Split the config parser into its own module.')
say(busy, 'Reading the parser and its callers first.')
for (const [name, args, out] of [
  ['Read', { file_path: 'src/config.ts' }, 'export function parse (raw) { … }'],
  ['Grep', { pattern: 'parse\\(', include: '*.ts' }, 'src/boot.ts:12\nsrc/cli.ts:44'],
  ['Read', { file_path: 'src/boot.ts' }, 'import { parse } from "./config.ts"'],
  ['Read', { file_path: 'src/cli.ts' }, 'const config = parse(await read(path))']
]) {
  result(busy, call(busy, name, args), out, false)
}
say(busy, 'The parser has two callers. Moving it now.')
for (const [name, args, out] of [
  ['Write', { file_path: 'src/parser.ts' }, 'Wrote 84 lines'],
  ['Edit', { file_path: 'src/config.ts' }, 'Replaced 1 occurrence'],
  ['Edit', { file_path: 'src/boot.ts' }, 'Replaced 1 occurrence'],
  ['Edit', { file_path: 'src/cli.ts' }, 'Replaced 1 occurrence'],
  ['Bash', { command: 'node --test' }, 'ok 14 passed']
]) {
  result(busy, call(busy, name, args), out, false)
}
say(busy, 'Done: the parser is its own module and the tests pass.')

const second = session('billing-again', 'Reconcile the invoice totals', '/home/dev/other-billing')
owns('ws-other', 'billing-again')
user(second, 'The totals disagree between the two exports.')
turn(second, async () => {
  say(second, 'Found it: one export rounds per line, the other per invoice.')
  return true
})
user(scratch, 'Hello')
turn(scratch, async () => {
  say(scratch, 'Hi. Send me anything and I echo it back. Put the word "ask" in it and I ask you a question.')
  return true
})

// The three-level hierarchy, over the real checkouts made by
// scripts/make-fixtures.sh.
//
// A session's cwd is the *project* folder, as it is on the real box — every
// session is started there, never inside a checkout. Which worktree it belongs
// to is decided the way the server decides it: by where the session wrote. So
// each of these records a couple of edits inside its worktree, which is what
// the real sessions do and what the grouping reads.
function filed (workspaceId, id, title, dir, first, writes = 2) {
  const project = dir.split('/')[0]
  const s = session(id, title, FIXTURES + project)
  owns(workspaceId, id)
  user(s, first)
  turn(s, async () => {
    for (let n = 0; n < writes; n += 1) {
      result(s, call(s, 'edit', { file_path: FIXTURES + dir + '/src/file' + n + '.ts' }), 'Replaced 1 occurrence', false)
    }
    return true
  })
  return s
}

// `develop` holds more than two sessions in a workspace holding more than three
// checkouts, so it is the one that starts shut. Its siblings hold one or two and
// stay open, which is the contrast the collapsing rule exists to produce.
filed('ws-lbc', 'onboarding-copy-tweaks', 'Onboarding copy tweaks', 'language-boss-and-choc/develop', 'In develop, tighten the welcome screen copy.')
filed('ws-lbc', 'review-pr-465', 'Review PR 465', 'language-boss-and-choc/develop', 'Review the pull request on develop.')
filed('ws-lbc', 'rotate-api-keys', 'Rotate the API keys', 'language-boss-and-choc/develop', 'Rotate the API keys on develop.')
filed('ws-lbc', 'build-sign-in-page', 'Build sign-in page', 'language-boss-and-choc/pre-term-sign-in', 'Build the sign-in page in pre-term-sign-in.')
filed('ws-lbc', 'write-e2e-tests', 'Write e2e tests', 'language-boss-and-choc/pre-term-sign-in', 'Cover the sign-in flow end to end in pre-term-sign-in.')
filed('ws-lbc', 'chart-error-trends', 'Chart error trends', 'language-boss-and-choc/student-error-insights', 'Chart the error trends in student-error-insights.')
filed('ws-lbc', 'attach-lesson-pdfs', 'Attach lesson PDFs', 'language-boss-and-choc/lesson-resource-attachments', 'Attach the lesson PDFs in lesson-resource-attachments.')

filed('ws-dmwg', 'bump-dependencies', 'Bump dependencies', 'dsh-mobile-web-gui/main', 'Bump the dev dependencies on main.')
filed('ws-dmwg', 'scaffold-session-list', 'Scaffold session list', 'dsh-mobile-web-gui/session-list-view', 'Scaffold the session list view in session-list-view.')
filed('ws-dmwg', 'fix-touch-scrolling', 'Fix touch scrolling', 'dsh-mobile-web-gui/session-list-view', 'Scrolling stutters on iOS, fix it in session-list-view.')

filed('ws-mak', 'investigate-ime-crash', 'Investigate IME crash', 'my-android-keyboard/main', 'The IME crashes on rotate; investigate on main.')
filed('ws-mak', 'gesture-detection', 'Gesture detection', 'my-android-keyboard/swipe-typing', 'Detect the swipe path in swipe-typing.')

// Newlines that are content rather than incidental whitespace, which HTML
// collapses to single spaces without `white-space: pre-wrap`. Deliberately not
// a markdown list: a numbered list becomes an `<ol>` and so proves nothing about
// line breaks. These are plain lines inside one paragraph, which is the case
// that actually regressed — an address block, a stack trace, a set of headings.
const layout = filed('ws-mak', 'suggestion-bar-layout', 'Suggestion bar layout', 'my-android-keyboard/swipe-typing', 'Lay out the suggestion bar.')
turn(layout, async () => {
  say(layout, 'Measurements taken:\nKey row: 48dp\nSuggestion bar: 36dp\nGap: 4dp\n\nAnd a second paragraph, to prove a blank line still separates blocks.')
  return true
})

// The hidden-row fixture set: subagent children, which the list must drop.
//
// Four of them, because one child has to prove four different things — an
// ordinary child disappears, a child in a directory no record owns does not
// mint a `cwd:` heading of its own, a child carrying only the `delegationDepth`
// signal is caught too, and a child blocked on a person stays reachable.
// `origin` is set explicitly rather than left to a stand-in: the filter reads
// `SessionHeader.origin === 'subagent'`, with `delegationDepth > 0` as the
// second signal, so a fixture that set neither would prove nothing.

// An ordinary child of a session the reader started: present in the store, and
// gone from the list.
const audited = session('subagent-audited-copy', 'auditing the copy build', FIXTURES + 'dsh-mobile-web-gui/main', { origin: 'subagent', delegationDepth: 1 })
owns('ws-dmwg', 'subagent-audited-copy')
user(audited, 'Audit the copy build for regressions.')
turn(audited, async () => {
  say(audited, 'Read the build script and its three callers.')
  return true
})

// A child whose cwd no workspace record owns. Left visible it would be grouped
// by its directory and mint a `cwd:` heading all of its own, so this is the case
// that proves a hidden session cannot create a heading either. Its directory is
// deliberately one the registry knows nothing about, so a heading appearing
// here could only have come from the child.
const stray = session('subagent-stray-review', 'reviewing the stray module', '/home/dev/nowhere', { origin: 'subagent', delegationDepth: 2 })
user(stray, 'Review the module under /home/dev/nowhere.')
turn(stray, async () => {
  say(stray, 'Nothing to review yet.')
  return true
})

// A child whose `origin` was never stamped, so `delegationDepth` is the only
// signal left. The discriminator accepts either, and a fixture that only ever
// set `origin` would not notice the second one being dropped. Deliberately
// carries no cwd a record owns, so it also re-proves the heading claim on the
// other signal.
const unstamped = session('subagent-unnamed-child', 'checking an unstamped child', '/home/dev/unrecorded', { delegationDepth: 1 })
user(unstamped, 'Check the unstamped child.')
turn(unstamped, async () => {
  say(unstamped, 'Nothing to report.')
  return true
})

// A child blocked on a person, which stays on the list: a row waiting for an
// answer must never become unreachable. It leaves on its own once the ask is
// settled. Held straight against the bridge rather than through `approve()`,
// because `approve()` claims the mock's single `onLocalApproval` settle callback
// and would take the deploy fixture's answerability down with it.
const blocked = session('subagent-blocked-on-you', 'writing the migration report', FIXTURES + 'dsh-mobile-web-gui/main', { origin: 'subagent', delegationDepth: 1 })
owns('ws-dmwg', 'subagent-blocked-on-you')
user(blocked, 'Write the migration report.')
turn(blocked, async () => {
  say(blocked, 'The report has to be written outside the sandbox. Asking for that first.')
  // Never released: the point of the fixture is the waiting state itself.
  hub.questions.holdApproval('mock-approval-subagent-blocked', 'subagent-blocked-on-you', {
    askId: 'mock-approval-subagent-blocked',
    toolName: 'bash',
    reason: 'escalate sandbox to danger-full-access: the child cannot write its report inside the workspace sandbox.'
  })
  return true
})

// A session longer than one tail window, so the scrollback path has something
// to walk back through. Off by default: the ordinary fixture set is what the
// other checks measure, and a thousand-event session would slow every one of
// them down. Turn it on with LONG=1.
if (process.env.LONG === '1') {
  const long = session('long-scrollback', 'Long scrollback', FIXTURES + 'dsh-mobile-web-gui')
  owns('ws-dmwg', 'long-scrollback')
  for (let n = 0; n < 500; n += 1) {
    user(long, 'Question number ' + n + ' in a very long conversation.')
    // Real turns are mostly tool traffic, and tool rows fold into one line on
    // the client. A fixture of bare messages never exercises that, so the
    // scrollback walk has to cross folded runs here as it does on a real box.
    const id = call(long, 'read', { file: '/src/module-' + n + '.ts' })
    result(long, id, 'Contents of module ' + n + '.')
    say(long, 'Answer number ' + n + '. This is the reply the reader scrolls back to find.')
  }
  // A long stretch of events that render no frame at all. A completed turn
  // boundary is the commonest of them and a real log is full of them, so a
  // backwards read can easily land on a whole window that draws nothing. The
  // walk has to cross that rather than stall on it.
  const quiet = session('quiet-scrollback', 'Quiet scrollback', FIXTURES + 'dsh-mobile-web-gui')
  owns('ws-dmwg', 'quiet-scrollback')
  user(quiet, 'The first message of the quiet session.')
  say(quiet, 'The first reply of the quiet session.')
  for (let n = 0; n < 900; n += 1) {
    add(quiet, 'turn/end', { turn: n, reason: { kind: 'completed' } })
  }
  user(quiet, 'The last message of the quiet session.')
  say(quiet, 'The last reply of the quiet session.')

  // Prompts and an answered question buried under far more tool traffic than one
  // tail window holds. A purely positional window lands entirely inside the last
  // burst of work, so this is the fixture that proves the reader's own words and
  // the questions put to them survive truncation rather than falling off the top.
  const buried = session('buried-prompts', 'Buried prompts', FIXTURES + 'dsh-mobile-web-gui')
  owns('ws-dmwg', 'buried-prompts')
  for (let n = 0; n < 6; n += 1) {
    user(buried, 'Buried prompt number ' + n + '.')
    say(buried, 'Starting on buried prompt number ' + n + '.')
    // A durable answered question, rendered from the tool result exactly as a
    // live one is, so the always-visible rule is measured on both halves.
    const askId = call(buried, 'ask_user_question', {
      questions: [{
        id: 'buried-' + n,
        question: 'Which way should buried task ' + n + ' go?',
        options: [{ label: 'The first way' }, { label: 'The second way' }]
      }]
    })
    result(buried, askId, JSON.stringify({
      answers: [{ id: 'buried-' + n, selected: ['The first way'] }]
    }), false)
    // The work itself: enough per prompt that the whole tail window is spent on
    // tool rows long before the oldest prompt is reached.
    for (let step = 0; step < 120; step += 1) {
      const id = call(buried, 'read', { file: '/src/buried-' + n + '-' + step + '.ts' })
      result(buried, id, 'Contents of buried module ' + n + '-' + step + '.')
    }
    say(buried, 'Finished buried prompt number ' + n + '.')
  }
}

const assets = await loadAssets(fileURLToPath(new URL('../client', import.meta.url)))
await listen(ctx, assets, hub, PORT, '::')
console.log('Mock harness listening on port ' + PORT + ' — open http://localhost:' + PORT)
