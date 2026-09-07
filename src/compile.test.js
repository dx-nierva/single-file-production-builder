// @vitest-environment jsdom
//
// compile() parses the entry with a real DOMParser, same as
// references.dom.test.js, so this file needs a DOM.

import { describe, it, expect } from 'vitest'
import { compile, describeSavings } from './compile.js'

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

/** Size, in real bytes, using the same rule the app itself uses. */
function bytesOf(str) {
  return new TextEncoder().encode(str).length
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

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<style>body{margin: 0;}</style>')
    expect(code).not.toContain('<link')
  })

  it('preserves a media attribute on the inlined <style>', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="a.css" media="print">',
      },
      'a.css': { type: 'text/css', content: 'body{margin:0}' },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<style media="print">body{margin:0}</style>')
  })

  it('inlines a matched script as minified <script>, no type', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<script src="a.js"></script>',
      },
      'a.js': { type: 'text/javascript', content: 'const a = 1  // hi' },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<script>const a = 1</script>')
    expect(code).not.toContain('src=')
  })

  it('preserves type="module" on the inlined script', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<script type="module" src="a.js"></script>',
      },
      'a.js': { type: 'text/javascript', content: 'export const a = 1' },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<script type="module">export const a = 1</script>')
  })

  it('removes a missing reference entirely', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<link rel="stylesheet" href="gone.css">',
      },
    })

    const { code } = compile(files, 'index.html')

    expect(code).not.toContain('<link')
    expect(code).not.toContain('gone.css')
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

    const { code } = compile(files, 'index.html')

    expect(code).not.toContain('<script')
    expect(code).not.toContain('data.json')
  })

  it('leaves an external reference completely untouched', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content:
          '<link rel="stylesheet" href="https://cdn.example.com/a.css" crossorigin="anonymous" integrity="sha256-x">',
      },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain(
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

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<link rel="icon" href="favicon.svg">')
  })

  it('leaves inline style and inline script untouched', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<style>body{margin:0}</style><script>console.log(1)</script>',
      },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<style>body{margin:0}</style>')
    expect(code).toContain('<script>console.log(1)</script>')
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

    const { code } = compile(files, 'index.html')

    expect(code.split('<style>body{margin:0}</style>')).toHaveLength(3)
  })

  it('starts with a lowercase doctype regardless of the source', () => {
    const files = project({
      'index.html': { type: 'text/html', content: '<!DOCTYPE HTML><p>hi</p>' },
    })

    const { code } = compile(files, 'index.html')

    expect(code.startsWith('<!doctype html>\n')).toBe(true)
  })

  it('preserves attributes on <html> such as lang', () => {
    const files = project({
      'index.html': {
        type: 'text/html',
        content: '<html lang="en"><body><p>hi</p></body></html>',
      },
    })

    const { code } = compile(files, 'index.html')

    expect(code).toContain('<html lang="en">')
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
      const { code } = compile(files(), 'index.html')
      const doc = new DOMParser().parseFromString(code, 'text/html')

      const remaining = [...doc.querySelectorAll('link[rel~="stylesheet"], script[src]')]
      const pointsAtUpload = remaining.filter((node) => {
        const href = node.getAttribute('href') ?? node.getAttribute('src') ?? ''
        return !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)
      })
      expect(pointsAtUpload).toHaveLength(0)
    })

    it('inlines the matched files, drops the missing one, keeps the external one', () => {
      const { code } = compile(files(), 'index.html')

      expect(code).toContain('<style>body{margin: 0;}</style>')
      expect(code).toContain('<script>start()</script>')
      expect(code).not.toContain('gone.css')
      expect(code).toContain('https://cdn.example.com/reset.css')
      expect(code).toContain('favicon.svg')
    })

    it('is well-formed enough to re-parse', () => {
      const { code } = compile(files(), 'index.html')
      const doc = new DOMParser().parseFromString(code, 'text/html')

      expect(doc.documentElement.getAttribute('lang')).toBe('en')
      expect(doc.querySelector('script').textContent).toBe('start()')
    })

    it('reports stats matching the mixed outcomes', () => {
      const { stats } = compile(files(), 'index.html')

      expect(stats).toMatchObject({
        matchedCount: 2,
        missingCount: 1,
        externalCount: 1,
        fileCount: files().size,
      })
    })

    it('logs one entry per reference in document order, plus parse and done', () => {
      const { log } = compile(files(), 'index.html')

      expect(log.map((entry) => entry.step)).toEqual([
        'parse',
        'inline', // css/main.css
        'skip', // css/gone.css
        'external', // cdn reset.css
        'inline', // js/app.js
        'done',
      ])
      expect(log.map((entry) => entry.level)).toEqual([
        'info',
        'info',
        'warn',
        'info',
        'info',
        'info',
      ])
    })
  })

  describe('stats', () => {
    it('sums the entry size plus each matched file, not missing or external ones', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'body{margin:0}' },
      })
      const entrySize = files.get('index.html').size
      const cssSize = files.get('a.css').size

      const { stats } = compile(files, 'index.html')

      expect(stats.originalBytes).toBe(entrySize + cssSize)
    })

    it('computes compiledBytes as the real byte length of code, not its string length', () => {
      // A non-ASCII character (e) takes more than one byte in UTF-8 but is a
      // single UTF-16 code unit, so this fixture only distinguishes the two
      // measurements if byte counting is actually used.
      const files = project({
        'index.html': { type: 'text/html', content: '<p>café</p>' },
      })

      const { code, stats } = compile(files, 'index.html')

      expect(stats.compiledBytes).toBe(bytesOf(code))
      expect(stats.compiledBytes).not.toBe(code.length)
    })

    it('does not divide by zero for a zero-byte entry', () => {
      const files = project({ 'index.html': { type: 'text/html', content: '' } })

      const { stats } = compile(files, 'index.html')

      expect(stats.originalBytes).toBe(0)
      expect(Number.isNaN(stats.compiledBytes)).toBe(false)
      expect(describeSavings(stats.originalBytes, stats.compiledBytes)).toBe(
        '0% smaller',
      )
    })

    it('buckets a matched-but-unusable file under missingCount, not matchedCount', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<script src="data.json"></script>',
        },
        'data.json': { type: 'application/json', content: null },
      })

      const { stats } = compile(files, 'index.html')

      expect(stats.matchedCount).toBe(0)
      expect(stats.missingCount).toBe(1)
    })

    it('reports zero for every count on a self-contained page', () => {
      const files = project({
        'index.html': { type: 'text/html', content: '<h1>self contained</h1>' },
      })

      const { stats, log } = compile(files, 'index.html')

      expect(stats).toMatchObject({
        matchedCount: 0,
        missingCount: 0,
        externalCount: 0,
      })
      expect(log.map((entry) => entry.step)).toEqual(['parse', 'done'])
      expect(log[0].message).toBe('Found no references in index.html')
    })

    it('two independent compiles never share mutated state', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'body{margin:0}' },
      })

      const first = compile(files, 'index.html')
      const second = compile(files, 'index.html')

      expect(second.stats).toEqual(first.stats)
      expect(second.log.map((e) => e.step)).toEqual(first.log.map((e) => e.step))
      expect(second.code).toBe(first.code)
    })
  })

  describe('describeSavings', () => {
    it('reads "smaller" when the compiled size is less than or equal to original', () => {
      expect(describeSavings(100, 50)).toBe('50% smaller')
      expect(describeSavings(100, 100)).toBe('0% smaller')
    })

    it('reads "larger" honestly rather than clamping to zero', () => {
      expect(describeSavings(100, 150)).toBe('50% larger')
    })

    it('does not divide by zero', () => {
      expect(describeSavings(0, 0)).toBe('0% smaller')
    })
  })

  describe('log message wording', () => {
    it('uses singular wording for exactly one reference', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'body{margin:0}' },
      })

      const { log } = compile(files, 'index.html')

      expect(log[0].message).toBe('Found 1 reference in index.html')
    })

    it('names the resolved path and both sizes for a clean inline', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'body {  margin: 0 ;  }' },
      })

      const { log } = compile(files, 'index.html')
      const inline = log.find((entry) => entry.step === 'inline')

      // 'body {  margin: 0 ;  }' is 22 ASCII bytes; minifyCss collapses it to
      // 'body{margin: 0;}', 16 bytes (the space before "0" is a declaration
      // value, left alone by design; see minify.js).
      expect(inline.message).toBe(`Inlined a.css (22 B -> 16 B)`)
    })

    it('surfaces a minifier warning as a warn-level log entry and still inlines the source unminified', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<script src="broken.js"></script>',
        },
        'broken.js': { type: 'text/javascript', content: 'const s = `oops' },
      })

      const { code, log } = compile(files, 'index.html')
      const inline = log.find((entry) => entry.step === 'inline')

      expect(inline.level).toBe('warn')
      expect(inline.message).toBe(
        `Could not minify broken.js: unterminated template literal - inlined unminified (15 B)`,
      )
      // The unminified source, backtick and all, is what actually got inlined.
      expect(code).toContain('<script>const s = `oops</script>')
    })

    it('uses rawHref, not resolvedPath, for a missing reference', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="./css/gone.css">',
        },
      })

      const { log } = compile(files, 'index.html')
      const skip = log.find((entry) => entry.step === 'skip')

      expect(skip.message).toBe('./css/gone.css not found - skipped')
    })

    it('uses rawHref for an external reference', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="https://cdn.example.com/a.css">',
        },
      })

      const { log } = compile(files, 'index.html')
      const external = log.find((entry) => entry.step === 'external')

      expect(external.message).toBe(
        'Left https://cdn.example.com/a.css as an external reference',
      )
    })

    it('every entry carries a numeric timestamp', () => {
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'body{margin:0}' },
      })

      const { log } = compile(files, 'index.html')

      for (const entry of log) {
        expect(typeof entry.at).toBe('number')
      }
    })
  })

  describe('compiling something larger than the original', () => {
    it('reports "larger" rather than a negative or clamped figure', () => {
      // A one-byte stylesheet that cannot shrink further, wrapped in a
      // <style></style> pair that is longer than the tiny <link> it replaces.
      const files = project({
        'index.html': {
          type: 'text/html',
          content: '<link rel="stylesheet" href="a.css">',
        },
        'a.css': { type: 'text/css', content: 'a{}' },
      })

      const { stats, log } = compile(files, 'index.html')

      expect(stats.compiledBytes).toBeGreaterThan(stats.originalBytes)
      const done = log.find((entry) => entry.step === 'done')
      expect(done.message).toContain('larger')
      expect(done.message).not.toMatch(/-\d+%/)
    })
  })
})
