const express = require("express");
const multer = require("multer");
const XLSX = require("xlsx");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const columnMapping = require("./columnMapping");
const llmHelper = require("./llmHelper");
const { runSetup } = require("./cliSetup");
const { buildLandingZoneDiagram } = require("./architectureDiagram");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// File upload config
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".csv", ".xlsx", ".xls"].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV and Excel files are allowed"));
    }
  },
});

// Azure config
const AZURE_CONFIG = {
  // Azure CLI public client ID - no app registration needed
  clientId: process.env.AZURE_CLIENT_ID || "04b07795-a710-4e24-aab2-7f4ff3b80bab",
  tenantId: process.env.AZURE_TENANT_ID || "organizations",
  redirectUri: `http://localhost:${PORT}/auth/callback`,
  scope: "https://management.azure.com/.default offline_access openid profile",
};

// In-memory session store
const sessions = {};

// Pre-auth token from CLI device code flow (if successful)
let preAuthToken = null;

// Persistent local config file for LLM settings
const LOCAL_CONFIG_PATH = path.join(__dirname, ".llm-config.json");

function loadLocalConfig() {
  let rawResponseText = null;
  let refinedRawText = null;
  let debugFilePath = null;
  try {
    if (fs.existsSync(LOCAL_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, "utf-8"));
    }
  } catch {}
  return {};
}

function saveLocalConfig(config) {
  const existing = loadLocalConfig();
  const merged = { ...existing, ...config };
  fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

// ============ SESSION PERSISTENCE ============
const SESSIONS_DIR = path.join(__dirname, "saved_sessions");
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/**
 * Save session to disk. Called automatically after key steps complete.
 * Saves by assessment name (sanitized). Overwrites if same name.
 */
function saveSessionToDisk(sessionId) {
  const session = sessions[sessionId];
  if (!session) return;

  const name = session.customerName || session.assessmentName || sessionId;
  const safeName = name.replace(/[^a-zA-Z0-9_\-\s]/g, "").replace(/\s+/g, "_").substring(0, 80);
  const filePath = path.join(SESSIONS_DIR, `${safeName}.json`);

  // Build saveable data (exclude large caches like vmSizes — they can be refetched)
  const saveData = {
    sessionId,
    savedAt: new Date().toISOString(),
    customerName: session.customerName || "",
    assessmentName: session.assessmentName || "",
    sourceFile: session.sourceFile || "",
    sourceColumns: session.sourceColumns || [],
    sourceData: session.sourceData || [],
    originalData: session.originalData || [],
    totalRows: session.totalRows || 0,
    validCount: session.validCount || 0,
    invalidCount: session.invalidCount || 0,
    environments: session.environments || [],
    envColumn: session.envColumn || null,
    assessmentReport: session.assessmentReport || null,
    envAssessments: session.envAssessments || null,
    lastMatchedServers: session.lastMatchedServers || null,
    lastSecurityPrice: session.lastSecurityPrice || null,
    lastEnabledSeries: session.lastEnabledSeries || null,
    lastCpuArchitecture: session.lastCpuArchitecture || null,
    wavePlan: session.wavePlan || null,
    bomData: session.bomData || null,
    lzConfig: session.lzConfig || null,
    bcdrConfig: session.bcdrConfig || null,
    // Track what steps are complete
    stepsCompleted: {
      upload: !!(session.sourceData && session.sourceData.length),
      assessment: !!session.assessmentReport,
      lzBcdr: !!(session.lzConfig || session.bcdrConfig),
      bom: !!session.bomData,
      wavePlan: !!session.wavePlan,
    },
  };

  try {
    fs.writeFileSync(filePath, JSON.stringify(saveData), "utf-8");
    console.log(`[Session] Saved: ${safeName} (${filePath})`);
  } catch (err) {
    console.error(`[Session] Save failed: ${err.message}`);
  }
}

/**
 * List all saved sessions (metadata only).
 */
function listSavedSessions() {
  try {
    const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
    return files.map(f => {
      try {
        const filePath = path.join(SESSIONS_DIR, f);
        const raw = fs.readFileSync(filePath, "utf-8");
        // Read only first 2000 chars for metadata (avoid parsing huge files fully)
        const data = JSON.parse(raw);
        return {
          fileName: f,
          sessionId: data.sessionId,
          customerName: data.customerName || f.replace(".json", ""),
          assessmentName: data.assessmentName || "",
          savedAt: data.savedAt,
          totalRows: data.totalRows || 0,
          sourceFile: data.sourceFile || "",
          stepsCompleted: data.stepsCompleted || {},
        };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => (b.savedAt || "").localeCompare(a.savedAt || ""));
  } catch { return []; }
}

/**
 * Load a saved session back into memory.
 */
function loadSessionFromDisk(fileName) {
  const filePath = path.join(SESSIONS_DIR, fileName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    // Restore into a new session ID
    const newSessionId = data.sessionId || crypto.randomUUID();
    sessions[newSessionId] = {
      sourceFile: data.sourceFile,
      sourceColumns: data.sourceColumns,
      sourceData: data.sourceData,
      originalData: data.originalData,
      totalRows: data.totalRows,
      validCount: data.validCount,
      invalidCount: data.invalidCount,
      environments: data.environments,
      envColumn: data.envColumn,
      assessmentReport: data.assessmentReport,
      envAssessments: data.envAssessments,
      lastMatchedServers: data.lastMatchedServers,
      lastSecurityPrice: data.lastSecurityPrice,
      lastEnabledSeries: data.lastEnabledSeries,
      lastCpuArchitecture: data.lastCpuArchitecture,
      wavePlan: data.wavePlan,
      bomData: data.bomData,
      lzConfig: data.lzConfig,
      bcdrConfig: data.bcdrConfig,
      customerName: data.customerName,
      assessmentName: data.assessmentName,
    };
    return { sessionId: newSessionId, data };
  } catch (err) {
    console.error(`[Session] Load failed: ${err.message}`);
    return null;
  }
}

// Template headers
const TEMPLATE_CSV = path.join(__dirname, "AzureMigrateimporttemplate.csv");
const templateContent = fs.readFileSync(TEMPLATE_CSV, "utf-8");
const templateHeaders = templateContent.split("\n")[0].split(",").map(h => h.trim());

// ============ INVENTORY PARSING (generic, works with any source file) ============

// Detect the header row in a sheet by scanning the first ~10 rows and picking the one
// that looks most like a header: mostly string cells, few numbers, plenty of cells filled,
// and ideally containing common inventory-header keywords.
function detectHeaderRowIndex(aoa) {
  const HEADER_KEYWORDS = /\b(host|server|vm|name|ip|address|os|operating|cpu|core|ram|memory|disk|storage|hdd|hostname|environment|tier|application|business)\b/i;
  const maxScan = Math.min(10, aoa.length);
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < maxScan; i++) {
    const row = aoa[i] || [];
    const filled = row.filter(c => c !== null && c !== undefined && String(c).trim() !== "");
    if (filled.length === 0) continue;
    let strings = 0, numbers = 0, keywordHits = 0;
    for (const c of filled) {
      if (typeof c === "number") numbers++;
      else {
        strings++;
        if (HEADER_KEYWORDS.test(String(c))) keywordHits++;
      }
    }
    // Score: heavily reward keyword hits and string ratio, penalize numbers.
    const score = keywordHits * 10 + strings - numbers * 3 + filled.length * 0.1;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

// Parse one sheet into row objects using auto-detected header row.
function parseSheetGeneric(sheet, sheetName) {
  const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, blankrows: false, defval: null });
  if (!aoa.length) return [];
  const headerIdx = detectHeaderRowIndex(aoa);
  // Collapse internal whitespace (incl. embedded \r\n from merged-cell artifacts) so the
  // same logical column name doesn't appear twice across sheets and renders cleanly in UI.
  const cleanName = (h, i) => {
    const s = (h == null ? "" : String(h)).replace(/\s+/g, " ").trim();
    return s || `Column ${i + 1}`;
  };
  const headers = (aoa[headerIdx] || []).map(cleanName);
  // De-duplicate any colliding cleaned names by suffixing the duplicates.
  const seen = new Map();
  const finalHeaders = headers.map(h => {
    const n = (seen.get(h) || 0) + 1;
    seen.set(h, n);
    return n === 1 ? h : `${h} (${n})`;
  });
  const rows = [];
  for (let r = headerIdx + 1; r < aoa.length; r++) {
    const row = aoa[r] || [];
    if (row.every(c => c === null || c === undefined || String(c).trim() === "")) continue;
    const obj = {};
    for (let c = 0; c < finalHeaders.length; c++) {
      obj[finalHeaders[c]] = row[c] == null ? "" : row[c];
    }
    obj._sheet = sheetName;
    rows.push(obj);
  }
  return rows;
}

// Parse the entire workbook (all sheets), merging rows. Each row carries `_sheet` so
// downstream wave-planning can use it as a free environment/site tag.
function parseWorkbookGeneric(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".csv") {
    const wb = XLSX.readFile(filePath, { type: "file" });
    const sn = wb.SheetNames[0];
    const rows = parseSheetGeneric(wb.Sheets[sn], sn || "Sheet1");
    return { rows, sheetSummary: [{ sheet: sn, rowCount: rows.length }] };
  }
  const wb = XLSX.readFile(filePath);
  const merged = [];
  const sheetSummary = [];
  for (const sn of wb.SheetNames) {
    const rows = parseSheetGeneric(wb.Sheets[sn], sn);
    sheetSummary.push({ sheet: sn, rowCount: rows.length });
    merged.push(...rows);
  }
  return { rows: merged, sheetSummary };
}

// ============ AUTO COLUMN MAPPING (synonym + unit detection) ============

function buildAutoMapping(sourceColumns, sampleRows) {
  const cols = sourceColumns;
  // Normalize a column name for pattern matching:
  //   "Provisioned Capacity\nGB" -> "provisioned capacity gb"
  //   "sourceCpuCoreCount"        -> "source cpu core count"
  //   "RAM (MB)"                  -> "ram mb"
  // This lets the same pattern catch space-separated, snake_case, and camelCase columns.
  function norm(s) {
    return String(s)
      .replace(/([a-z])([A-Z])/g, "$1 $2")     // camelCase -> camel Case
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2") // ABCDef   -> ABC Def
      .replace(/([a-zA-Z])(\d)/g, "$1 $2")     // letter+digit -> letter digit (Daily95 -> Daily 95)
      .replace(/(\d)([a-zA-Z])/g, "$1 $2")     // digit+letter -> digit letter (95th -> 95 th)
      .replace(/[_\-./\\]+/g, " ")
      .replace(/[()\[\]]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }
  // Sort so source* candidates come before target* (current-state preferred over planned).
  const colsRanked = cols.slice().sort((a, b) => {
    const an = norm(a), bn = norm(b);
    const aTarget = an.startsWith("target ") || an.startsWith("target");
    const bTarget = bn.startsWith("target ") || bn.startsWith("target");
    if (aTarget !== bTarget) return aTarget ? 1 : -1;
    return cols.indexOf(a) - cols.indexOf(b);
  });
  // Return ALL columns matching any of the patterns (preserve `cols` order).
  // Multi-sheet workbooks may carry different header names per sheet (e.g. CAH PROD has
  // "Memory" while DR has "Memory (GB)"); we must resolve per-row, not globally.
  const findAll = (...patterns) => {
    const matched = [];
    for (const c of colsRanked) {
      const n = norm(c);
      for (const p of patterns) {
        const re = p instanceof RegExp ? p : new RegExp(p, "i");
        if (re.test(c) || re.test(n)) { matched.push(c); break; }
      }
    }
    return matched;
  };
  const first = arr => (arr && arr.length ? arr[0] : null);

  // Patterns are matched against both the original and the normalized form.
  const nameCols     = findAll(/^host\s*name$/i, /^hostname$/i, /^server\s*name$/i, /^vm\s*name$/i, /^server$/i, /^name$/i, /^asset\s*name$/i, /computer\s*name/i);
  const ipCols       = findAll(/^ip\s*address(es)?$/i, /^collected\s*ip\s*address$/i, /\bipv?4?\b/i);
  const cpuCountCols = findAll(/^cpu\s*count$/i, /^sockets?$/i, /^socket\s*count$/i);
  const cpuCoresCols = findAll(/^source\s*cpu\s*core\s*count$/i, /^cpu\s*core\s*count$/i, /^core\s*count$/i, /cores?\s*per\s*socket/i, /^vcpu(s)?$/i, /^cores?$/i, /^cpu$/i, /^target\s*cpu\s*core\s*count$/i);
  const cpuThreadCols= findAll(/threads?\s*per\s*core/i, /cpu\s*core\s*thread/i, /^threads?$/i);
  const memCols      = findAll(/^source\s*memory\s*in\s*mb$/i, /^ram\s*mb$/i, /^memory\s*mb$/i, /^ram\s*gb$/i, /^memory\s*gb$/i, /^ram$/i, /^memory$/i, /^target\s*memory\s*in\s*mb$/i);
  const osCols       = findAll(/^operating\s*system$/i, /^os\s*name$/i, /^os$/i);
  const osVerCols    = findAll(/^os\s*version$/i, /version.*\bos\b|\bos\b.*version/i);
  const isVirtCols   = findAll(/^is\s*virtual$/i, /^is\s*physical$/i, /^is\s*linux$/i, /\bvirtual\?$/i);
  const mfgCols      = findAll(/^manufacturer$/i, /^hypervisor$/i, /virtuali[sz]ation\s*platform/i, /azure\s*stack\s*host/i);
  const descCols     = findAll(/^description$/i, /^model$/i, /^cpu\s*type$/i, /^os\s*name$/i);
  // Utilization columns: feed performance-based right-sizing (industry-standard formula
  // applies floor at 20%, falls back to as-allocated if missing or zero).
  // Patterns include "usage" + "utilization" + percentile variants. Within the matched
  // set, sortByPercentilePreference re-orders so the 95th-percentile column wins (which
  // is what Azure Migrate uses for its performance-based recommendation).
  const cpuUtilRaw = findAll(
    /^cpu\s*utilization\s*percentage$/i,
    /cpu\s*util(i[sz]ation)?(\s*%|\s*percent(age)?)?/i,
    /cpu\s*usage(\s*percent(age)?)?/i,
    /(p95|p99|95th|99th|peak|avg|average|median)\s*cpu/i,
    /cpu.*\b(p95|p99|95th|99th|peak|avg|average|median)\b/i,
    /\bcpu\s*%$/i,
  );
  const memUtilRaw = findAll(
    /^memory\s*utilization\s*percentage$/i,
    /(memory|ram|mem)\s*util(i[sz]ation)?(\s*%|\s*percent(age)?)?/i,
    /(memory|ram|mem)\s*usage(\s*percent(age)?)?/i,
    /(p95|p99|95th|99th|peak|avg|average|median)\s*(memory|ram|mem)/i,
    /(memory|ram|mem).*\b(p95|p99|95th|99th|peak|avg|average|median)\b/i,
    /\b(memory|ram|mem)\s*%$/i,
  );
  // Prefer 95th percentile > 99th > peak > average > median > anything else. This matches
  // Azure Migrate's performance-based sizing methodology (95th percentile of telemetry).
  function rankUtil(col) {
    const n = norm(col);
    if (/\b(95\s*th|p\s*95|95\b)\b/.test(n)) return 0;
    if (/\b(99\s*th|p\s*99|99\b)\b/.test(n)) return 1;
    if (/\bpeak\b/.test(n)) return 2;
    // Check median BEFORE avg, since these inventories often prefix every util
    // column with "avg" (= "average over the day"), so "avg" alone is the weakest signal.
    if (/\bmedian\b/.test(n)) return 4;
    if (/\b(avg|average)\b/.test(n)) return 3;
    return 5;
  }
  const cpuUtilCols = cpuUtilRaw.slice().sort((a, b) => rankUtil(a) - rankUtil(b));
  const memUtilCols = memUtilRaw.slice().sort((a, b) => rankUtil(a) - rankUtil(b));
  const diskCols     = findAll(
    /^source\s*drive\s*total\s*capacity(\s*in\s*gb)?$/i,
    /^target\s*drive\s*total\s*capacity\s*in\s*gb$/i,
    /^provisioned\s*capacity(\s*gb)?$/i,
    /^used\s*size\s*gb$/i,
    /^disk\s*space\s*gb$/i,
    /total\s*assigned\s*hdd/i,
    /disk\s*combined.*gb/i,
    /^disk\s*combined$/i,
    /^total\s*storage/i,
    /^storage$/i,
  );
  // Multi-disk source columns: "Disk 1 (MB)", "Disk 2 (GB)", "Disk 14 (MB)" etc.
  // We sum all non-empty values into Storage and use the count for Number of disks.
  const multiDiskCols = cols.filter(c => /^disk\s*\d+\b/i.test(norm(c)));

  // Pick a non-empty value across an ordered list of candidate columns.
  function pickValue(row, candidates) {
    for (const c of candidates) {
      const v = row[c];
      if (v !== undefined && v !== null && String(v).trim() !== "") return { col: c, value: v };
    }
    return null;
  }
  // Sniff a value's unit from its raw form: "1.2 TB" / "756.9 GB" / "8192" (MB) / "8" (GB).
  function parseSizeWithUnit(raw, defaultUnit) {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    const m = s.match(/^([\d.]+)\s*(tb|gb|mb|kb)?\s*$/i);
    if (!m) return null;
    const v = parseFloat(m[1]);
    if (isNaN(v)) return null;
    const unit = (m[2] || defaultUnit || "").toUpperCase();
    if (unit === "TB") return { mb: v * 1024 * 1024, gb: v * 1024 };
    if (unit === "GB") return { mb: v * 1024, gb: v };
    if (unit === "MB") return { mb: v, gb: v / 1024 };
    if (unit === "KB") return { mb: v / 1024, gb: v / (1024 * 1024) };
    return null;
  }
  function unitOfCol(col, sampleRows, defaultUnit) {
    if (!col) return defaultUnit;
    const n = norm(col);
    if (/\bgb\b/.test(n) || /\bin\s*gb\b/.test(n)) return "GB";
    if (/\bmb\b/.test(n) || /\bin\s*mb\b/.test(n)) return "MB";
    const vals = (sampleRows || []).map(r => parseFloat(r[col])).filter(n => !isNaN(n) && n > 0);
    if (vals.length === 0) return defaultUnit;
    const sorted = vals.slice().sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    return median < 512 ? "GB" : "MB";
  }

  // Aliases used in the UI summary — point at the first matching column.
  const nameCol = first(nameCols), ipCol = first(ipCols), cpuCountCol = first(cpuCountCols),
        cpuCoresCol = first(cpuCoresCols), cpuThreadCol = first(cpuThreadCols),
        memCol = first(memCols), osCol = first(osCols), osVerCol = first(osVerCols),
        isVirtCol = first(isVirtCols), mfgCol = first(mfgCols), descCol = first(descCols),
        diskCol = first(diskCols);
  const memUnit = unitOfCol(memCol, sampleRows, "MB");
  const diskUnit = unitOfCol(diskCol, sampleRows, "GB");

  const mapping = {
    "*Server name": (row) => {
      const r = pickValue(row, nameCols); return r ? r.value : "";
    },
    "IP addresses": (row) => {
      const r = pickValue(row, ipCols); return r ? r.value : "";
    },
    "*Cores": (row) => {
      const cnt = pickValue(row, cpuCountCols);
      const core = pickValue(row, cpuCoresCols);
      const thr = pickValue(row, cpuThreadCols);
      if (cnt && core && thr) {
        return (parseInt(cnt.value) || 0) * (parseInt(core.value) || 1) * (parseInt(thr.value) || 1);
      }
      if (core) return parseInt(core.value) || 0;
      if (cnt) return parseInt(cnt.value) || 0;
      return 0;
    },
    "*Memory (In MB)": (row) => {
      const r = pickValue(row, memCols);
      if (!r) return 0;
      const v = parseFloat(r.value) || 0;
      // Per-column unit so a workbook mixing "Memory" (GB) and "RAM (MB)" works correctly.
      let unit;
      if (/gb/i.test(r.col)) unit = "GB";
      else if (/mb/i.test(r.col)) unit = "MB";
      else unit = v > 0 && v < 512 ? "GB" : "MB";
      return unit === "GB" ? Math.round(v * 1024) : Math.round(v);
    },
    "OS version": (row) => {
      const r = pickValue(row, osVerCols); return r ? r.value : "";
    },
    "*OS name": (row) => {
      const os = pickValue(row, osCols);
      const ver = pickValue(row, osVerCols);
      return `${os ? os.value : ""} ${ver ? ver.value : ""}`.toString().trim();
    },
    "OS architecture": (row) => {
      const desc = pickValue(row, descCols);
      const text = String(desc ? desc.value : "").toLowerCase();
      if (text.includes("x86_64") || text.includes("amd64") || text.includes("64-bit") || text.includes("64bit")) return "x64";
      if (text.includes("i686") || text.includes("i386") || text.includes("32-bit") || text.includes("32bit")) return "x86";
      return "";
    },
    "Server type": (row) => {
      const r = pickValue(row, isVirtCols);
      if (r) {
        const v = String(r.value).toUpperCase();
        if (v === "TRUE" || v === "YES" || v === "Y" || v === "1" || v === "VIRTUAL") return "Virtual";
        if (v === "FALSE" || v === "NO" || v === "N" || v === "0" || v === "PHYSICAL") return "Physical";
      }
      return "Virtual";
    },
    "Hypervisor": (row) => {
      const m = pickValue(row, mfgCols);
      const text = (m ? String(m.value) : "").toLowerCase();
      const sheet = String(row._sheet || "").toLowerCase();
      const blob = `${text} ${sheet}`;
      if (blob.includes("vmware") || blob.includes("esxi") || blob.includes("vsphere")) return "Vmware";
      if (blob.includes("hyper-v") || blob.includes("hyperv") || blob.includes("microsoft") || blob.includes("azure stack") || blob.includes("azhci")) return "Hyper-V";
      if (blob.includes("xen")) return "Xen";
      return "";
    },
    "Storage in use (In GB)": (row) => {
      const r = pickValue(row, diskCols);
      if (!r) return "";
      const v = parseFloat(r.value) || 0;
      const unit = /mb/i.test(r.col) ? "MB" : "GB";
      return unit === "MB" ? Math.round(v / 1024) : v;
    },
    "Number of disks": () => "1",
    "Disk 1 size (In GB)": (row) => {
      const r = pickValue(row, diskCols);
      if (!r) return "";
      const v = parseFloat(r.value) || 0;
      const unit = /mb/i.test(r.col) ? "MB" : "GB";
      return unit === "MB" ? Math.round(v / 1024) : v;
    },
  };

  const detected = {
    nameCol, ipCol, cpuCountCol, cpuCoresCol, cpuThreadCol, memCol, memUnit,
    osCol, osVerCol, isVirtCol, mfgCol, descCol, diskCol, diskUnit,
    // Full candidate lists so baseline spec preserves cross-sheet variants.
    nameCols, ipCols, cpuCountCols, cpuCoresCols, cpuThreadCols, memCols,
    osCols, osVerCols, isVirtCols, mfgCols, descCols, diskCols,
    multiDiskCols,
    cpuUtilCols, memUtilCols,
  };
  return { mapping, detected };
}

// Choose the best mapping: prefer the static ABMB mapping ONLY when ALL of its expected
// source columns are present (legacy customer); otherwise use the auto-detected mapping.
function pickMappingForColumns(sourceColumns, sampleRows) {
  const STATIC_REQUIRED = ["Host name", "CPU count", "CPU core count", "RAM (MB)", "Operating System"];
  const allPresent = STATIC_REQUIRED.every(c => sourceColumns.includes(c));
  if (allPresent) return { mapping: columnMapping, source: "static (ABMB legacy)", detected: null };
  const auto = buildAutoMapping(sourceColumns, sampleRows);
  return { mapping: auto.mapping, source: "auto-detected", detected: auto.detected };
}

// ============ MAPPING SPEC: structured, JSON-friendly, hydratable ============
// Spec shape per target column:
//   { columns: [...], operation: "first" | "concat" | "product", unit?: "MB"|"GB" }
//   { operation: "static", value: "..." }
//   null  (skip)
// This is the format the AI returns AND the format we send back to the UI for editing.

const REQUIRED_TARGETS = ["*Server name", "*Cores", "*Memory (In MB)", "*OS name"];

function pickValueFromRow(row, candidates) {
  for (const c of candidates || []) {
    const v = row[c];
    if (v !== undefined && v !== null && String(v).trim() !== "") return { col: c, value: v };
  }
  return null;
}

// Convert a buildAutoMapping `detected` summary into the spec shape used everywhere else.
// Preserves ALL detected candidate columns per target so cross-sheet variants (e.g. CAH
// PROD's "Memory" + DR's "Memory (GB)") can both resolve at runtime.
function buildBaselineSpec(detected, sourceColumns) {
  if (!detected) return null;
  const srcSet = new Set(sourceColumns);
  const filt = (arr) => (arr || []).filter(c => srcSet.has(c));
  const nameCols = filt(detected.nameCols);
  const ipCols = filt(detected.ipCols);
  const cpuCntCols = filt(detected.cpuCountCols);
  const cpuCoreCols = filt(detected.cpuCoresCols);
  const cpuThrCols = filt(detected.cpuThreadCols);
  const memCols = filt(detected.memCols);
  const osCols = filt(detected.osCols);
  const osVerCols = filt(detected.osVerCols);
  const mfgCols = filt(detected.mfgCols);
  const diskCols = filt(detected.diskCols);
  const multiDiskCols = filt(detected.multiDiskCols);
  const cpuUtilCols = filt(detected.cpuUtilCols);
  const memUtilCols = filt(detected.memUtilCols);

  const spec = {};
  spec["*Server name"] = nameCols.length ? { columns: nameCols, operation: "first" } : null;
  spec["IP addresses"] = ipCols.length ? { columns: ipCols, operation: "first" } : null;
  if (cpuCntCols.length && cpuCoreCols.length && cpuThrCols.length) {
    spec["*Cores"] = { columns: [cpuCntCols[0], cpuCoreCols[0], cpuThrCols[0]], operation: "product" };
  } else if (cpuCoreCols.length) {
    spec["*Cores"] = { columns: cpuCoreCols, operation: "first" };
  } else if (cpuCntCols.length) {
    spec["*Cores"] = { columns: cpuCntCols, operation: "first" };
  } else {
    spec["*Cores"] = null;
  }
  spec["*Memory (In MB)"] = memCols.length
    ? { columns: memCols, operation: "first", unit: detected.memUnit || "MB" }
    : null;
  if (osCols.length && osVerCols.length) {
    spec["*OS name"] = { columns: [osCols[0], osVerCols[0]], operation: "concat" };
  } else if (osCols.length) {
    spec["*OS name"] = { columns: osCols, operation: "first" };
  } else {
    spec["*OS name"] = null;
  }
  spec["OS version"] = osVerCols.length ? { columns: osVerCols, operation: "first" } : null;
  spec["Server type"] = { operation: "static", value: "Virtual" };
  spec["Hypervisor"] = mfgCols.length ? { columns: mfgCols, operation: "first" } : null;

  // Storage: prefer summing per-disk columns (e.g. SPSetia "Disk 1..Disk 14"); else
  // fall back to a single combined storage column (Provisioned Capacity, Total HDD, ...).
  if (multiDiskCols.length >= 2) {
    spec["Storage in use (In GB)"] = { columns: multiDiskCols, operation: "sum", unit: detected.diskUnit || "MB" };
    spec["Number of disks"] = { columns: multiDiskCols, operation: "countNonEmpty" };
    spec["Disk 1 size (In GB)"] = { columns: [multiDiskCols[0]], operation: "first", unit: detected.diskUnit || "MB" };
    if (multiDiskCols.length >= 2) {
      spec["Disk 2 size (In GB)"] = { columns: [multiDiskCols[1]], operation: "first", unit: detected.diskUnit || "MB" };
    }
  } else {
    spec["Storage in use (In GB)"] = diskCols.length
      ? { columns: diskCols, operation: "first", unit: detected.diskUnit || "GB" }
      : null;
    spec["Disk 1 size (In GB)"] = diskCols.length
      ? { columns: diskCols, operation: "first", unit: detected.diskUnit || "GB" }
      : null;
    spec["Number of disks"] = { operation: "static", value: "1" };
  }

  // Utilization columns power performance-based right-sizing in assessment.js.
  // If the inventory carries them, map them so values reach the assessment input.
  if (cpuUtilCols.length) spec["CPU utilization percentage"] = { columns: cpuUtilCols, operation: "first" };
  if (memUtilCols.length) spec["Memory utilization percentage"] = { columns: memUtilCols, operation: "first" };

  return spec;
}

// Validate + sanitize a spec received from LLM or UI: drop unknown source columns,
// drop unknown targets, normalize operation to a known one, drop bad units.
function sanitizeSpec(rawSpec, sourceColumns) {
  const validOps = new Set(["first", "concat", "product", "static", "sum", "countNonEmpty"]);
  const allowedTargets = new Set(templateHeaders.map(h => h.trim()));
  const srcSet = new Set(sourceColumns);
  const out = {};
  for (const target of Object.keys(rawSpec || {})) {
    if (!allowedTargets.has(target)) continue;
    const v = rawSpec[target];
    if (v == null) { out[target] = null; continue; }
    if (typeof v !== "object") continue;
    const op = String(v.operation || "first").toLowerCase();
    if (!validOps.has(op)) continue;
    if (op === "static") {
      out[target] = { operation: "static", value: v.value == null ? "" : String(v.value) };
      continue;
    }
    const cols = Array.isArray(v.columns) ? v.columns.filter(c => srcSet.has(c)) : [];
    if (cols.length === 0) { out[target] = null; continue; }
    const entry = { columns: cols, operation: op };
    if (v.unit && /^(MB|GB)$/i.test(v.unit)) entry.unit = v.unit.toUpperCase();
    out[target] = entry;
  }
  return out;
}

// Hydrate a sanitized spec into the (target -> string|function|null) shape that
// processMapping consumes.
function compileMappingSpec(spec) {
  const mapping = {};
  for (const target of templateHeaders) {
    const t = target.trim();
    const entry = spec[t];
    if (entry == null) { mapping[t] = null; continue; }

    if (entry.operation === "static") {
      const val = entry.value;
      mapping[t] = () => val;
      continue;
    }

    const cols = entry.columns;
    const unitDeclared = entry.unit;

    if (entry.operation === "concat") {
      mapping[t] = (row) => cols.map(c => {
        const v = row[c];
        return (v == null) ? "" : String(v).trim();
      }).filter(Boolean).join(" ").trim();
      continue;
    }

    if (entry.operation === "product") {
      mapping[t] = (row) => {
        const nums = cols.map(c => {
          const v = row[c];
          if (v == null || String(v).trim() === "") return null;
          const n = parseInt(v);
          return isNaN(n) ? null : n;
        });
        if (nums.every(n => n == null)) return 0;
        return nums.reduce((acc, n) => acc * (n == null ? 1 : n), 1);
      };
      continue;
    }

    if (entry.operation === "countNonEmpty") {
      mapping[t] = (row) => {
        let n = 0;
        for (const c of cols) {
          const v = row[c];
          if (v != null && String(v).trim() !== "" && parseFloat(v) > 0) n++;
        }
        return n > 0 ? n : "1";
      };
      continue;
    }

    if (entry.operation === "sum") {
      // Sum all non-empty numeric cells in the listed columns; convert to target unit.
      const targetUnit = /memory/i.test(t) ? "MB" : "GB";
      mapping[t] = (row) => {
        let totalMb = 0; let any = false;
        for (const c of cols) {
          const raw = row[c];
          if (raw == null || String(raw).trim() === "") continue;
          const s = String(raw).trim();
          const m = s.match(/^([\d.]+)\s*(tb|gb|mb|kb)?\s*$/i);
          if (!m) continue;
          const v = parseFloat(m[1]);
          if (isNaN(v) || v <= 0) continue;
          let unit = (m[2] || "").toUpperCase();
          if (!unit) {
            if (/\bmb\b/i.test(c)) unit = "MB";
            else if (/\bgb\b/i.test(c)) unit = "GB";
            else if (/\btb\b/i.test(c)) unit = "TB";
            else unit = unitDeclared || "MB";
          }
          const factor = { TB: 1024 * 1024, GB: 1024, MB: 1, KB: 1 / 1024 }[unit] || 1;
          totalMb += v * factor;
          any = true;
        }
        if (!any) return "";
        return targetUnit === "MB" ? Math.round(totalMb) : Math.round(totalMb / 1024);
      };
      continue;
    }

    // operation === "first" (default)
    if (unitDeclared) {
      // Numeric with unit conversion. Used for memory (target MB) and storage (target GB).
      const targetUnit = /memory/i.test(t) ? "MB" : "GB";
      mapping[t] = (row) => {
        const r = pickValueFromRow(row, cols);
        if (!r) return "";
        const raw = String(r.value).trim();
        // Inline unit suffix on the value itself (e.g. "1.2 TB", "79.5 GB").
        const m = raw.match(/^([\d.]+)\s*(tb|gb|mb|kb)\s*$/i);
        let v, unit;
        if (m) {
          v = parseFloat(m[1]);
          unit = m[2].toUpperCase();
        } else {
          v = parseFloat(raw);
          if (isNaN(v)) return "";
          // Per-column unit override: if column name itself says MB/GB, trust that.
          if (/\bmb\b/i.test(r.col)) unit = "MB";
          else if (/\bgb\b/i.test(r.col)) unit = "GB";
          else unit = unitDeclared;
        }
        if (isNaN(v)) return "";
        const factorToMb = { TB: 1024 * 1024, GB: 1024, MB: 1, KB: 1 / 1024 }[unit] || 1;
        const inMb = v * factorToMb;
        return targetUnit === "MB" ? Math.round(inMb) : Math.round(inMb / 1024);
      };
      continue;
    }

    mapping[t] = (row) => {
      const r = pickValueFromRow(row, cols);
      return r ? r.value : "";
    };
  }
  return mapping;
}

// Decide if the inventory is too poor to be a server inventory at all. Done AFTER trying
// auto + (optionally) AI mapping. Threshold: any required target with <50% non-empty rows.
function assessInventoryQuality(rawData, mapping) {
  const sample = rawData.slice(0, Math.min(50, rawData.length));
  const issues = [];
  for (const target of REQUIRED_TARGETS) {
    const fn = mapping[target];
    let filled = 0;
    for (const row of sample) {
      let v;
      if (typeof fn === "function") v = fn(row);
      else if (typeof fn === "string") v = row[fn];
      else v = "";
      if (v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "0") filled++;
    }
    const ratio = sample.length ? filled / sample.length : 0;
    if (ratio < 0.5) issues.push({ target, filledRatio: ratio });
  }
  return {
    looksLikeInventory: issues.length === 0,
    issues,
  };
}

// Reprocess the cached source data of a session under a new mapping. Rewrites all output
// files in place and updates the session record. Returns a fresh response payload.
function reprocessSession(session, sessionId, mapping, mappingSource) {
  const rawData = session.sourceData;
  const { validRows, invalidRows, report } = processMapping(rawData, mapping);

  const azMigrateCsv = generateCsv(validRows, templateHeaders);
  const azMigratePath = path.join(session.outputDir, "AzureMigrate_Import.csv");
  fs.writeFileSync(azMigratePath, azMigrateCsv, "utf-8");

  const excludedPath = path.join(session.outputDir, "Excluded_Servers.csv");
  if (invalidRows.length > 0) {
    const excludedHeaders = [...templateHeaders, "Error"];
    fs.writeFileSync(excludedPath, generateCsv(invalidRows, excludedHeaders), "utf-8");
  } else if (fs.existsSync(excludedPath)) {
    fs.unlinkSync(excludedPath);
  }

  const reportText = generateReport(rawData.length, validRows, invalidRows, report);
  fs.writeFileSync(path.join(session.outputDir, "conversion_report.txt"), reportText, "utf-8");

  session.validCount = validRows.length;
  session.invalidCount = invalidRows.length;
  session.reportText = reportText;
  session.errors = invalidRows.map(r => ({
    serverName: r["*Server name"] || "Unknown",
    error: r["Error"],
  }));
  session.activeMappingSource = mappingSource;
  return { validRows, invalidRows, reportText };
}

// Build the UI-friendly mappingInfo array directly from a sanitized spec.
function specToMappingInfo(spec, sourceColumns) {
  const sourceSet = new Set(sourceColumns);
  const info = [];
  for (const target of templateHeaders) {
    const t = target.trim();
    const entry = spec[t];
    let source = null, type = "unmapped", reason = "No mapping defined";
    if (entry == null) {
      reason = "No source column matched";
    } else if (entry.operation === "static") {
      type = "computed";
      source = "(static)";
      reason = `Default value: "${entry.value}"`;
    } else if (entry.operation === "concat") {
      type = "computed";
      source = entry.columns.join(" + ");
      reason = `Concatenated: ${entry.columns.map(c => `"${c}"`).join(" + ")}`;
    } else if (entry.operation === "product") {
      type = "computed";
      source = entry.columns.join(" \u00d7 ");
      reason = `Product: ${entry.columns.map(c => `"${c}"`).join(" \u00d7 ")}`;
    } else if (entry.operation === "sum") {
      type = "computed";
      source = entry.columns.length <= 3
        ? entry.columns.join(" + ")
        : `${entry.columns[0]} + ... + ${entry.columns[entry.columns.length - 1]} (${entry.columns.length} cols)`;
      reason = `Sum across ${entry.columns.length} disk column${entry.columns.length === 1 ? "" : "s"}${entry.unit ? ` (${entry.unit})` : ""}`;
    } else if (entry.operation === "countNonEmpty") {
      type = "computed";
      source = `count(${entry.columns.length} disk cols)`;
      reason = `Count of non-empty values across ${entry.columns.length} disk columns`;
    } else if (entry.operation === "first") {
      const present = entry.columns.filter(c => sourceSet.has(c));
      if (present.length === 0) {
        reason = "Listed source columns not in inventory";
      } else if (present.length === 1) {
        type = "direct";
        source = present[0];
        reason = `Direct match: "${present[0]}" \u2192 "${t}"${entry.unit ? ` (${entry.unit})` : ""}`;
      } else {
        type = "computed";
        source = present.join(" | ");
        reason = `First non-empty across: ${present.map(c => `"${c}"`).join(", ")}${entry.unit ? ` (${entry.unit})` : ""}`;
      }
    }
    info.push({ target: t, source, type, reason });
  }
  return info;
}

// ============ CSV PROCESSING ROUTES ============

// Identify which required targets the current mapping is filling poorly. Used to decide
// whether automatic LLM verification on upload is worthwhile.
function findWeakTargets(rawData, mapping, threshold) {
  const sample = rawData.slice(0, Math.min(80, rawData.length));
  const weak = [];
  for (const target of REQUIRED_TARGETS) {
    const fn = mapping[target];
    if (fn == null) { weak.push(target); continue; }
    let filled = 0;
    for (const row of sample) {
      let v;
      if (typeof fn === "function") v = fn(row);
      else if (typeof fn === "string") v = row[fn];
      else v = "";
      if (v !== undefined && v !== null && String(v).trim() !== "" && String(v).trim() !== "0") filled++;
    }
    const ratio = sample.length ? filled / sample.length : 0;
    if (ratio < threshold) weak.push(target);
  }
  return weak;
}

app.post("/api/upload", upload.single("inventory"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;

    let rawData;
    let sheetSummary = [];
    try {
      const parsed = parseWorkbookGeneric(filePath);
      rawData = parsed.rows;
      sheetSummary = parsed.sheetSummary;
    } catch (err) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
    }

    if (!rawData || rawData.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "File contains no data rows" });
    }

    const sourceColumnSet = new Set();
    for (const r of rawData) for (const k of Object.keys(r)) if (k !== "_sheet") sourceColumnSet.add(k);
    const sourceColumns = Array.from(sourceColumnSet);

    const sampleRows = rawData.slice(0, Math.min(50, rawData.length));

    const STATIC_REQUIRED = ["Host name", "CPU count", "CPU core count", "RAM (MB)", "Operating System"];
    const isLegacyAbmb = STATIC_REQUIRED.every(c => sourceColumns.includes(c));
    let activeSpec = null;
    let activeMapping;
    let mappingSource;
    if (isLegacyAbmb) {
      activeMapping = columnMapping;
      mappingSource = "static (ABMB legacy)";
    } else {
      const auto = buildAutoMapping(sourceColumns, sampleRows);
      activeSpec = buildBaselineSpec(auto.detected, sourceColumns);
      activeMapping = compileMappingSpec(activeSpec);
      mappingSource = "auto-detected";
    }

    // Auto LLM verification on weakness. Status semantics:
    //   not-needed              : rules cover all required targets >=90%; LLM is skipped.
    //   triggered-applied       : weakness found, LLM ran, refined N targets.
    //   triggered-no-change     : weakness found, LLM ran, no improvement over rules.
    //   triggered-failed        : weakness found, LLM ran, error - falling back to rules.
    //   required-not-configured : weakness found AND LLM is NOT configured -> we BLOCK
    //                             the upload because the rule-based mapping is incomplete
    //                             and we have no AI to fall back to. User must configure
    //                             the AI model (see /api/llm/configure) and re-upload.
    let aiNotice = null;
    let aiStatus = "not-needed";
    let weakTargets = [];
    if (activeSpec) {
      weakTargets = findWeakTargets(rawData, activeMapping, 0.9);
      if (weakTargets.length > 0) {
        if (!llmHelper.isConfigured()) {
          fs.unlinkSync(filePath);
          return res.status(412).json({
            error: "AI model required for this inventory.",
            errorCode: "LLM_REQUIRED",
            message: `The rule-based mapper could not confidently map all required columns (${weakTargets.join(", ")}). An AI model is required to verify and refine the mapping. Please configure the AI model under Settings and re-upload.`,
            weakTargets,
            sourceColumns,
          });
        }
        try {
          const llmSamples = rawData.slice(0, 8).map(r => {
            const o = {}; for (const k of Object.keys(r)) if (k !== "_sheet") o[k] = r[k]; return o;
          });
          const suggestion = await llmHelper.suggestColumnMapping(
            sourceColumns, templateHeaders, llmSamples, activeSpec,
          );
          if (suggestion && typeof suggestion === "object") {
            const aiSpec = sanitizeSpec(suggestion, sourceColumns);
            const merged = { ...activeSpec };
            const targetsTouched = [];
            for (const target of templateHeaders) {
              const t = target.trim();
              const ai = aiSpec[t];
              const isWeakRequired = weakTargets.includes(t);
              const baselineNull = merged[t] == null;
              if (ai != null && (isWeakRequired || baselineNull)) {
                merged[t] = ai;
                targetsTouched.push(t);
              }
            }
            if (targetsTouched.length > 0) {
              activeSpec = merged;
              activeMapping = compileMappingSpec(activeSpec);
              mappingSource = "auto-detected + AI verified";
              aiStatus = "triggered-applied";
              aiNotice = { applied: true, targets: targetsTouched, originalWeakTargets: weakTargets };
            } else {
              aiStatus = "triggered-no-change";
              aiNotice = { applied: false, reason: "AI confirmed rule-based mapping was already correct.", originalWeakTargets: weakTargets };
            }
          } else {
            aiStatus = "triggered-failed";
            aiNotice = { applied: false, reason: "AI did not return a usable suggestion.", originalWeakTargets: weakTargets };
          }
        } catch (err) {
          console.error("[Upload AI verify] error:", err.message);
          aiStatus = "triggered-failed";
          aiNotice = { applied: false, reason: `AI verification failed: ${err.message}`, originalWeakTargets: weakTargets };
        }
      }
    }

    const { validRows, invalidRows, report } = processMapping(rawData, activeMapping);

    const sessionId = crypto.randomUUID();
    const outputDir = path.join(__dirname, "output", sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    const azMigrateCsv = generateCsv(validRows, templateHeaders);
    const azMigratePath = path.join(outputDir, "AzureMigrate_Import.csv");
    fs.writeFileSync(azMigratePath, azMigrateCsv, "utf-8");

    if (invalidRows.length > 0) {
      const excludedHeaders = [...templateHeaders, "Error"];
      const excludedCsv = generateCsv(invalidRows, excludedHeaders);
      fs.writeFileSync(path.join(outputDir, "Excluded_Servers.csv"), excludedCsv, "utf-8");
    }

    const reportText = generateReport(rawData.length, validRows, invalidRows, report);
    fs.writeFileSync(path.join(outputDir, "conversion_report.txt"), reportText, "utf-8");

    sessions[sessionId] = {
      sourceFile: req.file.originalname,
      sourceFilePath: req.file.path,
      sourceColumns,
      sourceData: rawData,
      originalData: rawData,
      totalRows: rawData.length,
      validCount: validRows.length,
      invalidCount: invalidRows.length,
      outputDir,
      azMigratePath,
      reportText,
      activeSpec,
      activeMappingSource: mappingSource,
      errors: invalidRows.map(r => ({
        serverName: r["*Server name"] || "Unknown",
        error: r["Error"],
      })),
    };

    const quality = assessInventoryQuality(rawData, activeMapping);

    const mappingInfo = activeSpec
      ? specToMappingInfo(activeSpec, sourceColumns)
      : templateHeaders.map(targetCol => {
          const m = activeMapping[targetCol];
          if (typeof m === "string") return { target: targetCol, source: m, type: "direct", reason: `Direct match: "${m}" \u2192 "${targetCol}"` };
          if (typeof m === "function") return { target: targetCol, source: "(computed)", type: "computed", reason: "Computed from source columns" };
          return { target: targetCol, source: null, type: "unmapped", reason: "Optional \u2014 no source data available" };
        });

    fs.unlinkSync(filePath);

    res.json({
      sessionId,
      totalRows: rawData.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      sourceColumns,
      sheetSummary,
      mappingSource,
      mappingInfo,
      activeSpec,
      aiStatus,
      aiNotice,
      weakTargets,
      inventoryQualityIssue: !quality.looksLikeInventory ? {
        message: "This file does not look like a server inventory. Required columns (server name, CPU/cores, memory, OS) could not be identified for most rows. Please verify you uploaded the correct file or use AI Assisted Mapping to refine.",
        details: quality.issues,
      } : null,
      errors: sessions[sessionId].errors,
      report: reportText,
      hasErrors: invalidRows.length > 0,
    });
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/download/:sessionId/:fileType", (req, res) => {
  const { sessionId, fileType } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  const fileMap = {
    azmigrate: "AzureMigrate_Import.csv",
    excluded: "Excluded_Servers.csv",
    report: "conversion_report.txt",
    bom: "Full_BOM.xlsx",
  };

  const fileName = fileMap[fileType];
  if (!fileName) return res.status(400).json({ error: "Invalid file type" });

  const filePath = path.join(session.outputDir, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File not found" });

  res.download(filePath, fileName);
});

// ============ ENVIRONMENT DETECTION ============
app.get("/api/session/:sessionId/environments", (req, res) => {
  const session = sessions[req.params.sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  const originalData = session.originalData || session.sourceData || [];
  if (originalData.length === 0) return res.json({ environments: ["All"], envColumn: null });

  // Find environment column (case-insensitive)
  const firstRow = originalData[0];
  const allCols = Object.keys(firstRow);
  const envCol = allCols.find(c => /^env(ironment)?$/i.test(c.trim()));

  if (!envCol) {
    session.environments = ["All"];
    session.envColumn = null;
    return res.json({ environments: ["All"], envColumn: null });
  }

  // Collect distinct environment values
  const envSet = new Set();
  for (const row of originalData) {
    const val = (row[envCol] || "").trim();
    envSet.add(val || "Unknown");
  }

  // Sort: known envs first (Prod > UAT > SIT > Dev > Test), then alphabetical, Unknown last
  const priority = ["production", "prod", "uat", "sit", "staging", "dev", "development", "test", "dr"];
  const envList = [...envSet].sort((a, b) => {
    if (a === "Unknown") return 1;
    if (b === "Unknown") return -1;
    const aIdx = priority.findIndex(p => a.toLowerCase().includes(p));
    const bIdx = priority.findIndex(p => b.toLowerCase().includes(p));
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return a.localeCompare(b);
  });

  session.environments = envList;
  session.envColumn = envCol;

  // Count servers per env
  const envCounts = {};
  for (const env of envList) {
    envCounts[env] = originalData.filter(r => {
      const val = (r[envCol] || "").trim() || "Unknown";
      return val === env;
    }).length;
  }

  res.json({ environments: envList, envColumn: envCol, envCounts });
});

// ============ ASSESSMENT UPLOAD & BOM ============

app.post("/api/upload-assessment", upload.single("assessment"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const sessionId = req.body.sessionId;
    const session = sessions[sessionId];

    const filePath = req.file.path;
    let assessmentData = [];
    let diskData = [];
    let settings = {};

    try {
      const workbook = XLSX.readFile(filePath);

      // Read Server_to_AzureVM sheet (main cost data)
      const vmSheet = workbook.Sheets["Server_to_AzureVM"];
      if (vmSheet) {
        assessmentData = XLSX.utils.sheet_to_json(vmSheet);
      }

      // Read Asessed_Disks sheet
      const diskSheet = workbook.Sheets["Asessed_Disks"];
      if (diskSheet) {
        diskData = XLSX.utils.sheet_to_json(diskSheet);
      }

      // Read Assessment_Settings
      const settingsSheet = workbook.Sheets["Assessment_Settings"];
      if (settingsSheet) {
        const settingsArr = XLSX.utils.sheet_to_json(settingsSheet, { header: 1 });
        settingsArr.forEach(row => {
          if (row[0] && row[1]) settings[row[0]] = row[1];
        });
      }

      // Fallback: try first sheet if Server_to_AzureVM not found
      if (assessmentData.length === 0) {
        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        assessmentData = XLSX.utils.sheet_to_json(firstSheet);
      }
    } catch (err) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: `Failed to parse assessment file: ${err.message}` });
    }

    if (assessmentData.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "No assessment data found. Upload the Strategy_Lift_and_shift.xlsx from Azure Migrate detailed report." });
    }

    fs.unlinkSync(filePath);

    // Build BOM data
    const bomData = buildBOM(assessmentData, diskData, settings, session);

    // Store BOM in session
    if (session) {
      session.bomData = bomData;
      // Write BOM Excel
      writeBomExcel(bomData, path.join(session.outputDir, "Full_BOM.xlsx"));

      // Auto-save session after BOM generation
      saveSessionToDisk(sessionId);
    }

    res.json({
      success: true,
      serverCount: bomData.servers.length,
      bomData,
    });
  } catch (err) {
    console.error("Assessment upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

function buildBOM(assessmentData, diskData, settings, session) {
  const currency = settings["Currency"] || "USD";
  const location = settings["Target location"] || "Unknown";
  const serverCount = assessmentData.length;

  // Shared infrastructure costs (monthly, amortized across all servers)
  const AZURE_FIREWALL_MONTHLY = 912; // Standard tier fixed
  const EXPRESSROUTE_CIRCUIT_MONTHLY = 55; // 50 Mbps metered
  const EXPRESSROUTE_GATEWAY_MONTHLY = 126; // Standard gateway
  const BACKUP_INSTANCE_FEE = 10; // per server/month
  const BACKUP_STORAGE_RATE = 0.024; // per GB/month after free tier

  const firewallPerServer = serverCount > 0 ? AZURE_FIREWALL_MONTHLY / serverCount : 0;
  const expressRouteTotal = EXPRESSROUTE_CIRCUIT_MONTHLY + EXPRESSROUTE_GATEWAY_MONTHLY;
  const expressRoutePerServer = serverCount > 0 ? expressRouteTotal / serverCount : 0;

  // Build per-server BOM
  const servers = assessmentData.map(row => {
    const serverName = row["SERVER_NAME"] || row["ServerName"] || "";
    const computeCost = parseFloat(row["MONTHLY_COMPUTE_COST_USD"]) || 0;
    const storageCost = parseFloat(row["MONTHLY_STORAGE_COST_USD"]) || 0;
    const securityCost = parseFloat(row["MONTHLY_SECURITY_COST_USD"]) || 0;
    const totalAzMigrate = parseFloat(row["TOTAL_MONTHLY_COST_USD"]) || 0;
    const computeSku = row["RECOMMENDED_COMPUTE_SKU"] || "";
    const storageSku = row["RECOMMENDED_STORAGE_SKU"] || "";
    const storageGB = parseFloat(row["RECOMMENDED_STORAGE_SIZE_GB"] || row["ONPREM_STORAGE_GB"]) || 0;
    const cores = parseInt(row["RECOMMENDED_NUMBER_OF_CORES"] || row["ONPREM_CORES_COUNT"]) || 0;
    const os = row["OPERATING_SYSTEM_NAME"] || "";
    const readiness = row["MIGRATION_READINESS"] || "";
    const networkMbps = (parseFloat(row["NETWORK_READ_MBPS"]) || 0) + (parseFloat(row["NETWORK_WRITE_MBPS"]) || 0);

    // Backup cost: instance fee + storage (first 500GB free for first instance)
    const backupStorageGB = storageGB;
    const backupStorageCost = Math.max(0, backupStorageGB - 0) * BACKUP_STORAGE_RATE; // simplified: no free tier per server
    const backupCost = BACKUP_INSTANCE_FEE + backupStorageCost;

    // Egress estimate: assume 5% of network throughput goes external
    // networkMbps * 0.05 * 3600 * 24 * 30 / 1024 = GB egress/month (very rough)
    const egressGB = networkMbps > 0 ? (networkMbps * 0.05 * 3600 * 24 * 30) / 1024 : 0;
    // First 100GB free, then $0.087/GB (Asia Pacific zone 1)
    const egressCost = Math.max(0, egressGB - (100 / serverCount)) * 0.087;

    const totalMonthly = totalAzMigrate + firewallPerServer + expressRoutePerServer + backupCost + egressCost;

    return {
      serverName,
      readiness,
      os,
      cores,
      computeSku,
      storageSku,
      storageGB,
      computeCost: round2(computeCost),
      storageCost: round2(storageCost),
      securityCost: round2(securityCost),
      firewallCost: round2(firewallPerServer),
      expressRouteCost: round2(expressRoutePerServer),
      egressCost: round2(egressCost),
      backupCost: round2(backupCost),
      windowsLicense: "",
      sqlLicense: "",
      totalMonthly: round2(totalMonthly),
      totalAnnual: round2(totalMonthly * 12),
    };
  });

  // Summary totals
  const totals = {
    computeCost: round2(servers.reduce((s, r) => s + r.computeCost, 0)),
    storageCost: round2(servers.reduce((s, r) => s + r.storageCost, 0)),
    securityCost: round2(servers.reduce((s, r) => s + r.securityCost, 0)),
    firewallCost: round2(AZURE_FIREWALL_MONTHLY),
    expressRouteCost: round2(expressRouteTotal),
    egressCost: round2(servers.reduce((s, r) => s + r.egressCost, 0)),
    backupCost: round2(servers.reduce((s, r) => s + r.backupCost, 0)),
    windowsLicense: "(To be filled by sales)",
    sqlLicense: "(To be filled by sales)",
    totalMonthly: round2(servers.reduce((s, r) => s + r.totalMonthly, 0)),
    totalAnnual: round2(servers.reduce((s, r) => s + r.totalAnnual, 0)),
  };

  return {
    servers,
    totals,
    currency,
    location,
    serverCount,
    metadata: {
      firewallNote: "Azure Firewall Standard: $912/month fixed + $0.016/GB data processed. Shared across all servers.",
      expressRouteNote: "ExpressRoute Standard 50 Mbps metered ($55/mo) + Standard Gateway ($126/mo). Shared across all servers.",
      backupNote: "Azure Backup: $10/instance/month + $0.024/GB/month storage (LRS). Ref: https://azure.microsoft.com/en-us/pricing/details/backup/",
      egressNote: "Egress estimated at 5% of observed network throughput. First 100GB/month free, then $0.087/GB (Asia Pacific). Ref: https://azure.microsoft.com/en-us/pricing/details/bandwidth/",
      licenseNote: "Windows and SQL license costs to be filled by sales representative based on EA/CSP agreement.",
    },
  };
}

function writeBomExcel(bomData, filePath) {
  const wb = XLSX.utils.book_new();

  // BOM Detail sheet
  const bomRows = bomData.servers.map(s => ({
    "Server Name": s.serverName,
    "Readiness": s.readiness,
    "OS": s.os,
    "Cores": s.cores,
    "Compute SKU": s.computeSku,
    "Storage SKU": s.storageSku,
    "Storage (GB)": s.storageGB,
    [`Compute (${bomData.currency}/mo)`]: s.computeCost,
    [`Storage (${bomData.currency}/mo)`]: s.storageCost,
    [`Security (${bomData.currency}/mo)`]: s.securityCost,
    [`Firewall (${bomData.currency}/mo)`]: s.firewallCost,
    [`ExpressRoute (${bomData.currency}/mo)`]: s.expressRouteCost,
    [`Egress (${bomData.currency}/mo)`]: s.egressCost,
    [`Backup (${bomData.currency}/mo)`]: s.backupCost,
    "Windows License": s.windowsLicense,
    "SQL License": s.sqlLicense,
    [`Total Monthly (${bomData.currency})`]: s.totalMonthly,
    [`Total Annual (${bomData.currency})`]: s.totalAnnual,
  }));

  // Add totals row
  bomRows.push({
    "Server Name": "TOTAL",
    "Readiness": "",
    "OS": "",
    "Cores": "",
    "Compute SKU": "",
    "Storage SKU": "",
    "Storage (GB)": "",
    [`Compute (${bomData.currency}/mo)`]: bomData.totals.computeCost,
    [`Storage (${bomData.currency}/mo)`]: bomData.totals.storageCost,
    [`Security (${bomData.currency}/mo)`]: bomData.totals.securityCost,
    [`Firewall (${bomData.currency}/mo)`]: bomData.totals.firewallCost,
    [`ExpressRoute (${bomData.currency}/mo)`]: bomData.totals.expressRouteCost,
    [`Egress (${bomData.currency}/mo)`]: bomData.totals.egressCost,
    [`Backup (${bomData.currency}/mo)`]: bomData.totals.backupCost,
    "Windows License": bomData.totals.windowsLicense,
    "SQL License": bomData.totals.sqlLicense,
    [`Total Monthly (${bomData.currency})`]: bomData.totals.totalMonthly,
    [`Total Annual (${bomData.currency})`]: bomData.totals.totalAnnual,
  });

  const ws = XLSX.utils.json_to_sheet(bomRows);
  XLSX.utils.book_append_sheet(wb, ws, "Full BOM");

  // Summary sheet
  const summaryRows = [
    { "Cost Category": "Compute", "Monthly": bomData.totals.computeCost, "Annual": bomData.totals.computeCost * 12 },
    { "Cost Category": "Storage", "Monthly": bomData.totals.storageCost, "Annual": bomData.totals.storageCost * 12 },
    { "Cost Category": "Security", "Monthly": bomData.totals.securityCost, "Annual": bomData.totals.securityCost * 12 },
    { "Cost Category": "Azure Firewall", "Monthly": bomData.totals.firewallCost, "Annual": bomData.totals.firewallCost * 12 },
    { "Cost Category": "ExpressRoute", "Monthly": bomData.totals.expressRouteCost, "Annual": bomData.totals.expressRouteCost * 12 },
    { "Cost Category": "Egress/Networking", "Monthly": bomData.totals.egressCost, "Annual": bomData.totals.egressCost * 12 },
    { "Cost Category": "Backup", "Monthly": bomData.totals.backupCost, "Annual": bomData.totals.backupCost * 12 },
    { "Cost Category": "Windows Licenses", "Monthly": "(TBD)", "Annual": "(TBD)" },
    { "Cost Category": "SQL Licenses", "Monthly": "(TBD)", "Annual": "(TBD)" },
    { "Cost Category": "TOTAL", "Monthly": bomData.totals.totalMonthly, "Annual": bomData.totals.totalAnnual },
  ];
  const ws2 = XLSX.utils.json_to_sheet(summaryRows);
  XLSX.utils.book_append_sheet(wb, ws2, "Cost Summary");

  // Notes sheet
  const notesRows = [
    { "Item": "Azure Firewall", "Note": bomData.metadata.firewallNote },
    { "Item": "ExpressRoute", "Note": bomData.metadata.expressRouteNote },
    { "Item": "Backup", "Note": bomData.metadata.backupNote },
    { "Item": "Egress", "Note": bomData.metadata.egressNote },
    { "Item": "Licenses", "Note": bomData.metadata.licenseNote },
  ];
  const ws3 = XLSX.utils.json_to_sheet(notesRows);
  XLSX.utils.book_append_sheet(wb, ws3, "Assumptions & References");

  XLSX.writeFile(wb, filePath);
}

// ============ AZURE AUTH ROUTES ============

// Check if pre-authenticated from CLI or az session exists
app.get("/api/auth/status", (req, res) => {
  if (preAuthToken && Date.now() < preAuthToken.expiresAt) {
    res.json({ authenticated: true, source: "cli" });
  } else {
    // Check if az CLI has an active session
    try {
      execSync("az account show", { stdio: "ignore" });
      res.json({ authenticated: true, source: "az-cli" });
    } catch {
      res.json({ authenticated: false });
    }
  }
});

// Claim the pre-auth token (web page picks it up)
app.post("/api/auth/claim-preauth", (req, res) => {
  // Try pre-auth token from CLI setup
  if (preAuthToken && Date.now() < preAuthToken.expiresAt) {
    const tokenId = crypto.randomUUID();
    sessions[`token_${tokenId}`] = {
      accessToken: preAuthToken.accessToken,
      refreshToken: preAuthToken.refreshToken,
      expiresAt: preAuthToken.expiresAt,
    };
    return res.json({ success: true, tokenId });
  }

  // Try getting token from existing az CLI session
  try {
    const tokenJson = execSync(
      'az account get-access-token --resource https://management.azure.com/ -o json',
      { encoding: "utf-8", timeout: 15000 }
    );
    const tokenData = JSON.parse(tokenJson);
    if (tokenData.accessToken) {
      const expiresOn = new Date(tokenData.expiresOn).getTime();
      const tokenId = crypto.randomUUID();
      sessions[`token_${tokenId}`] = {
        accessToken: tokenData.accessToken,
        refreshToken: null,
        expiresAt: expiresOn,
      };
      return res.json({ success: true, tokenId });
    }
  } catch {}

  res.json({ success: false });
});

// Azure login via az CLI (uses existing az login session)

app.post("/api/auth/device-code", async (req, res) => {
  try {
    // Check if az CLI is available
    try {
      execSync("az --version", { stdio: "ignore" });
    } catch {
      return res.status(400).json({ error: "Azure CLI (az) not installed. Install from https://aka.ms/installazurecli" });
    }

    // Check if already logged in
    try {
      execSync("az account show", { stdio: "ignore" });
    } catch {
      return res.status(401).json({ error: "Not logged in. Run 'az login' in terminal first, then click Login again." });
    }

    // Get access token from existing session
    let tokenJson;
    try {
      tokenJson = execSync(
        'az account get-access-token --resource https://management.azure.com/ -o json',
        { encoding: "utf-8", timeout: 15000 }
      );
    } catch (e) {
      return res.status(400).json({ error: "Failed to get token. Run 'az login' in terminal and try again." });
    }

    const tokenData = JSON.parse(tokenJson);
    if (!tokenData.accessToken) {
      return res.status(400).json({ error: "Could not get access token from Azure CLI." });
    }

    const expiresOn = new Date(tokenData.expiresOn).getTime();

    // Store token
    const tokenId = crypto.randomUUID();
    sessions[`token_${tokenId}`] = {
      accessToken: tokenData.accessToken,
      refreshToken: null,
      expiresAt: expiresOn,
    };

    res.json({
      status: "success",
      tokenId,
      message: "Logged in via Azure CLI",
    });
  } catch (err) {
    res.status(500).json({ error: `Server error: ${err.message}` });
  }
});

// Keep poll endpoint for compatibility (returns immediately since az CLI login is synchronous)
app.post("/api/auth/device-code-poll", async (req, res) => {
  res.json({ status: "error", error: "Not needed with az CLI login. Use /api/auth/device-code directly." });
});

// LLM status & config
app.get("/api/llm/status", (req, res) => {
  res.json(llmHelper.getStatus());
});

app.post("/api/llm/config", async (req, res) => {
  const { endpoint, apiKey, deploymentName, useTokenAuth, providerType, githubPat, model } = req.body;
  console.log(`[LLM Config] provider=${providerType || "auto"}, endpoint="${endpoint || "-"}", deployment="${deploymentName || model || "-"}", tokenAuth=${useTokenAuth}`);

  if (providerType === "github-models") {
    if (!githubPat || !model) {
      return res.status(400).json({ error: "GitHub Models requires both PAT and model." });
    }
    // Validate against the real API before persisting — catches 403 "no_access" up front
    // instead of letting the user discover it later on the first real LLM call.
    const v = await llmHelper.validateGithubModels(githubPat, model);
    if (!v.ok) {
      let msg;
      if (v.status === 403 && /openai|azure-openai/i.test(model)) {
        // OpenAI models on GitHub Models are gated behind Copilot Pro/Business/Enterprise.
        // A Free-tier PAT will get no_access no matter how the PAT is configured.
        msg = `GitHub denied access to ${model}. OpenAI models require a Copilot Pro+ subscription on GitHub. Try a free-tier model like mistral-ai/mistral-small-2503 or microsoft/Phi-3.5-MoE-instruct instead.`;
      } else if (v.status === 403) {
        msg = `GitHub denied access to ${model}. Check that your PAT has 'models:read' and that your account has access to this model. (${v.error})`;
      } else if (v.status === 429 || (v.error && /abuse|rate limit|whoa there/i.test(v.error))) {
        msg = "GitHub is rate-limiting requests right now. Wait a few minutes and try again.";
      } else {
        msg = v.error || "Validation failed";
      }
      return res.status(400).json({ error: msg, status: v.status });
    }
    llmHelper.configure({ providerType: "github-models", githubPat, model });
    console.log(`[LLM Config] Final status:`, llmHelper.getStatus());
    // Persist non-secret fields; we do save the PAT locally (same threat model as the existing API key).
    saveLocalConfig({
      providerType: "github-models",
      githubPat,
      model,
      // Clear stale Azure fields so a later boot doesn't accidentally re-arm Azure on top of GitHub.
      endpoint: "",
      deploymentName: "",
      useTokenAuth: false,
      apiKey: "",
    });
    return res.json({ success: true, status: llmHelper.getStatus() });
  }

  // Azure paths (unchanged behavior).
  // Only require token validation for token auth mode
  if (useTokenAuth && !getToken(req)) {
    return res.status(400).json({ error: "Token auth requires Azure login first." });
  }
  llmHelper.configure({ endpoint, apiKey, deploymentName, useTokenAuth, providerType });
  console.log(`[LLM Config] Final status:`, llmHelper.getStatus());
  saveLocalConfig({
    endpoint,
    deploymentName,
    useTokenAuth: useTokenAuth || false,
    providerType: providerType || "auto",
    // Clear GitHub-only fields when switching back to Azure.
    githubPat: "",
    model: "",
  });
  res.json({ success: true, status: llmHelper.getStatus() });
});

// GitHub Models: list available models for a given PAT (proxied so the PAT never
// touches the browser's network log and CORS isn't a concern).
app.post("/api/llm/github-models/catalog", async (req, res) => {
  const { githubPat } = req.body;
  if (!githubPat) return res.status(400).json({ error: "PAT required" });
  const result = await llmHelper.listGithubModels(githubPat);
  if (!result.ok) {
    const msg = result.status === 401 ? "PAT rejected by GitHub (check the token)."
              : result.status === 403 ? "PAT lacks 'models:read' scope."
              : (result.error || "Failed to load models");
    return res.status(result.status || 502).json({ error: msg });
  }
  res.json({ models: result.models });
});

// Disconnect AI: clear in-memory LLM config AND wipe persisted credentials so
// the next boot doesn't auto-re-arm. User can reconfigure from scratch.
app.post("/api/llm/disconnect", (req, res) => {
  llmHelper.configure({ reset: true });
  try {
    const existing = loadLocalConfig();
    const cleared = {
      ...existing,
      providerType: "",
      endpoint: "",
      apiKey: "",
      deploymentName: "",
      useTokenAuth: false,
      githubPat: "",
      model: "",
    };
    fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(cleared, null, 2), "utf-8");
  } catch (err) {
    console.error(`Disconnect: could not clear local config: ${err.message}`);
  }
  console.log("[LLM] Disconnected by user. Local config cleared.");
  res.json({ success: true, status: llmHelper.getStatus() });
});

app.get("/api/llm/saved-config", (req, res) => {
  const config = loadLocalConfig();
  res.json({
    endpoint: config.endpoint || "",
    deploymentName: config.deploymentName || "",
    useTokenAuth: config.useTokenAuth || false,
    providerType: config.providerType || "",
    // GitHub Models: surface model name and a boolean indicating a PAT is stored (never echo the PAT itself).
    model: config.model || "",
    hasGithubPat: !!config.githubPat,
  });
});

// Re-test the currently configured LLM connection. On failure, automatically
// clears the bad credentials so the user can reconfigure cleanly.
app.post("/api/llm/retest", async (req, res) => {
  const result = await llmHelper.validateCurrent();
  if (!result.ok) {
    // Token went stale at runtime — wipe so next boot doesn't auto-arm.
    llmHelper.configure({ reset: true });
    try {
      const existing = loadLocalConfig();
      const cleared = { ...existing, providerType: "", endpoint: "", apiKey: "", deploymentName: "", useTokenAuth: false, githubPat: "", model: "" };
      fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify(cleared, null, 2), "utf-8");
    } catch (err) {
      console.error(`Retest cleanup: could not clear local config: ${err.message}`);
    }
    console.log(`[LLM] Retest FAILED for ${result.providerType}: ${result.error}. Config cleared.`);
    return res.json({ ok: false, status: result.status, error: result.error, providerType: result.providerType, cleared: true });
  }
  console.log(`[LLM] Retest OK for ${result.providerType}.`);
  res.json({ ok: true, providerType: result.providerType });
});

// ============ SESSION PERSISTENCE ENDPOINTS ============

// List saved sessions
app.get("/api/sessions", (req, res) => {
  res.json(listSavedSessions());
});

// Load a saved session
app.post("/api/sessions/load", (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: "fileName required" });
  const result = loadSessionFromDisk(fileName);
  if (!result) return res.status(404).json({ error: "Session not found or corrupted" });
  res.json({
    sessionId: result.sessionId,
    customerName: result.data.customerName,
    assessmentName: result.data.assessmentName,
    sourceFile: result.data.sourceFile,
    sourceColumns: result.data.sourceColumns || [],
    totalRows: result.data.totalRows,
    validCount: result.data.validCount || 0,
    environments: result.data.environments || [],
    stepsCompleted: result.data.stepsCompleted || {},
    assessmentReport: result.data.assessmentReport,
    wavePlan: result.data.wavePlan,
    envAssessments: result.data.envAssessments,
    bomData: result.data.bomData,
  });
});

// Delete a saved session
app.delete("/api/sessions/:fileName", (req, res) => {
  const fileName = req.params.fileName;
  const filePath = path.join(SESSIONS_DIR, fileName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
  fs.unlinkSync(filePath);
  res.json({ success: true });
});

// List Azure OpenAI accounts in user's subscription.
// Filter covers BOTH the legacy 'OpenAI' kind and the newer 'AIServices' kind
// that Azure AI Foundry now provisions by default. Without 'AIServices' in the
// filter, customers using Foundry Hub see an empty list and assume the tool is
// broken — they're not, the filter was outdated.
app.get("/api/azure/openai-accounts", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId } = req.query;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    // ARM doesn't support OR on $filter for kind, so we list everything and
    // filter client-side. Both kinds expose deployments through the same
    // Cognitive Services control plane, so the deployments endpoint below
    // works for both without changes.
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2023-05-01`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const ACCEPTED_KINDS = new Set(["OpenAI", "AIServices"]);
    const accounts = (data.value || [])
      .filter(a => ACCEPTED_KINDS.has(a.kind))
      .map(a => ({
        name: a.name,
        id: a.id,
        location: a.location,
        kind: a.kind, // exposed so UI can show 'OpenAI' vs 'AIServices (Foundry)' if useful
        endpoint: a.properties?.endpoint || `https://${a.name}.openai.azure.com`,
      }));
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List deployments in an Azure OpenAI account
app.get("/api/azure/openai-deployments", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { accountId } = req.query;
  if (!accountId) return res.status(400).json({ error: "accountId required" });

  try {
    const url = `https://management.azure.com${accountId}/deployments?api-version=2023-05-01`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const deployments = (data.value || []).map(d => ({
      name: d.name,
      model: d.properties?.model?.name || "",
      modelVersion: d.properties?.model?.version || "",
      status: d.properties?.provisioningState || "",
    }));
    res.json(deployments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List serverless (MaaS) model endpoints in the subscription
app.get("/api/azure/serverless-endpoints", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId } = req.query;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    // List all ML online endpoints (serverless) across resource groups
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.MachineLearningServices/workspaces?api-version=2023-06-01-preview`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });

    const endpoints = [];
    // For each workspace, list serverless endpoints
    for (const ws of (data.value || [])) {
      try {
        const seUrl = `https://management.azure.com${ws.id}/serverlessEndpoints?api-version=2024-04-01-preview`;
        const seRes = await fetch(seUrl, { headers: { Authorization: `Bearer ${token}` } });
        const seData = await seRes.json();
        for (const ep of (seData.value || [])) {
          endpoints.push({
            name: ep.name,
            model: ep.properties?.modelSettings?.modelId || ep.name,
            endpoint: ep.properties?.inferenceEndpoint?.uri || "",
            workspace: ws.name,
            location: ws.location,
            status: ep.properties?.provisioningState || "",
          });
        }
      } catch (wsErr) {
        // Skip workspaces we can't access
      }
    }
    res.json(endpoints);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LLM-assisted column mapping. Session-aware: uses the cached source data for samples
// and applies the suggestion immediately, returning the new validation outcome so the
// UI can show real before/after counts.
app.post("/api/llm/suggest-mapping", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!llmHelper.isConfigured()) {
    return res.status(400).json({ error: "LLM not configured. Provide Azure OpenAI details in settings." });
  }
  const session = sessionId ? sessions[sessionId] : null;
  if (!session) {
    return res.status(400).json({ error: "Session not found. Re-upload the inventory file." });
  }
  try {
    const sourceColumns = session.sourceColumns || [];
    const sampleRows = (session.sourceData || []).slice(0, 8).map(r => {
      const o = {}; for (const k of Object.keys(r)) if (k !== "_sheet") o[k] = r[k]; return o;
    });
    // Provide LLM the current baseline (auto-detected) so it has somewhere to start.
    let baselineSpec = session.activeSpec;
    if (!baselineSpec) {
      const auto = buildAutoMapping(sourceColumns, session.sourceData.slice(0, 50));
      baselineSpec = buildBaselineSpec(auto.detected, sourceColumns);
    }

    const suggestion = await llmHelper.suggestColumnMapping(
      sourceColumns,
      templateHeaders,
      sampleRows,
      baselineSpec,
    );
    if (!suggestion || typeof suggestion !== "object") {
      return res.status(502).json({ error: "AI returned no usable mapping. Check model deployment and try again." });
    }

    // Sanitize against actual source columns and template headers.
    const aiSpec = sanitizeSpec(suggestion, sourceColumns);

    // Merge: AI overrides baseline only where it produced a non-null entry. Targets the
    // AI omits or nullifies fall back to the baseline so we never regress coverage.
    const mergedSpec = {};
    for (const target of templateHeaders) {
      const t = target.trim();
      const ai = aiSpec[t];
      const base = baselineSpec ? baselineSpec[t] : null;
      mergedSpec[t] = ai != null ? ai : (base != null ? base : null);
    }

    const compiled = compileMappingSpec(mergedSpec);
    const quality = assessInventoryQuality(session.sourceData, compiled);

    if (!quality.looksLikeInventory) {
      return res.status(200).json({
        applied: false,
        inventoryQualityIssue: {
          message: "Even after AI mapping, required columns (server name, CPU/cores, memory, OS) cannot be filled for most rows. This file does not appear to be a server inventory.",
          details: quality.issues,
        },
        activeSpec: mergedSpec,
        mappingInfo: specToMappingInfo(mergedSpec, sourceColumns),
      });
    }

    reprocessSession(session, sessionId, compiled, "AI-assisted");
    session.activeSpec = mergedSpec;

    res.json({
      applied: true,
      sessionId,
      mappingSource: "AI-assisted",
      activeSpec: mergedSpec,
      mappingInfo: specToMappingInfo(mergedSpec, sourceColumns),
      totalRows: session.totalRows,
      validRows: session.validCount,
      invalidRows: session.invalidCount,
      errors: session.errors,
      report: session.reportText,
      hasErrors: session.invalidCount > 0,
    });
  } catch (err) {
    console.error("[AI mapping] error:", err);
    res.status(500).json({ error: err.message });
  }
});

// Manual remap: user-edited mapping spec applied to a session's cached source data.
app.post("/api/sessions/:sessionId/remap", (req, res) => {
  const { sessionId } = req.params;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  const { spec } = req.body || {};
  if (!spec || typeof spec !== "object") {
    return res.status(400).json({ error: "Missing mapping spec" });
  }
  try {
    const sourceColumns = session.sourceColumns || [];
    const cleaned = sanitizeSpec(spec, sourceColumns);
    const compiled = compileMappingSpec(cleaned);
    const quality = assessInventoryQuality(session.sourceData, compiled);
    reprocessSession(session, sessionId, compiled, "user-edited");
    session.activeSpec = cleaned;
    res.json({
      sessionId,
      mappingSource: "user-edited",
      activeSpec: cleaned,
      mappingInfo: specToMappingInfo(cleaned, sourceColumns),
      totalRows: session.totalRows,
      validRows: session.validCount,
      invalidRows: session.invalidCount,
      errors: session.errors,
      report: session.reportText,
      hasErrors: session.invalidCount > 0,
      inventoryQualityIssue: !quality.looksLikeInventory ? {
        message: "Required columns (server name, CPU/cores, memory, OS) are still unfilled for most rows.",
        details: quality.issues,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/azure/config", (req, res) => {
  res.json({
    clientId: AZURE_CONFIG.clientId,
    tenantId: AZURE_CONFIG.tenantId,
    redirectUri: AZURE_CONFIG.redirectUri,
    configured: !!AZURE_CONFIG.clientId,
  });
});

app.post("/api/azure/config", (req, res) => {
  const { clientId, tenantId } = req.body;
  if (clientId) AZURE_CONFIG.clientId = clientId;
  if (tenantId) AZURE_CONFIG.tenantId = tenantId;
  AZURE_CONFIG.redirectUri = `http://localhost:${PORT}/auth/callback`;
  res.json({ success: true });
});

app.get("/auth/login", (req, res) => {
  if (!AZURE_CONFIG.clientId) {
    return res.status(400).send("Azure Client ID not configured.");
  }
  const state = crypto.randomUUID();
  const authUrl = `https://login.microsoftonline.com/${AZURE_CONFIG.tenantId}/oauth2/v2.0/authorize?` +
    `client_id=${encodeURIComponent(AZURE_CONFIG.clientId)}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(AZURE_CONFIG.redirectUri)}` +
    `&scope=${encodeURIComponent(AZURE_CONFIG.scope)}` +
    `&state=${state}` +
    `&response_mode=query`;
  res.redirect(authUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { code, error, error_description } = req.query;
  if (error) {
    return res.send(`<script>window.opener.postMessage({type:'auth_error',error:${JSON.stringify(error_description)}},'*');window.close();</script>`);
  }
  if (!code) {
    return res.send(`<script>window.opener.postMessage({type:'auth_error',error:'No authorization code received'},'*');window.close();</script>`);
  }

  try {
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${AZURE_CONFIG.tenantId}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: AZURE_CONFIG.clientId,
        code,
        redirect_uri: AZURE_CONFIG.redirectUri,
        grant_type: "authorization_code",
        scope: AZURE_CONFIG.scope,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (tokenData.error) {
      return res.send(`<script>window.opener.postMessage({type:'auth_error',error:${JSON.stringify(tokenData.error_description)}},'*');window.close();</script>`);
    }

    const tokenId = crypto.randomUUID();
    sessions[`token_${tokenId}`] = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      expiresAt: Date.now() + (tokenData.expires_in * 1000),
    };

    res.send(`<script>window.opener.postMessage({type:'auth_success',tokenId:'${tokenId}'},'*');window.close();</script>`);
  } catch (err) {
    res.send(`<script>window.opener.postMessage({type:'auth_error',error:${JSON.stringify(err.message)}},'*');window.close();</script>`);
  }
});

// ============ AZURE MANAGEMENT ROUTES ============

// Azure Migrate supported geographies (from official docs)
const AZURE_MIGRATE_GEOGRAPHIES = [
  { geography: "Malaysia", location: "malaysiawest" },
  { geography: "Asia Pacific", location: "eastasia" },
  { geography: "Australia", location: "australiaeast" },
  { geography: "Brazil", location: "brazilsouth" },
  { geography: "Canada", location: "canadacentral" },
  { geography: "Europe", location: "northeurope" },
  { geography: "France", location: "francecentral" },
  { geography: "Germany", location: "germanywestcentral" },
  { geography: "India", location: "centralindia" },
  { geography: "Italy", location: "northitaly" },
  { geography: "Japan", location: "japaneast" },
  { geography: "Korea", location: "koreacentral" },
  { geography: "Norway", location: "norwayeast" },
  { geography: "Sweden", location: "swedencentral" },
  { geography: "Switzerland", location: "switzerlandnorth" },
  { geography: "United Arab Emirates", location: "uaenorth" },
  { geography: "United Kingdom", location: "uksouth" },
  { geography: "United States", location: "centralus" },
];

app.get("/api/azure/geographies", (req, res) => {
  res.json(AZURE_MIGRATE_GEOGRAPHIES);
});

app.get("/api/azure/subscriptions", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  try {
    const response = await fetch("https://management.azure.com/subscriptions?api-version=2022-12-01", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List resource groups in a subscription
app.get("/api/azure/resource-groups", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId } = req.query;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    const response = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List Azure Migrate projects in a resource group (or all in subscription)
app.get("/api/azure/migrate-projects", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId, resourceGroup } = req.query;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    let url;
    if (resourceGroup) {
      url = `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${resourceGroup}/providers/Microsoft.Migrate/migrateProjects?api-version=2018-09-01-preview`;
    } else {
      url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Migrate/migrateProjects?api-version=2018-09-01-preview`;
    }
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    res.json(data.value || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/azure/create-project", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });

  const { subscriptionId, projectName, geography, customerName } = req.body;
  if (!subscriptionId || !projectName || !geography) {
    return res.status(400).json({ error: "subscriptionId, projectName, and geography are required" });
  }

  const rgName = `rg-${customerName || projectName}-azmigrate`.toLowerCase().replace(/[^a-z0-9-]/g, "");
  const location = mapGeographyToLocation(geography);

  try {
    // Create Resource Group
    const rgResponse = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/resourcegroups/${rgName}?api-version=2021-04-01`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ location }),
      }
    );
    const rgData = await rgResponse.json();
    if (rgData.error) {
      return res.status(400).json({ error: `RG creation failed: ${rgData.error.message}`, step: "resource_group" });
    }

    // Create Azure Migrate Project
    const migrateProjectName = projectName.replace(/[^a-zA-Z0-9-]/g, "");
    const randomSuffix = Math.random().toString(16).substring(2, 6);
    const assessProjectName = `${migrateProjectName}${randomSuffix}project`;
    const masterSiteName = `${migrateProjectName}${randomSuffix}masterSite`;
    const importSiteName = `${migrateProjectName}${randomSuffix}importSite`;

    const projectResponse = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Migrate/migrateProjects/${migrateProjectName}?api-version=2018-09-01-preview`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          location,
          eTag: "",
          identity: {
            type: "SystemAssigned",
          },
          properties: {
            registeredTools: ["ServerAssessment", "ServerDiscovery_Import"],
            publicNetworkAccess: "Enabled",
          },
        }),
      }
    );
    const projectData = await projectResponse.json();
    console.log(`[CreateProject] migrateProject response: ${projectResponse.status}`, JSON.stringify(projectData).substring(0, 500));
    if (projectData.error) {
      return res.status(400).json({ error: `Project creation failed: ${projectData.error.message}`, step: "migrate_project" });
    }

    // // Create Master Site (microsoft.offazure/MasterSites)
    // console.log(`[CreateProject] Creating masterSite: ${masterSiteName}`);
    // const masterSiteRes = await fetch(
    //   `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.OffAzure/masterSites/${masterSiteName}?api-version=2023-06-06`,
    //   {
    //     method: "PUT",
    //     headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    //     body: JSON.stringify({
    //       location,
    //       properties: {
    //         allowMultipleSites: true,
    //         sites: [],
    //       },
    //     }),
    //   }
    // );
    // const masterSiteData = await masterSiteRes.json();
    // console.log(`[CreateProject] masterSite response: ${masterSiteRes.status}`, JSON.stringify(masterSiteData).substring(0, 500));

    // // Create Import Site (microsoft.offazure/ImportSites)
    // console.log(`[CreateProject] Creating importSite: ${importSiteName}`);
    // const discoverySolutionId = `/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Migrate/migrateProjects/${migrateProjectName}/solutions/Servers-Discovery-ServerDiscovery`;
    // const importSiteRes = await fetch(
    //   `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.OffAzure/importSites/${importSiteName}?api-version=2023-06-06`,
    //   {
    //     method: "PUT",
    //     headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    //     body: JSON.stringify({
    //       location,
    //       properties: {
    //         discoverySolutionId,
    //       },
    //     }),
    //   }
    // );
    // const importSiteData = await importSiteRes.json();
    // console.log(`[CreateProject] importSite response: ${importSiteRes.status}`, JSON.stringify(importSiteData).substring(0, 300));

    // Create Assessment Project (Microsoft.Migrate/assessmentProjects)
    console.log(`[CreateProject] Creating assessmentProject: ${assessProjectName}`);
    const assessResponse = await fetch(
      `https://management.azure.com/subscriptions/${subscriptionId}/resourceGroups/${rgName}/providers/Microsoft.Migrate/assessmentProjects/${assessProjectName}?api-version=2023-03-15`,
      {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          location,
          properties: {
            projectStatus: "Active",
          },
        }),
      }
    );
    const assessData = await assessResponse.json();
    console.log(`[CreateProject] assessmentProject response: ${assessResponse.status}`, JSON.stringify(assessData).substring(0, 500));
    if (assessData.error) {
      console.log(`[CreateProject] assessmentProject warning: ${assessData.error.message}`);
    }

    res.json({
      success: true,
      resourceGroup: rgName,
      projectName: migrateProjectName,
      location,
      subscriptionId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/azure/import-discovery", async (req, res) => {
  // Keep for backward compat but now just returns the session data
  const session = sessions[req.body.sessionId];
  if (!session) return res.status(404).json({ error: "Upload session not found." });
  res.json({ success: true, message: "Use the new assessment flow instead.", serverCount: session.validCount });
});

// ============ NEW: LLM-DRIVEN ASSESSMENT ENDPOINTS ============
const assessment = require("./assessment");
const assessmentConfig = require("./assessmentConfig");

// Get assessment config (VM series, pricing models, etc.) — driven by SKUSizingLogic.json
app.get("/api/assessment/config", (req, res) => {
  const cfg = assessment.sizingConfig;
  res.json({
    vmSeries: cfg.compute.vmSeriesPreference || assessmentConfig.VM_SERIES,
    pricingModels: cfg.compute.pricingModels || assessmentConfig.PRICING_MODELS,
    ahubOptions: cfg.ahubOptions || assessmentConfig.AHUB_OPTIONS,
    regions: cfg.regions || assessmentConfig.AZURE_REGIONS,
    diskType: cfg.storage.diskType,
    rightSizingMode: cfg.rightSizing.mode,
    securityEnabled: cfg.security?.defenderForCloud?.include !== false,
  });
});

// Get VM sizes for a region (with cache)
app.get("/api/azure/vm-sizes", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId, region } = req.query;
  if (!subscriptionId || !region) return res.status(400).json({ error: "subscriptionId and region required" });

  try {
    const result = await assessment.fetchVmSizesWithSub(region, subscriptionId, token);
    res.json({ data: result.data, fromCache: result.fromCache, count: result.data.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-fetch pricing for a region (called when region selected)
app.get("/api/assessment/prefetch-pricing", async (req, res) => {
  const { region, pricingModel } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });
  const model = pricingModel || "3yr_ri";

  try {
    const vmResult = await assessment.fetchAllVmPricing(region, model);
    const diskResult = await assessment.fetchAllDiskPricing(region);
    const secResult = await assessment.fetchSecurityPricing(region);
    res.json({
      vmPricingCount: Object.keys(vmResult.data).length,
      diskPricingCount: Object.keys(diskResult.data).length,
      securityPerServer: secResult.data.perServerMonth,
      vmFromCache: vmResult.fromCache,
      diskFromCache: diskResult.fromCache,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Pre-fetch all caches for a region (SKUs + pricing + security) - background call on region change
app.get("/api/assessment/prefetch-region", async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });
  const token = getToken(req);
  const subId = req.query.subscriptionId;

  try {
    const skuResult = await assessment.fetchVmSizesWithSub(region, subId, token);
    const vmPricing3yr = await assessment.fetchAllVmPricing(region, "3yr_ri");
    const vmPricingPayg = await assessment.fetchAllVmPricing(region, "payg");
    const vmPricing1yr = await assessment.fetchAllVmPricing(region, "1yr_ri");
    const diskResult = await assessment.fetchAllDiskPricing(region);
    const secResult = await assessment.fetchSecurityPricing(region);
    res.json({
      skuCount: skuResult.data.length,
      skuFromCache: skuResult.fromCache,
      securityPerServer: secResult.data.perServerMonth,
      pricingCached: { payg: vmPricingPayg.fromCache, "1yr_ri": vmPricing1yr.fromCache, "3yr_ri": vmPricing3yr.fromCache },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Run full assessment (SSE stream with progress)
app.post("/api/assessment/run", async (req, res) => {
  const token = getToken(req); // Optional — used for ARM VM specs if available

  const { subscriptionId, sessionId, region, assessmentName, pricingModel, useAhub, enabledSeries, cpuArchitecture, storageTier, securityEnabled, sizingMode } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Upload session not found. Re-upload inventory." });

  // SSE setup
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  function sendEvent(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

  try {
    // Parse servers from the output CSV
    const servers = (() => {
      const csvPath = session.azMigratePath;
      if (csvPath && fs.existsSync(csvPath)) {
        const csvContent = fs.readFileSync(csvPath, "utf-8");
        const lines = csvContent.split("\n").filter(l => l.trim());
        if (lines.length < 2) return [];
        const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
        return lines.slice(1).map(line => {
          const values = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
          const row = {};
          headers.forEach((h, i) => { row[h] = values[i] || ""; });
          return row;
        });
      }
      return [];
    })();

    // Try to match with original inventory to get extra columns (any custom/tag columns)
    if (session.originalData && Array.isArray(session.originalData)) {
      const originalCols = Object.keys(session.originalData[0] || {});
      // Determine which source columns are already used for Azure Migrate mapping
      const mappingModule = require("./columnMapping");
      const mappedSourceCols = new Set();
      for (const [key, val] of Object.entries(mappingModule)) {
        if (typeof val === "string") mappedSourceCols.add(val.toLowerCase());
      }
      // Also exclude common identifiers already captured as server name
      mappedSourceCols.add("host name");
      mappedSourceCols.add("server name");
      mappedSourceCols.add("hostname");
      // Extra columns = all original columns NOT used as a mapping source
      const extraColNames = originalCols.filter(c =>
        !mappedSourceCols.has(c.toLowerCase()) && c.trim() !== ""
      );
      if (extraColNames.length > 0) {
        // Same indexed lookup as the multi-env path so duplicate hostnames
        // (common in DR inventories) map back to their original rows correctly.
        const originalsByName = new Map();
        for (const r of session.originalData) {
          const h = (r["Host name"] || r["Server Name"] || r["Hostname"] || r["host name"] || "").toString().trim().toLowerCase();
          if (!h) continue;
          if (!originalsByName.has(h)) originalsByName.set(h, []);
          originalsByName.get(h).push(r);
        }
        const stripDupSuffix = (name) => String(name || "").replace(/_\d+$/, "");
        for (const server of servers) {
          const serverName = server["*Server name"];
          const lookupName = stripDupSuffix(serverName).toLowerCase();
          const bucket = originalsByName.get(lookupName);
          if (!bucket || bucket.length === 0) continue;
          const origRow = bucket.shift();
          server._extraColumns = {};
          for (const col of extraColNames) {
            if (origRow[col] != null && origRow[col] !== "") server._extraColumns[col] = origRow[col];
          }
        }
      }
    }

    const totalServers = servers.length;
    if (totalServers === 0) {
      sendEvent({ type: "error", message: "No servers found. Please upload and map inventory first (Steps 1 & 2)." });
      res.end(); return;
    }

    const pricing = pricingModel || "3yr_ri";
    const ahub = useAhub !== false;
    const arch = cpuArchitecture || assessment.sizingConfig.cpuArchitecture?.default || "amd";
    const diskTier = storageTier && storageTier !== "auto" ? storageTier : null;
    const series = enabledSeries || assessment.sizingConfig.compute.vmSeriesPreference
      .filter(s => s.defaultEnabled).map(s => s.id);
    const totalSteps = 5;
    const stepStartTime = Date.now();

    // Step 1: Fetch VM sizes (cached)
    sendEvent({ type: "progress", step: 1, totalSteps, label: `Fetching VM sizes for ${region}...`, serverCount: totalServers });
    const vmResult = await assessment.fetchVmSizesWithSub(region, subscriptionId, token);
    const vmSizes = vmResult.data;
    if (vmSizes.length === 0) {
      sendEvent({ type: "error", message: `No VM sizes found for region ${region}.` });
      res.end(); return;
    }
    sendEvent({ type: "progress", step: 1, totalSteps, label: `${vmSizes.length} VM sizes${vmResult.fromCache ? " (cached)" : ""}`, serverCount: totalServers, done: true });

    // Step 2: First-pass matching
    sendEvent({ type: "progress", step: 2, totalSteps, label: `Matching ${totalServers} servers internally...`, serverCount: totalServers });
    const firstPassResults = assessment.runFirstPassMatching(servers, vmSizes, series, arch, diskTier, sizingMode);
    const matchedCount = firstPassResults.filter(r => r.vmMatch).length;
    sendEvent({ type: "progress", step: 2, totalSteps, label: `Matched ${matchedCount}/${totalServers} servers`, serverCount: totalServers, done: true });

    // Step 3: LLM optimization (skip if not configured)
    const llmConfigured = llmHelper.isConfigured();
    if (llmConfigured) {
      sendEvent({ type: "progress", step: 3, totalSteps, label: "LLM optimizing SKU sizing...", serverCount: totalServers });
      const optimizedResults = await assessment.llmOptimizeMatching(firstPassResults, vmSizes, region, series);
      const llmOptCount = optimizedResults.filter(r => r.llmOptimized).length;
      sendEvent({ type: "progress", step: 3, totalSteps, label: `LLM optimized ${llmOptCount} recommendations`, serverCount: totalServers, done: true });
      var finalResults = optimizedResults;
    } else {
      sendEvent({ type: "progress", step: 3, totalSteps, label: "LLM not configured — skipped", serverCount: totalServers, done: true });
      var finalResults = firstPassResults;
    }

    // Step 4: Fetch pricing (cached)
    sendEvent({ type: "progress", step: 4, totalSteps, label: `Fetching pricing (${pricing})...`, serverCount: totalServers });
    const vmPricingResult = await assessment.fetchAllVmPricing(region, pricing, ({ page, skus }) => {
      sendEvent({ type: "progress", step: 4, totalSteps, label: `Fetching pricing page ${page}... (${skus} SKUs so far)`, serverCount: totalServers });
    });
    const diskPricingResult = await assessment.fetchAllDiskPricing(region);
    const secPricingResult = await assessment.fetchSecurityPricing(region);
    const securityPrice = secPricingResult.data.perServerMonth;
    sendEvent({ type: "progress", step: 4, totalSteps, label: `${Object.keys(vmPricingResult.data).length} VM + ${Object.keys(diskPricingResult.data).length} disk prices${vmPricingResult.fromCache ? " (cached)" : ""}`, serverCount: totalServers, done: true });

    // Step 5: Generate report
    const secEnabled = securityEnabled !== false;
    sendEvent({ type: "progress", step: 5, totalSteps, label: "Generating report...", serverCount: totalServers });
    const report = assessment.generateAssessmentReport(finalResults, vmPricingResult.data, diskPricingResult.data, {
      assessmentName, region, pricingModel: pricing, useAhub: ahub, vmSizes, enabledSeries: series, cpuArchitecture: arch,
      securityEnabled: secEnabled, securityPerServerPrice: securityPrice, sizingModeOverride: sizingMode,
    });

    session.assessmentReport = report;
    session.lastSecurityPrice = securityPrice;
    // Store matched data for re-generation without re-running
    session.lastMatchedServers = finalResults;
    session.lastVmSizes = vmSizes;
    session.lastEnabledSeries = series;
    session.lastCpuArchitecture = arch;
    session.lastSizingMode = sizingMode || "auto";

    const totalTime = Date.now() - stepStartTime;
    sendEvent({ type: "progress", step: 5, totalSteps, label: "Report complete!", serverCount: totalServers, done: true });
    sendEvent({ type: "complete", report, totalTime });
    res.end();

  } catch (err) {
    console.error("[Assessment] Error:", err);
    sendEvent({ type: "error", message: err.message });
    res.end();
  }
});

// Re-generate report with different pricing/AHUB/security (no re-matching, instant)
app.post("/api/assessment/recalculate", async (req, res) => {
  const { sessionId, region, assessmentName, pricingModel, useAhub, cpuArchitecture, securityEnabled, sizingMode, paygHoursPerMonth } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.lastMatchedServers) {
    return res.status(404).json({ error: "No matched data. Run assessment first." });
  }

  try {
    const pricing = pricingModel || "3yr_ri";
    const ahub = useAhub !== false;
    const arch = cpuArchitecture || session.lastCpuArchitecture || "amd";
    const secEnabled = securityEnabled !== false;
    const securityPrice = session.lastSecurityPrice || 15.00;
    const vmPricingResult = await assessment.fetchAllVmPricing(region, pricing);
    const diskPricingResult = await assessment.fetchAllDiskPricing(region);

    const effectiveSizingMode = sizingMode || session.lastSizingMode || "auto";
    const report = assessment.generateAssessmentReport(session.lastMatchedServers, vmPricingResult.data, diskPricingResult.data, {
      assessmentName, region, pricingModel: pricing, useAhub: ahub,
      vmSizes: session.lastVmSizes || [], enabledSeries: session.lastEnabledSeries || [],
      cpuArchitecture: arch, securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
      sizingModeOverride: effectiveSizingMode,
      paygHoursPerMonth,
    });

    session.assessmentReport = report;
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get stored assessment report
app.get("/api/assessment/report", (req, res) => {
  const { sessionId } = req.query;
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport) {
    return res.status(404).json({ error: "No assessment report found. Run assessment first." });
  }
  res.json(session.assessmentReport);
});

// ============ MULTI-ENVIRONMENT ASSESSMENT ============
app.post("/api/assessment/run-multi", async (req, res) => {
  const { sessionId, subscriptionId, region, assessmentName, envConfigs, customerName, skipLlm } = req.body;
  // envConfigs: { "Prod": {pricingModel, useAhub, enabledSeries, cpuArchitecture, securityEnabled}, ... }
  const session = sessions[sessionId];
  const token = getToken(req);
  if (!session) { res.status(404).json({ error: "Session not found" }); return; }
  if (assessmentName) session.assessmentName = assessmentName;
  if (customerName) session.customerName = customerName;

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  function sendEvent(data) { res.write(`data: ${JSON.stringify(data)}\n\n`); }

  try {
    const envColumn = session.envColumn;
    const environments = Object.keys(envConfigs);
    const totalEnvs = environments.length;

    // Parse servers from CSV
    const allServers = (() => {
      const csvPath = session.azMigratePath;
      if (csvPath && fs.existsSync(csvPath)) {
        const csvContent = fs.readFileSync(csvPath, "utf-8");
        const lines = csvContent.split("\n").filter(l => l.trim());
        if (lines.length < 2) return [];
        const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
        return lines.slice(1).map(line => {
          const values = line.split(",").map(v => v.trim().replace(/^"|"$/g, ""));
          const row = {};
          headers.forEach((h, i) => { row[h] = values[i] || ""; });
          return row;
        });
      }
      return [];
    })();

    // Attach extra columns from original data
    if (session.originalData && Array.isArray(session.originalData)) {
      const originalCols = Object.keys(session.originalData[0] || {});
      const mappingModule = require("./columnMapping");
      const mappedSourceCols = new Set();
      for (const [key, val] of Object.entries(mappingModule)) {
        if (typeof val === "string") mappedSourceCols.add(val.toLowerCase());
      }
      mappedSourceCols.add("host name"); mappedSourceCols.add("server name"); mappedSourceCols.add("hostname");
      const extraColNames = originalCols.filter(c => !mappedSourceCols.has(c.toLowerCase()) && c.trim() !== "");
      if (extraColNames.length > 0) {
        // Index original rows by hostname, lower-cased. Build it once, then
        // each server lookup is O(1) instead of O(N). For inventories with
        // duplicate hostnames (common in DR sites — same names as primary),
        // the index keeps a list per name; we pop the next one each time the
        // same name is seen so the 1st duplicate maps to the 1st original
        // row, the 2nd to the 2nd, and so on.
        const originalsByName = new Map();
        for (const r of session.originalData) {
          const h = (r["Host name"] || r["Server Name"] || r["Hostname"] || r["host name"] || "").toString().trim().toLowerCase();
          if (!h) continue;
          if (!originalsByName.has(h)) originalsByName.set(h, []);
          originalsByName.get(h).push(r);
        }
        // We mutate the Map by shifting matched rows out, so the duplicate
        // suffix logic ('foo' → 'foo_1' → 'foo_2') correctly maps each renamed
        // server back to its original row. processMapping() suffixes duplicates
        // with '_N' (N starting from 1), so to recover the original we strip
        // a trailing '_<digits>' before lookup.
        const stripDupSuffix = (name) => String(name || "").replace(/_\d+$/, "");
        for (const server of allServers) {
          const serverName = server["*Server name"];
          const lookupName = stripDupSuffix(serverName).toLowerCase();
          const bucket = originalsByName.get(lookupName);
          if (!bucket || bucket.length === 0) continue;
          const origRow = bucket.shift();
          server._extraColumns = {};
          for (const col of extraColNames) {
            if (origRow[col] != null && origRow[col] !== "") server._extraColumns[col] = origRow[col];
          }
        }
      }
    }

    if (allServers.length === 0) {
      sendEvent({ type: "error", message: "No servers found." }); res.end(); return;
    }

    // Step 1: Fetch VM sizes (shared across all envs)
    sendEvent({ type: "progress", envName: "_global", step: 1, label: `Fetching VM sizes for ${region}...` });
    const vmResult = await assessment.fetchVmSizesWithSub(region, subscriptionId, token);
    const vmSizes = vmResult.data;
    if (vmSizes.length === 0) { sendEvent({ type: "error", message: `No VM sizes for region ${region}.` }); res.end(); return; }
    sendEvent({ type: "progress", envName: "_global", step: 1, label: `${vmSizes.length} VM sizes ready`, done: true });

    // Step 2: Fetch all needed pricing models (deduplicated)
    const pricingModelsNeeded = [...new Set(environments.map(e => envConfigs[e].pricingModel || "3yr_ri"))];
    const pricingCache = {};
    for (const pm of pricingModelsNeeded) {
      sendEvent({ type: "progress", envName: "_global", step: 2, label: `Fetching ${pm} pricing...` });
      const result = await assessment.fetchAllVmPricing(region, pm, ({ page, skus }) => {
        sendEvent({ type: "progress", envName: "_global", step: 2, label: `Pricing ${pm}: page ${page} (${skus} SKUs)` });
      });
      pricingCache[pm] = result.data;
    }
    const diskPricingResult = await assessment.fetchAllDiskPricing(region);
    const secPricingResult = await assessment.fetchSecurityPricing(region);
    const securityPrice = secPricingResult.data.perServerMonth;
    sendEvent({ type: "progress", envName: "_global", step: 2, label: "All pricing cached", done: true });

    // Step 3+: Per-environment assessment
    // IMPORTANT: do NOT wipe the entire envAssessments map — the frontend only
    // sends envs that need re-running (e.g. user changed Storage Profile on
    // just Prod). Wiping here would drop UAT/SIT/Dev assessments on disk and
    // make the combined total appear to "only show Prod price". We replace
    // each env's record only when we actually re-run it below.
    session.envAssessments = session.envAssessments || {};
    session.lastVmSizes = vmSizes;
    session.lastSecurityPrice = securityPrice;

    for (let envIdx = 0; envIdx < totalEnvs; envIdx++) {
      const envName = environments[envIdx];
      const config = envConfigs[envName];
      const pricing = config.pricingModel || "3yr_ri";
      const ahub = config.useAhub !== false;
      const arch = config.cpuArchitecture || "amd";
      const diskTier = config.storageTier && config.storageTier !== "auto" ? config.storageTier : null;
      const series = config.enabledSeries || [];
      const secEnabled = config.securityEnabled !== false;
      const sizingMode = config.sizingMode || "auto";
      const paygHours = (pricing === "payg") ? Number(config.paygHoursPerMonth) || null : null;
      // Industry-optimisation factors — only meaningful when sizingMode is
      // 'industry-optimized'. Stored on the env so a later recalculate-env
      // (e.g. pricing-only flip) can reuse them.
      const cpuOptF = Number(config.cpuOptimisationFactor);
      const ramOptF = Number(config.ramOptimisationFactor);
      const cpuOptimisationFactor = Number.isFinite(cpuOptF) && cpuOptF > 0 ? cpuOptF : null;
      const ramOptimisationFactor = Number.isFinite(ramOptF) && ramOptF > 0 ? ramOptF : null;
      // Cost mode: 'lns' (default) | 'dr-defer' | 'exclude'.
      // 'exclude' = skip sizing entirely. 'dr-defer' = size + price normally,
      // but cost contribution is held for Step 5 to apply a DR-strategy multiplier.
      const costMode = config.costMode === "exclude" || config.costMode === "dr-defer" ? config.costMode : "lns";

      // Filter servers for this environment
      let envServers;
      if (envName === "All") {
        envServers = allServers;
      } else {
        envServers = allServers.filter(s => {
          const envVal = (s._extraColumns && s._extraColumns[envColumn]) || "";
          const normalized = envVal.trim() || "Unknown";
          return normalized === envName;
        });
      }

      sendEvent({ type: "env-progress", envName, envIdx: envIdx + 1, totalEnvs, label: `Assessing ${envName} (${envServers.length} servers)...`, serverCount: envServers.length });

      // 'exclude' mode: short-circuit — no matching, no pricing. Surface a stub
      // report so the env still appears in the UI with a clear 'excluded' state.
      if (costMode === "exclude") {
        const stubReport = {
          assessmentName: `${assessmentName} - ${envName}`,
          region,
          timestamp: new Date().toISOString(),
          pricingModel: "Excluded",
          pricingModelId: pricing,
          useAhub: ahub,
          costMode: "exclude",
          sizingSummary: { modeRequested: sizingMode, totalServers: envServers.length, asAllocated: 0, performanceBased: 0, performanceBasedPartial: 0, flooredCount: 0, cappedCount: 0, zeroFallbackCount: 0, missingFallbackCount: 0 },
          summary: { totalServers: envServers.length, suitable: 0, notSuitable: 0, rematched: 0, totalMonthlyCompute: 0, totalMonthlyStorage: 0, totalMonthlySecurity: 0, totalMonthlyCost: 0, totalAnnualCompute: 0, totalAnnualStorage: 0, totalAnnualSecurity: 0, totalAnnualCost: 0 },
          deferredSummary: { totalServers: 0, totalMonthlyCompute: 0, totalMonthlyStorage: 0, totalMonthlySecurity: 0, totalMonthlyCost: 0 },
          servers: envServers.map(s => ({
            serverName: s["*Server name"] || s.serverName || "",
            cores: 0, memoryMB: 0, osName: s["*OS name"] || s.osName || "", osVersion: "",
            recommendedVm: "Excluded", vmCores: 0, vmMemoryMB: 0,
            computeMonthlyCost: 0, diskDetails: [], storageMonthlyCost: 0, securityMonthlyCost: 0, totalMonthlyCost: 0,
            costDeferredToDr: false, costExcluded: true,
            suitability: "Excluded", isWindows: (s["*OS name"] || "").toLowerCase().includes("windows"),
            extraColumns: s._extraColumns || {},
            sizingMode, sizingReason: "Environment excluded from sizing", reqCores: 0, reqMemoryMB: 0, note: "Excluded by user",
          })),
        };
        session.envAssessments[envName] = {
          report: stubReport,
          matchedServers: [],
          inputServers: envServers,
          enabledSeries: series,
          cpuArchitecture: arch,
          storageTier: diskTier,
          pricingModel: pricing,
          useAhub: ahub,
          securityEnabled: secEnabled,
          sizingMode,
          paygHoursPerMonth: paygHours,
          costMode: "exclude",
        };
        sendEvent({ type: "env-complete", envName, envIdx: envIdx + 1, totalEnvs, report: stubReport });
        continue;
      }

      // Match
      const firstPassResults = assessment.runFirstPassMatching(envServers, vmSizes, series, arch, diskTier, sizingMode, { cpuOptimisationFactor, ramOptimisationFactor });

      // LLM (skip if not configured or user opted out)
      let finalResults;
      if (llmHelper.isConfigured() && !skipLlm) {
        finalResults = await assessment.llmOptimizeMatching(firstPassResults, vmSizes, region, series, (progress) => {
          sendEvent({ type: "env-substatus", envName, substatus: progress });
        });
      } else {
        finalResults = firstPassResults;
      }

      // Generate report for this env
      const vmPricingData = pricingCache[pricing];
      const report = assessment.generateAssessmentReport(finalResults, vmPricingData, diskPricingResult.data, {
        assessmentName: `${assessmentName} - ${envName}`, region, pricingModel: pricing, useAhub: ahub,
        vmSizes, enabledSeries: series, cpuArchitecture: arch,
        securityEnabled: secEnabled, securityPerServerPrice: securityPrice, sizingModeOverride: sizingMode,
        paygHoursPerMonth: paygHours,
        costMode,
        cpuOptimisationFactor, ramOptimisationFactor,
      });

      session.envAssessments[envName] = {
        report,
        matchedServers: finalResults,
        inputServers: envServers,
        enabledSeries: series,
        cpuArchitecture: arch,
        storageTier: diskTier,
        pricingModel: pricing,
        useAhub: ahub,
        securityEnabled: secEnabled,
        sizingMode,
        paygHoursPerMonth: paygHours,
        costMode,
        cpuOptimisationFactor, ramOptimisationFactor,
      };

      sendEvent({ type: "env-complete", envName, envIdx: envIdx + 1, totalEnvs, report });
    }

    // Combined summary
    const combined = buildCombinedSummary(session.envAssessments, assessmentName, region);
    session.assessmentReport = combined;
    session.lastMatchedServers = allServers; // for backward compat

    // Auto-save session after successful assessment
    saveSessionToDisk(sessionId);

    sendEvent({ type: "all-complete", combined });
    res.end();

  } catch (err) {
    console.error("[Multi-Assessment] Error:", err);
    sendEvent({ type: "error", message: err.message });
    res.end();
  }
});

// Recalculate single environment (instant, no re-matching)
app.post("/api/assessment/recalculate-env", async (req, res) => {
  const { sessionId, envName, region, assessmentName, pricingModel, useAhub, cpuArchitecture, securityEnabled, sizingMode, paygHoursPerMonth, costMode, cpuOptimisationFactor, ramOptimisationFactor } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.envAssessments || !session.envAssessments[envName]) {
    return res.status(404).json({ error: "No assessment data for this environment." });
  }

  try {
    const envData = session.envAssessments[envName];
    const pricing = pricingModel || envData.pricingModel || "3yr_ri";
    const ahub = useAhub !== undefined ? useAhub : envData.useAhub;
    const arch = cpuArchitecture || envData.cpuArchitecture || "amd";
    const secEnabled = securityEnabled !== undefined ? securityEnabled : envData.securityEnabled;
    const securityPrice = session.lastSecurityPrice || 15.00;
    const newSizingMode = sizingMode !== undefined ? sizingMode : (envData.sizingMode || "auto");
    // PAYG hours: only meaningful when pricing model is PAYG. Use payload value if provided,
    // else fall back to whatever was last stored on the env (default null = engine uses 730).
    const paygHours = (pricing === "payg")
      ? (paygHoursPerMonth !== undefined ? (Number(paygHoursPerMonth) || null) : (envData.paygHoursPerMonth || null))
      : null;
    // Cost mode: payload wins; fallback to stored mode. 'exclude' here is a no-op
    // for cost (we just keep the stub) — changing TO 'exclude' from a sized state
    // requires a re-run, so we treat any incoming 'exclude' the same as a re-run signal.
    const newCostMode = (costMode === "exclude" || costMode === "dr-defer" || costMode === "lns") ? costMode : (envData.costMode || "lns");
    // Industry-optimisation factors — payload wins, else stored, else null.
    const cpuOptF = cpuOptimisationFactor !== undefined ? (Number(cpuOptimisationFactor) || null) : (envData.cpuOptimisationFactor || null);
    const ramOptF = ramOptimisationFactor !== undefined ? (Number(ramOptimisationFactor) || null) : (envData.ramOptimisationFactor || null);

    const vmPricingResult = await assessment.fetchAllVmPricing(region, pricing);
    const diskPricingResult = await assessment.fetchAllDiskPricing(region);

    // Re-run first-pass when sizing mode OR optimisation factors changed since
    // both shift reqCores/reqMemMB which can change the matched SKU. Pricing-
    // only changes (PAYG hours, AHUB toggle, security toggle, cost mode flip)
    // reuse the cached match for instant recalc.
    const oldSizingMode = envData.sizingMode || "auto";
    const oldCpuF = envData.cpuOptimisationFactor || null;
    const oldRamF = envData.ramOptimisationFactor || null;
    const sizingChanged = (newSizingMode !== oldSizingMode) || (cpuOptF !== oldCpuF) || (ramOptF !== oldRamF);
    let matchedForReport = envData.matchedServers;
    if (sizingChanged && envData.inputServers) {
      matchedForReport = assessment.runFirstPassMatching(
        envData.inputServers, session.lastVmSizes || [], envData.enabledSeries || [], arch, envData.storageTier, newSizingMode,
        { cpuOptimisationFactor: cpuOptF, ramOptimisationFactor: ramOptF }
      );
      envData.matchedServers = matchedForReport;
    }

    const report = assessment.generateAssessmentReport(matchedForReport, vmPricingResult.data, diskPricingResult.data, {
      assessmentName: `${assessmentName} - ${envName}`, region, pricingModel: pricing, useAhub: ahub,
      vmSizes: session.lastVmSizes || [], enabledSeries: envData.enabledSeries || [],
      cpuArchitecture: arch, securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
      sizingModeOverride: newSizingMode,
      paygHoursPerMonth: paygHours,
      costMode: newCostMode,
      cpuOptimisationFactor: cpuOptF,
      ramOptimisationFactor: ramOptF,
    });

    // Update stored data
    envData.report = report;
    envData.pricingModel = pricing;
    envData.useAhub = ahub;
    envData.securityEnabled = secEnabled;
    envData.sizingMode = newSizingMode;
    envData.paygHoursPerMonth = paygHours;
    envData.costMode = newCostMode;
    envData.cpuOptimisationFactor = cpuOptF;
    envData.ramOptimisationFactor = ramOptF;

    // Rebuild combined
    const combined = buildCombinedSummary(session.envAssessments, assessmentName, region);
    session.assessmentReport = combined;

    res.json({ envReport: report, combined });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper: build combined summary from all env assessments
function buildCombinedSummary(envAssessments, assessmentName, region) {
  let totalCompute = 0, totalStorage = 0, totalSecurity = 0;
  let totalServers = 0, totalSuitable = 0, totalNotSuitable = 0;
  // Deferred (DR strategy) and excluded buckets are tracked separately so the
  // UI can show "$X primary + $Y deferred to DR" instead of one opaque total.
  let deferredCompute = 0, deferredStorage = 0, deferredSecurity = 0, deferredServers = 0;
  let excludedServers = 0;
  const allServers = [];
  // Sizing summary aggregation across envs
  const combinedSizing = {
    modeRequested: null,
    totalServers: 0,
    asAllocated: 0,
    performanceBased: 0,
    performanceBasedPartial: 0,
    flooredCount: 0,
    cappedCount: 0,
    zeroFallbackCount: 0,
    missingFallbackCount: 0,
  };
  const modesSeen = new Set();

  for (const [envName, envData] of Object.entries(envAssessments)) {
    const s = envData.report.summary;
    const ds = envData.report.deferredSummary || { totalMonthlyCompute: 0, totalMonthlyStorage: 0, totalMonthlySecurity: 0, totalServers: 0 };
    const mode = envData.costMode || envData.report.costMode || "lns";

    // L&S totals only count rows whose env is in 'lns' mode. 'dr-defer' rows
    // had their cost diverted to deferredSummary by the report generator.
    totalCompute += s.totalMonthlyCompute;
    totalStorage += s.totalMonthlyStorage;
    totalSecurity += s.totalMonthlySecurity;
    deferredCompute += ds.totalMonthlyCompute;
    deferredStorage += ds.totalMonthlyStorage;
    deferredSecurity += ds.totalMonthlySecurity;
    deferredServers += ds.totalServers;

    if (mode === "exclude") {
      excludedServers += s.totalServers;
    } else {
      totalServers += s.totalServers;
      totalSuitable += s.suitable;
      totalNotSuitable += s.notSuitable;
    }
    // Add environment tag to each server for combined view
    for (const srv of envData.report.servers) {
      allServers.push({ ...srv, environment: envName });
    }
    const ss = envData.report.sizingSummary;
    if (ss && mode !== "exclude") {
      modesSeen.add(ss.modeRequested);
      combinedSizing.totalServers += ss.totalServers || 0;
      combinedSizing.asAllocated += ss.asAllocated || 0;
      combinedSizing.performanceBased += ss.performanceBased || 0;
      combinedSizing.performanceBasedPartial += ss.performanceBasedPartial || 0;
      combinedSizing.flooredCount += ss.flooredCount || 0;
      combinedSizing.cappedCount += ss.cappedCount || 0;
      combinedSizing.zeroFallbackCount += ss.zeroFallbackCount || 0;
      combinedSizing.missingFallbackCount += ss.missingFallbackCount || 0;
    }
  }
  combinedSizing.modeRequested = modesSeen.size === 1 ? [...modesSeen][0] : "mixed";

  const totalMonthlyCost = totalCompute + totalStorage + totalSecurity;
  const deferredMonthlyCost = deferredCompute + deferredStorage + deferredSecurity;
  // Application pairing: groups servers by their Business Application across envs
  // so Step 5 can reconcile DR coverage (e.g. "AMLA: 9 prod, 5 uat, 9 dr").
  const applicationPairing = buildApplicationPairing(allServers);

  // Inventory vs Azure optimisation footprint, aggregated across all envs.
  // Counts L&S-only by default (the customer-facing comparison should reflect
  // what they're actually paying for). Deferred / excluded server counts are
  // surfaced separately in deferredSummary / excludedSummary above.
  let invCores = 0, invRamMB = 0, recCores = 0, recRamMB = 0, srcDiskGB = 0;
  for (const s of allServers) {
    if (s.costExcluded) continue;
    if (s.costDeferredToDr) continue;
    invCores += s.cores || 0;
    invRamMB += s.memoryMB || 0;
    recCores += s.vmCores || 0;
    recRamMB += s.vmMemoryMB || 0;
    for (const d of (s.diskDetails || [])) srcDiskGB += d.sourceSizeGB || 0;
  }
  const optimisationSummary = {
    inventoryCores: invCores,
    inventoryRamMB: invRamMB,
    recommendedCores: recCores,
    recommendedRamMB: recRamMB,
    sourceDiskGB: Math.round(srcDiskGB),
    coresSavedPct: invCores > 0 ? Math.round((1 - recCores / invCores) * 1000) / 10 : 0,
    ramSavedPct: invRamMB > 0 ? Math.round((1 - recRamMB / invRamMB) * 1000) / 10 : 0,
  };

  // Reconciliation: compare what was in the raw inventory vs what made it
  // through to each cost bucket. Inventory rows that vanish silently are the
  // most insidious source of "the BOM is missing servers" complaints — usually
  // duplicate hostnames or blank env values that fell into 'Unknown' env. We
  // expose the numbers so the UI can surface them.
  const sizedCount = totalServers + deferredServers + excludedServers;
  const inventoryCount = (Object.values(envAssessments).reduce((sum, e) => sum + (e.inputServers?.length || 0), 0)) || sizedCount;
  const reconciliation = {
    inventoryCount,
    sizedCount,
    lnsCount: totalServers,
    deferredCount: deferredServers,
    excludedCount: excludedServers,
    unaccountedCount: Math.max(0, inventoryCount - sizedCount),
  };

  return {
    assessmentName,
    region,
    timestamp: new Date().toISOString(),
    pricingModel: "Multi-Environment",
    sizingSummary: combinedSizing,
    summary: {
      totalServers,
      suitable: totalSuitable,
      notSuitable: totalNotSuitable,
      totalMonthlyCompute: round2(totalCompute),
      totalMonthlyStorage: round2(totalStorage),
      totalMonthlySecurity: round2(totalSecurity),
      totalMonthlyCost: round2(totalMonthlyCost),
      totalAnnualCost: round2(totalMonthlyCost * 12),
      inventoryCores: invCores,
      inventoryRamMB: invRamMB,
      recommendedCores: recCores,
      recommendedRamMB: recRamMB,
      sourceDiskGB: Math.round(srcDiskGB),
    },
    optimisationSummary,
    reconciliation,
    deferredSummary: {
      totalServers: deferredServers,
      totalMonthlyCompute: round2(deferredCompute),
      totalMonthlyStorage: round2(deferredStorage),
      totalMonthlyCost: round2(deferredMonthlyCost),
      totalMonthlySecurity: round2(deferredSecurity),
    },
    excludedSummary: { totalServers: excludedServers },
    applicationPairing,
    sqlReplicaCandidates: detectSqlReplicas(allServers),
    servers: allServers,
  };
}

// Pick the inventory column that best identifies a "business application" so
// DR rows can be paired with their prod/UAT counterparts. Falls back through a
// list of common names; returns null if none exist on the rows.
function pickApplicationColumn(servers) {
  const candidates = [
    "Business Application", "BusinessApplication", "Application Name", "ApplicationName",
    "Application", "App Name", "AppName", "App", "Service Name", "ServiceName",
  ];
  const allCols = new Set();
  for (const s of servers) {
    if (s.extraColumns) for (const k of Object.keys(s.extraColumns)) allCols.add(k);
  }
  // Case-insensitive match against candidates
  for (const c of candidates) {
    const hit = [...allCols].find(k => k.toLowerCase() === c.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

// Group servers by Business Application × Environment to surface DR coverage.
// Returns { column, apps: [ {name, total, pairingStatus, byEnv: {prod, uat, dr, ...}, servers: [...] } ] }
//
// pairingStatus per app:
//   "paired"       — has a Production twin (or Production+UAT). Standard case.
//   "uat-only"     — DR servers paired with UAT but no Prod twin (soft edge case)
//   "orphan-dr"    — DR servers exist but no Prod/UAT/SIT/Dev/Test twin at all
//   "no-dr"        — no DR servers, app is irrelevant to DR strategy
function buildApplicationPairing(servers) {
  const appCol = pickApplicationColumn(servers);
  if (!appCol) return { column: null, apps: [], unpairedDr: [] };

  const byApp = new Map();
  for (const srv of servers) {
    const app = (srv.extraColumns && srv.extraColumns[appCol]) || "(unknown)";
    const env = srv.environment || "Unknown";
    if (!byApp.has(app)) byApp.set(app, { name: app, total: 0, byEnv: {}, servers: [] });
    const rec = byApp.get(app);
    rec.total++;
    rec.byEnv[env] = (rec.byEnv[env] || 0) + 1;
    rec.servers.push({ name: srv.serverName, env, deferred: !!srv.costDeferredToDr, excluded: !!srv.costExcluded });
  }

  // Classify each app's DR pairing status. The regex set below is intentionally
  // conservative — anything that LOOKS like a primary env (prod/uat/sit/dev/test/stage)
  // counts as a twin. Anything not matching is treated as "other" (not a primary).
  const drEnvRegex = /^(dr|d\.?r|disaster.?recovery|dr.?site)$/i;
  const prodRegex = /^(prod(uction)?)$/i;
  const primaryEnvRegex = /^(prod(uction)?|uat|sit|stag(ing)?|dev(elopment)?|test|qa|preprod)$/i;
  const unpairedDr = [];
  for (const rec of byApp.values()) {
    const envs = Object.keys(rec.byEnv);
    const drEnvs = envs.filter(e => drEnvRegex.test(e));
    if (drEnvs.length === 0) {
      rec.pairingStatus = "no-dr";
      rec.drCount = 0;
      continue;
    }
    rec.drCount = drEnvs.reduce((a, e) => a + rec.byEnv[e], 0);
    const hasProd = envs.some(e => prodRegex.test(e));
    const hasAnyPrimary = envs.some(e => primaryEnvRegex.test(e));
    if (!hasAnyPrimary) {
      rec.pairingStatus = "orphan-dr";
      unpairedDr.push({ app: rec.name, drCount: rec.drCount });
    } else if (!hasProd) {
      rec.pairingStatus = "uat-only";
    } else {
      rec.pairingStatus = "paired";
    }
  }

  const apps = [...byApp.values()].sort((a, b) => b.total - a.total);
  return { column: appCol, apps, unpairedDr };
}

// Apply user decisions about how to treat orphan / UAT-only DR-app servers in
// pre-sales pricing. Decisions are keyed by application name. Each decision is
// one of:
//   { action: "lns" }                          → keep DR servers in L&S total (DEFAULT for orphan/uat-only — conservative pricing)
//   { action: "dr-strategy", strategy: "..." } → apply a chosen DR strategy directly to those rows
//   { action: "exclude" }                      → exclude from the migration BOM entirely (set costExcluded)
//   { action: "map", mapToApp: "..." }         → treat as if the rows belonged to another app (pairing reconciles)
//
// We mutate per-server flags inside session.envAssessments[*].report.servers,
// then re-sum each env's summary + deferredSummary, then rebuild the combined
// session.assessmentReport. No re-matching is needed — we only re-route cost.
function applyOrphanDecisionsToSession(session) {
  if (!session || !session.envAssessments) return;
  const decisions = session.orphanDecisions || {};
  // Need an application column to resolve a server's app. Re-derive from a
  // sample to avoid relying on a previously-stored value.
  const sampleServers = [];
  for (const env of Object.values(session.envAssessments)) {
    for (const s of (env.report?.servers || [])) sampleServers.push(s);
  }
  const appCol = pickApplicationColumn(sampleServers);
  if (!appCol) return; // no app column, nothing to apply

  // Phase 1: compute the desired flag state per server based on app decision.
  // We track per-server overrides so a 'map' decision (move app A → app B) doesn't
  // require a DOM-side edit to extraColumns.
  for (const envData of Object.values(session.envAssessments)) {
    const isDeferEnv = envData.costMode === "dr-defer";
    for (const srv of (envData.report?.servers || [])) {
      const app = (srv.extraColumns && srv.extraColumns[appCol]) || "(unknown)";
      const decision = decisions[app];
      // Reset overrides — they're recomputed from scratch each call so the
      // decision map is always the source of truth.
      delete srv._orphanOverride;
      // No decision: server keeps the env-level default (lns or dr-defer).
      if (!decision || !decision.action) {
        srv.costDeferredToDr = isDeferEnv;
        srv.costExcluded = envData.costMode === "exclude";
        continue;
      }
      switch (decision.action) {
        case "lns":
          // Force back into L&S regardless of env mode. Compute counts in env L&S total.
          srv.costDeferredToDr = false;
          srv.costExcluded = false;
          srv._orphanOverride = "lns";
          break;
        case "dr-strategy":
          // Force into DR-deferred bucket so the strategy calculator picks them up.
          srv.costDeferredToDr = true;
          srv.costExcluded = false;
          srv._orphanOverride = "dr-strategy";
          srv._orphanStrategy = decision.strategy || "std-asr";
          break;
        case "exclude":
          srv.costDeferredToDr = false;
          srv.costExcluded = true;
          srv._orphanOverride = "exclude";
          break;
        case "map":
          // Mapping just changes the app's pairing label; cost still flows by env mode.
          srv.costDeferredToDr = isDeferEnv;
          srv.costExcluded = envData.costMode === "exclude";
          srv._orphanOverride = "map";
          srv._mappedTo = decision.mapToApp;
          break;
        default:
          srv.costDeferredToDr = isDeferEnv;
          srv.costExcluded = envData.costMode === "exclude";
      }
    }
    // Phase 2: re-sum each env's summary + deferredSummary from the (now
    // possibly-overridden) per-server flags. This is cheap arithmetic.
    const r = envData.report;
    if (!r || !r.summary) continue;
    let lnsCompute = 0, lnsStorage = 0, lnsSecurity = 0, lnsCount = 0;
    let defCompute = 0, defStorage = 0, defSecurity = 0, defCount = 0;
    for (const srv of r.servers) {
      if (srv.costExcluded) continue;
      if (srv.costDeferredToDr) {
        defCompute += srv.computeMonthlyCost || 0;
        defStorage += srv.storageMonthlyCost || 0;
        defSecurity += srv.securityMonthlyCost || 0;
        defCount++;
      } else {
        lnsCompute += srv.computeMonthlyCost || 0;
        lnsStorage += srv.storageMonthlyCost || 0;
        lnsSecurity += srv.securityMonthlyCost || 0;
        lnsCount++;
      }
    }
    r.summary.totalMonthlyCompute = round2(lnsCompute);
    r.summary.totalMonthlyStorage = round2(lnsStorage);
    r.summary.totalMonthlySecurity = round2(lnsSecurity);
    r.summary.totalMonthlyCost = round2(lnsCompute + lnsStorage + lnsSecurity);
    r.summary.totalAnnualCompute = round2(lnsCompute * 12);
    r.summary.totalAnnualStorage = round2(lnsStorage * 12);
    r.summary.totalAnnualSecurity = round2(lnsSecurity * 12);
    r.summary.totalAnnualCost = round2(r.summary.totalMonthlyCost * 12);
    r.deferredSummary = r.deferredSummary || {};
    r.deferredSummary.totalMonthlyCompute = round2(defCompute);
    r.deferredSummary.totalMonthlyStorage = round2(defStorage);
    r.deferredSummary.totalMonthlySecurity = round2(defSecurity);
    r.deferredSummary.totalMonthlyCost = round2(defCompute + defStorage + defSecurity);
    r.deferredSummary.totalServers = defCount;
  }
}

// Heuristic: is this server a SQL Server VM? Inventories rarely have an explicit
// "workload type" column, so we look at the server name and OS string. Good
// enough for the common DBA naming conventions ('sqlprod01', 'drcsqlsec01' etc.)
// and OS strings like "Windows 2019 Datacenter (SQL)".
function isSqlServer(srv) {
  const name = (srv.serverName || "").toLowerCase();
  const os = (srv.osName || "").toLowerCase();
  return /sql/.test(name) || /sql/.test(os);
}

// Detect SQL-replica candidates. Returns one entry per Business Application
// where the inventory shows BOTH a Prod-side SQL VM AND a DR-side SQL VM —
// the classic pattern for SQL Always-On AG / Database Mirroring. The DR-side
// SQL nodes typically run 24×7 (apply log streams, optionally serve read-only
// queries), so they should NOT be priced as cold ASR. The user picks per-app.
//
// Returns: [{ app, sqlProdCount, sqlDrCount, sqlProdServers: [], sqlDrServers: [] }]
function detectSqlReplicas(servers) {
  const appCol = pickApplicationColumn(servers);
  if (!appCol) return [];
  const drEnvRegex = /^(dr|d\.?r|disaster.?recovery|dr.?site)$/i;
  const prodRegex = /^(prod(uction)?)$/i;
  const byApp = new Map();
  for (const s of servers) {
    if (s.costExcluded) continue;
    if (!isSqlServer(s)) continue;
    const app = (s.extraColumns && s.extraColumns[appCol]) || "(unknown)";
    if (!byApp.has(app)) byApp.set(app, { app, sqlProdServers: [], sqlDrServers: [] });
    const rec = byApp.get(app);
    const env = s.environment || "";
    if (prodRegex.test(env)) rec.sqlProdServers.push(s.serverName);
    else if (drEnvRegex.test(env)) rec.sqlDrServers.push(s.serverName);
  }
  const flagged = [];
  for (const rec of byApp.values()) {
    if (rec.sqlProdServers.length >= 1 && rec.sqlDrServers.length >= 1) {
      flagged.push({
        app: rec.app,
        sqlProdCount: rec.sqlProdServers.length,
        sqlDrCount: rec.sqlDrServers.length,
        sqlProdServers: rec.sqlProdServers,
        sqlDrServers: rec.sqlDrServers,
      });
    }
  }
  // Sort by DR SQL count (largest first) so high-impact apps surface at the top.
  flagged.sort((a, b) => b.sqlDrCount - a.sqlDrCount);
  return flagged;
}

// Apply per-app SQL replica decisions. Each decision routes the SQL servers in
// the DR env (only those — not the entire app's DR servers) to a specific bucket
// in the DR Strategy calculator. Three actions:
//   { action: "ag" }    → Always-On AG / Mirroring → routed to active-active bucket
//                          (DR-side SQL VMs are 24×7 active replicas, no ASR licence)
//   { action: "asr" }   → Standalone with ASR → routed to std-asr bucket
//   { action: "tier" }  → no override → falls through to tier-driven strategy
//
// Sets srv._sqlOverride on the matched DR-env SQL servers only. Other DR
// servers in the same app keep their tier-strategy routing untouched, which
// is exactly what the user asked for: SQL flips to AG, the rest stays under
// (e.g.) Standard ASR with no double-counting.
function applySqlDecisionsToSession(session) {
  if (!session || !session.envAssessments) return;
  const decisions = session.sqlDecisions || {};
  const sampleServers = [];
  for (const env of Object.values(session.envAssessments)) {
    for (const s of (env.report?.servers || [])) sampleServers.push(s);
  }
  const appCol = pickApplicationColumn(sampleServers);
  if (!appCol) return;
  const drEnvRegex = /^(dr|d\.?r|disaster.?recovery|dr.?site)$/i;

  for (const envData of Object.values(session.envAssessments)) {
    for (const srv of (envData.report?.servers || [])) {
      delete srv._sqlOverride;
      if (srv.costExcluded) continue;
      if (!isSqlServer(srv)) continue;
      const env = srv.environment || envData.envName || "";
      if (!drEnvRegex.test(env)) continue;
      const app = (srv.extraColumns && srv.extraColumns[appCol]) || "(unknown)";
      const dec = decisions[app];
      if (!dec || !dec.action || dec.action === "tier") continue;
      if (dec.action === "ag" || dec.action === "asr") srv._sqlOverride = dec.action;
    }
  }
}

// Sum BYOL-relevant cores (Windows / SQL / Linux) for one environment in a
// session. Used by the BOM XLSX export to pre-fill commercial licensing tables.
// AHUB-off explicitly returns 0 Win cores because Azure bundles the licence.
//
// Reads from the env's own stored report when available; falls back to the
// combined report filtered by environment label so a stale envAssessments
// (e.g. mismatched env name after session reload) still produces correct
// numbers as long as the combined report has servers tagged with that env.
function computeLicenseCoresFromSession(session, envName, config) {
  const out = { winCores: 0, sqlCores: 0, linuxCores: 0 };
  if (!session) return out;
  // Primary path: per-env stored report.
  let servers = session.envAssessments?.[envName]?.report?.servers || [];
  // Fallback path: filter the combined report by environment field.
  if (servers.length === 0 && session.assessmentReport?.servers) {
    servers = session.assessmentReport.servers.filter(s => (s.environment || "") === envName);
  }
  // BYOL question is "what licences must be procured for the L&S Azure spend?"
  // — so deferred-to-DR rows are excluded (they're priced via DR Strategy and
  // their licence cost is part of that conversation, not L&S BYOL). Excluded
  // rows are obviously out. The Windows regex matches both long ("Windows
  // Server 2019 Datacenter") and short forms ("Win2008R2", "Win2012R2",
  // "Win2016 10.0.14393…") found in real inventories. Linux family detector
  // covers the common distros so the "Other OS Cores" column is honest.
  const winRe = /windows|win2008|win2003|win2012|win2016|win2019|win2022/i;
  const linuxRe = /linux|red\s*hat|rhel|centos|ubuntu|debian|suse|oracle\s*linux|amazon\s*linux/i;
  for (const srv of servers) {
    if (srv.costExcluded) continue;
    if (srv.costDeferredToDr) continue;
    const osName = srv.osName || "";
    const isWindows = srv.isWindows || winRe.test(osName);
    const isLinux = linuxRe.test(osName);
    const cores = srv.vmCores || 0;
    if (isWindows) out.winCores += cores;
    else if (isLinux) out.linuxCores += cores;
    else out.linuxCores += cores; // bucket "Other" with Linux to keep column meaningful for non-Windows OSes
    const nameLC = (srv.serverName || "").toLowerCase();
    const osLC = osName.toLowerCase();
    if (nameLC.includes("sql") || osLC.includes("sql")) out.sqlCores += cores;
  }
  if (config && config.useAhub === false) out.winCores = 0;
  return out;
}

// Conservative support-status classifier. We err toward "Unknown" rather than
// claim something is supported when it isn't. Output values:
//   "Out of support"        — clear EOL (Win 2003/2008/2008 R2/2012, RHEL ≤6, CentOS 6/7/8 etc.)
//   "Extended support"      — past mainstream end but still in extended phase as of mid-2026
//   "Supported"             — current vendor-supported version
//   "Unknown"               — anything we can't classify
// IMPORTANT: keep this purely string-pattern based; dates aren't normalized in
// inventories so we can only match obvious cues like "2008", "Win2008R2",
// "Red Hat ... 6.x", etc.
function classifyOsSupport(osName, osVersion) {
  const s = `${osName || ""} ${osVersion || ""}`.toLowerCase();
  if (!s.trim()) return "Unknown";
  // === Windows Server family ===
  if (/win(dows)?\s*(server\s*)?2003/.test(s) || /\b5\.2\.\d+\b/.test(s)) return "Out of support";
  if (/win(dows)?\s*(server\s*)?(nt|2000)/.test(s)) return "Out of support";
  if (/win(dows)?\s*(server\s*)?2008(\s*r2)?/.test(s) || /win2008r2/.test(s) || /\b6\.0\.\d+\b/.test(s) || /\b6\.1\.\d+\b/.test(s)) return "Out of support";
  if (/win(dows)?\s*(server\s*)?2012(\s*r2)?/.test(s) || /\b6\.2\.\d+\b/.test(s) || /\b6\.3\.\d+\b/.test(s)) return "Extended support"; // 2012 ESU active until Oct 2026
  if (/win(dows)?\s*(server\s*)?2016/.test(s) || /\b10\.0\.14393\b/.test(s)) return "Extended support"; // mainstream ended 2022
  if (/win(dows)?\s*(server\s*)?2019/.test(s) || /\b10\.0\.17763\b/.test(s)) return "Extended support"; // mainstream ended Jan 2024
  if (/win(dows)?\s*(server\s*)?2022/.test(s) || /\b10\.0\.20348\b/.test(s)) return "Supported";
  if (/win(dows)?\s*(server\s*)?2025/.test(s) || /\b10\.0\.26100\b/.test(s)) return "Supported";
  // === Windows desktop (rare in server inventory but flag if seen) ===
  if (/windows\s*(xp|vista|7|8|8\.1)\b/.test(s)) return "Out of support";
  if (/windows\s*(10|11)\b/.test(s)) return "Supported";
  // === Red Hat Enterprise Linux ===
  // Match standalone RHEL major versions to avoid false hits.
  if (/red\s*hat|rhel/.test(s)) {
    const m = s.match(/\b(\d+)(?:\.\d+)?\b/);
    if (m) {
      const major = parseInt(m[1], 10);
      if (major <= 6) return "Out of support";
      if (major === 7) return "Extended support"; // EOL June 2024, ELS through 2028
      if (major === 8) return "Supported";
      if (major === 9 || major === 10) return "Supported";
    }
    return "Unknown";
  }
  // === CentOS ===
  if (/centos/.test(s)) {
    const m = s.match(/\b(\d+)(?:\.\d+)?\b/);
    if (m) {
      const major = parseInt(m[1], 10);
      if (major <= 7) return "Out of support";
      if (major === 8) return "Out of support"; // CentOS 8 EOL Dec 2021
      if (major === 9) return "Supported";       // CentOS Stream 9
    }
    return "Out of support";
  }
  // === Oracle Linux ===
  if (/oracle.*(linux|enterprise)/.test(s)) {
    const m = s.match(/\b(\d+)(?:\.\d+)?\b/);
    if (m) {
      const major = parseInt(m[1], 10);
      if (major <= 6) return "Out of support";
      if (major === 7) return "Extended support";
      if (major >= 8) return "Supported";
    }
    return "Unknown";
  }
  // === Ubuntu ===
  if (/ubuntu/.test(s)) {
    const m = s.match(/\b(\d{2})\.(\d{2})\b/);
    if (m) {
      const yr = parseInt(m[1], 10);
      if (yr <= 18) return "Out of support";
      if (yr === 20) return "Extended support";
      if (yr === 22 || yr === 24) return "Supported";
    }
    return "Unknown";
  }
  // === SUSE ===
  if (/suse|sles/.test(s)) {
    const m = s.match(/\b(\d+)\b/);
    if (m) {
      const major = parseInt(m[1], 10);
      if (major <= 11) return "Out of support";
      if (major === 12) return "Extended support";
      if (major >= 15) return "Supported";
    }
    return "Unknown";
  }
  // === Debian / SUSE / generic linux fallback ===
  if (/debian/.test(s)) return "Unknown";
  if (/linux/.test(s)) return "Unknown";
  return "Unknown";
}

// Build an OS-license summary across all servers in a report. One row per
// distinct (OS Name, OS Version) pair so commercial teams can see exactly
// which licences need procuring (or upgrading). Includes per-env counts so
// the customer can split procurement across environments if they want.
//
// Returns: [{ osName, osVersion, totalServers, totalCores, kind, supportStatus, byEnv: { Prod: 9, ... } }]
function aggregateOsLicenses(servers) {
  const envSet = new Set();
  for (const s of servers) if (s.environment) envSet.add(s.environment);
  const envs = [...envSet];

  const byKey = new Map();
  for (const srv of servers) {
    if (srv.costExcluded) continue;
    const osName = (srv.osName || "(unknown)").trim() || "(unknown)";
    const osVersion = (srv.osVersion || "").toString().trim();
    const key = `${osName}||${osVersion}`;
    if (!byKey.has(key)) {
      const isWindows = srv.isWindows || /windows|win2008|win2003/i.test(osName);
      const looksSql = /sql/i.test(osName) || /sql/i.test(srv.serverName || "");
      const supportStatus = classifyOsSupport(osName, osVersion);
      const guidance = recommendTreatment(osName, osVersion, supportStatus);
      byKey.set(key, {
        osName,
        osVersion,
        totalServers: 0,
        totalCores: 0,
        kind: isWindows ? "Windows" : (looksSql ? "SQL" : "Linux/Other"),
        supportStatus,
        lnsCompatible: guidance.lnsCompatible,
        osPathOptions: guidance.osPathOptions,
        customerAction: guidance.customerAction,
        byEnv: {},
      });
    }
    const rec = byKey.get(key);
    rec.totalServers++;
    rec.totalCores += (srv.vmCores || 0);
    const env = srv.environment || "Unknown";
    rec.byEnv[env] = (rec.byEnv[env] || 0) + 1;
  }
  const rows = [...byKey.values()].sort((a, b) => b.totalServers - a.totalServers);
  return { envs, rows };
}

// Map (OS, version, support status) → decision-support guidance for the BOM.
// Every OS that boots on x86 CAN lift-and-shift to Azure — the question is
// what OS path the customer chooses. Returns three fields the export uses:
//   lnsCompatible    — short technical truth (Compatible / Compatible*)
//   osPathOptions    — pipe-separated list of viable paths
//   customerAction   — single-sentence summary of the decision the customer faces
// No prescriptive "Refactor/Retire" verdicts — leaving that conversation to
// consultants, not the tool.
function recommendTreatment(osName, osVersion, supportStatus) {
  const s = `${osName || ""} ${osVersion || ""}`.toLowerCase();
  const COMPATIBLE = "Compatible";
  const COMPATIBLE_LIMITED = "Compatible (older OS — Azure platform support limited)";

  // === Windows server family ===
  if (/win(dows)?\s*(server\s*)?(nt|2000|2003)/.test(s) || /\b5\.2\.\d+\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE_LIMITED,
      osPathOptions: "Keep as-is (no vendor patches) | Upgrade to Win 2019/2022 during migration",
      customerAction: "OS is fully out of support and beyond Azure ESU. Customer chooses between keeping as-is (no patches) or upgrading the OS as part of the move. Azure compute cost is identical either way.",
    };
  }
  if (/win(dows)?\s*(server\s*)?2008(\s*r2)?/.test(s) || /win2008r2/.test(s) || /\b6\.1\.\d+\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is | Keep + free Azure ESU | Upgrade to Win 2022 during migration",
      customerAction: "Out of mainstream support. Migrating to Azure unlocks 3 years of FREE Extended Security Updates (saves ~$1.5k/server/yr vs on-prem ESU). Customer chooses: keep + ESU, or upgrade now.",
    };
  }
  if (/win(dows)?\s*(server\s*)?2012(\s*r2)?/.test(s) || /\b6\.2\.\d+\b/.test(s) || /\b6\.3\.\d+\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is | Keep + free Azure ESU (until Oct 2026) | Upgrade to Win 2022 during migration",
      customerAction: "Win 2012 / 2012 R2 ESU runs to Oct 2026 (free on Azure). Customer can take free ESU now and schedule an upgrade within 18-24 months, or upgrade as part of the migration.",
    };
  }
  if (/win(dows)?\s*(server\s*)?2016/.test(s) || /\b10\.0\.14393\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is (extended support until Jan 2027) | Upgrade to Win 2022 during migration",
      customerAction: "In extended support until Jan 2027. Customer can rehost as-is and plan an upgrade within ~12 months, or upgrade in the migration window.",
    };
  }
  if (/win(dows)?\s*(server\s*)?2019/.test(s) || /\b10\.0\.17763\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is (extended support until Jan 2029) | Optional: upgrade to Win 2022/2025",
      customerAction: "In extended support until Jan 2029. Rehost as-is is the standard path; optional upgrade if the customer wants longer runway.",
    };
  }
  if (/win(dows)?\s*(server\s*)?(2022|2025)/.test(s) || /\b10\.0\.20348\b/.test(s) || /\b10\.0\.26100\b/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Current supported OS. Standard rehost. AHUB applies if customer has Software Assurance — otherwise Azure includes the Windows licence.",
    };
  }
  if (/windows/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is | Optional upgrade",
      customerAction: "Verify Windows Server edition for AHUB eligibility and support phase before deciding.",
    };
  }

  // === Red Hat family ===
  if (/red\s*hat|rhel/.test(s)) {
    const m = s.match(/\b(\d+)(?:\.\d+)?\b/);
    const major = m ? parseInt(m[1], 10) : null;
    if (major !== null && major <= 6) {
      return {
        lnsCompatible: COMPATIBLE_LIMITED,
        osPathOptions: "Keep as-is (no vendor patches) | Upgrade to RHEL 8/9 during migration",
        customerAction: "RHEL 6 reached EOL Nov 2020 (incl. ELS). Customer chooses between keeping as-is without patches or upgrading the OS as part of the move.",
      };
    }
    if (major === 7) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is + Red Hat ELS subscription (until 2028) | Upgrade to RHEL 8/9 during migration",
        customerAction: "RHEL 7 EOL Jun 2024. Customer needs Red Hat ELS subscription to keep patches, or upgrades to RHEL 8/9. BYOS or Azure-billed RHEL both work.",
      };
    }
    if (major === 8 || major === 9 || major === 10) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is",
        customerAction: "Current RHEL. Customer chooses BYOS (transfer existing Red Hat subscription) or Azure-billed RHEL (Red Hat support included).",
      };
    }
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Verify RHEL version, support phase and subscription model (BYOS vs Azure-billed).",
    };
  }

  // === CentOS — distribution is discontinued ===
  if (/centos/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE_LIMITED,
      osPathOptions: "Keep as-is (no upstream updates) | Convert to AlmaLinux/Rocky Linux | Upgrade to RHEL 8/9 during migration",
      customerAction: "CentOS Linux is discontinued (CentOS 8 EOL Dec 2021, CentOS 7 EOL Jun 2024). Customer chooses between keeping as-is, free in-place conversion to AlmaLinux/Rocky, or upgrading to RHEL.",
    };
  }

  // === Oracle Linux ===
  if (/oracle.*(linux|enterprise)/.test(s)) {
    const m = s.match(/\b(\d+)(?:\.\d+)?\b/);
    const major = m ? parseInt(m[1], 10) : null;
    if (major !== null && major <= 6) {
      return {
        lnsCompatible: COMPATIBLE_LIMITED,
        osPathOptions: "Keep as-is (no vendor patches) | Upgrade to Oracle Linux 8/9 during migration",
        customerAction: "Oracle Linux 6 EOL Mar 2021. Customer chooses keep as-is or upgrade as part of the move. BYOS via Oracle support contract for both options.",
      };
    }
    if (major === 7) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is + Oracle support | Upgrade to Oracle Linux 8/9 during migration",
        customerAction: "Oracle Linux 7 EOL Aug 2024. Customer keeps via Oracle ELS subscription, or upgrades to OL 8/9. BYOS in both cases.",
      };
    }
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Current Oracle Linux. BYOS via Oracle support contract.",
    };
  }

  // === Ubuntu ===
  if (/ubuntu/.test(s)) {
    const m = s.match(/\b(\d{2})\.(\d{2})\b/);
    const yr = m ? parseInt(m[1], 10) : null;
    if (yr !== null && yr <= 18) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is + Ubuntu Pro (Azure) | Upgrade to Ubuntu 22.04/24.04 LTS during migration",
        customerAction: "Ubuntu ≤18.04 is past standard support. Azure offers Ubuntu Pro for paid extended security to 2030. Customer can take Ubuntu Pro to keep as-is, or upgrade during the move.",
      };
    }
    if (yr === 20) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is | Keep + Ubuntu Pro on Azure (extends to 2030) | Upgrade to 22.04/24.04 LTS",
        customerAction: "Ubuntu 20.04 LTS standard support ends Apr 2025. Customer can plan a normal upgrade, or take Ubuntu Pro on Azure for runway to 2030.",
      };
    }
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Current Ubuntu LTS. Optional Ubuntu Pro on Azure for added security/compliance features.",
    };
  }

  // === SUSE ===
  if (/suse|sles/.test(s)) {
    const m = s.match(/\b(\d+)\b/);
    const major = m ? parseInt(m[1], 10) : null;
    if (major !== null && major <= 11) {
      return {
        lnsCompatible: COMPATIBLE_LIMITED,
        osPathOptions: "Keep as-is (no vendor patches) | Upgrade to SLES 15 during migration",
        customerAction: "SLES ≤11 long out of support. Customer chooses keep as-is or upgrade to SLES 15.",
      };
    }
    if (major === 12) {
      return {
        lnsCompatible: COMPATIBLE,
        osPathOptions: "Keep as-is + SUSE LTSS | Upgrade to SLES 15 during migration",
        customerAction: "SLES 12 in long-term phase. Keep with SUSE LTSS subscription, or upgrade to SLES 15. BYOS or Azure-billed.",
      };
    }
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Current SUSE. BYOS or Azure-billed SLES.",
    };
  }

  // === Generic ===
  if (/linux/.test(s)) {
    return {
      lnsCompatible: COMPATIBLE,
      osPathOptions: "Keep as-is",
      customerAction: "Linux distribution not auto-classified. Verify support phase and BYOS vs Azure-billed model with customer.",
    };
  }
  return {
    lnsCompatible: supportStatus === "Out of support" ? COMPATIBLE_LIMITED : COMPATIBLE,
    osPathOptions: "Keep as-is | Optional upgrade",
    customerAction: "OS string not recognised. Verify support state and licence model with customer before committing to a path.",
  };
}


// ============ LANDING ZONE & BCDR PRICING ENDPOINTS ============

// Generate a customised Azure Landing Zone diagram as a draw.io (.drawio) file.
// Customer-specific labels: customer name in MGs/title, primary + DR regions,
// workload landing zone spokes derived from environments seen in the inventory.
app.post("/api/architecture/landing-zone", (req, res) => {
  const { customerName, primaryRegion, drRegion, workloadGroups } = req.body || {};
  if (!customerName) return res.status(400).json({ error: "customerName is required" });
  try {
    const xml = buildLandingZoneDiagram({
      customerName,
      primaryRegion: primaryRegion || "",
      drRegion: drRegion || "",
      workloadGroups: Array.isArray(workloadGroups) ? workloadGroups : [],
    });
    const safeName = String(customerName).replace(/[^a-zA-Z0-9_-]/g, "_");
    res.setHeader("Content-Type", "application/vnd.jgraph.mxfile");
    res.setHeader("Content-Disposition", `attachment; filename="ALZ_${safeName}.drawio"`);
    res.send(xml);
  } catch (err) {
    console.error(`[ALZ Diagram] generation failed: ${err.stack || err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Fetch egress (bandwidth) pricing for a region
app.get("/api/pricing/egress", async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });
  try {
    const filter = `serviceName eq 'Bandwidth' and armRegionName eq '${region}' and priceType eq 'Consumption' and contains(meterName, 'Data Transfer Out')`;
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=100`;
    const data = await fetchWithTimeout(url);
    // Extract tiered pricing
    const tiers = [
      { rangeStart: 0, rangeEnd: 5, ratePerGB: 0 }, // first 5 GB free
    ];
    // Find inter-region/internet egress rates
    const items = (data.Items || []).filter(i => !i.meterName.includes("Intra") && !i.meterName.includes("Zone"));
    // Typically one rate for standard egress — ensure unitPrice > 0
    const standardRate = items.find(i => (i.skuName === "Standard" || i.meterName.includes("Inter-Region")) && i.unitPrice > 0)
      || items.find(i => i.unitPrice > 0)
      || null;
    const ratePerGB = (standardRate && standardRate.unitPrice > 0) ? standardRate.unitPrice : 0.087; // fallback if API returns 0
    console.log(`[Egress] Region: ${region}, Items: ${items.length}, Rate: $${ratePerGB}/GB${!standardRate || standardRate.unitPrice === 0 ? " (FALLBACK - API returned 0)" : ""}`);
    tiers.push({ rangeStart: 5, rangeEnd: 10240, ratePerGB });
    tiers.push({ rangeStart: 10240, rangeEnd: 51200, ratePerGB: round2(ratePerGB * 0.95) });
    tiers.push({ rangeStart: 51200, rangeEnd: 153600, ratePerGB: round2(ratePerGB * 0.80) });
    tiers.push({ rangeStart: 153600, rangeEnd: null, ratePerGB: round2(ratePerGB * 0.57) });

    res.json({ region, ratePerGB, tiers, benchmark: { conservative: 5, medium: 15, high: 50 } });
  } catch (err) {
    console.error("[Egress Pricing] Error:", err.message);
    // Fallback defaults
    res.json({ region, ratePerGB: 0.087, tiers: [
      { rangeStart: 0, rangeEnd: 5, ratePerGB: 0 },
      { rangeStart: 5, rangeEnd: 10240, ratePerGB: 0.087 },
      { rangeStart: 10240, rangeEnd: 51200, ratePerGB: 0.083 },
      { rangeStart: 51200, rangeEnd: 153600, ratePerGB: 0.07 },
      { rangeStart: 153600, rangeEnd: null, ratePerGB: 0.05 },
    ], benchmark: { conservative: 5, medium: 15, high: 50 } });
  }
});

// Fetch backup pricing for a region
app.get("/api/pricing/backup", async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });
  try {
    const filter = `serviceName eq 'Backup' and armRegionName eq '${region}' and priceType eq 'Consumption'`;
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=100`;
    const data = await fetchWithTimeout(url);
    const items = data.Items || [];

    // Protected instance fee (per VM)
    const instanceItem = items.find(i => i.meterName.includes("Protected Instances") || i.meterName.includes("Azure VM"));
    const instanceFee = instanceItem ? instanceItem.unitPrice : 10.00;

    // Backup storage per GB. Three redundancy options for Recovery Services /
    // Backup vaults: LRS (single zone), ZRS (3 zones in same region — stays in
    // country, datacenter-failure protection), GRS (LRS + paired region).
    const lrsItem = items.find(i => i.meterName.includes("LRS") && i.meterName.includes("Data Stored"));
    const zrsItem = items.find(i => i.meterName.includes("ZRS") && i.meterName.includes("Data Stored") && !i.meterName.includes("GZRS"));
    const grsItem = items.find(i => i.meterName.includes("GRS") && i.meterName.includes("Data Stored") && !i.meterName.includes("GZRS"));
    const lrsPerGB = lrsItem ? lrsItem.unitPrice : 0.05;
    // ZRS pricing isn't published for every region. Fallback = 1.25 × LRS,
    // matching Azure's standard ZRS uplift over LRS for storage workloads.
    const zrsPerGB = zrsItem ? zrsItem.unitPrice : round2(lrsPerGB * 1.25);
    const grsPerGB = grsItem ? grsItem.unitPrice : 0.10;

    res.json({
      region, instanceFeePerVM: round2(instanceFee),
      storageLRSPerGB: round2(lrsPerGB),
      storageZRSPerGB: round2(zrsPerGB),
      storageGRSPerGB: round2(grsPerGB),
      retentionMultipliers: { "30_days": 1.5, "90_days": 2.0, "1_year": 3.0 },
      defaultChangeRate: 3,
    });
  } catch (err) {
    console.error("[Backup Pricing] Error:", err.message);
    res.json({
      region, instanceFeePerVM: 10.00,
      storageLRSPerGB: 0.05, storageZRSPerGB: 0.0625, storageGRSPerGB: 0.10,
      retentionMultipliers: { "30_days": 1.5, "90_days": 2.0, "1_year": 3.0 },
      defaultChangeRate: 3,
    });
  }
});

// Fetch ASR pricing for a region
app.get("/api/pricing/asr", async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });
  try {
    const filter = `serviceName eq 'Azure Site Recovery' and armRegionName eq '${region}' and priceType eq 'Consumption'`;
    const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=50`;
    const data = await fetchWithTimeout(url);
    const items = data.Items || [];
    const perInstance = items.find(i => i.meterName.includes("Protected Instance") || i.meterName.includes("VM Replicated"));
    const pricePerServer = perInstance ? perInstance.unitPrice : 25.00;
    res.json({ region, pricePerServer: round2(pricePerServer) });
  } catch (err) {
    console.error("[ASR Pricing] Error:", err.message);
    res.json({ region, pricePerServer: 25.00 });
  }
});

// ============ DR STRATEGY ============
// List candidate columns from the inventory that the user could use as the
// "criticality / tier" key. Returns columns with their distinct values + counts
// so the UI can render a mapping table. Sorted by goodness-of-fit (column with
// 3-6 distinct values is ideal for tiering).
app.get("/api/dr-strategy/columns", (req, res) => {
  const { sessionId } = req.query;
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport || !session.assessmentReport.servers) {
    return res.status(404).json({ error: "Run assessment first" });
  }
  const servers = session.assessmentReport.servers;
  // Collect candidate extra columns + their value distribution
  const colStats = new Map();
  for (const s of servers) {
    const ec = s.extraColumns || {};
    for (const [col, val] of Object.entries(ec)) {
      if (val === null || val === undefined || val === "") continue;
      if (!colStats.has(col)) colStats.set(col, new Map());
      const valMap = colStats.get(col);
      const v = String(val).trim();
      valMap.set(v, (valMap.get(v) || 0) + 1);
    }
  }
  // Filter to columns with 2-12 distinct values (sensible tiering range) and
  // score them: closer to 5 distinct values is better.
  const candidates = [];
  for (const [col, valMap] of colStats.entries()) {
    const distinct = valMap.size;
    if (distinct < 2 || distinct > 12) continue;
    const totalCovered = [...valMap.values()].reduce((a, b) => a + b, 0);
    const coverage = totalCovered / servers.length;
    if (coverage < 0.5) continue; // skip sparse columns
    // Score: prefer ~5 distinct values, prefer columns whose name hints tier/criticality
    const distinctScore = -Math.abs(distinct - 5);
    const nameHint = /tier|crit|risk|prior|sla|class/i.test(col) ? 5 : 0;
    const score = distinctScore + nameHint + coverage * 2;
    candidates.push({
      column: col,
      distinctCount: distinct,
      coverage: Math.round(coverage * 100),
      score,
      values: [...valMap.entries()]
        .map(([value, count]) => ({ value, count }))
        .sort((a, b) => b.count - a.count),
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  // Suggest the top candidate as the default if its score is positive
  const suggested = candidates.length > 0 && candidates[0].score > 0 ? candidates[0].column : null;
  res.json({ candidates, suggested, totalServers: servers.length });
});

// Calculate DR strategy cost given a criticality column and a tier-to-strategy map.
// Body: { sessionId, column, tierMap: { tierValue: { strategy, rpoHours, rtoHours } }, asrPricePerServer? }
//
// Strategies (all costs are USD/month):
//   none           — no DR cost.
//   backup-restore — Backup GRS only. Cost handled separately by the Backup section;
//                    here we just report 0 standing cost (backup is already in BOM).
//   std-asr        — ASR licence × servers + replicated storage at SAME tier as primary.
//                    DR-side compute = 0 (cold; spins up on failover, billed then).
//   hot-asr        — ASR licence × servers + replicated storage at SAME tier as primary
//                    + warm DR compute at 30 % of primary SKU PAYG.
//   active-active  — 100 % DR-side compute + 100 % DR-side storage (matches primary).
//                    No ASR licence (replication handled at app/SQL layer).
app.post("/api/dr-strategy/calculate", async (req, res) => {
  const { sessionId, column, tierMap, asrPricePerServer, scope } = req.body || {};
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport || !session.assessmentReport.servers) {
    return res.status(404).json({ error: "Run assessment first" });
  }
  if (!tierMap || typeof tierMap !== "object") return res.status(400).json({ error: "tierMap required" });

  const asrLicense = Number(asrPricePerServer) > 0 ? Number(asrPricePerServer) : 25.00;
  // Always re-apply orphan + SQL decisions before bucketing so per-server flags
  // (costExcluded, costDeferredToDr, _orphanOverride, _sqlOverride) are current.
  applyOrphanDecisionsToSession(session);
  applySqlDecisionsToSession(session);
  // Rebuild combined here too so we feed the latest snapshot into the calc.
  session.assessmentReport = buildCombinedSummary(session.envAssessments, session.assessmentName || "Assessment", session.region || "");
  const allServers = session.assessmentReport.servers;

  // Scope filter: 'deferred' (default — the preferred mental model) prices only
  // servers whose VM Assess cost mode is 'dr-defer'. 'whole-estate' applies DR
  // to every non-excluded primary server (as if the customer were duplicating
  // their entire estate at DR). When no env is in 'dr-defer' mode the deferred
  // scope is empty, so we fall back to whole-estate transparently.
  const effectiveScope = scope === "whole-estate" ? "whole-estate" : "deferred";
  const deferredCount = allServers.filter(s => s.costDeferredToDr && !s.costExcluded).length;
  const finalScope = effectiveScope === "deferred" && deferredCount === 0 ? "whole-estate" : effectiveScope;
  const servers = allServers.filter(s => {
    if (s.costExcluded) return false;
    if (finalScope === "deferred") return !!s.costDeferredToDr;
    return true; // whole-estate: include everything except excluded
  });

  // Twin counts per tier — for each tier value, how its servers are distributed
  // across environments (Prod/UAT/SIT/DR/Dev/Test). The Application Pairing data
  // structure tells us the env per server. We use ALL servers (not just scope-
  // filtered) to compute twins so the user can see "Tier 1: scope=314 DR, with
  // 439 Prod twins, 280 UAT twins". This answers "are we covering the right apps?"
  function countTwinsByTier(allServersIn) {
    const out = {};
    for (const s of allServersIn) {
      if (s.costExcluded) continue;
      const tierVal = column ? ((s.extraColumns || {})[column] || "").toString().trim() || "__unmapped__" : "__default__";
      if (!out[tierVal]) out[tierVal] = {};
      const env = s.environment || "Unknown";
      out[tierVal][env] = (out[tierVal][env] || 0) + 1;
    }
    return out;
  }
  const twinCounts = countTwinsByTier(allServers);
  // Bucket servers by their tier value (per the chosen column). Servers with
  // no value land in '__unmapped__' so the user can see + decide.
  // Excluded servers are dropped entirely — they're out of the BOM.
  // 'lns' override servers are dropped from DR strategy (they're in L&S compute).
  // 'dr-strategy' override servers go into a synthetic '__orphan_<strategy>__' bucket
  // so each forced strategy is reported on its own line.
  // 'sql' override servers ('ag' / 'asr') go into '__sql_<mode>__' buckets so
  // SQL replicas appear on dedicated DR Strategy rows independent of their
  // app's tier — exactly the surgical behaviour SQL Always-On / Mirroring needs.
  const buckets = new Map();
  for (const s of servers) {
    if (s._orphanOverride === "lns") continue;
    // SQL override takes precedence over tier and orphan strategy. SQL DR
    // servers in flagged apps land here regardless of tier.
    if (s._sqlOverride === "ag") {
      const k = "__sql_active-active__";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(s);
      continue;
    }
    if (s._sqlOverride === "asr") {
      const k = "__sql_std-asr__";
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(s);
      continue;
    }
    if (s._orphanOverride === "dr-strategy") {
      const stratKey = `__orphan_${s._orphanStrategy || "std-asr"}__`;
      if (!buckets.has(stratKey)) buckets.set(stratKey, []);
      buckets.get(stratKey).push(s);
      continue;
    }
    const tierVal = column ? ((s.extraColumns || {})[column] || "").toString().trim() : "";
    const key = tierVal || "__unmapped__";
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(s);
  }

  const tierResults = [];
  let grandCompute = 0, grandStorage = 0, grandLicense = 0;
  for (const [tierKey, rows] of buckets.entries()) {
    let strategy, cfg;
    if (tierKey.startsWith("__sql_")) {
      // SQL replica synthetic bucket. Strategy is the suffix.
      strategy = tierKey.replace(/^__sql_/, "").replace(/__$/, "");
      cfg = { strategy };
    } else if (tierKey.startsWith("__orphan_")) {
      // Synthetic bucket: orphan apps that user forced to a specific DR strategy.
      strategy = tierKey.replace(/^__orphan_/, "").replace(/__$/, "");
      cfg = { strategy };
    } else {
      cfg = tierMap[tierKey] || tierMap["__default__"] || { strategy: "none" };
      strategy = cfg.strategy || "none";
    }
    // Aggregate primary sizing of the servers in this bucket (we use these as
    // the DR-side reference for hot-asr and active-active scenarios).
    let primaryCompute = 0;
    let primaryStorage = 0;
    let serverCount = rows.length;
    for (const r of rows) {
      primaryCompute += (r.computeMonthlyCost || 0);
      primaryStorage += (r.storageMonthlyCost || 0);
    }
    let computeCost = 0, storageCost = 0, licenseCost = 0;
    let note = "";
    switch (strategy) {
      case "active-active":
        computeCost = primaryCompute;       // 100% of primary SKU running in DR region
        storageCost = primaryStorage;       // 100% replicated storage
        licenseCost = 0;                    // app-layer replication, no ASR licence
        note = "DR-side VMs sized at 100% of primary (active-active). No ASR licence — replication at app/data layer.";
        break;
      case "hot-asr":
        computeCost = round2(primaryCompute * 0.30); // 30% warm DR pool
        storageCost = primaryStorage;       // full replicated storage (Premium implied)
        licenseCost = round2(serverCount * asrLicense);
        note = `${serverCount} servers × $${asrLicense}/mo ASR + 30% warm DR compute + full replicated storage.`;
        break;
      case "std-asr":
        computeCost = 0;                    // cold DR — VMs spin up only on failover
        storageCost = primaryStorage;       // full replicated storage
        licenseCost = round2(serverCount * asrLicense);
        note = `${serverCount} servers × $${asrLicense}/mo ASR + full replicated storage. DR compute billed only on failover.`;
        break;
      case "backup-restore":
        computeCost = 0; storageCost = 0; licenseCost = 0;
        note = "Backup-Restore: GRS backup covers DR. Cost already counted in the Backup section above.";
        break;
      case "none":
      default:
        computeCost = 0; storageCost = 0; licenseCost = 0;
        note = "No DR coverage.";
        break;
    }
    const tierTotal = round2(computeCost + storageCost + licenseCost);
    grandCompute += computeCost;
    grandStorage += storageCost;
    grandLicense += licenseCost;
    tierResults.push({
      tier: tierKey === "__unmapped__" ? "(no value)"
        : tierKey.startsWith("__sql_") ? `SQL replicas → ${strategy === "active-active" ? "Always-On AG" : "Standalone ASR"}`
        : tierKey.startsWith("__orphan_") ? `Orphan apps → ${strategy}`
        : tierKey,
      tierKey,
      serverCount,
      strategy,
      rpoHours: cfg.rpoHours ?? null,
      rtoHours: cfg.rtoHours ?? null,
      primaryCompute: round2(primaryCompute),
      primaryStorage: round2(primaryStorage),
      drCompute: round2(computeCost),
      drStorage: round2(storageCost),
      drLicense: round2(licenseCost),
      monthlyCost: tierTotal,
      note,
    });
  }
  // Sort tiers: by strategy "weight" so most-expensive first, then by tier name.
  const strategyWeight = { "active-active": 4, "hot-asr": 3, "std-asr": 2, "backup-restore": 1, "none": 0 };
  tierResults.sort((a, b) => (strategyWeight[b.strategy] || 0) - (strategyWeight[a.strategy] || 0) || a.tier.localeCompare(b.tier));

  const grandTotal = round2(grandCompute + grandStorage + grandLicense);
  // Persist the user's choice on the session so BOM + export pick it up.
  session.drStrategy = {
    column: column || null,
    tierMap,
    asrPricePerServer: asrLicense,
    scope: finalScope,
    scopeRequested: effectiveScope,
    scopeServerCount: servers.length,
    deferredCount,
    wholeEstateCount: allServers.filter(s => !s.costExcluded).length,
    twinCounts,
    tierResults,
    totals: {
      drCompute: round2(grandCompute),
      drStorage: round2(grandStorage),
      drLicense: round2(grandLicense),
      monthlyCost: grandTotal,
    },
    timestamp: new Date().toISOString(),
  };

  res.json({
    ...session.drStrategy,
    // Echo the latest combined summary so the UI can refresh both totals in one round-trip.
    combined: session.assessmentReport,
  });
});

// Set orphan / UAT-only DR-app decisions. Each call replaces the entire
// decision map for the session (frontend sends the full state). Re-applies
// per-server flags from the decisions, then rebuilds the combined report.
//
// Body: { sessionId, decisions: { "AppName": { action, strategy?, mapToApp? } } }
// Returns: { combined, applicationPairing }
app.post("/api/dr-strategy/orphan-decisions", (req, res) => {
  const { sessionId, decisions } = req.body || {};
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!decisions || typeof decisions !== "object") return res.status(400).json({ error: "decisions object required" });
  // Sanitise: keep only known actions + scrub the values to plain strings.
  const sanitized = {};
  for (const [app, dec] of Object.entries(decisions)) {
    if (!dec || typeof dec !== "object") continue;
    const action = ["lns", "dr-strategy", "exclude", "map"].includes(dec.action) ? dec.action : null;
    if (!action) continue;
    const entry = { action };
    if (action === "dr-strategy" && typeof dec.strategy === "string") entry.strategy = dec.strategy;
    if (action === "map" && typeof dec.mapToApp === "string" && dec.mapToApp.trim()) entry.mapToApp = dec.mapToApp.trim();
    sanitized[String(app)] = entry;
  }
  session.orphanDecisions = sanitized;

  // Re-route per-server cost flags and re-sum env totals.
  applyOrphanDecisionsToSession(session);

  // Rebuild the combined session report with the new flags.
  const combined = buildCombinedSummary(session.envAssessments, session.assessmentName || "Assessment", session.region || "");
  session.assessmentReport = combined;
  res.json({ combined, applicationPairing: combined.applicationPairing, decisions: sanitized });
});

// Set per-app SQL replica decisions. Each call replaces the entire decision
// map for the session (frontend sends the full state). Re-applies per-server
// SQL flags, then rebuilds the combined report. The DR Strategy calculator
// will route SQL DR servers into '__sql_active-active__' / '__sql_std-asr__'
// buckets based on these decisions, leaving non-SQL DR servers in the same
// app under their tier-strategy.
//
// Body: { sessionId, decisions: { "AppName": { action: "ag"|"asr"|"tier" } } }
// Returns: { combined, sqlReplicaCandidates, decisions }
app.post("/api/dr-strategy/sql-decisions", (req, res) => {
  const { sessionId, decisions } = req.body || {};
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (!decisions || typeof decisions !== "object") return res.status(400).json({ error: "decisions object required" });
  const sanitized = {};
  for (const [app, dec] of Object.entries(decisions)) {
    if (!dec || typeof dec !== "object") continue;
    const action = ["ag", "asr", "tier"].includes(dec.action) ? dec.action : null;
    if (!action) continue;
    sanitized[String(app)] = { action };
  }
  session.sqlDecisions = sanitized;
  applySqlDecisionsToSession(session);
  const combined = buildCombinedSummary(session.envAssessments, session.assessmentName || "Assessment", session.region || "");
  session.assessmentReport = combined;
  res.json({ combined, sqlReplicaCandidates: combined.sqlReplicaCandidates, decisions: sanitized });
});


// Fetch landing zone component SKUs and pricing for a region
app.get("/api/pricing/landing-zone", async (req, res) => {
  const { region } = req.query;
  if (!region) return res.status(400).json({ error: "region required" });

  const components = {};

  async function fetchService(serviceName, label) {
    try {
      const filter = `serviceName eq '${serviceName}' and armRegionName eq '${region}' and priceType eq 'Consumption'`;
      const url = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}&$top=100`;
      const data = await fetchWithTimeout(url);
      return (data.Items || []).map(i => ({
        skuName: i.skuName, meterName: i.meterName,
        unitPrice: i.unitPrice, unitOfMeasure: i.unitOfMeasure,
        productName: i.productName,
      }));
    } catch (e) { return []; }
  }

  // Fetch all LZ services in parallel
  const [firewallItems, vpnItems, bastionItems, logItems, kvItems, erItems] = await Promise.all([
    fetchService("Azure Firewall", "Firewall"),
    fetchService("VPN Gateway", "VPN"),
    fetchService("Azure Bastion", "Bastion"),
    fetchService("Log Analytics", "Log Analytics"),
    fetchService("Key Vault", "Key Vault"),
    fetchService("ExpressRoute", "ExpressRoute"),
  ]);

  // Build SKU options with monthly cost estimates
  // For services like Azure Firewall, multiple meters per SKU should be SUMMED (Deployment + Data Processing)
  function buildSkus(items, hourlyKeywords, defaultSku) {
    const skuMap = {};
    for (const item of items) {
      const key = item.skuName || item.meterName;
      if (!skuMap[key]) skuMap[key] = { sku: key, monthly: 0, meter: item.meterName, meters: [] };
      let itemMonthly = 0;
      if (item.unitOfMeasure.includes("Hour") || item.unitOfMeasure === "1/Hour" || item.unitOfMeasure === "1 Hour") {
        itemMonthly = round2(item.unitPrice * 730);
      } else if (item.unitOfMeasure.includes("Month") || item.unitOfMeasure === "1/Month") {
        itemMonthly = round2(item.unitPrice);
      } else if (item.unitOfMeasure.includes("Day") || item.unitOfMeasure === "1/Day") {
        itemMonthly = round2(item.unitPrice * 30);
      } else if (item.unitOfMeasure.includes("GB")) {
        // Per-GB charges (data processing) — skip as variable cost, only include fixed fees
        continue;
      } else {
        itemMonthly = round2(item.unitPrice);
      }
      // Only add deployment/fixed fees, not per-GB variable charges
      if (item.meterName.toLowerCase().includes("deployment") || item.meterName.toLowerCase().includes("gateway") ||
          item.meterName.toLowerCase().includes("unit") || item.meterName.toLowerCase().includes("instance") ||
          item.meterName.toLowerCase().includes("connection") || !item.meterName.toLowerCase().includes("data")) {
        skuMap[key].monthly += itemMonthly;
        skuMap[key].meters.push(item.meterName);
      }
    }
    // Round final values
    for (const v of Object.values(skuMap)) { v.monthly = round2(v.monthly); }
    const skus = Object.values(skuMap).filter(s => s.monthly > 0).sort((a, b) => a.monthly - b.monthly);
    return { skus, defaultSku };
  }

  components.firewall = buildSkus(firewallItems, ["Deployment"], "Standard");
  components.vpnGateway = buildSkus(vpnItems, ["Gateway"], "VpnGw1");
  components.bastion = buildSkus(bastionItems, ["Gateway"], "Basic");
  components.logAnalytics = buildSkus(logItems, ["Data"], null);
  components.keyVault = buildSkus(kvItems, [], "Standard");
  components.expressRoute = buildSkus(erItems, [], null);

  res.json({ region, components });
});


// ============ HELPER FUNCTIONS ============

function getToken(req) {
  const tokenId = req.headers["x-token-id"];
  const tokenSession = sessions[`token_${tokenId}`];
  if (!tokenSession || Date.now() > tokenSession.expiresAt) return null;
  return tokenSession.accessToken;
}

function mapGeographyToLocation(geography) {
  const found = AZURE_MIGRATE_GEOGRAPHIES.find(g => g.geography.toLowerCase() === geography.toLowerCase());
  if (found) return found.location;
  // fallback: use the geography value as-is
  return geography.toLowerCase().replace(/\s+/g, "");
}

function round2(n) { return Math.round(n * 100) / 100; }

// Fetch with timeout for external API calls (default 15s)
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function processMapping(rawData, mappingOverride) {
  const activeMapping = mappingOverride || columnMapping;
  const resultRows = [];
  const report = { duplicateNames: 0, duplicateIPs: 0, ipsCleaned: 0, osVersionsCleaned: 0 };

  for (const sourceRow of rawData) {
    const targetRow = {};
    for (const templateCol of templateHeaders) {
      const colName = templateCol.trim();
      const mapping = activeMapping[colName];
      if (mapping === null || mapping === undefined) {
        targetRow[colName] = "";
      } else if (typeof mapping === "function") {
        targetRow[colName] = mapping(sourceRow);
      } else {
        targetRow[colName] = sourceRow[mapping] !== undefined ? sourceRow[mapping] : "";
      }
    }
    resultRows.push(targetRow);
  }

  // Fix IPs
  for (const row of resultRows) {
    let ip = row["IP addresses"];
    if (!ip || ip.toString().trim() === "") continue;
    const parts = ip.toString().split(/[,\/]/).map(p => p.trim());
    const validIp = parts.find(p => p.match(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/));
    if (validIp !== ip) report.ipsCleaned++;
    row["IP addresses"] = validIp || "";
  }

  // Fix OS version
  for (const row of resultRows) {
    const osVersion = String(row["OS version"] || "");
    if (osVersion && !osVersion.match(/^[\d.]+$/)) {
      const match = osVersion.match(/([\d]+\.[\d.]+)/);
      row["OS version"] = match ? match[1] : "";
      report.osVersionsCleaned++;
    }
  }

  // Validate
  const validRows = [];
  const invalidRows = [];
  for (const row of resultRows) {
    const errors = [];
    if (!row["*Server name"] || row["*Server name"].toString().trim() === "") errors.push("Server name missing");
    if ((parseInt(row["*Cores"]) || 0) === 0) errors.push("Cores is 0 or missing");
    if (!row["*Memory (In MB)"] || parseInt(row["*Memory (In MB)"]) === 0) errors.push("Memory missing or 0");
    if (!row["*OS name"] || row["*OS name"].toString().trim() === "") errors.push("OS name missing");

    if (errors.length > 0) {
      row["Error"] = errors.join("; ");
      invalidRows.push(row);
    } else {
      validRows.push(row);
    }
  }

  // Deduplicate IPs
  const seenIPs = new Set();
  for (const row of validRows) {
    const ip = row["IP addresses"];
    if (!ip || ip.toString().trim() === "") continue;
    if (seenIPs.has(ip)) { row["IP addresses"] = ""; report.duplicateIPs++; }
    else seenIPs.add(ip);
  }

  // Deduplicate names
  const seenNames = {};
  for (const row of validRows) {
    const name = row["*Server name"];
    if (seenNames[name] === undefined) { seenNames[name] = 0; }
    else { seenNames[name]++; row["*Server name"] = `${name}_${seenNames[name]}`; report.duplicateNames++; }
  }

  return { validRows, invalidRows, report };
}

function generateCsv(rows, headers) {
  function esc(val) {
    const str = String(val == null ? "" : val);
    if (str.includes(",") || str.includes('"') || str.includes("\n")) return `"${str.replace(/"/g, '""')}"`;
    return str;
  }
  const headerLine = headers.map(h => esc(h.trim())).join(",");
  const dataLines = rows.map(row => headers.map(h => esc(row[h.trim()])).join(","));
  return [headerLine, ...dataLines].join("\n");
}

function generateReport(totalInput, validRows, invalidRows, report) {
  const lines = [
    "=".repeat(60),
    "  AZURE MIGRATE CSV CONVERSION REPORT",
    "=".repeat(60),
    "", `Date: ${new Date().toISOString()}`, "",
    "--- SUMMARY ---",
    `Total input rows:        ${totalInput}`,
    `Valid rows (Az Migrate):  ${validRows.length}`,
    `Excluded rows (invalid): ${invalidRows.length}`, "",
    "--- DATA CLEANUP ---",
    `IPs cleaned/fixed:       ${report.ipsCleaned}`,
    `OS versions cleaned:     ${report.osVersionsCleaned}`,
    `Duplicate IPs blanked:   ${report.duplicateIPs}`,
    `Duplicate names renamed: ${report.duplicateNames}`, "",
    "--- COLUMN MAPPING ---",
  ];

  for (const [target, source] of Object.entries(columnMapping)) {
    if (source === null) lines.push(`  ${target} -> (not mapped)`);
    else if (typeof source === "function") lines.push(`  ${target} -> (computed)`);
    else lines.push(`  ${target} -> "${source}"`);
  }

  if (invalidRows.length > 0) {
    lines.push("", "--- EXCLUDED SERVERS ---");
    for (const row of invalidRows.slice(0, 50)) {
      lines.push(`  ${row["*Server name"] || "Unknown"}: ${row["Error"]}`);
    }
    if (invalidRows.length > 50) lines.push(`  ... and ${invalidRows.length - 50} more`);
  }

  lines.push("", "=".repeat(60), "  END OF REPORT", "=".repeat(60));
  return lines.join("\n");
}

// ============ WAVE PLAN ENDPOINTS ============

const wavePlanConfig = JSON.parse(fs.readFileSync(path.join(__dirname, "wavePlanConfig.json"), "utf-8"));
const wavePlanLogic = JSON.parse(fs.readFileSync(path.join(__dirname, "wavePlanLogic.json"), "utf-8"));

// When the user groups by Tier, the inventory's tier values are typically bare
// strings ("1", "2", "3", "4", "1+", "T2", "Non-Tier", ...). The criticality
// priority dictionary in wavePlanLogic.json uses keys like "tier 1" / "tier1",
// so substring matching against the raw value never fires — every tier ends
// up with the same critScore and the count tiebreaker reverses the intended
// order (largest tier first instead of last). This helper emits an extra
// "tier N" token so the existing dictionary picks it up cleanly. Returns an
// empty string when no numeric tier is detectable.
function tierHaystackBoost(groupName, groupBy, groupColumn) {
  if (groupName == null) return "";
  const isTierMode = groupBy === "tier" || (groupColumn && /tier|criticality|classification/i.test(groupColumn));
  if (!isTierMode) return "";
  const m = String(groupName).match(/(\d+)/);
  if (!m) return "";
  return ` tier ${m[1]} tier-${m[1]} tier${m[1]}`;
}

// Detect grouping columns available in the session's inventory
app.get("/api/waveplan/detect-groups", (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found. The server may have restarted — reload your saved session from the Setup panel, or re-upload the inventory." });

  const report = session.assessmentReport;
  if (!report || !report.servers) return res.status(400).json({ error: "No assessment data. Run the VM Assessment (Step 3) first." });

  // Only consider L&S servers for grouping — deferred/excluded rows don't ride
  // in waves so showing them in group counts would mislead the user.
  const wavePlanServers = report.servers.filter(s => !s.costExcluded && !s.costDeferredToDr);

  // Collect all extra column names from servers
  const extraCols = new Set();
  for (const srv of wavePlanServers) {
    if (srv.extraColumns) {
      for (const col of Object.keys(srv.extraColumns)) extraCols.add(col);
    }
  }

  // Match against known grouping patterns (smart labels)
  const detected = [];
  const usedColumns = new Set(); // track which columns matched a known pattern

  for (const mode of wavePlanConfig.groupingModes) {
    const matchedCol = mode.columnPatterns.find(pattern =>
      [...extraCols].some(col => col.toLowerCase().includes(pattern.toLowerCase()))
    );
    if (matchedCol) {
      const actualCol = [...extraCols].find(col => col.toLowerCase().includes(matchedCol.toLowerCase()));
      const values = [...new Set(wavePlanServers.map(s => (s.extraColumns && s.extraColumns[actualCol]) || "Unknown").filter(v => v))];
      detected.push({ ...mode, detected: true, column: actualCol, values });
      usedColumns.add(actualCol);
    } else {
      detected.push({ ...mode, detected: false, column: null });
    }
  }

  // Always offer environment grouping from envAssessments if available
  if (session.envAssessments && Object.keys(session.envAssessments).length > 1) {
    const envMode = detected.find(d => d.id === "environment");
    if (envMode && !envMode.detected) {
      envMode.detected = true;
      envMode.column = "__environment__";
      envMode.values = Object.keys(session.envAssessments);
    }
  }

  // Add remaining extra columns as dynamic grouping options — but only if they look like valid grouping columns
  const excludePatterns = /^(cpu|cores|vcpu|ram|memory|disk|storage|manufacturer|model|serial|ip|mac|uuid|bios|firmware|os\s*version|os\s*type|kernel|hostname|fqdn|domain|size|capacity|speed|frequency|architecture|processor|nic|network.*adapter|interface|port|slot|power|height|rack|datacenter|physical|virtual|cluster|host)/i;
  for (const col of extraCols) {
    if (usedColumns.has(col)) continue; // already matched a known pattern
    if (excludePatterns.test(col.trim())) continue; // skip hardware/infra columns not relevant to wave planning
    const values = [...new Set(wavePlanServers.map(s => (s.extraColumns && s.extraColumns[col]) || "").filter(v => v))];
    if (values.length > 1 && values.length <= 200) { // skip columns with only 1 value or too many unique values (e.g. server names)
      detected.push({ id: `col_${col}`, label: `By "${col}"`, detected: true, column: col, values, columnPatterns: [] });
    }
  }

  // Always add "Distribute Evenly" as a fallback option (no grouping, splits VMs evenly by count)
  detected.push({ id: "even", label: "Distribute Evenly (no grouping)", detected: true, column: null, values: null, columnPatterns: [] });

  res.json({ groupingModes: detected, config: wavePlanConfig.defaults, totalServers: wavePlanServers.length });
});

// Generate wave plan (rule-based auto-assignment)
app.post("/api/waveplan/generate", (req, res) => {
  const { sessionId, numWaves, lzDesignWeeks, lzProvisionWeeks, pilotDurationWeeks, waveDurationWeeks, bufferDays, startDate, groupBy, groupColumn } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found. The server may have restarted — reload your saved session from the Setup panel, or re-upload the inventory." });
  if (!session.assessmentReport) return res.status(404).json({ error: "No assessment data. Run the VM Assessment (Step 3) first." });

  const report = session.assessmentReport;
  // Wave plan migrates Lift & Shift servers only. Deferred-to-DR-Strategy
  // servers (e.g. ABMB's 314 DR replicas) are protection wrapping around the
  // primary estate \u2014 they ride along with the strategy chosen in Step 5,
  // not as individual wave items. Excluded servers aren't being migrated.
  const servers = (report.servers || []).filter(s => !s.costExcluded && !s.costDeferredToDr);

  // Group servers
  const groups = {};
  if (groupBy === "even") {
    // No grouping — treat as one flat list, will split evenly across waves
    groups["All Servers"] = [...servers];
  } else {
    for (const srv of servers) {
      let groupName;
      if (groupBy === "environment" && groupColumn === "__environment__") {
        groupName = srv.environment || "Unknown";
      } else if (groupColumn && srv.extraColumns && srv.extraColumns[groupColumn]) {
        groupName = srv.extraColumns[groupColumn];
      } else {
        groupName = srv.environment || "All";
      }
      if (!groups[groupName]) groups[groupName] = [];
      groups[groupName].push(srv);
    }
  }

  // Score each group for priority assignment.
  // The scoring is intentionally generic: callers may have any tag/column convention,
  // so we look at group name AND any string fields on the servers (extraColumns + environment)
  // to find optional hints from the configured priority dictionaries. If no hint matches,
  // we fall back to a neutral score and tiebreak by server count ascending so that
  // smaller groups get earlier waves (good pilot candidates).
  const envPriority = (wavePlanLogic.autoAssignment && wavePlanLogic.autoAssignment.environmentPriority) || {};
  const critPriority = (wavePlanLogic.autoAssignment && wavePlanLogic.autoAssignment.criticalityPriority) || {};

  function findPriorityHint(haystack, dict) {
    if (!haystack || !dict) return null;
    const lower = haystack.toLowerCase();
    let best = null;
    for (const [key, val] of Object.entries(dict)) {
      if (!key) continue;
      if (lower.includes(key.toLowerCase())) {
        // For a heterogeneous group, the highest-risk hint wins: a group that contains
        // even one production server should be treated as production (industry practice).
        if (best === null || val > best) best = val;
      }
    }
    return best;
  }

  const scoredGroups = Object.entries(groups).map(([name, srvs]) => {
    const haystackParts = [name, tierHaystackBoost(name, groupBy, groupColumn)];
    for (const srv of srvs) {
      if (srv && srv.environment) haystackParts.push(String(srv.environment));
      if (srv && srv.extraColumns) {
        for (const v of Object.values(srv.extraColumns)) {
          if (v != null && typeof v !== "object") haystackParts.push(String(v));
        }
      }
    }
    const haystack = haystackParts.join(" ");
    const envHint = findPriorityHint(haystack, envPriority);
    const critHint = findPriorityHint(haystack, critPriority);
    const envScore = envHint != null ? envHint : 3;
    const critScore = critHint != null ? critHint : 2;
    // Lower score = earlier wave. Server count adds a small weight so larger groups
    // are not all stuffed into the pilot wave.
    const score = envScore + critScore + Math.log2(srvs.length + 1);
    return { name, servers: srvs, serverCount: srvs.length, score };
  });

  // Sort by score, then by server count ascending as a tiebreaker.
  scoredGroups.sort((a, b) => (a.score - b.score) || (a.serverCount - b.serverCount));

  // For "even" mode: split the single "All Servers" group into even chunks
  if (groupBy === "even" && scoredGroups.length === 1 && scoredGroups[0].name === "All Servers") {
    const allSrvs = scoredGroups[0].servers;
    const totalWavesIncPilot = (numWaves || wavePlanConfig.defaults.numMigrationWaves) + 1; // +1 for pilot
    const chunkSize = Math.ceil(allSrvs.length / totalWavesIncPilot);
    scoredGroups.length = 0;
    for (let i = 0; i < totalWavesIncPilot; i++) {
      const chunk = allSrvs.slice(i * chunkSize, (i + 1) * chunkSize);
      if (chunk.length > 0) {
        scoredGroups.push({ name: `Batch ${i + 1}`, servers: chunk, serverCount: chunk.length, score: i });
      }
    }
  }

  // Build waves
  const totalMigrationWaves = numWaves || wavePlanConfig.defaults.numMigrationWaves;
  const waves = [];
  const start = new Date(startDate || Date.now() + wavePlanConfig.defaults.startDateOffsetDays * 86400000);
  const lzDesignW = lzDesignWeeks || wavePlanConfig.defaults.lzDesignWeeks;
  const lzProvW = lzProvisionWeeks || wavePlanConfig.defaults.lzProvisionWeeks;
  const waveDurW = waveDurationWeeks || wavePlanConfig.defaults.waveDurationWeeks;
  const bufDays = bufferDays != null ? bufferDays : wavePlanConfig.defaults.bufferDays;
  const pilotW = pilotDurationWeeks || wavePlanConfig.defaults.pilotDurationWeeks || 8;
  const pilotThroughput = req.body.pilotThroughputPerWeek || wavePlanConfig.defaults.pilotThroughputPerWeek || 10;
  const waveThroughput = req.body.waveThroughputPerWeek || wavePlanConfig.defaults.waveThroughputPerWeek || 30;

  // Throughput-based capacity
  const maxPilotVMs = pilotW * pilotThroughput;
  const maxWaveVMs = waveDurW * waveThroughput;
  const totalCapacity = maxPilotVMs + (totalMigrationWaves * maxWaveVMs);

  // Wave 0: Foundation (LZ Design + LZ Provision + Pilot Migration)
  const wave0Start = new Date(start);
  const wave0End = new Date(wave0Start.getTime() + (lzDesignW + lzProvW + pilotW) * 7 * 86400000);

  // Assign pilot group(s): fill up to throughput capacity
  const wave0Groups = [];
  let pilotCount = 0;
  const remaining = [...scoredGroups];

  while (remaining.length > 0 && pilotCount + remaining[0].serverCount <= maxPilotVMs) {
    const g = remaining.shift();
    wave0Groups.push(g);
    pilotCount += g.serverCount;
  }
  // Ensure at least one group in pilot if available
  if (wave0Groups.length === 0 && remaining.length > 0) {
    const g = remaining.shift();
    wave0Groups.push(g);
    pilotCount = g.serverCount;
  }

  // Preserve any user-edited free-text fields (e.g. strategicIntent) across
  // regenerations. Map by waveNumber so editing Wave 2 then re-running with
  // a different group-by doesn't wipe the intent text.
  const priorIntents = new Map();
  for (const w of (session.wavePlan?.waves || [])) {
    if (w.strategicIntent) priorIntents.set(w.waveNumber, w.strategicIntent);
  }

  // Per-server wave cost includes BCDR backup attribution. Backup is set on
  // each server by the frontend's calculateBackupCost() based on the env's
  // retention/redundancy policy. Servers in non-backed-up envs have
  // backupMonthlyCost = 0, so this is safe to always sum.
  const serverWaveCost = (srv) => (srv.totalMonthlyCost || 0) + (srv.backupMonthlyCost || 0);
  const wave0Cost = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + serverWaveCost(srv), 0), 0);
  const wave0Backup = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.backupMonthlyCost || 0), 0), 0);

  waves.push({
    waveNumber: 0,
    name: "Wave 0 - Foundation & Pilot",
    startDate: wave0Start.toISOString().split("T")[0],
    endDate: wave0End.toISOString().split("T")[0],
    durationWeeks: lzDesignW + lzProvW + pilotW,
    phases: [
      { label: "LZ Design", weeks: lzDesignW },
      { label: "LZ Provisioning", weeks: lzProvW },
      { label: "Pilot Migration", weeks: pilotW, capacity: maxPilotVMs, groups: wave0Groups.map(g => g.name) },
    ],
    groups: wave0Groups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName) })),
    totalServers: pilotCount,
    maxCapacity: maxPilotVMs,
    waveCost: round2(wave0Cost),
    waveBackup: round2(wave0Backup),
    cumulativeCost: round2(wave0Cost),
    strategicIntent: priorIntents.get(0) || "",
  });

  // Distribute remaining groups across migration waves preserving risk order.
  // Industry practice: dev/test in early waves, UAT/staging mid, production/DR in last wave.
  const migrationWaves = [];
  for (let i = 0; i < totalMigrationWaves; i++) migrationWaves.push([]);

  if (remaining.length === 0) {
    // nothing to do
  } else if (remaining.length <= totalMigrationWaves) {
    // Few groups: assign exactly one per wave, packed to the END so the highest-risk
    // group lands in the final wave. Early migration waves may legitimately be empty —
    // we surface that as a capacity warning so the user can reduce the wave count.
    const offset = totalMigrationWaves - remaining.length;
    for (let i = 0; i < remaining.length; i++) migrationWaves[offset + i].push(remaining[i]);
  } else {
    // Many groups: slice the score-sorted list into N segments at roughly equal VM-count
    // midpoints. Order is preserved so risk order is preserved.
    const totalRemainingVMs = remaining.reduce((s, g) => s + g.serverCount, 0);
    const targetPerWave = totalRemainingVMs / totalMigrationWaves;
    let cumVMs = 0;
    for (const g of remaining) {
      const midpoint = cumVMs + g.serverCount / 2;
      let waveIdx = targetPerWave > 0 ? Math.floor(midpoint / targetPerWave) : 0;
      if (waveIdx >= totalMigrationWaves) waveIdx = totalMigrationWaves - 1;
      migrationWaves[waveIdx].push(g);
      cumVMs += g.serverCount;
    }

    // Eliminate empty waves caused by one wave hogging a contiguous run of groups.
    // Sweep adjacent waves and re-slice within their range.
    function eliminateEmptyWaves(buckets) {
      const N = buckets.length;
      for (let pass = 0; pass < N; pass++) {
        let changed = false;
        for (let i = 0; i < N; i++) {
          if (buckets[i].length > 0) continue;
          // Find largest neighbor bucket as donor for re-slicing
          let donorIdx = -1, donorCount = -1;
          for (let j = 0; j < N; j++) {
            if (j === i || buckets[j].length === 0) continue;
            const c = buckets[j].reduce((s, g) => s + g.serverCount, 0);
            if (c > donorCount) { donorCount = c; donorIdx = j; }
          }
          if (donorIdx === -1) break;
          const lo = Math.min(i, donorIdx);
          const hi = Math.max(i, donorIdx);
          const merged = [];
          for (let k = lo; k <= hi; k++) merged.push(...buckets[k]);
          if (merged.length < 2) continue; // can't split a single group
          const total = merged.reduce((s, g) => s + g.serverCount, 0);
          const nRange = hi - lo + 1;
          if (total === 0) continue;
          const tgt = total / nRange;
          for (let k = lo; k <= hi; k++) buckets[k] = [];
          let cum = 0;
          for (const g of merged) {
            const mid = cum + g.serverCount / 2;
            let idx = lo + Math.floor(mid / tgt);
            if (idx > hi) idx = hi;
            if (idx < lo) idx = lo;
            buckets[idx].push(g);
            cum += g.serverCount;
          }
          changed = true;
        }
        if (!changed) break;
      }
    }
    eliminateEmptyWaves(migrationWaves);
  }

  let cumCost = wave0Cost;
  let currentEnd = new Date(wave0End.getTime() + bufDays * 86400000);
  let capacityWarning = null;

  for (let i = 0; i < totalMigrationWaves; i++) {
    const waveGroups = migrationWaves[i];
    const waveStart = new Date(currentEnd);
    const waveEnd = new Date(waveStart.getTime() + waveDurW * 7 * 86400000);
    const waveServerCount = waveGroups.reduce((s, g) => s + g.serverCount, 0);
    const waveCost = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + serverWaveCost(srv), 0), 0);
    const waveBackup = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.backupMonthlyCost || 0), 0), 0);
    cumCost += waveCost;

    // Check if wave exceeds throughput capacity
    if (waveServerCount > maxWaveVMs && !capacityWarning) {
      capacityWarning = `Wave ${i + 1} has ${waveServerCount} VMs but capacity is ${maxWaveVMs} (${waveDurW} wks × ${waveThroughput}/wk). Consider increasing wave duration, adding more waves, or increasing throughput.`;
    }

    waves.push({
      waveNumber: i + 1,
      name: `Wave ${i + 1}`,
      startDate: waveStart.toISOString().split("T")[0],
      endDate: waveEnd.toISOString().split("T")[0],
      durationWeeks: waveDurW,
      groups: waveGroups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName) })),
      totalServers: waveServerCount,
      maxCapacity: maxWaveVMs,
      overCapacity: waveServerCount > maxWaveVMs,
      waveCost: round2(waveCost),
      waveBackup: round2(waveBackup),
      cumulativeCost: round2(cumCost),
      strategicIntent: priorIntents.get(i + 1) || "",
    });

    currentEnd = new Date(waveEnd.getTime() + bufDays * 86400000);
  }

  // Warn about empty migration waves (typically: fewer distinct risk groups than waves).
  const emptyWaves = waves.filter(w => w.waveNumber > 0 && w.totalServers === 0).map(w => w.name);
  if (emptyWaves.length > 0) {
    const groupCount = remaining.length + wave0Groups.length;
    const suggestedWaves = Math.max(1, groupCount - 1); // -1 because wave 0 is pilot
    const msg = `${emptyWaves.join(", ")} ${emptyWaves.length === 1 ? "is" : "are"} empty because there are only ${groupCount} distinct group(s) for ${totalMigrationWaves + 1} wave(s). Risk-order distribution requires at least one group per wave. Consider reducing wave count to ${suggestedWaves} or choosing a finer "Distribute by" column.`;
    capacityWarning = capacityWarning ? `${capacityWarning} | ${msg}` : msg;
  }

  // Store in session
  const throughputInfo = { pilotThroughputPerWeek: pilotThroughput, waveThroughputPerWeek: waveThroughput, maxPilotVMs, maxWaveVMs, totalCapacity };
  session.wavePlan = { waves, config: { numWaves: totalMigrationWaves, lzDesignWeeks: lzDesignW, lzProvisionWeeks: lzProvW, pilotDurationWeeks: pilotW, waveDurationWeeks: waveDurW, bufferDays: bufDays, startDate: start.toISOString().split("T")[0], groupBy, groupColumn }, throughput: throughputInfo, capacityWarning };

  saveSessionToDisk(sessionId);
  res.json(session.wavePlan);
});

// Update wave plan (user reassigns groups)
app.post("/api/waveplan/update", (req, res) => {
  const { sessionId, assignments, groupMeta, config: reqConfig } = req.body;
  // assignments: { "groupName": waveNumber, ... }
  // groupMeta: { "groupName": { reason, tags } } — optional, from LLM
  // config: optional UI config values (from AI path)
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found. The server may have restarted — reload your saved session from the Setup panel, or re-upload the inventory." });
  if (!session.assessmentReport) return res.status(404).json({ error: "No assessment data. Run the VM Assessment (Step 3) first." });

  // If wavePlan doesn't exist yet (AI path without prior rule-based gen), initialize config
  if (!session.wavePlan) {
    session.wavePlan = { waves: [], config: {} };
  }

  // Merge request config into stored config (UI values ALWAYS override stored values)
  if (reqConfig) {
    session.wavePlan.config = {
      numWaves: reqConfig.numWaves || wavePlanConfig.defaults.numMigrationWaves || 3,
      lzDesignWeeks: reqConfig.lzDesignWeeks || wavePlanConfig.defaults.lzDesignWeeks || 4,
      lzProvisionWeeks: reqConfig.lzProvisionWeeks || wavePlanConfig.defaults.lzProvisionWeeks || 2,
      pilotDurationWeeks: reqConfig.pilotDurationWeeks || wavePlanConfig.defaults.pilotDurationWeeks || 8,
      waveDurationWeeks: reqConfig.waveDurationWeeks || wavePlanConfig.defaults.waveDurationWeeks || 2,
      bufferDays: reqConfig.bufferDays != null ? reqConfig.bufferDays : (wavePlanConfig.defaults.bufferDays || 3),
      startDate: reqConfig.startDate || new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0],
      groupBy: reqConfig.groupBy || session.wavePlan.config.groupBy || "application",
      groupColumn: reqConfig.groupColumn != null ? reqConfig.groupColumn : (session.wavePlan.config.groupColumn || null),
    };
  }

  const report = session.assessmentReport;
  // Same L&S-only filter as generate / detect-groups for consistency.
  const servers = (report.servers || []).filter(s => !s.costExcluded && !s.costDeferredToDr);
  const config = session.wavePlan.config;

  // Rebuild groups from original grouping
  const groupColumn = config.groupColumn;
  const groups = {};
  for (const srv of servers) {
    let groupName;
    if (config.groupBy === "environment" && groupColumn === "__environment__") {
      groupName = srv.environment || "Unknown";
    } else if (groupColumn && srv.extraColumns && srv.extraColumns[groupColumn]) {
      groupName = srv.extraColumns[groupColumn];
    } else {
      groupName = srv.environment || "All";
    }
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(srv);
  }

  // Also build server-name lookup for server-level assignments
  const serverByName = {};
  for (const srv of servers) { serverByName[srv.serverName] = srv; }

  // Build case-insensitive lookup maps
  const groupsLower = {};
  for (const key of Object.keys(groups)) { groupsLower[key.toLowerCase().trim()] = key; }
  const serversLower = {};
  for (const key of Object.keys(serverByName)) { serversLower[key.toLowerCase().trim()] = key; }

  // Rebuild waves based on assignments
  const numWaves = config.numWaves || wavePlanConfig.defaults.numMigrationWaves || 3;
  const waveBuckets = {};
  for (let i = 0; i <= numWaves; i++) waveBuckets[i] = [];

  // First pass: collect server-level assignments. These take precedence over the
  // server's parent group — the group bucket will exclude these specific servers.
  const serverLevelAssignments = new Map(); // canonicalServerName -> waveIdx
  for (const [name, waveNum] of Object.entries(assignments)) {
    const waveIdx = Math.max(0, Math.min(numWaves, parseInt(waveNum) || 0));
    if (groups[name] || groupsLower[name.toLowerCase().trim()]) continue; // group keys handled in second pass
    const actualServerName = serverByName[name] ? name : serversLower[name.toLowerCase().trim()];
    if (actualServerName && serverByName[actualServerName]) {
      serverLevelAssignments.set(actualServerName, waveIdx);
    }
  }

  let assignedCount = 0;
  for (const [groupName, waveNum] of Object.entries(assignments)) {
    const waveIdx = Math.max(0, Math.min(numWaves, parseInt(waveNum) || 0));
    // Try exact match first, then case-insensitive
    const actualGroupName = groups[groupName] ? groupName : groupsLower[groupName.toLowerCase().trim()];
    const actualServerName = serverByName[groupName] ? groupName : serversLower[groupName.toLowerCase().trim()];

    if (actualGroupName && groups[actualGroupName]) {
      // Group-level assignment — exclude any servers that have their own server-level assignment.
      const meta = (groupMeta && groupMeta[groupName]) || {};
      const filteredSrvs = groups[actualGroupName].filter(s => !serverLevelAssignments.has(s.serverName));
      if (filteredSrvs.length === 0) continue; // entire group split out via server-level moves
      waveBuckets[waveIdx].push({ name: actualGroupName, servers: filteredSrvs, serverCount: filteredSrvs.length, reason: meta.reason || "", tags: meta.tags || {} });
      assignedCount += filteredSrvs.length;
    } else if (actualServerName && serverByName[actualServerName]) {
      // Server-level assignment (LLM split into individual servers)
      const meta = (groupMeta && groupMeta[groupName]) || {};
      waveBuckets[waveIdx].push({ name: actualServerName, servers: [serverByName[actualServerName]], serverCount: 1, reason: meta.reason || "", tags: meta.tags || {} });
      assignedCount += 1;
    } else {
      console.warn(`[WavePlan Update] Unmatched assignment: "${groupName}" → wave ${waveIdx} (no matching group or server found)`);
    }
  }

  // If some groups were unassigned (LLM missed them), add them to earliest empty wave or wave 1.
  // Filter out any servers that were split off via server-level assignments so we don't double-count.
  const allGroupNames = new Set(Object.keys(groups));
  const assignedGroups = new Set();
  for (const bucket of Object.values(waveBuckets)) {
    for (const g of bucket) { assignedGroups.add(g.name); }
  }
  for (const unassigned of allGroupNames) {
    if (!assignedGroups.has(unassigned)) {
      const filteredSrvs = groups[unassigned].filter(s => !serverLevelAssignments.has(s.serverName));
      if (filteredSrvs.length === 0) continue; // entire group was split out individually
      console.warn(`[WavePlan Update] Group "${unassigned}" was not assigned, adding ${filteredSrvs.length} remaining server(s) to wave 1`);
      const targetWave = Math.min(1, numWaves);
      const meta = {};
      waveBuckets[targetWave].push({ name: unassigned, servers: filteredSrvs, serverCount: filteredSrvs.length, reason: "Auto-assigned (not in response)", tags: meta });
      assignedCount += filteredSrvs.length;
    }
  }

  // Rebuild timeline with validated durations
  const start = new Date(config.startDate || new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0]);
  const lzDesignW = config.lzDesignWeeks || wavePlanConfig.defaults.lzDesignWeeks || 4;
  const lzProvW = config.lzProvisionWeeks || wavePlanConfig.defaults.lzProvisionWeeks || 2;
  const waveDurW = config.waveDurationWeeks || wavePlanConfig.defaults.waveDurationWeeks || 2;
  const bufDays = config.bufferDays != null ? config.bufferDays : (wavePlanConfig.defaults.bufferDays || 3);
  const pilotW = config.pilotDurationWeeks || wavePlanConfig.defaults.pilotDurationWeeks || 8;

  console.log(`[WavePlan Update] Timeline config: lzDesign=${lzDesignW}w, lzProv=${lzProvW}w, pilot=${pilotW}w, waveDur=${waveDurW}w, buffer=${bufDays}d, numWaves=${numWaves}, assigned=${assignedCount}/${servers.length}`);

  const waves = [];
  const wave0Start = new Date(start);
  const wave0End = new Date(wave0Start.getTime() + (lzDesignW + lzProvW + pilotW) * 7 * 86400000);
  const wave0Groups = waveBuckets[0] || [];
  // Preserve any user-edited free-text fields across regen (same logic as
  // /generate). User edits to strategicIntent shouldn't be wiped when AI
  // re-runs the wave assignment.
  const priorIntents = new Map();
  for (const w of (session.wavePlan?.waves || [])) {
    if (w.strategicIntent) priorIntents.set(w.waveNumber, w.strategicIntent);
  }
  // Same per-server cost helper as /generate. Adds backup attribution.
  const serverWaveCost = (srv) => (srv.totalMonthlyCost || 0) + (srv.backupMonthlyCost || 0);
  const wave0Cost = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + serverWaveCost(srv), 0), 0);
  const wave0Backup = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.backupMonthlyCost || 0), 0), 0);

  waves.push({
    waveNumber: 0, name: "Wave 0 - Foundation & Pilot",
    startDate: wave0Start.toISOString().split("T")[0], endDate: wave0End.toISOString().split("T")[0],
    durationWeeks: lzDesignW + lzProvW + pilotW,
    phases: [{ label: "LZ Design", weeks: lzDesignW }, { label: "LZ Provisioning", weeks: lzProvW }, { label: "Pilot Migration", weeks: pilotW, groups: wave0Groups.map(g => g.name) }],
    groups: wave0Groups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName), reason: g.reason || "", tags: g.tags || {} })),
    totalServers: wave0Groups.reduce((s, g) => s + g.serverCount, 0),
    waveCost: round2(wave0Cost), waveBackup: round2(wave0Backup), cumulativeCost: round2(wave0Cost),
    strategicIntent: priorIntents.get(0) || "",
  });

  let cumCost = wave0Cost;
  let currentEnd = new Date(wave0End.getTime() + bufDays * 86400000);

  for (let i = 1; i <= numWaves; i++) {
    const waveGroups = waveBuckets[i] || [];
    const waveStart = new Date(currentEnd);
    const waveEnd = new Date(waveStart.getTime() + waveDurW * 7 * 86400000);
    const waveCost = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + serverWaveCost(srv), 0), 0);
    const waveBackup = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.backupMonthlyCost || 0), 0), 0);
    cumCost += waveCost;

    const waveServerCount = waveGroups.reduce((s, g) => s + g.serverCount, 0);
    const maxWaveVMs = waveDurW * (reqConfig?.waveThroughputPerWeek || wavePlanConfig.defaults.waveThroughputPerWeek || 30);
    const overCapacity = waveServerCount > maxWaveVMs;

    waves.push({
      waveNumber: i, name: `Wave ${i}`,
      startDate: waveStart.toISOString().split("T")[0], endDate: waveEnd.toISOString().split("T")[0],
      durationWeeks: waveDurW,
      groups: waveGroups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName), reason: g.reason || "", tags: g.tags || {} })),
      totalServers: waveServerCount,
      maxCapacity: maxWaveVMs,
      overCapacity,
      waveCost: round2(waveCost), waveBackup: round2(waveBackup), cumulativeCost: round2(cumCost),
      strategicIntent: priorIntents.get(i) || "",
    });
    currentEnd = new Date(waveEnd.getTime() + bufDays * 86400000);
  }

  // Generate capacity warning if any wave is overloaded
  let capacityWarning = null;
  const overWaves = waves.filter(w => w.overCapacity);
  if (overWaves.length > 0) {
    const worst = overWaves.reduce((a, b) => b.totalServers > a.totalServers ? b : a);
    capacityWarning = `⚠️ ${worst.name} has ${worst.totalServers} VMs but capacity is ${worst.maxCapacity} (${waveDurW} wks × ${reqConfig?.waveThroughputPerWeek || 30}/wk). Consider: increasing wave duration, adding more waves, or splitting constrained groups across multiple late waves.`;
  }

  session.wavePlan = { waves, config, capacityWarning };
  saveSessionToDisk(sessionId);
  res.json(session.wavePlan);
});

// Export wave plan as formatted XLSX
app.get("/api/waveplan/export-xlsx", (req, res) => {
  const { sessionId } = req.query;
  const session = sessions[sessionId];
  if (!session || !session.wavePlan) return res.status(404).json({ error: "No wave plan data." });

  const plan = session.wavePlan;
  const wb = XLSX.utils.book_new();

  // Helper: format date as DD-MM-YYYY
  const fmtDate = (isoStr) => {
    if (!isoStr) return "";
    const [y, m, d] = isoStr.split("-");
    return `${d}-${m}-${y}`;
  };

  // Sheet 1: Timeline Summary
  const timelineRows = plan.waves.map(w => ({
    "Wave": w.name,
    "Start Date": fmtDate(w.startDate),
    "End Date": fmtDate(w.endDate),
    "Duration (wks)": w.durationWeeks,
    "Total Servers": w.totalServers,
    "Max Capacity": w.maxCapacity || "",
    "Over Capacity": w.overCapacity ? "YES" : "",
    "Groups": w.groups.map(g => g.name).join(", "),
    "Strategic Intent": w.strategicIntent || "",
    "Wave Cost (USD/mo)": w.waveCost,
    "Of which Backup (USD/mo)": w.waveBackup || 0,
    "Cumulative Cost (USD/mo)": w.cumulativeCost,
  }));
  const ws1 = XLSX.utils.json_to_sheet(timelineRows);
  // Set column widths
  ws1["!cols"] = [
    { wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 60 }, { wch: 18 }, { wch: 22 }, { wch: 22 }
  ];
  // Wrap the Strategic Intent column so paragraphs render readably in Excel
  // (column index 8, 0-based). XLSX style hooks need explicit cell-level
  // settings — set wrapText on the column header + a generous default row
  // height by writing the cell-level alignment into each row's entry.
  ws1["!rows"] = ws1["!rows"] || [];
  for (let r = 0; r <= timelineRows.length; r++) {
    if (!ws1["!rows"][r]) ws1["!rows"][r] = {};
    if (r > 0) ws1["!rows"][r].hpx = 80; // give each data row ~80px height for wrap
  }
  XLSX.utils.book_append_sheet(wb, ws1, "Timeline");

  // Sheet 2: Server Assignments (detailed)
  const detailRows = [];
  for (const w of plan.waves) {
    for (const g of w.groups) {
      const servers = g.servers || [];
      for (const srv of servers) {
        detailRows.push({
          "Wave": w.name,
          "Wave #": w.waveNumber,
          "Start Date": fmtDate(w.startDate),
          "End Date": fmtDate(w.endDate),
          "Group": g.name,
          "Server": srv,
        });
      }
      if (!servers.length) {
        detailRows.push({ "Wave": w.name, "Wave #": w.waveNumber, "Start Date": fmtDate(w.startDate), "End Date": fmtDate(w.endDate), "Group": g.name, "Server": `(${g.serverCount} servers)` });
      }
    }
  }
  const ws2 = XLSX.utils.json_to_sheet(detailRows);
  ws2["!cols"] = [{ wch: 25 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 25 }, { wch: 30 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Server Assignments");

  // Sheet 3: Configuration & Throughput
  const configRows = [
    { "Parameter": "Start Date", "Value": fmtDate(plan.config.startDate) },
    { "Parameter": "LZ Design (weeks)", "Value": plan.config.lzDesignWeeks },
    { "Parameter": "LZ Provisioning (weeks)", "Value": plan.config.lzProvisionWeeks },
    { "Parameter": "Pilot Duration (weeks)", "Value": plan.config.pilotDurationWeeks },
    { "Parameter": "Migration Waves", "Value": plan.config.numWaves },
    { "Parameter": "Wave Duration (weeks)", "Value": plan.config.waveDurationWeeks },
    { "Parameter": "Buffer (days)", "Value": plan.config.bufferDays },
    { "Parameter": "Grouping Mode", "Value": plan.config.groupBy },
    { "Parameter": "Group Column", "Value": plan.config.groupColumn || "N/A" },
  ];
  if (plan.throughput) {
    configRows.push(
      { "Parameter": "", "Value": "" },
      { "Parameter": "--- Throughput ---", "Value": "" },
      { "Parameter": "Pilot Throughput (VMs/week)", "Value": plan.throughput.pilotThroughputPerWeek },
      { "Parameter": "Wave Throughput (VMs/week)", "Value": plan.throughput.waveThroughputPerWeek },
      { "Parameter": "Max Pilot VMs", "Value": plan.throughput.maxPilotVMs },
      { "Parameter": "Max VMs per Wave", "Value": plan.throughput.maxWaveVMs },
      { "Parameter": "Total Capacity", "Value": plan.throughput.totalCapacity },
    );
  }
  if (plan.capacityWarning) {
    configRows.push({ "Parameter": "", "Value": "" }, { "Parameter": "⚠ CAPACITY WARNING", "Value": plan.capacityWarning });
  }
  const ws3 = XLSX.utils.json_to_sheet(configRows);
  ws3["!cols"] = [{ wch: 30 }, { wch: 50 }];
  XLSX.utils.book_append_sheet(wb, ws3, "Configuration");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const customerName = (session.customerName || "export").replace(/[^a-zA-Z0-9_-]/g, "_");
  res.setHeader("Content-Disposition", `attachment; filename="WavePlan_${customerName}.xlsx"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// Update editable per-wave fields without re-running the full plan generator.
// Today this only handles 'strategicIntent' (free-text describing what the
// wave is meant to achieve), but the same shape can grow to include other
// editable fields (validation gates, regulatory hooks, etc.).
//
// Body: { sessionId, waveNumber, strategicIntent }
// Returns: { wave: <updated record> }
app.post("/api/waveplan/update-meta", (req, res) => {
  const { sessionId, waveNumber, strategicIntent } = req.body || {};
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found." });
  if (!session.wavePlan || !Array.isArray(session.wavePlan.waves)) {
    return res.status(400).json({ error: "Generate a wave plan first." });
  }
  const wave = session.wavePlan.waves.find(w => w.waveNumber === waveNumber);
  if (!wave) return res.status(404).json({ error: `Wave ${waveNumber} not found.` });
  if (typeof strategicIntent === "string") {
    // Cap at a reasonable length to keep BOM XLSX readable. Banking customers
    // tend to paste their full strategy paragraphs — 1500 chars is enough for
    // a couple of paragraphs and keeps the column from blowing out.
    wave.strategicIntent = strategicIntent.slice(0, 1500);
  }
  saveSessionToDisk(sessionId);
  res.json({ wave });
});

// LLM-assisted wave plan suggestion
app.post("/api/waveplan/llm-suggest", async (req, res) => {
  const { sessionId, numWaves, groupBy, groupColumn, userInstructions, lzDesignWeeks, lzProvisionWeeks, pilotDurationWeeks, waveDurationWeeks, bufferDays, startDate, pilotThroughputPerWeek, waveThroughputPerWeek } = req.body;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found. The server may have restarted — reload your saved session from the Setup panel, or re-upload the inventory." });
  if (!session.assessmentReport) return res.status(404).json({ error: "No assessment data. Run the VM Assessment (Step 3) first." });
  if (!llmHelper.isConfigured()) return res.status(400).json({ error: "LLM not configured." });

  const report = session.assessmentReport;
  // Same wave-plan scope filter as the rule-based path: L&S servers only.
  const servers = (report.servers || []).filter(s => !s.costExcluded && !s.costDeferredToDr);

  // ===== STEP 1: Run rule-based distribution first (this always works) =====
  const groups = {};
  for (const srv of servers) {
    let groupName;
    if (groupBy === "environment" && groupColumn === "__environment__") {
      groupName = srv.environment || "Unknown";
    } else if (groupColumn && srv.extraColumns && srv.extraColumns[groupColumn]) {
      groupName = srv.extraColumns[groupColumn];
    } else {
      groupName = srv.environment || "All";
    }
    if (!groups[groupName]) groups[groupName] = [];
    groups[groupName].push(srv);
  }

  // Server-name lookup (for server-level moves when groups are split by tag).
  const serverByName = {};
  for (const srv of servers) { serverByName[srv.serverName] = srv; }

  const envPriority = (wavePlanLogic.autoAssignment && wavePlanLogic.autoAssignment.environmentPriority) || {};
  const critPriority = (wavePlanLogic.autoAssignment && wavePlanLogic.autoAssignment.criticalityPriority) || {};

  function findPriorityHint(haystack, dict) {
    if (!haystack || !dict) return null;
    const lower = haystack.toLowerCase();
    let best = null;
    for (const [key, val] of Object.entries(dict)) {
      if (!key) continue;
      if (lower.includes(key.toLowerCase())) {
        if (best === null || val > best) best = val; // highest risk wins for a group
      }
    }
    return best;
  }

  const scoredGroups = Object.entries(groups).map(([name, srvs]) => {
    const haystackParts = [name, tierHaystackBoost(name, groupBy, groupColumn)];
    for (const srv of srvs) {
      if (srv && srv.environment) haystackParts.push(String(srv.environment));
      if (srv && srv.extraColumns) {
        for (const v of Object.values(srv.extraColumns)) {
          if (v != null && typeof v !== "object") haystackParts.push(String(v));
        }
      }
    }
    const haystack = haystackParts.join(" ");
    const envHint = findPriorityHint(haystack, envPriority);
    const critHint = findPriorityHint(haystack, critPriority);
    const envScore = envHint != null ? envHint : 3;
    const critScore = critHint != null ? critHint : 2;
    // Lower score = earlier wave. Production (envScore=5) naturally ends up last.
    const score = envScore + critScore + Math.log2(srvs.length + 1);
    return { name, servers: srvs, serverCount: srvs.length, score };
  });
  scoredGroups.sort((a, b) => (a.score - b.score) || (a.serverCount - b.serverCount));

  const totalMigrationWaves = numWaves || wavePlanConfig.defaults.numMigrationWaves || 3;
  const pilotThroughput = pilotThroughputPerWeek || wavePlanConfig.defaults.pilotThroughputPerWeek || 10;
  const waveThroughput = waveThroughputPerWeek || wavePlanConfig.defaults.waveThroughputPerWeek || 30;
  const pilotW = pilotDurationWeeks || wavePlanConfig.defaults.pilotDurationWeeks || 8;
  const waveDurW = waveDurationWeeks || wavePlanConfig.defaults.waveDurationWeeks || 2;
  const maxPilotVMs = pilotW * pilotThroughput;
  const maxWaveVMs = waveDurW * waveThroughput;

  // Assign pilot (wave 0) — fill up to throughput capacity
  const baseAssignment = {}; // groupName -> waveNumber
  const remaining = [...scoredGroups];
  const wave0Groups = [];
  let pilotCount = 0;

  // Keep adding lowest-risk groups until we hit pilot capacity
  while (remaining.length > 0 && pilotCount + remaining[0].serverCount <= maxPilotVMs) {
    const g = remaining.shift();
    wave0Groups.push(g);
    pilotCount += g.serverCount;
    baseAssignment[g.name] = 0;
  }
  // Ensure at least one group in pilot
  if (wave0Groups.length === 0 && remaining.length > 0) {
    const g = remaining.shift();
    wave0Groups.push(g);
    pilotCount = g.serverCount;
    baseAssignment[g.name] = 0;
  }

  // Distribute remaining across migration waves preserving risk order (industry practice:
  // production/critical groups land in later waves). See /api/waveplan/generate for the
  // detailed strategy — same logic applies here.
  const migrationBuckets = [];
  for (let i = 0; i < totalMigrationWaves; i++) migrationBuckets.push([]);

  if (remaining.length === 0) {
    // nothing to do
  } else if (remaining.length <= totalMigrationWaves) {
    // Few groups: one per wave, end-justified so highest-risk lands in the last wave.
    const offset = totalMigrationWaves - remaining.length;
    for (let i = 0; i < remaining.length; i++) {
      migrationBuckets[offset + i].push(remaining[i]);
      baseAssignment[remaining[i].name] = offset + i + 1;
    }
  } else {
    // Many groups: midpoint slicing, then eliminate empty waves by re-slicing adjacent ranges.
    const totalRemainingVMs = remaining.reduce((s, g) => s + g.serverCount, 0);
    const targetPerWave = totalRemainingVMs / totalMigrationWaves;
    let cumVMs = 0;
    for (const g of remaining) {
      const midpoint = cumVMs + g.serverCount / 2;
      let waveIdx = targetPerWave > 0 ? Math.floor(midpoint / targetPerWave) : 0;
      if (waveIdx >= totalMigrationWaves) waveIdx = totalMigrationWaves - 1;
      migrationBuckets[waveIdx].push(g);
      cumVMs += g.serverCount;
    }
    // Re-slice ranges containing empty waves
    const N = migrationBuckets.length;
    for (let pass = 0; pass < N; pass++) {
      let changed = false;
      for (let i = 0; i < N; i++) {
        if (migrationBuckets[i].length > 0) continue;
        let donorIdx = -1, donorCount = -1;
        for (let j = 0; j < N; j++) {
          if (j === i || migrationBuckets[j].length === 0) continue;
          const c = migrationBuckets[j].reduce((s, g) => s + g.serverCount, 0);
          if (c > donorCount) { donorCount = c; donorIdx = j; }
        }
        if (donorIdx === -1) break;
        const lo = Math.min(i, donorIdx);
        const hi = Math.max(i, donorIdx);
        const merged = [];
        for (let k = lo; k <= hi; k++) merged.push(...migrationBuckets[k]);
        if (merged.length < 2) continue;
        const total = merged.reduce((s, g) => s + g.serverCount, 0);
        const nRange = hi - lo + 1;
        const tgt = total / nRange;
        for (let k = lo; k <= hi; k++) migrationBuckets[k] = [];
        let cum = 0;
        for (const g of merged) {
          const mid = cum + g.serverCount / 2;
          let idx = lo + Math.floor(mid / tgt);
          if (idx > hi) idx = hi;
          if (idx < lo) idx = lo;
          migrationBuckets[idx].push(g);
          cum += g.serverCount;
        }
        changed = true;
      }
      if (!changed) break;
    }
    // Materialize baseAssignment from final bucket layout
    for (let i = 0; i < migrationBuckets.length; i++) {
      for (const g of migrationBuckets[i]) baseAssignment[g.name] = i + 1;
    }
  }

  console.log(`[WavePlan] Rule-based assignment:`, JSON.stringify(baseAssignment));

  // ===== STEP 2: Ask LLM for refinements based on user instructions =====
  // Collect metadata for each group. We do NOT hardcode any column names — every
  // categorical extra column the inventory provides is exposed to the LLM as a tag,
  // except hardware/infra columns that are not relevant to wave planning.
  const tagExcludePatterns = /^(cpu|cores|vcpu|ram|memory|disk|storage|manufacturer|model|serial|ip|mac|uuid|bios|firmware|os\s*version|os\s*type|kernel|hostname|fqdn|domain|size|capacity|speed|frequency|architecture|processor|nic|network.*adapter|interface|port|slot|power|height|rack|datacenter|physical|virtual|cluster|host)/i;
  const groupColLower = (groupColumn || "").toString().trim().toLowerCase();
  function isCandidateTagColumn(col) {
    if (!col) return false;
    const c = col.trim();
    if (tagExcludePatterns.test(c)) return false;
    // Exclude the column used as the group key itself (e.g. "Business Application")
    // because its value is just the group name and adds no signal.
    if (groupColLower && c.toLowerCase() === groupColLower) return false;
    return true;
  }
  const groupDescriptions = Object.entries(groups).map(([name, srvs]) => {
    const metadata = {};
    for (const srv of srvs) {
      if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (!isCandidateTagColumn(col)) continue;
          const val = srv.extraColumns[col];
          if (val == null || val === "") continue;
          if (!metadata[col]) metadata[col] = new Set();
          metadata[col].add(val);
        }
      }
      if (srv.environment) {
        if (!metadata["environment"]) metadata["environment"] = new Set();
        metadata["environment"].add(srv.environment);
      }
    }
    // Drop tags whose cardinality is too high to be useful as a grouping signal.
    for (const k of Object.keys(metadata)) {
      if (metadata[k].size > 50) delete metadata[k];
    }
    const metaStr = Object.entries(metadata).map(([col, vals]) => `${col}=[${[...vals].join(",")}]`).join(", ");
    return `- "${name}" (${srvs.length} servers, currently wave ${baseAssignment[name]})${metaStr ? ` | ${metaStr}` : ""}`;
  }).join("\n");

  // Build refinement prompt — much simpler job for the LLM
  const refinementPrompt = `I have a migration wave plan with ${totalMigrationWaves} migration waves (wave 0 = pilot, waves 1-${totalMigrationWaves} = migration).

Here is the current rule-based assignment:
${groupDescriptions}

The user has given these instructions: "${userInstructions}"

Based on the user's instructions, which groups/servers need to be MOVED to a different wave? 
Only return moves that are necessary to satisfy the user's instructions. If no moves are needed, return an empty array.

Return ONLY a JSON array of moves:
[{"group": "<exact group name from the list above>", "toWave": <integer>, "reason": "<short reason citing the matching tag/value>"}]

Rules:
- Use only group names that appear in the list above. Do not invent names.
- Match the user's instructions to groups by their tag values (e.g. any column they mention).
- Do not assume any specific tag vocabulary — different inventories use different conventions.
- Wave numbers must be integers between 0 and ${totalMigrationWaves}.
- "last wave" means wave ${totalMigrationWaves}.
- "first wave" means wave 1 (wave 0 is always pilot).
- Only move groups that match the user's criteria; otherwise return [].
- Return ONLY the JSON array, no other text.`;

  let moves = [];

  // Helper: extract JSON array from free-form LLM text
  function extractJsonArrayFromText(text) {
    if (!text || typeof text !== 'string') return null;
    // Try direct parse
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        const arr = Object.values(parsed).find(v => Array.isArray(v));
        if (arr) return arr;
      }
    } catch (e) {}
    // Regex: first top-level array or object
    const m = text.match(/(\[[\s\S]*?\]|\{[\s\S]*?\})/);
    if (m && m[0]) {
      try {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === 'object') {
          const arr = Object.values(parsed).find(v => Array.isArray(v));
          if (arr) return arr;
        }
      } catch (e) {}
    }
    // Try moves property
    const movesMatch = text.match(/"moves"\s*:\s*(\[[\s\S]*?\])/i);
    if (movesMatch && movesMatch[1]) {
      try { const parsed = JSON.parse(movesMatch[1]); if (Array.isArray(parsed)) return parsed; } catch (e) {}
    }
    return null;
  }

  try {
    // Call LLM and capture raw response for robust parsing
    let rawResponse = await llmHelper.call(
      "You are a migration planning assistant. Your job is to interpret the user's instructions and determine which server groups need to be moved to different waves. Return ONLY a JSON array of moves. If no moves needed, return []. NEVER ask questions.",
      refinementPrompt,
      { maxTokens: 4000, timeout: 120000 }
    );
    rawResponseText = (typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse));

    // Log raw response for debugging
    try {
      console.log(`[WavePlan] Raw LLM response (initial, truncated):`, rawResponseText.substring(0, 4000));
    } catch (e) { /* ignore logging issues */ }

    // Parsed response may already be an array/object
    if (Array.isArray(rawResponse)) moves = rawResponse;
    else if (rawResponse && typeof rawResponse === 'object') {
      const arrProp = Object.values(rawResponse).find(v => Array.isArray(v));
      if (arrProp) moves = arrProp;
      else {
        const asText = JSON.stringify(rawResponse);
        const extracted = extractJsonArrayFromText(asText);
        if (extracted) moves = extracted;
      }
    } else if (typeof rawResponse === 'string') {
      const extracted = extractJsonArrayFromText(rawResponse);
      if (extracted) moves = extracted;
    }

    console.log(`[WavePlan] LLM suggested ${moves.length} moves after parsing:`, JSON.stringify(moves));
  } catch (err) {
    console.warn(`[WavePlan] LLM refinement failed (using rule-based): ${err && err.message ? err.message : err}`);
    if (err && err.stack) console.warn(err.stack);
  }

  // ===== STEP 3: Apply LLM moves on top of rule-based assignment =====
  const finalAssignment = { ...baseAssignment };
  const groupMeta = {};

  // Populate groupMeta with all categorical tags discovered from the inventory.
  // We do NOT hardcode any column names — every extra column that is not a hardware/infra
  // attribute is treated as a customer-defined tag the LLM can use for matching.
  for (const [name, srvs] of Object.entries(groups)) {
    const tags = {};
    for (const srv of srvs) {
      if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (!isCandidateTagColumn(col)) continue;
          const val = srv.extraColumns[col];
          if (val == null || val === "") continue;
          if (!tags[col]) tags[col] = new Set();
          tags[col].add(val);
        }
      }
      if (srv.environment) {
        if (!tags["environment"]) tags["environment"] = new Set();
        tags["environment"].add(srv.environment);
      }
    }
    // Drop high-cardinality tags (e.g. server names) that aren't useful for grouping.
    for (const k of Object.keys(tags)) {
      if (tags[k].size > 50) delete tags[k];
    }
    const flatTags = {};
    for (const [k, v] of Object.entries(tags)) { flatTags[k.toLowerCase()] = [...v].join(", "); }
    groupMeta[name] = { reason: "", tags: flatTags };
  }

  // Build case-insensitive lookup for group matching
  const groupsLower = {};
  for (const key of Object.keys(groups)) { groupsLower[key.toLowerCase().trim()] = key; }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function matchGroupMetaToText(text, meta) {
    if (!text || !meta || !meta.tags) return false;
    const lowerText = text.toString().toLowerCase();

    for (const [tagKey, rawTagValue] of Object.entries(meta.tags)) {
      const key = (tagKey || "").toString().toLowerCase().trim();
      const rawValue = (rawTagValue || "").toString().toLowerCase().trim();
      if (!rawValue) continue;

      // Values may be comma-joined lists from multiple servers in the group; check each.
      const valueParts = rawValue.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
      const keyTokens = key.split(/\W+/).filter(Boolean);

      for (const value of valueParts) {
        if (!value) continue;
        const escapedValue = escapeRegExp(value);

        // (a) Phrase match: full key adjacent to value, e.g. "system tier 1" or "1 system tier".
        if (key && (lowerText.includes(`${key} ${value}`) || lowerText.includes(`${value} ${key}`))) {
          return true;
        }

        // (b) Key-token + value, with or without space, e.g. "tier1", "tier 1", "tier-1".
        //     Requires at least one significant key token (>=3 chars) so we don't
        //     match generic prepositions/articles.
        for (const kt of keyTokens) {
          if (!kt || kt.length < 3) continue;
          const reConcat = new RegExp(`\\b${escapeRegExp(kt)}[\\s\\-_]*${escapedValue}(?![a-z0-9])`, "i");
          if (reConcat.test(lowerText)) {
            return true;
          }
        }

        // (c) Whole-word match of the value alone, but only for values long enough
        //     to be unambiguous (>=3 chars). Skips bare digits like "1"/"2"/"+".
        if (value.length >= 3) {
          const reWhole = new RegExp(`\\b${escapedValue}\\b`, "i");
          if (reWhole.test(lowerText)) {
            return true;
          }
        }
      }
    }
    return false;
  }

  // Helper: resolve move.group text to one or more actual group names.
  function resolveMoveTargets(groupText) {
    if (!groupText) return [];
    const txt = (groupText || "").toString().trim();
    if (!txt) return [];
    // Exact name match
    if (groups[txt]) return [txt];
    const lookup = groupsLower[txt.toLowerCase()];
    if (lookup) return [lookup];

    const lower = txt.toLowerCase();
    const results = new Set();

    for (const [gName, meta] of Object.entries(groupMeta)) {
      if (matchGroupMetaToText(lower, meta)) {
        results.add(gName);
      }
    }
    if (results.size) return [...results];

    // Fallback: substring match against group names
    for (const gName of Object.keys(groups)) {
      if (gName.toLowerCase().includes(lower)) results.add(gName);
    }
    return [...results];
  }

  // Apply moves. The LLM may target multiple groups if its move references a tag value
  // (e.g. any customer-defined tag). resolveMoveTargets() handles that mapping generically.
  const movedGroupNames = new Set();
  const movedServerNames = new Set();

  // Extract concrete (tagKey, tagValue) filters that the user's instruction references.
  // We enumerate every distinct (key, value) pair found in the inventory and test it
  // against the same matching rules used for groups. This way "Tier 1 last wave" yields
  // {key: "system tier", value: "1"} and we can split heterogeneous groups per server.
  function extractTagFiltersFromInstructions(text) {
    const lower = (text || "").toString().toLowerCase();
    const filters = [];
    if (!lower) return filters;
    const seen = new Set();
    for (const meta of Object.values(groupMeta)) {
      if (!meta || !meta.tags) continue;
      for (const [k, joinedV] of Object.entries(meta.tags)) {
        const key = (k || "").toLowerCase().trim();
        if (!key) continue;
        const keyTokens = key.split(/\W+/).filter(t => t && t.length >= 3);
        for (const part of String(joinedV || "").split(/\s*,\s*/)) {
          const value = part.trim().toLowerCase();
          if (!value) continue;
          const id = `${key}::${value}`;
          if (seen.has(id)) continue;
          const escapedValue = escapeRegExp(value);
          let hit = false;
          if (lower.includes(`${key} ${value}`) || lower.includes(`${value} ${key}`)) hit = true;
          if (!hit) {
            for (const kt of keyTokens) {
              const re = new RegExp(`\\b${escapeRegExp(kt)}[\\s\\-_]*${escapedValue}(?![a-z0-9])`, "i");
              if (re.test(lower)) { hit = true; break; }
            }
          }
          if (!hit && value.length >= 3) {
            const re = new RegExp(`\\b${escapedValue}\\b`, "i");
            if (re.test(lower)) hit = true;
          }
          if (hit) { filters.push({ key, value }); seen.add(id); }
        }
      }
    }
    return filters;
  }

  // True if the server's tags satisfy ANY of the supplied {key, value} filters.
  function serverMatchesAnyFilter(srv, filters) {
    if (!filters || !filters.length) return false;
    for (const f of filters) {
      let val = null;
      if (f.key === "environment") {
        val = srv.environment;
      } else if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (col.toLowerCase() === f.key) { val = srv.extraColumns[col]; break; }
        }
      }
      if (val == null) continue;
      if (String(val).toLowerCase().trim() === f.value) return true;
    }
    return false;
  }

  // Apply a tag-driven directive ("last wave" or "first wave") by splitting groups:
  //  - If ALL servers in a group match the filter set, queue a whole-group move.
  //  - If only SOME match, queue server-level moves so we don't displace unrelated servers.
  function applyTagDirective(directiveLabel, targetWave) {
    const filters = extractTagFiltersFromInstructions(instructionText);
    if (filters.length === 0) {
      console.log(`[WavePlan] ${directiveLabel}: no tag filters extracted from instruction; skipping fallback.`);
      return;
    }
    console.log(`[WavePlan] ${directiveLabel}: tag filters extracted ->`, JSON.stringify(filters));
    let wholeGroupMoves = 0;
    let serverMoves = 0;
    for (const [gName, srvs] of Object.entries(groups)) {
      const matching = srvs.filter(s => serverMatchesAnyFilter(s, filters));
      if (matching.length === 0) continue;
      if (matching.length === srvs.length) {
        if (!moves.some(m => m.group === gName)) {
          moves.push({ group: gName, toWave: targetWave, reason: `${directiveLabel} (all ${srvs.length} servers match filter)` });
          wholeGroupMoves++;
        }
      } else {
        for (const s of matching) {
          if (!moves.some(m => m.group === s.serverName)) {
            moves.push({ group: s.serverName, toWave: targetWave, reason: `${directiveLabel} (server matches tag filter; group "${gName}" stays put for non-matching servers)` });
            serverMoves++;
          }
        }
      }
    }
    console.log(`[WavePlan] ${directiveLabel}: queued ${wholeGroupMoves} whole-group move(s) and ${serverMoves} server-level move(s).`);
  }

  const instructionText = (userInstructions || "").toString().toLowerCase();
  const isLastWaveDirective = /(last\s+wave|last\s+waves|final\s+wave|final\s+phase|end\s+wave|later\s+wave|move.*last|put.*last|push.*end|delay.*end|delay.*last|defer.*last)/.test(instructionText);
  const isFirstWaveDirective = /(first\s+wave|wave\s*0|wave\s*zero|pilot\s+wave|pilot\s+phase|early\s+wave|to\s+pilot|in\s+pilot|move.*first|put.*first|move.*pilot|put.*pilot)/.test(instructionText);

  if (isLastWaveDirective) {
    applyTagDirective("last-wave", totalMigrationWaves);
  }
  if (isFirstWaveDirective) {
    applyTagDirective("first-wave", 0);
  }

  // If moves are empty or ambiguous (hints instead of exact group names), ask the LLM to refine
  const isAmbiguous = (!moves || moves.length === 0) || moves.some(m => {
    try { return resolveMoveTargets(m.group).length !== 1; } catch { return true; }
  });

  if (isAmbiguous && llmHelper.isConfigured()) {
    try {
      // Build explicit group list with tags to give the LLM exact choices
      const groupsList = Object.keys(groupMeta).map(name => {
        const tags = groupMeta[name].tags || {};
        const tagStr = Object.entries(tags).map(([k, v]) => `${k}=${v}`).join(", ");
        return `- "${name}" | ${tagStr}`;
      }).join("\n");

      const refinePrompt2 = `You are a migration planning assistant. The user gave free-text instructions: "${userInstructions}".\n` +
        `We have the following groups (name and tags):\n${groupsList}\n` +
        `Earlier you returned: ${JSON.stringify(moves || [])} .\n` +
        `Now, MAP any hints or tags from the user's instructions to the EXACT group NAMES above and RETURN ONLY a JSON array of moves in the form:` +
        `[ { "group": "Exact Group Name", "toWave": 0-` + totalMigrationWaves + `, "reason": "explain briefly" } ]\n` +
        `Rules: use only group names from the list above (do not invent names), ensure group names match exactly (including punctuation), wave numbers must be integers between 0 and ${totalMigrationWaves}, and return only the JSON array.`;

      // Call refinement LLM and robustly parse result (log raw text for debugging)
      const refinedRaw = await llmHelper.call(
        "You are a strict JSON-output assistant. Map hints to exact group names from the provided list and output only a JSON array of moves.",
        refinePrompt2,
        { maxTokens: 2000, timeout: 120000 }
      );

      refinedRawText = (typeof refinedRaw === 'string' ? refinedRaw : JSON.stringify(refinedRaw));
      try {
        console.log(`[WavePlan] Raw LLM refinement response (truncated):`, refinedRawText.substring(0, 4000));
      } catch (e) {}

      if (Array.isArray(refinedRaw)) {
        moves = refinedRaw;
      } else if (refinedRaw && typeof refinedRaw === 'object') {
        const arr = Object.values(refinedRaw).find(v => Array.isArray(v));
        if (Array.isArray(arr) && arr.length > 0) moves = arr;
        else {
          const asText = JSON.stringify(refinedRaw);
          const extracted = extractJsonArrayFromText(asText);
          if (extracted) moves = extracted;
        }
      } else if (typeof refinedRaw === 'string') {
        const extracted = extractJsonArrayFromText(refinedRaw);
        if (extracted) moves = extracted;
      }

      if (moves && moves.length > 0) console.log(`[WavePlan] LLM refinement returned ${moves.length} moves after parsing.`);
    } catch (err) {
      console.warn(`[WavePlan] LLM refinement failed: ${err.message}`);
      // fall back to original moves (may be empty)
    }
  }

  // If debug requested, persist raw/refined responses now (we have variables in-scope)
  if (req.body && req.body.debugRaw) {
    try {
      const dump = {
        timestamp: new Date().toISOString(),
        rawResponse: rawResponseText || null,
        refinedResponse: refinedRawText || null,
        movesParsed: moves || [],
        prompt: refinementPrompt,
      };
      // Persist to in-memory session for retrieval via debug endpoint
      if (session) session.lastLLM = dump;
      console.log(`[WavePlan] Debug LLM dump attached to session: ${sessionId}`);
    } catch (e) {
      console.warn(`[WavePlan] Failed to write debug LLM dump: ${e.message}`);
      debugFilePath = null;
    }
  }

  // Now apply moves to resolved targets
  for (const move of moves || []) {
    if (!move.group || move.toWave === undefined) continue;
    const toWave = Math.max(0, Math.min(totalMigrationWaves, parseInt(move.toWave) || 0));

    // Server-level move (matches an exact server name) — used when a group was split.
    if (serverByName[move.group]) {
      finalAssignment[move.group] = toWave;
      movedServerNames.add(move.group);
      // Carry an inline tag snapshot for that single server so the UI can show it.
      const srv = serverByName[move.group];
      const tags = {};
      if (srv.environment) tags["environment"] = srv.environment;
      if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (!isCandidateTagColumn(col)) continue;
          const v = srv.extraColumns[col];
          if (v != null && v !== "") tags[col.toLowerCase()] = String(v);
        }
      }
      groupMeta[move.group] = { reason: move.reason || "", tags };
      console.log(`[WavePlan] Moved server "${move.group}" → wave ${toWave} (${move.reason})`);
      continue;
    }

    const targets = resolveMoveTargets(move.group);
    if (!targets || targets.length === 0) {
      console.warn(`[WavePlan] LLM suggested moving "${move.group}" but no matching group(s) found`);
      continue;
    }
    for (const actualName of targets) {
      finalAssignment[actualName] = toWave;
      movedGroupNames.add(actualName);
      if (!groupMeta[actualName]) groupMeta[actualName] = { reason: "", tags: {} };
      groupMeta[actualName].reason = move.reason || `Moved from wave ${baseAssignment[actualName] || 'N/A'} → ${toWave}`;
      console.log(`[WavePlan] Moved "${actualName}" from wave ${baseAssignment[actualName] || 'N/A'} → wave ${toWave} (${move.reason})`);
    }
  }

  // ===== STEP 4: Rebalance non-constrained groups after moves =====
  // Identify which groups were moved (hard constraints) vs not moved (soft, rebalanceable)

  if (movedGroupNames.size > 0 || movedServerNames.size > 0) {
    // Separate constrained vs soft groups
    const constrainedWaveLoads = {}; // waveNum -> total server count from constrained groups/servers
    const softGroups = []; // groups that can be rebalanced

    for (const [name, wave] of Object.entries(finalAssignment)) {
      if (movedServerNames.has(name)) {
        // Server-level constraint — stays where it was placed.
        constrainedWaveLoads[wave] = (constrainedWaveLoads[wave] || 0) + 1;
        continue;
      }
      if (!groups[name]) continue; // unknown / orphan
      // Effective server count: subtract any servers from this group that were split out.
      const splitOut = groups[name].filter(s => movedServerNames.has(s.serverName)).length;
      const effectiveCount = groups[name].length - splitOut;
      if (effectiveCount <= 0) continue; // entire group split out; nothing left to schedule
      if (movedGroupNames.has(name)) {
        constrainedWaveLoads[wave] = (constrainedWaveLoads[wave] || 0) + effectiveCount;
      } else {
        softGroups.push({ name, serverCount: effectiveCount });
      }
    }

    // Redistribute soft groups across all waves, considering constrained loads
    // Target: balance total VMs per wave as evenly as possible
    const totalSoftVMs = softGroups.reduce((s, g) => s + g.serverCount, 0);
    const idealPerWave = Math.ceil(totalSoftVMs / (totalMigrationWaves + 1)); // +1 for wave 0

    // Sort soft groups by size descending for best-fit packing
    softGroups.sort((a, b) => b.serverCount - a.serverCount);

    // Calculate available space per wave (total target minus constrained load)
    const waveLoads = {};
    for (let i = 0; i <= totalMigrationWaves; i++) {
      waveLoads[i] = constrainedWaveLoads[i] || 0;
    }

    // Greedy assignment: put each soft group in the wave with the least total load
    for (const g of softGroups) {
      // Find wave with minimum current load (prefer non-zero waves if possible to leave pilot light)
      let bestWave = 1;
      let bestLoad = Infinity;
      for (let i = 0; i <= totalMigrationWaves; i++) {
        // Slightly penalize wave 0 to keep pilot lighter
        const effectiveLoad = waveLoads[i] + (i === 0 ? idealPerWave * 0.3 : 0);
        if (effectiveLoad < bestLoad) {
          bestLoad = effectiveLoad;
          bestWave = i;
        }
      }
      finalAssignment[g.name] = bestWave;
      waveLoads[bestWave] += g.serverCount;
    }

    // Log rebalanced distribution (uses effective counts: server-level entries count as 1,
    // group-level entries subtract any split-out servers).
    const waveSummary = {};
    for (const [name, wave] of Object.entries(finalAssignment)) {
      let count;
      if (movedServerNames.has(name)) count = 1;
      else if (groups[name]) count = groups[name].filter(s => !movedServerNames.has(s.serverName)).length;
      else count = 0;
      waveSummary[wave] = (waveSummary[wave] || 0) + count;
    }
    console.log(`[WavePlan] Rebalanced distribution:`, JSON.stringify(waveSummary));
  }

  // Build response in format expected by /api/waveplan/update
  const responsePayload = { assignments: finalAssignment, groupMeta, moves, baseAssignment };
  // If client requested debugRaw, include raw LLM text for debugging
  if (req.body && req.body.debugRaw) {
    try {
      // Persist raw responses to a debug file for full inspection (avoids JSON serialization issues)
      try {
        const debugDir = SESSIONS_DIR;
        const debugPath = path.join(debugDir, `${sessionId}_llm_raw.txt`);
        const dump = {
          timestamp: new Date().toISOString(),
          rawResponse: rawResponseText || null,
          refinedResponse: typeof refinedRawText !== 'undefined' ? refinedRawText : null,
          movesParsed: moves || [],
        };
        fs.writeFileSync(debugPath, JSON.stringify(dump, null, 2), 'utf-8');
        responsePayload._debug = { debugFile: debugPath };
      } catch (e) {
        responsePayload._debug = { error: 'failed to persist raw debug file' };
      }
    } catch (e) {
      responsePayload._debug = { error: 'failed to attach raw debug texts' };
    }
  }
  res.json(responsePayload);
});

// Debug: retrieve last LLM dump for a session
app.get('/api/waveplan/llm-debug/:sessionId', (req, res) => {
  const s = sessions[req.params.sessionId];
  if (!s) return res.status(404).json({ error: 'session not found' });
  if (!s.lastLLM) return res.status(404).json({ error: 'no llm dump available for this session' });
  res.json(s.lastLLM);
});

// ============ XLSX EXPORT ENDPOINTS ============

// Assessment Report Excel (.xlsx) — proper multi-sheet workbook
app.post("/api/export/assessment-xlsx", (req, res) => {
  const { sessionId, customerName, assessmentName, region, environments, envConfigs, envReports, envCounts } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport) return res.status(404).json({ error: "No assessment data found." });

  const report = session.assessmentReport;
  const s = report.summary;
  const pricingLabels = { "payg": "Pay As You Go", "1yr_ri": "1 Yr RI", "3yr_ri": "3 Yr RI", "spot": "Spot" };

  // Sheet 1: Cost Summary
  const ds = report.deferredSummary || { totalServers: 0, totalMonthlyCost: 0 };
  const xs = report.excludedSummary || { totalServers: 0 };
  const summaryData = [
    ["Assessment Report - " + (customerName || "Customer")],
    [],
    ["Assessment Name", assessmentName || "Assessment"],
    ["Customer", customerName || ""],
    ["Target Region", region || ""],
    ["Total Servers Sized", s.totalServers],
    ["  of which Priced as Lift & Shift", Math.max(0, (s.totalServers || 0) - (ds.totalServers || 0))],
    ["  of which Deferred to DR Strategy", ds.totalServers || 0],
    ["Servers excluded from sizing", xs.totalServers || 0],
    [],
    ["Monthly Compute (USD) — L&S only", s.totalMonthlyCompute],
    ["Monthly Storage (USD) — L&S only", s.totalMonthlyStorage],
    ["Monthly Security (USD) — L&S only", s.totalMonthlySecurity],
    ["Total Monthly Lift & Shift (USD)", s.totalMonthlyCost],
    ["Deferred to DR Strategy / mo (USD)", ds.totalMonthlyCost || 0],
    ["Total Annual Lift & Shift (USD)", s.totalAnnualCost],
    [],
    ["Pricing Configuration per Environment"],
    ["Environment", "Servers", "Pricing Model", "License", "Cost Treatment"],
  ];
  for (const env of (environments || ["All"])) {
    const config = (envConfigs && envConfigs[env]) || {};
    const count = (envReports && envReports[env] && envReports[env].totalServers) || (envCounts && envCounts[env]) || 0;
    const treatment = config.costMode === "dr-defer" ? "Deferred to DR Strategy"
      : config.costMode === "exclude" ? "Excluded from sizing"
      : "Lift & Shift";
    summaryData.push([env, count, pricingLabels[config.pricingModel] || config.pricingModel || "N/A", config.useAhub ? "AHUB" : "PAYG", treatment]);
  }

  // Sheet 2: Server Recommendations
  // Application column is auto-detected so it carries over from any inventory format.
  // Tier column comes from the user's DR Strategy choice (Step 5) and falls back to
  // common patterns when DR Strategy hasn't been run yet — that way the export still
  // shows tier when the customer organised their inventory by it.
  const appCol = pickApplicationColumn(report.servers);
  let tierCol = session.drStrategy?.column || null;
  if (!tierCol) {
    const allCols = new Set();
    for (const s of report.servers) if (s.extraColumns) for (const k of Object.keys(s.extraColumns)) allCols.add(k);
    const tierCandidates = ["System Tier", "Tier", "App Tier", "Server Tier", "Classification", "Criticality", "Business Criticality"];
    for (const c of tierCandidates) {
      const hit = [...allCols].find(k => k.toLowerCase() === c.toLowerCase());
      if (hit) { tierCol = hit; break; }
    }
  }
  const serverHeaders = ["Server Name", "Environment", "Application", "Tier", "Cost Treatment", "OS", "OS Version", "Cores", "RAM (GB)", "Recommended VM", "VM Cores", "VM RAM (GB)", "Disks", "Compute/mo (USD)", "Storage/mo (USD)", "Backup/mo (USD)", "Total Run-Rate/mo (USD)", "Suitability", "LLM Reason"];
  const serverData = [serverHeaders];
  for (const srv of report.servers) {
    const treatment = srv.costExcluded ? "Excluded"
      : srv.costDeferredToDr ? "Deferred to DR"
      : "Lift & Shift";
    const backup = srv.backupMonthlyCost || 0;
    const totalWithBackup = (srv.totalMonthlyCost || 0) + backup;
    const application = appCol ? ((srv.extraColumns || {})[appCol] || "") : "";
    const tier = tierCol ? ((srv.extraColumns || {})[tierCol] || "") : "";
    serverData.push([
      srv.serverName || "",
      srv.environment || "",
      application,
      tier,
      treatment,
      srv.osName || "",
      srv.osVersion || "",
      srv.cores || 0,
      srv.memoryMB ? +(srv.memoryMB / 1024).toFixed(1) : 0,
      srv.recommendedVm || "",
      srv.vmCores || "",
      srv.vmMemoryMB ? +(srv.vmMemoryMB / 1024).toFixed(1) : "",
      (srv.diskDetails || []).map(d => d.azureTier + "(" + d.sourceSizeGB + "GB)").join("; "),
      +(srv.computeMonthlyCost || 0).toFixed(2),
      +(srv.storageMonthlyCost || 0).toFixed(2),
      +backup.toFixed(2),
      +totalWithBackup.toFixed(2),
      srv.suitability || "",
      srv.llmReason || "",
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  ws1["!cols"] = [{ wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 15 }, { wch: 24 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Cost Summary");

  const ws2 = XLSX.utils.aoa_to_sheet(serverData);
  ws2["!cols"] = [{ wch: 25 }, { wch: 12 }, { wch: 22 }, { wch: 10 }, { wch: 18 }, { wch: 28 }, { wch: 14 }, { wch: 6 }, { wch: 9 }, { wch: 22 }, { wch: 8 }, { wch: 10 }, { wch: 40 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 18 }, { wch: 15 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Server Recommendations");

  // OS License Summary sheet — one row per distinct (OS, OS Version) pair, with
  // total servers, total cores, classification (Windows/SQL/Linux), support
  // status (out of support / extended / supported / unknown) and per-env split.
  const osAgg = aggregateOsLicenses(report.servers);
  if (osAgg.rows.length > 0) {
    const osHeaders = ["OS Name (from inventory)", "OS Version", "License Type", "Support Status", "L&S Compatibility", "OS Path Options", "Customer Action Required", "Total Servers", "Total Cores", ...osAgg.envs];
    const osData = [osHeaders];
    for (const r of osAgg.rows) {
      const envCounts = osAgg.envs.map(e => r.byEnv[e] || "");
      osData.push([r.osName, r.osVersion, r.kind, r.supportStatus, r.lnsCompatible, r.osPathOptions, r.customerAction, r.totalServers, r.totalCores, ...envCounts]);
    }
    // Totals row
    const grandServers = osAgg.rows.reduce((a, r) => a + r.totalServers, 0);
    const grandCores = osAgg.rows.reduce((a, r) => a + r.totalCores, 0);
    const envTotals = osAgg.envs.map(e => osAgg.rows.reduce((a, r) => a + (r.byEnv[e] || 0), 0));
    osData.push([]);
    osData.push(["Total", "", "", "", "", "", "", grandServers, grandCores, ...envTotals]);
    const wsOs = XLSX.utils.aoa_to_sheet(osData);
    wsOs["!cols"] = [{ wch: 38 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 36 }, { wch: 60 }, { wch: 70 }, { wch: 14 }, { wch: 12 }, ...osAgg.envs.map(() => ({ wch: 12 }))];
    XLSX.utils.book_append_sheet(wb, wsOs, "OS License Summary");
  }

  // Sheet 3 (optional): Application Pairing — shows DR coverage by Business App.
  const pairing = report.applicationPairing;
  if (pairing && pairing.column && pairing.apps && pairing.apps.length > 0) {
    const pairData = [[`Application pairing key: ${pairing.column}`], [], ["Business Application", "Total", "Prod", "UAT", "DR", "Other"]];
    for (const app of pairing.apps) {
      let prod = 0, uat = 0, dr = 0, other = 0;
      for (const sv of (app.servers || [])) {
        const e = (sv.env || "").toLowerCase();
        if (/^prod/.test(e)) prod++;
        else if (/^uat/.test(e)) uat++;
        else if (/^dr|disaster/.test(e)) dr++;
        else other++;
      }
      pairData.push([app.name, app.total, prod || "", uat || "", dr || "", other || ""]);
    }
    if ((pairing.unpairedDr || []).length > 0) {
      pairData.push([]);
      pairData.push(["Unpaired DR apps (no Prod/UAT twin):"]);
      for (const u of pairing.unpairedDr) pairData.push([u.app, "", "", "", u.drCount]);
    }
    const wsP = XLSX.utils.aoa_to_sheet(pairData);
    wsP["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }, { wch: 8 }];
    XLSX.utils.book_append_sheet(wb, wsP, "Application Pairing");
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `${customerName || "Customer"}_${assessmentName || "Assessment"}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
});

// BOM Excel (.xlsx)
app.post("/api/export/bom-xlsx", (req, res) => {
  const { sessionId, customerName, region, environments, envConfigs, envCounts, envReports, bomItems, step5Snapshot, perServerBackup } = req.body;
  // bomItems: [{label, value}]
  const pricingLabels = { "payg": "Pay As You Go", "1yr_ri": "1 Yr RI", "3yr_ri": "3 Yr RI", "spot": "Spot" };
  const session = sessionId ? sessions[sessionId] : null;

  // Backup attribution lives in the browser (calculateBackupCost) and never
  // makes it to the session. Stamp the client-supplied per-server backup map
  // onto every server we see (combined + per-env) so the Per-Server BOM and
  // any other downstream consumer sees real numbers.
  if (session && perServerBackup && typeof perServerBackup === "object") {
    const stamp = (srv) => {
      if (!srv || !srv.serverName) return;
      const v = Number(perServerBackup[srv.serverName]);
      if (Number.isFinite(v) && v > 0) srv.backupMonthlyCost = v;
    };
    for (const srv of (session.assessmentReport?.servers || [])) stamp(srv);
    for (const env of Object.values(session.envAssessments || {})) {
      for (const srv of (env.report?.servers || [])) stamp(srv);
    }
  }

  const data = [
    ["Bill of Materials (BOM)"],
    ["Customer", customerName || ""],
    ["Region", region || ""],
    [],
  ];

  // Server reconciliation block — keeps procurement honest by showing where
  // every inventory server ended up. Surfaces unaccounted servers (typically
  // duplicate hostnames or blank-env rows that fell into 'Unknown' env).
  const recon = session?.assessmentReport?.reconciliation;
  if (recon && recon.inventoryCount > 0) {
    const lnsPriced = Math.max(0, (recon.lnsCount || 0) - (recon.deferredCount || 0));
    data.push(["Server Reconciliation"]);
    data.push(["Inventory rows", recon.inventoryCount]);
    data.push(["Total Sized", recon.lnsCount]);
    data.push(["  Priced as Lift & Shift", lnsPriced]);
    data.push(["  Deferred to DR Strategy (priced via DR Strategy section)", recon.deferredCount]);
    data.push(["Excluded from sizing", recon.excludedCount]);
    if (recon.unaccountedCount > 0) {
      data.push(["⚠ Unaccounted (review)", recon.unaccountedCount, "Likely fell into 'Unknown' env from blank/duplicate hostnames. Re-upload inventory to reconcile."]);
    }
    data.push([]);
  }

  data.push(["Pricing Configuration per Environment"]);
  data.push(["Environment", "Servers", "Pricing Model", "License", "Cost Treatment", "Win Cores BYOL", "SQL Cores BYOL", "Other OS Cores"]);
  for (const env of (environments || ["All"])) {
    const config = (envConfigs && envConfigs[env]) || {};
    const count = (envReports && envReports[env] && envReports[env].totalServers) || (envCounts && envCounts[env]) || 0;
    const treatment = config.costMode === "dr-defer" ? "Deferred to DR Strategy"
      : config.costMode === "exclude" ? "Excluded from sizing"
      : "Lift & Shift";
    const lic = session ? computeLicenseCoresFromSession(session, env, config) : { winCores: 0, sqlCores: 0, linuxCores: 0 };
    // AHUB-off explicitly bundles the Win licence into Azure compute so BYOL = 0.
    // When useAhub is undefined (e.g. frontend didn't restore config after session
    // reload), default to AHUB-on so the Win cores still show — better to overshoot
    // (procurement gets a number) than zero out silently.
    const useAhubEffective = config.useAhub !== false;
    data.push([
      env, count,
      pricingLabels[config.pricingModel] || config.pricingModel || "N/A",
      useAhubEffective ? "AHUB" : "Azure-included",
      treatment,
      useAhubEffective ? lic.winCores : 0,
      lic.sqlCores,
      lic.linuxCores,
    ]);
  }
  data.push([]);
  data.push(["Items", "Cores (BYOL)", "Rate ($/mo)", "Cost per Month (USD)"]);
  for (const item of (bomItems || [])) {
    // Items with `cores` are licence rows: render Cores | Rate | Total.
    // The frontend leaves Rate blank when pre-sales hasn't entered a number
    // so procurement sees an empty cell to fill, not a misleading $0.
    if (Object.prototype.hasOwnProperty.call(item, "cores")) {
      const rate = item.value;
      const rateNum = typeof rate === "number" ? rate : parseFloat(rate);
      const cores = Number(item.cores) || 0;
      const monthly = Number.isFinite(rateNum) && cores > 0 ? round2(rateNum * cores) : (Number.isFinite(rateNum) ? rateNum : "");
      data.push([item.label, cores || "", Number.isFinite(rateNum) ? rateNum : "", monthly]);
    } else {
      data.push([item.label, "", "", item.value]);
    }
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [{ wch: 50 }, { wch: 14 }, { wch: 14 }, { wch: 22 }, { wch: 24 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
  XLSX.utils.book_append_sheet(wb, ws, "BOM");

  // ============ STEP 5 CONFIG SHEETS (LZ + Backup) ============
  // Captures the customer-facing configuration choices so the BOM file is
  // a self-contained "what we proposed" deliverable. Egress + Landing Zone
  // SKUs go on one sheet; Backup policies (per-env) on another.
  if (step5Snapshot && typeof step5Snapshot === "object") {
    // Sheet: LZ & Egress Config
    const lzData = [
      ["Landing Zone & Network Egress Configuration"],
      ["Customer", customerName || ""],
      ["Region", region || ""],
      [],
      ["Network Egress"],
      ["Setting", "Value"],
      ["Enabled", step5Snapshot.egress?.enabled ? "Yes" : "No"],
      ["Method", step5Snapshot.egress?.method === "per_server" ? "Per-server estimate" : "Fixed total"],
      ["Per-server (GB/mo)", step5Snapshot.egress?.perServer || 0],
      ["Total (GB/mo)", step5Snapshot.egress?.totalGB || 0],
      ["Monthly cost (USD)", step5Snapshot.egress?.monthlyCost || 0],
      [],
      ["Landing Zone Components"],
      ["Component", "Enabled", "SKU", "Qty", "Unit $/mo", "Monthly cost (USD)"],
    ];
    const lzList = step5Snapshot.landingZone || [];
    const COMP_LABEL = {
      firewall: "Azure Firewall",
      vpn: "VPN Gateway",
      er: "ExpressRoute",
      bastion: "Azure Bastion",
      monitor: "Azure Monitor",
    };
    let lzTotal = 0;
    for (const c of lzList) {
      lzData.push([
        COMP_LABEL[c.component] || c.component,
        c.enabled ? "Yes" : "No",
        c.sku || "",
        c.qty || 0,
        c.unitMonthlyCost || 0,
        c.monthlyCost || 0,
      ]);
      lzTotal += c.monthlyCost || 0;
    }
    lzData.push([]);
    lzData.push(["Landing Zone Total (USD/mo)", "", "", "", "", round2(lzTotal)]);
    const wsLz = XLSX.utils.aoa_to_sheet(lzData);
    wsLz["!cols"] = [{ wch: 26 }, { wch: 10 }, { wch: 30 }, { wch: 8 }, { wch: 14 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsLz, "LZ & Egress Config");

    // Sheet: Backup Policies (per-env retention/redundancy)
    const RETENTION_LABEL = {
      "30_days": "30 days (1.5× multiplier)",
      "90_days": "90 days (2× multiplier)",
      "1_year":  "1 year (3× multiplier)",
    };
    const bk = step5Snapshot.backup || {};
    const bkData = [
      ["Backup Configuration"],
      ["Customer", customerName || ""],
      ["Region", region || ""],
      [],
      ["Global Settings"],
      ["Setting", "Value"],
      ["Daily Change Rate (%)", bk.changeRate || 0],
      ["Compression & Dedup (%)", bk.compression || 0],
      [],
      ["Per-Environment Policies"],
      ["Environment", "Included", "Servers", "Source TB", "Retention", "Redundancy", "Cost Treatment", "Monthly Cost (USD)"],
    ];
    const policies = bk.perEnvPolicies || {};
    const breakdown = bk.perEnvBreakdown || [];
    const breakdownByEnv = {};
    for (const b of breakdown) breakdownByEnv[b.env] = b;
    for (const env of (environments || [])) {
      const policy = policies[env] || {};
      const cfg = (envConfigs && envConfigs[env]) || {};
      const treatment = cfg.costMode === "dr-defer" ? "Deferred to DR Strategy"
        : cfg.costMode === "exclude" ? "Excluded from sizing"
        : "Lift & Shift";
      const bd = breakdownByEnv[env];
      bkData.push([
        env,
        policy.include ? "Yes" : "No",
        bd ? bd.servers : ((envReports && envReports[env] && envReports[env].totalServers) || (envCounts && envCounts[env]) || 0),
        bd ? bd.sourceTB : "",
        RETENTION_LABEL[policy.retention] || policy.retention || "—",
        (policy.redundancy || "").toUpperCase(),
        treatment,
        bd ? round2(bd.cost) : "",
      ]);
    }
    bkData.push([]);
    bkData.push(["Backup Total (USD/mo)", "", "", "", "", "", "", round2(bk.monthlyCost || 0)]);
    const wsBk = XLSX.utils.aoa_to_sheet(bkData);
    wsBk["!cols"] = [{ wch: 22 }, { wch: 10 }, { wch: 9 }, { wch: 11 }, { wch: 26 }, { wch: 12 }, { wch: 24 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsBk, "Backup Policies");
  }

  // OS License Summary sheet — same aggregation as the assessment export so
  // commercial teams have the procurement breakdown directly in the BOM file.
  if (session && session.assessmentReport && Array.isArray(session.assessmentReport.servers)) {
    const osAgg = aggregateOsLicenses(session.assessmentReport.servers);
    if (osAgg.rows.length > 0) {
      const osHeaders = ["OS Name (from inventory)", "OS Version", "License Type", "Support Status", "L&S Compatibility", "OS Path Options", "Customer Action Required", "Total Servers", "Total Cores", ...osAgg.envs];
      const osData = [osHeaders];
      for (const r of osAgg.rows) {
        const envCounts = osAgg.envs.map(e => r.byEnv[e] || "");
        osData.push([r.osName, r.osVersion, r.kind, r.supportStatus, r.lnsCompatible, r.osPathOptions, r.customerAction, r.totalServers, r.totalCores, ...envCounts]);
      }
      const grandServers = osAgg.rows.reduce((a, r) => a + r.totalServers, 0);
      const grandCores = osAgg.rows.reduce((a, r) => a + r.totalCores, 0);
      const envTotals = osAgg.envs.map(e => osAgg.rows.reduce((a, r) => a + (r.byEnv[e] || 0), 0));
      osData.push([]);
      osData.push(["Total", "", "", "", "", "", "", grandServers, grandCores, ...envTotals]);
      const wsOs = XLSX.utils.aoa_to_sheet(osData);
      wsOs["!cols"] = [{ wch: 38 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 36 }, { wch: 60 }, { wch: 70 }, { wch: 14 }, { wch: 12 }, ...osAgg.envs.map(() => ({ wch: 12 }))];
      XLSX.utils.book_append_sheet(wb, wsOs, "OS License Summary");
    }
  }

  // Optional sheet: DR Strategy breakdown when the user has run Step 5.
  if (session && session.drStrategy && Array.isArray(session.drStrategy.tierResults) && session.drStrategy.tierResults.length > 0) {
    const dr = session.drStrategy;
    const drData = [
      ["DR Strategy"],
      ["Criticality column", dr.column || "(none — single bucket)"],
      ["ASR licence ($/server/mo)", dr.asrPricePerServer || 25],
      [],
      ["Tier", "Servers", "Strategy", "RPO (hr)", "RTO (hr)", "DR Compute/mo", "DR Storage/mo", "DR Licence/mo", "Total/mo"],
    ];
    for (const t of dr.tierResults) {
      drData.push([
        t.tier, t.serverCount, t.strategy,
        t.rpoHours ?? "", t.rtoHours ?? "",
        t.drCompute || 0, t.drStorage || 0, t.drLicense || 0, t.monthlyCost || 0,
      ]);
    }
    drData.push([]);
    drData.push(["Total", "", "", "", "", dr.totals?.drCompute || 0, dr.totals?.drStorage || 0, dr.totals?.drLicense || 0, dr.totals?.monthlyCost || 0]);
    const wsDr = XLSX.utils.aoa_to_sheet(drData);
    wsDr["!cols"] = [{ wch: 18 }, { wch: 9 }, { wch: 20 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 14 }];
    XLSX.utils.book_append_sheet(wb, wsDr, "DR Strategy");
  }

  // Optional sheet: DR Treatment Plan — per-app treatment decisions.
  // One row per business application that has DR servers (paired or otherwise).
  // Columns surface exactly what was decided for each app and how many servers
  // were affected so customers / consultants can review during deep assessment.
  if (session && session.assessmentReport && session.assessmentReport.applicationPairing) {
    const pairing = session.assessmentReport.applicationPairing;
    const decisions = session.orphanDecisions || {};
    const tierMap = session.drStrategy?.tierMap || {};
    const drCol = session.drStrategy?.column || null;
    const STATUS_LABEL = {
      "paired": "Paired with Production (standard)",
      "uat-only": "Paired with UAT only (no Prod)",
      "orphan-dr": "Orphan — no Prod/UAT/SIT/Dev twin",
      "no-dr": "No DR servers",
    };
    const STRATEGY_LABEL = {
      "none": "None (no DR)",
      "backup-restore": "Backup-Restore (GRS)",
      "std-asr": "Standard ASR (cold DR)",
      "hot-asr": "Hot ASR (warm DR)",
      "active-active": "Active-Active",
    };
    const planData = [
      ["DR Treatment Plan — per-application decisions"],
      ["Application column", pairing.column || "(none)"],
      ["Criticality column", drCol || "(none)"],
      [],
      ["Application", "Pairing Status", "Tier (dominant)", "Total Servers", "Prod", "UAT", "DR", "Other", "DR Treatment", "SQL Handling", "Treatment Notes", "Servers Needing Review at Deep Assessment"],
    ];
    // Helper: dominant tier for this app's servers.
    const allServers = session.assessmentReport.servers || [];
    const tierByName = new Map();
    if (drCol) for (const s of allServers) tierByName.set(s.serverName, ((s.extraColumns || {})[drCol] || "").toString().trim());
    // SQL decisions + candidates lookup
    const sqlDecisions = session.sqlDecisions || {};
    const sqlCandidates = session.assessmentReport.sqlReplicaCandidates || [];
    const sqlByApp = new Map();
    for (const c of sqlCandidates) sqlByApp.set(c.app, c);

    for (const app of (pairing.apps || [])) {
      if (app.pairingStatus === "no-dr") continue; // skip apps without any DR servers
      let prod = 0, uat = 0, dr = 0, other = 0;
      for (const sv of (app.servers || [])) {
        const e = (sv.env || "").toLowerCase();
        if (/^prod/.test(e)) prod++;
        else if (/^uat/.test(e)) uat++;
        else if (/^dr|disaster/.test(e)) dr++;
        else other++;
      }
      const tierCounts = new Map();
      for (const sv of (app.servers || [])) {
        const t = tierByName.get(sv.name) || "(no value)";
        tierCounts.set(t, (tierCounts.get(t) || 0) + 1);
      }
      let dominantTier = "(no value)";
      let dominantCount = 0;
      for (const [t, c] of tierCounts) if (c > dominantCount) { dominantTier = t; dominantCount = c; }

      // Resolve treatment for this app:
      //   - explicit decision wins
      //   - else "paired" / "uat-only" → strategy from tierMap of dominant tier
      //   - "orphan-dr" without decision → defaults to "Keep in L&S" (pre-sales conservative)
      let treatment, treatmentNotes, reviewNote = "";
      const dec = decisions[app.name];
      if (dec) {
        switch (dec.action) {
          case "lns":
            treatment = "Keep in L&S (priced as primary)";
            treatmentNotes = "DR servers explicitly kept in Lift & Shift compute total. Verify during deep assessment whether they are genuine shared/infra services, mislabelled, or ghost servers.";
            reviewNote = `${dr} DR servers priced as L&S — confirm purpose at deep assessment`;
            break;
          case "dr-strategy":
            treatment = `DR Strategy: ${STRATEGY_LABEL[dec.strategy] || dec.strategy}`;
            treatmentNotes = "User explicitly applied a DR strategy to this orphan app's DR servers (e.g. shared infra service with own DR pattern).";
            break;
          case "exclude":
            treatment = "Excluded from migration";
            treatmentNotes = "DR servers excluded from the BOM by user (e.g. confirmed ghost / decommissioned). Validate with the customer before final commitment.";
            reviewNote = `${dr} DR servers excluded — confirm before final BOM`;
            break;
          case "map":
            treatment = `Mapped to: ${dec.mapToApp}`;
            treatmentNotes = `User reconciled this orphan to another app (${dec.mapToApp}) — likely mislabelled inventory tag.`;
            break;
          default:
            treatment = "(unknown decision)";
            treatmentNotes = "";
        }
      } else if (app.pairingStatus === "orphan-dr") {
        treatment = "Keep in L&S (priced as primary, default)";
        treatmentNotes = "Pre-sales default: orphan DR servers are kept in L&S for conservative pricing. Verify at deep assessment — they may be shared infra (keep), mislabelled (re-tag), or ghost (exclude).";
        reviewNote = `${dr} DR servers priced as L&S — review during deep assessment`;
      } else {
        // Paired or UAT-only — uses the tier-strategy assignment.
        const tierKey = dominantTier === "(no value)" ? "__unmapped__" : dominantTier;
        const tierCfg = tierMap[tierKey] || tierMap["__default__"] || { strategy: "none" };
        const strategy = tierCfg.strategy || "none";
        treatment = `DR Strategy: ${STRATEGY_LABEL[strategy] || strategy}`;
        treatmentNotes = app.pairingStatus === "uat-only"
          ? "UAT-only pairing (no Production twin). Treated under tier-driven DR strategy. Confirm with customer whether UAT is the de-facto Prod for this app."
          : `Tier "${dominantTier}" → ${STRATEGY_LABEL[strategy] || strategy}. Standard tier-driven assignment.`;
      }
      planData.push([
        app.name,
        STATUS_LABEL[app.pairingStatus] || app.pairingStatus,
        dominantTier,
        app.total,
        prod || "",
        uat || "",
        dr || "",
        other || "",
        treatment,
        (() => {
          const cand = sqlByApp.get(app.name);
          if (!cand) return ""; // not a SQL replica candidate
          const dec = sqlDecisions[app.name];
          const action = dec?.action || "ag"; // default: AG / Mirroring
          if (action === "ag") return `SQL replicas → Always-On AG / Mirroring (Active-Active). ${cand.sqlProdCount} prod + ${cand.sqlDrCount} DR SQL VMs treated as 24×7 active replicas.`;
          if (action === "asr") return `SQL replicas → Standalone with ASR. ${cand.sqlProdCount} prod + ${cand.sqlDrCount} DR SQL VMs treated as cold ASR target.`;
          return `SQL replicas → tier default (${cand.sqlProdCount} prod + ${cand.sqlDrCount} DR SQL VMs follow this app's tier strategy).`;
        })(),
        treatmentNotes,
        reviewNote,
      ]);
    }
    // A final summary block listing the totals by treatment so customer can sanity-check.
    const reviewServers = (pairing.apps || []).reduce((a, app) => {
      const dec = decisions[app.name];
      const drCount = (app.servers || []).filter(s => /^dr|disaster/i.test(s.env || "")).length;
      if (!drCount) return a;
      if (dec?.action === "lns" || dec?.action === "exclude") return a + drCount;
      if (!dec && app.pairingStatus === "orphan-dr") return a + drCount;
      return a;
    }, 0);
    if (reviewServers > 0) {
      planData.push([]);
      planData.push([`⚠ ${reviewServers} servers need review during deep assessment (priced as L&S or excluded due to insufficient pre-sales data).`]);
    }
    const wsPlan = XLSX.utils.aoa_to_sheet(planData);
    wsPlan["!cols"] = [{ wch: 30 }, { wch: 32 }, { wch: 18 }, { wch: 13 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 8 }, { wch: 36 }, { wch: 60 }, { wch: 80 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(wb, wsPlan, "DR Treatment Plan");
  }

  // ============ PER-SERVER BOM SHEET ============
  // One row per L&S server with all monthly cost categories distributed down
  // to server-level. Excluded + DR-deferred rows are dropped (this is the
  // commit-to-Azure spend, not the wider portfolio). Wave column is left blank
  // so the consultant can fill it in alongside the Wave Plan output.
  if (session && session.assessmentReport && Array.isArray(session.assessmentReport.servers)) {
    const allServers = session.assessmentReport.servers;
    const lnsServers = allServers.filter(s => !s.costExcluded && !s.costDeferredToDr);

    // ---- OS Rollup (L&S only) ----
    // One-glance procurement summary: how many L&S servers and Azure VM cores
    // by OS family (Windows / Linux / Other). Same Windows-detection used by
    // aggregateOsLicenses + the SQL-flavoured slice for licence conversations.
    const osRollup = { Windows: { servers: 0, vmCores: 0, srcCores: 0 }, Linux: { servers: 0, vmCores: 0, srcCores: 0 }, Other: { servers: 0, vmCores: 0, srcCores: 0 } };
    let sqlServers = 0, sqlVmCores = 0;
    for (const srv of lnsServers) {
      const osName = (srv.osName || "").toString();
      const isWindows = srv.isWindows || /windows|win2008|win2003|win2012|win2016|win2019|win2022/i.test(osName);
      const isLinux = /linux|red\s*hat|rhel|centos|ubuntu|debian|suse|oracle\s*linux|amazon\s*linux/i.test(osName);
      const family = isWindows ? "Windows" : (isLinux ? "Linux" : "Other");
      osRollup[family].servers++;
      osRollup[family].vmCores += Number(srv.vmCores) || 0;
      osRollup[family].srcCores += Number(srv.cores) || 0;
      if (/sql/i.test(osName) || /sql/i.test(srv.serverName || "")) {
        sqlServers++;
        sqlVmCores += Number(srv.vmCores) || 0;
      }
    }
    const rollupData = [
      ["OS Rollup — Lift & Shift only"],
      [`Excludes ${allServers.filter(s => s.costDeferredToDr).length} DR-deferred + ${allServers.filter(s => s.costExcluded).length} excluded servers`],
      [],
      ["OS Family", "Servers", "Source Cores (inventory)", "Azure VM Cores"],
      ["Windows", osRollup.Windows.servers, osRollup.Windows.srcCores, osRollup.Windows.vmCores],
      ["Linux", osRollup.Linux.servers, osRollup.Linux.srcCores, osRollup.Linux.vmCores],
      ["Other", osRollup.Other.servers, osRollup.Other.srcCores, osRollup.Other.vmCores],
      [
        "Total",
        osRollup.Windows.servers + osRollup.Linux.servers + osRollup.Other.servers,
        osRollup.Windows.srcCores + osRollup.Linux.srcCores + osRollup.Other.srcCores,
        osRollup.Windows.vmCores + osRollup.Linux.vmCores + osRollup.Other.vmCores,
      ],
      [],
      ["SQL workloads (subset of above — name/OS contains 'SQL')", sqlServers, "", sqlVmCores],
    ];
    const wsRollup = XLSX.utils.aoa_to_sheet(rollupData);
    wsRollup["!cols"] = [{ wch: 50 }, { wch: 12 }, { wch: 26 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(wb, wsRollup, "OS Rollup (L&S)");

    // Resolve application + tier columns once.
    const psAppCol = pickApplicationColumn(allServers);
    let psTierCol = session.drStrategy?.column || null;
    if (!psTierCol) {
      const cols = new Set();
      for (const s of allServers) if (s.extraColumns) for (const k of Object.keys(s.extraColumns)) cols.add(k);
      const candidates = ["System Tier", "Tier", "App Tier", "Server Tier", "Classification", "Criticality", "Business Criticality"];
      for (const c of candidates) {
        const hit = [...cols].find(k => k.toLowerCase() === c.toLowerCase());
        if (hit) { psTierCol = hit; break; }
      }
    }

    // Egress per-server allocation. We use exact division (no per-row rounding)
    // so the column sum exactly matches the BOM Summary's egress total. The
    // last server absorbs any sub-cent residual.
    const egressTotal = Number(step5Snapshot?.egress?.monthlyCost) || 0;
    const egressPerServerRaw = lnsServers.length > 0 ? egressTotal / lnsServers.length : 0;

    // DR per-server allocation. Two modes:
    //   - scope = "whole-estate": every non-excluded server is in the DR
    //     buckets, so each L&S server gets its direct share of its tier
    //     bucket's DR cost (proportional to compute+storage).
    //   - scope = "deferred" (default): only the DR-deferred twins are in
    //     the buckets. The L&S BOM still wants DR shown per server, so we
    //     redistribute each app's deferred DR cost back across its L&S
    //     siblings via Business Application pairing. Apps with no DR twin
    //     get DR = 0 (correct \u2014 no DR coverage purchased for them).
    //
    // Honors orphan / SQL overrides via the same bucket keys the calculator
    // used so the per-server total reconciles to drStrategy.totals.monthlyCost.
    const drByServer = new Map(); // serverName -> drMonthlyCost
    const drStrategyByServer = new Map();
    if (session.drStrategy && Array.isArray(session.drStrategy.tierResults)) {
      const dr = session.drStrategy;
      const drCol = dr.column || null;
      const drScope = dr.scope === "whole-estate" ? "whole-estate" : "deferred";
      const drServers = allServers.filter(s => {
        if (s.costExcluded) return false;
        if (drScope === "deferred") return !!s.costDeferredToDr;
        return true;
      });
      // Bucket key matches /api/dr-strategy/calculate exactly.
      const bucketKeyOf = (s) => {
        if (s._orphanOverride === "lns") return null;
        if (s._sqlOverride === "ag") return "__sql_active-active__";
        if (s._sqlOverride === "asr") return "__sql_std-asr__";
        if (s._orphanOverride === "dr-strategy") return `__orphan_${s._orphanStrategy || "std-asr"}__`;
        const tierVal = drCol ? ((s.extraColumns || {})[drCol] || "").toString().trim() : "";
        return tierVal || "__unmapped__";
      };
      const buckets = new Map();
      for (const s of drServers) {
        const k = bucketKeyOf(s);
        if (k == null) continue;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(s);
      }
      const tierByKey = new Map();
      for (const t of dr.tierResults) tierByKey.set(t.tierKey, t);

      // Step 1: per-server DR cost for servers IN the DR scope.
      const drInScope = new Map();
      const strategyInScope = new Map();
      for (const [bk, rows] of buckets.entries()) {
        const tier = tierByKey.get(bk);
        if (!tier) continue;
        const totalCost = Number(tier.monthlyCost) || 0;
        if (totalCost === 0) {
          for (const r of rows) strategyInScope.set(r.serverName, tier.strategy || "");
          continue;
        }
        const weights = rows.map(s => (Number(s.computeMonthlyCost) || 0) + (Number(s.storageMonthlyCost) || 0));
        const sumW = weights.reduce((a, b) => a + b, 0);
        for (let i = 0; i < rows.length; i++) {
          const share = sumW > 0 ? weights[i] / sumW : 1 / rows.length;
          drInScope.set(rows[i].serverName, Math.round(totalCost * share * 100) / 100);
          strategyInScope.set(rows[i].serverName, tier.strategy || "");
        }
      }

      if (drScope === "whole-estate") {
        // L&S servers were directly in the buckets \u2014 use their own share.
        for (const [name, cost] of drInScope) drByServer.set(name, cost);
        for (const [name, strat] of strategyInScope) drStrategyByServer.set(name, strat);
      } else {
        // Redistribute deferred-side DR cost back to L&S siblings by app.
        // appOf(server) -> which app this server belongs to.
        const appCol = pickApplicationColumn(allServers);
        const appOf = (s) => appCol ? ((s.extraColumns || {})[appCol] || "").toString().trim() : "";
        // Sum DR cost of deferred members per app.
        const drByApp = new Map();
        const stratByApp = new Map();
        for (const s of allServers) {
          if (!s.costDeferredToDr) continue;
          const app = appOf(s);
          if (!app) continue;
          drByApp.set(app, (drByApp.get(app) || 0) + (drInScope.get(s.serverName) || 0));
          const strat = strategyInScope.get(s.serverName);
          if (strat && !stratByApp.has(app)) stratByApp.set(app, strat);
        }
        // Distribute each app's DR pool across its L&S siblings. DR/ASR
        // protects Production specifically, so prefer Prod siblings when
        // available; fall back to any L&S sibling only when the app has no
        // Production member (e.g. UAT-only apps with a DR twin). Weighting
        // is proportional to compute+storage so larger servers carry more.
        const lnsByAppProd = new Map();
        const lnsByAppAll = new Map();
        const isProdEnv = (env) => /^prod|production|live/i.test(env || "");
        for (const s of lnsServers) {
          const app = appOf(s);
          if (!app) continue;
          if (!lnsByAppAll.has(app)) lnsByAppAll.set(app, []);
          lnsByAppAll.get(app).push(s);
          if (isProdEnv(s.environment)) {
            if (!lnsByAppProd.has(app)) lnsByAppProd.set(app, []);
            lnsByAppProd.get(app).push(s);
          }
        }
        for (const [app, drPool] of drByApp.entries()) {
          if (drPool <= 0) continue;
          const siblings = lnsByAppProd.get(app) || lnsByAppAll.get(app) || [];
          if (siblings.length === 0) continue; // orphan DR \u2014 no L&S sibling to allocate to
          const weights = siblings.map(s => (Number(s.computeMonthlyCost) || 0) + (Number(s.storageMonthlyCost) || 0));
          const sumW = weights.reduce((a, b) => a + b, 0);
          for (let i = 0; i < siblings.length; i++) {
            const share = sumW > 0 ? weights[i] / sumW : 1 / siblings.length;
            const prev = drByServer.get(siblings[i].serverName) || 0;
            drByServer.set(siblings[i].serverName, Math.round((prev + drPool * share) * 100) / 100);
            const strat = stratByApp.get(app);
            if (strat) drStrategyByServer.set(siblings[i].serverName, strat);
          }
        }
      }
    }

    const psHeaders = [
      "Server Name", "Environment", "Application", "Tier", "OS", "OS Version",
      "Cores", "RAM (GB)", "Recommended VM", "VM Cores", "VM RAM (GB)", "Disks Total (GB)",
      "Compute/mo (USD)", "Storage/mo (USD)", "Defender P2/mo (USD)", "Network Egress/mo (USD)",
      "Backup/mo (USD)", "DR/mo (USD)", "DR Strategy",
      "Total/mo (USD)", "Wave",
    ];
    const psData = [psHeaders];
    let totCompute = 0, totStorage = 0, totSecurity = 0, totEgress = 0, totBackup = 0, totDr = 0, totAll = 0;
    for (let idx = 0; idx < lnsServers.length; idx++) {
      const srv = lnsServers[idx];
      const compute = Number(srv.computeMonthlyCost) || 0;
      const storage = Number(srv.storageMonthlyCost) || 0;
      const security = Number(srv.securityMonthlyCost) || 0;
      // Last server absorbs the cumulative rounding residual so the column sum
      // matches the BOM Summary egress total exactly.
      let egress;
      if (idx < lnsServers.length - 1) {
        egress = Math.round(egressPerServerRaw * 100) / 100;
      } else {
        const allocatedSoFar = Math.round(egressPerServerRaw * 100) / 100 * (lnsServers.length - 1);
        egress = Math.round((egressTotal - allocatedSoFar) * 100) / 100;
      }
      const backup = Number(srv.backupMonthlyCost) || 0;
      const drCost = drByServer.get(srv.serverName) || 0;
      const drStrategy = drStrategyByServer.get(srv.serverName) || "";
      // Total mirrors the BOM Summary line items exactly: Compute + Storage +
      // Defender P2 + Egress + Backup + DR. Each column maps 1:1 to a BOM line.
      const total = Math.round((compute + storage + security + egress + backup + drCost) * 100) / 100;
      const application = psAppCol ? ((srv.extraColumns || {})[psAppCol] || "") : "";
      const tier = psTierCol ? ((srv.extraColumns || {})[psTierCol] || "") : "";
      const totalDiskGB = (srv.diskDetails || []).reduce((a, d) => a + (Number(d.sourceSizeGB) || 0), 0);

      psData.push([
        srv.serverName || "",
        srv.environment || "",
        application,
        tier,
        srv.osName || "",
        srv.osVersion || "",
        srv.cores || 0,
        srv.memoryMB ? +(srv.memoryMB / 1024).toFixed(1) : 0,
        srv.recommendedVm || "",
        srv.vmCores || "",
        srv.vmMemoryMB ? +(srv.vmMemoryMB / 1024).toFixed(1) : "",
        Math.round(totalDiskGB),
        +compute.toFixed(2),
        +storage.toFixed(2),
        +security.toFixed(2),
        +egress.toFixed(2),
        +backup.toFixed(2),
        +drCost.toFixed(2),
        drStrategy,
        total,
        "", // Wave — left blank for consultant to fill in
      ]);
      totCompute += compute;
      totStorage += storage;
      totSecurity += security;
      totEgress += egress;
      totBackup += backup;
      totDr += drCost;
      totAll += total;
    }
    // Totals row
    psData.push([]);
    psData.push([
      `Total (${lnsServers.length} L&S servers)`, "", "", "", "", "",
      "", "", "", "", "", "",
      round2(totCompute), round2(totStorage), round2(totSecurity), round2(totEgress),
      round2(totBackup), round2(totDr), "",
      round2(totAll), "",
    ]);

    const wsPs = XLSX.utils.aoa_to_sheet(psData);
    wsPs["!cols"] = [
      { wch: 26 }, { wch: 12 }, { wch: 22 }, { wch: 8 }, { wch: 28 }, { wch: 14 },
      { wch: 6 }, { wch: 9 }, { wch: 22 }, { wch: 8 }, { wch: 10 }, { wch: 12 },
      { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 18 },
      { wch: 16 }, { wch: 8 },
    ];
    XLSX.utils.book_append_sheet(wb, wsPs, "Per-Server BOM");
  }

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `${customerName || "Customer"}_BOM.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
});

// ============ START SERVER ============

async function main() {
  // Run CLI setup (Azure login + LLM config) unless --skip-setup flag
  const skipSetup = process.argv.includes("--skip-setup");

  if (!skipSetup) {
    try {
      const config = await runSetup();

      // Store pre-auth token if login succeeded
      if (config.azureToken) {
        preAuthToken = {
          accessToken: config.azureToken.accessToken,
          refreshToken: config.azureToken.refreshToken,
          expiresAt: Date.now() + (config.azureToken.expiresIn * 1000),
        };
      }

      // Configure Azure settings from CLI
      if (config.azureClientId) AZURE_CONFIG.clientId = config.azureClientId;
      if (config.azureTenantId) AZURE_CONFIG.tenantId = config.azureTenantId;

      // LLM config: merge env-var config (from runSetup) with persisted .llm-config.json.
      // Persisted config wins because the user explicitly saved it from the web panel.
      const persistedLlm = loadLocalConfig();
      const mergedLlm = { ...(config.llm || {}), ...persistedLlm };

      if (mergedLlm.providerType === "github-models" && mergedLlm.githubPat && mergedLlm.model) {
        // GitHub Models is fully self-contained (no Azure dependency) so it can re-arm at boot.
        // But: tokens can expire, be revoked, or lose model access between sessions. Revalidate
        // with a tiny 1-token call before arming, so the UI never shows a misleading "Connected"
        // state for a token that no longer works.
        const v = await llmHelper.validateGithubModels(mergedLlm.githubPat, mergedLlm.model);
        if (v.ok) {
          llmHelper.configure({
            providerType: "github-models",
            githubPat: mergedLlm.githubPat,
            model: mergedLlm.model,
          });
          console.log(`  ✓ AI/LLM configured (GitHub Models, model=${mergedLlm.model})\n`);
        } else {
          // Wipe the dead config from disk so the next boot doesn't keep retrying it.
          try {
            const existing = loadLocalConfig();
            fs.writeFileSync(LOCAL_CONFIG_PATH, JSON.stringify({
              ...existing,
              providerType: "", githubPat: "", model: "",
            }, null, 2), "utf-8");
          } catch {}
          console.log(`  ✗ Saved GitHub Models token rejected (HTTP ${v.status || "?"}: ${v.error || "validation failed"}). Cleared. Reconfigure in the Setup panel.\n`);
        }
      } else if (mergedLlm.endpoint && mergedLlm.apiKey) {
        // Only auto-configure if API key auth (doesn't need Azure login)
        llmHelper.configure(mergedLlm);
        console.log("  ✓ AI/LLM configured (API key)\n");
      } else {
        console.log("  ○ AI/LLM: Will activate when user selects endpoint\n");
      }
    } catch (err) {
      console.log(`  Setup warning: ${err.message}. Continuing...\n`);
    }
  }

  const server = app.listen(PORT, async () => {
    console.log(`\n  ╔══════════════════════════════════════════╗`);
    console.log(`  ║   Dr. BOM Agent                          ║`);
    console.log(`  ║   Running at: http://localhost:${PORT}      ║`);
    console.log(`  ╚══════════════════════════════════════════╝`);
    console.log(`  ${preAuthToken ? "✓ Azure: Pre-authenticated" : "○ Azure: Not logged in (login via web page)"}`);
    console.log(`  ${llmHelper.isConfigured() ? "✓ AI/LLM: Configured" : "○ AI/LLM: Not configured (optional)"}\n`);

    // Try to open browser automatically
    try {
      const open = (await import("open")).default;
      await open(`http://localhost:${PORT}`);
      console.log("  Browser opened automatically.\n");
    } catch {
      console.log(`  Open http://localhost:${PORT} in your browser.\n`);
    }
  });

  server.on("error", async (err) => {
    if (err.code === "EADDRINUSE") {
      console.log(`\n  ⚠ Port ${PORT} is already in use. Attempting to free it...`);
      try {
        // Try to kill the old process occupying the port
        const { execSync } = require("child_process");
        if (process.platform === "win32") {
          const result = execSync(`netstat -ano | findstr :${PORT} | findstr LISTENING`, { encoding: "utf-8" });
          const lines = result.trim().split("\n");
          const pids = [...new Set(lines.map(l => l.trim().split(/\s+/).pop()))];
          for (const pid of pids) {
            try { execSync(`taskkill /PID ${pid} /F`, { stdio: "ignore" }); } catch {}
          }
        } else {
          execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: "ignore" });
        }
        console.log(`  ✓ Old process killed. Restarting on port ${PORT}...\n`);
        // Wait a moment for the port to be released
        await new Promise(r => setTimeout(r, 1000));
        server.listen(PORT);
      } catch (killErr) {
        console.log(`  ✗ Could not free port ${PORT}. Please close the other instance manually.`);
        console.log(`    Or run: taskkill /F /IM node.exe\n`);
        process.exit(1);
      }
    } else {
      console.error("  Server error:", err.message);
      process.exit(1);
    }
  });
}

main();
