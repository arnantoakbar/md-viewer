# MD Viewer

A fully client-side Markdown file viewer and editor. Browse your local folders, preview rendered Markdown in real time, edit files, and save changes — all inside the browser with no uploads, no server, and no dependencies to install.

## Live Demo

🌐 **Try it now**: https://flavida.co/md-viewer

![MD Viewer Landing Page](https://github.com/user-attachments/assets/03678d7c-2180-4c13-81e0-e54483900ec9)

![MD Viewer Interface](https://github.com/user-attachments/assets/772d1a9a-c75a-4a6e-814a-b5bba8d62b0d)

![MD Viewer File Browser](https://github.com/user-attachments/assets/d66ad5ab-16e1-4e4c-aa59-d4fbc3582261)

![MD Viewer Preview](https://github.com/user-attachments/assets/508993bd-a4ad-4e2e-8269-6004a6dca75d)

---

## Features

- **Folder browser** — Pick any local folder and navigate its contents like a file manager. Only Markdown files (`.md`, `.markdown`) and sub-folders are shown, so the tree stays clean.
- **Real-time preview** — Selecting a file instantly renders it as formatted HTML with syntax-highlighted code blocks.
- **Code / Rendered toggle** — Switch between the rendered view and the raw Markdown source at any time. Edits in the source view are reflected immediately when you switch back to rendered.
- **Edit & save** — The Save button appears only when unsaved changes are detected. Press `Ctrl+S` / `⌘S` or click Save to write back to disk.
- **Collapsible sidebar** — Hide the file browser to focus on reading or writing. Toggle with the panel button or `Ctrl+B` / `⌘B`.
- **Fullscreen preview** — Expand the preview to fill the entire window with `F11`. Press `Esc` to exit.
- **Resizable panel** — Drag the divider between the sidebar and the preview to adjust the split.
- **Preferences remembered** — Panel width, view mode (rendered/code), and collapsed state are saved to `localStorage` and restored on the next visit.
- **Privacy-first** — Nothing leaves your machine. No analytics, no telemetry, no cloud storage.

---

## Browser Support

Requires the [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API), available in:

| Browser | Minimum version |
|---------|----------------|
| Chrome  | 86+            |
| Edge    | 86+            |
| Opera   | 72+            |
| Safari  | 15.2+          |

Firefox does not support this API as of mid-2025.

---

## Getting Started

### Option 1 — Open directly (simplest)

1. Clone or download this repository.
2. Open `index.html` in Chrome or Edge.
3. Click **Open a Folder** and select a folder that contains `.md` files.

> The browser will show a permission dialog before it reads your files. No data leaves your device.

### Option 2 — Local development server (recommended for Safari)

If you need Safari compatibility or your browser restricts the File System Access API on `file://` URLs, serve the folder over HTTP:

```bash
# Python (built-in, no install needed)
python3 -m http.server 8080 --directory /path/to/md-viewer

# Node.js (if you have npx available)
npx serve /path/to/md-viewer
```

Then open `http://localhost:8080` in your browser.

---

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` / `⌘S` | Save the current file |
| `Ctrl+B` / `⌘B` | Toggle the file browser sidebar |
| `F11` | Toggle fullscreen preview |
| `Esc` | Exit fullscreen |

---

## File Structure

```
md-viewer/
├── index.html      — App shell and landing screen
├── style.css       — All styles (Flavida design tokens + layout + Markdown typography)
├── app.js          — All JavaScript (file system, navigation, preview, editor, UI state)
└── .claude/
    └── launch.json — Dev server config for Claude Code preview
```

No build step, no `package.json`, no bundler. Everything runs directly in the browser.

---

## Dependencies (CDN, no install)

All loaded from cdnjs — no local copies needed:

| Library | Version | Purpose |
|---------|---------|---------|
| [marked](https://marked.js.org) | 9.1.6 | Markdown → HTML parsing |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.0.8 | Sanitize rendered HTML |
| [highlight.js](https://highlightjs.org) | 11.9.0 | Syntax highlighting in code blocks |
| [Google Fonts](https://fonts.google.com) | — | Bricolage Grotesque + DM Sans |

The app will work offline if your browser has cached these resources from a previous visit. For fully offline use, download the libraries and reference them locally in `index.html`.

---

## How It Works

### File access and permissions

When you click **Open a Folder**, the browser shows a native permission dialog for read and write access to the selected folder. This is handled entirely by the browser's [File System Access API](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) — no code on this page can access your files without that explicit grant.

Permissions are session-scoped. The next time you open the app, you'll be asked to pick a folder again. No file paths or handles are stored between sessions.

### Navigation model

The sidebar works like macOS Finder or Windows Explorer in list view:

- Click a **folder** to navigate into it.
- Click the **↑ Up** button or a breadcrumb segment to go back to a parent directory.
- Only `.md` / `.markdown` files and folders are listed — other file types are hidden.

### Saving files

The Save button only appears after you make a change in the Code view. When you save:

1. The browser may prompt for write permission if it hasn't been granted yet this session.
2. The file is written in place using `FileSystemFileHandle.createWritable()`.
3. The rendered preview updates immediately to reflect the saved content.

### localStorage

The following preferences are stored locally and never sent anywhere:

| Key | Value |
|-----|-------|
| `mdviewer-prefs.panelWidth` | Sidebar width in pixels |
| `mdviewer-prefs.currentView` | `rendered` or `code` |
| `mdviewer-prefs.isPanelCollapsed` | `true` or `false` |

To reset preferences, run `localStorage.removeItem('mdviewer-prefs')` in the browser console.

---

## Customisation

### Changing the panel default width

Edit the `--panel-w` variable in `style.css`:

```css
:root {
  --panel-w: 280px; /* change this */
}
```

### Changing the colour scheme

All colours are Flavida design tokens defined at the top of `style.css` under `:root`. The primary accent colour is `--color-flame: #E8391D`.

### Adding support for other file types

In `app.js`, the file filter is in `loadDirectory()`:

```js
} else if (name.toLowerCase().endsWith('.md') || name.toLowerCase().endsWith('.markdown')) {
```

Add more extensions here (e.g. `|| name.toLowerCase().endsWith('.txt')`) to include them in the browser.

---

## Contributing

This is a static, dependency-free project — contributions should keep it that way. No build tools, no frameworks, no npm packages.

1. Fork the repository.
2. Make your changes to `index.html`, `style.css`, or `app.js`.
3. Test by opening `index.html` in Chrome or running a local server.
4. Open a pull request with a clear description of what changed and why.

---

## Licence

MIT — see [LICENSE](LICENSE) for details.
