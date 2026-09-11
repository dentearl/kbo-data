# KBO Data Pipeline (`dentearl/kbo-data`)

Automated regular-season schedule and game results pipeline for the Korea Baseball Organization (KBO).

## Purpose
This repository serves static, daily-updated JSON datasets of KBO regular-season games (including ties, scores, and standings) via GitHub Pages / `raw.githubusercontent.com`.

The live baseball division visualizer dynamically fetches from:
```
https://raw.githubusercontent.com/dentearl/kbo-data/main/data/kbo/2026.json
```

## Security & Architecture
- **Zero Secrets / Zero Tokens**: Uses standard unauthenticated HTTP GET requests on the frontend and ephemeral, default `GITHUB_TOKEN` (`contents: write`) in GitHub Actions.
- **Server Friendly**: Intelligent monthly caching prevents excessive requests to official KBO servers.
- **Automated Nightly Run**: Scheduled via GitHub Actions daily at `15:30 UTC` (`00:30 KST`), shortly after night games finish.

## Manual Run
```bash
npm install
node scripts/scrapeKBO.js --season 2026
```
