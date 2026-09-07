import './style.css'
import { createStore, createInitialState } from './store.js'
import { mount, update, setDragActive } from './render.js'
import * as files from './files.js'
import { createUploader } from './upload.js'
import { collectDroppedInputs } from './drop.js'
import { compile } from './compile.js'

const root = document.querySelector('#app')
const store = createStore(createInitialState())
const ingest = createUploader(store)

mount(root)
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

root.querySelector('[data-compile]').addEventListener('click', () => {
  const { uploadedFiles, entryPath } = store.getState()
  store.setState({ compiledOutput: compile(uploadedFiles, entryPath) })
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
