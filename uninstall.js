const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function uninstall() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    console.log('Nothing to uninstall.');
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not parse ~/.claude/settings.json:', e.message);
    process.exit(1);
  }

  if (!settings.hooks?.PostToolUse) {
    console.log('No CodeLens hook found.');
    return;
  }

  const before = settings.hooks.PostToolUse.length;
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter(entry =>
    !entry.hooks?.some(h => h.command?.toLowerCase().includes('codelens'))
  );

  if (settings.hooks.PostToolUse.length === before) {
    console.log('No CodeLens hook found.');
    return;
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('CodeLens hook removed from ~/.claude/settings.json');
}

uninstall();
