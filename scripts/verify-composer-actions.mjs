/**
 * The composer's action row: Clear, Merge, Rebase, Undo.
 *
 * Guards the bug that made Merge and Rebase do nothing on Safari while working
 * everywhere else. WebKit does not focus a <button> when it is pressed, so the
 * press blurred the textarea and moved focus to nothing; a blur handler that
 * asked `activeElement` where focus had gone concluded the reader had left and
 * hid the row one frame into the press. A click is only synthesised when press
 * and release land on the same rendered element, so the release landed on a
 * hidden button and no click was ever dispatched. What the reader saw was the
 * message box losing its caret and nothing else happening.
 *
 * Runs in WebKit, because that is the only engine the bug ever appeared in.
 */
import { webkit } from '/usr/lib/node_modules/playwright/index.mjs'

const ORIGIN = process.env.GUI_ORIGIN ?? 'http://127.0.0.1:7778'
const fails = []
const ok = (name, condition) => {
  console.log((condition ? 'PASS ' : 'FAIL ') + name)
  if (!condition) fails.push(name)
}

const browser = await webkit.launch()
const page = await browser.newPage({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } })
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.goto(ORIGIN + '/', { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1200)

const box = page.locator('#box')
await box.tap()
await page.waitForTimeout(300)
ok('row opens while writing', await page.locator('#merge').isVisible())

// The press WebKit actually performs: pointer down on the button, textarea
// blurred, focus given to nothing.
await page.evaluate(() => {
  document.getElementById('merge').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.getElementById('box').blur()
})
await page.waitForTimeout(300)
ok('row survives a press that focuses nothing', await page.locator('#merge').isVisible())
await page.evaluate(() => {
  document.getElementById('merge').dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
})
await page.waitForTimeout(300)

await box.tap()
await box.fill('')
await page.waitForTimeout(200)
await page.locator('#merge').tap()
await page.waitForTimeout(500)
ok('Merge writes its prompt', (await box.inputValue()).includes('onto develop'))

await page.locator('#rebase').tap()
await page.waitForTimeout(500)
ok('Rebase writes its prompt', (await box.inputValue()).startsWith('Pull develop'))

await page.locator('#clear').tap()
await page.waitForTimeout(400)
ok('Clear empties the box', (await box.inputValue()) === '')

await page.locator('#undo').tap()
await page.waitForTimeout(400)
ok('Undo puts back what Clear took', (await box.inputValue()).startsWith('Pull develop'))

// Leaving for something that takes no focus still ends the act of writing.
await page.mouse.click(50, 200)
await page.waitForTimeout(500)
ok('row closes once the reader leaves', !(await page.locator('#merge').isVisible()))

ok('no page errors', errors.length === 0)
if (errors.length > 0) console.log(errors.join('\n'))

await browser.close()
console.log(fails.length > 0 ? '\nFAILURES: ' + fails.join(', ') : '\nAll checks passed.')
process.exit(fails.length > 0 ? 1 : 0)
