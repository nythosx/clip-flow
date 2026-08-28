const fs = require('fs');
const path = require('path');
const { DEFAULT_CONFIG } = require('../../shared/protocol');

function ensureProjectConfig(configDir) {
  fs.mkdirSync(configDir, { recursive: true });

  const configPath = path.join(configDir, 'config.json');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n');
  }

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  return { configDir, configPath, config };
}

module.exports = { ensureProjectConfig };
