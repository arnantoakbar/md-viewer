'use strict';

/* ═══════════════════════════════════════════════════════════
   STATE
═══════════════════════════════════════════════════════════ */
const state = {
  rootDirHandle:     null,
  currentDirHandle:  null,
  dirStack:          [],   // [{ handle, name }]
  currentFileHandle: null,
  isDirty:           false,
  currentView:       'rendered',
  isPanelCollapsed:  false,
  isFullscreen:      false,
  panelWidth:        280,
  isResizing:        false,
  // Search
  searchActive:      false,
  searchQuery:       '',
  searchGenId:       0,    // incremented on each new search to cancel stale runs
  searchOpenResult:  null, // the result object last opened from search (path used on exit)
  // In-file match navigation
  matchNav: {
    active: false,
    marks:  [],   // all mark.search-match elements in current file
    index:  0,    // currently focused match (0-based)
  },
};

const PREF_KEY = 'mdviewer-prefs';

// Tracks the file/folder pending soft-delete (during the 3 s undo window)
let _pendingDelete = null; // { name, handle, kind, dirHandle, listItemEl, timer }

// Drag-and-drop state
let _dragState   = null; // { handle, name, kind, srcDirHandle, listItemEl }
let _pendingMove = null; // { handle, name, kind, srcDirHandle, destDirHandle, destDirName, listItemEl }


/* ═══════════════════════════════════════════════════════════
   DOM REFERENCES
═══════════════════════════════════════════════════════════ */
const dom = {};

function cacheDom() {
  const ids = [
    'landing', 'app',
    'btn-open-folder', 'btn-open-new', 'btn-toggle-panel',
    'btn-up', 'btn-view-rendered', 'btn-view-code',
    'btn-new-file', 'btn-new-folder', 'btn-duplicate',
    'btn-save', 'btn-fullscreen', 'icon-fullscreen',
    'panel-left', 'resize-handle', 'panel-right',
    'file-list', 'file-list-empty', 'current-dir-name',
    'breadcrumb',
    'preview-pane', 'preview-empty', 'code-pane', 'code-editor', 'code-highlight', 'line-numbers',
    'file-name-display', 'dirty-indicator',
    'api-unsupported', 'toast-container',
    'delete-modal', 'delete-modal-filename', 'btn-delete-cancel', 'btn-delete-confirm',
    'file-panel-toolbar',
    'btn-help', 'shortcuts-modal', 'btn-shortcuts-close',
    'move-modal', 'move-modal-source', 'move-modal-dest', 'btn-move-cancel', 'btn-move-confirm',
    // Search
    'search-bar', 'search-input', 'btn-search-clear', 'search-results', 'search-status',
    // Match navigator
    'match-nav', 'btn-match-prev', 'btn-match-next', 'btn-match-close',
    'match-nav-label', 'match-nav-query',
  ];
  ids.forEach(id => {
    const key = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    dom[key] = document.getElementById(id);
  });
}


/* ═══════════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════════ */
function init() {
  cacheDom();
  loadPreferences();
  _applyOsShortcutLabels();

  if (!('showDirectoryPicker' in window)) {
    dom.apiUnsupported.classList.remove('hidden');
    dom.btnOpenFolder.disabled = true;
    dom.btnOpenFolder.title = 'File System Access API not supported in this browser';
  }

  // Initialise Mermaid with Flavida-themed neutral palette
  mermaid.initialize({
    startOnLoad: false,
    theme: 'neutral',
    themeVariables: {
      primaryColor:       '#FFF0E0',
      primaryBorderColor: '#E8391D',
      primaryTextColor:   '#111111',
      lineColor:          '#E8391D',
      secondaryColor:     '#FFF8F0',
      tertiaryColor:      '#FFF8F0',
      edgeLabelBackground:'#FFF8F0',
      fontFamily:         'DM Sans, sans-serif',
    },
    flowchart:  { curve: 'basis' },
    securityLevel: 'loose',
  });

  wireEvents();
  initResizeHandle();
  wireKeyboard();
}

document.addEventListener('DOMContentLoaded', init);


/* ═══════════════════════════════════════════════════════════
   FOLDER PICKER
═══════════════════════════════════════════════════════════ */
async function openFolder() {
  if (!('showDirectoryPicker' in window)) {
    showToast('File System Access API is not supported in this browser. Please use Chrome or Edge 86+.', 'error', 5000);
    return;
  }

  try {
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });

    state.rootDirHandle     = handle;
    state.currentDirHandle  = handle;
    state.dirStack          = [{ handle, name: handle.name }];
    state.currentFileHandle = null;
    state.isDirty           = false;
    state.currentView       = 'rendered'; // always start in rendered view on folder open

    showApp();
    await loadDirectory(handle);

  } catch (err) {
    if (err.name === 'AbortError') return; // user cancelled — silent
    showToast('Could not open folder: ' + err.message, 'error');
  }
}

function showApp() {
  dom.landing.classList.add('hidden');
  dom.app.classList.remove('hidden');
  dom.btnHelp.classList.remove('hidden');
  applyPreferences();
}


/* ═══════════════════════════════════════════════════════════
   DIRECTORY NAVIGATION
═══════════════════════════════════════════════════════════ */
async function loadDirectory(dirHandle) {
  dom.fileList.innerHTML = '';
  dom.fileListEmpty.classList.add('hidden');

  const dirs  = [];
  const files = [];

  try {
    for await (const [name, handle] of dirHandle.entries()) {
      // Skip hidden files/dirs (starting with .)
      if (name.startsWith('.')) continue;

      if (handle.kind === 'directory') {
        dirs.push({ name, handle });
      } else if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) {
        files.push({ name, handle });
      }
      // All other file types are silently ignored
    }
  } catch (err) {
    showToast('Could not read directory: ' + err.message, 'error');
    return;
  }

  // Sort alphabetically, case-insensitive
  const collator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
  dirs.sort((a, b) => collator.compare(a.name, b.name));
  files.sort((a, b) => collator.compare(a.name, b.name));

  const allEntries = [...dirs, ...files];

  // Filter out any entry that has a pending delete in this directory —
  // keeps the list consistent even when the user navigates away and back.
  const pendingDeleteName = (_pendingDelete && _pendingDelete.dirHandle === dirHandle)
    ? _pendingDelete.name : null;

  const visibleEntries = pendingDeleteName
    ? allEntries.filter(({ name }) => name !== pendingDeleteName)
    : allEntries;

  if (visibleEntries.length === 0) {
    dom.fileListEmpty.classList.remove('hidden');
  } else {
    const fragment = document.createDocumentFragment();
    visibleEntries.forEach(({ name, handle }) => {
      fragment.appendChild(createFileItem(name, handle));
    });
    dom.fileList.appendChild(fragment);
  }

  dom.currentDirName.textContent = dirHandle.name;
  dom.btnUp.disabled = state.dirStack.length <= 1;
  renderBreadcrumb();
}

function createFileItem(name, handle) {
  const el = document.createElement('button');
  el.className = 'file-item';
  el.dataset.kind = handle.kind;
  el.setAttribute('role', 'listitem');
  el.type = 'button';

  const icon = document.createElement('span');
  icon.className = 'file-item-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = handle.kind === 'directory' ? '📁' : '📄';

  const label = document.createElement('span');
  label.className = 'file-item-label';
  label.textContent = name;
  label.title = name;

  el.append(icon, label);

  // Delete button (files and folders) — visible on hover via CSS
  const delBtn = document.createElement('span');
  delBtn.className = 'file-item-delete';
  delBtn.setAttribute('role', 'button');
  delBtn.setAttribute('aria-label', `Delete ${name}`);
  delBtn.setAttribute('title', handle.kind === 'directory' ? 'Delete folder' : 'Delete file');
  delBtn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
    <path d="M10 11v6"/><path d="M14 11v6"/>
  </svg>`;
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    requestDeleteFile(name, handle, el);
  });
  el.appendChild(delBtn);

  // For directories, delay navigation 300 ms so a double-click can cancel it
  // and start a rename instead (otherwise dblclick fires AFTER two navigations).
  let _navTimer = null;

  el.addEventListener('click', () => {
    // Ignore clicks while a rename input is active on this item
    if (el.dataset.renaming) return;
    if (handle.kind === 'directory') {
      clearTimeout(_navTimer);
      _navTimer = setTimeout(() => { enterDirectory(handle, name); }, 300);
    } else {
      openFile(handle, name, el);
    }
  });

  // Double-click → rename (for both files and folders)
  el.addEventListener('dblclick', e => {
    e.stopPropagation();
    clearTimeout(_navTimer); // cancel pending directory navigation
    if (el.dataset.renaming) return;
    startRename(handle, state.currentDirHandle, el, name);
  });

  // ── Drag and drop ───────────────────────────────────────
  el.draggable = true;

  el.addEventListener('dragstart', e => {
    _dragState = { handle, name, kind: handle.kind, srcDirHandle: state.currentDirHandle, listItemEl: el };
    requestAnimationFrame(() => el.classList.add('dragging'));
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', name); // required for Firefox
  });

  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dom.fileList.querySelectorAll('.drag-over').forEach(t => t.classList.remove('drag-over'));
    _dragState = null;
  });

  // Folder items are drop targets
  if (handle.kind === 'directory') {
    el.addEventListener('dragover', e => {
      if (!_dragState || _dragState.name === name) return; // can't drop onto itself
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', e => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drag-over');
    });
    el.addEventListener('drop', e => {
      e.preventDefault();
      el.classList.remove('drag-over');
      if (!_dragState || _dragState.name === name) return;
      const ds = _dragState;
      _dragState = null;
      requestMoveEntry(ds, handle, name);
    });
  }

  return el;
}

async function enterDirectory(handle, name) {
  if (await confirmIfDirty()) return;
  state.dirStack.push({ handle, name });
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

async function goUp() {
  if (state.dirStack.length <= 1) return;
  if (await confirmIfDirty()) return;

  state.dirStack.pop();
  const { handle } = state.dirStack[state.dirStack.length - 1];
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

async function navigateToBreadcrumb(depth) {
  if (depth >= state.dirStack.length - 1) return;
  if (await confirmIfDirty()) return;

  state.dirStack = state.dirStack.slice(0, depth + 1);
  const { handle } = state.dirStack[state.dirStack.length - 1];
  state.currentDirHandle = handle;
  clearActiveFile();
  await loadDirectory(handle);
}

function clearActiveFile() {
  state.currentFileHandle = null;
  state.isDirty = false;
  dom.fileNameDisplay.textContent = 'No file open';
  delete dom.fileNameDisplay.dataset.renameable;
  dom.dirtyIndicator.classList.add('hidden');
  dom.btnSave.classList.add('hidden');
  dom.btnDuplicate.classList.add('hidden');
  dom.previewEmpty.classList.remove('hidden');
  dom.previewPane.innerHTML = '';
  dom.previewPane.appendChild(dom.previewEmpty);
  dom.codeEditor.value = '';
}


/* ═══════════════════════════════════════════════════════════
   FILE MANAGEMENT — CREATE / DUPLICATE / RENAME
═══════════════════════════════════════════════════════════ */

// Split "my notes (2).md" → { base: "my notes", ext: ".md" }
function _splitName(fullName) {
  const dot = fullName.lastIndexOf('.');
  if (dot <= 0) return { base: fullName, ext: '' };
  return { base: fullName.slice(0, dot), ext: fullName.slice(dot) };
}

// Return the first unused name: try base+ext, then "base (2)+ext", etc.
async function _getAvailableName(dirHandle, base, ext) {
  const existing = new Set();
  try {
    for await (const [name] of dirHandle.entries()) existing.add(name.toLowerCase());
  } catch (_) {}
  if (!existing.has((base + ext).toLowerCase())) return base + ext;
  let i = 2;
  while (existing.has(`${base} (${i})${ext}`.toLowerCase())) i++;
  return `${base} (${i})${ext}`;
}

async function createNewFile() {
  if (!state.currentDirHandle) return;
  const name = await _getAvailableName(state.currentDirHandle, 'untitled', '.md');
  try {
    const handle = await state.currentDirHandle.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    await writable.write('');
    await writable.close();

    await loadDirectory(state.currentDirHandle);

    // Find and activate the new item, then start rename immediately
    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.querySelector('.file-item-label')?.textContent === name);
    if (item) {
      // Mark active + update state so toolbar rename works
      dom.fileList.querySelectorAll('.file-item').forEach(e => e.classList.remove('active'));
      item.classList.add('active');
      state.currentFileHandle = handle;
      state.isDirty = false;
      dom.fileNameDisplay.textContent = name;
      dom.fileNameDisplay.dataset.renameable = '1';
      dom.dirtyIndicator.classList.add('hidden');
      dom.btnSave.classList.add('hidden');
      dom.btnDuplicate.classList.remove('hidden');
      dom.codeEditor.value = '';
      await renderMarkdown('');
      setView('code', false); // go straight to code view; don't persist so next file open stays rendered
      updateLineNumbers();
      updateCodeHighlight();
      // Start rename right away so user can set a real name
      startRename(handle, state.currentDirHandle, item, name);
    }
  } catch (err) {
    showToast('Could not create file: ' + err.message, 'error');
  }
}

async function createNewFolder() {
  if (!state.currentDirHandle) return;
  const name = await _getAvailableName(state.currentDirHandle, 'untitled folder', '');
  try {
    const handle = await state.currentDirHandle.getDirectoryHandle(name, { create: true });

    await loadDirectory(state.currentDirHandle);

    // Find the new folder item and immediately start rename
    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.dataset.kind === 'directory' && el.querySelector('.file-item-label')?.textContent === name);
    if (item) {
      startRename(handle, state.currentDirHandle, item, name);
    }
  } catch (err) {
    showToast('Could not create folder: ' + err.message, 'error');
  }
}

async function duplicateFile() {
  if (!state.currentFileHandle || !state.currentDirHandle) return;
  const origName = dom.fileNameDisplay.textContent;
  const { base, ext } = _splitName(origName);
  // Strip any existing counter before generating the new name
  const cleanBase = base.replace(/ \(\d+\)$/, '');
  const newName = await _getAvailableName(state.currentDirHandle, cleanBase, ext);

  try {
    const content = dom.codeEditor.value; // use live editor content
    const handle  = await state.currentDirHandle.getFileHandle(newName, { create: true });
    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();

    showToast(`Duplicated as "${newName}"`, 'success');
    await loadDirectory(state.currentDirHandle);

    const item = [...dom.fileList.querySelectorAll('.file-item')]
      .find(el => el.querySelector('.file-item-label')?.textContent === newName);
    if (item) {
      await openFile(handle, newName, item);
      setView('code', false); // duplicated file → start in code view without persisting
    }
  } catch (err) {
    showToast('Could not duplicate: ' + err.message, 'error');
  }
}

// ── Inline rename ─────────────────────────────────────────

// Start inline rename on a left-panel file item.
function startRename(handle, dirHandle, listItemEl, currentName) {
  // Don't start a second rename if one is already in progress
  if (listItemEl.dataset.renaming) return;
  // For directories, use the full name as base (no extension splitting)
  const { base, ext } = handle.kind === 'directory'
    ? { base: currentName, ext: '' }
    : _splitName(currentName);
  const label = listItemEl.querySelector('.file-item-label');
  if (!label) return;

  // Mark the item as renaming so click/dblclick handlers are blocked
  listItemEl.dataset.renaming = '1';

  let committed = false;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-item-rename';
  input.value = base;
  label.replaceWith(input);
  input.focus();
  input.select();

  // Prevent mouse and keyboard events from bubbling to the parent <button>,
  // which would otherwise trigger navigation or re-open the file.
  input.addEventListener('click',     e => e.stopPropagation());
  input.addEventListener('mousedown', e => e.stopPropagation());
  input.addEventListener('keyup',     e => e.stopPropagation());

  const cleanup = () => {
    delete listItemEl.dataset.renaming;
  };

  const commit = async () => {
    if (committed) return;
    committed = true;
    cleanup();
    const newBase = input.value.trim();
    const newName = (newBase || base) + ext;
    input.replaceWith(label);
    label.textContent = currentName; // restore temporarily; _commitRename reloads
    if (newName !== currentName) {
      await _commitRename(handle, dirHandle, currentName, newName);
    }
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    cleanup();
    input.replaceWith(label);
    label.textContent = currentName;
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation(); // block app shortcuts while typing
  });
  input.addEventListener('blur', commit);
}

// Start inline rename from the toolbar filename.
function startToolbarRename() {
  if (!state.currentFileHandle || !state.currentDirHandle) return;
  const currentName = dom.fileNameDisplay.textContent;
  if (!currentName || currentName === 'No file open') return;
  // Don't start if already renaming
  if (dom.fileNameDisplay.parentElement.querySelector('.file-name-rename')) return;

  const { base, ext } = _splitName(currentName);
  let committed = false;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'file-name-rename';
  input.value = base;
  dom.fileNameDisplay.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    if (committed) return;
    committed = true;
    const newBase = input.value.trim();
    const newName = (newBase || base) + ext;
    input.replaceWith(dom.fileNameDisplay);
    dom.fileNameDisplay.textContent = currentName; // restore temporarily
    if (newName !== currentName) {
      await _commitRename(state.currentFileHandle, state.currentDirHandle, currentName, newName);
    }
  };
  const cancel = () => {
    if (committed) return;
    committed = true;
    input.replaceWith(dom.fileNameDisplay);
    dom.fileNameDisplay.textContent = currentName;
  };

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(); }
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
}

// Rename a file or folder: copy to new name, remove old.
async function _commitRename(handle, dirHandle, oldName, newName) {
  if (!newName || /[/\\]/.test(newName)) {
    showToast('Invalid name', 'error');
    await loadDirectory(dirHandle);
    return;
  }
  if (newName === oldName) return;

  // Check for collision (entry with newName already exists)
  try {
    if (handle.kind === 'file') await dirHandle.getFileHandle(newName);
    else await dirHandle.getDirectoryHandle(newName);
    showToast(`"${newName}" already exists`, 'warning');
    await loadDirectory(dirHandle);
    return;
  } catch (_) { /* name is available */ }

  try {
    if (handle.kind === 'file') {
      // Use live editor content if this is the currently open file
      const isOpen = state.currentFileHandle === handle;
      const content = isOpen
        ? dom.codeEditor.value
        : await (await handle.getFile()).text();

      const newHandle = await dirHandle.getFileHandle(newName, { create: true });
      const writable  = await newHandle.createWritable();
      await writable.write(content);
      await writable.close();
      await dirHandle.removeEntry(oldName);

      if (isOpen) {
        state.currentFileHandle = newHandle;
        dom.fileNameDisplay.textContent = newName;
      }
    } else {
      // Directory rename: deep-copy under new name, then remove old
      await _copyDirRecursive(handle, newName, dirHandle);
      await dirHandle.removeEntry(oldName, { recursive: true });

      // If this directory (or a descendant) is in the navigation stack,
      // truncate the stack to just before it so navigation resets cleanly
      const stackIdx = state.dirStack.findIndex(e => e.handle === handle);
      if (stackIdx !== -1) {
        state.dirStack = state.dirStack.slice(0, stackIdx);
        state.currentDirHandle = state.dirStack[state.dirStack.length - 1].handle;
        clearActiveFile();
      }
    }

    showToast(`Renamed to "${newName}"`, 'success');
    await loadDirectory(dirHandle);

    // Re-mark the renamed file item as active (files only)
    if (handle.kind === 'file') {
      const item = [...dom.fileList.querySelectorAll('.file-item')]
        .find(el => el.querySelector('.file-item-label')?.textContent === newName);
      if (item) item.classList.add('active');
    }

  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
    await loadDirectory(dirHandle);
  }
}


/* ═══════════════════════════════════════════════════════════
   FILE DELETION — confirm modal + undo toast
═══════════════════════════════════════════════════════════ */

function requestDeleteFile(name, handle, listItemEl) {
  // If another pending delete exists, execute it immediately first
  if (_pendingDelete) _executePendingDelete();

  _pendingDelete = { name, handle, kind: handle.kind, dirHandle: state.currentDirHandle, listItemEl, timer: null };

  // Update modal title and description based on kind
  const isDir = handle.kind === 'directory';
  document.getElementById('delete-modal-title').textContent = isDir ? 'Delete folder?' : 'Delete file?';
  const suffixEl = document.getElementById('delete-modal-suffix');
  if (suffixEl) suffixEl.textContent = isDir ? ' and all its contents will be permanently deleted.' : ' will be permanently deleted.';

  dom.deleteModalFilename.textContent = name;
  dom.deleteModal.classList.remove('hidden');
  // Focus the cancel button by default (safer)
  requestAnimationFrame(() => dom.btnDeleteCancel.focus());
}

function _closeDeleteModal() {
  dom.deleteModal.classList.add('hidden');
}

function openHelp() {
  dom.shortcutsModal.classList.remove('hidden');
  requestAnimationFrame(() => dom.btnShortcutsClose.focus());
}

function closeHelp() {
  dom.shortcutsModal.classList.add('hidden');
}

function _startSoftDelete() {
  _closeDeleteModal();
  const { name, dirHandle, listItemEl } = _pendingDelete;

  // Hide from the current DOM view immediately
  listItemEl.style.display = 'none';

  // Show undo toast with 3 s countdown
  const DELAY = 3000;
  showUndoToast(`"${name}" deleted`, DELAY, () => {
    // UNDO pressed — clear the pending delete and reload to restore the item
    _pendingDelete = null;
    if (state.currentDirHandle === dirHandle) {
      loadDirectory(dirHandle); // fire-and-forget: shows the item again
    }
  });

  // Schedule actual deletion
  _pendingDelete.timer = setTimeout(async () => {
    if (!_pendingDelete) return; // already undone
    await _executePendingDelete();
  }, DELAY);
}

async function _executePendingDelete() {
  if (!_pendingDelete) return;
  const { name, handle, kind, dirHandle, listItemEl } = _pendingDelete;
  _pendingDelete = null;

  // listItemEl.style.display is 'none' when the item is hidden (not undone).
  // It may be a detached element if the user navigated away, but its style is
  // still 'none' — that's how we know the undo window expired without undo.
  if (listItemEl.style.display === 'none') {
    try {
      await dirHandle.removeEntry(name, { recursive: kind === 'directory' });
    } catch (err) {
      listItemEl.style.display = '';
      showToast(`Could not delete "${name}": ${err.message}`, 'error');
      return;
    }

    // Clear the preview only if the deleted file is still the active one
    if (state.currentFileHandle === handle) {
      clearActiveFile();
    }

    // Reload the directory to remove any stale DOM nodes
    // (covers navigate-away-and-back case; no-op if user is elsewhere)
    if (state.currentDirHandle === dirHandle) {
      await loadDirectory(dirHandle);
    }
  }
}

/* ═══════════════════════════════════════════════════════════
   DRAG-AND-DROP MOVE — confirm modal + undo toast
═══════════════════════════════════════════════════════════ */

function requestMoveEntry(dragInfo, destDirHandle, destDirName) {
  _pendingMove = {
    handle:       dragInfo.handle,
    name:         dragInfo.name,
    kind:         dragInfo.kind,
    srcDirHandle: dragInfo.srcDirHandle,
    destDirHandle,
    destDirName,
    listItemEl:   dragInfo.listItemEl,
  };

  dom.moveModalSource.textContent = dragInfo.name;
  dom.moveModalDest.textContent   = destDirName;
  dom.moveModal.classList.remove('hidden');
  requestAnimationFrame(() => dom.btnMoveCancel.focus());
}

function _closeMoveModal() {
  dom.moveModal.classList.add('hidden');
}

async function _startSoftMove() {
  _closeMoveModal();
  if (!_pendingMove) return;
  await _executePendingMove();
}

async function _executePendingMove() {
  if (!_pendingMove) return;
  const { handle, name, kind, srcDirHandle, destDirHandle, destDirName, listItemEl } = _pendingMove;
  _pendingMove = null;

  try {
    // Check for name collision at destination
    try {
      if (kind === 'file') await destDirHandle.getFileHandle(name);
      else                 await destDirHandle.getDirectoryHandle(name);
      // Name exists — abort with a clear message so user knows to rename first
      showToast(`Can't move: "${destDirName}" already contains an item named "${name}". Rename one of them first.`, 'warning', 5000);
      return;
    } catch (_) { /* name is free — proceed */ }

    if (kind === 'file') {
      const content   = await (await handle.getFile()).arrayBuffer();
      const newHandle = await destDirHandle.getFileHandle(name, { create: true });
      const writable  = await newHandle.createWritable();
      await writable.write(content);
      await writable.close();
      await srcDirHandle.removeEntry(name);
    } else {
      await _copyDirRecursive(handle, name, destDirHandle);
      await srcDirHandle.removeEntry(name, { recursive: true });
    }

    listItemEl.remove();
    if (dom.fileList.querySelectorAll('.file-item').length === 0) {
      dom.fileListEmpty.classList.remove('hidden');
    }
    if (state.currentFileHandle === handle) {
      clearActiveFile();
    }
    showToast(`"${name}" moved to "${destDirName}"`, 'success');

  } catch (err) {
    listItemEl.style.opacity = ''; listItemEl.style.pointerEvents = ''; listItemEl.draggable = true;
    showToast(`Could not move "${name}": ${err.message}`, 'error');
  }
}

// Recursively copy all contents of srcDirHandle into a new sub-folder under destParentHandle.
async function _copyDirRecursive(srcDirHandle, name, destParentHandle) {
  const newDir = await destParentHandle.getDirectoryHandle(name, { create: true });
  for await (const [entryName, entryHandle] of srcDirHandle.entries()) {
    if (entryHandle.kind === 'file') {
      const content = await (await entryHandle.getFile()).arrayBuffer();
      const fh = await newDir.getFileHandle(entryName, { create: true });
      const wr = await fh.createWritable();
      await wr.write(content);
      await wr.close();
    } else {
      await _copyDirRecursive(entryHandle, entryName, newDir);
    }
  }
}


function showUndoToast(message, delay, onUndo) {
  const toast = document.createElement('div');
  toast.className = 'toast warning';
  toast.setAttribute('role', 'status');

  const row = document.createElement('div');
  row.className = 'toast-undo-row';

  const text = document.createElement('span');
  text.textContent = message;

  const undoBtn = document.createElement('button');
  undoBtn.className = 'toast-undo-btn';
  // Show the keyboard shortcut hint inside the button label
  const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
  const kbdShortcut = isMac ? '⌘Z' : 'Ctrl+Z';
  const undoKbd = document.createElement('kbd');
  undoKbd.className = 'toast-kbd';
  undoKbd.textContent = kbdShortcut;
  undoBtn.append('Undo ', undoKbd);
  undoBtn.addEventListener('click', () => {
    // Clear the pending delete timer
    clearTimeout(_pendingDelete?.timer);
    onUndo();
    hide();
  });

  row.append(text, undoBtn);

  const progress = document.createElement('div');
  progress.className = 'toast-progress';
  progress.style.animationDuration = delay + 'ms';

  toast.append(row, progress);
  dom.toastContainer.appendChild(toast);

  toast.getBoundingClientRect(); // force reflow
  toast.classList.add('show');

  const hide = () => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  setTimeout(hide, delay + 300);
}


/* ═══════════════════════════════════════════════════════════
   FILE LOADING & RENDERING
═══════════════════════════════════════════════════════════ */
async function openFile(handle, name, listItemEl) {
  if (await confirmIfDirty()) return;

  // Update active state in file list
  dom.fileList.querySelectorAll('.file-item').forEach(el => el.classList.remove('active'));
  listItemEl.classList.add('active');

  try {
    const file    = await handle.getFile();
    const content = await file.text();

    state.currentFileHandle = handle;
    state.isDirty = false;

    dom.fileNameDisplay.textContent = name;
    dom.fileNameDisplay.dataset.renameable = '1';
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');
    dom.btnDuplicate.classList.remove('hidden');
    dom.codeEditor.value = content;
    dom.lineNumbers._count = null; // force rebuild on next updateLineNumbers()

    await renderMarkdown(content);
    setView('rendered'); // always open existing files in rendered view
    updateLineNumbers();
    updateCodeHighlight();

  } catch (err) {
    showToast('Could not read file: ' + err.message, 'error');
  }
}

async function renderMarkdown(content) {
  marked.setOptions({
    breaks: true,
    gfm: true,
  });

  let rawHtml;
  try {
    rawHtml = marked.parse(content);
  } catch (e) {
    rawHtml = '<p style="color:var(--color-flame)">Error parsing Markdown: ' + escapeHtml(e.message) + '</p>';
  }

  // DOMPurify: allow class attrs so highlight.js styling is preserved
  const safeHtml = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['class'],
    ALLOW_DATA_ATTR: false,
  });

  dom.previewPane.innerHTML = safeHtml;

  // Syntax highlight non-mermaid code blocks and stamp language label on <pre>
  dom.previewPane.querySelectorAll('pre code').forEach(block => {
    if (block.classList.contains('language-mermaid')) return; // handled below
    try { hljs.highlightElement(block); } catch (_) {}
    const lang = [...block.classList]
      .find(c => c.startsWith('language-'))
      ?.replace('language-', '') ?? 'code';
    block.closest('pre').dataset.lang = lang;
  });

  // Render Mermaid diagrams
  await renderMermaidBlocks();

  // Stamp each block with its source line so scroll sync can find it
  annotateRenderedBlocks(content);

  dom.previewPane.scrollTop = 0;
}

async function renderMermaidBlocks() {
  const blocks = dom.previewPane.querySelectorAll('pre code.language-mermaid');
  let idx = 0;
  for (const block of blocks) {
    const definition = block.textContent.trim();
    const pre = block.closest('pre');
    try {
      const id = 'mermaid-' + Date.now() + '-' + (idx++);
      const { svg } = await mermaid.render(id, definition);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = svg;
      pre.replaceWith(wrapper);
    } catch (err) {
      const errDiv = document.createElement('div');
      errDiv.className = 'mermaid-error';
      errDiv.textContent = 'Mermaid diagram error: ' + (err.message || err);
      pre.replaceWith(errDiv);
    }
  }
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}


/* ═══════════════════════════════════════════════════════════
   MARKDOWN SYNTAX HIGHLIGHTING (code editor overlay)
═══════════════════════════════════════════════════════════ */

// Highlight inline markdown patterns within a single already-HTML-escaped line.
function applyInlineSyntax(s) {
  // 1. Inline code — process first so backtick content is protected
  s = s.replace(/`([^`\n]+)`/g, (_, c) =>
    `<span class="sy-code-tick">\`</span><span class="sy-code">${c}</span><span class="sy-code-tick">\`</span>`
  );
  // 2. Links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (_, t, u) =>
    `<span class="sy-mark">[</span><span class="sy-link-text">${t}</span><span class="sy-mark">](</span><span class="sy-link-url">${u}</span><span class="sy-mark">)</span>`
  );
  // 3. Bold **text** or __text__
  s = s.replace(/(\*\*|__)([^*_\n]+?)\1/g, (_, m, t) =>
    `<span class="sy-mark">${m}</span><span class="sy-bold">${t}</span><span class="sy-mark">${m}</span>`
  );
  // 4. Italic *text* (not **)
  s = s.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, (_, t) =>
    `<span class="sy-mark">*</span><span class="sy-italic">${t}</span><span class="sy-mark">*</span>`
  );
  return s;
}

// Convert raw markdown source into syntax-coloured HTML for the overlay.
function applyMarkdownSyntax(text) {
  const lines = text.split('\n');
  let inFence = false;
  const out = [];

  for (const line of lines) {
    // HTML-escape the line first so angle brackets etc. are safe
    let s = line
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // ── Fenced code block toggle (``` or ~~~) ──
    if (/^(`{3,}|~{3,})/.test(s)) {
      inFence = !inFence;
      out.push(`<span class="sy-fence">${s}</span>`);
      continue;
    }
    if (inFence) {
      out.push(`<span class="sy-fence-body">${s}</span>`);
      continue;
    }

    // ── Headings ──
    const hm = s.match(/^(#{1,6})([ \t].+)?$/);
    if (hm) {
      const cls = `sy-h${hm[1].length}`;
      const body = hm[2] ? applyInlineSyntax(hm[2]) : '';
      out.push(`<span class="${cls}"><span class="sy-hmark">${hm[1]}</span>${body}</span>`);
      continue;
    }

    // ── Horizontal rule ──
    if (/^([-*_][ \t]*){3,}$/.test(s.trim())) {
      out.push(`<span class="sy-hr">${s}</span>`);
      continue;
    }

    // ── Blockquote ──
    if (s.startsWith('&gt;')) {
      // &gt; is 4 chars; keep it coloured, apply inline to the rest
      out.push(`<span class="sy-bq">&gt;</span>${applyInlineSyntax(s.slice(4))}`);
      continue;
    }

    // ── List items (- * + and 1. 2.) ──
    const lm = s.match(/^(\s*)([-*+]|\d+[.)]) (.*)/);
    if (lm) {
      out.push(`${lm[1]}<span class="sy-list">${lm[2]}</span> ${applyInlineSyntax(lm[3])}`);
      continue;
    }

    // ── Plain text / paragraph ──
    out.push(applyInlineSyntax(s));
  }

  return out.join('\n');
}

function syncHighlightScroll() {
  dom.codeHighlight.scrollTop  = dom.codeEditor.scrollTop;
  dom.codeHighlight.scrollLeft = dom.codeEditor.scrollLeft;
}

function updateCodeHighlight() {
  dom.codeHighlight.innerHTML = applyMarkdownSyntax(dom.codeEditor.value);
  syncHighlightScroll();
}


/* ═══════════════════════════════════════════════════════════
   SCROLL SYNC & LINE ANNOTATION
═══════════════════════════════════════════════════════════ */

// Stamp each top-level rendered block with its source line number.
// Uses marked's own lexer so the token order is guaranteed to match
// the rendered element order.
function annotateRenderedBlocks(source) {
  let tokens;
  try { tokens = marked.lexer(source); } catch (_) { return; }

  const lineNums = [];
  let line = 1;
  for (const token of tokens) {
    const newlines = (token.raw.match(/\n/g) || []).length;
    // 'space' and 'def' tokens don't produce a rendered element
    if (token.type !== 'space' && token.type !== 'def') {
      lineNums.push(line);
    }
    line += newlines;
  }

  // Direct children of previewPane (skip the empty-state placeholder)
  const blocks = [...dom.previewPane.children].filter(el => el.id !== 'preview-empty');
  blocks.forEach((el, i) => {
    if (lineNums[i] !== undefined) el.dataset.sourceLine = lineNums[i];
  });
}

// Returns the source line that is at (or just above) the top of the rendered pane.
function getRenderedScrollLine() {
  const pane = dom.previewPane;
  const paneTop = pane.getBoundingClientRect().top;
  const blocks = pane.querySelectorAll('[data-source-line]');
  let best = 1;
  for (const block of blocks) {
    const relTop = block.getBoundingClientRect().top - paneTop;
    if (relTop <= 24) {          // 24 px tolerance (header + padding)
      best = parseInt(block.dataset.sourceLine, 10);
    } else {
      break;
    }
  }
  return best;
}

// Returns the source line visible at the top of the code editor.
function getCodeScrollLine() {
  const lh = parseFloat(getComputedStyle(dom.codeEditor).lineHeight);
  const pt = parseFloat(getComputedStyle(dom.codeEditor).paddingTop);
  return Math.max(1, Math.floor((dom.codeEditor.scrollTop - pt) / lh) + 1);
}

// Scrolls the code editor so that `lineNum` is near the top.
function scrollCodeToLine(lineNum) {
  const lh = parseFloat(getComputedStyle(dom.codeEditor).lineHeight);
  const pt = parseFloat(getComputedStyle(dom.codeEditor).paddingTop);
  dom.codeEditor.scrollTop = pt + (lineNum - 1) * lh;
}

// Scrolls the rendered pane to bring the block closest to `lineNum` into view.
function scrollPreviewToLine(lineNum) {
  const pane = dom.previewPane;
  const blocks = [...pane.querySelectorAll('[data-source-line]')];
  if (!blocks.length) return;

  // Find the last block whose source line is ≤ lineNum
  let target = blocks[0];
  for (const block of blocks) {
    if (parseInt(block.dataset.sourceLine, 10) <= lineNum) target = block;
    else break;
  }

  const paneRect  = pane.getBoundingClientRect();
  const blockTop  = target.getBoundingClientRect().top - paneRect.top + pane.scrollTop;
  pane.scrollTop  = Math.max(0, blockTop - 20);
}

/* ───────────────────────────────────────────────────────────
   LINE NUMBERS
─────────────────────────────────────────────────────────── */
function updateLineNumbers() {
  const content   = dom.codeEditor.value;
  const lineCount = content ? content.split('\n').length : 1;

  // Highlight the line the cursor is on
  const cursorLine = content
    ? content.substring(0, dom.codeEditor.selectionStart).split('\n').length
    : 1;

  // Only rebuild DOM when line count changes (avoids jitter while typing)
  if (dom.lineNumbers._count !== lineCount) {
    let html = '';
    for (let i = 1; i <= lineCount; i++) html += `<span>${i}</span>`;
    dom.lineNumbers.innerHTML = html;
    dom.lineNumbers._count = lineCount;
  }

  // Update current-line highlight
  const spans = dom.lineNumbers.children;
  if (dom.lineNumbers._activeLine !== cursorLine) {
    if (dom.lineNumbers._activeLine) {
      const prev = spans[dom.lineNumbers._activeLine - 1];
      if (prev) prev.classList.remove('current-line');
    }
    const curr = spans[cursorLine - 1];
    if (curr) curr.classList.add('current-line');
    dom.lineNumbers._activeLine = cursorLine;
  }

  // Keep gutter scroll in sync with the editor
  dom.lineNumbers.scrollTop = dom.codeEditor.scrollTop;
}


/* ═══════════════════════════════════════════════════════════
   VIEW TOGGLE
═══════════════════════════════════════════════════════════ */
function setView(view, save = true) {
  if (view === state.currentView && state.currentFileHandle) {
    // Same view — just ensure line numbers are up to date
    if (view === 'code') updateLineNumbers();
    return;
  }

  // Capture scroll position from the CURRENTLY VISIBLE pane before switching
  const syncLine = state.currentFileHandle
    ? (state.currentView === 'rendered' ? getRenderedScrollLine() : getCodeScrollLine())
    : 1;

  state.currentView = view;
  const isRendered = view === 'rendered';

  dom.previewPane.classList.toggle('hidden', !isRendered);
  dom.codePane.classList.toggle('hidden',    isRendered);
  dom.btnViewRendered.classList.toggle('active',  isRendered);
  dom.btnViewCode.classList.toggle('active',     !isRendered);

  if (state.currentFileHandle) {
    if (isRendered) {
      // Re-render from textarea so unsaved edits appear live; scroll after mermaid settles
      renderMarkdown(dom.codeEditor.value).then(() => scrollPreviewToLine(syncLine));
    } else {
      updateLineNumbers();
      requestAnimationFrame(() => scrollCodeToLine(syncLine));
    }
  }

  if (save) savePreferences();
}


/* ═══════════════════════════════════════════════════════════
   EDITOR & SAVE
═══════════════════════════════════════════════════════════ */
function onEditorInput() {
  if (!state.currentFileHandle) return;
  if (!state.isDirty) {
    state.isDirty = true;
    dom.dirtyIndicator.classList.remove('hidden');
    dom.btnSave.classList.remove('hidden');
  }
  updateLineNumbers();
  updateCodeHighlight();
}

async function saveFile() {
  if (!state.currentFileHandle) return;
  if (!state.isDirty) {
    showToast('No unsaved changes', 'info', 2000);
    return;
  }

  const content = dom.codeEditor.value;

  try {
    // createWritable() triggers the browser write-permission prompt if needed
    const writable = await state.currentFileHandle.createWritable();
    await writable.write(content);
    await writable.close();

    state.isDirty = false;
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');

    if (state.currentView === 'rendered') {
      await renderMarkdown(content);
    }

    showToast('File saved', 'success');

  } catch (err) {
    if (err.name === 'AbortError') {
      showToast('Save cancelled — write permission was denied', 'warning');
      return;
    }
    showToast('Save failed: ' + err.message, 'error');
  }
}

async function confirmIfDirty() {
  if (!state.isDirty) return false;
  const ok = window.confirm('You have unsaved changes. Continue without saving?');
  return !ok; // return true = cancel navigation
}


/* ═══════════════════════════════════════════════════════════
   PANEL UI — COLLAPSE, FULLSCREEN, RESIZE
═══════════════════════════════════════════════════════════ */
function setPanelWidth(outerW, innerW) {
  dom.panelLeft.style.width = outerW + 'px';
  dom.panelLeft.querySelector('.panel-left-inner').style.width = innerW + 'px';
}

function togglePanel() {
  state.isPanelCollapsed = !state.isPanelCollapsed;
  dom.panelLeft.classList.toggle('collapsed', state.isPanelCollapsed);
  // Must set inline width — inline styles beat class rules, so the class alone won't shrink
  // a panel that already has an inline width set by applyPreferences() or the resize handler.
  setPanelWidth(state.isPanelCollapsed ? 0 : state.panelWidth, state.panelWidth);
  savePreferences();
}

function toggleFullscreen() {
  state.isFullscreen = !state.isFullscreen;
  dom.panelRight.classList.toggle('fullscreen', state.isFullscreen);

  // Swap icon between expand and compress
  const expand = `<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>`;
  const compress = `<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="10" y1="14" x2="3" y2="21"/><line x1="21" y1="3" x2="14" y2="10"/>`;

  dom.iconFullscreen.innerHTML = state.isFullscreen ? compress : expand;
  dom.btnFullscreen.title = state.isFullscreen
    ? 'Exit fullscreen (Esc)'
    : 'Toggle fullscreen (F11)';
}

function initResizeHandle() {
  const handle = dom.resizeHandle;
  let startX, startWidth;

  handle.addEventListener('mousedown', e => {
    if (state.isPanelCollapsed) return;
    state.isResizing = true;
    startX = e.clientX;
    startWidth = dom.panelLeft.offsetWidth;
    handle.classList.add('dragging');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', e => {
    if (!state.isResizing) return;
    const MIN = 180, MAX = 500;
    const newW = Math.min(MAX, Math.max(MIN, startWidth + (e.clientX - startX)));
    state.panelWidth = newW;
    setPanelWidth(newW, newW);
  });

  document.addEventListener('mouseup', () => {
    if (!state.isResizing) return;
    state.isResizing = false;
    handle.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    savePreferences();
  });
}


/* ═══════════════════════════════════════════════════════════
   SEARCH
═══════════════════════════════════════════════════════════ */
let _searchTimer = null;

function onSearchInput() {
  const q = dom.searchInput.value.trim();
  dom.btnSearchClear.classList.toggle('hidden', q.length === 0);

  clearTimeout(_searchTimer);

  if (!q) {
    exitSearch();
    return;
  }

  // Show "Searching…" immediately so the user gets instant feedback
  dom.fileList.classList.add('hidden');
  dom.fileListEmpty.classList.add('hidden');
  dom.searchResults.classList.remove('hidden');
  dom.searchStatus.textContent = 'Searching…';
  dom.searchStatus.className = 'search-status searching';
  // Clear stale result cards
  [...dom.searchResults.children]
    .filter(el => el !== dom.searchStatus)
    .forEach(el => el.remove());

  _searchTimer = setTimeout(() => performSearch(q), 280);
}

async function performSearch(query) {
  if (!state.rootDirHandle) return;

  const gen = ++state.searchGenId;
  state.searchActive = true;
  state.searchQuery = query;

  const results = await _searchDir(query.toLowerCase(), state.rootDirHandle, '', gen);
  if (state.searchGenId !== gen) return; // a newer search superseded this one

  // Remove stale cards before rendering new ones
  [...dom.searchResults.children]
    .filter(el => el !== dom.searchStatus)
    .forEach(el => el.remove());

  if (results.length === 0) {
    dom.searchStatus.textContent = `No results for "${query}"`;
    dom.searchStatus.className = 'search-status no-results';
    return;
  }

  dom.searchStatus.textContent =
    `${results.length} file${results.length !== 1 ? 's' : ''} matched`;
  dom.searchStatus.className = 'search-status has-results';

  const frag = document.createDocumentFragment();
  results.forEach((result, idx) => {
    result.idx = idx;
    frag.appendChild(_createSearchCard(result, query));
  });
  dom.searchResults.appendChild(frag);
}

async function _searchDir(q, dirHandle, pathPrefix, gen) {
  const results = [];
  try {
    for await (const [name, handle] of dirHandle.entries()) {
      if (state.searchGenId !== gen) return results; // cancelled
      if (name.startsWith('.')) continue;

      if (handle.kind === 'directory') {
        const sub = await _searchDir(
          q, handle,
          pathPrefix ? `${pathPrefix}/${name}` : name,
          gen
        );
        results.push(...sub);
      } else if (_isMdFile(name)) {
        try {
          const file    = await handle.getFile();
          const content = await file.text();
          const snippets = _extractSnippets(content, q);
          if (snippets.length > 0) {
            results.push({ handle, name, path: pathPrefix, snippets });
          }
        } catch (_) { /* skip unreadable files */ }
      }
    }
  } catch (_) {}
  return results;
}

function _isMdFile(name) {
  const n = name.toLowerCase();
  return n.endsWith('.md') || n.endsWith('.markdown');
}

function _extractSnippets(content, q) {
  const lines = content.split('\n');
  const snippets = [];
  for (let i = 0; i < lines.length && snippets.length < 3; i++) {
    const idx = lines[i].toLowerCase().indexOf(q);
    if (idx !== -1) {
      snippets.push({ line: i + 1, text: lines[i], matchStart: idx, matchEnd: idx + q.length });
    }
  }
  return snippets;
}

function _createSearchCard(result, query) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = 'search-card';
  card.setAttribute('role', 'listitem');
  card.dataset.idx = result.idx;

  // Header: icon + filename
  const header = document.createElement('div');
  header.className = 'search-card-header';

  const icon = document.createElement('span');
  icon.className = 'search-card-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = '📄';

  const nameEl = document.createElement('span');
  nameEl.className = 'search-card-name';
  nameEl.textContent = result.name;
  nameEl.title = result.name;

  header.append(icon, nameEl);
  card.appendChild(header);

  // Subfolder path (if nested)
  if (result.path) {
    const pathEl = document.createElement('div');
    pathEl.className = 'search-card-path';
    pathEl.textContent = result.path;
    card.appendChild(pathEl);
  }

  // Up to 2 context snippets
  result.snippets.slice(0, 2).forEach(snippet => {
    const s   = document.createElement('div');
    s.className = 'search-card-snippet';

    const raw         = snippet.text.trim();
    const lowerRaw    = raw.toLowerCase();
    const qIdx        = lowerRaw.indexOf(query.toLowerCase());

    if (qIdx === -1) {
      s.textContent = raw.slice(0, 80);
    } else {
      const before = raw.slice(0, qIdx);
      const match  = raw.slice(qIdx, qIdx + query.length);
      const after  = raw.slice(qIdx + query.length);
      const bTrim  = before.length > 40 ? '…' + before.slice(-40) : before;
      const aTrim  = after.length  > 40 ? after.slice(0, 40) + '…' : after;

      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = match;
      s.append(document.createTextNode(bTrim), mark, document.createTextNode(aTrim));
    }
    card.appendChild(s);
  });

  card.addEventListener('click', () => openFileFromSearch(result, query));
  return card;
}

async function openFileFromSearch(result, query) {
  if (await confirmIfDirty()) return;

  // Highlight active card and scroll it into view within the results panel
  dom.searchResults.querySelectorAll('.search-card').forEach(c => c.classList.remove('active'));
  const activeCard = dom.searchResults.querySelector(`[data-idx="${result.idx}"]`);
  if (activeCard) activeCard.classList.add('active');

  try {
    const file    = await result.handle.getFile();
    const content = await file.text();

    state.currentFileHandle = result.handle;
    state.isDirty = false;
    state.searchOpenResult = result; // remember where this file lives for exitSearch()

    dom.fileNameDisplay.textContent = result.name;
    dom.dirtyIndicator.classList.add('hidden');
    dom.btnSave.classList.add('hidden');
    dom.codeEditor.value = content;
    dom.lineNumbers._count = null;

    await renderMarkdown(content);
    setView('rendered');
    updateLineNumbers();
    updateCodeHighlight();

    // Highlight all keyword matches then start the match navigator
    _highlightMatches(query);
    initMatchNav(query);

  } catch (err) {
    showToast('Could not open file: ' + err.message, 'error');
  }
}

function _highlightMatches(query) {
  if (!query) return;
  const q = query.toLowerCase();

  // Walk every text node in the preview pane
  const walker = document.createTreeWalker(dom.previewPane, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const tag = node.parentElement?.tagName?.toLowerCase();
      // Skip content inside script/style/existing marks
      if (tag === 'script' || tag === 'style' || tag === 'mark') {
        return NodeFilter.FILTER_REJECT;
      }
      return node.textContent.toLowerCase().includes(q)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_SKIP;
    },
  });

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  textNodes.forEach(tn => {
    const text  = tn.textContent;
    const lower = text.toLowerCase();
    const frag  = document.createDocumentFragment();
    let i = 0;
    while (i < text.length) {
      const j = lower.indexOf(q, i);
      if (j === -1) { frag.appendChild(document.createTextNode(text.slice(i))); break; }
      if (j > i)      frag.appendChild(document.createTextNode(text.slice(i, j)));
      const mark = document.createElement('mark');
      mark.className = 'search-match';
      mark.textContent = text.slice(j, j + q.length);
      frag.appendChild(mark);
      i = j + q.length;
    }
    tn.parentNode.replaceChild(frag, tn);
  });

  // Scroll to first match in the preview pane
  const first = dom.previewPane.querySelector('mark.search-match');
  if (first) {
    requestAnimationFrame(() => first.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}

/* ── Match navigator ─────────────────────────────────────── */

function initMatchNav(query) {
  const marks = [...dom.previewPane.querySelectorAll('mark.search-match')];
  if (marks.length === 0) { closeMatchNav(); return; }

  state.matchNav.active = true;
  state.matchNav.marks  = marks;
  state.matchNav.index  = -1; // _goToMatch will set to 0

  dom.matchNavQuery.textContent = `"${query}"`;
  dom.matchNav.classList.remove('hidden');

  _goToMatch(0);
}

function _goToMatch(idx) {
  const { marks } = state.matchNav;
  if (!marks.length) return;

  // Remove current highlight from previous match
  marks.forEach(m => m.classList.remove('current'));

  // Wrap around
  idx = ((idx % marks.length) + marks.length) % marks.length;
  state.matchNav.index = idx;

  marks[idx].classList.add('current');
  dom.matchNavLabel.textContent = `${idx + 1} / ${marks.length}`;

  marks[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function matchNavNext() {
  if (!state.matchNav.active) return;
  _goToMatch(state.matchNav.index + 1);
}

function matchNavPrev() {
  if (!state.matchNav.active) return;
  _goToMatch(state.matchNav.index - 1);
}

function closeMatchNav() {
  state.matchNav.active = false;
  state.matchNav.marks.forEach(m => m.classList.remove('current'));
  state.matchNav.marks  = [];
  state.matchNav.index  = 0;
  dom.matchNav.classList.add('hidden');
}

/* ─────────────────────────────────────────────────────────── */

async function exitSearch() {
  state.searchActive = false;
  state.searchQuery  = '';
  state.searchGenId++;          // cancel any in-flight search

  dom.searchInput.value = '';
  dom.btnSearchClear.classList.add('hidden');
  dom.searchResults.classList.add('hidden');

  // Always unhide the file list first — loadDirectory populates it but
  // doesn't remove the .hidden class that search activation added.
  dom.fileList.classList.remove('hidden');

  // If a file was opened from search, navigate the directory panel to that
  // file's location so the left panel matches what's being previewed.
  const openedResult = state.searchOpenResult;
  state.searchOpenResult = null;

  if (openedResult && state.rootDirHandle) {
    await _navigateToDir(openedResult);
  } else {
    // No search result was opened — restore the existing directory view.
    // loadDirectory was already called when the folder was picked, so just
    // make sure the empty-state visibility is correct.
    if (dom.fileList.children.length === 0) {
      dom.fileListEmpty.classList.remove('hidden');
    }
  }

  // Strip search highlights from the rendered preview WITHOUT re-rendering
  // (re-rendering would reset scroll position to the top).
  _removeSearchHighlights();
}

// Remove <mark class="search-match"> wrappers in-place, preserving scroll position.
function _removeSearchHighlights() {
  closeMatchNav();
  dom.previewPane.querySelectorAll('mark.search-match').forEach(mark => {
    mark.replaceWith(document.createTextNode(mark.textContent));
  });
  // Merge any split text nodes left behind
  dom.previewPane.normalize();
}

// Traverse from rootDirHandle down through result.path segments,
// rebuild dirStack, then reload the directory listing and mark the file active.
async function _navigateToDir(result) {
  const segments = result.path ? result.path.split('/').filter(Boolean) : [];

  // Reset stack to root
  state.dirStack         = [{ handle: state.rootDirHandle, name: state.rootDirHandle.name }];
  state.currentDirHandle = state.rootDirHandle;
  let handle = state.rootDirHandle;

  for (const seg of segments) {
    try {
      const sub = await handle.getDirectoryHandle(seg);
      state.dirStack.push({ handle: sub, name: seg });
      state.currentDirHandle = sub;
      handle = sub;
    } catch (_) {
      break; // path segment not found — stop where we are
    }
  }

  await loadDirectory(handle);

  // Highlight the active file in the newly loaded list
  dom.fileList.querySelectorAll('.file-item').forEach(item => {
    const label = item.querySelector('.file-item-label');
    if (label?.textContent === result.name) item.classList.add('active');
  });
}


/* ═══════════════════════════════════════════════════════════
   BREADCRUMB
═══════════════════════════════════════════════════════════ */
function renderBreadcrumb() {
  dom.breadcrumb.innerHTML = '';

  state.dirStack.forEach(({ name }, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'breadcrumb-separator';
      sep.textContent = '/';
      sep.setAttribute('aria-hidden', 'true');
      dom.breadcrumb.appendChild(sep);
    }

    const seg = document.createElement('button');
    seg.className = 'breadcrumb-segment';
    seg.textContent = name;
    seg.title = name;
    seg.type = 'button';

    const isLast = index === state.dirStack.length - 1;
    if (isLast) {
      seg.classList.add('current');
      seg.setAttribute('aria-current', 'page');
    } else {
      seg.addEventListener('click', () => navigateToBreadcrumb(index));
    }

    dom.breadcrumb.appendChild(seg);
  });
}


/* ═══════════════════════════════════════════════════════════
   TOAST SYSTEM
═══════════════════════════════════════════════════════════ */
function showToast(message, type = 'info', duration = 3500) {
  const toast = document.createElement('div');
  toast.className = 'toast ' + type;
  toast.textContent = message;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');

  dom.toastContainer.appendChild(toast);

  // Force reflow before adding .show so the enter transition plays
  toast.getBoundingClientRect();
  toast.classList.add('show');

  const hide = () => {
    toast.classList.remove('show');
    toast.addEventListener('transitionend', () => toast.remove(), { once: true });
  };

  const timer = setTimeout(hide, duration);

  // Click to dismiss early
  toast.addEventListener('click', () => {
    clearTimeout(timer);
    hide();
  });
}


/* ═══════════════════════════════════════════════════════════
   LOCAL STORAGE PREFERENCES
═══════════════════════════════════════════════════════════ */
function savePreferences() {
  try {
    const prefs = {
      panelWidth:       state.panelWidth,
      currentView:      state.currentView,
      isPanelCollapsed: state.isPanelCollapsed,
    };
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  } catch (_) {}
}

function loadPreferences() {
  try {
    const raw = localStorage.getItem(PREF_KEY);
    if (!raw) return;
    const prefs = JSON.parse(raw);

    if (typeof prefs.panelWidth === 'number' && prefs.panelWidth >= 180 && prefs.panelWidth <= 500) {
      state.panelWidth = prefs.panelWidth;
    }
    if (prefs.currentView === 'rendered' || prefs.currentView === 'code') {
      state.currentView = prefs.currentView;
    }
    if (typeof prefs.isPanelCollapsed === 'boolean') {
      state.isPanelCollapsed = prefs.isPanelCollapsed;
    }
  } catch (_) {}
}

function applyPreferences() {
  // Apply panel width + collapse state together so inline style is always consistent
  dom.panelLeft.classList.toggle('collapsed', state.isPanelCollapsed);
  setPanelWidth(state.isPanelCollapsed ? 0 : state.panelWidth, state.panelWidth);

  // Apply view (but don't render — no file loaded yet)
  dom.btnViewRendered.classList.toggle('active', state.currentView === 'rendered');
  dom.btnViewCode.classList.toggle('active', state.currentView === 'code');
  dom.previewPane.classList.toggle('hidden', state.currentView !== 'rendered');
  dom.codePane.classList.toggle('hidden', state.currentView !== 'code');
}


/* ═══════════════════════════════════════════════════════════
   KEYBOARD SHORTCUTS
═══════════════════════════════════════════════════════════ */
function wireKeyboard() {
  document.addEventListener('keydown', e => {
    const meta = e.ctrlKey || e.metaKey;
    const appVisible = !dom.app.classList.contains('hidden');

    // Save: Ctrl/Cmd + S
    if (meta && e.key === 's') {
      e.preventDefault();
      saveFile();
      return;
    }

    // Undo pending delete: Ctrl/Cmd + Z
    if (meta && e.key === 'z' && _pendingDelete) {
      e.preventDefault();
      const undoBtn = dom.toastContainer.querySelector('.toast-undo-btn');
      if (undoBtn) undoBtn.click();
      return;
    }

    // Show shortcuts help: ? (when not typing in an input)
    if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
      if (!appVisible) return;
      openHelp();
      return;
    }

    // Focus search: Ctrl/Cmd + F
    if (meta && e.key === 'f') {
      e.preventDefault();
      if (!appVisible) return;
      // Expand panel if collapsed so the input is visible
      if (state.isPanelCollapsed) togglePanel();
      dom.searchInput.focus();
      dom.searchInput.select();
      return;
    }

    // Enter confirms the visible action modal (delete or move)
    if (e.key === 'Enter' && !e.shiftKey) {
      if (!dom.deleteModal.classList.contains('hidden')) {
        e.preventDefault();
        if (_pendingDelete) _startSoftDelete();
        return;
      }
      if (!dom.moveModal.classList.contains('hidden')) {
        e.preventDefault();
        if (_pendingMove) _startSoftMove();
        return;
      }
    }

    // Match navigation (only when nav bar is active and focus is not in the editor)
    if (state.matchNav.active && document.activeElement !== dom.codeEditor) {
      // Enter / Shift+Enter — next / prev match
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? matchNavPrev() : matchNavNext();
        return;
      }
      // Arrow keys — next / prev (only when search input is NOT focused, to keep typing free)
      if (document.activeElement !== dom.searchInput) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault(); matchNavNext(); return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault(); matchNavPrev(); return;
        }
      }
    }

    // Toggle panel: Ctrl/Cmd + B
    if (meta && e.key === 'b') {
      e.preventDefault();
      if (!appVisible) return;
      togglePanel();
      return;
    }

    // Fullscreen: F11
    if (e.key === 'F11') {
      e.preventDefault();
      if (!appVisible) return;
      toggleFullscreen();
      return;
    }

    // Escape: close shortcuts → close move modal → close delete modal → close match nav → exit search → exit fullscreen
    if (e.key === 'Escape') {
      if (!dom.shortcutsModal.classList.contains('hidden')) {
        closeHelp();
        return;
      }
      if (!dom.moveModal.classList.contains('hidden')) {
        _pendingMove = null;
        _closeMoveModal();
        return;
      }
      if (!dom.deleteModal.classList.contains('hidden')) {
        _pendingDelete = null;
        _closeDeleteModal();
        return;
      }
      if (state.matchNav.active && !state.searchActive) {
        closeMatchNav();
        return;
      }
      if (state.searchActive) {
        exitSearch();
        dom.searchInput.blur();
        return;
      }
      if (state.isFullscreen) {
        toggleFullscreen();
        return;
      }
    }
  });
}


/* ═══════════════════════════════════════════════════════════
   OS-AWARE KEYBOARD LABELS
═══════════════════════════════════════════════════════════ */
function _applyOsShortcutLabels() {
  const isMac = /Mac|iPhone|iPad/i.test(navigator.userAgent);
  // Update search bar placeholder
  dom.searchInput.placeholder = isMac ? 'Search files… (⌘F)' : 'Search files… (Ctrl+F)';
  // Replace every "Ctrl" <kbd> in the shortcuts modal with ⌘ on Mac
  dom.shortcutsModal.querySelectorAll('kbd').forEach(kbd => {
    if (kbd.textContent.trim() === 'Ctrl') kbd.textContent = isMac ? '⌘' : 'Ctrl';
  });
}


/* ═══════════════════════════════════════════════════════════
   EVENT WIRING
═══════════════════════════════════════════════════════════ */
function wireEvents() {
  dom.btnOpenFolder.addEventListener('click', openFolder);
  dom.btnOpenNew.addEventListener('click', openFolder);
  dom.btnTogglePanel.addEventListener('click', togglePanel);
  dom.btnUp.addEventListener('click', goUp);
  dom.btnNewFile.addEventListener('click', createNewFile);
  dom.btnNewFolder.addEventListener('click', createNewFolder);

  // Panel toolbar (folder name area) as drag-drop target — drops move item to parent directory
  dom.filePanelToolbar.addEventListener('dragover', e => {
    if (!_dragState || state.dirStack.length <= 1) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    dom.filePanelToolbar.classList.add('drag-over');
  });
  dom.filePanelToolbar.addEventListener('dragleave', e => {
    if (!dom.filePanelToolbar.contains(e.relatedTarget)) dom.filePanelToolbar.classList.remove('drag-over');
  });
  dom.filePanelToolbar.addEventListener('drop', e => {
    e.preventDefault();
    dom.filePanelToolbar.classList.remove('drag-over');
    if (!_dragState || state.dirStack.length <= 1) return;
    const parent = state.dirStack[state.dirStack.length - 2];
    const ds = _dragState;
    _dragState = null;
    requestMoveEntry(ds, parent.handle, parent.name);
  });
  dom.btnDuplicate.addEventListener('click', duplicateFile);
  dom.btnViewRendered.addEventListener('click', () => setView('rendered'));
  dom.btnViewCode.addEventListener('click', () => setView('code'));
  dom.btnSave.addEventListener('click', saveFile);
  dom.btnFullscreen.addEventListener('click', toggleFullscreen);

  // Double-click toolbar filename → rename
  dom.fileNameDisplay.addEventListener('dblclick', startToolbarRename);
  dom.codeEditor.addEventListener('input',   onEditorInput);
  dom.codeEditor.addEventListener('scroll',  () => {
    dom.lineNumbers.scrollTop = dom.codeEditor.scrollTop;
    syncHighlightScroll();
  });
  dom.codeEditor.addEventListener('click',   updateLineNumbers);
  dom.codeEditor.addEventListener('keyup',   updateLineNumbers);

  // Search
  dom.searchInput.addEventListener('input', onSearchInput);
  dom.btnSearchClear.addEventListener('click', () => {
    exitSearch();
    dom.searchInput.focus();
  });

  // Match navigator
  dom.btnMatchPrev.addEventListener('click', matchNavPrev);
  dom.btnMatchNext.addEventListener('click', matchNavNext);
  dom.btnMatchClose.addEventListener('click', closeMatchNav);

  // Move modal
  dom.btnMoveCancel.addEventListener('click', () => { _pendingMove = null; _closeMoveModal(); });
  dom.btnMoveConfirm.addEventListener('click', () => { if (_pendingMove) _startSoftMove(); });
  dom.moveModal.addEventListener('click', e => {
    if (e.target === dom.moveModal) { _pendingMove = null; _closeMoveModal(); }
  });

  // Help / shortcuts modal
  dom.btnHelp.addEventListener('click', openHelp);
  dom.btnShortcutsClose.addEventListener('click', closeHelp);
  dom.shortcutsModal.addEventListener('click', e => {
    if (e.target === dom.shortcutsModal) closeHelp();
  });

  // Delete modal
  dom.btnDeleteCancel.addEventListener('click', () => {
    _pendingDelete = null;
    _closeDeleteModal();
  });
  dom.btnDeleteConfirm.addEventListener('click', () => {
    if (_pendingDelete) _startSoftDelete();
  });
  // Click the backdrop to cancel
  dom.deleteModal.addEventListener('click', e => {
    if (e.target === dom.deleteModal) {
      _pendingDelete = null;
      _closeDeleteModal();
    }
  });
}
