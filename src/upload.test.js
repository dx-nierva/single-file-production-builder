// @vitest-environment jsdom
//
// The success path runs analyze(), which parses the entry document, so
// these cases need a DOM even though the uploader itself has none.

import { describe, it, expect, vi } from 'vitest'
import { createStore, createInitialState } from './store.js'
import { createUploader } from './upload.js'
import { fetchProject } from './fetch-project.js'

vi.mock('./fetch-project.js', () => ({ fetchProject: vi.fn() }))

/** A promise whose resolution this test controls, standing in for a slow read. */
function deferred() {
  let settle
  const promise = new Promise((resolve) => {
    settle = resolve
  })
  return { promise, resolve: settle }
}

/** Same, but for a fetchProject call this test wants to fail on demand. */
function deferredRejection() {
  let fail
  const promise = new Promise((_resolve, reject) => {
    fail = reject
  })
  return { promise, reject: fail }
}

function fetched(rootName) {
  return {
    files: new Map([
      ['index.html', { path: 'index.html', name: 'index.html', type: 'text/html', size: 2, content: '<html></html>' }],
    ]),
    rootName,
  }
}

function file(body, type = 'text/css') {
  return { size: body.length, type, text: async () => body }
}

function failing(message) {
  return {
    size: 1,
    type: 'text/css',
    text: () => Promise.reject(new Error(message)),
  }
}

function input(path, entry) {
  return { file: entry, rawPath: path }
}

/** Let every already-resolved promise in the chain run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

function setup() {
  const store = createStore(createInitialState())
  const { ingest, fetchFromUrl } = createUploader(store)
  return { store, ingest, fetchFromUrl }
}

describe('a single upload', () => {
  it('goes reading, then success, and keys the files by their stripped path', async () => {
    const { store, ingest } = setup()
    const slow = deferred()

    const run = ingest(slow.promise)
    expect(store.getState().uploadStatus).toBe('reading')

    slow.resolve([input('site/css/main.css', file('body{}'))])
    await run

    const state = store.getState()
    expect(state.uploadStatus).toBe('success')
    expect(state.rootName).toBe('site')
    expect([...state.uploadedFiles.keys()]).toEqual(['css/main.css'])
  })

  it('reports a failed read without discarding what was already loaded', async () => {
    const { store, ingest } = setup()

    await ingest([input('good/a.css', file('a{}')), input('good/b.css', file('b{}'))])
    expect(store.getState().uploadedFiles.size).toBe(2)

    await ingest([input('broken/x.css', failing('Device not readable'))])

    const state = store.getState()
    expect(state.uploadStatus).toBe('error')
    expect(state.errorMessage).toContain('Device not readable')
    expect([...state.uploadedFiles.keys()]).toEqual(['a.css', 'b.css'])
    expect(state.rootName).toBe('good')
  })

  it('records the entry document and what it references', async () => {
    const { store, ingest } = setup()

    await ingest([
      input(
        'site/index.html',
        file('<link rel="stylesheet" href="css/main.css"><script src="js/gone.js"></script>', 'text/html'),
      ),
      input('site/css/main.css', file('body{}')),
    ])

    const state = store.getState()
    expect(state.entryPath).toBe('index.html')
    expect(state.references).toEqual([
      {
        kind: 'stylesheet',
        rawHref: 'css/main.css',
        resolvedPath: 'css/main.css',
        status: 'matched',
      },
      {
        kind: 'script',
        rawHref: 'js/gone.js',
        resolvedPath: 'js/gone.js',
        status: 'missing',
      },
    ])
  })

  it('leaves the entry and references untouched when a read fails', async () => {
    const { store, ingest } = setup()

    await ingest([
      input('good/index.html', file('<link rel="stylesheet" href="a.css">', 'text/html')),
      input('good/a.css', file('a{}')),
    ])
    const loaded = store.getState()
    expect(loaded.entryPath).toBe('index.html')
    expect(loaded.references).toHaveLength(1)

    await ingest([input('broken/x.css', failing('Device not readable'))])

    const state = store.getState()
    expect(state.uploadStatus).toBe('error')
    expect(state.entryPath).toBe('index.html')
    expect(state.references).toHaveLength(1)
  })

  it('reports no entry when the upload has no html', async () => {
    const { store, ingest } = setup()
    await ingest([input('site/a.css', file('a{}'))])

    expect(store.getState().entryPath).toBeNull()
    expect(store.getState().references).toEqual([])
  })

  it('describes a thrown value that is not an Error', async () => {
    const { store, ingest } = setup()
    await ingest(Promise.reject('just a string'))
    expect(store.getState().errorMessage).toContain('just a string')
  })
})

describe('overlapping uploads', () => {
  it('lets the newer upload win even when the older one finishes last', async () => {
    const { store, ingest } = setup()
    const slow = deferred()
    const fast = deferred()

    const slowRun = ingest(slow.promise)
    const fastRun = ingest(fast.promise)

    fast.resolve([input('fast/only.css', file('x{}'))])
    await fastRun
    expect(store.getState().rootName).toBe('fast')

    // The abandoned upload resolves afterwards and must not win.
    slow.resolve([input('slow/a.css', file('a{}')), input('slow/b.css', file('b{}'))])
    await slowRun

    const state = store.getState()
    expect(state.rootName).toBe('fast')
    expect([...state.uploadedFiles.keys()]).toEqual(['only.css'])
  })

  it('suppresses the error of an upload that has been superseded', async () => {
    const { store, ingest } = setup()
    const slow = deferred()
    const fast = deferred()

    const slowRun = ingest(slow.promise)
    const fastRun = ingest(fast.promise)

    fast.resolve([input('fast/only.css', file('x{}'))])
    await fastRun

    slow.resolve([input('slow/x.css', failing('Device not readable'))])
    await slowRun

    expect(store.getState().uploadStatus).toBe('success')
    expect(store.getState().errorMessage).toBeNull()
  })
})

describe('ingest and fetchFromUrl sharing the race guard', () => {
  it('lets a newer fetchFromUrl win when it resolves after a slower ingest', async () => {
    const { store, ingest, fetchFromUrl } = setup()
    const slow = deferred()
    const fetchDeferred = deferred()

    const slowRun = ingest(slow.promise)
    fetchProject.mockReturnValueOnce(fetchDeferred.promise)
    const fetchRun = fetchFromUrl('https://example.com/')

    fetchDeferred.resolve(fetched('example.com'))
    await fetchRun
    expect(store.getState().rootName).toBe('example.com')

    // The abandoned local upload resolves afterwards and must not win.
    slow.resolve([input('slow/a.css', file('a{}'))])
    await slowRun

    expect(store.getState().rootName).toBe('example.com')
    expect([...store.getState().uploadedFiles.keys()]).toEqual(['index.html'])
  })

  it('lets a newer ingest win when it resolves after a slower fetchFromUrl', async () => {
    const { store, ingest, fetchFromUrl } = setup()
    const fetchDeferred = deferred()
    const fast = deferred()

    fetchProject.mockReturnValueOnce(fetchDeferred.promise)
    const fetchRun = fetchFromUrl('https://example.com/')
    const fastRun = ingest(fast.promise)

    fast.resolve([input('fast/only.css', file('x{}'))])
    await fastRun
    expect(store.getState().rootName).toBe('fast')

    // The abandoned fetch resolves afterwards and must not win.
    fetchDeferred.resolve(fetched('example.com'))
    await fetchRun

    expect(store.getState().rootName).toBe('fast')
  })

  it('suppresses the error of a fetchFromUrl superseded by a newer ingest', async () => {
    const { store, ingest, fetchFromUrl } = setup()
    const fetchDeferred = deferredRejection()
    const fast = deferred()

    fetchProject.mockReturnValueOnce(fetchDeferred.promise)
    const fetchRun = fetchFromUrl('https://example.com/')
    const fastRun = ingest(fast.promise)

    fast.resolve([input('fast/only.css', file('x{}'))])
    await fastRun

    fetchDeferred.reject(new Error('Could not reach that URL.'))
    await fetchRun

    expect(store.getState().uploadStatus).toBe('success')
    expect(store.getState().errorMessage).toBeNull()
  })
})

describe('an upload that offers no files', () => {
  it('settles on idle when nothing was loaded', async () => {
    const { store, ingest } = setup()
    await ingest([])
    expect(store.getState().uploadStatus).toBe('idle')
    expect(store.getState().uploadedFiles.size).toBe(0)
  })

  it('keeps a loaded project and returns to success', async () => {
    const { store, ingest } = setup()
    await ingest([input('site/a.css', file('a{}'))])

    await ingest([])

    expect(store.getState().uploadStatus).toBe('success')
    expect([...store.getState().uploadedFiles.keys()]).toEqual(['a.css'])
  })

  // F-08: an empty drop landing mid-read must not cancel the live upload.
  it('does not cancel an upload that is still reading', async () => {
    const { store, ingest } = setup()
    const slow = deferred()
    const empty = deferred()

    const slowRun = ingest(slow.promise)
    const emptyRun = ingest(empty.promise)

    empty.resolve([])
    await emptyRun
    expect(store.getState().uploadStatus).toBe('reading')

    slow.resolve([input('slow/a.css', file('a{}'))])
    await slowRun

    const state = store.getState()
    expect(state.uploadStatus).toBe('success')
    expect(state.rootName).toBe('slow')
  })

  // F-09: a stale empty run must not overwrite a newer run that already ended.
  it('does not overwrite the outcome of a newer run that already finished', async () => {
    const { store, ingest } = setup()
    const empty = deferred()

    const emptyRun = ingest(empty.promise)

    // A newer upload starts and fails while the empty walk is still going.
    await ingest([input('later/x.css', failing('Device not readable'))])
    expect(store.getState().uploadStatus).toBe('error')

    empty.resolve([])
    await emptyRun
    await flush()

    expect(store.getState().uploadStatus).toBe('error')
    expect(store.getState().errorMessage).toContain('Device not readable')
  })
})
