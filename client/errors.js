// Every failure renders into the page in full, inside selectable text — never
// only to the console. A staff member copies it straight to a developer; a
// developer reads it during a screenshare without opening devtools.

let host = null

export function mount (element) {
  host = element
}

// Show one failure with everything needed to diagnose it.
export function show (summary, detail) {
  if (host === null) return
  const block = document.createElement('pre')
  block.className = 'error'
  block.textContent = summary + '\n\n' + detail
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
