let editor = null;
let commentDecorations = [];
let removedDecorations = [];
const lineQueue = [];
let processingQueue = false;
let animationGeneration = 0;

// Sidebar state
let sidebarRootPath = null;
let activeRelPath = null;
const sessionTabs = [];

// TTS state
let currentFile = null;
let audioEnabled = false;
let summaryTimer = null;
let selectedVoice = null;

function loadVoices() {
  const voices = speechSynthesis.getVoices();
  const select = document.getElementById('voice-select');
  if (select.dataset.ready) return;
  select.innerHTML = '';

  const defaultOpt = document.createElement('option');
  defaultOpt.value = '-1';
  defaultOpt.textContent = 'Browser Default';
  select.appendChild(defaultOpt);

  voices.forEach((v, i) => {
    const opt = document.createElement('option');
    opt.value = i;
    opt.textContent = v.name.replace('Microsoft ', '').replace(' Desktop', '').replace(' Online (Natural)', '');
    select.appendChild(opt);
  });

  selectedVoice = null;
  select.dataset.ready = '1';
  select.addEventListener('change', () => {
    const idx = parseInt(select.value);
    selectedVoice = idx === -1 ? null : voices[idx];
  });
}

if (speechSynthesis.onvoiceschanged !== undefined) {
  speechSynthesis.onvoiceschanged = loadVoices;
}
loadVoices();

function getCommentText(line) {
  return line.trim()
    .replace(/^\/\/\s*/, '')
    .replace(/^#\s*/, '')
    .replace(/^<!--\s*/, '')
    .replace(/\s*-->$/, '')
    .trim();
}

function speakAndWait(text) {
  return new Promise(resolve => {
    if (!audioEnabled || !window.speechSynthesis || !text) return resolve();
    const utt = new SpeechSynthesisUtterance(text);
    utt.rate = 0.92;
    if (selectedVoice) utt.voice = selectedVoice;
    utt.onend = resolve;
    utt.onerror = resolve;
    speechSynthesis.speak(utt);
  });
}

function speak(text) {
  speakAndWait(text);
}

async function requestFileSummary(file) {
  try {
    const res = await fetch('/summary', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file })
    });
    const { text } = await res.json();
    if (text) speak(text);
  } catch (e) {}
}

function cancelAnimation() {
  animationGeneration++;
  lineQueue.length = 0;
  processingQueue = false;
  if (summaryTimer) { clearTimeout(summaryTimer); summaryTimer = null; }
}

function scheduleSummary(file) {
  if (summaryTimer) clearTimeout(summaryTimer);
  summaryTimer = setTimeout(() => {
    summaryTimer = null;
    requestFileSummary(file);
  }, 4000);
}

require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.44.0/min/vs' } });
document.getElementById('audio-btn').addEventListener('click', () => {
  audioEnabled = !audioEnabled;
  const btn = document.getElementById('audio-btn');
  btn.textContent = audioEnabled ? '🔊' : '🔇';
  btn.classList.toggle('enabled', audioEnabled);
  if (audioEnabled) {
    // warm up speech synthesis with a silent utterance to satisfy the user gesture requirement
    const warm = new SpeechSynthesisUtterance('');
    speechSynthesis.speak(warm);
  } else {
    speechSynthesis.cancel();
  }
});

require(['vs/editor/editor.main'], () => {
  editor = monaco.editor.create(document.getElementById('editor-container'), {
    value: '',
    language: 'plaintext',
    theme: 'vs-dark',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 14,
    fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
    lineNumbers: 'on',
    readOnly: true,
    smoothScrolling: true,
    padding: { top: 12 }
  });
  connectEvents();
});

// ── Language detection ──────────────────────────────────────────────────────

function getLanguage(filename) {
  const ext = (filename || '').split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
    py: 'python', html: 'html', css: 'css', json: 'json', md: 'markdown',
    sh: 'shell', sql: 'sql', java: 'java', cpp: 'cpp', c: 'c',
    cs: 'csharp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php'
  };
  return map[ext] || 'plaintext';
}

function getFileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    js: ['◇', '#f7df1e'], ts: ['◇', '#3178c6'], jsx: ['◇', '#61dafb'], tsx: ['◇', '#61dafb'],
    py: ['◆', '#3572a5'], html: ['◈', '#e34c26'], css: ['◈', '#563d7c'],
    json: ['{}', '#cb4b16'], md: ['✦', '#888'], sh: ['$', '#89e051'],
    cs: ['◇', '#178600'], go: ['◇', '#00add8'], rs: ['◇', '#dea584'],
    java: ['◇', '#b07219'], cpp: ['◇', '#f34b7d'], c: ['◇', '#aaa']
  };
  const [icon, color] = icons[ext] || ['·', '#6e6e6e'];
  return `<span style="color:${color}">${icon}</span>`;
}

// ── Status & UI helpers ─────────────────────────────────────────────────────

function setStatus(text, mode = 'idle') {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('status-dot');
  dot.className = mode === 'live' ? 'live' : mode === 'writing' ? 'writing' : '';
}

function addFeedItem(filename, type) {
  const feed = document.getElementById('feed');
  feed.querySelectorAll('.feed-item').forEach(el => el.classList.remove('active'));
  const item = document.createElement('div');
  item.className = 'feed-item active';
  item.innerHTML = `
    <div class="feed-name">${filename}</div>
    <div class="feed-meta">
      <span class="feed-type ${type}">${type}</span>
      <span>${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
    </div>`;
  feed.prepend(item);
}

function fadeInEditor() {
  const el = document.getElementById('editor-container');
  el.classList.remove('fade-in');
  void el.offsetWidth;
  el.classList.add('fade-in');
}

async function smoothScrollToLine(lineNumber) {
  if (!editor) return;
  const lineTop = editor.getTopForLineNumber(lineNumber);
  const height = editor.getLayoutInfo().height;
  const target = Math.max(0, lineTop - height / 2);
  const from = editor.getScrollTop();
  if (Math.abs(target - from) < 5) return;
  const duration = 620;
  const t0 = performance.now();
  await new Promise(resolve => {
    function step(now) {
      const p = Math.min((now - t0) / duration, 1);
      const eased = p < 0.5 ? 2 * p * p : -1 + (4 - 2 * p) * p;
      editor.setScrollTop(from + (target - from) * eased);
      if (p < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}

// ── Tabs ────────────────────────────────────────────────────────────────────

function addTab(filename) {
  const bar = document.getElementById('tabs-bar');
  let existing = bar.querySelector(`.tab[data-file="${CSS.escape(filename)}"]`);
  if (existing) { setActiveTab(filename); return; }

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.file = filename;
  tab.textContent = filename;
  bar.appendChild(tab);
  requestAnimationFrame(() => tab.classList.add('tab-visible'));
  setActiveTab(filename);
}

function setActiveTab(filename) {
  document.querySelectorAll('#tabs-bar .tab').forEach(t => {
    t.classList.toggle('active', t.dataset.file === filename);
  });
  // Scroll active tab into view
  const active = document.querySelector(`#tabs-bar .tab[data-file="${CSS.escape(filename)}"]`);
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// ── File tree ───────────────────────────────────────────────────────────────

function buildTreeUL(nodes, depth, touched) {
  const ul = document.createElement('ul');
  ul.className = depth === 0 ? 'tree-root' : 'tree-children';

  for (const node of nodes) {
    const li = document.createElement('li');

    if (node.type === 'dir') {
      li.className = 'tree-node tree-dir expanded';
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.innerHTML = `<span class="tree-chevron">▾</span><span class="tree-name">${node.name}</span>`;
      row.addEventListener('click', () => {
        const expanded = li.classList.toggle('expanded');
        row.querySelector('.tree-chevron').textContent = expanded ? '▾' : '▸';
      });
      li.appendChild(row);
      if (node.children && node.children.length > 0) {
        li.appendChild(buildTreeUL(node.children, depth + 1, touched));
      }
    } else {
      const isTouched = touched.includes(node.path);
      li.className = `tree-node tree-file${isTouched ? ' touched' : ''}`;
      li.dataset.path = node.path;
      const row = document.createElement('div');
      row.className = 'tree-row';
      row.style.paddingLeft = `${10 + depth * 14}px`;
      row.innerHTML = `<span class="tree-icon">${getFileIcon(node.name)}</span><span class="tree-name">${node.name}</span>`;
      li.appendChild(row);
    }
    ul.appendChild(li);
  }
  return ul;
}

function saveCollapseState() {
  const collapsed = new Set();
  document.querySelectorAll('.tree-dir:not(.expanded)').forEach(el => {
    const name = el.querySelector('.tree-name');
    if (name) collapsed.add(name.textContent);
  });
  return collapsed;
}

function restoreCollapseState(collapsed) {
  document.querySelectorAll('.tree-dir').forEach(el => {
    const name = el.querySelector('.tree-name');
    if (name && collapsed.has(name.textContent)) {
      el.classList.remove('expanded');
      const chevron = el.querySelector('.tree-chevron');
      if (chevron) chevron.textContent = '▸';
    }
  });
}

function updateTree(data) {
  if (data.rootPath) sidebarRootPath = data.rootPath;

  const titleEl = document.getElementById('tree-title');
  if (data.root) titleEl.textContent = data.root;

  const treeEl = document.getElementById('file-tree');
  const collapsed = saveCollapseState();

  treeEl.innerHTML = '';
  if (data.tree && data.tree.length > 0) {
    treeEl.appendChild(buildTreeUL(data.tree, 0, data.touched || []));
  }

  restoreCollapseState(collapsed);

  // Slide in new file
  if (data.newFile) {
    const node = treeEl.querySelector(`[data-path="${data.newFile}"]`);
    if (node) {
      node.classList.add('tree-node-new');
      setTimeout(() => node.classList.remove('tree-node-new'), 400);
    }
  }

  // Re-highlight active file
  if (activeRelPath) highlightActiveFile(activeRelPath);

  // Flash the file that was just touched
  if (data.activeFile) flashTreeFile(data.activeFile);
}

function highlightActiveFile(relPath) {
  document.querySelectorAll('.tree-file').forEach(el => el.classList.remove('active'));
  const node = document.querySelector(`.tree-file[data-path="${relPath}"]`);
  if (node) {
    node.classList.add('active');
    node.scrollIntoView({ block: 'nearest' });
  }
}

function flashTreeFile(relPath) {
  const node = document.querySelector(`.tree-file[data-path="${relPath}"]`);
  if (!node) return;
  node.classList.add('touched');
  node.classList.remove('touch-flash');
  void node.offsetWidth;
  node.classList.add('touch-flash');
  setTimeout(() => node.classList.remove('touch-flash'), 700);
}

function setActivePath(fullPath) {
  if (!sidebarRootPath || !fullPath) return null;
  const norm = fullPath.replace(/\\/g, '/');
  const root = sidebarRootPath.replace(/\\/g, '/');
  const rel = norm.startsWith(root + '/') ? norm.slice(root.length + 1) : norm.slice(root.length);
  activeRelPath = rel;
  highlightActiveFile(rel);
  return rel;
}

// ── Write animation ─────────────────────────────────────────────────────────

function insertLine(line) {
  if (!editor) return;
  const model = editor.getModel();
  const endPos = model.getFullModelRange().getEndPosition();
  const isEmpty = model.getLineCount() === 1 && model.getLineContent(1) === '';
  editor.updateOptions({ readOnly: false });
  editor.executeEdits('codelens', [{
    range: new monaco.Range(endPos.lineNumber, endPos.column, endPos.lineNumber, endPos.column),
    text: isEmpty ? line : '\n' + line
  }]);
  editor.updateOptions({ readOnly: true });
  editor.revealLine(editor.getModel().getLineCount());
}

async function typewriterLine(line, gen) {
  if (!editor) return;
  const model = editor.getModel();
  const endPos = model.getFullModelRange().getEndPosition();
  const isEmpty = model.getLineCount() === 1 && model.getLineContent(1) === '';
  editor.updateOptions({ readOnly: false });
  editor.executeEdits('codelens', [{
    range: new monaco.Range(endPos.lineNumber, endPos.column, endPos.lineNumber, endPos.column),
    text: isEmpty ? '' : '\n'
  }]);
  const lineNum = editor.getModel().getLineCount();
  const ids = editor.deltaDecorations(commentDecorations, [{
    range: new monaco.Range(lineNum, 1, lineNum, 1000),
    options: { isWholeLine: true, className: 'comment-line-glow' }
  }]);
  commentDecorations = ids;
  let built = '';
  for (const char of line) {
    if (animationGeneration !== gen) break;
    built += char;
    const currentLen = model.getLineContent(lineNum).length;
    editor.executeEdits('codelens', [{
      range: new monaco.Range(lineNum, 1, lineNum, currentLen + 1),
      text: built
    }]);
    editor.revealLine(lineNum);
    await new Promise(r => setTimeout(r, 30));
  }
  editor.updateOptions({ readOnly: true });
  setTimeout(() => { if (editor) editor.deltaDecorations(commentDecorations, []); commentDecorations = []; }, 500);
}

function enqueueLine(line) {
  lineQueue.push(line);
  if (!processingQueue) drainQueue(animationGeneration);
}

async function drainQueue(gen) {
  processingQueue = true;
  let hadCodeSinceLastComment = false;
  while (lineQueue.length > 0 && animationGeneration === gen) {
    const line = lineQueue.shift();
    const isComment = line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('<!--');
    const isBlank = line.trim() === '';
    if (isComment) {
      if (hadCodeSinceLastComment) await new Promise(r => setTimeout(r, 250));
      hadCodeSinceLastComment = false;
      if (animationGeneration !== gen) break;
      await Promise.all([
        speakAndWait(getCommentText(line)),
        typewriterLine(line, gen)
      ]);
    } else {
      insertLine(line);
      await new Promise(r => setTimeout(r, isBlank ? 40 : 120));
      if (!isBlank) hadCodeSinceLastComment = true;
    }
  }
  if (animationGeneration === gen) processingQueue = false;
}

async function handleWrite(payload) {
  cancelAnimation();
  const myGen = animationGeneration;

  const filename = payload.file.split(/[\\/]/).pop();
  if (currentFile && currentFile !== payload.file) requestFileSummary(currentFile);
  currentFile = payload.file;
  addTab(filename);
  setActivePath(payload.file);
  setStatus(`Writing ${filename}...`, 'writing');
  addFeedItem(filename, 'write');

  if (editor) {
    editor.updateOptions({ readOnly: false });
    editor.setValue('');
    editor.updateOptions({ readOnly: true });
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(filename));
    fadeInEditor();
  }

  const lines = (payload.content || '').split('\n');
  for (const line of lines) enqueueLine(line);

  await new Promise(resolve => {
    const poll = setInterval(() => {
      if (animationGeneration !== myGen || (!processingQueue && lineQueue.length === 0)) {
        clearInterval(poll); resolve();
      }
    }, 100);
  });

  if (animationGeneration === myGen) {
    setStatus('Live', 'live');
    scheduleSummary(payload.file);
  }
}

// ── Edit animation ──────────────────────────────────────────────────────────

function insertLineAt(line, targetLine) {
  if (!editor) return;
  editor.updateOptions({ readOnly: false });
  const model = editor.getModel();
  if (targetLine <= model.getLineCount()) {
    editor.executeEdits('codelens', [{
      range: new monaco.Range(targetLine, 1, targetLine, 1),
      text: line + '\n'
    }]);
  } else {
    const end = model.getFullModelRange().getEndPosition();
    editor.executeEdits('codelens', [{
      range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
      text: (end.column > 1 ? '\n' : '') + line
    }]);
  }
  editor.updateOptions({ readOnly: true });
  editor.revealLine(Math.min(targetLine, editor.getModel().getLineCount()));
}

async function typewriterLineAt(line, targetLine, gen) {
  if (!editor) return;
  editor.updateOptions({ readOnly: false });
  const model = editor.getModel();
  let slotLine;
  if (targetLine <= model.getLineCount()) {
    editor.executeEdits('codelens', [{
      range: new monaco.Range(targetLine, 1, targetLine, 1),
      text: '\n'
    }]);
    slotLine = targetLine;
  } else {
    const end = model.getFullModelRange().getEndPosition();
    if (end.column > 1) {
      editor.executeEdits('codelens', [{
        range: new monaco.Range(end.lineNumber, end.column, end.lineNumber, end.column),
        text: '\n'
      }]);
    }
    slotLine = model.getLineCount();
  }
  const ids = editor.deltaDecorations(commentDecorations, [{
    range: new monaco.Range(slotLine, 1, slotLine, 1000),
    options: { isWholeLine: true, className: 'comment-line-glow' }
  }]);
  commentDecorations = ids;
  let built = '';
  for (const char of line) {
    if (animationGeneration !== gen) break;
    built += char;
    const currentLen = model.getLineContent(slotLine).length;
    editor.executeEdits('codelens', [{
      range: new monaco.Range(slotLine, 1, slotLine, currentLen + 1),
      text: built
    }]);
    editor.revealLine(slotLine);
    await new Promise(r => setTimeout(r, 30));
  }
  editor.updateOptions({ readOnly: true });
  setTimeout(() => { if (editor) editor.deltaDecorations(commentDecorations, []); commentDecorations = []; }, 500);
}

async function handleEdit(payload) {
  cancelAnimation();
  const myGen = animationGeneration;

  const filename = payload.file.split(/[\\/]/).pop();
  if (currentFile && currentFile !== payload.file) requestFileSummary(currentFile);
  currentFile = payload.file;
  addTab(filename);
  setActivePath(payload.file);
  setStatus(`Editing ${filename}...`, 'writing');
  addFeedItem(filename, 'edit');

  if (!editor || !payload.fullContent) return;

  const fullContent = payload.fullContent.replace(/\r\n/g, '\n');
  const newStr = (payload.newString || '').replace(/\r\n/g, '\n');
  const oldStr = (payload.oldString || '').replace(/\r\n/g, '\n');

  const newIdx = fullContent.indexOf(newStr);
  let oldContent;
  if (newIdx !== -1 && oldStr) {
    oldContent = fullContent.slice(0, newIdx) + oldStr + fullContent.slice(newIdx + newStr.length);
  } else {
    editor.updateOptions({ readOnly: false });
    editor.setValue(fullContent);
    monaco.editor.setModelLanguage(editor.getModel(), getLanguage(filename));
    editor.updateOptions({ readOnly: true });
    fadeInEditor();
    setStatus('Live', 'live');
    return;
  }

  // Load before-state with fade in
  editor.updateOptions({ readOnly: false });
  editor.setValue(oldContent);
  monaco.editor.setModelLanguage(editor.getModel(), getLanguage(filename));
  editor.updateOptions({ readOnly: true });
  fadeInEditor();

  const model = editor.getModel();
  const modelText = model.getValue().replace(/\r\n/g, '\n');
  const oldIdx = modelText.indexOf(oldStr);
  if (oldIdx === -1 || animationGeneration !== myGen) { setStatus('Live', 'live'); return; }

  const oldLines = oldStr.split('\n');
  const startLine = modelText.slice(0, oldIdx).split('\n').length;
  const endLine = startLine + oldLines.length - 1;

  // Let the file settle before scrolling
  await new Promise(r => setTimeout(r, 600));
  if (animationGeneration !== myGen) return;

  // Smooth scroll to the change location
  await smoothScrollToLine(startLine);
  await new Promise(r => setTimeout(r, 200));
  if (animationGeneration !== myGen) return;

  // Highlight old lines red
  editor.updateOptions({ readOnly: false });
  const redIds = editor.deltaDecorations(removedDecorations, [{
    range: new monaco.Range(startLine, 1, endLine, 1000),
    options: { isWholeLine: true, className: 'removed-line-highlight' }
  }]);
  removedDecorations = redIds;

  await new Promise(r => setTimeout(r, 850));
  if (animationGeneration !== myGen) { editor.deltaDecorations(removedDecorations, []); return; }

  // Remove old lines cleanly
  const totalLines = model.getLineCount();
  const removeRange = endLine < totalLines
    ? new monaco.Range(startLine, 1, endLine + 1, 1)
    : new monaco.Range(startLine, 1, endLine, model.getLineContent(endLine).length + 1);
  editor.executeEdits('codelens', [{ range: removeRange, text: '' }]);
  editor.deltaDecorations(removedDecorations, []);
  removedDecorations = [];

  // Animate new lines in with typewriter + pause logic
  const newLines = newStr.split('\n');
  let currentLine = startLine;
  let hadCodeSinceLastComment = false;

  for (const line of newLines) {
    if (animationGeneration !== myGen) break;
    const isComment = line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('<!--');
    const isBlank = line.trim() === '';
    if (isComment) {
      if (hadCodeSinceLastComment) await new Promise(r => setTimeout(r, 250));
      hadCodeSinceLastComment = false;
      if (animationGeneration !== myGen) break;
      await Promise.all([
        speakAndWait(getCommentText(line)),
        typewriterLineAt(line, currentLine, myGen)
      ]);
    } else {
      insertLineAt(line, currentLine);
      await new Promise(r => setTimeout(r, isBlank ? 40 : 100));
      if (!isBlank) hadCodeSinceLastComment = true;
    }
    currentLine++;
  }

  if (animationGeneration === myGen) {
    setStatus('Live', 'live');
    scheduleSummary(payload.file);
  }
}

// ── SSE connection ───────────────────────────────────────────────────────────

function connectEvents() {
  const es = new EventSource('/events');

  es.onopen = () => setStatus('Live — watching for changes', 'live');

  es.onmessage = async (e) => {
    const payload = JSON.parse(e.data);
    if (payload.type === 'tree')  updateTree(payload);
    else if (payload.type === 'write') await handleWrite(payload);
    else if (payload.type === 'edit')  await handleEdit(payload);
  };

  es.onerror = () => setStatus('Disconnected — retrying...', 'idle');
}
