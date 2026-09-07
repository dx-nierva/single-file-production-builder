/**
 * Fetches a page and its same-origin CSS/JS references, reconstructing the
 * exact { files, rootName } shape buildFileEntries already produces, so the
 * rest of the app cannot tell a URL-sourced project from a local one.
 */

import { extractReferences, resolveHref } from './references.js'
import { inferType, isTextType, basename } from './files.js'

const REQUEST_TIMEOUT_MS = 15000

export async function fetchProject(rawUrl) {
  const pageUrl = parseUrl(rawUrl)

  const entryResponse = await timedFetch(pageUrl.href)
  if (!entryResponse.ok) {
    throw new Error(`The site responded with an error (HTTP ${entryResponse.status}).`)
  }

  const contentType = entryResponse.headers.get('content-type') ?? ''
  if (!contentType.toLowerCase().includes('text/html')) {
    throw new Error("That URL didn't return an HTML page.")
  }

  const html = await entryResponse.text()
  const files = new Map()
  files.set('index.html', {
    path: 'index.html',
    name: 'index.html',
    type: 'text/html',
    size: byteLength(html),
    content: html,
  })

  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const { rawHref } of extractReferences(doc)) {
    const { resolvedPath, external } = resolveHref(rawHref, 'index.html')
    if (external || resolvedPath === null || files.has(resolvedPath)) continue

    try {
      const assetUrl = new URL(rawHref, pageUrl).href
      const assetResponse = await timedFetch(assetUrl)
      if (!assetResponse.ok) continue

      const type = inferType(assetResponse.headers.get('content-type'), resolvedPath)
      const content = isTextType(type) ? await assetResponse.text() : null
      files.set(resolvedPath, {
        path: resolvedPath,
        name: basename(resolvedPath),
        type,
        size: content === null ? 0 : byteLength(content),
        content,
      })
    } catch {
      // Any per-asset failure (network, CORS, a bad status, a timeout) is
      // indistinguishable from a locally missing file, so it is simply left
      // out of `files`. analyze()/compile() already classify that "missing".
    }
  }

  return { files, rootName: pageUrl.hostname }
}

function parseUrl(rawUrl) {
  try {
    return new URL(String(rawUrl ?? '').trim())
  } catch {
    throw new Error(
      "That doesn't look like a valid URL. Include the scheme (for example https://example.com).",
    )
  }
}

async function timedFetch(url) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    return await fetch(url, { signal: controller.signal })
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('Fetching that URL took too long and was cancelled.')
    }
    // The Fetch API gives no way to tell a CORS block apart from a plain
    // network failure, so this names both causes rather than guessing.
    throw new Error(
      'Could not reach that URL. It may be offline, or the site may not allow cross-origin requests from this app (a CORS restriction).',
    )
  } finally {
    clearTimeout(timer)
  }
}

/** Matches compile.js's own byte accounting so Stats stays consistent
 *  regardless of which input method produced a project. */
function byteLength(str) {
  return new TextEncoder().encode(str).length
}
