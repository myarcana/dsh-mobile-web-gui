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

const log = document.getElementById('log')

let rows = []
let headings = []
let showing = false

export function update (listing) {
  rows = listing.rows
  headings = listing.groups
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
  paint()
}

export function hide () {
  showing = false
}

// Every heading the server sent, in its order, then any group a row names that
// the server's list did not carry. A row is the reason this screen exists, so
// it must never disappear because its heading is missing from the list.
function sections () {
  const byId = new Map()
  const sections = []
  for (const group of headings) {
    const section = { id: group.id, title: group.title, order: group.order, rows: [] }
    byId.set(group.id, section)
    sections.push(section)
  }
  for (const row of rows) {
    let section = byId.get(row.workspaceId)
    if (section === undefined) {
      section = { id: row.workspaceId, title: row.workspace, order: row.workspaceOrder, rows: [] }
      byId.set(row.workspaceId, section)
      sections.push(section)
    }
    section.rows.push(row)
  }
  return sections.sort((left, right) => left.order - right.order
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id))
}

function paint () {
  log.innerHTML = ''
  const groups = sections()
  if (groups.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No sessions.'
    log.append(empty)
    return
  }
  for (const group of groups) {
    const heading = document.createElement('h2')
    heading.className = 'group'
    // Anchored so a breadcrumb can link back to the workspace a session is in.
    if (group.id !== '') heading.id = group.id
    heading.textContent = group.title
    log.append(heading)
    // A workspace with nothing in it is a real answer, not a gap: say so under
    // its heading rather than leaving the heading looking like a failed render.
    if (group.rows.length === 0) {
      const none = document.createElement('p')
      none.className = 'state'
      none.textContent = 'No sessions yet.'
      log.append(none)
      continue
    }
    for (const row of group.rows) log.append(item(row))
  }
}

function item (row) {
  const link = document.createElement('a')
  link.className = 'row'
  link.href = '/s/' + encodeURIComponent(row.id)
  const title = document.createElement('strong')
  // Specific, never a generic label: this session's own title.
  title.textContent = row.title
  const line = document.createElement('span')
  line.textContent = preview(row)
  link.append(title, line, stamp(row.time))
  return link
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
  if (row.asks.length > 0) return 'Waiting for your answer · ' + row.lastLine
  return row.running ? 'Working · ' + row.lastLine : row.lastLine
}
