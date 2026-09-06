/**
 * Turns a drop into the same {file, rawPath} shape the pickers produce, so both
 * paths converge on buildFileEntries and cannot drift apart.
 *
 * No DOM access here, only the DataTransfer and FileSystem entry APIs.
 */

/**
 * Drain a directory reader completely.
 *
 * readEntries() returns at most 100 entries per call and signals the end with
 * an empty array. Calling it once silently truncates any directory holding
 * more than 100 items, which is the classic bug in this API.
 */
export function readAllEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = []

    const readBatch = () => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all)
          return
        }
        all.push(...batch)
        readBatch()
      }, reject)
    }

    readBatch()
  })
}

function fileFromEntry(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walkEntry(entry, inputs) {
  if (entry.isFile) {
    inputs.push({ file: await fileFromEntry(entry), rawPath: entry.fullPath })
    return
  }

  if (entry.isDirectory) {
    const children = await readAllEntries(entry.createReader())
    for (const child of children) {
      await walkEntry(child, inputs)
    }
  }
}

/** Walk already-collected filesystem entries into ingest inputs. */
export async function collectEntryInputs(entries) {
  const inputs = []
  for (const entry of entries) {
    await walkEntry(entry, inputs)
  }
  return inputs
}

/**
 * A DataTransfer goes inert as soon as the drop handler yields, so every item
 * is read synchronously here before any traversal is awaited.
 */
export function collectDroppedInputs(dataTransfer) {
  const entries = []
  const looseFiles = []

  for (const item of dataTransfer.items) {
    if (item.kind !== 'file') continue

    const entry = item.webkitGetAsEntry?.()
    if (entry) {
      entries.push(entry)
      continue
    }

    // Browser without the entry API: a flat file drop still works.
    const file = item.getAsFile()
    if (file) looseFiles.push({ file, rawPath: file.name })
  }

  return collectEntryInputs(entries).then((walked) => [
    ...looseFiles,
    ...walked,
  ])
}
