# RelayRadar

> Find the best API relays. Instantly.

<p align="center">
  <img src="poster.png" alt="RelayRadar" width="480">
</p>

RelayRadar aggregates data from three Chinese LLM API relay ranking sites — [apiranking.com](https://apiranking.com), [codepk.net](https://codepk.net), and [helpaio.com/transit](https://www.helpaio.com/transit) — and gives you a unified, ranked, and testable view of 100+ relay providers.

## Features

- **Multi-source aggregation** — Scrapes 3 ranking sites in real time, merges & deduplicates 100+ relays into a unified schema
- **Weighted ranking** — Customizable scoring: price, stability (uptime + latency), model coverage, and community rating
- **Connectivity probing** — Tests every relay's `/v1/chat/completions` endpoint concurrently, reports working/degraded/dead
- **Config generation** — Generates API config files for Claude Code, Cursor, and ChatBox with one command
- **Remote sync** — SCP your configs to a remote server

## Quick Start

```bash
# Requires Node.js 18+
git clone https://github.com/Ottohere-Mourn/RelayRadar.git
cd RelayRadar

# Scrape all 3 sites, merge into one dataset
node relay-radar.mjs aggregate --output /tmp/data.json

# Rank relays (customize weights as you like)
node relay-radar.mjs rank --data /tmp/data.json --weights price:40,stability:30,models:15,rating:15

# Test which relays are actually working
node relay-radar.mjs test --data /tmp/data.json --api-key "sk-your-key"

# Generate Claude Code config for a specific relay
node relay-radar.mjs gen-config --relay "DoCode" --data /tmp/data.json --api-key "sk-your-key" --tool claude-code --install
```

Or install globally:

```bash
npm install -g .
relay-radar aggregate --output /tmp/data.json
relay-radar rank --data /tmp/data.json
```

## Commands

| Command | What it does |
|---------|-------------|
| `aggregate` | Scrapes apiranking.com (64 relays), codepk.net (28 relays), helpaio.com (19 relays), merges into ~103 unique entries |
| `rank` | Weighted scoring across price / stability / models / rating. Auto-runs aggregate if no `--data` given |
| `test` | Sends a minimal chat completion request to each relay. Classifies as working / needs_auth / timeout / unreachable |
| `gen-config` | Reads templates from `templates/`, fills in the relay URL + models, outputs config files |
| `migrate` | Verifies SSH, then SCPs config files to a remote host |

## Weighted Ranking

Default weights: **price 30%**, **stability 30%**, **models 20%**, **rating 20%**.

Override with `--weights`:

```bash
relay-radar rank --weights price:50,stability:20,models:15,rating:15
```

What each dimension measures:

- **Price** — Recharge bonus ratio, price grade diversity, registration bonus
- **Stability** — 7-day uptime %, average latency (lower = better)
- **Models** — Total model count + major provider coverage (GPT, Claude, Gemini, DeepSeek, Qwen, Kimi, GLM)
- **Rating** — Third-party score + user rating from ranking sites

## Data Sources

| Site | Relays | Data Quality | Method |
|------|--------|-------------|--------|
| [apiranking.com](https://apiranking.com) | 64 | Rankings, tiers, watermarks, uptime, prices | Server-rendered HTML + JSON-LD |
| [codepk.net](https://codepk.net) | 28 | Scores, latency, models, reviews, bonuses | Nuxt 3 SSR payload parser |
| [helpaio.com/transit](https://www.helpaio.com/transit) | 19 | Rankings, names | JSON-LD + RSC payload |

## Config Templates

Supported tools:

- **Claude Code** — `~/.claude/settings.json`
- **Cursor** — `~/.cursor/config.json`
- **ChatBox** — Custom provider config

Each template has `{{BASE_URL}}`, `{{API_KEY}}`, `{{DEFAULT_MODEL}}`, `{{RELAY_NAME}}`, `{{MODELS}}` placeholders that are filled from the selected relay's data.

## Requirements

- Node.js 18+
- curl (available on macOS/Linux by default, Git Bash on Windows)
- SSH client (only for `migrate`)

No npm dependencies. Zero install. Uses only Node.js built-ins.

## License

MIT
