import { mintId } from 'store'

// Creating things: a session, and a workspace.
//
// Both are one deliberate tap followed by a plain form. Nothing here is a
// wizard: a session needs at most which workspace, and a workspace needs a
// directory. Anything more would be this page guessing at intent it can ask for.
//
// A failure is shown verbatim. The host's own message says why a create was
// refused, and paraphrasing it here would cost the reader the one sentence that
// explains the problem.

// A create is one intent, not one request. The id is reserved before the first
// attempt and reused until it succeeds, so a second tap, or a retry after a
// response the link ate, resolves to the session already made instead of
// minting a duplicate. Clearing it on the key change is what lets a genuinely
// different request — another workspace — get its own session.
let pending = null

// The key is the whole request, not just the workspace: two worktrees in one
// project are two different intents, and keying on the workspace alone would
// make a session started in the second resolve to the one already made in the
// first — landing the reader on a session opened with the wrong worktree.
function reservedId (workspaceId, prefill) {
  const key = (workspaceId ?? '') + '\n' + (prefill ?? '')
  if (pending === null || pending.key !== key) pending = { key, sessionId: 'session-' + mintId() }
  return pending.sessionId
}

const tools = document.getElementById('tools')
const dialog = document.getElementById('dialog')

let workspaces = []
let onCreated = () => {}

export function observe (fn) {
  onCreated = fn
}

// The headings are the workspaces, and they arrive with every list frame. Kept
// here so the picker offers names rather than requiring an id from memory.
export function update (listing) {
  workspaces = listing.groups.filter(group => !group.id.startsWith('cwd:') && group.id !== '')
}

export function mount () {
  if (tools === null) return
  tools.querySelector('#new-session')?.addEventListener('click', () => pickWorkspace())
  tools.querySelector('#new-workspace')?.addEventListener('click', () => browse('/'))
}

// Show the controls only on the list. The server decides per route and this
// mirrors it, so a transcript never grows a create button on a client-side
// repaint.
export function show (visible) {
  if (tools !== null) tools.hidden = !visible
}

// Drop whatever the dialog is holding. Called on every route change, because
// the dialog lives on every route: a status line left here by a finished
// create would otherwise ride along with the tab and show up on whatever
// session the reader opens next.
export function reset () {
  clear()
}

function clear () {
  dialog.innerHTML = ''
}

function title (text) {
  const heading = document.createElement('h2')
  heading.className = 'group'
  heading.textContent = text
  dialog.append(heading)
}

function note (text, className) {
  const line = document.createElement('p')
  if (className !== undefined) line.className = className
  line.textContent = text
  dialog.append(line)
  return line
}

function button (text, onClick, primary) {
  const el = document.createElement('button')
  el.type = 'button'
  el.textContent = text
  if (primary === true) el.className = 'primary'
  el.addEventListener('click', onClick)
  return el
}

function cancel () {
  return button('Cancel', clear)
}

// Failures land where the reader is looking, in the dialog, rather than in the
// error panel used for stream faults — this is the answer to their tap.
function failed (error) {
  note(error instanceof Error ? error.message : String(error), 'error')
}

// A POST that never answers must not look like a POST that is working. Without a
// deadline a stalled request and a slow one are the same screen, which is how a
// wedged server leaves "Creating…" up for as long as the reader is willing to
// wait. `timeoutMs` turns that into a reportable fault.
async function post (url, body, timeoutMs) {
  const controller = new AbortController()
  const timer = timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs)
  let response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(timer === undefined ? {} : { signal: controller.signal })
    })
  } catch (error) {
    // An abort is this deadline firing, not a network fault, and the reader
    // needs to know the request may still have been carried out: the reserved id
    // makes trying again resolve to the same session rather than a duplicate.
    if (controller.signal.aborted) {
      throw new Error('The server did not answer within ' + Math.round(timeoutMs / 1000) +
        's. It may still be working; trying again will not create a second session.')
    }
    throw error
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    const message = payload !== null && typeof payload.message === 'string'
      ? payload.message
      : 'The server refused the request (' + response.status + ').'
    throw new Error(message)
  }
  return payload
}

// --- new session ------------------------------------------------------------

function pickWorkspace () {
  clear()
  title('New session')
  note('A session runs in one directory. Pick the workspace it belongs to.')
  for (const group of workspaces) {
    dialog.append(button(group.title, () => create(group.id)))
  }
  // The host's own default directory, for work that belongs to no project.
  dialog.append(button('Somewhere else (host default)', () => create(undefined)))
  dialog.append(cancel())
}

// How long a create may take before it is reported as stalled. The host composes
// an agent on this call (preset resolution, model selection, sandbox), which is
// normally about two seconds, so this is generous rather than tight.
const CREATE_TIMEOUT_MS = 30000

// Start a session in the workspace a worktree hangs under, with the opening
// line that names the worktree already written.
//
// The harness creates a session against a workspace, not a checkout — a
// workspace is one title over one path, and the worktree level this page shows
// is derived from where sessions actually wrote. So the worktree is not passed
// to the server: it is said to the agent, in the first thing the reader sends.
//
// The dialog is skipped deliberately. The tap already answered the only
// question it asks — which workspace — so showing it would be this page asking
// something it has just been told.
export function inWorktree (workspaceId, opened) {
  return create(workspaceId, opened)
}

// A create that says what it is doing where the reader tapped, rather than in
// the shared dialog at the top of the page.
//
// The list repaints on every summary frame and rebuilds its buttons, so this
// cannot write to a node: it reports through `onChange` and lets the caller keep
// the state somewhere a repaint does not reach. Same reservation and same
// deadline as the dialog path — only the reporting differs.
//
// `onChange` is called with `{ phase: 'creating', seconds }` while the request
// is out, `{ phase: 'failed', message }` if it is refused or stalls, and `null`
// when it succeeds.
//
// Success must report too, even though the reader is being taken to the session
// they just made. Leaving is not the end of this button: history brings them
// back to the list, and a starter still holding a spent `creating` state paints
// disabled, with the second count frozen at whatever the create finished on, and
// refuses every tap. Clearing it is what makes the button a button again.
export async function startInline (workspaceId, opened, onChange) {
  const sessionId = reservedId(workspaceId, opened?.prefill)
  const started = Date.now()
  const elapsed = () => Math.round((Date.now() - started) / 1000)
  // True only while this request is actually out. Every `creating` state carries
  // it, so a caller holding one across a navigation can ask whether the create
  // behind it is still running instead of trusting that it was told when it
  // stopped. Settled in `finally`, so no exit path can leave it lying.
  let running = true
  const live = () => running
  onChange({ phase: 'creating', seconds: 0, live })
  // Elapsed seconds, so a slow create reads as slow rather than as a tap that
  // was dropped. The caller stops repainting when a terminal phase arrives.
  const ticker = setInterval(() => onChange({ phase: 'creating', seconds: elapsed(), live }), 1000)
  try {
    const created = await post('/api/sessions', {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      sessionId
    }, CREATE_TIMEOUT_MS)
    pending = null
    // Before the hand-off, because that navigates: this tap is answered, and the
    // starter must be idle again for when history returns the reader to the list.
    onChange(null)
    onCreated(created.sessionId, opened)
  } catch (error) {
    // Verbatim: the host's own sentence is the one that says why it was refused,
    // and the reservation survives, so trying again asks for the very session
    // this attempt may already have made.
    onChange({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
    clearInterval(ticker)
  }
}

// `opened` is what the reader's tap chose: the opening line to put in the box,
// and the checkout it names. Both ride together because both are answers to the
// same tap, and the page needs the name before the session has written anything
// the server could derive it from. Undefined for a plain "New session".
async function create (workspaceId, opened) {
  const sessionId = reservedId(workspaceId, opened?.prefill)
  clear()
  const state = note('Creating…', 'state')
  const started = Date.now()
  // Elapsed seconds, so a slow create reads as slow rather than as a page that
  // dropped the tap. Cleared on every exit path below.
  const ticker = setInterval(() => {
    state.textContent = 'Creating… ' + Math.round((Date.now() - started) / 1000) + 's'
  }, 1000)
  try {
    const created = await post('/api/sessions', {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      sessionId
    }, CREATE_TIMEOUT_MS)
    // The reservation is spent, so the next create is a new intent rather than
    // a retry of this one.
    pending = null
    // The hand-off does not clear this dialog: the router only hides the tools,
    // so without this the success path is the one that forgets to clean up and
    // leaves "Creating…" on screen for good.
    clear()
    onCreated(created.sessionId, opened)
  } catch (error) {
    clear()
    title('New session')
    failed(error)
    // The reservation survives the failure, so trying again asks for the very
    // session this attempt may already have made.
    if (pending !== null && pending.key === (workspaceId ?? '') + '\n' + (opened?.prefill ?? '')) {
      dialog.append(button('Try again', () => create(workspaceId, opened), true))
    }
    dialog.append(cancel())
  } finally {
    running = false
    clearInterval(ticker)
  }
}

// --- new workspace ----------------------------------------------------------

// The browse backend lists one level at a time and never joins paths, so this
// walks down one tap at a time and carries the absolute path it was handed.
async function browse (path) {
  clear()
  title('New workspace')
  note('Pick or create the directory this workspace owns.')
  let listing
  try {
    listing = await (await fetch('/api/browse?path=' + encodeURIComponent(path))).json()
  } catch (error) {
    failed(error)
    dialog.append(cancel())
    return
  }
  if (listing.error === true) {
    failed(new Error(listing.message))
    dialog.append(cancel())
    return
  }
  const crumbs = document.createElement('p')
  crumbs.className = 'state'
  crumbs.textContent = listing.path
  dialog.append(crumbs)
  dialog.append(button('Home', () => browse(listing.home)))
  if (listing.path !== listing.home && listing.path !== '/') dialog.append(button('Up', () => browse(parent(listing.path))))
  for (const entry of listing.entries) {
    if (entry.hidden) continue
    dialog.append(button(entry.name, () => browse(entry.path)))
  }
  if (listing.truncated === true) note('More directories here than are listed.', 'state')
  if (listing.canCreateDirectory === true) {
    const form = document.createElement('form')
    const name = document.createElement('input')
    name.className = 'other'
    name.placeholder = 'New folder name'
    const make = document.createElement('button')
    make.type = 'submit'
    make.textContent = 'Create folder'
    form.append(name, make)
    form.addEventListener('submit', async event => {
      event.preventDefault()
      const value = name.value.trim()
      if (value === '') return
      try {
        await post('/api/directory', { path: listing.path, name: value })
        await browse(listing.path + (listing.path.endsWith('/') ? '' : '/') + value)
      } catch (error) { failed(error) }
    })
    dialog.append(form)
  }
  dialog.append(button('Register this directory', () => register(listing.path), true))
  dialog.append(cancel())
}

function parent (path) {
  const cut = path.replace(/\/+$/, '').lastIndexOf('/')
  return cut <= 0 ? '/' : path.slice(0, cut)
}

async function register (path) {
  clear()
  note('Registering…', 'state')
  try {
    await post('/api/workspaces', { path })
    clear()
    onCreated(null)
  } catch (error) {
    clear()
    title('New workspace')
    failed(error)
    dialog.append(cancel())
  }
}
