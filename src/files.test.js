import { describe, it, expect, vi } from 'vitest'
import {
  normalizePath,
  findCommonRoot,
  inferType,
  isAssetType,
  bytesToBase64,
  formatSize,
  removeFile,
  buildFileEntries,
  downloadName,
} from './files.js'

// The non-breaking space formatSize emits, written as an escape so it
// cannot be mistaken for a plain space in this file.
const NBSP = ' '

function file(body, type = '') {
  return {
    size: body.length,
    type,
    text: async () => body,
    arrayBuffer: async () => {
      const bytes = new Uint8Array(body.length)
      for (let i = 0; i < body.length; i += 1) bytes[i] = body.charCodeAt(i)
      return bytes.buffer
    },
  }
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

describe('inferType asset extensions', () => {
  it('recognises the added image and font extensions', () => {
    expect(inferType('', 'x/a.gif')).toBe('image/gif')
    expect(inferType('', 'x/a.webp')).toBe('image/webp')
    expect(inferType('', 'x/a.ico')).toBe('image/x-icon')
    expect(inferType('', 'x/a.woff')).toBe('font/woff')
    expect(inferType('', 'x/a.woff2')).toBe('font/woff2')
    expect(inferType('', 'x/a.ttf')).toBe('font/ttf')
    expect(inferType('', 'x/a.otf')).toBe('font/otf')
    expect(inferType('', 'x/a.eot')).toBe('application/vnd.ms-fontobject')
  })
})

describe('isAssetType', () => {
  it('accepts image and font MIME types', () => {
    expect(isAssetType('image/png')).toBe(true)
    expect(isAssetType('image/svg+xml')).toBe(true)
    expect(isAssetType('font/woff2')).toBe(true)
    expect(isAssetType('application/vnd.ms-fontobject')).toBe(true)
  })

  it('rejects text and other binary types', () => {
    expect(isAssetType('text/css')).toBe(false)
    expect(isAssetType('text/javascript')).toBe(false)
    expect(isAssetType('application/octet-stream')).toBe(false)
    expect(isAssetType('application/json')).toBe(false)
  })
})

describe('bytesToBase64', () => {
  it('round-trips a small byte sequence', () => {
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255, 65, 66, 67])
    const encoded = bytesToBase64(bytes)
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect([...decoded]).toEqual([...bytes])
  })

  it('round-trips a buffer large enough to force more than one chunk', () => {
    const bytes = new Uint8Array(200000)
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = i % 256
    const encoded = bytesToBase64(bytes)
    const decoded = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))
    expect([...decoded]).toEqual([...bytes])
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

  it('base64-encodes a recognized image or font type, leaving content null', async () => {
    const { files } = await buildFileEntries([
      ...project(),
      input('site/assets/font.woff2', file('fake-font-bytes', 'font/woff2')),
    ])

    const svg = files.get('assets/logo.svg')
    expect(svg.content).toBeNull()
    expect(svg.base64).toBe(btoa('<svg/>'))

    const font = files.get('assets/font.woff2')
    expect(font.content).toBeNull()
    expect(font.base64).toBe(btoa('fake-font-bytes'))
  })

  it('leaves base64 null for a non-text, non-asset type', async () => {
    const { files } = await buildFileEntries(project())

    expect(files.get('README.md').base64).toBeNull()
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

describe('buildFileEntries progress reporting', () => {
  function manyInputs(count) {
    return Array.from({ length: count }, (_, i) =>
      input(`site/file${i}.css`, file('a{}', 'text/css')),
    )
  }

  it('calls onProgress exactly once, with done === total, below the computed interval', async () => {
    const onProgress = vi.fn()
    await buildFileEntries(manyInputs(3), onProgress)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress).toHaveBeenCalledWith(3, 3)
  })

  it('calls onProgress at each interval multiple plus a final call when total is not a multiple', async () => {
    const onProgress = vi.fn()
    await buildFileEntries(manyInputs(60), onProgress)
    expect(onProgress.mock.calls).toEqual([
      [25, 60],
      [50, 60],
      [60, 60],
    ])
  })

  it('does not repeat the final count when total already lands on an interval multiple', async () => {
    const onProgress = vi.fn()
    await buildFileEntries(manyInputs(50), onProgress)
    expect(onProgress.mock.calls).toEqual([
      [25, 50],
      [50, 50],
    ])
  })

  it('omitting onProgress does not throw and produces the same result as before', async () => {
    const { files, rootName } = await buildFileEntries(manyInputs(30))
    expect(rootName).toBe('site')
    expect(files.size).toBe(30)
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

describe('removeFile', () => {
  it('removes the target path and leaves every other entry exactly as it was', () => {
    const a = { path: 'a.css', name: 'a.css', type: 'text/css', size: 1, content: 'a' }
    const b = { path: 'b.css', name: 'b.css', type: 'text/css', size: 1, content: 'b' }
    const files = new Map([['a.css', a], ['b.css', b]])

    const result = removeFile(files, 'a.css')

    expect([...result.keys()]).toEqual(['b.css'])
    expect(result.get('b.css')).toBe(b)
  })

  it('returns a new Map instance when the path existed', () => {
    const files = new Map([['a.css', { path: 'a.css', name: 'a.css', type: 'text/css', size: 1, content: 'a' }]])
    const result = removeFile(files, 'a.css')
    expect(result).not.toBe(files)
  })

  it('returns the identical reference when the path did not exist', () => {
    const files = new Map([['a.css', { path: 'a.css', name: 'a.css', type: 'text/css', size: 1, content: 'a' }]])
    const result = removeFile(files, 'gone.css')
    expect(result).toBe(files)
  })

  it('never mutates the original Map', () => {
    const files = new Map([['a.css', { path: 'a.css', name: 'a.css', type: 'text/css', size: 1, content: 'a' }]])
    removeFile(files, 'a.css')
    expect(files.has('a.css')).toBe(true)
  })
})

