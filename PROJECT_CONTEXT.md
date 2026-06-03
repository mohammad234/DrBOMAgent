# PROJECT_CONTEXT.md — Dr. BOM Agent

> **Purpose:** Complete technical reference for this project. Any developer or AI coding agent can read this file and understand the full architecture, logic, conventions, and how to make changes safely.

---

## 1. Project Overview

**Name:** Dr. BOM Agent  
**Type:** Node.js Express web application (self-hosted, localhost)  
**Port:** 3000 (configurable via `PORT` env var)  
**Purpose:** End-to-end Azure migration planning tool that:
1. Uploads customer server inventory (CSV/XLSX)
2. Converts it to Azure Migrate import format
3. Optionally creates an Azure Migrate project and imports servers
4. Runs local VM SKU sizing assessment (or accepts Azure Migrate report upload)
5. Generates a full Bill of Materials (BOM) with TCO breakdown
6. Builds a Wave Plan with timeline, Gantt chart, and throughput-based capacity planning

**Target User:** Microsoft CSA (Cloud Solution Architect) working with enterprise customers on Azure migration projects.

---

## 2. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | v18+ (tested on v22) |
| Web Framework | Express | ^4.21.0 |
| File Upload | Multer | ^2.1.1 |
| Spreadsheet I/O | SheetJS (xlsx) | ^0.18.5 |
| Browser Launch | open | ^10.1.0 |
| Frontend CSS | Bootstrap (CDN) | 5.3.3 |
| Frontend Icons | Bootstrap Icons (CDN) | 1.11.3 |
| Gantt Export | html2canvas (CDN) | 1.4.1 |
| LLM Integration | Azure OpenAI (optional) | REST API |
| Azure Auth | Azure CLI (`az login`) | No App Registration needed |

**No build step.** Pure vanilla JS frontend, no bundler. Served as static files from `/public`.

---

## 3. File Structure

```
Migration TCO and BOM CLI Agent/
├── server.js              # Main Express server (all API routes, ~2400 lines)
├── assessment.js          # VM SKU sizing engine (Retail Prices API based)
├── assessmentConfig.js    # VM series, pricing models, regions, AHUB options
├── columnMapping.js       # Inventory column → Azure Migrate field mapping
├── llmHelper.js           # Azure OpenAI integration (optional, fallback)
├── cliSetup.js            # Interactive CLI startup (Azure login, LLM config)
├── package.json           # Dependencies and scripts
├── start.bat              # Windows double-click launcher
├── SKUSizingLogic.json    # Right-sizing config (comfort factors, SKU filtering)
├── wavePlanConfig.json    # Wave plan defaults (throughput, durations, grouping modes)
├── wavePlanLogic.json     # Auto-assignment rules, scoring, LLM prompt templates
├── prompts.json           # LLM prompt templates for column mapping
├── public/
│   ├── index.html         # Single-page app (7-step wizard UI)
│   ├── app.js             # Frontend JavaScript (~1900 lines)
│   └── style.css          # Custom styles
├── uploads/               # Temp upload directory (multer)
└── output/                # Session output files (per-session UUID subdirs)
    └── {sessionId}/
        ├── AzureMigrate_Import.csv
        ├── conversion_report.txt
        └── Excluded_Servers.csv
```

---

## 4. Architecture

### 4.1 Session Model
- **In-memory store:** `const sessions = {}` (no database)
- **Session ID:** UUID generated on file upload
- **Session lifecycle:** Created on upload, lives until server restart
- **Session fields:**
  - `outputDir` — path to output/{sessionId}/
  - `originalFile` — uploaded filename
  - `mappedData` — converted rows (Azure Migrate format)
  - `excludedServers` — servers that failed validation
  - `mappingInfo` — column mapping details shown in Step 2
  - `extraColumns` — inventory columns not mapped to Azure Migrate
  - `envAssessments` — per-environment assessment results
  - `assessmentReport` — combined sizing/costing report
  - `bomData` — Bill of Materials with all cost categories
  - `wavePlan` — generated wave plan (waves, config, throughput)
  - `customerName` — entered by user in Step 1

### 4.2 Frontend Architecture
- **Single HTML page** with 7 step panels (only one visible at a time)
- **Step navigation:** `goToStep(n)` function shows/hides panels
- **State object:** `state` in app.js tracks sessionId, step completion, connection status
- **No SPA router** — pure DOM manipulation with Bootstrap

### 4.3 Data Flow

```
Inventory CSV/XLSX
    → POST /api/upload → columnMapping.js → Azure Migrate CSV + extraColumns
    → POST /api/assessment/run → assessment.js → VM sizing + pricing
    → GET /api/waveplan/detect-groups → wave grouping options
    → POST /api/waveplan/generate → throughput-based wave plan
    → GET /api/waveplan/export-xlsx → formatted Excel download
```

---

## 5. The 7 Steps (UI Wizard)

### Step 1: Upload Inventory
- User enters **Customer Name** (required) and uploads CSV/XLSX
- `columnMapping.js` maps source columns to Azure Migrate template
- Extra/unmapped columns are preserved as `extraColumns` per server
- Output: `AzureMigrate_Import.csv`, `Excluded_Servers.csv`, `conversion_report.txt`

### Step 2: Review & Accept
- Shows column mapping table (source → target)
- Shows valid server count, excluded count with reasons
- User can accept (proceeds) or re-upload
- Download buttons for converted CSV and report

### Step 3: Azure Migrate Project (Optional)
- User selects subscription, resource group, project name, geography
- Creates Azure Migrate project via ARM API
- Requires Azure authentication (az CLI or device code flow)

### Step 4: Import to Azure Migrate (Optional)
- Imports the converted CSV into the Azure Migrate project
- Triggers discovery and assessment creation

### Step 5: Upload Assessment Report
- User uploads Azure Migrate detailed report (`Strategy_Lift_and_shift.xlsx`)
- OR runs local assessment (no Azure needed) using `assessment.js`
- Local assessment uses Azure Retail Prices API (no subscription required for pricing)

### Step 6: Bill of Materials (BOM)
- Full cost breakdown: Compute, Storage, Security, Firewall, ExpressRoute, Egress, Backup
- Per-server detail + totals + summary
- Export to XLSX (multi-sheet: Full BOM, Cost Summary, Assumptions)
- Shared costs (Firewall, ExpressRoute) amortized across all servers

### Step 7: Wave Plan
- Configuration: start date, LZ design/provision weeks, pilot duration, waves, wave duration, buffer
- Throughput-based capacity planning (advanced collapsible section)
- Grouping detection from inventory extra columns
- Rule-based or AI-assisted wave assignment
- Timeline table, Gantt chart, accordion details, BOM cost check
- Export: XLSX (multi-sheet) and Gantt PNG

---

## 6. Key Business Logic

### 6.1 Column Mapping (`columnMapping.js`)
- Maps standard Azure Migrate columns from various inventory formats
- Handles derived columns (e.g., vCores = sockets × cores_per_socket × threads)
- Preserves unmapped columns as `extraColumns` for later use in grouping

### 6.2 VM Sizing (`assessment.js` + `SKUSizingLogic.json`)
- **Mode:** "as-allocated" (use vCPU/RAM as reported) or "performance-based" (with percentile+comfort factor)
- **SKU Catalog:** Fetched from Azure Retail Prices API (no subscription needed)
- **Matching Logic:**
  1. Filter SKUs by enabled VM series (D, E, F, L, M by default)
  2. Filter where SKU.vCPUs >= required AND SKU.memoryGB >= required
  3. Sort by cost (cheapest first), pick best fit
- **Disk Sizing:** Map source disk GB to Azure Managed Disk tier (Standard SSD default)
- **Pricing Models:** PAYG, 1-Year RI, 3-Year RI (configurable)
- **AHUB:** Azure Hybrid Benefit toggle (excludes Windows license cost)
- **Caching:** In-memory with 1hr TTL for SKU/pricing data

### 6.3 BOM Generation
- Per-server: Compute + Storage + Security (Defender P2)
- Shared costs distributed:
  - **Azure Firewall:** Standard tier ($912/mo + $0.016/GB) ÷ server count
  - **ExpressRoute:** Circuit + Gateway ÷ server count
  - **Egress:** Based on network throughput × utilization
  - **Backup:** Instance fee + storage tier based on disk size
- Output: JSON → rendered in UI table → exportable as XLSX

### 6.4 Wave Plan Logic

#### Throughput-Based Capacity Formula
```
maxPilotVMs = pilotDurationWeeks × pilotThroughputPerWeek
maxWaveVMs  = waveDurationWeeks × waveThroughputPerWeek
totalCapacity = maxPilotVMs + (numWaves × maxWaveVMs)
```

**Defaults:** pilotThroughput=10 VMs/wk, waveThroughput=30 VMs/wk

#### Wave Structure
- **Wave 0 (Foundation & Pilot):**
  - Phases: LZ Design → LZ Provisioning → Pilot Migration
  - Pilot capped by: `maxPilotVMs` AND `pilotMaxGroups` (3)
  - Selects lowest-risk groups (by environmentPriority scoring)
- **Waves 1-N (Migration):**
  - Greedy distribution: assign next group to wave with fewest servers
  - Each wave flagged `overCapacity: true` if exceeds `maxWaveVMs`
  - `capacityWarning` string returned if any wave overflows

#### Group Detection
1. Scan `extraColumns` from all servers
2. Match against `wavePlanConfig.groupingModes[].columnPatterns`
3. Add all remaining columns with 2-200 unique values as dynamic options
4. Always offer "Distribute Evenly" fallback (splits by count, no grouping)

#### LLM-Assisted (Optional)
- If AI configured AND user provides instructions in textarea → use LLM
- LLM receives grouped server list + user instructions
- Returns `[{group, wave, reason}]` assignments
- Assignments applied via `/api/waveplan/update` endpoint (rebuilds timeline)

### 6.5 Date Format
- **Server/API:** ISO format (YYYY-MM-DD) for all date storage and calculations
- **Frontend display:** DD-MM-YYYY via `fmtDateDisplay()` helper
- **XLSX export:** DD-MM-YYYY via server-side `fmtDate()` helper

---

## 7. API Endpoints Reference

### Upload & Conversion
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` | Upload inventory CSV/XLSX, returns mapped data + session |
| GET | `/api/download/:sessionId/:fileType` | Download converted files (csv, excluded, report) |
| GET | `/api/session/:sessionId/environments` | Get detected environments from extra columns |

### Azure Auth
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/auth/status` | Check if Azure CLI session is active |
| POST | `/api/auth/claim-preauth` | Claim pre-authenticated token from CLI startup |
| POST | `/api/auth/device-code` | Start device code auth flow |
| POST | `/api/auth/device-code-poll` | Poll for device code completion |
| GET | `/auth/login` | Browser-based OAuth redirect |
| GET | `/auth/callback` | OAuth callback handler |

### Azure Resources
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/azure/subscriptions` | List subscriptions |
| GET | `/api/azure/resource-groups` | List RGs for subscription |
| GET | `/api/azure/migrate-projects` | List existing Migrate projects |
| POST | `/api/azure/create-project` | Create RG + Migrate project |
| POST | `/api/azure/import-discovery` | Import servers to Migrate |
| GET | `/api/azure/geographies` | List supported geographies |

### LLM / AI
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/llm/status` | Check if LLM is configured |
| POST | `/api/llm/config` | Save LLM endpoint/key/deployment |
| GET | `/api/llm/saved-config` | Load persisted LLM config |
| GET | `/api/azure/openai-accounts` | List AOAI accounts in subscription |
| GET | `/api/azure/openai-deployments` | List deployments for an AOAI account |
| POST | `/api/llm/suggest-mapping` | AI-suggested column mapping |

### Assessment
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/assessment/config` | Get sizing config (series, regions, pricing) |
| GET | `/api/azure/vm-sizes` | Fetch VM SKU catalog for region |
| GET | `/api/assessment/prefetch-pricing` | Pre-cache pricing data |
| GET | `/api/assessment/prefetch-region` | Pre-cache SKUs for new region |
| POST | `/api/assessment/run` | Run sizing assessment (single env) |
| POST | `/api/assessment/run-multi` | Run multi-environment assessment |
| POST | `/api/assessment/recalculate` | Re-run with changed params |
| POST | `/api/assessment/recalculate-env` | Re-run single environment |
| GET | `/api/assessment/report` | Get latest assessment report |
| POST | `/api/upload-assessment` | Upload Azure Migrate report XLSX |

### Pricing
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/pricing/egress` | Fetch egress/bandwidth pricing |
| GET | `/api/pricing/backup` | Fetch backup pricing |
| GET | `/api/pricing/asr` | Fetch Azure Site Recovery pricing |
| GET | `/api/pricing/landing-zone` | Fetch Firewall + ExpressRoute pricing |

### Wave Plan
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/waveplan/detect-groups` | Detect grouping columns from inventory |
| POST | `/api/waveplan/generate` | Generate wave plan (rule-based, throughput caps) |
| POST | `/api/waveplan/update` | Apply manual/AI reassignments (rebuild timeline) |
| GET | `/api/waveplan/export-xlsx` | Download formatted XLSX (3 sheets) |
| POST | `/api/waveplan/llm-suggest` | Get AI wave assignments |

### Export
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/export/assessment-xlsx` | Export assessment report as XLSX |
| POST | `/api/export/bom-xlsx` | Export BOM as XLSX |

---

## 8. Configuration Files

### `wavePlanConfig.json`
- Wave plan UI defaults and constraints
- Throughput values: `pilotThroughputPerWeek`, `waveThroughputPerWeek`
- Grouping mode patterns (what column names map to what grouping type)
- Cost fields configuration

### `wavePlanLogic.json`
- Auto-assignment strategy (progressive-risk)
- Environment priority scoring (dev=1, prod=5)
- Criticality priority scoring
- LLM prompt templates with `{{placeholder}}` variables
- Fallback rules

### `SKUSizingLogic.json`
- Region configuration
- Right-sizing mode (as-allocated vs performance-based)
- Comfort factors for CPU/RAM
- SKU filtering rules (exclude retired, spot, promo)
- Disk mapping rules (Standard SSD default)
- Retail API pagination limits

### `prompts.json`
- LLM system/user prompts for column mapping suggestions
- Structured output format expectations

### `.llm-config.json` (auto-generated, gitignored)
- Persisted LLM endpoint, deployment name, auth mode
- Created when user configures AI via the settings panel

---

## 9. Frontend (public/app.js) Structure

### State Management
```javascript
const state = {
  currentStep: 1,
  sessionId: null,
  tokenId: null,
  subscriptionId: null,
  resourceGroup: null,
  projectName: null,
  bomData: null,
  llmConfigured: false,
  azureConnected: false,
  customerName: "",
  securityPricePerServer: null,
  lastSourceColumns: [],
  lastUploadData: null,
  stepsCompleted: { 1-7: false },
  assessmentReport: null,  // populated after assessment
};
```

### Key Functions by Step

| Step | Functions |
|------|-----------|
| 1 | `uploadFile(file)` |
| 2 | `populateResults(data)` |
| 3 | `loadSubscriptions()`, `loadResourceGroups()`, `createProject()` |
| 4 | `importToAzure()` |
| 5 | `uploadAssessment()`, `runLocalAssessment()` |
| 6 | `renderBOM(data)`, `exportBomXlsx()` |
| 7 | `initWavePlan()`, `showPilotGuidance()`, `updateCapacityGuidance()`, `renderWavePlan()`, `renderGantt()`, `renderWaveDetails()`, `checkBOMMatch()` |

### Helper Functions
- `escHtml(s)` — HTML entity escaping
- `fmtDateDisplay(isoStr)` — ISO to DD-MM-YYYY
- `showStatus(id, msg, type)` — Alert display helper
- `addLog(container, msg, type)` — Log entry helper
- `goToStep(n)` — Step navigation
- `updateWpLlmStatus()` — Polls LLM status for wave plan AI badge

---

## 10. How to Make Changes

### Adding a new API endpoint
1. Add route in `server.js` in the appropriate section (grouped by feature)
2. Access session via `sessions[req.body.sessionId]` or `sessions[req.query.sessionId]`
3. Return JSON response; use `res.status(4xx).json({error: "..."})` for errors

### Adding a new UI step
1. Add `<section class="panel" id="panelN">` in `index.html`
2. Add step indicator `<div class="step" data-step="N">` in the stepper
3. Add initialization logic in `goToStep(n)` case in `app.js`
4. Update `state.stepsCompleted` object

### Changing assessment logic
1. Edit `SKUSizingLogic.json` for sizing rules
2. Edit `assessment.js` for matching algorithm
3. Edit `assessmentConfig.js` for available options (series, regions)

### Changing wave plan logic
1. Edit `wavePlanConfig.json` for defaults and UI constraints
2. Edit `wavePlanLogic.json` for scoring and prompt templates
3. Edit `server.js` generate/update endpoints for assignment algorithm
4. Edit `app.js` render functions for display changes

### Adding LLM features
1. Add prompt to `prompts.json` or `wavePlanLogic.json`
2. Call `llmHelper.call(systemPrompt, userContent)` — returns null if not configured
3. Always have a local fallback (LLM is optional)

---

## 11. Conventions & Patterns

### Code Style
- No TypeScript, no build step — plain ES2020+ JS
- `const` by default, `let` when mutation needed
- Express routes grouped by feature with comment headers
- Frontend: vanilla JS, no framework, DOM manipulation with `getElementById`

### Error Handling
- Server: try/catch around async operations, return 4xx/5xx JSON errors
- Frontend: try/catch in async handlers, show error via `showStatus()` or alert div
- LLM: always graceful — `llmHelper.call()` returns null on failure

### Date Handling
- All internal dates: ISO format YYYY-MM-DD (string)
- Date arithmetic: `new Date()` + millisecond math (86400000 = 1 day)
- Display format: DD-MM-YYYY (converted at render time, not stored)

### Cost Rounding
- `round2(x)` helper: `Math.round(x * 100) / 100`
- All costs stored as numbers (not strings)
- Display: `toLocaleString(undefined, {minimumFractionDigits: 2})`

### File Exports
- XLSX via SheetJS (`XLSX.utils.json_to_sheet()` + `XLSX.writeFile()`)
- Server-side generation for proper formatting/column widths
- Frontend triggers via `window.open("/api/export/...")` or fetch + blob

### Security
- No secrets stored in code (Azure auth via CLI, LLM key in `.llm-config.json`)
- File upload: extension whitelist (.csv, .xlsx, .xls), 100MB limit
- No database — in-memory sessions, no SQL injection surface
- CORS: not configured (localhost only)

---

## 12. Running & Testing

### Start
```bash
cd "Migration TCO and BOM CLI Agent"
npm install        # first time
npm start          # or: node server.js
# Opens http://localhost:3000 automatically
```

### Start (skip Azure login prompt)
```bash
npm run quick      # or: node server.js --skip-setup
```

### Syntax Check
```bash
node -c server.js
node -c public/app.js
```

### Key Test Flows
1. **Upload only:** Upload CSV → Review → Download converted file (no Azure needed)
2. **Local assessment:** Upload → Accept → Skip Steps 3-4 → Run Local Assessment → BOM → Wave Plan
3. **Full flow:** Upload → Accept → Create Project → Import → Upload Report → BOM → Wave Plan
4. **Wave plan export:** Generate wave plan → Download XLSX → Download Gantt PNG

---

## 13. Known Constraints

- **No persistence:** Server restart loses all sessions (in-memory store)
- **Single user:** No authentication/multi-tenancy (designed for local use)
- **No WebSocket:** Frontend polls for LLM status, no real-time push
- **Memory:** Large inventories (10k+ servers) may slow down in-memory operations
- **CDN dependency:** Bootstrap + html2canvas loaded from CDN (needs internet)
- **Windows-centric:** `start.bat` for Windows; macOS/Linux use `npm start` directly

---

## 14. Dependencies (package.json)

```json
{
  "express": "^4.21.0",    // Web server
  "multer": "^2.1.1",      // File upload middleware
  "open": "^10.1.0",       // Auto-open browser on start
  "xlsx": "^0.18.5"        // Excel read/write (SheetJS)
}
```

No dev dependencies. No build tools. Production-ready as-is.

---

## 15. Glossary

| Term | Meaning |
|------|---------|
| BOM | Bill of Materials — full cost breakdown per server |
| TCO | Total Cost of Ownership |
| LZ | Landing Zone — Azure infrastructure (VNet, policies, etc.) |
| Wave 0 | Foundation + Pilot phase (LZ setup + initial migration) |
| Wave N | Production migration batch |
| AHUB | Azure Hybrid Benefit (use existing Windows licenses) |
| RI | Reserved Instance (1yr or 3yr commitment discount) |
| PAYG | Pay As You Go (no commitment) |
| SKU | Stock Keeping Unit — specific VM size (e.g., Standard_D4s_v5) |
| Comfort Factor | Multiplier for headroom in sizing (e.g., 1.3 = 30% buffer) |
| Throughput | Migration velocity in VMs per week |
| Over Capacity | Wave has more VMs than can be migrated in its duration |

---

*Last updated: June 2026*
