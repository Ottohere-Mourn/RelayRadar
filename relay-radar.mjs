#!/usr/bin/env node
// RelayRadar — Find the best API relays. Instantly.
// CLI entry point: relay-radar <command> [options]

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const scriptsDir = join(__dirname, 'scripts');
const configFile = join(__dirname, 'config.yaml');

const args = process.argv.slice(2);
const cmd = args[0];

function usage() {
  console.log(`
RelayRadar — Find the best API relays. Instantly.

Usage: relay-radar <command> [options]

Commands:
  aggregate     Scrape all 3 ranking sites, output merged data
  rank          Aggregate + weighted ranking (top 20)
  test          Connectivity probe of all relays
  gen-config    Generate API config files for specific tools
  migrate       Sync config files to remote server via SCP

Options (aggregate):
  --output <path>         Output file path (default: /tmp/relay-radar-data.json)
  --timeout <ms>          Scrape timeout per site (default: 30000)

Options (rank):
  --data <path>           Aggregated data file from 'aggregate'
  --weights w:x,y:z,...   Weight ratios (default: price:30,stability:30,models:20,rating:20)
  --top <n>               Show top N results (default: 20)

Options (test):
  --data <path>           Aggregated data file
  --api-key <key>         Your API key (or set TRANSIT_API_KEY env)
  --model <name>          Model to test (default: gpt-4o-mini)
  --timeout <ms>          Per-relay timeout (default: 15000)
  --parallel <n>          Concurrent probes (default: 5)

Options (gen-config):
  --relay <name>          Relay name or domain
  --data <path>           Aggregated data file
  --api-key <key>         Your API key (or set TRANSIT_API_KEY env)
  --tool <tools>          Comma-separated tools (default: claude-code,cursor,chatbox)
  --install               Install directly to tool config paths
  --output-dir <path>     Output directory (default: /tmp/relay-radar-configs)

Options (migrate):
  --local <dir>           Local config directory
  --host user@host        Remote SSH host
  --port <n>              SSH port (default: 22)
  --key <path>            SSH private key (default: ~/.ssh/id_rsa)
  --remote-dir <path>     Remote target directory (default: ~/.config/)
  --dry-run               Preview without transferring

Examples:
  relay-radar aggregate --output /tmp/data.json
  relay-radar rank --data /tmp/data.json --weights price:40,stability:30,models:15,rating:15
  relay-radar test --data /tmp/data.json --api-key sk-xxx
  relay-radar gen-config --relay "DoCode" --data /tmp/data.json --tool claude-code --install
  relay-radar migrate --local /tmp/relay-radar-configs --host user@10.0.0.1
`);
}

const validCmds = ['aggregate', 'rank', 'test', 'gen-config', 'migrate'];

if (!cmd || !validCmds.includes(cmd) || args.includes('--help') || args.includes('-h')) {
  usage();
  process.exit(cmd && !validCmds.includes(cmd) ? 1 : 0);
}

// Route to the appropriate script
const scriptMap = {
  aggregate: 'aggregate.mjs',
  rank: 'weighted-rank.mjs',
  test: 'connectivity-test.mjs',
  'gen-config': 'config-gen.mjs',
  migrate: 'config-migrate.mjs',
};

const script = join(scriptsDir, scriptMap[cmd]);
const scriptArgs = args.slice(1);

// For 'rank', auto-run aggregate first if no --data provided
if (cmd === 'rank' && !scriptArgs.includes('--data')) {
  const dataFile = '/tmp/relay-radar-data.json';
  console.error('[RelayRadar] No --data provided, running aggregate first...');
  const agg = spawnSync('node', [join(scriptsDir, 'aggregate.mjs'), '--output', dataFile], {
    stdio: 'inherit',
    timeout: 120000,
  });
  if (agg.status !== 0) process.exit(agg.status);
  scriptArgs.push('--data', dataFile);
}

const result = spawnSync('node', [script, ...scriptArgs], {
  stdio: 'inherit',
  timeout: 120000,
});

process.exit(result.status || 0);
