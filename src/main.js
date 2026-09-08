import './style.css'
import { createStore, createInitialState } from './store.js'
import { update, setDragActive } from './render.js'
import * as files from './files.js'
import { createUploader } from './upload.js'
import { collectDroppedInputs } from './drop.js'
import { compile } from './compile.js'
import { writeTheme } from './theme.js'

const root = document.querySelector('#app')
const store = createStore(createInitialState())
const { ingest, fetchFromUrl } = createUploader(store)

store.subscribe((state) => update(root, state))
update(root, store.getState())

const dropzone = root.querySelector('[data-dropzone]')
const inputFiles = root.querySelector('[data-input-files]')
const inputFolder = root.querySelector('[data-input-folder]')

root.querySelector('[data-pick-files]').addEventListener('click', () => {
  inputFiles.click()
})

root.querySelector('[data-pick-folder]').addEventListener('click', () => {
  inputFolder.click()
})

inputFiles.addEventListener('change', () => handlePicked(inputFiles))
inputFolder.addEventListener('change', () => handlePicked(inputFolder))

// A file dropped outside the drop zone would otherwise make the browser
// navigate away from the app and lose whatever is loaded.
window.addEventListener('dragover', (event) => event.preventDefault())
window.addEventListener('drop', (event) => event.preventDefault())

// dragleave also fires when the pointer crosses into a child element, so the
// active state is tracked by depth rather than by the last event seen.
let dragDepth = 0

dropzone.addEventListener('dragenter', (event) => {
  event.preventDefault()
  dragDepth += 1
  setDragActive(root, true)
})

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

dropzone.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) setDragActive(root, false)
})

dropzone.addEventListener('drop', (event) => {
  event.preventDefault()
  dragDepth = 0
  setDragActive(root, false)

  // Read the transfer synchronously, then hand the walk to ingest.
  ingest(collectDroppedInputs(event.dataTransfer))
})

function compileNow() {
  const { uploadedFiles, entryPath } = store.getState()
  const { code, stats, log } = compile(uploadedFiles, entryPath)
  store.setState({ compiledOutput: code, stats, log })
}

root.querySelector('[data-compile]').addEventListener('click', compileNow)

root.querySelector('[data-url-form]').addEventListener('submit', async (event) => {
  event.preventDefault()
  const input = root.querySelector('[data-input-url]')
  await fetchFromUrl(input.value)
  // Checking the store's current status, rather than tracking whether this
  // particular call won, is deliberate: fetchFromUrl's own guard already
  // ensures the store reflects whichever run actually won by now.
  if (store.getState().uploadStatus === 'success') compileNow()
})

/** Shared so a download and a preview build their Blob the same way. */
function createOutputUrl(compiledOutput) {
  return URL.createObjectURL(new Blob([compiledOutput], { type: 'text/html' }))
}

root.querySelector('[data-download]').addEventListener('click', () => {
  const { compiledOutput, rootName } = store.getState()
  const url = createOutputUrl(compiledOutput)

  const link = document.createElement('a')
  link.href = url
  link.download = files.downloadName(rootName)
  link.click()

  // The anchor's synchronous click already triggered the browser's own
  // (synchronous) read of the blob, so revoking on the next tick is safe.
  setTimeout(() => URL.revokeObjectURL(url), 0)
})

root.querySelector('[data-preview]').addEventListener('click', () => {
  const { compiledOutput } = store.getState()
  const url = createOutputUrl(compiledOutput)

  // Called synchronously, with nothing awaited first: a popup blocker only
  // allows window.open from within a trusted click event, and that trust
  // does not survive an intervening async gap.
  window.open(url, '_blank', 'noopener')

  // Deliberately never revoked. Opening a new tab and navigating it to a
  // blob: URL is not guaranteed to finish its fetch within one tick the way
  // the download's synchronous read is; revoking on any short timer risks
  // the preview tab failing to load. One retained Blob per preview click,
  // freed when the page closes or reloads, is the accepted, bounded cost of
  // never risking a visibly broken preview.
})

root.querySelector('[data-theme-toggle]').addEventListener('click', () => {
  const next = store.getState().theme === 'dark' ? 'light' : 'dark'
  store.setState({ theme: next })
  writeTheme(next)
})

function handlePicked(input) {
  const picked = [...input.files].map((file) => ({
    file,
    // A folder pick carries the path; a plain file pick only has a name.
    rawPath: file.webkitRelativePath || file.name,
  }))

  // Clearing the value lets the same folder be chosen twice in a row, which
  // otherwise fires no change event.
  input.value = ''
  ingest(picked)
}

if (import.meta.env.DEV) {
  // Lets the step 2 and step 3 done-whens be checked from the console before
  // any upload path exists. Vite strips this branch from the production build.
  window.store = store
  window.files = files
}
