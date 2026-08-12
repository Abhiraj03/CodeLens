// Claude Code PostToolUse hook — fires after Edit or Write tool calls
// Sends the diff to CodeLens for visualization
const http = require('http');
const fs = require('fs');

const chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString());
    const { tool_name, tool_input } = data;

    let payload = null;

    if (tool_name === 'Write') {
      payload = { type: 'write', file: tool_input.file_path, content: tool_input.content };
    } else if (tool_name === 'Edit') {
      // Hook fires after the edit is applied — read the new file content from disk.
      // Frontend reconstructs the before state by swapping newString back to oldString.
      let fullContent = '';
      try { fullContent = fs.readFileSync(tool_input.file_path, 'utf8'); } catch (e) {}
      payload = {
        type: 'edit',
        file: tool_input.file_path,
        oldString: tool_input.old_string,
        newString: tool_input.new_string,
        fullContent
      };
    }

    if (!payload) return;

    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost',
      port: 4006,
      path: '/diff',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (e) {}
});
