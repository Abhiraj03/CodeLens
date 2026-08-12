const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const app = express();
const PORT = 4006;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clients = new Set();
let projectRoot = null;
const touchedFiles = new Set();
const fileEdits = {};

function findCommonAncestor(a, b) {
  const pa = a.split(path.sep);
  const pb = b.split(path.sep);
  const common = [];
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i].toLowerCase() === pb[i].toLowerCase()) common.push(pa[i]);
    else break;
  }
  return common.join(path.sep);
}

const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.next', 'dist', 'build', '.venv', 'venv', 'target', 'bin', 'obj']);

function getDirectoryTree(dir, root) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        const children = getDirectoryTree(fullPath, root);
        result.push({ name: entry.name, path: relPath, type: 'dir', children });
      } else {
        result.push({ name: entry.name, path: relPath, type: 'file' });
      }
    }
    return result.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch (e) {
    return [];
  }
}

function broadcast(data) {
  const event = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of clients) {
    try { client.write(event); } catch (e) { clients.delete(client); }
  }
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  res.write(': connected\n\n');

  clients.add(res);
  console.log(`[CodeLens] Browser connected (${clients.size} watching)`);

  // Send current tree state immediately on connect
  if (projectRoot) {
    const tree = getDirectoryTree(projectRoot, projectRoot);
    res.write(`data: ${JSON.stringify({
      type: 'tree', root: path.basename(projectRoot),
      rootPath: projectRoot.replace(/\\/g, '/'),
      tree, touched: [...touchedFiles]
    })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clients.delete(res);
    clearInterval(heartbeat);
    console.log(`[CodeLens] Browser disconnected (${clients.size} watching)`);
  });
});

app.post('/diff', (req, res) => {
  const payload = req.body;
  const filename = path.basename(payload.file || 'unknown');
  console.log(`[CodeLens] ${payload.type.toUpperCase()} — ${filename} → pushing to ${clients.size} client(s)`);

  if (payload.file) {
    const fileDir = path.dirname(payload.file);
    projectRoot = projectRoot ? findCommonAncestor(projectRoot, fileDir) : fileDir;
    const rel = path.relative(projectRoot, payload.file).replace(/\\/g, '/');
    const isNew = !touchedFiles.has(rel);
    touchedFiles.add(rel);

    // Tree update first so sidebar is ready before animation starts
    const tree = getDirectoryTree(projectRoot, projectRoot);
    broadcast({
      type: 'tree',
      root: path.basename(projectRoot),
      rootPath: projectRoot.replace(/\\/g, '/'),
      tree,
      touched: [...touchedFiles],
      newFile: isNew ? rel : null,
      activeFile: rel
    });
  }

  // Accumulate edit history for file summary
  if (payload.file) {
    if (!fileEdits[payload.file]) fileEdits[payload.file] = [];
    if (payload.type === 'write') {
      const lines = (payload.content || '').split('\n');
      fileEdits[payload.file].push({
        type: 'write',
        lines: lines.length,
        snippet: lines.filter(l => l.trim()).slice(0, 4).join(' ').substring(0, 120)
      });
    } else if (payload.type === 'edit') {
      fileEdits[payload.file].push({
        type: 'edit',
        old: (payload.oldString || '').replace(/\n/g, ' ').substring(0, 100),
        new: (payload.newString || '').replace(/\n/g, ' ').substring(0, 100)
      });
    }
  }

  broadcast(payload);
  res.json({ ok: true, clients: clients.size });
});

app.post('/summary', (req, res) => {
  const { file } = req.body;
  const edits = fileEdits[file] || [];
  if (edits.length === 0) return res.json({ text: '' });

  const filename = path.basename(file);
  const editDesc = edits.map(e => {
    if (e.type === 'write') return `Wrote ${e.lines} lines. First lines: ${e.snippet}`;
    if (e.type === 'edit') return `Changed: "${e.old}" → "${e.new}"`;
  }).join('\n');

  const prompt = `These edits were made to ${filename}:\n${editDesc}\n\nSummarize in one short spoken sentence what changed and why. Max 20 words. No markdown, no filler, just the sentence.`;

  const proc = spawn('claude', ['-p', '--model', 'claude-haiku-4-5-20251001'], { shell: true });
  let output = '';
  proc.stdout.on('data', d => { output += d.toString(); });
  proc.stderr.on('data', () => {});
  proc.on('close', () => res.json({ text: output.trim() }));
  proc.on('error', () => res.json({ text: '' }));
  proc.stdin.write(prompt);
  proc.stdin.end();
});

app.listen(PORT, () => {
  console.log(`CodeLens running at http://localhost:${PORT}`);
});
