#!/usr/bin/env node
// config-gen.mjs — 多工具配置文件生成器
// Usage: node config-gen.mjs --relay <name> --data <aggregated.json> [--api-key <key>] [--tool claude-code,cursor,chatbox] [--install] [--output-dir <dir>]

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const args = process.argv.slice(2);
const relayName = getArg('--relay');
const dataFile = getArg('--data');
const apiKey = getArg('--api-key') || process.env.TRANSIT_API_KEY || '${YOUR_API_KEY}';
const toolArg = getArg('--tool') || 'claude-code,cursor,chatbox';
const shouldInstall = args.includes('--install');
const outputDir = getArg('--output-dir') || process.env.TEMP + '/relay-radar-configs';

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

if (!relayName || !dataFile) {
  console.error('Usage: node config-gen.mjs --relay <name> --data <aggregated.json> [--api-key <key>] [--tool claude-code,cursor,chatbox] [--install]');
  process.exit(1);
}

// ============================================================
// Load data and find relay
// ============================================================

const data = JSON.parse(readFileSync(dataFile, 'utf8'));
const relays = data.relays || data;
const relay = relays.find(r => r.name === relayName || r.domain === relayName);

if (!relay) {
  console.error(`[config-gen] Relay "${relayName}" not found in data. Available relays:`);
  relays.slice(0, 10).forEach(r => console.error(`  - ${r.name} (${r.url})`));
  if (relays.length > 10) console.error(`  ... and ${relays.length - 10} more`);
  process.exit(1);
}

const tools = toolArg.split(',').map(t => t.trim());

// ============================================================
// Template variables
// ============================================================

const baseUrl = normalizeBaseUrl(relay.url);
const defaultModel = relay.models && relay.models.length > 0 ? relay.models[0] : 'gpt-4o-mini';
const modelList = relay.models || ['gpt-4o-mini'];

function normalizeBaseUrl(url) {
  if (!url) return 'https://api.example.com/v1';
  let normalized = url.startsWith('http') ? url : 'https://' + url;
  // Ensure trailing /v1
  if (!normalized.endsWith('/v1')) {
    normalized = normalized.replace(/\/+$/, '') + '/v1';
  }
  return normalized;
}

const vars = {
  BASE_URL: baseUrl,
  API_KEY: apiKey,
  DEFAULT_MODEL: defaultModel,
  RELAY_NAME: relay.name,
  MODELS: JSON.stringify(modelList),
};

// ============================================================
// Template paths
// ============================================================

const repoDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const templateDir = join(repoDir, 'templates');
const templateFiles = {
  'claude-code': join(templateDir, 'claude-code.json'),
  'cursor': join(templateDir, 'cursor.json'),
  'chatbox': join(templateDir, 'chatbox.json'),
};

// Tool install paths
const installPaths = {
  'claude-code': join(homedir(), '.claude', 'settings.json'),
  'cursor': join(homedir(), '.cursor', 'config.json'),
  'chatbox': join(homedir(), 'ChatBox', 'config.json'),
};

// ============================================================
// Generate configs
// ============================================================

if (!existsSync(outputDir)) {
  mkdirSync(outputDir, { recursive: true });
}

const generated = [];

for (const tool of tools) {
  const templateFile = templateFiles[tool];
  if (!templateFile || !existsSync(templateFile)) {
    console.error(`[config-gen] Unknown tool: ${tool}, skipping`);
    continue;
  }

  let template = readFileSync(templateFile, 'utf8');
  // Replace placeholders
  for (const [key, val] of Object.entries(vars)) {
    const placeholder = `{{${key}}}`;
    template = template.replaceAll(placeholder, val);
  }

  const outputFile = join(outputDir, `${tool}.json`);
  writeFileSync(outputFile, template, 'utf8');
  generated.push({ tool, file: outputFile });
  console.error(`[config-gen] Generated ${tool} config: ${outputFile}`);
}

// ============================================================
// Install to tool paths
// ============================================================

if (shouldInstall) {
  console.error('\n[config-gen] Installing configs...');
  for (const { tool, file } of generated) {
    const installPath = installPaths[tool];
    if (!installPath) continue;

    // Ensure parent directory exists
    const parentDir = dirname(installPath);
    if (!existsSync(parentDir)) {
      mkdirSync(parentDir, { recursive: true });
    }

    // Backup existing config if any
    if (existsSync(installPath)) {
      const backup = installPath + '.bak.' + Date.now();
      writeFileSync(backup, readFileSync(installPath, 'utf8'));
      console.error(`  Backed up: ${installPath} → ${backup}`);
    }

    writeFileSync(installPath, readFileSync(file, 'utf8'));
    console.error(`  Installed: ${file} → ${installPath}`);
  }
}

// ============================================================
// Output summary
// ============================================================

console.error(`\n[config-gen] Done. Relay: ${relay.name} (${baseUrl})`);
console.error(`[config-gen] Default model: ${defaultModel}`);
console.error(`[config-gen] Models: ${modelList.length} available`);

console.log(JSON.stringify({
  generated_at: new Date().toISOString(),
  relay: { name: relay.name, url: baseUrl, models: modelList },
  tools: generated.map(g => g.tool),
  files: generated.map(g => g.file),
  installed: shouldInstall,
}, null, 2));
