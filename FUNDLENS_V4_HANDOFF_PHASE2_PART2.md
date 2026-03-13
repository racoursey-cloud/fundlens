# FundLens v4 — Phase 2, Part 2 Handoff
**Date:** 2026-03-12 | **From:** Claude Part 1 | **To:** Claude Part 2

> **NOTE ON CREDENTIALS:** All actual API keys and tokens are in the compacted session
> summary in your context window — not repeated here to avoid secret scanning blocks.

---

## !! MANDATORY — READ BEFORE CODING ANYTHING !!

You must complete Steps 1-3 below before writing, modifying, or committing any code.
This is not a suggestion. Skipping caused rework in Part 1.

### Step 1: Read the full project context

1. Read this document completely.
2. Open /mnt/transcripts/journal.txt — find and read the most recent transcript file.
3. Read the compacted session summary at the top of your context window.
   It has every credential, every locked decision, and every constraint.
4. Do not proceed until all three are done.

### Step 2: Healthcheck — run all four, in order

**A) GitHub API**
GET https://api.github.com/repos/racoursey-cloud/fundlens
Use the GitHub token from your session summary.
Expected: 200, name=fundlens, default_branch=main

**B) File tree — verify Part 1 complete, Part 2 not started**
GET https://api.github.com/repos/racoursey-cloud/fundlens/git/trees/main?recursive=1
Must exist: src/services/api.js, src/services/cache.js, src/engine/scoring.js,
            src/engine/tiingo.js, src/engine/edgar.js
Must NOT exist: src/engine/world.js, mandate.js, manager.js, expenses.js, pipeline.js

**C) Live app env check**
Navigate to: https://fundlens-production.up.railway.app/api/devinfo?key=fl-devinfo-2026
Expected: status ok, all of these true:
  ANTHROPIC_KEY, TINNGO_KEY, FRED_KEY, TWELVEDATA_KEY, SUPA_URL, SUPA_KEY, SUPA_ANON_KEY
Note: tables/schema 404 is normal — Supabase schema not yet built.

**D) Supabase REST**
GET https://jbzhordefdqplxjtxfji.supabase.co/rest/v1/
Header: apikey <SUPA_KEY from session summary>
Expected: 200

### Step 3: Report and wait for go-ahead

Tell the operator each check result. Name the first file you will build (world.js).
Wait for explicit operator approval before writing any code.

---

## Part 1 Exit Healthcheck Results (2026-03-12, verified live)

| Check | Result |
|---|---|
| GitHub API | PASS — 200, fundlens, main |
| Part 1 files in tree | PASS — all 5 confirmed |
| Live app devinfo | PASS — all 7 env keys true |
| Supabase REST | PASS — 200 |
| DEVINFO_TOKEN | PASS — fl-devinfo-2026 active |

---

## Infrastructure Reference

- GitHub repo: racoursey-cloud/fundlens
- GitHub token expires: Apr 11 2026 (value in session summary)
- Railway domain: fundlens-production.up.railway.app
- Railway project ID: 782d1a9c-4a43-433f-bc73-7a714d7b5a1d
- Railway service ID: 700d6a66-fbf3-4ba1-b446-fac26977bf97
- Railway env ID: a1f1d5de-9c98-41cb-b200-8dc65c9e79aa
- Supabase project: jbzhordefdqplxjtxfji
- Supabase URL: https://jbzhordefdqplxjtxfji.supabase.co
- DEVINFO_TOKEN: fl-devinfo-2026
- All key values: compacted session summary

---

## Part 2 Build Order

| # | File | State |
|---|---|---|
| 1 | src/engine/world.js | Build first |
| 2 | src/engine/mandate.js | After world |
| 3 | src/engine/manager.js | After mandate |
| 4 | src/engine/expenses.js | After manager |
| 5 | src/engine/pipeline.js | After expenses |
| 6 | src/store/useAppStore.js | Add runPipeline + setErrors |
| 7 | src/components/shared/PipelineOverlay.jsx | After store |
| 8 | src/components/shared/DataQualityBanner.jsx | Last |

---

## Non-Negotiable Constraints

### Operator rules
- No terminal. No local dev. GitHub write then Railway auto-deploys.
- One file per commit. Never batch two engine files.
- Operator questions = curiosity, NOT change requests. Explain before touching anything.
- Always ask permission before modifying a committed file.

### Architecture
- Dark theme (--bg:#0e0f11, --surface:#16181c, Inter). Intentional. Do not touch.
- TINNGO_KEY: the typo is intentional and correct in Railway. Do not fix it.
- Claude model = claude-haiku-4-5-20251001. No substitutions.
- No web_search tool in v4. Was in v3 expenses.js. Do not port it.
- No localStorage. In-memory only throughout.
- Composite score: mandateScore*W1 + momentum*W2 + riskAdj*W3 + managerQuality*W4
  minus concentrationPenalty, clamped 1-10.
  Default weights: mandateScore:40, momentum:25, riskAdj:20, managerQuality:15.

### Concurrency — most common source of subtle bugs

| Operation | Pattern |
|---|---|
| FRED fetches in world.js | SEQUENTIAL — one at a time |
| Sector ETF momentum tiingo.js | CONCURRENT via Promise.all (done, do not change) |
| EDGAR classifyUnknownSectors | CONCURRENT via Promise.all |
| managerScorePromise + edgarPromise | Start at t=0 BEFORE pipeline Step 1 |

### world.js — Treasury shape (silently wrong if missed)

v3 shape: { rows: [{ "2 Yr": X, "10 Yr": Y }] }
v4 shape: { date, y1, y2, y5, y10, y30 } — flat, direct access, NOT rows[0]
There is no runtime error if you use the wrong shape. It silently returns undefined.

### world.js — news merge
1. RSS items first
2. GDELT items appended
3. Deduplicate
4. Slice to 36
TTL = 60 min. Singleton in Supabase via cache.js getWorldData / setWorldData.

### pipeline.js
- MONEY_MARKET_FUNDS = new Set(['FDRXX','ADAXX']) — skip EDGAR for these
- predictROI: thesisROI=(worldScore-5)*1.6, momentumROI=(momentum-5)*0.8, riskROI=(riskAdj-5)*0.4
  return thesisROI*0.55 + momentumROI*0.30 + riskROI*0.15

### Other files
- mandate.js: 3 retries, max_tokens:2200, accept if >=70% of funds scored, fundsWithQuantContext=null
- manager.js: 30-day Supabase cache, fallback score 5, max_tokens:2000
- expenses.js: 90-day cache, NO web_search, returns gross/net/note per ticker
- cache.js holdings: DELETE-then-INSERT (not upsert). Match in pipeline.js.

---

## Fixed in Part 1 — Do Not Re-Introduce

- scoring.js: expenses briefly added as 5th factor. Correct = 4 factors + concentration penalty only.
- tiingo.js: localStorage removed. In-memory only.

---

## GitHub Write Pattern

Fetch SHA and use it in the SAME async closure. Do not store in window and read later — causes 409.

```
const chk = await fetch(.../contents/path, { headers: { Authorization } });
const { sha } = await chk.json();
await fetch(.../contents/path, { method: PUT, body: JSON.stringify({ sha, message, content: btoa(...) }) });
```

---

## Final Rule

The transcript is the authority. Do not guess. Do not infer from what seems architecturally right.
Fetch and read the relevant transcript section before deciding anything ambiguous.