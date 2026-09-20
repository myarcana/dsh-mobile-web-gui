/**
 * Check the derived session-name pipeline against every session log on the box.
 *
 * The functions under test are pulled out of the BUILT bundle rather than
 * reimplemented here, so a change to `src/corpus.ts` that is not rebuilt, or a
 * rebuild that drops one of them, fails this script instead of passing it.
 *
 * Usage: node scripts/verify-names.mjs
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundle = fs.readFileSync(path.join(root, 'lib/index.js'), 'utf8')

/** Lift one declaration out of the bundle, failing loudly when it is absent. */
function grab(re) {
  const match = bundle.match(re)
  if (match === null) throw new Error(`not in built bundle: ${re}`)
  return match[0]
}

const source = [
  grab(/const FUNCTION_WORDS = new Set\([\s\S]*?\.split\(\/\\s\+\/\)\);/),
  grab(/const NAME_WORDS = \d+;/),
  grab(/const URL_PATH_MAX = \d+;/),
  grab(/function plain\(source\) \{[\s\S]*?\n\}/),
  grab(/function shortenUrl\(word\) \{[\s\S]*?\n\}/),
  grab(/function nameFromPrompt\(opening\) \{[\s\S]*?\n\}/),
].join('\n')

const { nameFromPrompt } = await import(
  `data:text/javascript,${encodeURIComponent(`${source}\nexport{nameFromPrompt}`)}`
)

let failures = 0

// Cases the real logs do not cover, pinned so a later edit cannot regress them.
const expected = [
  ['add archive buttons to sessions on the https://dsh.openclaw.test/sessions page', 'add archive buttons sessions /sessions page'],
  ['check https://example.com and report back', 'check example.com report back'],
  ['see https://dsh.openclaw.test/sessions. then fix it', 'see /sessions fix'],
  ['email me at mailto:a@b.com about titles/names', 'email mailto:a@b.com about titles/names'],
  ['', ''],
  ['the and of to with', ''],
]
console.log('— pinned cases —')
for (const [prompt, want] of expected) {
  const got = nameFromPrompt(prompt)
  const ok = got === want
  if (!ok) failures++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`)
}

// Every real log, to confirm no origin survives into a name.
const dir = path.join(process.env.HOME ?? '/root', '.dsh/sessions')
const derived = []
const counts = { durable: 0, derived: 0, empty: 0 }
for (const workspace of fs.readdirSync(dir)) {
  const wd = path.join(dir, workspace)
  if (!fs.statSync(wd).isDirectory()) continue
  for (const entry of fs.readdirSync(wd)) {
    const log = path.join(wd, entry, 'session.jsonl.zstd')
    if (!fs.existsSync(log)) continue
    // Only the head of the log is needed: a title and the first prompt both
    // land in the opening events, and decompressing whole multi-megabyte
    // transcripts for every session on the box takes minutes.
    let text = ''
    try {
      text = execSync(`zstdcat ${JSON.stringify(log)} | head -c 200000`, { maxBuffer: 1 << 28, shell: '/bin/bash' }).toString()
    } catch {
      continue
    }
    let title = ''
    let opening = ''
    for (const line of text.split('\n')) {
      if (line === '') continue
      if (!line.includes('session/title') && !line.includes('user/message')) continue
      let event
      try {
        event = JSON.parse(line)
      } catch {
        continue
      }
      if (event.type === 'session/title') title = event.data.title
      if (opening === '' && event.type === 'user/message') {
        opening = (event.data.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
      }
    }
    if (title !== '') {
      counts.durable++
      continue
    }
    const name = nameFromPrompt(opening)
    if (name === '') counts.empty++
    else {
      counts.derived++
      derived.push(name)
    }
  }
}

console.log('\n— derived names from real logs —')
for (const name of derived) console.log(`  ${name}`)

const leftover = derived.filter(name => /https?:\/\//.test(name))
if (leftover.length > 0) {
  failures++
  console.log('\nFAIL origin survived into:', leftover)
}

console.log('\ncounts:', counts)
console.log(failures === 0 ? 'all checks passed' : `${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
