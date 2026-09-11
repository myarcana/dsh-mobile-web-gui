// Times always name their zone. The detailed form with the full date rides the
// title attribute, so it is there on hover and on a long press.
//
// Note the explicit components: Intl.DateTimeFormat refuses timeZoneName
// alongside the dateStyle/timeStyle shorthands, and naming the zone is the
// requirement, so the shorthands cannot be used here.

const short = new Intl.DateTimeFormat(undefined, {
  hour: 'numeric', minute: '2-digit', timeZoneName: 'long'
})
const full = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'long'
})

// Build a <time> element for one epoch-millisecond value.
export function stamp (ms) {
  const when = new Date(ms)
  const el = document.createElement('time')
  el.dateTime = when.toISOString()
  el.textContent = short.format(when)
  el.title = full.format(when)
  return el
}

// The same wording used inline in a sentence, e.g. a delivery confirmation.
export function inline (ms) {
  return short.format(new Date(ms))
}
