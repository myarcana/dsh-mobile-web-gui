/**
 * Digest-stamped static delivery.
 *
 * Every client module is hashed and served immutably under its digest. A
 * one-line fix expires one file rather than all of them, and a dropped request
 * costs one module rather than the app.
 *
 * The table is read once at boot, and {@link AssetTable.refresh} re-reads the
 * files that changed since. Without that refresh a rebuild would not be served
 * until the process restarted — which also kills every turn in flight — so a
 * page request calls it and a rebuild lands on the next load.
 * @module
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** One client file, hashed and pre-compressed. */
export interface Asset {
  /** Digest-stamped path, e.g. `/m/view-a1b2c3d4.js`. */
  readonly url: string
  readonly type: string
  readonly bytes: Buffer
  readonly brotli: Buffer
  readonly gzip: Buffer
  /**
   * Whether {@link Asset.bytes} is already a compressed format.
   *
   * Set for PNG, where {@link Asset.brotli} and {@link Asset.gzip} are the raw
   * bytes rather than encodings of them. {@link encoded} reads this instead of
   * comparing buffers, so it can never announce a `Content-Encoding` the body
   * does not actually carry — which would reach the browser as a corrupt image.
   */
  readonly precompressed: boolean
}

/** Bare module name to its stamped asset, plus the raw bytes of non-module files. */
export interface AssetTable {
  /** ES modules, keyed by bare specifier (`view`, `stream`, …). */
  readonly modules: ReadonlyMap<string, Asset>
  /** Everything else, keyed by its stamped url. */
  readonly byUrl: ReadonlyMap<string, Asset>
  /**
   * Non-module, non-stylesheet files keyed by their base name (`icon`,
   * `app.webmanifest` minus its extension, …).
   *
   * The shell needs the *current* stamped url for the manifest and the icons,
   * and it can only get it by name — the digest is not knowable in advance.
   * Keeping them here rather than only in {@link AssetTable.byUrl} is also what
   * lets a scan recognise that it has already read them, so they are neither
   * re-compressed on every page request nor left behind as dead urls.
   */
  readonly extras: ReadonlyMap<string, Asset>
  /** The stylesheet, needed by the shell's preload list. */
  readonly stylesheet: Asset
  /**
   * Re-read every client file whose size or mtime changed since the last scan.
   *
   * Cheap when nothing changed (one `readdir` plus one `stat` per file) and
   * already-scanned files are never re-hashed, so calling it per page request
   * costs no compression. A file that changed gets a new digest, which is what
   * expires exactly that module in every browser cache.
   * @returns a promise that settles when the table is current.
   */
  refresh(): Promise<void>
}

/** Content types this server serves. No other extension is admitted. */
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  // The installable-app icons. A browser will not offer to install a site whose
  // manifest cannot promise it a raster icon of at least 192x192, and `sizes`
  // on an SVG cannot make that promise — see the icon note in `manifest.ts`.
  '.png': 'image/png',
}

/**
 * Extensions whose bytes are already compressed.
 *
 * Re-compressing a PNG spends real CPU at every scan to produce something
 * slightly larger than the original, so these are stored uncompressed and
 * served as-is; {@link encoded} then offers them with no `Content-Encoding`.
 */
const PRECOMPRESSED: ReadonlySet<string> = new Set(['.png'])

/**
 * Read, hash, and compress every client file.
 * @param dir - the directory holding the client sources.
 * @returns the immutable table the shell and the static route share, already current.
 * @throws Error when the stylesheet is missing, which would leave the page unstyled.
 */
export async function loadAssets(dir: string): Promise<AssetTable> {
  const modules = new Map<string, Asset>()
  const byUrl = new Map<string, Asset>()
  const extras = new Map<string, Asset>()
  /** File name to `mtimeMs:size` — the cheap key that says whether its bytes changed. */
  const stamps = new Map<string, string>()
  let stylesheet: Asset | undefined
  let scanning: Promise<void> | undefined

  /**
   * Bring the table up to date with the directory.
   *
   * Only files whose stamp moved are read and re-compressed, and a scan never
   * leaves the table half-updated: a file that vanished is dropped rather than
   * served from the bytes it had when it was last seen.
   */
  const scan = async (): Promise<void> => {
    const present = new Set<string>()
    for (const name of (await readdir(dir)).sort()) {
      const extension = name.slice(name.lastIndexOf('.'))
      const type = TYPES[extension]
      if (type === undefined) continue
      present.add(name)
      const info = await stat(`${dir}/${name}`)
      const base = name.slice(0, name.length - extension.length)
      // The stamp says the bytes did not move. That is only a reason to skip the
      // work if the table is actually still serving them: the url the shell
      // advertises for this module has to be in `byUrl`, or the page references
      // a module that 404s and no client code runs at all. Checking the table
      // rather than trusting the stamp makes a scan self-healing, which matters
      // because these maps are mutated in place while requests read them.
      // Which slot this file occupies. Every admitted extension has one, so a
      // manifest or an icon is remembered exactly as a module is; a file kind
      // with nowhere to be held would be re-read and re-compressed on every
      // page request and would leak its superseded urls into `byUrl` forever.
      const held = extension === '.css' ? stylesheet : extension === '.js' ? modules.get(base) : extras.get(base)
      if (stamps.get(name) === `${info.mtimeMs}:${info.size}` && held !== undefined && byUrl.has(held.url)) continue
      const bytes = await readFile(`${dir}/${name}`)
      const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
      const url = `/m/${base}-${digest}${extension}`
      stamps.set(name, `${info.mtimeMs}:${info.size}`)
      // A rebuild that reproduces the same bytes (a touch, a no-op edit) keeps
      // the digest, so the already-served asset stands and nothing re-compresses.
      const replaced = held
      if (replaced?.url === url) {
        // Same bytes as the asset already held, so the expensive re-compression
        // is skipped — but put it back in `byUrl` if something removed it, so
        // the url the shell is advertising is always one this server answers.
        byUrl.set(url, replaced)
        continue
      }
      const precompressed = PRECOMPRESSED.has(extension)
      const asset: Asset = {
        url,
        type,
        bytes,
        // Already-compressed bytes are held once and shared by all three slots,
        // so nothing re-compresses them and `encoded` has something to return
        // whichever encoding a client asks for.
        brotli: precompressed ? bytes : brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gzip: precompressed ? bytes : gzipSync(bytes, { level: 9 }),
        precompressed,
      }
      // Content moved, so its old stamped url stops being served; the new one is
      // what the next shell render references. An already-open page holds its
      // modules in memory and never re-fetches them, so it is unaffected.
      if (replaced !== undefined) byUrl.delete(replaced.url)
      byUrl.set(url, asset)
      if (extension === '.js') modules.set(base, asset)
      else if (extension === '.css') stylesheet = asset
      else extras.set(base, asset)
    }
    for (const name of [...stamps.keys()]) {
      if (present.has(name)) continue
      stamps.delete(name)
      const extension = name.slice(name.lastIndexOf('.'))
      const base = name.slice(0, name.length - extension.length)
      // A vanished stylesheet is kept rather than dropped: it is only ever
      // missing mid-edit, and a page with last-known styling beats an unstyled
      // one until the file returns.
      if (extension === '.css') continue
      const gone = extension === '.js' ? modules.get(base) : extras.get(base)
      if (gone === undefined) continue
      if (extension === '.js') modules.delete(base)
      else extras.delete(base)
      byUrl.delete(gone.url)
    }
  }

  const refresh = async (): Promise<void> => {
    // One scan at a time. A page load is a document request plus one request per
    // module, and they must not each walk the directory.
    scanning ??= scan().finally(() => { scanning = undefined })
    return scanning
  }

  await scan()
  if (stylesheet === undefined) throw new Error(`web GUI client assets are missing a stylesheet in ${dir}`)
  // `modules` and `byUrl` are the live maps, so mutations through `refresh` are
  // visible to holders of the table; `stylesheet` is a plain slot and needs a
  // getter, or a rebuilt stylesheet would keep serving the boot-time bytes.
  return {
    modules,
    byUrl,
    extras,
    get stylesheet(): Asset {
      if (stylesheet === undefined) throw new Error('web GUI client assets lost their stylesheet')
      return stylesheet
    },
    refresh,
  }
}

/**
 * Pick the best encoding the client accepts.
 * @param asset - the asset being served.
 * @param accept - the request's `Accept-Encoding` header.
 * @returns the body to send and the `Content-Encoding` to declare, if any.
 */
export function encoded(asset: Asset, accept: string | undefined): { body: Buffer; encoding?: string } {
  const offered = accept ?? ''
  // A PNG is already compressed and is stored undisguised, so it goes out
  // plain. Claiming an encoding here would describe bytes that were never
  // encoded, and the browser would decode a valid image into garbage.
  if (asset.precompressed) return { body: asset.bytes }
  if (offered.includes('br')) return { body: asset.brotli, encoding: 'br' }
  if (offered.includes('gzip')) return { body: asset.gzip, encoding: 'gzip' }
  return { body: asset.bytes }
}
