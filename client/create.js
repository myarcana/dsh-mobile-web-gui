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

function reservedId (workspaceId) {
  const key = workspaceId ?? ''
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

async function post (url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
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

async function create (workspaceId) {
  const sessionId = reservedId(workspaceId)
  clear()
  note('Creating…', 'state')
  try {
    const created = await post('/api/sessions', {
      ...(workspaceId === undefined ? {} : { workspaceId }),
      sessionId
    })
    // The reservation is spent, so the next create is a new intent rather than
    // a retry of this one.
    pending = null
    // The hand-off does not clear this dialog: the router only hides the tools,
    // so without this the success path is the one that forgets to clean up and
    // leaves "Creating…" on screen for good.
    clear()
    onCreated(created.sessionId)
  } catch (error) {
    clear()
    title('New session')
    failed(error)
    // The reservation survives the failure, so trying again asks for the very
    // session this attempt may already have made.
    if (pending !== null && pending.key === (workspaceId ?? '')) {
      dialog.append(button('Try again', () => create(workspaceId), true))
    }
    dialog.append(cancel())
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
