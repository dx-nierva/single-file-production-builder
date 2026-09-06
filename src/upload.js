/**
 * Owns the upload lifecycle: status transitions, and deciding which of several
 * overlapping runs gets to write the result.
 *
 * Kept out of main.js and free of the DOM so the interleavings can be tested.
 * They are the part of this feature that has broken twice under review.
 */

import { buildFileEntries } from './files.js'
import { analyze } from './references.js'

export function createUploader(store) {
  // Reads are sequential, so a large folder takes a while and the drop zone
  // stays droppable throughout. Without this counter a slow first upload would
  // resolve last and overwrite the newer one the user actually asked for.
  let generationCounter = 0
  let inFlight = 0

  return async function ingest(pending) {
    const generation = (generationCounter += 1)
    const isCurrent = () => generation === generationCounter
    inFlight += 1

    store.setState({ uploadStatus: 'reading', errorMessage: null })

    try {
      const inputs = await pending

      if (inputs.length === 0) {
        // A newer run already owns the outcome, so there is nothing to give
        // back and nothing to restore.
        if (!isCurrent()) return

        // An empty folder, a dragged link, or a cancelled picker offers
        // nothing, so this run hands its claim back rather than cancelling an
        // upload that is still reading.
        generationCounter -= 1

        // Another run is still reading, so leave the status to it.
        if (inFlight === 1) {
          const hasFiles = store.getState().uploadedFiles.size > 0
          store.setState({ uploadStatus: hasFiles ? 'success' : 'idle' })
        }
        return
      }

      if (!isCurrent()) return

      const { files, rootName } = await buildFileEntries(inputs)
      if (!isCurrent()) return

      // Analysing here keeps the files and what they reference in one state
      // write, so the UI never renders a project against a stale reference set.
      const { entryPath, references } = analyze(files)

      store.setState({
        uploadStatus: 'success',
        uploadedFiles: files,
        rootName,
        entryPath,
        references,
      })
    } catch (error) {
      if (!isCurrent()) return

      // The files already loaded are left alone: a failed attempt should not
      // cost the user a project they had working, since nothing is persisted.
      store.setState({
        uploadStatus: 'error',
        errorMessage: `Could not read the selected files: ${describe(error)}`,
      })
    } finally {
      inFlight -= 1
    }
  }
}

/** Not every thrown value is an Error, and "undefined" is not a message. */
function describe(error) {
  const message = error?.message ?? String(error ?? '')
  return message || 'the browser gave no reason'
}
