/**
 * The edge from working into waiting, which is the only thing that notifies.
 *
 * The failure this guards against is not a crash. A wrong answer here is either
 * a phone that rings for every idle session after a restart, or a session that
 * finishes in the night and says nothing — both invisible from the server, and
 * both discovered by the reader rather than by a stack trace. So every case
 * that must stay quiet is asserted as explicitly as the cases that must fire.
 */

import { describe, expect, it } from 'vitest'
import { Transitions, stateOf, waiting } from '../src/notify.ts'
import type { Notice } from '../src/notify.ts'
import type { PendingApproval, PendingAsk, SessionSummary } from '../src/types.ts'

/** A question, filled out only as far as the classifier looks at it. */
function ask(askId: string): PendingAsk {
  return { askId, questions: [] }
}

/** A permission request, likewise. */
function approval(askId: string): PendingApproval {
  return { askId, toolName: 'Bash', reason: 'rm -rf /' }
}

/**
 * A summary row. Every field is spelled out rather than asserted into place:
 * the project bans casts, and a fixture that lies about its shape is how a test
 * keeps passing after the type it stands for has moved on.
 */
function row(
  id: string,
  running: boolean,
  asks: readonly PendingAsk[] = [],
  approvals: readonly PendingApproval[] = [],
): SessionSummary {
  return {
    id,
    title: 'Session ' + id,
    running,
    latestSeq: 1,
    workspace: 'Workspace',
    workspaceId: 'cwd:/tmp',
    workspaceOrder: 0,
    worktreeId: '',
    worktree: '',
    lastLine: 'last words of ' + id,
    empty: false,
    time: 0,
    actions: ['send'],
    sending: [],
    asks,
    approvals,
  }
}

const headings = (notices: readonly Notice[]): string[] =>
  notices.map(notice => notice.heading)

describe('classification mirrors the session list', () => {
  it('names a running session working', () => {
    expect(stateOf(row('a', true))).toBe('working')
  })

  it('names a stopped session done', () => {
    expect(stateOf(row('a', false))).toBe('done')
  })

  // A session can be running and holding a question at once; the question is
  // what the reader must act on, so it has to win.
  it('lets a question beat running', () => {
    expect(stateOf(row('a', true, [ask('q1')]))).toBe('asking')
  })

  it('treats an approval request as asking', () => {
    expect(stateOf(row('a', true, [], [approval('p1')]))).toBe('asking')
  })

  it('counts everything but working as waiting', () => {
    expect(waiting('working')).toBe(false)
    expect(waiting('done')).toBe(true)
    expect(waiting('asking')).toBe(true)
  })
})

describe('Transitions', () => {
  it('seeds on the first listing without notifying', () => {
    const transitions = new Transitions()
    expect(transitions.fold([row('a', true), row('b', false)])).toEqual([])
  })

  it('says nothing while a session keeps working', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    expect(transitions.fold([row('a', true)])).toEqual([])
  })

  it('notifies once when work stops', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    expect(headings(transitions.fold([row('a', false)]))).toEqual(['Session a has finished'])
  })

  it('does not notify again while the session stays finished', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    transitions.fold([row('a', false)])
    expect(transitions.fold([row('a', false)])).toEqual([])
  })

  it('notifies when a working session raises a question', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    expect(headings(transitions.fold([row('a', true, [ask('q1')])]))).toEqual(['Session a is asking you'])
  })

  // An archived session restored, or one created while nobody was connected, is
  // not evidence that work just stopped.
  it('seeds an unseen session silently', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    expect(transitions.fold([row('a', true), row('b', false)])).toEqual([])
  })

  it('forgets a session that leaves the listing', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    // Gone (archived), then back and already finished: restoring it must not
    // read as a transition.
    transitions.fold([])
    expect(transitions.fold([row('a', false)])).toEqual([])
  })

  it('carries the last line of the session as the body', () => {
    const transitions = new Transitions()
    transitions.fold([row('a', true)])
    const [notice] = transitions.fold([row('a', false)])
    expect(notice?.body).toBe('last words of a')
    expect(notice?.sessionId).toBe('a')
  })
})
