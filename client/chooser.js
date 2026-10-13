// The chooser is a view, not furniture. It answers the question that matters
// when a box holds hundreds of sessions: where did that work happen?
//
// The headings come from the server, which takes them from the workspace
// registry — the reader's own durable list. Deriving them from the rows instead
// made a workspace with nothing in it vanish from the screen, so a project that
// had been registered but not yet worked in looked like it did not exist.
//
// Rows arrive newest-first from the server and stay in that order inside each
// section, so the most recent session in a workspace is the first thing under
// its heading. Heading order is the registry's durable order, which is what the
// desktop UI shows — re-deriving one from activity would make the two disagree.

import { stamp } from 'time'
import * as errors from 'errors'
import * as copy from 'copy'
import * as create from 'create'
import * as alerts from 'alerts'

const log = document.getElementById('log')

let rows = []
let headings = []
let trees = []
let showing = false

// Every workspace and every worktree is open, always. There is no collapsing
// here and no state saying which groups are shut, because the whole list is
// what this screen is for: a reader who came to find where work happened
// should not have to tap twice to be shown it.
//
// A heading is still anchored, so `/sessions#ws-1` lands on a group. What it
// no longer does is decide whether that group has anything under it.
//
// Old links may still carry a `?open=` query from when groups could be shut.
// Nothing reads it — the screen it names and the screen without it are the
// same screen — so it rides along harmlessly rather than being rewritten.

// A group's key, which now names one thing only: the element the reconciler
// matches a repaint against, and the anchor a deep link targets.
//
// A workspace is its own id, but a worktree's id is an absolute path, so a
// worktree is named instead — qualified by its workspace, because a bare name
// is not unique: `main` exists in two of this box's projects and
// `Unknown worktree` in four, and an unscoped key would collide across them.
function keyOf (group) {
  if (!group.id.startsWith('wt:')) return group.id
  return group.workspaceId + '/' + group.title.replaceAll(' ', '-')
}

// Sessions whose archive POST is still in flight. A listing can arrive mid
// request and repaint the whole list, so the state lives here rather than on the
// button, which that repaint would throw away — leaving a pressed control
// looking untouched.
const archiving = new Set()

// What each starter is saying about the reader's own last tap, keyed by the same
// key the button is reconciled under.
//
// For exactly the reason `archiving` exists, and more sharply: a create takes
// seconds, and a summary frame lands several times a second while any session is
// working. State written onto the button would be wiped a moment after the tap,
// so "Creating…" would flicker and vanish while the request was still out. Held
// here, every repaint rebuilds the button in whatever state its create is in.
//
// Keyed per starter, so two creates in two workspaces report independently and
// neither borrows the other's message.
const creating = new Map()

// A create reports into the map and asks for a repaint. Only the list's own
// paint writes to the document, so a starter's progress and a listing arriving
// mid-create can never disagree about what is on screen.
// A live create carries the callback that is still reporting into it, so a
// starter's state can be told apart from one whose create is over. Without that,
// a spent state and a working one are the same entry, and the only thing keeping
// a finished create from disabling its button forever is every exit path
// remembering to report — which the success path did not.
function report (key, state) {
  if (state === null) creating.delete(key)
  else creating.set(key, state)
  if (showing) paint()
}

export function update (listing) {
  rows = listing.rows
  headings = listing.groups
  trees = listing.worktrees
  if (showing) paint()
}

// Redraw the list because something it shows changed outside the listing —
// today, the notifications row at the top of it. A no-op when the list is not
// the screen the reader is on.
export function repaint () {
  if (showing) paint()
}

export function latest () {
  return rows
}

export function find (id) {
  return rows.find(row => row.id === id)
}

export function show () {
  showing = true
  // Swept on arrival, not only on departure. The list is reached by several
  // routes that never hid it in between — the Sessions link from a session the
  // reader was taken to by their own create, and the replace that follows
  // archiving from inside a session — and a sweep that only ran on the way out
  // leaves every one of those showing a spent starter: disabled, with the second
  // count frozen where the create finished, refusing taps.
  settled()
  paint()
}

export function hide () {
  showing = false
  settled()
}

// Drop every starter state whose create is over, and keep every one still
// working. A create still in flight has not answered yet, so the reader leaving
// and coming back should still find it running; one that has answered belongs to
// a tap that is already settled and must not be holding a button. `live` makes
// that judgement on the create's own terms, so a state left behind by a finished
// create cannot pose as one still working.
function settled () {
  for (const [key, state] of creating) {
    if (state.phase !== 'creating' || state.live() !== true) creating.delete(key)
  }
  // An archive in flight is not held across a screen change. It marks a row so a
  // second tap cannot land while the POST is out, and the POST does not outlive
  // the trip: whatever the reader comes back to is painted from the listing,
  // which is the thing that actually says whether the session is still here.
  archiving.clear()
}

// Every heading the server sent, in its order, then any group a row names that
// the server's list did not carry. A row is the reason this screen exists, so
// it must never disappear because its heading is missing from the list.
//
// The screen is always exactly three levels: workspace, worktree, session. A
// session is a leaf and never appears at either heading level, so a row the
// server could not place still lands under a worktree heading — the "Unknown
// worktree" bucket — rather than being promoted next to the checkouts.
//
// The invariant is enforced here as well as on the server. This function owns
// the shape of the screen, and a row arriving without a usable worktree (an
// older server, a frame that crossed a deploy) must still render somewhere
// legible instead of silently changing the page's structure.
const UNKNOWN = 'wt:unknown'

function sections () {
  const byId = new Map()
  const sections = []
  for (const group of headings) {
    const section = { id: group.id, title: group.title, order: group.order, trees: [], byTree: new Map() }
    byId.set(group.id, section)
    sections.push(section)
  }
  const section = id => byId.get(id)
  // Each bucket carries the workspace it hangs under, because a worktree's key
  // in the URL is scoped by it — two projects may both hold a `main`.
  const bucketIn = (parent, id, title, order, departed) => {
    let bucket = parent.byTree.get(id)
    if (bucket === undefined) {
      bucket = { id, title, order, workspaceId: parent.id, rows: [], departed: departed === true }
      parent.byTree.set(id, bucket)
      parent.trees.push(bucket)
    }
    return bucket
  }
  for (const tree of trees) {
    const parent = section(tree.workspaceId)
    if (parent === undefined) continue
    bucketIn(parent, tree.id, tree.title, tree.order, tree.departed)
  }
  for (const row of rows) {
    let parent = section(row.workspaceId)
    if (parent === undefined) {
      parent = { id: row.workspaceId, title: row.workspace, order: row.workspaceOrder, trees: [], byTree: new Map() }
      byId.set(row.workspaceId, parent)
      sections.push(parent)
    }
    // Unplaceable rows go to the unknown bucket, which is created on demand so
    // a workspace whose sessions are all placed never shows an empty one. The
    // large order keeps it last, matching the server's own ordering.
    const id = row.worktreeId === '' ? UNKNOWN : row.worktreeId
    const title = row.worktreeId === '' ? 'Unknown worktree' : row.worktree
    bucketIn(parent, id, title, id === UNKNOWN ? Number.MAX_SAFE_INTEGER : parent.trees.length).rows.push(row)
  }
  for (const parent of sections) {
    // Every worktree stays, empty or not: a checkout is a place the reader made
    // and can start work in, so the headings describe the project rather than
    // this week's activity. An empty one says "nothing here yet", which is a
    // real answer and the same one an empty workspace gives.
    parent.trees.sort((left, right) => left.order - right.order
      || left.title.localeCompare(right.title)
      || left.id.localeCompare(right.id))
  }
  return sections.sort((left, right) => left.order - right.order
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id))
}

// Repaint the list without losing the reader's place.
//
// The list is rebuilt wholesale, and emptying it first collapsed the document to
// a single viewport — at which point the browser clamps the scroll offset to the
// new maximum, which is 0. The content came back a moment later but the position
// did not, so every tap on a heading below the fold threw the reader to the top
// of the page and left the group looking untouched.
//
// So the old height is held on the container across the swap, and released once
// the new rows are in and have a height of their own. Nothing is measured after
// that: the floor is dropped in the same frame it is raised, so it never fights
// a genuine change in the list's length.
//
// The elements themselves are built fresh every time but are *matched* against
// the ones already on screen by key before anything is put in the document — see
// `commit`. A repaint that changes nothing therefore touches no node at all,
// which is what this list needs: a summary frame arrives on every corpus bump,
// so while any session is working the whole list was being torn down and rebuilt
// several times a second. That restarted the working dot's CSS animation from 0°
// on every frame (it only spins while the node it is on survives), dropped focus
// and any in-progress text selection, and made the page visibly shimmer.
function paint () {
  const floor = log.offsetHeight
  const groups = sections()
  const next = document.createDocumentFragment()
  // What this device will be told about when the reader is not looking at it.
  // First, because it answers the same question the list does — what wants me?
  // — for the case where nobody is watching the list at all.
  next.append(key(alerts.row(), 'alerts'))
  if (groups.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No sessions.'
    key(empty, 'empty')
    next.append(empty)
    return commit(next, floor)
  }
  for (const group of groups) {
    // Every session in the workspace, across all its worktrees, so the heading
    // reports what is waiting anywhere inside it without the reader adding up
    // the worktrees below it themselves.
    const sessions = group.trees.flatMap(tree => tree.rows)
    const groupKey = keyOf(group)
    next.append(key(header('h2', 'group', group, count(sessions)), 'g:' + groupKey))
    // Starting work in the project itself, before its checkouts are listed: the
    // same reason the worktree starter sits above its sessions. A workspace with
    // no worktrees still gets one, because the workspace is real and a session
    // in it is a reasonable thing to want — it is the one control that turns an
    // empty project into a place work can begin.
    next.append(key(workspaceStarter(group, group.trees.length === 0), 'nw:' + groupKey))
    // A workspace with no checkouts at all is a real answer, not a gap: say so
    // under its heading rather than leaving it looking like a failed render.
    if (group.trees.length === 0) {
      next.append(key(note('state', 'No worktrees yet.'), 'g0:' + groupKey))
      continue
    }
    for (const tree of group.trees) {
      // The name is copyable because it is the thing a reader retypes into a
      // shell or a prompt, and retyping is where it gets misspelled. Not offered
      // on the unknown bucket, whose title is this page's own word for "we could
      // not tell", and so names no checkout to paste anywhere.
      const treeKey = keyOf(tree)
      const heading = key(header('h3', 'tree', tree, null,
        onDisk(tree) ? copy.button(tree.title, 'worktree name') : null,
        count(tree.rows)), 't:' + treeKey)
      // The workspace trunk stops at the last worktree, open or shut. What an
      // open one reveals hangs off its *own* trunk one level in, which the rows
      // draw themselves — so nothing below this heading needs the workspace
      // line, and leaving it on gave the last branch a tail into empty space.
      const lastTree = tree === group.trees[group.trees.length - 1]
      if (lastTree) heading.dataset.last = ''
      next.append(heading)
      // Starting work is the first thing offered under a checkout, above the
      // sessions already in it: the reader who opened a worktree to begin
      // something should not have to walk past everything they finished to
      // find the way in.
      const start = key(starter(tree, group, lastTree && tree.rows.length === 0), 'n:' + treeKey)
      next.append(start)
      // A checkout with no sessions keeps its heading and says why it is bare,
      // exactly as an empty workspace does one level up. The starter above it
      // is a control rather than content, so the line still needs saying.
      if (tree.rows.length === 0) {
        const bare = key(note('state tree-state', 'No sessions yet.'), 't0:' + treeKey)
        // The workspace trunk stops here when this empty checkout is the last
        // one, and carries on past it when more worktrees follow.
        if (lastTree) bare.dataset.last = ''
        next.append(bare)
        continue
      }
      for (const row of tree.rows) {
        const entry = item(row, true)
        // The last session ends its worktree's branch, so the worktree trunk
        // beside it stops at the point it is joined at. The workspace trunk
        // passing further left does not: the rows under a heading are what carry
        // that line down to the next worktree, because the heading's own arm
        // ends at its bottom edge. It stops here only when this worktree is the
        // workspace's last and there is nothing below to reach.
        //
        // Marked on the row rather than on whatever `item` handed back: a row
        // with an Archive button comes wrapped, and the flags belong on the
        // element the tree lines are actually drawn on. Putting them on the
        // wrapper left every line running straight past the last leaf, because
        // nothing the stylesheet ends the tree with matched.
        if (row === tree.rows[tree.rows.length - 1]) {
          entry.row.dataset.last = ''
          if (lastTree) entry.row.dataset.lastBranch = ''
        }
        next.append(key(entry.element, 'r:' + row.id))
      }
    }
  }
  commit(next, floor)
}

// Name one element for the reconciler. The key says which thing on the screen
// this element *is*, so a later repaint can recognise it and keep the node that
// is already there rather than swapping in an identical replacement.
//
// Returns the element so it can be written around a constructor call.
function key (element, value) {
  element.dataset.key = value
  return element
}

// Swap the new list in under a held height.
//
// The floor keeps the container's old height while the rows are replaced, so a
// repaint never shrinks the document to a single viewport — the browser clamps
// the scroll offset to the new maximum the moment that happens, synchronously,
// and refilling the list does not undo the clamp.
//
// It is released as soon as the new rows are in and have a height of their own,
// so a list that genuinely got shorter leaves no dead space behind it.
//
// The new list is matched against the old one by key before anything is written.
// A key that is already on screen keeps its node and takes only the attributes
// and text that actually differ; a key that is new is inserted; a key that is
// gone is removed. So a summary frame that changed one row's state rewrites one
// attribute, and a frame that changed nothing writes nothing at all.
//
// Reconciling rather than replacing is not a micro-optimisation here. Replacing
// destroyed the node every CSS animation, focus ring and text selection in the
// list was attached to, several times a second for as long as any session was
// working — which is exactly the flicker this list had.
function commit (next, floor) {
  log.style.minHeight = floor + 'px'
  reconcile(log, [...next.children])
  log.style.minHeight = ''
}

// Make `parent`'s children equal `wanted`, moving and patching what is already
// there instead of rebuilding it.
//
// Single pass, walking the wanted list in order and keeping a cursor on the old
// children. The old nodes are indexed by key up front so a row that moved is
// found rather than rebuilt — a session changing state reorders nothing today,
// but a workspace opening above one does shift every row below it.
function reconcile (parent, wanted) {
  const old = new Map()
  for (const child of parent.children) {
    const k = child.dataset.key
    if (k !== undefined) old.set(k, child)
  }
  let cursor = parent.firstChild
  for (const want of wanted) {
    const mine = old.get(want.dataset.key)
    if (mine === undefined) {
      parent.insertBefore(want, cursor)
      continue
    }
    old.delete(want.dataset.key)
    // Already in the right place: patch it where it stands and step over it.
    if (mine === cursor) cursor = cursor.nextSibling
    else parent.insertBefore(mine, cursor)
    patch(mine, want)
  }
  // Whatever the new list never claimed is gone from the screen.
  for (const stale of old.values()) stale.remove()
}

// Make the node on screen match the one just built, touching only what differs.
//
// Recurses through unkeyed children positionally, which is what the insides of a
// row and a heading are: a fixed little structure of dot, title, line and time
// whose shape does not change between repaints. Keyed children hand off to
// `reconcile`, so a list nested inside a node still matches by identity.
function patch (mine, want) {
  if (mine.nodeType === Node.TEXT_NODE) {
    if (mine.nodeValue !== want.nodeValue) mine.nodeValue = want.nodeValue
    return
  }
  // A different element entirely — swap it wholesale, there is nothing to keep.
  if (mine.nodeName !== want.nodeName) return mine.replaceWith(want)
  // A control saying something about the reader's own last tap owns itself
  // until it has finished saying it. The copy button swaps its glyph to a tick
  // for a moment after a successful copy, and a summary frame landing in that
  // window would otherwise wipe the acknowledgement mid-blink.
  if (mine.dataset.done !== undefined) return
  attributes(mine, want)
  const kids = [...want.childNodes]
  // A keyed level is an ordered set, not a fixed shape: match it by key.
  if (kids.some(kid => kid.nodeType === Node.ELEMENT_NODE && kid.dataset.key !== undefined)) {
    return reconcile(mine, kids.filter(kid => kid.nodeType === Node.ELEMENT_NODE))
  }
  // Structure changed under this node: rebuild just this subtree.
  if (mine.childNodes.length !== kids.length) return mine.replaceChildren(...kids)
  for (let i = 0; i < kids.length; i++) patch(mine.childNodes[i], kids[i])
}

// Copy across the attributes that differ, and drop the ones that went away.
//
// `value` is deliberately not touched: nothing in this list is a text field, and
// writing one would throw away what the reader had typed.
function attributes (mine, want) {
  for (const { name, value } of want.attributes) {
    if (mine.getAttribute(name) !== value) mine.setAttribute(name, value)
  }
  for (const name of [...mine.getAttributeNames()]) {
    if (!want.hasAttribute(name)) mine.removeAttribute(name)
  }
  // `disabled` is a property as well as an attribute, and the Archive button
  // flips it. Setting the attribute alone leaves a re-enabled button disabled.
  if ('disabled' in mine) mine.disabled = want.hasAttribute('disabled')
}

// Where the reader is standing, so a repaint can put them back.
//
// The list is emptied by the view before this module repaints it, and an empty
// document is one viewport tall — so by the time the new rows exist the offset
// has already been clamped to zero. It has to be taken before that, which is
// why the route hands it over rather than the repaint reading it itself.
export function place () {
  return document.scrollingElement.scrollTop
}

export function restore (y) {
  const el = document.scrollingElement
  if (y <= 0) return
  // Never further than the new list can actually hold.
  const target = Math.min(y, el.scrollHeight - el.clientHeight)
  if (Math.abs(el.scrollTop - target) > 1) el.scrollTop = target
}

// One heading.
//
// Nothing here is a control: a group cannot be opened or shut, so the heading
// only names what is under it. The inner element stays because it is what the
// layout is built on — it carries the worktree indent, the hanging indent that
// keeps a wrapped name in its column, and the text flow the copy mark follows
// the last word in. The heading itself keeps the anchor, so a deep link into a
// workspace still lands.
function header (tag, className, group, summary, aside, trailing) {
  const heading = document.createElement(tag)
  heading.className = className
  // Anchored so a URL can link straight to the group a session is in.
  //
  // A worktree is anchored by its scoped key, not its bare id: the unknown
  // bucket carries the same `wt:unknown` id in every workspace that has one, so
  // using the id put four elements on this page under one anchor. A duplicate
  // id makes the browser resolve every link to the first of them, which is why
  // opening the second, third or fourth unknown bucket jumped to the top of the
  // page instead of expanding the one that was tapped.
  const anchor = group.id.startsWith('wt:') ? keyOf(group) : group.id
  if (anchor !== '') heading.id = anchor
  const button = document.createElement('div')
  button.className = 'disclose'
  const label = document.createElement('span')
  label.textContent = group.title
  // The name is shown in full and wraps rather than truncating, so this is not
  // standing in for hidden text: it is the hover and long-press surface for a
  // name that has wrapped over several lines and is easier to read in one
  // piece. Set always, so it never appears at one viewport width and not
  // another.
  label.title = group.title
  // What is inside, as a running tally beside the name. Built by the caller as
  // an element rather than a string, because the waiting count is coloured and
  // a string cannot carry that.
  button.append(label)
  // Directly after the name, so it follows the last word wherever that word
  // ends up — which is what the inline text flow here exists for.
  if (aside !== undefined && aside !== null) button.append(copy.JOIN, aside)
  if (summary !== null && summary !== undefined) button.append(summary)
  // A worktree's count follows the name and its copy mark in the same text
  // flow, so the heading reads name, copy, count and the tally is the one of
  // the three free to drop to the next line when the row fills. A workspace
  // heading passes none and keeps its count inside `summary` instead.
  if (trailing !== undefined && trailing !== null) {
    trailing.className = 'count'
    button.append(trailing)
  }
  heading.append(button)
  return heading
}

// The first item under a worktree: the way to start work in it.
//
// A session is created against the workspace, because that is the level the
// harness owns — a worktree here is derived from where sessions actually wrote,
// and there is no such thing as creating one "in" a checkout. The checkout is
// named to the agent instead, as the opening line of the message box, which the
// reader can add to before sending. Nothing is sent by this tap.
//
// The unknown bucket is not a directory, so it carries no opening line: "Work
// in the Unknown worktree worktree." names nothing an agent could act on. The
// button is still offered, because the workspace it hangs under is real and
// starting a session there is a reasonable thing to want.
function starter (tree, group, last) {
  return control(keyOf(tree), tree.workspaceId,
    { prefill: prefill(tree), worktree: onDisk(tree) ? tree.title : '' },
    // Named for the checkout, never a bare "New session": a list showing a dozen
    // of these has to say which one a press would start work in — but only where
    // there is a checkout to name. See `onDisk`.
    //
    // Where there is not, the workspace is named instead. Several projects on
    // this box have an unknown bucket, so a bare "New session" appeared on the
    // list four times over, each one starting work somewhere different — which
    // is precisely the ambiguity a specific label exists to remove.
    onDisk(tree)
      ? 'New session in ' + tree.title
      : 'New session in the ' + group.title + ' workspace, outside any worktree',
    'worktree', last)
}

// The same control under a workspace heading, above its checkouts.
//
// A workspace-level session names no checkout, so it carries no opening line:
// the reader asked to start work in the project, not in one of its worktrees,
// and inventing a directory for them would be this page answering a question it
// was not asked. It is the same session the top-of-page "New session" makes
// after picking this workspace — offered where the reader is already looking.
// The workspace is named as a workspace, not just by its title: a project and a
// checkout inside it routinely share a name — `my-android-keyboard` holds a
// worktree called `my-android-keyboard` — and two buttons a few lines apart
// both reading "New session in my-android-keyboard" would leave the reader
// guessing which of the two levels a press would start work in. Saying which
// one is what makes the pair legible, and is the same reason the worktree
// starter names its checkout rather than saying a bare "New session".
function workspaceStarter (group, last) {
  return control('ws:' + group.id, group.id, undefined,
    'New session in the ' + group.title + ' workspace', 'workspace', last)
}

// One starter, at either level.
//
// Both levels are the same control over the same endpoint, differing only in
// what they name and how far they are indented — so they are built once here
// rather than twice, which is what keeps the two from drifting apart.
//
// `opened` is undefined at the workspace level and an opening line plus checkout
// at the worktree level; it is passed through to the create untouched.
function control (key, workspaceId, opened, label, level, last) {
  const state = creating.get(key)
  // A failed create answers on the spot: the host's sentence, in full, under the
  // button that asked for it — and the button itself becomes the retry, so there
  // is one control rather than a dead button beside a live one.
  if (state !== undefined && state.phase === 'failed') {
    const wrap = document.createElement('div')
    wrap.className = 'starterline'
    wrap.append(button(key, workspaceId, opened, 'Try again: ' + label, level, last, false))
    const why = document.createElement('p')
    // Verbatim and wrapped, never truncated: this is the sentence a reader
    // copies to whoever can fix it.
    why.className = 'starter-state error'
    why.textContent = state.message
    wrap.append(why)
    return wrap
  }
  // Disabled only while the create behind this state is still running. A state
  // whose create has finished paints as a plain, tappable starter — the reader
  // arriving back here by history finds a button, not a frozen count.
  const busy = state !== undefined && state.live() === true
  const text = busy
    ? 'Creating…' + (state.seconds > 0 ? ' ' + state.seconds + 's' : '')
    : label
  return button(key, workspaceId, opened, text, level, last, busy)
}

function button (key, workspaceId, opened, label, level, last, busy) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'starter'
  // Which level this sits at, which is the one thing the stylesheet indents on.
  button.dataset.level = level
  // A create already in flight owns this button until it answers. The reserved
  // id means a second tap could not make a duplicate anyway, but a button that
  // keeps taking taps while saying "Creating…" invites them.
  button.disabled = busy === true
  // The words live in their own element so the button's chrome — its border,
  // its background — can wrap the text rather than the whole row. The row itself
  // has to stay full width, because it owns the tree gutter the trunk and elbow
  // are painted in; a bordered box that wide would draw a frame around the
  // hierarchy instead of around a control.
  const face = document.createElement('span')
  face.className = 'face'
  face.textContent = label
  button.append(face)
  button.title = label
  button.setAttribute('aria-label', label)
  // The tree lines are drawn on this element the same way they are on a row, so
  // it sits in the hierarchy rather than floating beside it.
  button.dataset.nested = ''
  if (last) button.dataset.last = ''
  button.addEventListener('click', () => {
    // Only a create that is genuinely still out may refuse a tap. Asking the
    // create itself, rather than trusting the stored phase, is what stops a
    // state left over from a finished create from eating every press.
    const inFlight = creating.get(key)
    if (inFlight !== undefined && inFlight.phase === 'creating' && inFlight.live() === true) return
    // The answer lands on this button, not at the top of the page: the reader is
    // looking here, and a status line several screens up is one they may never
    // see. `opened` carries both halves of what a worktree tap chose — the
    // opening line, and the checkout it names, which the header shows until the
    // server can place the session itself.
    create.startInline(workspaceId, opened, state => report(key, state))
  })
  return button
}

// The opening line a new session in this worktree starts with. Empty where no
// directory exists to name — the unknown bucket, and a checkout that has been
// deleted — because "Work in the X worktree." would be an instruction no agent
// could carry out.
//
// The trailing space is deliberate: the reader's own first sentence continues
// this one, and a caret landing hard against a full stop reads as a typo.
function prefill (tree) {
  if (!onDisk(tree)) return ''
  return 'Work in the ' + tree.title + ' worktree. '
}

// Whether a heading names a checkout that is still on disk.
//
// Two do not: the synthetic unknown bucket, which is this page's word for "we
// could not tell", and a pruned checkout, which keeps its real name with
// `(deleted)` after it — a marker, not part of the name. Both are worth showing;
// neither is a place work can be started in, so every control that would name a
// directory asks this first.
function onDisk (tree) {
  return tree.id !== UNKNOWN && tree.departed !== true
}

// "1 waiting · 0 working" — what a group holds, counted by what it wants from
// the reader rather than by how much of it there is.
//
// A structure count answers a question nobody asked: "2 worktrees · 4 sessions"
// is the same number every day and says nothing about whether this workspace
// needs attention. The two states that do are the ones a reader is scanning
// for, so those are what a heading reports.
//
// Waiting is everything that is not working, so it covers both states where
// nothing moves until the reader acts: a session stopped on a question, and a
// session whose turn has ended and is sitting there finished. A finished
// session wants the reader exactly as much as an asking one — it just wants the
// next instruction rather than an answer — so counting only questions left the
// heading reading "0 waiting" above a column of green dots that were all, in
// fact, waiting. An archived session is not counted because the listing never
// carries one: the server drops them before the page sees them, so "and not
// archived" needs no test here.
//
// Both counts always show, zeros included. The shape is then identical on every
// heading, which is what makes a number readable at a glance — the eye learns
// one position for "waiting" and checks it, instead of re-reading a sentence
// whose words move depending on what happens to be true.
function count (rows) {
  let waiting = 0
  let working = 0
  // The same `state` the dot beside each row uses, so a heading and the rows
  // under it can never disagree about what is waiting.
  for (const row of rows) {
    if (state(row) === 'working') working++
    else waiting++
  }
  const summary = document.createElement('small')
  // The waiting count carries its own element so the stylesheet can warm it to
  // the same amber the dots use. Marked by what it counts rather than by
  // whether it is non-zero, so the colour rule lives in one place and this
  // function stays a count.
  const amber = document.createElement('b')
  amber.className = 'waiting'
  amber.textContent = String(waiting)
  // A zero is not news: it keeps the row's shape but drops the warm colour, so
  // a glance down the page lands only on workspaces that actually want the
  // reader. The attribute is the hook; the stylesheet decides what it means.
  if (waiting === 0) amber.dataset.none = ''
  summary.append(amber, ' waiting · ' + working + ' working')
  return summary
}

function note (className, text) {
  const p = document.createElement('p')
  p.className = className
  p.textContent = text
  return p
}

// One row: the link that opens the session, and beside it whatever this session
// says it supports. The button is a sibling of the link rather than a child,
// because a control nested inside a link is invalid and taps ambiguously.
//
// Returns both what to append and the link itself, because those are not always
// the same element — a row with a control comes wrapped. The tree's end-of-branch
// flags belong on the link, which is where the lines are drawn, so handing back
// only the outer element made it easy to mark the wrapper instead and silently
// lose every rule that ends the tree.
function item (row, nested) {
  const link = document.createElement('a')
  link.className = 'row'
  // The one bit of state the stylesheet indents on. Kept as an attribute rather
  // than a second class so the depth is readable in the DOM while debugging.
  if (nested) link.dataset.nested = ''
  link.href = '/s/' + encodeURIComponent(row.id)
  // What this session is doing, as an attribute the stylesheet draws the mark
  // from. On the link rather than on the mark itself, so one value decides both
  // the dot and anything else the row wants to say about its state.
  link.dataset.state = state(row)
  const title = document.createElement('strong')
  // Specific, never a generic label: this session's own title.
  title.textContent = row.title
  const line = document.createElement('span')
  line.textContent = preview(row)
  link.append(mark(row), title, line, stamp(row.time))
  // Nothing to put beside the link: hand back the link itself rather than wrap
  // it in a container that would exist only to hold one child.
  if (!row.actions.includes('archive')) return { element: link, row: link }
  // The indent stays on the link, which is the element the stylesheet already
  // indents, so the wrapper needs no depth of its own. The link also stays first
  // here — it owns the tree gutter, and a button appended ahead of it would push
  // every connector right and sit on top of the lines. The stylesheet reorders
  // the two visually instead, which moves the button without moving the tree.
  const wrap = document.createElement('div')
  wrap.className = 'rowline'
  wrap.append(link, archiveButton(row))
  return { element: wrap, row: link }
}

// The archive control for one row. Named for the session it hides, so the label
// a screen reader announces says which session it would archive.
function archiveButton (row) {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'archive'
  const busy = archiving.has(row.id)
  button.disabled = busy
  button.textContent = busy ? 'Archiving' : 'Archive'
  button.title = 'Archive ' + row.title
  button.setAttribute('aria-label', 'Archive ' + row.title)
  // The id, not the row object: this node outlives the listing it was built
  // from, because a repaint now keeps it rather than replacing it. The row is
  // looked up again at tap time so an archive names the session's current title
  // rather than the one it happened to carry when the node was created.
  const id = row.id
  button.addEventListener('click', () => { archive(find(id) ?? row, button) })
  return button
}

// Hide one session. The row leaves the screen when the server's next listing
// arrives without it, never before: the list stays a view of durable state
// rather than a guess about it, so a refusal cannot leave a row wrongly gone.
async function archive (row, button) {
  if (archiving.has(row.id)) return
  archiving.add(row.id)
  button.disabled = true
  button.textContent = 'Archiving'
  let response
  try {
    response = await fetch('/api/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: row.id })
    })
  } catch (error) {
    release(row, button)
    errors.show('Could not archive ' + row.title, 'POST /api/archive\nSession: ' + row.id + '\n' + error + '\nAt: ' + new Date().toString())
    return
  }
  if (!response.ok) {
    release(row, button)
    await errors.fromResponse('POST', '/api/archive', response, 'Session: ' + row.id)
    return
  }
  // Left marked until the listing that drops this row arrives. Re-enabling now
  // would offer a second tap on a session already on its way out.
  //
  // The mark is not load-bearing beyond that: `settled()` clears it whenever the
  // list is arrived at or left, so an archive the listing never confirms — a
  // dropped push, a link that died just after the POST landed — cannot leave the
  // row's control disabled for the life of the page. The archive itself is
  // idempotent on the server, so a second tap after that costs nothing.
}

// Give the row back after a failure, so the reader can try again. The button may
// already have been replaced by a repaint, hence the set as well as the element.
function release (row, button) {
  archiving.delete(row.id)
  button.disabled = false
  button.textContent = 'Archive'
}

// What a row says under its title.
//
// A session known to hold no messages says so, because a blank line there reads
// as a failed render rather than as an empty session. A session whose log has
// not been read yet claims nothing: it is not known to be empty, and naming it
// so would be a claim the server never made. The dot only joins a prefix to
// text that is actually present, so no row ends in a dangling separator.
function preview (row) {
  if (row.empty) return 'No messages yet'
  if (row.lastLine === '') return ''
  if (row.asks.length > 0 || row.approvals.length > 0) return 'Waiting for your answer · ' + row.lastLine
  return row.running ? 'Working · ' + row.lastLine : row.lastLine
}

// Which of the three states a session is in.
//
// A waiting question outranks working, in the same order `preview` uses: a
// session that has asked something is stopped on the reader whatever else it
// was doing, and that is the one state where nothing moves without them. The
// two functions read the same fields in the same order so the mark beside a row
// can never contradict the sentence under it.
function state (row) {
  if (row.asks.length > 0 || row.approvals.length > 0) return 'asking'
  if (row.running) return 'working'
  // Still waiting on the reader like a finished session, so the heading counts
  // it as waiting — but its turn did not complete, and the dot says so.
  if (row.failed) return 'failed'
  return 'done'
}

// The dot beside a session, and the only place the three states are named for a
// reader. Titled as well as coloured: colour alone is not an answer to someone
// who cannot separate green from amber, and the title is what a screen reader
// and a long-press both surface.
const WORDS = {
  asking: 'Asking you a question or for permission',
  working: 'Working',
  failed: 'The last turn ended with an error',
  done: 'Finished'
}

function mark (row) {
  const dot = document.createElement('i')
  dot.className = 'dot'
  const word = WORDS[state(row)]
  dot.title = word
  // The accessible name carries the session it belongs to, because a bare
  // "Working" in a list of forty rows does not say which session is working.
  dot.setAttribute('aria-label', word + ': ' + row.title)
  dot.setAttribute('role', 'img')
  return dot
}
