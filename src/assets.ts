/**
 * Digest-stamped static delivery.
 *
 * Every client module is read once at boot, hashed, and served immutably under
 * its digest. A one-line fix expires one file rather than all of them, and a
 * dropped request costs one module rather than the app.
 * @module
 */

import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { brotliCompressSync, constants, gzipSync } from 'node:zlib'

/** One client file, hashed and pre-compressed at boot. */
export interface Asset {
  /** Digest-stamped path, e.g. `/m/view-a1b2c3d4.js`. */
  readonly url: string
  readonly type: string
  readonly bytes: Buffer
  readonly brotli: Buffer
  readonly gzip: Buffer
}

/** Bare module name to its stamped asset, plus the raw bytes of non-module files. */
export interface AssetTable {
  /** ES modules, keyed by bare specifier (`view`, `stream`, …). */
  readonly modules: ReadonlyMap<string, Asset>
  /** Everything else, keyed by its stamped url. */
  readonly byUrl: ReadonlyMap<string, Asset>
  /** The stylesheet, needed by the shell's preload list. */
  readonly stylesheet: Asset
}

/** Content types this server serves. No other extension is admitted. */
const TYPES: Readonly<Record<string, string>> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

/**
 * Read, hash, and compress every client file.
 * @param dir - the directory holding the client sources.
 * @returns the immutable table the shell and the static route share.
 * @throws Error when the stylesheet is missing, which would leave the page unstyled.
 */
export async function loadAssets(dir: string): Promise<AssetTable> {
  const modules = new Map<string, Asset>()
  const byUrl = new Map<string, Asset>()
  let stylesheet: Asset | undefined
  for (const name of (await readdir(dir)).sort()) {
    const extension = name.slice(name.lastIndexOf('.'))
    const type = TYPES[extension]
    if (type === undefined) continue
    const bytes = await readFile(`${dir}/${name}`)
    const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 8)
    const base = name.slice(0, name.length - extension.length)
    const asset: Asset = {
      url: `/m/${base}-${digest}${extension}`,
      type,
      bytes,
      brotli: brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
      gzip: gzipSync(bytes, { level: 9 }),
    }
    byUrl.set(asset.url, asset)
    if (extension === '.js') modules.set(base, asset)
    if (extension === '.css') stylesheet = asset
  }
  if (stylesheet === undefined) throw new Error(`web GUI client assets are missing a stylesheet in ${dir}`)
  return { modules, byUrl, stylesheet }
}

/**
 * Pick the best encoding the client accepts.
 * @param asset - the asset being served.
 * @param accept - the request's `Accept-Encoding` header.
 * @returns the body to send and the `Content-Encoding` to declare, if any.
 */
export function encoded(asset: Asset, accept: string | undefined): { body: Buffer; encoding?: string } {
  const offered = accept ?? ''
  if (offered.includes('br')) return { body: asset.brotli, encoding: 'br' }
  if (offered.includes('gzip')) return { body: asset.gzip, encoding: 'gzip' }
  return { body: asset.bytes }
}
