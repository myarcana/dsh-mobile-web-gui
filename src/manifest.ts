/**
 * The web app manifest, which is what lets this GUI be installed to a phone's
 * home screen.
 *
 * It is generated rather than served from a file on disk because the icons it
 * names are digest-stamped, and a digest is not knowable when a static file is
 * written. Deriving it from the live asset table is the same discipline the
 * import map follows in `shell.ts`: one snapshot, so the manifest and the files
 * it points at can never disagree.
 *
 * Its own url is *not* stamped. A manifest is fetched by the browser from the
 * `<link rel=manifest>` of whatever page is open, and an installed app re-reads
 * it to notice a changed name or icon; a stamped url would be immutable and the
 * install would keep whatever it captured on the day it was made. So this is the
 * one asset served from a stable path under a short cache, while the icons it
 * names stay immutable and free.
 *
 * Every url inside is site-root-relative, never absolute. The GUI has to answer
 * on `localhost:PORT`, `192.168.1.8:PORT`, or any name pointed at it, and an
 * absolute url baked in here would install an app that opens somebody else's
 * hostname.
 * @module
 */

import type { AssetTable } from './assets.ts'

/** Where the manifest is served. Stable by design — see the module note. */
export const MANIFEST_URL = '/app.webmanifest'

/**
 * The colour behind the icon and the system chrome of the installed app.
 *
 * DeepSeek blue, which is the background the whale mark is drawn on in
 * `client/icon.svg`. It is deliberately not one of the stylesheet's theme
 * variables: those flip with the colour scheme, and this is painted by the OS
 * before any CSS exists — a splash screen cannot read a media query.
 */
const BRAND = '#4d6bfe'

/**
 * Build the manifest for the current asset table.
 * @param assets - the digest table holding the stamped icons.
 * @returns the manifest as a JSON string, ready to serve.
 */
export function manifest(assets: AssetTable): string {
  const icons = []
  // Raster icons first, and they are what makes the app installable at all.
  //
  // A browser only offers a real install — standalone, its own icon, no address
  // bar — when the manifest promises an icon of at least 192x192. An SVG cannot
  // make that promise: it has no intrinsic size, so it is declared `sizes: any`,
  // and `any` does not match a minimum the browser has to check a number
  // against. A manifest carrying only SVGs parses perfectly and is then judged
  // uninstallable, which a phone shows as "add to home screen" quietly
  // degrading into a bookmark that opens in a browser tab.
  //
  // So both concrete sizes are named: 192 is the launcher icon, 512 is what the
  // install dialog and the splash screen are drawn from.
  for (const size of [192, 512]) {
    const png = assets.extras.get(`icon-${size}`)
    if (png !== undefined) icons.push({ src: png.url, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' })
    const mask = assets.extras.get(`icon-maskable-${size}`)
    if (mask !== undefined) icons.push({ src: mask.url, sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' })
  }
  // The scalable versions stay, listed after the rasters. They are what a
  // desktop or a future high-density launcher picks when it would rather scale
  // artwork than upscale a bitmap, and they cost nothing to offer — but they are
  // never the only icons, for the reason above.
  const any = assets.extras.get('icon')
  const maskable = assets.extras.get('icon-maskable')
  if (any !== undefined) icons.push({ src: any.url, sizes: 'any', type: 'image/svg+xml', purpose: 'any' })
  if (maskable !== undefined) icons.push({ src: maskable.url, sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' })
  return JSON.stringify({
    name: 'DeepSeek Harness Sessions',
    // What fits under an icon on a home screen. The long name is the one shown
    // in an install prompt, where there is room for it.
    short_name: 'Harness',
    // Launching at the session list rather than `/` means opening the installed
    // app always lands on the same screen. `/` redirects to the most recent
    // session, which would make the app open somewhere different every time.
    start_url: '/sessions',
    // The whole origin, so a tap on any in-app link stays inside the app rather
    // than kicking the reader out to a browser tab.
    scope: '/',
    display: 'standalone',
    // `portrait`, not `portrait-primary`: the latter pins the app to one
    // specific way up, so a phone held upside down or a tablet whose natural
    // orientation is landscape gets a rotated app. `portrait` accepts both
    // portrait orientations, which is what a reader holding a phone expects.
    orientation: 'portrait',
    // Named explicitly rather than left for a browser to infer from content.
    // It is what a launcher and a screen reader use to pick language-specific
    // rendering for the name and description below.
    lang: 'en',
    background_color: BRAND,
    theme_color: BRAND,
    description: 'Command and orchestrate DeepSeek Harness sessions from a phone.',
    icons,
  })
}
