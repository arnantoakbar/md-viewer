/* ═══════════════════════════════════════════════════════════
   INLINE RENDERED EDITOR — TEST SUITE

   Covers every editing path through the contenteditable preview
   pane: round-trip fidelity, inline/block format toggles, format
   composition, block escape, lists, code blocks, the slash menu,
   markdown shortcuts, paste, and split view.

   Run from the browser console with a file open:
       runEditorTests()
   Returns { passed, failed, total, failures }.
═══════════════════════════════════════════════════════════ */

async function runEditorTests() {
  const R = [];
  const ok   = (name, pass, detail = '') => R.push({ name, pass, detail });
  const sel  = () => window.getSelection();
  const md   = () => dom.codeEditor.value.trim();
  const html = () => dom.previewPane.innerHTML;

  // ── helpers ────────────────────────────────────────────────
  const load = async (source) => {
    dom.codeEditor.value = source;
    await renderMarkdown(source);
    setView('rendered');
    dom.previewPane.focus();
  };
  const selectAll = (q) => {
    const el = dom.previewPane.querySelector(q);
    if (!el) return null;
    const r = document.createRange(); r.selectNodeContents(el);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const caret = (q, offset) => {
    const el = dom.previewPane.querySelector(q);
    if (!el) return null;
    const node = el.firstChild || el;
    const r = document.createRange();
    r.setStart(node, Math.min(offset, node.nodeType === 3 ? node.textContent.length : node.childNodes.length));
    r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const caretEnd = (q) => {
    const el = dom.previewPane.querySelector(q);
    const node = el.lastChild || el;
    const r = document.createRange();
    r.setStart(node, node.nodeType === 3 ? node.textContent.length : node.childNodes.length);
    r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    return el;
  };
  const enter = (opts = {}) => {
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...opts });
    dom.previewPane.dispatchEvent(e);
    if (!e.defaultPrevented) document.execCommand('insertParagraph');
    _flushPreviewSync();
  };

  /* ── 1. ROUND-TRIP FIDELITY ──────────────────────────────
     Rendering markdown and converting the DOM back must be lossless. */
  const roundTrips = {
    'h1/h2/h3':        '# One\n\n## Two\n\n### Three\n',
    'bold':            'A **bold** word.\n',
    'italic':          'A *slanted* word.\n',
    'strikethrough':   'A ~~struck~~ word.\n',
    'inline code':     'Run `npm test` now.\n',
    'highlight':       'A ==marked== word.\n',
    'superscript':     'E = mc^2^ here.\n',
    'subscript':       'Water is H~2~O.\n',
    'blockquote':      '> A quoted line.\n',
    'bullet list':     '- alpha\n- beta\n',
    'numbered list':   '1. first\n2. second\n',
    'fenced code':     '```js\nconst a = 1;\nconst b = 2;\n```\n',
    'link':            'Read [the docs](https://example.com).\n',
    'image':           '![alt text](img.png)\n',
    'divider':         'Above\n\n---\n\nBelow\n',
    'table':           '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
    'nested emphasis': 'A **bold with *italic* inside** here.\n',
    'multi paragraph': 'One.\n\nTwo.\n\nThree.\n',
    'code in heading': '### Head `code` tail\n',
    'quote with bold': '> Quoted **bold** text.\n',
  };
  for (const [name, source] of Object.entries(roundTrips)) {
    await renderMarkdown(source);
    const back = domToMarkdown(dom.previewPane).trim();
    ok(`round-trip: ${name}`, back === source.trim(),
       back === source.trim() ? '' : `want ${JSON.stringify(source.trim())} got ${JSON.stringify(back)}`);
  }

  /* ── 2. INLINE FORMAT TOGGLE ON → OFF ────────────────────
     Every inline format must apply and then fully remove itself. */
  const inline = [
    ['bold',          '**plain words**'],
    ['italic',        '*plain words*'],
    ['strikethrough', '~~plain words~~'],
    ['code',          '`plain words`'],
    ['highlight',     '==plain words=='],
    ['sub',           '~plain words~'],
    ['sup',           '^plain words^'],
  ];
  for (const [fmt, expected] of inline) {
    await load('plain words\n');
    selectAll('p');
    applyFormat(fmt);
    const applied = md();
    // re-select the produced wrapper and toggle off
    const wrapper = dom.previewPane.querySelector('p > *');
    if (wrapper) selectAll('p > *');
    applyFormat(fmt);
    ok(`inline ${fmt}: apply`, applied === expected, `got ${JSON.stringify(applied)}`);
    ok(`inline ${fmt}: remove`, md() === 'plain words', `got ${JSON.stringify(md())}`);
  }

  /* ── 3. BLOCK FORMAT TOGGLE ON → OFF ─────────────────────*/
  const blocks = [['h1', '# text'], ['h2', '## text'], ['h3', '### text'], ['blockquote', '> text']];
  for (const [fmt, expected] of blocks) {
    await load('text\n');
    caret('p', 0);
    applyFormat(fmt);
    const applied = md();
    const el = dom.previewPane.querySelector(fmt === 'blockquote' ? 'blockquote' : fmt);
    if (el) selectAll(fmt === 'blockquote' ? 'blockquote' : fmt);
    applyFormat(fmt);
    ok(`block ${fmt}: apply`, applied === expected, `got ${JSON.stringify(applied)}`);
    ok(`block ${fmt}: remove`, md() === 'text', `got ${JSON.stringify(md())}`);
  }

  /* ── 4. FORMAT COMPOSITION ───────────────────────────────
     Applying a second format must not destroy the first. */
  await load('compose me\n');
  selectAll('p'); applyFormat('bold');
  selectAll('p > b, p > strong'); applyFormat('highlight');
  ok('compose: bold + highlight', md() === '**==compose me==**', `got ${JSON.stringify(md())}`);
  selectAll('mark'); applyFormat('highlight');
  ok('compose: remove highlight keeps bold', md() === '**compose me**', `got ${JSON.stringify(md())}`);

  await load('stack\n');
  selectAll('p');            applyFormat('bold');
  selectAll('p > b, p > strong'); applyFormat('sup');
  selectAll('sup');          applyFormat('highlight');
  ok('compose: bold + sup + highlight', md() === '**^==stack==^**', `got ${JSON.stringify(md())}`);

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('code');
  const act = _detectActiveFormats(sel().getRangeAt(0));
  ok('compose: code inside h3 keeps both', md() === '### `Heading text`', `got ${JSON.stringify(md())}`);
  ok('compose: toolbar reports code AND h3', act.has('code') && act.has('h3'), [...act].join(','));

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('sup');
  ok('compose: sup inside h3', md() === '### ^Heading text^', `got ${JSON.stringify(md())}`);

  await load('### Heading text\n');
  selectAll('h3'); applyFormat('sub');
  ok('compose: sub inside h3', md() === '### ~Heading text~', `got ${JSON.stringify(md())}`);

  /* ── 5. CODE BLOCK ───────────────────────────────────────*/
  await load('```js\nconst a = 1;\n```\n');
  selectAll('pre code'); applyFormat('fenced');
  ok('code block: toggles off', !dom.previewPane.querySelector('pre'), html());
  ok('code block: text survives unwrap', md().includes('const a = 1;'), md());

  await load('plain line\n');
  selectAll('p'); applyFormat('fenced');
  ok('code block: toggles on', !!dom.previewPane.querySelector('pre'), html());

  await load('```js\nline one\n```\n');
  ok('code block: is editable', dom.previewPane.querySelector('pre').isContentEditable);
  {
    const code = dom.previewPane.querySelector('pre code');
    const t = code.firstChild;
    const r = document.createRange(); r.setStart(t, 'line one'.length); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    document.execCommand('insertLineBreak');
    document.execCommand('insertText', false, 'line two');
    _flushPreviewSync();
    ok('code block: multi-line edit keeps newline', /line one\nline two/.test(dom.codeEditor.value), JSON.stringify(dom.codeEditor.value));
  }

  /* ── 6. ESCAPING QUOTES AND LISTS ────────────────────────*/
  await load('> Quoted line.\n');
  caretEnd('blockquote p, blockquote');
  enter();            // new empty line inside the quote
  enter();            // should now break out
  ok('escape: Enter twice leaves a quote',
     !_findInPreview(sel().anchorNode, 'blockquote'), html());

  await load('> Quoted line.\n');
  caret('blockquote p, blockquote', 3);
  enter({ ctrlKey: true });
  ok('escape: Ctrl+Enter leaves a quote mid-text',
     !_findInPreview(sel().anchorNode, 'blockquote'), html());

  await load('- one\n- two\n');
  {
    const li = dom.previewPane.querySelectorAll('li')[1];
    const r = document.createRange(); r.setStart(li.firstChild, 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    enter({ ctrlKey: true });
    ok('escape: Ctrl+Enter leaves a list mid-item',
       !_findInPreview(sel().anchorNode, 'ul'), html());
  }

  await load('- one\n- two\n');
  {
    const li = dom.previewPane.querySelectorAll('li')[1];
    const r = document.createRange(); r.setStart(li.firstChild, 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    enter();
    ok('list: Enter mid-item splits it', md() === '- one\n- t\n- wo', md());
  }

  /* ── 7. LIST CREATED BELOW EXISTING TEXT ─────────────────
     The paragraph above must not be swallowed into the list. */
  for (const [fmt, marker] of [['ul', '-'], ['ol', '1.']]) {
    await load('Normal text.\n');
    caretEnd('p');
    enter();                       // new empty block below
    applyFormat(fmt);
    _flushPreviewSync();
    ok(`list ${fmt}: below text keeps paragraph intact`,
       md().startsWith('Normal text.') && md().includes(marker), md());
    ok(`list ${fmt}: no <ul> nested inside <p>`,
       !/<p[^>]*>\s*<(ul|ol)/i.test(html()), html());
  }

  /* ── 8. SLASH MENU ───────────────────────────────────────*/
  const openSlash = async (query = '') => {
    await load('# Doc\n\nBody text.\n');
    const p = document.createElement('p');
    p.textContent = '/' + query;
    dom.previewPane.appendChild(p);
    const r = document.createRange();
    r.setStart(p.firstChild, query.length + 1); r.collapse(true);
    const s = sel(); s.removeAllRanges(); s.addRange(r);
    _updateSlashMenu();
  };
  await openSlash();
  ok('slash: opens with all commands',
     !dom.slashMenu.classList.contains('hidden') && dom.slashMenuList.querySelectorAll('.slash-item').length === 9);
  await openSlash('quo');
  ok('slash: filters to Quote',
     dom.slashMenuList.querySelectorAll('.slash-item').length === 1);
  await openSlash('zzzz');
  ok('slash: shows empty state',
     !dom.slashMenuEmpty.classList.contains('hidden'));

  const slashExpect = {
    h1: '#', h2: '##', h3: '###', ul: '-', ol: '1.',
    blockquote: '>', fenced: '```', hr: '---',
  };
  for (const [cmd, marker] of Object.entries(slashExpect)) {
    await openSlash();
    const items = _slashMatches('');
    _slashIndex = items.findIndex(c => c.fmt === cmd);
    _slashMenuKeydown({ key: 'Enter' });
    _flushPreviewSync();
    ok(`slash: ${cmd} inserts ${marker}`, md().includes(marker), md());
    ok(`slash: ${cmd} preserves the document above`,
       md().startsWith('# Doc') && md().includes('Body text.'), md());
  }
  await openSlash();
  _slashMenuKeydown({ key: 'Escape' });
  ok('slash: Escape dismisses', dom.slashMenu.classList.contains('hidden'));

  /* ── 9. MARKDOWN SHORTCUTS ───────────────────────────────*/
  for (const [marker, tag] of [['#','h1'], ['##','h2'], ['###','h3'], ['>','blockquote'], ['-','ul'], ['1.','ol']]) {
    dom.previewPane.innerHTML = `<p>${marker}</p>`;
    caret('p', marker.length);
    const consumed = _tryMarkdownShortcut();
    ok(`shortcut: "${marker} " → ${tag}`,
       consumed && dom.previewPane.firstElementChild.tagName.toLowerCase() === tag,
       dom.previewPane.innerHTML);
  }
  dom.previewPane.innerHTML = '<p>text #</p>';
  caret('p', 6);
  ok('shortcut: marker mid-sentence is ignored', !_tryMarkdownShortcut());

  /* ── 10. PASTE ───────────────────────────────────────────*/
  await load('start\n');
  caretEnd('p');
  {
    const dt = new DataTransfer();
    dt.setData('text/plain', ' PLAIN');
    dt.setData('text/html', '<b style="color:red" class="x">RICH</b>');
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    dom.previewPane.dispatchEvent(e);
    ok('paste: inserts plain text', dom.previewPane.textContent.includes('PLAIN'));
    ok('paste: strips inline styles', !/style=/i.test(html()), html());
  }

  /* ── 11. TYPING STABILITY ────────────────────────────────*/
  dom.previewPane.innerHTML = '<p>hello world</p>';
  caret('p', 5);
  document.execCommand('insertParagraph');
  ok('typing: Enter splits into two paragraphs',
     dom.previewPane.querySelectorAll('p').length === 2, html());

  await load('one\n');
  dom.previewPane.innerHTML = '<p>one</p><div>two</div><p>three</p>';
  ok('typing: contenteditable <div> becomes a paragraph break',
     domToMarkdown(dom.previewPane).trim() === 'one\n\ntwo\n\nthree',
     JSON.stringify(domToMarkdown(dom.previewPane)));

  /* ── 12. SPLIT VIEW ──────────────────────────────────────*/
  await load('# Title\n\nBody.\n');
  setView('split');
  await new Promise(r => setTimeout(r, 150));
  {
    const pw = dom.previewPane.getBoundingClientRect().width;
    const cw = dom.codePane.getBoundingClientRect().width;
    ok('split: panes are even', Math.abs(pw - cw) <= 8, `${Math.round(pw)}/${Math.round(cw)}`);
    ok('split: prose gutter stays sane',
       parseFloat(getComputedStyle(dom.previewPane).paddingLeft) < 40,
       getComputedStyle(dom.previewPane).paddingLeft);

    dom.previewPane.querySelector('p').textContent = 'Edited live';
    _flushPreviewSync();
    ok('split: edits reach the code pane', dom.codeEditor.value.includes('Edited live'));

    // A double-click must not steal focus, or the format toolbar vanishes.
    // Focus the pane first: a synthetic MouseEvent does not move focus itself.
    dom.previewPane.focus();
    selectAll('p');
    dom.previewPane.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 200, clientY: 200 }));
    ok('split: dblclick keeps focus in the preview',
       document.activeElement !== dom.codeEditor, document.activeElement?.id || '');
    ok('split: dblclick keeps the selection alive',
       !!window.getSelection().toString(), 'selection lost');
  }
  setView('rendered');

  /* ── 13. TOOLBAR STATE DETECTION ─────────────────────────*/
  await load('A **bold** word.\n');
  selectAll('strong, b');
  ok('toolbar: detects bold', _detectActiveFormats(sel().getRangeAt(0)).has('bold'));
  await load('> Quoted.\n');
  selectAll('blockquote p, blockquote');
  {
    const a = _detectActiveFormats(sel().getRangeAt(0));
    ok('toolbar: detects blockquote', a.has('blockquote'));
    ok('toolbar: quote is NOT reported italic (styling only)', !a.has('italic'), [...a].join(','));
  }

  const failures = R.filter(r => !r.pass);
  return {
    passed: R.length - failures.length,
    failed: failures.length,
    total: R.length,
    failures,
  };
}

if (typeof window !== 'undefined') window.runEditorTests = runEditorTests;
