// Consecutive tool rows, folded into one line that says how many there were.
//
// A long turn is mostly tool traffic, and drawn one row per event it buries the
// conversation a reader actually came for. So a run of them collapses to a
// single link, and the rows themselves move to their own screen at that link's
// URL.
//
// This runs on the client rather than in the server renderer on purpose. A
// durable frame is append-only and arrives one event at a time, and a frame the
// server has already sent cannot be taken back. Folding here means a run that
// grows a call at a time collapses exactly like one read cold from a deep link,
// with no second code path and nothing in the server's resume cursor to keep in
// step.
//
// The fold is idempotent and reads only the rows at the tail it was handed, so
// an append costs work proportional to what just arrived rather than to the
// transcript behind it.

// Rows that make up a run, and rows a run survives. A turn boundary or a retry
// lands between two calls routinely; breaking on one would draw a long turn as a
// string of one-item groups, which is the clutter this exists to remove.
const TOOL = 'tool'
const NEUTRAL = 'progress'
// An assistant message. Between two calls it is a preamble to the work ("Let me
// check the config"), and a burst of work narrated call by call would otherwise
// draw as a string of one-call lines rather than the single line it reads as.
// After the last call it is the agent talking to the reader again, which is
// where the run genuinely ends. Which one it is depends on what follows, so it
// is held aside until that is known.
const SAID = 'said'

// Every tool call folds, including a lone one. A transcript in which some tool
// traffic is a counted link and some is a pair of raw rows reads as two
// different things happening; one rule applied everywhere is what makes the
// conversation the only thing left at the top level.
//
// The threshold counts *calls*, not rows: a call and its result are two rows but
// one action, so a single call and its result fold together into one line.
const MIN_CALLS = 1

// Fold every run of tool rows in the log into one summary line each.
//
// Called after any append, including a whole-tail replace, so the same pass
// handles a live event and a cold paint.
export function fold (log, sessionId) {
  if (sessionId === null) return
  let run = []
  // Narration seen since the last tool row, not yet known to be interior. It
  // joins the run if another call follows, and ends the run if one does not.
  let held = []
  // A static list: the pass inserts and removes nodes as it goes, and a live
  // NodeList would renumber underneath it.
  for (const node of [...log.children]) {
    const kind = kindOf(node)
    if (kind === TOOL) {
      // A call followed the narration, so that narration was a preamble to this
      // work rather than the end of it.
      if (run.length > 0) for (const said of held) run.push(said)
      held = []
      run.push(node)
      continue
    }
    if (kind === NEUTRAL && run.length > 0) continue
    if (kind === SAID && run.length > 0) { held.push(node); continue }
    run = close(run, sessionId)
    held = []
  }
  close(run, sessionId)
}

// Classify one row. A summary line already standing in for a run counts as part
// of one, so a pass over an already-folded log leaves it alone instead of
// wrapping it a second time.
function kindOf (node) {
  if (node.dataset === undefined) return null
  if (node.dataset.tools !== undefined) return TOOL
  if (node.dataset.role === 'tool') return TOOL
  if (node.dataset.role === 'progress') return NEUTRAL
  // Uncommitted assistant text is transient and carries no seq. Treating it as
  // a break would split a run that is still growing, then re-join it when the
  // durable frame lands — a visible flicker mid-turn.
  if (node.dataset.partial !== undefined) return NEUTRAL
  if (node.dataset.role === 'assistant') return SAID
  // Everything else — including `asked` — is unclassified, which ends the run
  // and so can never be folded away. A question put to the reader, and the
  // answer ticked into that same row, are part of the conversation rather than
  // tool traffic: they must stay legible in the scrollback forever. Do not give
  // that role a kind here.
  return null
}

// Replace one collected run with its summary line, and report the empty run the
// caller continues with.
function close (run, sessionId) {
  collapse(run, sessionId)
  return []
}

// Draw the summary line for a run and take its rows out of the transcript.
function collapse (run, sessionId) {
  if (run.length === 0) return
  // Count the calls, not the rows: a call and its result are two events but one
  // action, and a reader counts actions. A run already folded contributes the
  // count it was standing for, so re-folding after an append stays accurate.
  let calls = 0
  let first = null
  for (const node of run) {
    const folded = node.dataset.tools
    if (folded !== undefined) calls += Number(folded)
    else if (node.dataset.kind === 'call') calls += 1
    if (first === null) first = seqOf(node)
  }
  // A result can reach the page a frame before the call it belongs to, which
  // would otherwise draw a line claiming zero calls. Leave those rows alone and
  // let the next append, carrying the call, fold them.
  if (calls < MIN_CALLS || first === null) return
  // Already folded and nothing new to absorb: leave the existing line in place
  // rather than rebuilding an identical one on every append.
  if (run.length === 1 && run[0].dataset.tools === String(calls)) return
  const line = document.createElement('article')
  line.dataset.role = 'tool'
  // What this line stands for, so a later pass can re-read it rather than having
  // to look behind it, and so the run's address survives the fold.
  line.dataset.tools = String(calls)
  line.dataset.seq = String(first)
  // Where the run ended. A run now swallows the narration between its calls, so
  // its extent is no longer derivable from its first seq alone: the screen
  // behind the link has to be told where to stop, or it would run on past the
  // message the reader can still see under the line.
  const last = lastSeq(run)
  if (last !== null) line.dataset.last = String(last)
  const link = document.createElement('a')
  link.href = '/s/' + encodeURIComponent(sessionId) + '/t/' + first + (last === null ? '' : '-' + last)
  link.textContent = calls === 1 ? '1 tool call' : calls + ' tool calls'
  line.append(link)
  const anchor = run[0]
  anchor.parentNode.insertBefore(line, anchor)
  for (const node of run) node.remove()
}

// The seq a run is addressed by: its first row's. Already-folded lines carry the
// seq they were built with, so the address never drifts as a run grows.
function seqOf (node) {
  const raw = Number(node.dataset.seq)
  return Number.isSafeInteger(raw) ? raw : null
}

// The last seq a run covers. An already-folded line inside the run reports the
// end it was built with rather than its own position, so re-folding a grown run
// keeps the far edge rather than pulling it back to the summary line's seq.
function lastSeq (run) {
  let last = null
  for (const node of run) {
    const folded = Number(node.dataset.last)
    const own = seqOf(node)
    const candidate = Number.isSafeInteger(folded) ? folded : own
    if (candidate !== null && (last === null || candidate > last)) last = candidate
  }
  return last
}
