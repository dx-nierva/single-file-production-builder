/**
 * Recursively resolves @import statements inside an already-matched
 * stylesheet, splicing each local target's own (recursively expanded)
 * content in place of the statement. Reuses minifyCss's own string/url()/
 * comment-aware character walk (via its exported helpers) so an
 * @import-shaped substring inside a string or comment is never mistaken
 * for a real statement, and resolveHref (feature 2) so path resolution
 * never diverges from every other reference in this app.
 *
 * The same walk also embeds any other url(...) it finds - a background
 * image, an @font-face source, and so on (feature 11). This runs inside the
 * per-file recursion rather than as a second pass over the flattened output,
 * because a nested @import-ed file's own relative url(...) has to resolve
 * against that file's own path, not the top-level stylesheet's; once the
 * text is spliced into the parent's output that distinction is gone.
 */

import { readString, readUrl, startsUrl } from './minify.js'
import { resolveHref } from './references.js'
import { isAssetType } from './files.js'

function isSpace(char) {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r' || char === '\f'
}

function isImportKeywordAt(source, i) {
  if (source.slice(i, i + 7).toLowerCase() !== '@import') return false

  const before = source[i - 1]
  if (before !== undefined && /[A-Za-z0-9_-]/.test(before)) return false

  const after = source[i + 7]
  return after === undefined || isSpace(after) || after === '"' || after === "'"
}

function unwrapQuotes(inner) {
  const first = inner[0]
  const last = inner[inner.length - 1]
  if ((first === '"' || first === "'") && first === last) return inner.slice(1, -1)
  return inner
}

/** The unquoted, trimmed target inside a `url(...)` token (the full
    `source.slice(start, end)` text, including the "url(" and ")"). */
function urlTarget(token) {
  return unwrapQuotes(token.slice(4, -1).trim())
}

/**
 * Resolve one non-@import url(...) token found while walking `path`'s own
 * source. Returns the token unchanged (with an event describing why) for an
 * empty, external, missing, or matched-but-non-asset target; returns a
 * rewritten data-URI token, with an `embedded` event, for a matched image or
 * font. Leaving a matched-but-non-asset target untouched with no event is
 * deliberate: this feature only knows how to embed images and fonts.
 */
function embedAssetUrl(token, path, files, events) {
  const target = urlTarget(token)
  if (target === '') return token

  const { resolvedPath, external } = resolveHref(target, path)

  if (external) {
    events.push({ status: 'asset-external', target })
    return token
  }

  if (resolvedPath === null || !files.has(resolvedPath)) {
    events.push({ status: 'asset-missing', target })
    return token
  }

  const asset = files.get(resolvedPath)
  if (!isAssetType(asset.type) || asset.base64 == null) return token

  events.push({ status: 'embedded', target: resolvedPath, size: asset.size })
  return `url("data:${asset.type};base64,${asset.base64}")`
}

/**
 * Parses one @import statement starting at `start` (already confirmed to be
 * "@import" by isImportKeywordAt). Returns null for anything this cannot
 * read confidently - the caller then leaves the text untouched rather than
 * guess, matching minify.js's own rule.
 */
function parseImport(source, start) {
  let i = start + 7
  while (i < source.length && isSpace(source[i])) i += 1
  if (i >= source.length) return null

  let target

  if (startsUrl(source, i)) {
    const end = readUrl(source, i)
    if (end === -1) return null
    target = unwrapQuotes(source.slice(i + 4, end - 1).trim())
    i = end
  } else if (source[i] === '"' || source[i] === "'") {
    const end = readString(source, i)
    if (end === -1) return null
    target = source.slice(i + 1, end - 1)
    i = end
  } else {
    return null
  }

  const semi = source.indexOf(';', i)
  if (semi === -1) {
    // A recognizable url()/string target with no closing `;` anywhere before
    // EOF: nothing later in the file can be a valid statement either, so the
    // caller leaves everything from here to the end untouched. `tail: null`
    // (rather than falling through as if no target had been found at all)
    // tells the caller this target was already consumed here, so the
    // general url() branch must not re-examine it as a standalone asset.
    return { target, tail: null, end: source.length }
  }

  return { target, tail: source.slice(i, semi), end: semi + 1 }
}

export function resolveCssImports(path, files, seen = new Set()) {
  const source = files.get(path).content ?? ''
  const events = []

  seen.add(path)

  let out = ''
  let i = 0

  while (i < source.length) {
    const char = source[i]

    if (char === '"' || char === "'") {
      const end = readString(source, i)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      out += source.slice(i, end)
      i = end
      continue
    }

    if (startsUrl(source, i)) {
      const end = readUrl(source, i)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      // @import's own url(...) is fully consumed by isImportKeywordAt/
      // parseImport below before this branch ever runs at that position, so
      // any url(...) reaching here is an ordinary reference (background
      // image, @font-face source, etc.), never an @import target.
      out += embedAssetUrl(source.slice(i, end), path, files, events)
      i = end
      continue
    }

    if (char === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end === -1) {
        out += source.slice(i)
        break
      }
      out += source.slice(i, end + 2)
      i = end + 2
      continue
    }

    if (isImportKeywordAt(source, i)) {
      const parsed = parseImport(source, i)

      if (parsed) {
        const { target, tail, end } = parsed

        // No closing `;` was found before EOF: leave the untouched target
        // (and everything after it) exactly as authored, without letting the
        // general url() branch re-examine it as a standalone asset.
        if (tail === null) {
          out += source.slice(i, end)
          i = end
          continue
        }

        // A media/supports()/layer()-qualified import is invisible to this
        // feature entirely - left as ordinary text, no event.
        if (tail.trim() !== '') {
          out += source.slice(i, end)
          i = end
          continue
        }

        const { resolvedPath, external } = resolveHref(target, path)

        if (external) {
          out += source.slice(i, end)
          events.push({ status: 'external', target })
          i = end
          continue
        }

        if (resolvedPath === null || !files.has(resolvedPath)) {
          events.push({ status: 'missing', target })
          i = end
          continue
        }

        if (seen.has(resolvedPath)) {
          events.push({ status: 'circular', target: resolvedPath })
          i = end
          continue
        }

        const nested = resolveCssImports(resolvedPath, files, seen)
        out += nested.code
        events.push({ status: 'matched', target: resolvedPath, size: files.get(resolvedPath).size })
        events.push(...nested.events)
        i = end
        continue
      }
    }

    out += char
    i += 1
  }

  seen.delete(path)
  return { code: out, events }
}
