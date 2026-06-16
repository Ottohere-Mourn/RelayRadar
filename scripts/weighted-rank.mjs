#!/usr/bin/env node
// weighted-rank.mjs — 加权排名引擎
// Usage: node weighted-rank.mjs [--data /tmp/relay-radar-data.json] [--weights price:30,stability:30,models:20,rating:20]
//        Reads aggregated data from --data file or stdin, outputs ranked results

import { readFileSync } from 'fs';

// Parse CLI args
const args = process.argv.slice(2);
const dataFile = args.includes('--data') ? args[args.indexOf('--data') + 1] : null;
const weightsArg = args.includes('--weights') ? args[args.indexOf('--weights') + 1] : null;
const topN = args.includes('--top') ? parseInt(args[args.indexOf('--top') + 1]) : 20;

// Default weights
const weights = {
  price: 30,
  stability: 30,
  models: 20,
  rating: 20,
};

if (weightsArg) {
  weightsArg.split(',').forEach(pair => {
    const [k, v] = pair.split(':');
    if (weights[k] !== undefined) weights[k] = parseInt(v);
  });
}

// Read data
if (!dataFile) {
  console.error('Usage: node weighted-rank.mjs --data <path> [--weights price:30,stability:30,models:20,rating:20] [--top 20]');
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataFile, 'utf8'));
rankAndPrint(data);

function rankAndPrint(data) {
  const relays = data.relays || data;
  const ranked = rankRelays(relays, weights);
  printResults(ranked, topN, weights);
}

// ============================================================
// Normalization functions
// ============================================================

function normalizePrice(relay, allRelays) {
  let score = 50; // baseline

  // From codepk: recharge_ratio (higher is better)
  if (relay.recharge_ratio != null) {
    const maxRatio = Math.max(...allRelays.map(r => r.recharge_ratio || 0));
    if (maxRatio > 0) {
      score = (relay.recharge_ratio / maxRatio) * 80;
    }
  }

  // From apiranking: fewer price grades = cheaper
  if (relay.price_grade && relay.price_grade.length > 0) {
    // price_grade contains strings like ["低", "中", "高"]
    // Fewer grades = more focused pricing = potentially cheaper
    const gradeBonus = Math.max(0, (4 - relay.price_grade.length) * 5);
    score = Math.min(100, score + gradeBonus);
  }

  // Register bonus
  if (relay.register_bonus != null) {
    const bonus = typeof relay.register_bonus === 'number' ? relay.register_bonus : 0;
    if (bonus > 0) score = Math.min(100, score + 10);
  }

  return Math.min(100, Math.max(0, score));
}

function normalizeStability(relay, allRelays) {
  let uptimeScore = 0;
  let latencyScore = 0;

  // Uptime (higher is better)
  if (relay.uptime_7d != null) {
    uptimeScore = (relay.uptime_7d / 100) * 50;
  }

  // Latency (lower is better)
  if (relay.avg_latency_ms != null) {
    const latency = Math.min(relay.avg_latency_ms, 3000);
    latencyScore = (1 - latency / 3000) * 50;
    // Bonus for very low latency
    if (relay.avg_latency_ms < 500) latencyScore += 5;
  } else if (relay.uptime_7d != null) {
    // No latency data, give partial credit
    latencyScore = 25;
  }

  return Math.min(100, Math.max(0, uptimeScore + latencyScore));
}

function normalizeModels(relay, allRelays) {
  let score = 0;

  // Model count
  if (relay.models && relay.models.length > 0) {
    const maxModels = Math.max(...allRelays.map(r => (r.models || []).length));
    const modelRatio = Math.min(relay.models.length / Math.max(maxModels, 1), 1);
    score += modelRatio * 60;
  }

  // Major provider coverage
  if (relay.models) {
    const modelStr = relay.models.join(',').toLowerCase();
    const providers = ['gpt', 'claude', 'gemini', 'deepseek', 'qwen', 'kimi', 'glm', 'opus'];
    let covered = 0;
    for (const p of providers) {
      if (modelStr.includes(p)) covered++;
    }
    const coverageRatio = Math.min(covered / 6, 1);
    score += coverageRatio * 40;
  }

  return Math.min(100, Math.max(0, score));
}

function normalizeRating(relay, allRelays) {
  let score = 0;

  // codepk score
  if (relay.score != null) {
    score += (relay.score / 100) * 70;
  }

  // User rating
  if (relay.avg_rating != null) {
    score += (relay.avg_rating / 5) * 30;
  } else if (relay.score != null) {
    // No user rating but has score, weight score more
    score = (relay.score / 100) * 100;
  }

  return Math.min(100, Math.max(0, score));
}

// ============================================================
// Ranking engine
// ============================================================

function rankRelays(relays, weights) {
  const results = [];

  for (const relay of relays) {
    // Skip non-active relays
    if (relay.status === 'suspended' || relay.status === 'closed') continue;

    const normPrice = normalizePrice(relay, relays);
    const normStability = normalizeStability(relay, relays);
    const normModels = normalizeModels(relay, relays);
    const normRating = normalizeRating(relay, relays);

    let total = (normPrice * weights.price / 100)
              + (normStability * weights.stability / 100)
              + (normModels * weights.models / 100)
              + (normRating * weights.rating / 100);

    // Boost/penalty modifiers
    if (relay.is_recommend) total += 10;
    if (relay.water_check_pass === true) total += 5;
    if (relay.water_check_pass === false) total -= 15;
    if (relay.tier === 'c') total -= 5;

    // Add score_detail breakdown if available
    const detail = relay.score_detail || null;

    results.push({
      name: relay.name,
      url: relay.url,
      domain: relay.domain,
      total_score: Math.round(total * 10) / 10,
      breakdown: {
        price: Math.round(normPrice * 10) / 10,
        stability: Math.round(normStability * 10) / 10,
        models: Math.round(normModels * 10) / 10,
        rating: Math.round(normRating * 10) / 10,
      },
      highlights: {
        tier: relay.tier,
        water_check_pass: relay.water_check_pass,
        is_recommend: relay.is_recommend,
        models: relay.models ? relay.models.slice(0, 10) : [],
        model_count: relay.models ? relay.models.length : 0,
        uptime_7d: relay.uptime_7d,
        avg_latency_ms: relay.avg_latency_ms,
        recharge_ratio: relay.recharge_ratio,
        score: relay.score,
        avg_rating: relay.avg_rating,
        register_bonus: relay.register_bonus,
      },
      source: relay.source,
    });
  }

  // Sort by total score descending
  results.sort((a, b) => b.total_score - a.total_score);
  return results;
}

function printResults(ranked, topN, weights) {
  console.error(`[rank] Weights: price=${weights.price} stability=${weights.stability} models=${weights.models} rating=${weights.rating}`);
  console.error(`[rank] Total relays ranked: ${ranked.length}, showing top ${Math.min(topN, ranked.length)}`);
  console.error('');

  // Table header
  const header = `${'#'.padEnd(4)} ${'名称'.padEnd(14)} ${'总分'.padStart(6)} ${'价格'.padStart(6)} ${'稳定'.padStart(6)} ${'模型'.padStart(6)} ${'评分'.padStart(6)} ${'推荐'.padStart(4)} ${'验真'.padStart(4)}`;
  console.error(header);
  console.error('─'.repeat(header.length));

  for (let i = 0; i < Math.min(topN, ranked.length); i++) {
    const r = ranked[i];
    const line = `${String(i + 1 + '.').padEnd(4)} ${r.name.padEnd(14)} ${String(r.total_score).padStart(6)} ${String(r.breakdown.price).padStart(6)} ${String(r.breakdown.stability).padStart(6)} ${String(r.breakdown.models).padStart(6)} ${String(r.breakdown.rating).padStart(6)} ${(r.highlights.is_recommend ? '⭐' : '').padStart(4)} ${(r.highlights.water_check_pass ? '✓' : (r.highlights.water_check_pass === false ? '✗' : '?')).padStart(4)}`;
    console.error(line);
  }

  // Output full JSON
  console.log(JSON.stringify({
    ranked_at: new Date().toISOString(),
    weights,
    total_ranked: ranked.length,
    results: ranked.slice(0, topN),
  }, null, 2));
}
