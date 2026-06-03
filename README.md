<p align="center">
  <h1 align="center">🩺 Dr. BOM Agent</h1>
  <p align="center">
    <strong>Azure Migrate Assessment, TCO Analysis, BOM Builder & Wave Planner</strong>
  </p>
  <p align="center">
    A self-contained local web tool for end-to-end Azure migration planning — from raw server inventory to a fully costed Bill of Materials and migration wave schedule.
  </p>
  <p align="center">
    <a href="#-quick-start">Quick Start</a> •
    <a href="#-features">Features</a> •
    <a href="#-screenshots">Screenshots</a> •
    <a href="#-how-it-works">How It Works</a> •
    <a href="#-contributing">Contributing</a>
  </p>
</p>

---

## ⚡ Quick Start

### One-liner (Download + Run)

> **Requires:** [Node.js](https://nodejs.org/) v18+ and [Git](https://git-scm.com/)

```bash
git clone https://github.com/mohammad234/dr-bom-agent.git && cd dr-bom-agent && npm install && npm start
```

The browser opens automatically at **http://localhost:3000**

### Windows (Double-click)

1. Download or clone this repo
2. Double-click **`start.bat`**

That's it. It handles Node.js detection, dependency installation, and browser launch.

### Manual Steps

```bash
# Clone the repository
git clone https://github.com/mohammad234/dr-bom-agent.git
cd dr-bom-agent

# Install dependencies
npm install

# Start the application
npm start
```

---

## 🎯 Features

| Capability | Description |
|------------|-------------|
| **Inventory Conversion** | Upload any server inventory (CSV/XLSX) → auto-maps to Azure Migrate import format |
| **Local Assessment Engine** | Right-size VMs using Azure Retail Prices API (no Azure subscription needed for pricing) |
| **Full BOM Generation** | Compute, Storage, Security, Firewall, ExpressRoute, Egress, Backup — per-server and total |
| **Wave Plan Builder** | Throughput-based capacity planning with timeline, Gantt chart, and configurable grouping |
| **AI-Assisted Planning** | Optional Azure AI Foundary integration for intelligent wave assignment |
| **Multi-Format Export** | Excel (.xlsx) exports with formatting, Gantt PNG download, CSV fallback |
| **Zero Config Auth** | Uses existing `az login` session — no App Registration or secrets needed |

---

## 📸 Screenshots

> *Add screenshots of your tool here after first run*

---

## 🏗 How It Works

Dr. BOM Agent is a **7-step wizard** that guides you through the full migration planning lifecycle:

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Step 1      Step 2      Step 3       Step 4      Step 5     Step 6     Step 7     │
│  Upload  →  Review  →  Az Migrate → Import  →  Assess  →  BOM    →  Wave Plan   │
│  CSV/XLSX   Mapping     (optional)   (optional)  Sizing     Costing    Timeline   │
└──────────────────────────────────────────────────────────────────────────┘
```

| Step | What Happens |
|------|--------------|
| **1. Upload** | Upload server inventory. Columns are auto-mapped to Azure Migrate format. Invalid rows are flagged with reasons. |
| **2. Review** | Verify column mapping, see valid/excluded server counts, download the converted CSV. |
| **3. Azure Migrate** *(optional)* | Create a Resource Group + Azure Migrate project in your subscription. |
| **4. Import** *(optional)* | Import converted inventory into Azure Migrate for cloud-based assessment. |
| **5. Assessment** | Upload Azure Migrate report OR run local sizing (uses Retail Prices API — free, no subscription). |
| **6. BOM** | Full Bill of Materials with per-server cost breakdown. Export to Excel. |
| **7. Wave Plan** | Configure migration waves with throughput capacity planning. Export timeline + Gantt chart. |

> **Steps 3–4 are optional.** You can skip Azure integration entirely and use the built-in local assessment engine.

---

## 📋 Prerequisites

| Requirement | When Needed | Install |
|-------------|-------------|---------|
| **Node.js** v18+ | Always | [nodejs.org](https://nodejs.org/) |
| **Azure CLI** | Steps 3–4 only | [aka.ms/installazurecli](https://aka.ms/installazurecli) |
| Modern browser | Always | Edge, Chrome, or Firefox |
| Azure subscription | Steps 3–4 only | [azure.com/free](https://azure.com/free) |

### Azure Resource Providers (for Steps 3–4 only)

If using Azure Migrate integration, ensure these are registered on your subscription:

```
Microsoft.Migrate
Microsoft.OffAzure
Microsoft.KeyVault
```

---

## 🔐 Authentication

### Azure (for Steps 3–5)

**No App Registration required.** Dr. BOM Agent uses the Azure CLI for authentication.

```bash
# Just sign in once — the tool picks up your session automatically
az login
```

From the web UI, click **"Login to Azure"** in the Settings panel if you skipped the CLI prompt.

### Azure OpenAI (Optional — AI Features)

AI features support two auth modes:

| Mode | Setup |
|------|-------|
| **API Key** | Enter endpoint + deployment name + API key in Settings |
| **Azure AD Token** | Enter endpoint + deployment name only (uses your `az login` token) |

For token auth, your account needs the **Cognitive Services OpenAI User** role on the Azure OpenAI resource.

<details>
<summary>How to find your deployment name</summary>

1. Go to [Azure AI Foundry](https://ai.azure.com) → **Deployments**
2. Find your model (e.g., `gpt-4o`)
3. Copy the **Deployment name** from the table

If you paste the full endpoint URL (e.g., `https://x.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=...`), the tool auto-extracts the deployment name.

</details>

---

## 💰 BOM Cost Categories

| Category | Source | Sharing Model |
|----------|--------|---------------|
| Compute | VM SKU monthly cost (RI or PAYG) | Per server |
| Storage | Managed Disk tier pricing | Per server |
| Security | Microsoft Defender for Servers P2 | Per server |
| Azure Firewall | Standard tier (~$912/mo + data) | Shared (amortized) |
| ExpressRoute | Circuit + Gateway | Shared (amortized) |
| Egress | Bandwidth pricing × estimated throughput | Per server |
| Backup | Instance fee + storage tier | Per server |
| Windows License | *(Left for sales rep — AHUB toggle available)* | Per server |
| SQL License | *(Left for sales rep)* | Per server |

---

## 📅 Wave Plan — Throughput Formula

The wave planner uses a **capacity-based model** to ensure realistic migration timelines:

```
Pilot capacity  = pilotDurationWeeks × pilotThroughput (VMs/week)
Wave capacity   = waveDurationWeeks  × waveThroughput  (VMs/week)
Total capacity  = pilotCapacity + (numWaves × waveCapacity)
```

**Defaults:** Pilot = 10 VMs/week, Waves = 30 VMs/week

Waves that exceed capacity are flagged with warnings. The formula is fully configurable in the UI.

### Wave Structure

- **Wave 0 (Foundation):** Landing Zone Design → LZ Provisioning → Pilot Migration
- **Waves 1–N:** Production migration batches, balanced by server count

### Grouping Options

The tool auto-detects grouping columns from your inventory (Application, Environment, Tier, etc.) and offers:
- Rule-based assignment (progressive risk — dev first, prod last)
- AI-assisted assignment (provide instructions in natural language)
- Even distribution (no grouping, split by count)

---

## 📁 Project Structure

```
dr-bom-agent/
├── server.js              # Express backend — all API routes
├── assessment.js          # VM SKU sizing engine (Retail Prices API)
├── assessmentConfig.js    # VM series, pricing models, regions
├── columnMapping.js       # Inventory → Azure Migrate column mapping
├── llmHelper.js           # Azure OpenAI integration (optional)
├── cliSetup.js            # Interactive CLI startup prompts
├── package.json           # Dependencies & scripts
├── start.bat              # Windows one-click launcher
├── SKUSizingLogic.json    # Right-sizing configuration
├── wavePlanConfig.json    # Wave plan defaults & throughput settings
├── wavePlanLogic.json     # Auto-assignment rules & LLM prompts
├── prompts.json           # LLM prompt templates
├── PROJECT_CONTEXT.md     # Full technical reference (for developers)
├── public/
│   ├── index.html         # Single-page wizard UI
│   ├── app.js             # Frontend logic
│   └── style.css          # Custom styles
├── uploads/               # Temporary upload directory
└── output/                # Session output (per-session UUID folders)
```

---

## ⚙️ Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AZURE_TENANT_ID` | `organizations` | Azure AD tenant (multi-tenant by default) |

### Key Config Files

| File | Purpose |
|------|---------|
| `SKUSizingLogic.json` | VM sizing rules, comfort factors, region, disk defaults |
| `wavePlanConfig.json` | Wave plan UI defaults, throughput values, grouping patterns |
| `wavePlanLogic.json` | Assignment strategy, priority scoring, LLM prompts |

---

## 🧪 Development

```bash
# Syntax check
node -c server.js && node -c public/app.js

# Start with auto-restart (install nodemon globally first)
npx nodemon server.js

# Skip Azure login prompt during development
node server.js --skip-setup
```

### Architecture Notes

- **No build step** — vanilla JS frontend, no bundler
- **No database** — in-memory sessions (restart clears state)
- **No external dependencies** beyond the 4 in package.json
- **All pricing data** fetched from Azure Retail Prices API (public, no auth needed)
- **LLM is optional** — every AI feature has a local fallback

For full technical documentation, see [`PROJECT_CONTEXT.md`](PROJECT_CONTEXT.md).

---

## 🛡️ Privacy & Security

- **All data stays local.** No telemetry, no external analytics.
- Azure APIs are called **only** when you explicitly trigger Steps 3–5 or use the pricing engine.
- LLM calls (if configured) send only column names or server group summaries — never raw inventory data.
- No secrets are stored in code. LLM config is saved locally in `.llm-config.json` (gitignored).

---

## 🐛 Troubleshooting

| Issue | Solution |
|-------|----------|
| `npm: command not found` | Install Node.js from [nodejs.org](https://nodejs.org) |
| Port 3000 already in use | Set `PORT=3001` or kill the existing process |
| Browser doesn't open | Navigate manually to http://localhost:3000 |
| Azure login popup blocked | Allow popups for localhost in your browser |
| Assessment upload fails | Upload the `Strategy_Lift_and_shift.xlsx` from Azure Migrate detailed report |
| LLM not responding | Verify endpoint, deployment name, and RBAC role. Check `az account get-access-token` works |

---

## 🤝 Contributing

Contributions are welcome! Here's how:

1. **Fork** this repository
2. **Create a branch** (`git checkout -b feature/my-feature`)
3. **Make your changes** (see `PROJECT_CONTEXT.md` for architecture details)
4. **Test locally** (`node -c server.js && npm start`)
5. **Submit a Pull Request**

### Ideas for Contribution

- [ ] Add more Azure regions to `assessmentConfig.js`
- [ ] Support AWS/GCP inventory formats in `columnMapping.js`
- [ ] Add database persistence (SQLite) for sessions
- [ ] Dark mode toggle
- [ ] PDF export for wave plan
- [ ] Docker containerization
- [ ] Multi-language support

---

## 📄 License

This project is open source. See [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [Azure Retail Prices API](https://learn.microsoft.com/en-us/rest/api/cost-management/retail-prices/azure-retail-prices) — free public pricing data
- [SheetJS](https://sheetjs.com/) — Excel file processing
- [Bootstrap](https://getbootstrap.com/) — UI framework
- [html2canvas](https://html2canvas.hertzen.com/) — Gantt chart export

---

<p align="center">
  Built with ❤️ for the Azure migration community
</p>
