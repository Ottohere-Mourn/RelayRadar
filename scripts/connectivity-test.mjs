#!/usr/bin/env node
// connectivity-test.mjs — Relay endpoint connectivity probe
// Usage: node connectivity-test.mjs --data <aggregated.json> [--api-key <key>] [--model gpt-4o-mini] [--timeout 15000] [--parallel 5]
//        Tests each relay's /v1/chat/completions endpoint

import { readFileSync } from 'fs';
import { request } from 'https';
import { request as httpRequest } from 'http';
import { URL } from 'url';

const args = process.argv.slice(2);
const dataFile = getArg('--data');
const apiKey = getArg('--api-key') || process.env.TRANSIT_API_KEY || '';
const model = getArg('--model') || 'gpt-4o-mini';
const timeoutMs = parseInt(getArg('--timeout') || '15000');
const parallel = parseInt(getArg('--parallel') || '5');

function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : null;
}

if (!dataFile) {
  console.error('Usage: node connectivity-test.mjs --data <aggregated.json> --api-key <key> [--model gpt-4o-mini]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataFile, 'utf8'));
const relays = data.relays || data;

console.error(`[test] Testing ${relays.length} relays with model "${model}" (timeout: ${timeoutMs}ms, parallel: ${parallel})`);
if (!apiKey) {
  console.error('[test] WARNING: No API key provided. Tests may return "needs_auth" for all relays.');
  console.error('[test] Set TRANSIT_API_KEY env var or use --api-key');
}

// ============================================================
// HTTP request helper (no external deps)
// ============================================================

function testEndpoint(relay) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const baseUrl = relay.url || '';
    // Normalize URL
    let endpoint;
    try {
      const normalized = baseUrl.startsWith('http') ? baseUrl : 'https://' + baseUrl;
      const u = new URL(normalized);
      u.pathname = u.pathname.replace(/\/+$/, '') + '/v1/chat/completions';
      endpoint = u.toString();
    } catch {
      return resolve({
        name: relay.name,
        url: baseUrl,
        domain: relay.domain,
        status: 'invalid_url',
        latency_ms: null,
        error: 'Invalid URL',
      });
    }

    const payload = JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 5,
    });

    const urlObj = new URL(endpoint);
    const opts = {
      hostname: urlObj.hostname,
      port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': apiKey ? `Bearer ${apiKey}` : '',
        'User-Agent': 'RelayRadar/1.0',
      },
      timeout: timeoutMs,
    };

    const requester = urlObj.protocol === 'https:' ? request : httpRequest;
    const req = requester(opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        const latency = Date.now() - startTime;
        resolve(classifyResponse(relay, res.statusCode, body, latency));
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        name: relay.name,
        url: baseUrl,
        domain: relay.domain,
        status: 'timeout',
        latency_ms: timeoutMs,
        error: `Timeout after ${timeoutMs}ms`,
      });
    });

    req.on('error', (err) => {
      const latency = Date.now() - startTime;
      let status = 'unreachable';
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') status = 'dns_error';
      else if (err.code === 'ECONNREFUSED') status = 'connection_refused';
      else if (err.code === 'CERT_HAS_EXPIRED' || err.message.includes('SSL')) status = 'ssl_error';

      resolve({
        name: relay.name,
        url: baseUrl,
        domain: relay.domain,
        status,
        latency_ms: latency,
        error: err.message,
      });
    });

    req.write(payload);
    req.end();
  });
}

function classifyResponse(relay, statusCode, body, latency) {
  const result = {
    name: relay.name,
    url: relay.url,
    domain: relay.domain,
    latency_ms: latency,
    model_used: model,
  };

  if (statusCode === 200) {
    try {
      const parsed = JSON.parse(body);
      if (parsed.choices && parsed.choices.length > 0) {
        result.status = 'working';
        result.model_returned = parsed.model || null;
      } else if (parsed.error) {
        result.status = 'api_error';
        result.error = parsed.error.message || JSON.stringify(parsed.error);
      } else {
        result.status = 'degraded';
        result.error = 'Empty or unexpected response';
      }
    } catch {
      result.status = 'degraded';
      result.error = `Invalid JSON response: ${body.substring(0, 100)}`;
    }
  } else if (statusCode === 401 || statusCode === 403) {
    result.status = 'needs_auth';
    result.error = `HTTP ${statusCode}: Invalid or missing API key`;
  } else if (statusCode === 429) {
    result.status = 'rate_limited';
    result.error = 'Too many requests';
  } else if (statusCode >= 500) {
    result.status = 'server_error';
    result.error = `HTTP ${statusCode}`;
  } else if (statusCode === 404) {
    result.status = 'endpoint_not_found';
    result.error = 'Endpoint does not exist (404)';
  } else {
    result.status = 'unknown';
    result.error = `HTTP ${statusCode}: ${body.substring(0, 100)}`;
  }

  return result;
}

// ============================================================
// Batch runner
// ============================================================

async function runTests(relays) {
  const results = [];
  const working = [];
  const failed = [];

  // Process in batches
  for (let i = 0; i < relays.length; i += parallel) {
    const batch = relays.slice(i, i + parallel);
    const batchResults = await Promise.all(batch.map(r => testEndpoint(r)));

    for (const result of batchResults) {
      results.push(result);
      if (result.status === 'working') working.push(result);
      else failed.push(result);

      const icon = statusIcon(result.status);
      console.error(`  ${icon} ${result.name.padEnd(14)} ${result.status.padEnd(18)} ${result.latency_ms ? result.latency_ms + 'ms' : 'N/A'}`);
    }
  }

  // Sort: working first, then by latency
  results.sort((a, b) => {
    if (a.status === 'working' && b.status !== 'working') return -1;
    if (b.status === 'working' && a.status !== 'working') return 1;
    return (a.latency_ms || 9999) - (b.latency_ms || 9999);
  });

  return { results, working, failed };
}

function statusIcon(status) {
  switch (status) {
    case 'working': return '✅';
    case 'needs_auth': return '🔑';
    case 'degraded': return '⚠️';
    case 'timeout': return '⏱️';
    case 'rate_limited': return '🚦';
    default: return '❌';
  }
}

// ============================================================
// Main
// ============================================================

async function main() {
  const { results, working, failed } = await runTests(relays);

  const summary = {
    tested_at: new Date().toISOString(),
    model_used: model,
    total: results.length,
    working: working.length,
    failed: failed.length,
    by_status: {},
    results,
  };

  for (const r of results) {
    summary.by_status[r.status] = (summary.by_status[r.status] || 0) + 1;
  }

  console.error('');
  console.error(`[test] Done. Working: ${working.length}/${results.length}`);
  for (const [status, count] of Object.entries(summary.by_status)) {
    console.error(`  ${statusIcon(status)} ${status}: ${count}`);
  }

  if (working.length > 0) {
    console.error(`\n[test] Working relays (sorted by latency):`);
    working.forEach((r, i) => {
      console.error(`  ${i + 1}. ${r.name} — ${r.latency_ms}ms`);
    });
  }

  console.log(JSON.stringify(summary, null, 2));
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
