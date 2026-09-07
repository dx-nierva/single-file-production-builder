import { describe, it, expect } from 'vitest'
import {
  normalizePath,
  findCommonRoot,
  inferType,
  formatSize,
  buildFileEntries,
  downloadName,
} from './files.js'

// The non-breaking space formatSize emits, written as an escape so it
// cannot be mistaken for a plain space in this file.
const NBSP = ' '

function file(body, type = '') {
  return { size: body.length, type, text: async () => body }
}

function input(rawPath, entry) {
  return { rawPath, file: entry }
}

describe('normalizePath', () => {
  it('uses forward slashes and drops a leading ./ or /', () => {
    expect(normalizePath('/portfolio-site/index.html')).toBe(
      'portfolio-site/index.html',
    )
    expect(normalizePath('portfolio-site\\js\\app.js')).toBe(
      'portfolio-site/js/app.js',
    )
    expect(normalizePath('./portfolio-site//assets/logo.svg')).toBe(
      'portfolio-site/assets/logo.svg',
    )
  })

  it('preserves case, because the keys are matched against later', () => {
    expect(normalizePath('Site/README.md')).toBe('Site/README.md')
  })
})

describe('findCommonRoot', () => {
  it('names the single directory every path sits under', () => {
    expect(findCommonRoot(['site/index.html', 'site/css/main.css'])).toBe('site')
  })

  it('returns null when the paths do not share one root', () => {
    expect(findCommonRoot(['a/x.css', 'b/y.css'])).toBeNull()
    expect(findCommonRoot([])).toBeNull()
  })

  it('never treats a loose file as a root, which would erase it', () => {
    expect(findCommonRoot(['index.html'])).toBeNull()
  })
})

describe('inferType', () => {
  it('trusts a type the browser declared', () => {
    expect(inferType('text/css', 'a/b.js')).toBe('text/css')
  })

  it('canonicalises the JavaScript media types browsers disagree on', () => {
    expect(inferType('application/javascript', 'a.js')).toBe('text/javascript')
    expect(inferType('application/x-javascript', 'a.js')).toBe('text/javascript')
  })

  it('falls back to the extension when the browser declared nothing', () => {
    expect(inferType('', 'x/index.html')).toBe('text/html')
    expect(inferType('', 'x/a.htm')).toBe('text/html')
    expect(inferType('', 'x/a.css')).toBe('text/css')
    expect(inferType('', 'x/a.mjs')).toBe('text/javascript')
    expect(inferType('', 'x/a.json')).toBe('application/json')
    expect(inferType('', 'x/a.svg')).toBe('image/svg+xml')
    expect(inferType('', 'README.md')).toBe('text/markdown')
    expect(inferType('', 'x/a.jpeg')).toBe('image/jpeg')
  })

  it('never returns an empty type', () => {
    expect(inferType('', 'x/data.bin')).toBe('application/octet-stream')
    expect(inferType('', 'LICENSE')).toBe('application/octet-stream')
  })
})

describe('formatSize', () => {
  it('shows whole bytes below a kilobyte', () => {
    expect(formatSize(0)).toBe(`0${NBSP}B`)
    expect(formatSize(812)).toBe(`812${NBSP}B`)
    expect(formatSize(1023)).toBe(`1023${NBSP}B`)
  })

  it('shows one decimal in binary units', () => {
    expect(formatSize(1024)).toBe(`1.0${NBSP}KB`)
    expect(formatSize(2458)).toBe(`2.4${NBSP}KB`)
    expect(formatSize(148897)).toBe(`145.4${NBSP}KB`)
    expect(formatSize(1572864)).toBe(`1.5${NBSP}MB`)
  })

  it('picks the unit after rounding, not before', () => {
    // 1048575 / 1024 rounds to 1024.0, which belongs in megabytes.
    expect(formatSize(1048575)).toBe(`1.0${NBSP}MB`)
    expect(formatSize(1048000)).toBe(`1023.4${NBSP}KB`)
  })
})

describe('buildFileEntries', () => {
  const project = () => [
    input('site/css/main.css', file('body{}', 'text/css')),
    input('site/index.html', file('<h1>hi</h1>', 'text/html')),
    input('site/assets/logo.svg', file('<svg/>', 'image/svg+xml')),
    input('site/README.md', file('# hi', 'text/markdown')),
  ]

  it('strips the common root and sorts the keys', async () => {
    const { files, rootName } = await buildFileEntries(project())

    expect(rootName).toBe('site')
    expect([...files.keys()]).toEqual([
      'assets/logo.svg',
      'css/main.css',
      'index.html',
      'README.md',
    ])
  })

  it('decodes text but leaves other types undecoded', async () => {
    const { files } = await buildFileEntries(project())

    expect(files.get('css/main.css').content).toBe('body{}')
    expect(files.get('index.html').content).toBe('<h1>hi</h1>')
    // Only HTML, CSS and JS are decoded; feature 10 handles the rest.
    expect(files.get('assets/logo.svg').content).toBeNull()
    expect(files.get('README.md').content).toBeNull()
  })

  it('carries the name, type and size of each file', async () => {
    const { files } = await buildFileEntries(project())
    const entry = files.get('css/main.css')

    expect(entry).toMatchObject({
      path: 'css/main.css',
      name: 'main.css',
      type: 'text/css',
      size: 6,
    })
  })

  it('lets the last of two identical paths win', async () => {
    const { files } = await buildFileEntries([
      input('site/index.html', file('FIRST', 'text/html')),
      input('site/other.html', file('x', 'text/html')),
      input('site/index.html', file('SECOND', 'text/html')),
    ])

    expect(files.get('index.html').content).toBe('SECOND')
  })

  it('orders case-only duplicates the same way whatever order they arrive in', async () => {
    const forward = await buildFileEntries([
      input('site/README.md', file('a', 'text/markdown')),
      input('site/readme.md', file('b', 'text/markdown')),
    ])
    const reverse = await buildFileEntries([
      input('site/readme.md', file('b', 'text/markdown')),
      input('site/README.md', file('a', 'text/markdown')),
    ])

    expect([...forward.files.keys()]).toEqual([...reverse.files.keys()])
  })

  it('skips inputs whose path normalises to nothing', async () => {
    const { files } = await buildFileEntries([
      input('/', file('x', 'text/css')),
      input('site/a.css', file('a{}', 'text/css')),
    ])

    expect([...files.keys()]).toEqual(['a.css'])
  })

  it('rejects rather than returning a partial project when a read fails', async () => {
    await expect(
      buildFileEntries([
        input('site/ok.css', file('a{}', 'text/css')),
        input('site/broken.html', {
          size: 9,
          type: 'text/html',
          text: () => Promise.reject(new Error('could not be read')),
        }),
      ]),
    ).rejects.toThrow('could not be read')
  })
})

describe('downloadName', () => {
  it('appends .html to the upload root name', () => {
    expect(downloadName('portfolio-site')).toBe('portfolio-site.html')
  })

  it('falls back to index.html when there is no common root', () => {
    expect(downloadName(null)).toBe('index.html')
  })
})
