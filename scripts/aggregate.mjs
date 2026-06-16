#!/usr/bin/env node
// aggregate.mjs — 三站数据聚合引擎
// Usage: node aggregate.mjs [--timeout 30000] [--output /tmp/relay-radar-data.json]
//        Outputs unified relay data to stdout (JSON) or --output file

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRAPE_TIMEOUT = parseInt(process.env.SCRAPE_TIMEOUT || '30000');
const OUTPUT_FILE = process.argv.includes('--output')
  ? process.argv[process.argv.indexOf('--output') + 1]
  : null;

// ============================================================
// HTTP helpers
// ============================================================

function curl(url, opts = {}) {
  const timeout = Math.floor((opts.timeout || SCRAPE_TIMEOUT) / 1000);
  const args = ['-sL', '--max-time', String(timeout), '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64)'];
  if (opts.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      args.push('-H', `${k}: ${v}`);
    }
  }
  args.push(url);
  try {
    const result = execSync(`curl ${args.map(a => `"${a}"`).join(' ')}`, {
      encoding: 'utf8',
      timeout: timeout * 1000 + 5000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { ok: true, body: result, status: 200 };
  } catch (e) {
    return { ok: false, body: e.stdout || '', error: e.stderr || e.message, status: e.status || 0 };
  }
}

// ============================================================
// Source 1: apiranking.com
// ============================================================

function scrapeApiranking(html) {
  const relays = [];

  // A. Parse JSON-LD for structured ranking data
  const ldMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  let ldRelays = [];
  if (ldMatch) {
    try {
      const ld = JSON.parse(ldMatch[1]);
      ldRelays = (ld.itemListElement || []).map(item => ({
        position: item.position,
        name: item.item?.name || '',
        provider_url: item.item?.provider?.url || '',
        apiranking_url: item.item?.url || '',
      }));
    } catch (e) { /* ignore */ }
  }

  // B. Parse HTML cards for detailed data
  const cardRegex = /<div class="card tier-([^"]+)">([\s\S]*?)(?=<div class="card tier-|$)/gi;
  let cardMatch, cardIdx = 0;

  while ((cardMatch = cardRegex.exec(html)) !== null) {
    const tier = cardMatch[1];
    const cardHtml = cardMatch[2];
    cardIdx++;

    // Match with JSON-LD entry by position
    const ldEntry = ldRelays.find(r => r.position === cardIdx);

    const name = extract(cardHtml, /<div class="provider-name">([^<]+)<\/div>/);
    const domain = extract(cardHtml, /<div class="provider-domain">([^<]+)<\/div>/);

    // Water check (model authenticity)
    const waterBadge = cardHtml.match(/<a[^>]*class="water-badge ([^"]*)"[^>]*>([^<]*)<\/a>/);
    let waterCheckPass = null;
    if (waterBadge) {
      if (waterBadge[1].includes('clean')) waterCheckPass = true;
      else if (waterBadge[1].includes('dirty') || waterBadge[1].includes('fail')) waterCheckPass = false;
    }

    // Price grades
    const priceGrades = [...cardHtml.matchAll(/<span class="price-grade[^"]*">([^<]+)<\/span>/g)]
      .map(m => m[1].trim());

    // Payment methods
    const paymentMethods = [...cardHtml.matchAll(/<span class="pay-tag[^"]*" title="([^"]*)">/g)]
      .map(m => m[1].trim());

    // Min topup
    const topupMatch = cardHtml.match(/<span class="topup-tag[^"]*">([^<]+)<\/span>/);

    // Uptime
    const uptimeFill = cardHtml.match(/style="width:\s*([0-9.]+)%"/);
    const uptimeGrade = extract(cardHtml, /<div class="uptime-grade[^"]*">([^<]+)<\/div>/);

    // Invoice support
    const hasInvoice = !!cardHtml.match(/<span class="invoice-yes">/);
    const noInvoice = !!cardHtml.match(/<span class="invoice-no">/);

    // Register bonus / trial
    const bonusMatch = cardHtml.match(/<div class="bonus-col">[\s\S]*?<span[^>]*>([^<]+)<\/span>/);

    // Anomaly tag
    const anomalyTag = extract(cardHtml, /<span class="tag-anomaly[^"]*">([^<]+)<\/span>/);

    const relay = {
      name: name || ldEntry?.name || '',
      url: ldEntry?.provider_url || '',
      domain: domain || extractDomain(ldEntry?.provider_url || ''),
      position: cardIdx,
      tier,
      water_check_pass: waterCheckPass,
      price_grade: priceGrades.length > 0 ? priceGrades : null,
      payment_methods: paymentMethods.length > 0 ? paymentMethods : null,
      min_topup: topupMatch ? topupMatch[1].trim() : null,
      uptime_7d: uptimeFill ? parseFloat(uptimeFill[1]) : null,
      uptime_grade: uptimeGrade || null,
      invoice_support: hasInvoice ? true : (noInvoice ? false : null),
      register_bonus: (bonusMatch && bonusMatch[1].trim() !== '×') ? bonusMatch[1].trim() : null,
      anomaly: anomalyTag || null,
      score: null,
      avg_latency_ms: null,
      models: null,
      avg_rating: null,
      review_count: null,
      recharge_ratio: null,
      status: 'active',
      is_recommend: false,
      source: ['apiranking'],
    };

    relays.push(relay);
  }

  return relays;
}

// ============================================================
// Source 2: codepk.net (Nuxt 3 SSR)
// ============================================================

function scrapeCodepk(html) {
  const nuxtMatch = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!nuxtMatch) return [];

  let arr;
  try { arr = JSON.parse(nuxtMatch[1]); } catch (e) { return []; }

  // Nuxt 3 compressed payload resolver
  // In Nuxt payload: object field values are indices into arr.
  // One level of lookup gives the terminal value (numbers are NOT further resolved).
  // Only Nuxt wrappers ["Reactive"/"ShallowReactive", N] need unwrapping.
  function resolve(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') {
      if (val >= arr.length || val < 0) return val;
      const next = arr[val];
      if (next === null || next === undefined) return null;
      // Nuxt reactive wrappers: ["Reactive", N] or ["ShallowReactive", N]
      if (Array.isArray(next) && next.length === 2 &&
          (next[0] === 'Reactive' || next[0] === 'ShallowReactive')) {
        return resolve(next[1]);
      }
      // Nuxt set marker: ["Set"] → empty array
      if (Array.isArray(next) && next.length === 1 && next[0] === 'Set') {
        return [];
      }
      // Terminal value: numbers, strings, booleans, objects, arrays
      // Numbers are NOT further resolved — they are the actual value
      if (typeof next === 'number') return next;
      if (typeof next === 'string' || typeof next === 'boolean') return next;
      if (Array.isArray(next)) return next.map(v => resolve(v));
      if (typeof next === 'object') {
        const result = {};
        for (const [k, v] of Object.entries(next)) {
          result[k] = resolve(v);
        }
        return result;
      }
      return next;
    }
    if (Array.isArray(val)) return val.map(v => resolve(v));
    if (typeof val === 'object') {
      const result = {};
      for (const [k, v] of Object.entries(val)) {
        result[k] = resolve(v);
      }
      return result;
    }
    return val;
  }

  // Find the sites items array (raw indices, NOT resolved)
  const stateKeys = arr[2];
  const sitesKey = Object.keys(stateKeys).find(k => k.includes('sites:items'));
  if (!sitesKey) return [];

  const rawIdx = stateKeys[sitesKey];
  let siteIndices = arr[rawIdx];
  // Handle Nuxt wrapper
  if (Array.isArray(siteIndices) && siteIndices.length === 2 &&
      (siteIndices[0] === 'Reactive' || siteIndices[0] === 'ShallowReactive')) {
    siteIndices = arr[siteIndices[1]];
  }
  if (!Array.isArray(siteIndices)) return [];

  const relays = [];
  for (const idx of siteIndices) {
    const site = resolve(idx);
    if (!site || !site.name) continue;

    // Parse models from comma-separated string
    let models = null;
    if (site.models) {
      models = site.models.split(',').map(m => m.trim()).filter(Boolean);
    }

    // Parse score_detail if available
    let score = null;
    if (typeof site.score === 'number') score = site.score;

    let avgRating = null;
    if (typeof site.avg_rating === 'number') avgRating = site.avg_rating;

    let rechargeRatio = null;
    if (typeof site.recharge_ratio === 'number') rechargeRatio = site.recharge_ratio;

    let registerBonus = null;
    if (typeof site.register_bonus === 'number') registerBonus = site.register_bonus;
    else if (typeof site.register_bonus === 'string') registerBonus = site.register_bonus;

    let uptime7d = null;
    if (typeof site.uptime_7d === 'number') uptime7d = site.uptime_7d;

    let latency = null;
    if (typeof site.latency === 'number') latency = site.latency;
    else if (typeof site.response_ms === 'number') latency = site.response_ms;

    const relay = {
      name: site.name || '',
      url: site.url || '',
      domain: extractDomain(site.url || ''),
      position: null,
      tier: null,
      water_check_pass: null,
      price_grade: null,
      payment_methods: site.recharge_methods
        ? (Array.isArray(site.recharge_methods) ? site.recharge_methods : [site.recharge_methods])
        : null,
      min_topup: site.min_recharge != null ? String(site.min_recharge) : null,
      uptime_7d: uptime7d,
      uptime_grade: null,
      invoice_support: null,
      register_bonus: registerBonus,
      anomaly: null,
      score,
      avg_latency_ms: latency,
      models,
      avg_rating: avgRating,
      review_count: typeof site.review_count === 'number' ? site.review_count : null,
      recharge_ratio: rechargeRatio,
      status: site.status === 1 ? 'active' : (site.status === 0 ? 'suspended' : 'active'),
      is_recommend: site.is_recommend === true,
      source: ['codepk'],
    };

    // Parse score_detail for sub-scores
    if (site.score_detail && typeof site.score_detail === 'object') {
      relay.score_detail = site.score_detail;
    }

    relays.push(relay);
  }

  return relays;
}

// ============================================================
// Source 3: helpaio.com/transit
// ============================================================

function scrapeHelpaio(html) {
  const relays = [];

  // Parse JSON-LD blocks
  const ldBlocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];

  for (const block of ldBlocks) {
    try {
      const data = JSON.parse(block[1]);
      // Look for ItemList in @graph
      const graph = data['@graph'] || [data];
      for (const item of graph) {
        if (item['@type'] === 'ItemList' && item.itemListElement) {
          for (const elem of item.itemListElement) {
            relays.push({
              name: elem.name || '',
              url: '',  // helpaio uses fragment anchors, no real URL
              domain: extractDomainFromName(elem.name || ''),
              position: elem.position || null,
              tier: null,
              water_check_pass: null,
              price_grade: null,
              payment_methods: null,
              min_topup: null,
              uptime_7d: null,
              uptime_grade: null,
              invoice_support: null,
              register_bonus: null,
              anomaly: null,
              score: null,
              avg_latency_ms: null,
              models: null,
              avg_rating: null,
              review_count: null,
              recharge_ratio: null,
              status: 'active',
              is_recommend: false,
              source: ['helpaio'],
            });
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  return relays;
}

// ============================================================
// Merge & Dedup
// ============================================================

function mergeRelays(allRelays) {
  const map = new Map();

  for (const relay of allRelays) {
    const key = relay.domain || relay.name;
    if (!key) continue;

    if (map.has(key)) {
      const existing = map.get(key);
      // Merge sources
      if (!existing.source.includes(relay.source[0])) {
        existing.source.push(relay.source[0]);
      }
      // Fill missing fields from the new relay (prefer richer data)
      for (const [field, val] of Object.entries(relay)) {
        if (field === 'source') continue;
        if (val == null) continue;
        const existingPriority = sourcePriority(existing.source[0]);
        const newPriority = sourcePriority(relay.source[0]);
        // Overwrite if: existing is null/false, OR new source has strictly higher priority
        if (existing[field] == null || existing[field] === false || newPriority > existingPriority) {
          existing[field] = val;
        }
      }
    } else {
      map.set(key, { ...relay });
    }
  }

  return [...map.values()];
}

function sourcePriority(source) {
  if (source === 'codepk') return 3;
  if (source === 'apiranking') return 2;
  if (source === 'helpaio') return 1;
  return 0;
}

// ============================================================
// Helpers
// ============================================================

function extract(str, regex) {
  const m = str.match(regex);
  return m ? m[1].trim() : null;
}

function extractDomain(url) {
  if (!url) return '';
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

function extractDomainFromName(name) {
  // Try to guess domain from common中转站 name patterns
  const nameToDomain = {
    'Micu': 'micu.ai',
    'Packy Code': 'packyapi.com',
    'Yes Code': 'yescode.ai',
    'SSSAiCode': 'sssaicode.com',
    'CCTQ': 'cctq.ai',
    'TimiCC': 'timicc.com',
    '78 Code': '78code.com',
    'IKun Code': 'ikuncode.com',
    'Cubence': 'cubence.com',
  };
  return nameToDomain[name] || name.toLowerCase().replace(/\s+/g, '') + '.com';
}

// ============================================================
// Main
// ============================================================

async function main() {
  const result = {
    generated_at: new Date().toISOString(),
    sources: {},
    relays: [],
  };

  // 1. apiranking.com
  console.error('[aggregate] Fetching apiranking.com ...');
  const apirankingResp = curl('https://apiranking.com/');
  if (apirankingResp.ok) {
    const relays = scrapeApiranking(apirankingResp.body);
    result.sources.apiranking = { status: 'ok', count: relays.length };
    result.relays.push(...relays);
    console.error(`[aggregate] apiranking.com: ${relays.length} relays`);
  } else {
    result.sources.apiranking = { status: 'error', count: 0, error: `HTTP ${apirankingResp.status}` };
    console.error(`[aggregate] apiranking.com: ERROR (HTTP ${apirankingResp.status})`);
  }

  // 2. codepk.net
  console.error('[aggregate] Fetching codepk.net ...');
  const codepkResp = curl('https://codepk.net/');
  if (codepkResp.ok) {
    const relays = scrapeCodepk(codepkResp.body);
    result.sources.codepk = { status: 'ok', count: relays.length };
    result.relays.push(...relays);
    console.error(`[aggregate] codepk.net: ${relays.length} relays`);
  } else {
    result.sources.codepk = { status: 'error', count: 0, error: `HTTP ${codepkResp.status}` };
    console.error(`[aggregate] codepk.net: ERROR (HTTP ${codepkResp.status})`);
  }

  // 3. helpaio.com/transit
  console.error('[aggregate] Fetching helpaio.com/transit ...');
  const helpaioResp = curl('https://www.helpaio.com/transit');
  if (helpaioResp.ok) {
    const relays = scrapeHelpaio(helpaioResp.body);
    result.sources.helpaio = { status: 'ok', count: relays.length };
    result.relays.push(...relays);
    console.error(`[aggregate] helpaio.com/transit: ${relays.length} relays`);
  } else {
    result.sources.helpaio = { status: 'error', count: 0, error: `HTTP ${helpaioResp.status}` };
    console.error(`[aggregate] helpaio.com/transit: ERROR (HTTP ${helpaioResp.status})`);
  }

  // 4. Merge and dedup
  console.error('[aggregate] Merging and deduplicating ...');
  result.relays = mergeRelays(result.relays);
  console.error(`[aggregate] Total unique relays: ${result.relays.length}`);

  // Output
  const json = JSON.stringify(result, null, 2);
  if (OUTPUT_FILE) {
    writeFileSync(OUTPUT_FILE, json, 'utf8');
    console.error(`[aggregate] Written to ${OUTPUT_FILE}`);
  }
  console.log(json);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
