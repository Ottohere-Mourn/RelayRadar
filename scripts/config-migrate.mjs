#!/usr/bin/env node
// config-migrate.mjs — 配置迁移到远程服务器
// Usage: node config-migrate.mjs --local <dir> --host user@host [--port 22] [--key ~/.ssh/id_rsa] [--remote-dir ~/.config/] [--dry-run]

import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const args = process.argv.slice(2);

const localDir = getArg('--local') || getArg('--local-dir');
const host = getArg('--host');
const port = getArg('--port') || '22';
const key = getArg('--key') || join(process.env.HOME || '~', '.ssh', 'id_rsa');
const remoteDir = getArg('--remote-dir') || getArg('--remote') || '~/.config/';
const dryRun = args.includes('--dry-run');

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

if (!localDir || !host) {
  console.error('Usage: node config-migrate.mjs --local <dir> --host user@host [--port 22] [--key ~/.ssh/id_rsa] [--remote-dir ~/.config/] [--dry-run]');
  process.exit(1);
}

if (!existsSync(localDir)) {
  console.error(`[migrate] Local directory does not exist: ${localDir}`);
  process.exit(1);
}

// ============================================================
// Verify SSH connectivity
// ============================================================

function runCmd(cmd, silent = true) {
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 15000, stdio: silent ? 'pipe' : 'inherit' });
    return { ok: true, output: result };
  } catch (e) {
    return { ok: false, error: e.stderr || e.message };
  }
}

// ============================================================
// Step 1: Verify SSH
// ============================================================

console.error(`[migrate] Verifying SSH connection to ${host}...`);

const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new'];
if (port !== '22') sshOpts.push('-p', port);
sshOpts.push('-i', key);

const sshTest = runCmd(`ssh ${sshOpts.join(' ')} ${host} "echo SSH_OK"`);
if (!sshTest.ok) {
  console.error(`[migrate] SSH connection FAILED to ${host}`);
  console.error(`[migrate] Error: ${sshTest.error}`);
  console.error(`[migrate] Check:`);
  console.error('  - Host is correct and reachable');
  console.error(`  - SSH key ${key} exists and has correct permissions`);
  console.error('  - SSH agent is running (ssh-add -l)');
  console.error('  - Port ' + port + ' is open on the remote host');
  process.exit(1);
}

console.error(`[migrate] SSH connection OK`);

// ============================================================
// Step 2: List files to transfer
// ============================================================

const files = [];
function scanDir(dir) {
  for (const entry of readdirSync(dir)) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isFile()) files.push(fullPath);
    else if (stat.isDirectory()) scanDir(fullPath);
  }
}
scanDir(localDir);

if (files.length === 0) {
  console.error('[migrate] No files found in local directory');
  process.exit(0);
}

console.error(`[migrate] ${dryRun ? '[DRY RUN] ' : ''}Found ${files.length} file(s) to transfer:`);
files.forEach(f => console.error(`  - ${f}`));

// ============================================================
// Step 3: Transfer
// ============================================================

if (dryRun) {
  console.error(`\n[migrate] [DRY RUN] Would transfer to: ${host}:${remoteDir}`);
  console.error('[migrate] Dry run complete. Remove --dry-run to execute.');
  process.exit(0);
}

console.error(`\n[migrate] Transferring to ${host}:${remoteDir} ...`);

// Build SCP command
const scpArgs = ['-r', ...sshOpts.slice(0, -2)]; // Copy SSH opts but not host
scpArgs.push(...files);
scpArgs.push(`${host}:${remoteDir}`);

try {
  const scpResult = execSync(`scp ${scpArgs.map(a => `"${a}"`).join(' ')}`, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: 'pipe',
  });
  console.error(`[migrate] Transfer complete.`);
  if (scpResult) console.log(scpResult);
} catch (e) {
  console.error(`[migrate] Transfer FAILED: ${e.stderr || e.message}`);
  process.exit(1);
}

// ============================================================
// Step 4: Verify transfer
// ============================================================

console.error(`[migrate] Verifying remote files...`);
const verify = runCmd(`ssh ${sshOpts.join(' ')} ${host} "ls -la ${remoteDir}/*.json 2>/dev/null || echo 'No JSON files found'"`);
if (verify.ok) {
  console.error('[migrate] Remote files:');
  verify.output.split('\n').filter(Boolean).forEach(line => console.error(`  ${line}`));
}

console.error(`\n[migrate] Done. Configs synced to ${host}:${remoteDir}`);
