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
// Two records sharing a display title, which is legal, plus one session no
// record owns — the three grouping cases worth seeing on screen. `ws-new` is
// deliberate: a workspace holding no sessions must still render a heading, so
// the case the real box hit (a registered project with no work in it yet) is
// exercised here rather than only in production.
const workspaces = new Map([
  ['ws-new', { id: 'ws-new', title: 'new-project', path: '/home/dev/new-project', sessionIds: [] }],
  ['ws-billing', { id: 'ws-billing', title: 'billing', path: '/home/dev/billing', sessionIds: [] }],
  ['ws-infra', { id: 'ws-infra', title: 'infra', path: '/home/dev/infra', sessionIds: [] }],
  ['ws-other', { id: 'ws-other', title: 'billing', path: '/home/dev/other-billing', sessionIds: [] }]
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
      return { session: { id, createdAt: s.createdAt, cwd: s.cwd }, events: s.events.slice() }
    },
    async listSessions () {
      return [...sessions.values()].map(s => ({
        header: { id: s.id, createdAt: s.createdAt, cwd: s.cwd },
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

function session (id, title, cwd) {
  const s = {
    id,
    cwd,
    createdAt: Date.now() - 3_600_000,
    events: [],
    status: 'idle',
    turn: 0,
    inbox: { nextTurn: [], nextStep: [] },
    question: null,
    followup (message) { prompt(s, message) },
    cancel () { s.question?.abort() }
  }
  // The live-session shape the real host exposes: `agent.session.id/.header/.events`.
  // Getters, because the log is appended in place and a snapshot would go stale.
  s.session = {
    id,
    get header () { return { id, createdAt: s.createdAt, cwd: s.cwd } },
    get events () { return s.events }
  }
  sessions.set(id, s)
  add(s, 'session/title', { title })
  return s
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
    message: { role: 'tool', content: [{ type: 'tool-result', callId, isError, content: [{ type: 'text', text }] }] }
  })
}

// The ask_user_question tool: a durable call, a wait on the same waterfall the
// real tool dispatches through, then a durable result.
async function ask (s, questions) {
  const callId = call(s, 'ask_user_question', { questions })
  const controller = new AbortController()
  s.question = controller
  try {
    const answer = await waterfall('user-questions/request', { questions, agent: s, signal: controller.signal })
    result(s, callId, JSON.stringify(answer), false)
    return answer
  } catch (error) {
    result(s, callId, String(error), true)
    return null
  } finally {
    s.question = null
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

// What a real agent does with a followup: log it, then run a turn.
function prompt (s, message) {
  add(s, 'user/message', { content: message.content, source: message.source })
  const text = message.content.map(block => block.text ?? '').join('')
  turn(s, async () => {
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

// The hub registers the question answerer, so it must exist before any agent asks.
const hub = new StreamHub(ctx)

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

const assets = await loadAssets(fileURLToPath(new URL('../client', import.meta.url)))
await listen(ctx, assets, hub, PORT, '::')
console.log('Mock harness listening on port ' + PORT + ' — open http://localhost:' + PORT)
