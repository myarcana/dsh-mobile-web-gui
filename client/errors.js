// Every failure renders into the page in full, inside selectable text — never
// only to the console. A staff member copies it straight to a developer; a
// developer reads it during a screenshare without opening devtools.

let host = null

export function mount (element) {
  host = element
}

// Show one failure with everything needed to diagnose it.
//
// Dismissable, because these accumulate: a flaky connection can stack up a
// screenful of the same failed request, and a reader who has copied one out (or
// simply reconnected) needs the page back. Closing is the only thing the button
// does — nothing is retried and nothing is reported — so a failure never leaves
// the page on its own, only when someone says so.
export function show (summary, detail) {
  if (host === null) return
  const block = document.createElement('section')
  block.className = 'error'
  const close = document.createElement('button')
  close.type = 'button'
  close.className = 'dismiss'
  close.textContent = 'Dismiss'
  // Names what goes away, so with several stacked failures it is clear which
  // one this button closes.
  close.title = 'Dismiss: ' + summary
  close.addEventListener('click', () => block.remove())
  const text = document.createElement('pre')
  text.textContent = summary + '\n\n' + detail
  block.append(close, text)
  host.append(block)
}

// Describe a failed fetch completely: method, full URL, status, body.
export async function fromResponse (method, url, response, extra) {
  let body = ''
  try { body = await response.text() } catch (error) { body = 'Response body unreadable: ' + error }
  show(method + ' ' + url + ' failed', [
    'Status: ' + response.status + ' ' + response.statusText,
    'Request: ' + method + ' ' + new URL(url, location.href).href,
    extra === undefined ? '' : extra,
    'Response body:',
    body,
    'At: ' + new Date().toString()
  ].filter(Boolean).join('\n'))
}

// Route uncaught failures into the same renderer rather than the console.
export function listen () {
  addEventListener('error', event => {
    show('Uncaught error', (event.error && event.error.stack) || event.message)
  })
  addEventListener('unhandledrejection', event => {
    const reason = event.reason
    show('Unhandled rejection', (reason && reason.stack) || String(reason))
  })
}
