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
    // The group a row files under. Distinct from `workspace` because two
    // workspaces may share a display title, and a `cwd:`-derived group is not a
    // workspace record at all.
    workspaceId: str(value.workspaceId, 'session summary workspaceId'),
    workspaceOrder: num(value.workspaceOrder, 'session summary workspaceOrder'),
    // The worktree level, between the workspace and the session. Empty where the
    // session's directory is in no repository, which is a real answer: those rows
    // sit directly under their workspace rather than under an invented heading.
    worktreeId: typeof value.worktreeId === 'string' ? value.worktreeId : '',
    worktree: typeof value.worktree === 'string' ? value.worktree : '',
    lastLine: str(value.lastLine, 'session summary lastLine'),
    // True only once the whole log has been read and held no message. An unread
    // session reports false, so a row never claims emptiness it has not checked.
    empty: value.empty === true,
    time: num(value.time, 'session summary time'),
    actions: Array.isArray(value.actions) ? value.actions.map(a => str(a, 'action')) : fail('actions', value.actions),
    // The prompts this server has accepted but not logged yet. The page renders
    // "Sending" from this and from nothing else, so delivery state has exactly
    // one author. A server that sends no field yields an empty list, which reads
    // as "nothing in flight" rather than as a malformed row.
    sending: Array.isArray(value.sending) ? value.sending.map(key => str(key, 'sending key')) : [],
    asks: asks(value.asks),
    approvals: approvals(value.approvals)
  }
}

export function asks (value) {
  if (!Array.isArray(value)) fail('waiting questions', value)
  return value.map(ask => {
    if (typeof ask !== 'object' || ask === null || !Array.isArray(ask.questions)) fail('waiting question', ask)
    // `from` rides along when the request was carried up from a hidden child,
    // so the form can name who is asking instead of reading as this session's own.
    //
    // `prefaceHtml` is what the agent said in the same breath as asking, and it
    // is admitted here for the same reason it is sent: a question opening "Given
    // that" names a "that" that lives only in the preface. It arrives already
    // serialized, because the markdown the agent wrote it in is parsed on the
    // server and this page ships no parser. This validator rebuilds each ask
    // field by field, so a field missing from this list is silently dropped no
    // matter how correctly the server sends it and the form renders it — which
    // is exactly how the preface stayed invisible through every reload.
    return {
      askId: str(ask.askId, 'waiting question askId'),
      questions: ask.questions.map(question),
      ...(typeof ask.from === 'string' ? { from: ask.from } : {}),
      ...(typeof ask.fromId === 'string' ? { fromId: ask.fromId } : {}),
      ...(typeof ask.prefaceHtml === 'string' ? { prefaceHtml: ask.prefaceHtml } : {})
    }
  })
}

// The permission requests one session is waiting on. The sibling of `asks`,
// with its own two fields rather than a question list: the tool whose name the
// reader is being asked to trust, and the agent's own reason for asking.
export function approvals (value) {
  if (!Array.isArray(value)) fail('waiting permissions', value)
  return value.map(approval => {
    if (typeof approval !== 'object' || approval === null) fail('waiting permission', approval)
    return {
      askId: str(approval.askId, 'waiting permission askId'),
      toolName: typeof approval.toolName === 'string' ? approval.toolName : '',
      reason: typeof approval.reason === 'string' ? approval.reason : '',
      ...(typeof approval.from === 'string' ? { from: approval.from } : {})
    }
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

/**
 * One session-list frame.
 *
 * The headings ride with the rows because they are not derivable from them: a
 * workspace with no visible session still has a heading, and the reader's own
 * registry order is the one the desktop UI shows.
 */
export function listing (value) {
  if (typeof value !== 'object' || value === null) fail('session listing', value)
  const groups = value.groups
  if (!Array.isArray(groups)) fail('session listing groups', groups)
  return {
    rows: summaries(value.rows),
    groups: groups.map(group),
    // Worktrees are derived from the repository on disk rather than from a
    // durable record, so unlike workspaces an absent list is ordinary — a server
    // that sends none simply has no middle level to draw.
    worktrees: Array.isArray(value.worktrees) ? value.worktrees.map(worktree) : []
  }
}

function group (value) {
  if (typeof value !== 'object' || value === null) fail('workspace group', value)
  return {
    id: str(value.id, 'workspace group id'),
    title: str(value.title, 'workspace group title'),
    order: num(value.order, 'workspace group order')
  }
}

function worktree (value) {
  if (typeof value !== 'object' || value === null) fail('worktree group', value)
  return {
    id: str(value.id, 'worktree group id'),
    workspaceId: str(value.workspaceId, 'worktree group workspaceId'),
    title: str(value.title, 'worktree group title'),
    order: num(value.order, 'worktree group order')
  }
}

export function eventFrame (value) {
  if (typeof value !== 'object' || value === null) fail('event frame', value)
  return {
    sessionId: str(value.sessionId, 'event frame sessionId'),
    seq: num(value.seq, 'event frame seq'),
    html: str(value.html, 'event frame html'),
    replace: value.replace === true,
    // Only a replace frame carries it, because only a whole-tail read can say a
    // session holds nothing. A live frame leaves it false.
    empty: value.empty === true,
    // Likewise: only a whole-tail read knows what sits behind the window it
    // painted, so a live append leaves this false and the link is left alone.
    more: value.more === true,
    // Where a backwards read starts. Not derivable from the painted rows: the
    // first paint keeps every prompt however far back it sits, so the oldest row
    // on screen can be the log's first message while the work behind it is still
    // unread. `-1` on a live append, which moves no top edge.
    oldest: typeof value.oldest === 'number' && Number.isFinite(value.oldest) ? value.oldest : -1,
    // The seq of a row already on screen that this frame restates rather than
    // follows. An answered question is the only sender: its answer belongs on
    // the question's own form, so that row is re-sent with the choices ticked.
    // `undefined` on every ordinary frame, which appends as before.
    amends: typeof value.amends === 'number' && Number.isFinite(value.amends) ? value.amends : undefined
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

// One chunk of transcript read backwards from the top of what is on screen.
// `more` says whether anything remains behind it, which is what retires the
// link rather than the chunk happening to arrive empty.
export function earlierFrames (value) {
  if (typeof value !== 'object' || value === null) fail('earlier frames', value)
  if (value.error === true) fail('earlier frames', value)
  return {
    html: str(value.html, 'earlier frames html'),
    oldest: num(value.oldest, 'earlier frames oldest'),
    more: value.more === true
  }
}

export function expandedEvent (value) {
  if (typeof value !== 'object' || value === null) fail('expanded event', value)
  if (value.error === true) fail('expanded event', value)
  return { html: str(value.html, 'expanded event html') }
}
