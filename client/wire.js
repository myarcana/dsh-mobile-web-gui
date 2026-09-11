// Plain validator functions. Every response becomes a typed object by passing
// through one of these; nothing in the client asserts a shape it did not check.
// A refusal throws with the offending payload in the message, so a wire
// mismatch reads as a full technical error in the page rather than as undefined
// three frames later.

function fail (what, value) {
  throw new TypeError('Malformed ' + what + ': ' + JSON.stringify(value))
}

function str (value, what) {
  if (typeof value !== 'string') fail(what, value)
  return value
}

function num (value, what) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(what, value)
  return value
}

export function summary (value) {
  if (typeof value !== 'object' || value === null) fail('session summary', value)
  return {
    id: str(value.id, 'session summary id'),
    title: str(value.title, 'session summary title'),
    running: value.running === true,
    latestSeq: num(value.latestSeq, 'session summary latestSeq'),
    workspace: str(value.workspace, 'session summary workspace'),
    lastLine: str(value.lastLine, 'session summary lastLine'),
    time: num(value.time, 'session summary time'),
    actions: Array.isArray(value.actions) ? value.actions.map(a => str(a, 'action')) : fail('actions', value.actions),
    asks: asks(value.asks)
  }
}

export function asks (value) {
  if (!Array.isArray(value)) fail('waiting questions', value)
  return value.map(ask => {
    if (typeof ask !== 'object' || ask === null || !Array.isArray(ask.questions)) fail('waiting question', ask)
    return { askId: str(ask.askId, 'waiting question askId'), questions: ask.questions.map(question) }
  })
}

function question (value) {
  if (typeof value !== 'object' || value === null) fail('question', value)
  return {
    id: str(value.id, 'question id'),
    question: str(value.question, 'question text'),
    header: typeof value.header === 'string' ? value.header : '',
    detail: typeof value.detail === 'string' ? value.detail : '',
    options: Array.isArray(value.options) ? value.options.map(option) : [],
    multiSelect: value.multiSelect === true
  }
}

function option (value) {
  if (typeof value !== 'object' || value === null) fail('question option', value)
  return {
    label: str(value.label, 'question option label'),
    description: typeof value.description === 'string' ? value.description : ''
  }
}

export function summaries (value) {
  if (!Array.isArray(value)) fail('session list', value)
  return value.map(summary)
}

export function eventFrame (value) {
  if (typeof value !== 'object' || value === null) fail('event frame', value)
  return {
    sessionId: str(value.sessionId, 'event frame sessionId'),
    seq: num(value.seq, 'event frame seq'),
    html: str(value.html, 'event frame html'),
    replace: value.replace === true
  }
}

export function tokenFrame (value) {
  if (typeof value !== 'object' || value === null) fail('token frame', value)
  return {
    sessionId: str(value.sessionId, 'token frame sessionId'),
    revision: num(value.revision, 'token frame revision'),
    off: num(value.off, 'token frame off'),
    s: str(value.s, 'token frame text')
  }
}

export function sendAccepted (value) {
  if (typeof value !== 'object' || value === null) fail('send response', value)
  if (value.error === true) fail('send response', value)
  return { accepted: value.accepted === true, duplicate: value.duplicate === true }
}

export function expandedEvent (value) {
  if (typeof value !== 'object' || value === null) fail('expanded event', value)
  if (value.error === true) fail('expanded event', value)
  return { html: str(value.html, 'expanded event html') }
}
