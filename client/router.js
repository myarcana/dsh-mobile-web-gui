// Every full-screen change pushes history and changes the URL, and every URL
// opens the same screen when pasted into another browser. pushState plus a
// popstate listener: about fifteen lines, available everywhere, and its failure
// mode is never a full page navigation tearing down the stream.

let render = () => {}

export function start (fn) {
  render = fn
  addEventListener('popstate', () => render(location.pathname))
  // One delegated listener for every internal link, including the ones the
  // server rendered inside transcript frames.
  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return
    const link = event.target.closest('a')
    if (link === null || link.origin !== location.origin || link.hasAttribute('download')) return
    // A press that ended a text selection is a copy, not a navigation.
    if (!getSelection().isCollapsed) { event.preventDefault(); return }
    event.preventDefault()
    go(link.pathname + link.search + link.hash)
  })
  render(location.pathname)
}

export function go (path) {
  if (path === location.pathname + location.search + location.hash) return
  history.pushState(null, '', path)
  render(location.pathname)
}
