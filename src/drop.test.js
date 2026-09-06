import { describe, it, expect } from 'vitest'
import {
  readAllEntries,
  collectEntryInputs,
  collectDroppedInputs,
} from './drop.js'
import { buildFileEntries } from './files.js'

/** Browsers cap readEntries at 100 per call and end with an empty array. */
const BATCH_CAP = 100

function fileEntry(fullPath, body = 'a{}') {
  return {
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (resolve) =>
      resolve({ size: body.length, type: 'text/css', text: async () => body }),
  }
}

function dirEntry(fullPath, children) {
  return {
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader() {
      let cursor = 0
      return {
        readEntries(onSuccess) {
          const batch = children.slice(cursor, cursor + BATCH_CAP)
          cursor += batch.length
          setTimeout(() => onSuccess(batch), 0)
        },
      }
    },
  }
}

describe('readAllEntries', () => {
  it('drains a directory that holds more than one batch', async () => {
    const many = Array.from({ length: 250 }, (_, n) =>
      fileEntry(`/big/part-${String(n).padStart(3, '0')}.css`),
    )
    const entries = await readAllEntries(dirEntry('/big', many).createReader())
    expect(entries).toHaveLength(250)
  })

  it('does not stop early on a directory of exactly one batch', async () => {
    const exact = Array.from({ length: BATCH_CAP }, (_, n) =>
      fileEntry(`/x/${n}.css`),
    )
    const entries = await readAllEntries(dirEntry('/x', exact).createReader())
    expect(entries).toHaveLength(BATCH_CAP)
  })

  it('resolves empty for an empty directory', async () => {
    const entries = await readAllEntries(dirEntry('/x', []).createReader())
    expect(entries).toEqual([])
  })

  it('rejects when the directory cannot be read', async () => {
    const reader = {
      readEntries(_onSuccess, onError) {
        onError(new Error('Permission denied'))
      },
    }
    await expect(readAllEntries(reader)).rejects.toThrow('Permission denied')
  })
})

describe('collectEntryInputs', () => {
  const tree = () =>
    dirEntry('/portfolio-site', [
      fileEntry('/portfolio-site/index.html', '<html></html>'),
      dirEntry('/portfolio-site/css', [
        fileEntry('/portfolio-site/css/main.css'),
        fileEntry('/portfolio-site/css/reset.css'),
      ]),
      dirEntry('/portfolio-site/js', [
        dirEntry('/portfolio-site/js/vendor', [
          fileEntry('/portfolio-site/js/vendor/lib.js', 'var a'),
        ]),
        fileEntry('/portfolio-site/js/app.js', 'start()'),
      ]),
    ])

  it('walks nested directories and keeps the full path of each file', async () => {
    const inputs = await collectEntryInputs([tree()])

    expect(inputs).toHaveLength(5)
    expect(inputs.map((i) => i.rawPath)).toContain(
      '/portfolio-site/js/vendor/lib.js',
    )
  })

  it('produces the same keys the picker would', async () => {
    const { files, rootName } = await buildFileEntries(
      await collectEntryInputs([tree()]),
    )

    expect(rootName).toBe('portfolio-site')
    expect([...files.keys()]).toEqual([
      'css/main.css',
      'css/reset.css',
      'index.html',
      'js/app.js',
      'js/vendor/lib.js',
    ])
  })
})

describe('collectDroppedInputs', () => {
  it('walks a dropped directory and ignores non-file items', async () => {
    let looseFileRequested = false
    const dataTransfer = {
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => dirEntry('/site', [fileEntry('/site/a.css')]),
          getAsFile: () => {
            looseFileRequested = true
            return null
          },
        },
        { kind: 'string', webkitGetAsEntry: () => null, getAsFile: () => null },
      ],
    }

    const inputs = await collectDroppedInputs(dataTransfer)

    expect(inputs.map((i) => i.rawPath)).toEqual(['/site/a.css'])
    expect(looseFileRequested).toBe(false)
  })

  it('falls back to a flat file drop when the entry API is missing', async () => {
    const inputs = await collectDroppedInputs({
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: undefined,
          getAsFile: () => ({
            name: 'loose.css',
            size: 3,
            type: 'text/css',
            text: async () => 'a{}',
          }),
        },
      ],
    })

    expect(inputs.map((i) => i.rawPath)).toEqual(['loose.css'])
  })

  it('resolves empty when the drop carries no files at all', async () => {
    const inputs = await collectDroppedInputs({
      items: [{ kind: 'string', webkitGetAsEntry: () => null, getAsFile: () => null }],
    })

    expect(inputs).toEqual([])
  })
})
