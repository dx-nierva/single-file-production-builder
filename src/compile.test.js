// @vitest-environment jsdom
//
// compile() parses the entry with a real DOMParser, same as
// references.dom.test.js, so this file needs a DOM.

import { describe, it, expect } from 'vitest'
import { compile } from './compile.js'

function project(entries) {
  const files = new Map()
  for (const [path, { type, content = null }] of Object.entries(entries)) {
    files.set(path, {
      path,
      name: path.split('/').pop(),
      type,
      size: content === null ? 0 : content.length,
      content,
    })
  }
  return files
}

describe('compile', () => {
  it('inlines a matched stylesheet as a minified <style>, no media', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="a.css">',
      },
      'a.css': { type: 'text/css', content: 'body {  margin: 0 ;  }' },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<style>body{margin: 0;}</style>')
    expect(html).not.toContain('<link')
  })

  it('preserves a media attribute on the inlined <style>', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="a.css" media="print">',
      },
      'a.css': { type: 'text/css', content: 'body{margin:0}' },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<style media="print">body{margin:0}</style>')
  })

  it('inlines a matched script as minified <script>, no type', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<script src="a.js"></script>',
      },
      'a.js': { type: 'text/javascript', content: 'const a = 1  // hi' },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<script>const a = 1</script>')
    expect(html).not.toContain('src=')
  })

  it('preserves type="module" on the inlined script', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<script type="module" src="a.js"></script>',
      },
      'a.js': { type: 'text/javascript', content: 'export const a = 1' },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<script type="module">export const a = 1</script>')
  })

  it('removes a missing reference entirely', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="gone.css">',
      },
    })

    const html = compile(files, 'index.html')

    expect(html).not.toContain('<link')
    expect(html).not.toContain('gone.css')
  })

  it('removes a matched reference whose file content is null', () => {
    // Matched by src alone (feature 2's rule), but not a type feature 1
    // decodes as text, so there is nothing safe to inline.
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<script src="data.json"></script>',
      },
      'data.json': { type: 'application/json', content: null },
    })

    const html = compile(files, 'index.html')

    expect(html).not.toContain('<script')
    expect(html).not.toContain('data.json')
  })

  it('leaves an external reference completely untouched', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content:
          '<link rel="stylesheet" href="https://cdn.example.com/a.css" crossorigin="anonymous" integrity="sha256-x">',
      },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain(
      '<link rel="stylesheet" href="https://cdn.example.com/a.css" crossorigin="anonymous" integrity="sha256-x">',
    )
  })

  it('leaves a non-reference link untouched', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="icon" href="favicon.svg">',
      },
      'favicon.svg': { type: 'image/svg+xml', content: null },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<link rel="icon" href="favicon.svg">')
  })

  it('leaves inline style and inline script untouched', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<style>body{margin:0}</style><script>console.log(1)</script>',
      },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<style>body{margin:0}</style>')
    expect(html).toContain('<script>console.log(1)</script>')
  })

  it('inlines each occurrence of a file referenced twice independently', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content:
          '<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="a.css">',
      },
      'a.css': { type: 'text/css', content: 'body{margin:0}' },
    })

    const html = compile(files, 'index.html')

    expect(html.split('<style>body{margin:0}</style>')).toHaveLength(3)
  })

  it('starts with a lowercase doctype regardless of the source', () => {
    const files = project({
      'index.html': { type: 'text/html', content: '<!DOCTYPE HTML><p>hi</p>' },
    })

    const html = compile(files, 'index.html')

    expect(html.startsWith('<!doctype html>\n')).toBe(true)
  })

  it('preserves attributes on <html> such as lang', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<html lang="en"><body><p>hi</p></body></html>',
      },
    })

    const html = compile(files, 'index.html')

    expect(html).toContain('<html lang="en">')
  })

  describe('a small multi-reference project', () => {
    const files = () =>
      project({
        'index.html': {
          type: 'text/html',
          content: `<!doctype html>
<html lang="en">
  <head>
    <link rel="stylesheet" href="css/main.css">
    <link rel="stylesheet" href="css/gone.css">
    <link rel="stylesheet" href="https://cdn.example.com/reset.css">
    <link rel="icon" href="favicon.svg">
  </head>
  <body>
    <script src="js/app.js"></script>
  </body>
</html>`,
        },
        'css/main.css': { type: 'text/css', content: 'body {  margin: 0 ;  }' },
        'js/app.js': { type: 'text/javascript', content: 'start()  // go' },
        'favicon.svg': { type: 'image/svg+xml', content: null },
      })

    it('leaves no reference to an uploaded file unresolved', () => {
      // The external CDN link legitimately remains as a <link rel=stylesheet>;
      // what must be gone is any tag still pointing at a path that was in the
      // upload (matched, now inlined, or missing, now removed).
      const html = compile(files(), 'index.html')
      const doc = new DOMParser().parseFromString(html, 'text/html')

      const remaining = [...doc.querySelectorAll('link[rel~="stylesheet"], script[src]')]
      const pointsAtUpload = remaining.filter((node) => {
        const href = node.getAttribute('href') ?? node.getAttribute('src') ?? ''
        return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
      })
      expect(pointsAtUpload).toHaveLength(0)
    })

    it('inlines the matched files, drops the missing one, keeps the external one', () => {
      const html = compile(files(), 'index.html')

      expect(html).toContain('<style>body{margin: 0;}</style>')
      expect(html).toContain('<script>start()</script>')
      expect(html).not.toContain('gone.css')
      expect(html).toContain('https://cdn.example.com/reset.css')
      expect(html).toContain('favicon.svg')
    })

    it('is well-formed enough to re-parse', () => {
      const html = compile(files(), 'index.html')
      const doc = new DOMParser().parseFromString(html, 'text/html')

      expect(doc.documentElement.getAttribute('lang')).toBe('en')
      expect(doc.querySelector('script').textContent).toBe('start()')
    })
  })
})
