/**
 * Merge and Rebase collect the worktree name before writing their prompt.
 *
 * Guards the bug where the draft was written with a WORKTREE placeholder and
 * only the *first* occurrence was selected for the reader to type over. Merge
 * names the checkout four times, so answering it left three literal WORKTREEs
 * in a message that was then sent.
 *
 * Runs in WebKit, the engine the composer's other bugs appeared in, and the one
 * whose handling of `window.prompt` the old code was written to avoid.
 */
import { webkit } from '/usr/lib/node_modules/playwright/index.mjs'

const ORIGIN = process.env.GUI_ORIGIN ?? 'http://127.0.0.1:7778'
const fails = []
const ok = (name, condition, detail) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + name + (condition ? '' : ' -- ' + detail))
  if (!condition) fails.push(name)
}

const browser = await webkit.launch()
const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

const box = page.locator('#box')
await box.tap()
await page.waitForTimeout(300)

// Force the "page does not know the checkout" path, so the buttons must ask.
// A session list frame repaints the header and re-reveals the button, so hold it
// hidden rather than setting it once: the repaint is exactly what raced the
// first version of this test.
const hideInsert = () => page.evaluate(() => {
  const insert = document.getElementById('insert-worktree')
  insert.hidden = true
  clearInterval(window.__hold)
  window.__hold = setInterval(() => { insert.hidden = true }, 50)
})
await hideInsert()

// Answer the dialog with a name that shares no text with the prompts, so any
// surviving placeholder is unmistakable.
let asked = 0
page.on('dialog', async dialog => {
  asked += 1
  await dialog.accept('feature-xyz')
})

await box.fill('')
await page.locator('#merge').tap()
await page.waitForTimeout(600)
let text = await box.inputValue()
ok('Merge asks for the name', asked === 1, 'prompts seen: ' + asked)
ok('Merge leaves no placeholder', !text.includes('WORKTREE'), text)
// Merge names the checkout three times: what to rebase, whose work to apply,
// and which worktree to remove.
ok('Merge substitutes every occurrence',
  text.split('feature-xyz').length - 1 === 3,
  'occurrences: ' + (text.split('feature-xyz').length - 1) + ' in ' + text)

await box.fill('')
await page.locator('#rebase').tap()
await page.waitForTimeout(600)
text = await box.inputValue()
ok('Rebase asks for the name', asked === 2, 'prompts seen: ' + asked)
ok('Rebase leaves no placeholder', !text.includes('WORKTREE'), text)
ok('Rebase substitutes every occurrence',
  text.split('feature-xyz').length - 1 === 2,
  'occurrences: ' + (text.split('feature-xyz').length - 1) + ' in ' + text)

// Cancelling must not disturb the draft the reader already had.
page.removeAllListeners('dialog')
page.on('dialog', async dialog => { asked += 1; await dialog.dismiss() })
await box.fill('keep me')
await page.locator('#merge').tap()
await page.waitForTimeout(600)
ok('Cancel leaves the draft alone', (await box.inputValue()) === 'keep me', await box.inputValue())

// A known checkout is used directly: no question a reader would answer by
// retyping what is already on screen.
const before = asked
await page.evaluate(() => {
  clearInterval(window.__hold)
  const insert = document.getElementById('insert-worktree')
  insert.hidden = false
  insert.textContent = 'known-tree'
})
await box.fill('')
await page.locator('#rebase').tap()
await page.waitForTimeout(600)
text = await box.inputValue()
ok('Known checkout is not asked about', asked === before, 'prompts seen: ' + (asked - before))
ok('Known checkout is used', text.includes('known-tree') && !text.includes('WORKTREE'), text)

ok('no page errors', errors.length === 0, errors.join('\n'))

await browser.close()
console.log(fails.length > 0 ? '\nFAILURES: ' + fails.join(', ') : '\nAll checks passed.')
process.exit(fails.length > 0 ? 1 : 0)
