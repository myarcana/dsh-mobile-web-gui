// The chooser is a view, not furniture. It answers the question that matters
// when a box holds hundreds of sessions: where did that work happen?
//
// Rows arrive newest-first from the server and stay in that order inside each
// group, so the most recent session in a workspace is the first thing under its
// heading. Group order is the durable registry order, which is what the desktop
// UI shows — re-deriving one from activity would make the two disagree.

import { stamp } from 'time'

const log = document.getElementById('log')

let rows = []
let showing = false

export function update (next) {
  rows = next
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

// Group without reordering: first appearance wins, so a group's position is its
// best-placed row's and the time ordering inside it survives untouched.
function grouped () {
  const groups = []
  const seen = new Map()
  for (const row of rows) {
    let group = seen.get(row.workspaceId)
    if (group === undefined) {
      group = { id: row.workspaceId, title: row.workspace, order: row.workspaceOrder, rows: [] }
      seen.set(row.workspaceId, group)
      groups.push(group)
    }
    group.rows.push(row)
  }
  return groups.sort((left, right) => left.order - right.order
    || left.title.localeCompare(right.title)
    || left.id.localeCompare(right.id))
}

function paint () {
  log.innerHTML = ''
  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No sessions.'
    log.append(empty)
    return
  }
  for (const group of grouped()) {
    const heading = document.createElement('h2')
    heading.className = 'group'
    // Anchored so a breadcrumb can link back to the workspace a session is in.
    if (group.id !== '') heading.id = group.id
    heading.textContent = group.title
    log.append(heading)
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
  line.textContent = row.asks.length > 0
    ? 'Waiting for your answer · ' + row.lastLine
    : row.running ? 'Working · ' + row.lastLine : row.lastLine
  link.append(title, line, stamp(row.time))
  return link
}
