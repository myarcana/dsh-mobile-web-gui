// The chooser is a view, not furniture. It answers the question that matters
// when several sessions run at once: which one needs me now?

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

function paint () {
  log.innerHTML = ''
  if (rows.length === 0) {
    const empty = document.createElement('p')
    empty.textContent = 'No sessions are running.'
    log.append(empty)
    return
  }
  for (const row of rows) {
    const item = document.createElement('a')
    item.className = 'row'
    item.href = '/s/' + encodeURIComponent(row.id)
    const title = document.createElement('strong')
    // Specific, never a generic label: this session's own title.
    title.textContent = row.title
    const line = document.createElement('span')
    line.textContent = row.asks.length > 0
      ? 'Waiting for your answer · ' + row.lastLine
      : row.running ? 'Working · ' + row.lastLine : row.lastLine
    item.append(title, line, stamp(row.time))
    log.append(item)
  }
}
