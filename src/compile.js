/**
 * Turns the entry document and its matched stylesheets and scripts into one
 * self-contained HTML string: minified CSS and JS inlined in place, missing
 * references dropped, external references left alone. Narrates the walk as
 * stats and a step-by-step log, so a compile is never a silent black box and
 * a minifier warning (feature 4's own deferred obligation) finally reaches
 * the user.
 *
 * Reuses feature 2's classification and resolution directly rather than
 * trusting a separately-produced list to line up with a fresh DOM walk by
 * position - that kind of implicit correspondence between two independently
 * built lists is exactly what has broken before in this codebase.
 */

import { classifyNode, resolveHref, classify } from './references.js'
import { minifySource } from './minify.js'
import { formatSize } from './files.js'
import { resolveCssImports } from './css-imports.js'

const encoder = new TextEncoder()

/** Byte length of a JS string. str.length counts UTF-16 units, not bytes. */
function byteLength(str) {
  return encoder.encode(str).length
}

function describeReferenceCount(count) {
  if (count === 0) return 'no references'
  return count === 1 ? '1 reference' : `${count} references`
}

/**
 * "N% smaller", or "N% larger" when compiling did not shrink the document.
 * Exported so the Result card's Saved row reports the identical figure the
 * done log entry does, from one calculation rather than two.
 */
export function describeSavings(originalBytes, compiledBytes) {
  if (originalBytes === 0) return '0% smaller'
  const delta = originalBytes - compiledBytes
  const percent = Math.round((Math.abs(delta) / originalBytes) * 100)
  return delta >= 0 ? `${percent}% smaller` : `${percent}% larger`
}

export function compile(files, entryPath) {
  const entry = files.get(entryPath)

  // Inert parsing, same as analyze(): no script runs, no event handler fires,
  // no subresource is fetched. An uploaded file cannot act during compilation.
  const doc = new DOMParser().parseFromString(entry.content ?? '', 'text/html')

  const references = [...doc.querySelectorAll('link, script')]
    .map((node) => ({ node, reference: classifyNode(node) }))
    .filter(({ reference }) => reference !== null)

  const log = []
  const now = () => Date.now()

  log.push({
    step: 'parse',
    level: 'info',
    message: `Found ${describeReferenceCount(references.length)} in ${entryPath}`,
    at: now(),
  })

  let originalBytes = entry.size
  let matchedCount = 0
  let missingCount = 0
  let externalCount = 0

  for (const { node, reference } of references) {
    const { resolvedPath, external } = resolveHref(reference.rawHref, entryPath)
    const status = classify(resolvedPath, external, files)

    if (status === 'external') {
      externalCount += 1
      log.push({
        step: 'external',
        level: 'info',
        message: `Left ${reference.rawHref} as an external reference`,
        at: now(),
      })
      continue
    }

    if (status === 'missing') {
      missingCount += 1
      node.remove()
      log.push({
        step: 'skip',
        level: 'warn',
        message: `${reference.rawHref} not found - skipped`,
        at: now(),
      })
      continue
    }

    const file = files.get(resolvedPath)

    if (file.content === null) {
      // Matched, but not a type feature 1 decodes as text (an image or font
      // linked as a stylesheet, say). Nothing safe to inline; inlining null
      // would corrupt the tag, so this gets the same treatment as missing.
      missingCount += 1
      node.remove()
      log.push({
        step: 'skip',
        level: 'warn',
        message: `${resolvedPath} is not a text file - skipped`,
        at: now(),
      })
      continue
    }

    matchedCount += 1
    originalBytes += file.size

    // A stylesheet's own @import statements are resolved before minifying,
    // so the tracked "before" size for its own log line below has to grow
    // by whatever nested imports actually got inlined.
    let contentToMinify = file.content
    let stylesheetOriginalBytes = file.size

    if (reference.kind === 'stylesheet') {
      const { code: expanded, events } = resolveCssImports(resolvedPath, files)
      contentToMinify = expanded

      for (const event of events) {
        if (event.status === 'matched') {
          matchedCount += 1
          stylesheetOriginalBytes += event.size
          log.push({
            step: 'inline',
            level: 'info',
            message: `Inlined ${event.target} via @import`,
            at: now(),
          })
        } else if (event.status === 'missing') {
          missingCount += 1
          log.push({
            step: 'skip',
            level: 'warn',
            message: `${event.target} not found - @import skipped`,
            at: now(),
          })
        } else if (event.status === 'external') {
          externalCount += 1
          log.push({
            step: 'external',
            level: 'info',
            message: `Left @import ${event.target} as an external reference`,
            at: now(),
          })
        } else {
          // circular
          missingCount += 1
          log.push({
            step: 'skip',
            level: 'warn',
            message: `${event.target} imports its own importer - @import skipped to avoid a cycle`,
            at: now(),
          })
        }
      }

      originalBytes += stylesheetOriginalBytes - file.size
    }

    const { code: minified, warning } = minifySource(contentToMinify, file.type)

    if (warning === null) {
      log.push({
        step: 'inline',
        level: 'info',
        message: `Inlined ${resolvedPath} (${formatSize(stylesheetOriginalBytes)} -> ${formatSize(byteLength(minified))})`,
        at: now(),
      })
    } else {
      log.push({
        step: 'inline',
        level: 'warn',
        message: `Could not minify ${resolvedPath}: ${warning} - inlined unminified (${formatSize(byteLength(minified))})`,
        at: now(),
      })
    }

    if (reference.kind === 'stylesheet') {
      const style = doc.createElement('style')
      const media = node.getAttribute('media')
      if (media !== null) style.setAttribute('media', media)
      style.textContent = minified
      node.replaceWith(style)
    } else {
      const script = doc.createElement('script')
      // The one attribute that changes execution semantics: a module script
      // inlined without type="module" would silently become a classic script
      // with invalid import/export syntax. async and defer do nothing on a
      // script with no src, so nothing else is worth copying.
      const type = node.getAttribute('type')
      if (type !== null) script.setAttribute('type', type)
      script.textContent = minified
      node.replaceWith(script)
    }
  }

  // A normalization, not a preservation contract: the output always starts
  // with a lowercase doctype regardless of what the source document had.
  const code = `<!doctype html>\n${doc.documentElement.outerHTML}`
  const compiledBytes = byteLength(code)

  log.push({
    step: 'done',
    level: 'info',
    message:
      `Compiled ${files.size} file${files.size === 1 ? '' : 's'}: ` +
      `${matchedCount} inlined, ${missingCount} skipped, ${externalCount} external. ` +
      `${formatSize(originalBytes)} -> ${formatSize(compiledBytes)} ` +
      `(${describeSavings(originalBytes, compiledBytes)})`,
    at: now(),
  })

  const stats = {
    originalBytes,
    compiledBytes,
    matchedCount,
    missingCount,
    externalCount,
    fileCount: files.size,
  }

  return { code, stats, log }
}
