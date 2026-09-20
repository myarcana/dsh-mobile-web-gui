# Vendored third-party source

Copied here rather than installed, because this package is `#NoBuild` for the
client and carries no runtime dependencies. Vendoring keeps the dependency count
at zero while still using a real, tested parser instead of a hand-rolled one.

## marked

- Version: 18.0.13
- License: MIT (see `LICENSE`)
- Upstream: https://github.com/markedjs/marked
- File: `marked.js`, derived from the published `lib/marked.esm.js`.

Only the **lexer** is used, and only the lexer is kept. `marked.js` is the
upstream file's source verbatim up to the end of the `Lexer` class, with a
single `export { x as Lexer }` appended; everything after that point is deleted.
That removes the `Renderer`, `TextRenderer`, `Parser`, `Hooks`, the `Marked`
class, the extension/plugin system and the top-level `marked()` entry points —
about 10 KB whose only job is turning tokens into HTML, which this package never
does.

`marked.d.ts` is deliberately not vendored: `../markdown.ts` declares the token
fields it reads, so upstream's 28 KB declaration file was dead weight.

Dropping the renderer is a safety property as well as a size one. `../markdown.ts`
maps the token tree into the closed `Node` vocabulary from `../node.ts`, which is
what allows the browser to insert transcript HTML with `insertAdjacentHTML` and
ship no sanitizer. With the renderer absent, marked's HTML output cannot be
reached even by mistake.

### Re-vendoring a new release

Never edit `marked.js`. To move to a new version:

1. `npm pack marked@<version>` and unpack it.
2. Take `lib/marked.esm.js` and cut it immediately before the renderer class
   that follows the `Lexer` class (in 18.0.13 the lexer ends at byte 34024,
   where `var P=class` begins). Drop the trailing `sourceMappingURL` comment,
   since the map is not vendored.
3. Append `export { x as Lexer }`, renaming `x` if upstream's minified
   identifier for the `Lexer` class changed.
4. Re-apply the header comment recording the version and what was removed.
5. Prove the trim changed nothing: lex a corpus of GFM and hostile inputs with
   both the full and trimmed builds and assert the token trees are identical.
   `../../tests/serialize.spec.ts` covers the same ground end to end.
