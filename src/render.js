/**
 * Owns every DOM write. All markup already exists in index.html (including
 * the row templates); this file only ever reconciles element state/text/
 * attributes against the store - it never builds structure from a string.
 *
 * User-controlled values (folder names, file paths, authored hrefs, error text)
 * are only ever written with textContent, never into markup.
 */

import { formatSize } from './files.js'
import { describeSavings } from './compile.js'

const DROP_COPY = {
  idle: {
    title: 'Drop your project folder here',
    hint: 'Nothing leaves your browser. Everything compiles locally.',
  },
  reading: {
    title: 'Reading files',
    hint: 'This can take a moment on large projects.',
  },
  success: {
    title: 'Project loaded',
    hint: 'Drop another folder to replace it.',
  },
  error: {
    title: 'Drop your project folder here',
    hint: 'Nothing was loaded. Try again.',
  },
}

const STATUS_BADGE = {
  matched: 'badge-ok',
  missing: 'badge-warn',
  external: 'badge-muted',
}

const LOG_BADGE = {
  info: 'badge-ok',
  warn: 'badge-warn',
  error: 'badge-error',
}

export function update(root, state) {
  renderTheme(root, state)
  renderDropzone(root, state)
  renderWarningCard(root, state)
  renderFileList(root, state)
  renderReferences(root, state)
  renderActionButtons(root, state)
  renderStats(root, state)
  renderLog(root, state)
  announce(root, state)
}

function renderTheme(root, state) {
  const { theme } = state

  // The one DOM write in this file that targets an element outside root,
  // kept here anyway so every DOM write still goes through update().
  document.documentElement.dataset.theme = theme

  const themeToggle = root.querySelector('[data-theme-toggle]')
  themeToggle.textContent = theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  themeToggle.setAttribute('aria-pressed', String(theme === 'dark'))
}

function renderDropzone(root, state) {
  const { uploadStatus, uploadedFiles, rootName, errorMessage, readProgress } = state
  const copy = DROP_COPY[uploadStatus] ?? DROP_COPY.idle
  const isReading = uploadStatus === 'reading'

  // A failed upload keeps whatever was already loaded, so the drop zone has to
  // keep naming that project rather than reverting to the empty invitation.
  const keptFiles = uploadStatus === 'error' && uploadedFiles.size > 0
  const showsProject = uploadStatus === 'success' || keptFiles

  // rootName, errorMessage and every path or href come from the user's files,
  // so they are set as text, never interpolated into markup.
  root.querySelector('[data-drop-title]').textContent =
    isReading && readProgress ? describeProgress(readProgress) :
    showsProject && rootName ? `${rootName}/` : copy.title
  root.querySelector('[data-drop-hint]').textContent = keptFiles
    ? 'The project you had loaded is unchanged.'
    : copy.hint

  const dropzone = root.querySelector('[data-dropzone]')
  dropzone.classList.toggle('is-busy', isReading)
  dropzone.setAttribute('aria-busy', String(isReading))
  root.querySelector('[data-drop-actions]').hidden = isReading
  root.querySelector('[data-url-form]').hidden = isReading

  const errorCard = root.querySelector('[data-error-card]')
  errorCard.hidden = uploadStatus !== 'error'
  root.querySelector('[data-error-text]').textContent = errorMessage ?? ''
}

function renderWarningCard(root, state) {
  const { uploadedFiles, entryPath, uploadStatus } = state

  // Only meaningful once the upload has settled: mid-read there is no analysis
  // yet, and the drop zone is already saying so.
  root.querySelector('[data-warning-card]').hidden = !(
    uploadedFiles.size > 0 &&
    entryPath === null &&
    uploadStatus !== 'reading'
  )
}

function renderActionButtons(root, state) {
  const { uploadStatus, uploadedFiles, entryPath, compiledOutput } = state
  const isReading = uploadStatus === 'reading'

  // The caption explains the disabled state rather than disappearing and
  // leaving a bare dead button.
  root.querySelector('[data-compile-hint]').textContent =
    uploadedFiles.size === 0 ? 'Add files to enable' : capitalize(referenceSummary(state))

  // Mid-read, entryPath still describes whatever was loaded before, so
  // compiling is gated on the read having settled, not just a non-null path.
  root.querySelector('[data-compile]').disabled = isReading || entryPath === null

  const canAct = compiledOutput !== null
  root.querySelector('[data-download]').disabled = !canAct
  root.querySelector('[data-preview]').disabled = !canAct
  root.querySelector('[data-clear]').disabled = uploadStatus === 'idle'
  root.querySelector('[data-view-source]').disabled = !canAct
  // A stale or empty panel must never be visible: force it shut whenever
  // there is nothing compiled to show, regardless of how it got that way
  // (Clear, a file removal, or simply never having compiled yet).
  if (!canAct) root.querySelector('[data-source-panel]').hidden = true
  root.querySelector('[data-source-output]').value = compiledOutput ?? ''
}

/** Drag feedback is transient, so it is not stored in state. */
export function setDragActive(root, isActive) {
  root.querySelector('[data-dropzone]').classList.toggle('is-active', isActive)
}

/**
 * One polite live region carries every status change, so a screen reader user
 * hears the outcome of a drop they cannot see.
 */
function announce(root, state) {
  const { uploadStatus, rootName, errorMessage, uploadedFiles } = state
  const count = uploadedFiles.size
  const region = root.querySelector('[data-status]')

  if (uploadStatus === 'reading') {
    region.textContent = 'Reading files'
    return
  }

  if (uploadStatus === 'error') {
    region.textContent = `Upload failed. ${errorMessage ?? ''}`.trim()
    return
  }

  if (uploadStatus === 'success') {
    const noun = count === 1 ? '1 file' : `${count} files`
    const from = rootName ? ` from ${rootName}` : ''
    region.textContent = `${noun} loaded${from}, ${referenceSummary(state)}`
    return
  }

  region.textContent = ''
}

/**
 * One phrase describing the analysis, shared by the compile caption and the
 * live region so they can never disagree.
 */
function referenceSummary(state) {
  const { entryPath, references } = state

  if (entryPath === null) return 'no entry index.html found'
  if (references.length === 0) return 'no references to inline'

  const matched = references.filter((r) => r.status === 'matched').length
  return `${matched} of ${references.length} references resolved`
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function describeCount(count, bytes) {
  if (count === 0) return '0 files'
  const label = count === 1 ? '1 file' : `${count} files`
  return `${label} · ${formatSize(bytes)}`
}

function describeProgress({ done, total }) {
  return `Reading files (${done.toLocaleString()} of ${total.toLocaleString()})`
}

function totalBytes(uploadedFiles) {
  let total = 0
  for (const entry of uploadedFiles.values()) {
    total += entry.size
  }
  return total
}

function renderFileList(root, state) {
  const { uploadedFiles, entryPath, references } = state
  const count = uploadedFiles.size

  root.querySelector('[data-file-count]').textContent = describeCount(
    count,
    totalBytes(uploadedFiles),
  )

  const referenced = new Set(
    references.map((reference) => reference.resolvedPath).filter(Boolean),
  )

  const list = root.querySelector('[data-file-list]')
  const template = root.querySelector('[data-tpl-file-row]')
  list.replaceChildren()
  for (const entry of uploadedFiles.values()) {
    const isEntry = entry.path === entryPath
    // Without an entry nothing has been analysed, so nothing is known to be
    // unreferenced and badging every row would be noise.
    const unreferenced =
      entryPath !== null && !isEntry && !referenced.has(entry.path)

    const row = cloneRow(template)
    row.classList.toggle('is-entry', isEntry)
    row.classList.toggle('is-skipped', unreferenced)

    row.querySelector('[data-cell-path]').textContent = entry.path
    row.querySelector('[data-cell-type]').textContent = entry.type
    row.querySelector('[data-cell-size]').textContent = formatSize(entry.size)
    row.querySelector('[data-badge-entry]').hidden = !isEntry
    row.querySelector('[data-badge-unreferenced]').hidden = !unreferenced

    const removeButton = row.querySelector('[data-remove-file]')
    removeButton.dataset.path = entry.path
    removeButton.setAttribute('aria-label', `Remove ${entry.path}`)

    list.append(row)
  }

  list.hidden = count === 0
  root.querySelector('[data-file-empty]').hidden = count > 0
}

function renderReferences(root, state) {
  const { uploadedFiles, entryPath, references } = state
  const list = root.querySelector('[data-reference-list]')
  const template = root.querySelector('[data-tpl-reference-row]')

  list.replaceChildren()
  for (const reference of references) {
    const row = cloneRow(template)
    row.classList.toggle('is-skipped', reference.status !== 'matched')

    row.querySelector('[data-cell-path]').textContent = reference.rawHref
    row.querySelector('[data-cell-type]').textContent = reference.kind

    const status = row.querySelector('[data-cell-status]')
    status.className = `badge ${STATUS_BADGE[reference.status]}`
    status.textContent = reference.status

    list.append(row)
  }

  list.hidden = references.length === 0
  root.querySelector('[data-reference-count]').textContent =
    references.length === 0 ? '' : describeReferences(references)

  const empty = root.querySelector('[data-reference-empty]')
  empty.hidden = references.length > 0
  empty.textContent = describeNoReferences(uploadedFiles.size, entryPath)
}

function describeReferences(references) {
  const matched = references.filter((r) => r.status === 'matched').length
  return `${matched} of ${references.length} resolved`
}

function describeNoReferences(fileCount, entryPath) {
  if (fileCount === 0) return 'Detected from the entry document after an upload'
  if (entryPath === null) return 'No entry document found'
  return 'The entry document references no stylesheets or scripts'
}

/** The six rows already exist in index.html; only their values ever change. */
function renderStats(root, state) {
  const { stats, compiledOutput } = state

  root.querySelector('[data-result-status]').textContent =
    compiledOutput === null ? 'not compiled' : 'compiled'

  const values = stats ?? {
    originalBytes: 0,
    compiledBytes: 0,
    matchedCount: 0,
    missingCount: 0,
    externalCount: 0,
  }
  const saved = stats ? describeSavings(stats.originalBytes, stats.compiledBytes) : ''

  const list = root.querySelector('[data-result-stats]')
  list.querySelector('[data-stat-original]').textContent = stats ? formatSize(values.originalBytes) : ''
  list.querySelector('[data-stat-compiled]').textContent = stats ? formatSize(values.compiledBytes) : ''
  list.querySelector('[data-stat-saved]').textContent = saved
  list.querySelector('[data-stat-matched]').textContent = stats ? String(values.matchedCount) : ''
  list.querySelector('[data-stat-missing]').textContent = stats ? String(values.missingCount) : ''
  list.querySelector('[data-stat-external]').textContent = stats ? String(values.externalCount) : ''

  list.hidden = stats === null
  root.querySelector('[data-result-empty]').hidden = stats !== null
}

function renderLog(root, state) {
  const { log } = state

  root.querySelector('[data-log-count]').textContent =
    log.length === 0 ? '' : `${log.length} ${log.length === 1 ? 'entry' : 'entries'}`

  const list = root.querySelector('[data-log-list]')
  const template = root.querySelector('[data-tpl-log-row]')
  list.replaceChildren()
  for (const entry of log) {
    const row = cloneRow(template)

    row.querySelector('[data-cell-step]').textContent = entry.step
    row.querySelector('[data-cell-message]').textContent = entry.message

    const level = row.querySelector('[data-cell-level]')
    level.className = `badge ${LOG_BADGE[entry.level]}`
    level.textContent = entry.level

    list.append(row)
  }

  list.hidden = log.length === 0
  root.querySelector('[data-log-empty]').hidden = log.length > 0
}

/** Every row template's content is exactly one <li>; clone that node directly
 *  rather than the fragment wrapping it. */
function cloneRow(template) {
  return template.content.firstElementChild.cloneNode(true)
}
