// Fail loudly when the page cannot run.
//
//   node scripts/check-page.mjs [origin]     default http://127.0.0.1:7778
//
// The failure this exists for is silent on both sides: the document answers 200,
// `/api/sessions` answers 200, nothing is thrown, and the page runs no code at
// all — a blank screen. It happens when a client module imports a bare specifier
// the import map has no key for, so the browser cannot resolve it and stops
// before the first statement. Nothing server-side notices, because every request
// succeeded.
//
// So this fetches the real page from the running server, reads the map the
// browser will actually receive, fetches each module the map advertises, and
// compares the two. Exit code is the answer: 0 sound, 1 broken, 2 unreachable.
//
// Node builtins only, so it runs from the checkout with no install.
//
// A check on the *served* page rather than on the source: the class of bug it
// catches is the two halves of that page disagreeing, which no amount of reading
// the files can rule out.

const origin = (process.argv[2] ?? 'http://127.0.0.1:7778').replace(/\/+$/, '')
const path = process.argv[3] ?? '/sessions'

/** Bare specifiers need a map key; paths and URLs do not. */
function isBare (specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return false
  return !specifier.includes(':')
}

/** Every bare specifier a module source imports statically. */
function importsOf (source) {
  const found = []
  // Two statement shapes, because ESM admits two: `import 'y'` with no clause,
  // and `import … from 'y'` / `export … from 'y'` with one. The second requires
  // the literal `from`, which is what keeps `export const x = 'a string'` from
  // being read as an import of `a string` — a false positive that would fail a
  // perfectly sound page. The clause may span lines but never a `;`, and a `(`
  // is excluded so a dynamic `import('y')` does not count: that resolves at run
  // time and cannot blank the page.
  const clause = /(?:^|[\n;}])\s*import\s*['"]([^'"]+)['"]|(?:^|[\n;}])\s*(?:import|export)\s+[\w\s*{},$]*?\bfrom\s*['"]([^'"]+)['"]/g
  for (const match of source.matchAll(clause)) {
    const specifier = match[1] ?? match[2]
    if (specifier !== undefined && specifier !== '') found.push(specifier)
  }
  return found
}

let document
try {
  const response = await fetch(`${origin}${path}`)
  if (!response.ok) {
    console.error(`FAIL  GET ${path} answered HTTP ${response.status}`)
    process.exit(2)
  }
  document = await response.text()
} catch (error) {
  console.error(`FAIL  could not reach ${origin} — is the GUI running? (${String(error)})`)
  process.exit(2)
}

const mapTag = /<script type=importmap[^>]*>([\s\S]*?)<\/script>/.exec(document)
if (mapTag === null) {
  console.error('FAIL  the page carries no import map, so no module can resolve')
  process.exit(1)
}
let map
try {
  map = JSON.parse(mapTag[1]).imports
} catch (error) {
  console.error(`FAIL  the import map is not JSON: ${String(error)}`)
  process.exit(1)
}
const keys = Object.keys(map)
console.log(`import map: ${keys.length} key(s)`)

const failures = []
// Every advertised module must actually serve. A 404 entry module stops all
// client code just as surely as a missing key does.
for (const [name, url] of Object.entries(map)) {
  try {
    const response = await fetch(`${origin}${url}`)
    if (!response.ok) failures.push(`the map advertises ${name} at ${url}, which answers HTTP ${response.status}`)
  } catch (error) {
    failures.push(`the map advertises ${name} at ${url}, which could not be fetched: ${String(error)}`)
  }
}

// Every bare specifier every advertised module imports must have a key. The
// whole set is walked, not only the entry: a nested module naming a missing file
// breaks the chain the entry loads through, and blanks the page the same way.
const keySet = new Set(keys)
let checked = 0
for (const [name, url] of Object.entries(map)) {
  let source
  try {
    const response = await fetch(`${origin}${url}`)
    if (!response.ok) continue
    source = await response.text()
  } catch {
    continue
  }
  checked += 1
  for (const specifier of importsOf(source)) {
    if (!isBare(specifier)) continue
    if (!keySet.has(specifier)) failures.push(`${name} imports "${specifier}", which has no key in the import map and no client/${specifier}.js behind it`)
  }
}
console.log(`modules parsed: ${checked}`)

// The server renders its own notice when it already knows the page is broken,
// so its presence is independent evidence — and its absence is not proof, which
// is why the checks above do the deciding.
const noticed = /data-notice=unresolved/.test(document)

if (failures.length === 0) {
  console.log(`\nOK  ${origin}${path} — every imported specifier resolves${noticed ? ' (but the page carries a notice: the server thinks otherwise)' : ''}`)
  process.exit(noticed ? 1 : 0)
}
for (const failure of failures) console.error(`FAIL  ${failure}`)
console.error(`\n${failures.length} unresolved import(s) — the page would run no JavaScript and appear blank.`)
process.exit(1)
