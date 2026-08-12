const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK_PATH = path.join(__dirname, 'hook.js').replace(/\\/g, '/');
const HOOK_COMMAND = `node "${HOOK_PATH}"`;

function install() {
  let settings = {};

  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    } catch (e) {
      console.error('Could not parse ~/.claude/settings.json:', e.message);
      process.exit(1);
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Remove any existing CodeLens entry so we don't duplicate on re-install
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
    !entry.hooks?.some(h => h.command?.toLowerCase().includes('codelens'))
  );

  settings.hooks.PostToolUse.push({
    matcher: 'Write|Edit',
    hooks: [{ type: 'command', command: HOOK_COMMAND }]
  });

  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));

  console.log('');
  console.log('  CodeLens installed.');
  console.log('');
  console.log('  Hook registered at:');
  console.log('  ' + HOOK_COMMAND);
  console.log('');
  console.log('  Next steps:');
  console.log('  1. node server.js');
  console.log('  2. Open http://localhost:4006');
  console.log('  3. Start a Claude Code session and write or edit a file');
  console.log('');
}

install();
