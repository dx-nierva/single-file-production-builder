/**
 * Turns the entry document and its matched stylesheets and scripts into one
 * self-contained HTML string: minified CSS and JS inlined in place, missing
 * references dropped, external references left alone.
 *
 * Reuses feature 2's classification and resolution directly rather than
 * trusting a separately-produced list to line up with a fresh DOM walk by
 * position - that kind of implicit correspondence between two independently
 * built lists is exactly what has broken before in this codebase.
 */

import { classifyNode, resolveHref, classify } from './references.js'
import { minifySource } from './minify.js'

export function compile(files, entryPath) {
  const entry = files.get(entryPath)

  // Inert parsing, same as analyze(): no script runs, no event handler fires,
  // no subresource is fetched. An uploaded file cannot act during compilation.
  const doc = new DOMParser().parseFromString(entry.content ?? '', 'text/html')

  for (const node of [...doc.querySelectorAll('link, script')]) {
    const reference = classifyNode(node)
    if (reference === null) continue // not a reference; leave completely alone

    const { resolvedPath, external } = resolveHref(reference.rawHref, entryPath)
    const status = classify(resolvedPath, external, files)

    if (status === 'external') continue // leave completely alone

    if (status === 'missing') {
      node.remove()
      continue
    }

    const file = files.get(resolvedPath)

    if (file.content === null) {
      // Matched, but not a type feature 1 decodes as text (an image or font
      // linked as a stylesheet, say). Nothing safe to inline; inlining null
      // would corrupt the tag, so this gets the same treatment as missing.
      node.remove()
      continue
    }

    const { code } = minifySource(file.content, file.type)

    if (reference.kind === 'stylesheet') {
      const style = doc.createElement('style')
      const media = node.getAttribute('media')
      if (media !== null) style.setAttribute('media', media)
      style.textContent = code
      node.replaceWith(style)
    } else {
      const script = doc.createElement('script')
      // The one attribute that changes execution semantics: a module script
      // inlined without type="module" would silently become a classic script
      // with invalid import/export syntax. async and defer do nothing on a
      // script with no src, so nothing else is worth copying.
      const type = node.getAttribute('type')
      if (type !== null) script.setAttribute('type', type)
      script.textContent = code
      node.replaceWith(script)
    }
  }

  // A normalization, not a preservation contract: the output always starts
  // with a lowercase doctype regardless of what the source document had.
  return `<!doctype html>\n${doc.documentElement.outerHTML}`
}
