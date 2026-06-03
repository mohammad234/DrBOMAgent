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

// ============ CSV PROCESSING ROUTES ============

app.post("/api/upload", upload.single("inventory"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const filePath = req.file.path;

    let rawData;
    try {
      const workbook = XLSX.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rawData = XLSX.utils.sheet_to_json(sheet, { range: 2 });
      if (!rawData || rawData.length === 0) {
        rawData = XLSX.utils.sheet_to_json(sheet);
      }
    } catch (err) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: `Failed to parse file: ${err.message}` });
    }

    if (!rawData || rawData.length === 0) {
      fs.unlinkSync(filePath);
      return res.status(400).json({ error: "File contains no data rows" });
    }

    const sourceColumns = Object.keys(rawData[0]);
    const { validRows, invalidRows, report } = processMapping(rawData);

    const sessionId = crypto.randomUUID();
    const outputDir = path.join(__dirname, "output", sessionId);
    fs.mkdirSync(outputDir, { recursive: true });

    // Write valid CSV
    const azMigrateCsv = generateCsv(validRows, templateHeaders);
    const azMigratePath = path.join(outputDir, "AzureMigrate_Import.csv");
    fs.writeFileSync(azMigratePath, azMigrateCsv, "utf-8");

    // Write excluded servers CSV
    if (invalidRows.length > 0) {
      const excludedHeaders = [...templateHeaders, "Error"];
      const excludedCsv = generateCsv(invalidRows, excludedHeaders);
      fs.writeFileSync(path.join(outputDir, "Excluded_Servers.csv"), excludedCsv, "utf-8");
    }

    // Write report
    const reportText = generateReport(rawData.length, validRows, invalidRows, report);
    fs.writeFileSync(path.join(outputDir, "conversion_report.txt"), reportText, "utf-8");

    // Store session
    sessions[sessionId] = {
      sourceFile: req.file.originalname,
      sourceFilePath: req.file.path,
      sourceColumns,
      sourceData: rawData,
      originalData: rawData, // Preserve original columns for assessment output
      totalRows: rawData.length,
      validCount: validRows.length,
      invalidCount: invalidRows.length,
      outputDir,
      azMigratePath,
      reportText,
      errors: invalidRows.map(r => ({
        serverName: r["*Server name"] || "Unknown",
        error: r["Error"],
      })),
    };

    // Build mapping info for UI display
    const mappingInfo = [];
    for (const targetCol of templateHeaders) {
      const mapping = columnMapping[targetCol];
      let sourceCol = null;
      let type = "unmapped";
      let reason = "No mapping defined";
      if (typeof mapping === "string") {
        sourceCol = mapping;
        if (sourceColumns.includes(mapping)) {
          type = "direct";
          reason = `Direct match: "${mapping}" → "${targetCol}"`;
        } else {
          type = "missing";
          reason = `Expected source column "${mapping}" not found in inventory`;
        }
      } else if (typeof mapping === "function") {
        type = "computed";
        sourceCol = "(computed)";
        // Try to describe what the function does based on known patterns
        const funcStr = mapping.toString();
        if (targetCol === "*Cores") reason = "Computed: CPU count × core count × threads";
        else if (targetCol === "*OS name") reason = "Computed: OS + version combined";
        else if (targetCol === "OS architecture") reason = "Derived from Description field";
        else if (targetCol === "Server type") reason = "Derived from Is Virtual field";
        else if (targetCol === "Hypervisor") reason = "Derived from Manufacturer field";
        else if (targetCol === "Number of disks") reason = "Default value: 1";
        else reason = "Computed from source columns";
      } else if (mapping === null) {
        reason = "Optional — no source data available";
      }
      mappingInfo.push({ target: targetCol, source: sourceCol, type, reason });
    }

    fs.unlinkSync(filePath);

    res.json({
      sessionId,
      totalRows: rawData.length,
      validRows: validRows.length,
      invalidRows: invalidRows.length,
      sourceColumns,
      mappingInfo,
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

app.post("/api/llm/config", (req, res) => {
  const { endpoint, apiKey, deploymentName, useTokenAuth, providerType } = req.body;
  console.log(`[LLM Config] endpoint="${endpoint}", deployment="${deploymentName}", tokenAuth=${useTokenAuth}, provider=${providerType || "auto"}`);
  // Only require token validation for token auth mode
  if (useTokenAuth && !getToken(req)) {
    return res.status(400).json({ error: "Token auth requires Azure login first." });
  }
  llmHelper.configure({ endpoint, apiKey, deploymentName, useTokenAuth, providerType });
  console.log(`[LLM Config] Final status:`, llmHelper.getStatus());
  saveLocalConfig({ endpoint, deploymentName, useTokenAuth: useTokenAuth || false, providerType: providerType || "auto" });
  res.json({ success: true, status: llmHelper.getStatus() });
});

app.get("/api/llm/saved-config", (req, res) => {
  const config = loadLocalConfig();
  res.json({ endpoint: config.endpoint || "", deploymentName: config.deploymentName || "", useTokenAuth: config.useTokenAuth || false });
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

// List Azure OpenAI accounts in user's subscription
app.get("/api/azure/openai-accounts", async (req, res) => {
  const token = getToken(req);
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  const { subscriptionId } = req.query;
  if (!subscriptionId) return res.status(400).json({ error: "subscriptionId required" });

  try {
    const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CognitiveServices/accounts?api-version=2023-05-01&$filter=kind eq 'OpenAI'`;
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const data = await response.json();
    if (data.error) return res.status(400).json({ error: data.error.message });
    const accounts = (data.value || []).map(a => ({
      name: a.name,
      id: a.id,
      location: a.location,
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

// LLM-assisted column mapping suggestion
app.post("/api/llm/suggest-mapping", async (req, res) => {
  const { sourceColumns } = req.body;
  if (!llmHelper.isConfigured()) {
    return res.status(400).json({ error: "LLM not configured. Provide Azure OpenAI details in settings." });
  }
  try {
    const suggestion = await llmHelper.suggestColumnMapping(sourceColumns, templateHeaders);
    if (!suggestion) {
      return res.status(500).json({ error: "LLM returned no result. Check your deployment." });
    }
    res.json({ suggestion });
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

  const { subscriptionId, sessionId, region, assessmentName, pricingModel, useAhub, enabledSeries, cpuArchitecture, storageTier, securityEnabled } = req.body;
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
        for (const server of servers) {
          const serverName = server["*Server name"];
          const origRow = session.originalData.find(r => {
            const hostName = r["Host name"] || r["Server Name"] || r["Hostname"] || r["host name"] || "";
            return hostName.toLowerCase() === serverName.toLowerCase();
          });
          if (origRow) {
            server._extraColumns = {};
            for (const col of extraColNames) {
              if (origRow[col] != null && origRow[col] !== "") server._extraColumns[col] = origRow[col];
            }
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
    const firstPassResults = assessment.runFirstPassMatching(servers, vmSizes, series, arch, diskTier);
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
      securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
    });

    session.assessmentReport = report;
    session.lastSecurityPrice = securityPrice;
    // Store matched data for re-generation without re-running
    session.lastMatchedServers = finalResults;
    session.lastVmSizes = vmSizes;
    session.lastEnabledSeries = series;
    session.lastCpuArchitecture = arch;

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
  const { sessionId, region, assessmentName, pricingModel, useAhub, cpuArchitecture, securityEnabled } = req.body;
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

    const report = assessment.generateAssessmentReport(session.lastMatchedServers, vmPricingResult.data, diskPricingResult.data, {
      assessmentName, region, pricingModel: pricing, useAhub: ahub,
      vmSizes: session.lastVmSizes || [], enabledSeries: session.lastEnabledSeries || [],
      cpuArchitecture: arch, securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
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
        for (const server of allServers) {
          const serverName = server["*Server name"];
          const origRow = session.originalData.find(r => {
            const hostName = r["Host name"] || r["Server Name"] || r["Hostname"] || r["host name"] || "";
            return hostName.toLowerCase() === (serverName || "").toLowerCase();
          });
          if (origRow) {
            server._extraColumns = {};
            for (const col of extraColNames) {
              if (origRow[col] != null && origRow[col] !== "") server._extraColumns[col] = origRow[col];
            }
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
    session.envAssessments = {};
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

      // Match
      const firstPassResults = assessment.runFirstPassMatching(envServers, vmSizes, series, arch, diskTier);

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
        securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
      });

      session.envAssessments[envName] = {
        report,
        matchedServers: finalResults,
        enabledSeries: series,
        cpuArchitecture: arch,
        storageTier: diskTier,
        pricingModel: pricing,
        useAhub: ahub,
        securityEnabled: secEnabled,
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
  const { sessionId, envName, region, assessmentName, pricingModel, useAhub, cpuArchitecture, securityEnabled } = req.body;
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

    const vmPricingResult = await assessment.fetchAllVmPricing(region, pricing);
    const diskPricingResult = await assessment.fetchAllDiskPricing(region);

    const report = assessment.generateAssessmentReport(envData.matchedServers, vmPricingResult.data, diskPricingResult.data, {
      assessmentName: `${assessmentName} - ${envName}`, region, pricingModel: pricing, useAhub: ahub,
      vmSizes: session.lastVmSizes || [], enabledSeries: envData.enabledSeries || [],
      cpuArchitecture: arch, securityEnabled: secEnabled, securityPerServerPrice: securityPrice,
    });

    // Update stored data
    envData.report = report;
    envData.pricingModel = pricing;
    envData.useAhub = ahub;
    envData.securityEnabled = secEnabled;

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
  const allServers = [];

  for (const [envName, envData] of Object.entries(envAssessments)) {
    const s = envData.report.summary;
    totalCompute += s.totalMonthlyCompute;
    totalStorage += s.totalMonthlyStorage;
    totalSecurity += s.totalMonthlySecurity;
    totalServers += s.totalServers;
    totalSuitable += s.suitable;
    totalNotSuitable += s.notSuitable;
    // Add environment tag to each server for combined view
    for (const srv of envData.report.servers) {
      allServers.push({ ...srv, environment: envName });
    }
  }

  const totalMonthlyCost = totalCompute + totalStorage + totalSecurity;
  return {
    assessmentName,
    region,
    timestamp: new Date().toISOString(),
    pricingModel: "Multi-Environment",
    summary: {
      totalServers,
      suitable: totalSuitable,
      notSuitable: totalNotSuitable,
      totalMonthlyCompute: Math.round(totalCompute * 100) / 100,
      totalMonthlyStorage: Math.round(totalStorage * 100) / 100,
      totalMonthlySecurity: Math.round(totalSecurity * 100) / 100,
      totalMonthlyCost: Math.round(totalMonthlyCost * 100) / 100,
      totalAnnualCost: Math.round(totalMonthlyCost * 12 * 100) / 100,
    },
    servers: allServers,
  };
}


// ============ LANDING ZONE & BCDR PRICING ENDPOINTS ============

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

    // Backup storage per GB
    const lrsItem = items.find(i => i.meterName.includes("LRS") && i.meterName.includes("Data Stored"));
    const grsItem = items.find(i => i.meterName.includes("GRS") && i.meterName.includes("Data Stored"));
    const lrsPerGB = lrsItem ? lrsItem.unitPrice : 0.05;
    const grsPerGB = grsItem ? grsItem.unitPrice : 0.10;

    res.json({
      region, instanceFeePerVM: round2(instanceFee),
      storageLRSPerGB: round2(lrsPerGB), storageGRSPerGB: round2(grsPerGB),
      retentionMultipliers: { "30_days": 1.5, "90_days": 2.0, "1_year": 3.0 },
      defaultChangeRate: 3,
    });
  } catch (err) {
    console.error("[Backup Pricing] Error:", err.message);
    res.json({
      region, instanceFeePerVM: 10.00,
      storageLRSPerGB: 0.05, storageGRSPerGB: 0.10,
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

function processMapping(rawData) {
  const resultRows = [];
  const report = { duplicateNames: 0, duplicateIPs: 0, ipsCleaned: 0, osVersionsCleaned: 0 };

  for (const sourceRow of rawData) {
    const targetRow = {};
    for (const templateCol of templateHeaders) {
      const colName = templateCol.trim();
      const mapping = columnMapping[colName];
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

// Detect grouping columns available in the session's inventory
app.get("/api/waveplan/detect-groups", (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  const report = session.assessmentReport;
  if (!report || !report.servers) return res.status(400).json({ error: "No assessment data. Run assessment first." });

  // Collect all extra column names from servers
  const extraCols = new Set();
  for (const srv of report.servers) {
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
      const values = [...new Set(report.servers.map(s => (s.extraColumns && s.extraColumns[actualCol]) || "Unknown").filter(v => v))];
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
    const values = [...new Set(report.servers.map(s => (s.extraColumns && s.extraColumns[col]) || "").filter(v => v))];
    if (values.length > 1 && values.length <= 200) { // skip columns with only 1 value or too many unique values (e.g. server names)
      detected.push({ id: `col_${col}`, label: `By "${col}"`, detected: true, column: col, values, columnPatterns: [] });
    }
  }

  // Always add "Distribute Evenly" as a fallback option (no grouping, splits VMs evenly by count)
  detected.push({ id: "even", label: "Distribute Evenly (no grouping)", detected: true, column: null, values: null, columnPatterns: [] });

  res.json({ groupingModes: detected, config: wavePlanConfig.defaults, totalServers: report.servers.length });
});

// Generate wave plan (rule-based auto-assignment)
app.post("/api/waveplan/generate", (req, res) => {
  const { sessionId, numWaves, lzDesignWeeks, lzProvisionWeeks, pilotDurationWeeks, waveDurationWeeks, bufferDays, startDate, groupBy, groupColumn } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport) return res.status(404).json({ error: "No assessment data." });

  const report = session.assessmentReport;
  const servers = report.servers;

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

  // Score each group for priority assignment
  const envPriority = wavePlanLogic.autoAssignment.environmentPriority;
  const critPriority = wavePlanLogic.autoAssignment.criticalityPriority;

  const scoredGroups = Object.entries(groups).map(([name, srvs]) => {
    let envScore = 3; // default mid
    const nameLower = name.toLowerCase();
    for (const [key, val] of Object.entries(envPriority)) {
      if (nameLower.includes(key)) { envScore = val; break; }
    }
    return { name, servers: srvs, serverCount: srvs.length, score: envScore + Math.log2(srvs.length + 1) };
  });

  // Sort by score (lowest = least risky = goes first)
  scoredGroups.sort((a, b) => a.score - b.score);

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

  // Assign pilot group(s): capped by throughput capacity AND max 3 groups
  const maxPilotGroups = wavePlanConfig.defaults.pilotMaxGroups || 3;
  const wave0Groups = [];
  let pilotCount = 0;
  const remaining = [...scoredGroups];

  while (remaining.length > 0 && wave0Groups.length < maxPilotGroups && pilotCount + remaining[0].serverCount <= maxPilotVMs) {
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

  const wave0Cost = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.totalMonthlyCost || 0), 0), 0);

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
    cumulativeCost: round2(wave0Cost),
  });

  // Distribute remaining groups across migration waves (balanced by server count, respecting throughput cap)
  const migrationWaves = [];
  for (let i = 0; i < totalMigrationWaves; i++) migrationWaves.push([]);

  // Greedy distribution: assign next group to wave with fewest servers (soft-balance)
  for (const g of remaining) {
    const waveIdx = migrationWaves.reduce((minIdx, wave, idx, arr) => {
      const minCount = arr[minIdx].reduce((s, x) => s + x.serverCount, 0);
      const curCount = wave.reduce((s, x) => s + x.serverCount, 0);
      return curCount < minCount ? idx : minIdx;
    }, 0);
    migrationWaves[waveIdx].push(g);
  }

  let cumCost = wave0Cost;
  let currentEnd = new Date(wave0End.getTime() + bufDays * 86400000);
  let capacityWarning = null;

  for (let i = 0; i < totalMigrationWaves; i++) {
    const waveGroups = migrationWaves[i];
    const waveStart = new Date(currentEnd);
    const waveEnd = new Date(waveStart.getTime() + waveDurW * 7 * 86400000);
    const waveServerCount = waveGroups.reduce((s, g) => s + g.serverCount, 0);
    const waveCost = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.totalMonthlyCost || 0), 0), 0);
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
      cumulativeCost: round2(cumCost),
    });

    currentEnd = new Date(waveEnd.getTime() + bufDays * 86400000);
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
  if (!session || !session.assessmentReport) return res.status(404).json({ error: "No assessment data." });

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
  const servers = report.servers;
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

  let assignedCount = 0;
  for (const [groupName, waveNum] of Object.entries(assignments)) {
    const waveIdx = Math.max(0, Math.min(numWaves, parseInt(waveNum) || 0));
    // Try exact match first, then case-insensitive
    const actualGroupName = groups[groupName] ? groupName : groupsLower[groupName.toLowerCase().trim()];
    const actualServerName = serverByName[groupName] ? groupName : serversLower[groupName.toLowerCase().trim()];

    if (actualGroupName && groups[actualGroupName]) {
      // Group-level assignment
      const meta = (groupMeta && groupMeta[groupName]) || {};
      waveBuckets[waveIdx].push({ name: actualGroupName, servers: groups[actualGroupName], serverCount: groups[actualGroupName].length, reason: meta.reason || "", tags: meta.tags || {} });
      assignedCount += groups[actualGroupName].length;
    } else if (actualServerName && serverByName[actualServerName]) {
      // Server-level assignment (LLM split into individual servers)
      const meta = (groupMeta && groupMeta[groupName]) || {};
      waveBuckets[waveIdx].push({ name: actualServerName, servers: [serverByName[actualServerName]], serverCount: 1, reason: meta.reason || "", tags: meta.tags || {} });
      assignedCount += 1;
    } else {
      console.warn(`[WavePlan Update] Unmatched assignment: "${groupName}" → wave ${waveIdx} (no matching group or server found)`);
    }
  }

  // If some groups were unassigned (LLM missed them), add them to earliest empty wave or wave 1
  const allGroupNames = new Set(Object.keys(groups));
  const assignedGroups = new Set();
  for (const bucket of Object.values(waveBuckets)) {
    for (const g of bucket) { assignedGroups.add(g.name); }
  }
  for (const unassigned of allGroupNames) {
    if (!assignedGroups.has(unassigned)) {
      console.warn(`[WavePlan Update] Group "${unassigned}" was not assigned by LLM, adding to wave 1`);
      const targetWave = Math.min(1, numWaves);
      const meta = {};
      waveBuckets[targetWave].push({ name: unassigned, servers: groups[unassigned], serverCount: groups[unassigned].length, reason: "Auto-assigned (not in LLM response)", tags: meta });
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
  const wave0Cost = wave0Groups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.totalMonthlyCost || 0), 0), 0);

  waves.push({
    waveNumber: 0, name: "Wave 0 - Foundation & Pilot",
    startDate: wave0Start.toISOString().split("T")[0], endDate: wave0End.toISOString().split("T")[0],
    durationWeeks: lzDesignW + lzProvW + pilotW,
    phases: [{ label: "LZ Design", weeks: lzDesignW }, { label: "LZ Provisioning", weeks: lzProvW }, { label: "Pilot Migration", weeks: pilotW, groups: wave0Groups.map(g => g.name) }],
    groups: wave0Groups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName), reason: g.reason || "", tags: g.tags || {} })),
    totalServers: wave0Groups.reduce((s, g) => s + g.serverCount, 0),
    waveCost: round2(wave0Cost), cumulativeCost: round2(wave0Cost),
  });

  let cumCost = wave0Cost;
  let currentEnd = new Date(wave0End.getTime() + bufDays * 86400000);

  for (let i = 1; i <= numWaves; i++) {
    const waveGroups = waveBuckets[i] || [];
    const waveStart = new Date(currentEnd);
    const waveEnd = new Date(waveStart.getTime() + waveDurW * 7 * 86400000);
    const waveCost = waveGroups.reduce((sum, g) => sum + g.servers.reduce((s, srv) => s + (srv.totalMonthlyCost || 0), 0), 0);
    cumCost += waveCost;

    waves.push({
      waveNumber: i, name: `Wave ${i}`,
      startDate: waveStart.toISOString().split("T")[0], endDate: waveEnd.toISOString().split("T")[0],
      durationWeeks: waveDurW,
      groups: waveGroups.map(g => ({ name: g.name, serverCount: g.serverCount, servers: g.servers.map(s => s.serverName), reason: g.reason || "", tags: g.tags || {} })),
      totalServers: waveGroups.reduce((s, g) => s + g.serverCount, 0),
      waveCost: round2(waveCost), cumulativeCost: round2(cumCost),
    });
    currentEnd = new Date(waveEnd.getTime() + bufDays * 86400000);
  }

  session.wavePlan = { waves, config };
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
    "Wave Cost (USD/mo)": w.waveCost,
    "Cumulative Cost (USD/mo)": w.cumulativeCost,
  }));
  const ws1 = XLSX.utils.json_to_sheet(timelineRows);
  // Set column widths
  ws1["!cols"] = [
    { wch: 25 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
    { wch: 12 }, { wch: 12 }, { wch: 40 }, { wch: 18 }, { wch: 20 }
  ];
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

// LLM-assisted wave plan suggestion
app.post("/api/waveplan/llm-suggest", async (req, res) => {
  const { sessionId, numWaves, groupBy, groupColumn, userInstructions, lzDesignWeeks, lzProvisionWeeks, pilotDurationWeeks, waveDurationWeeks, bufferDays, startDate, pilotThroughputPerWeek, waveThroughputPerWeek } = req.body;
  const session = sessions[sessionId];
  if (!session || !session.assessmentReport) return res.status(404).json({ error: "No assessment data." });
  if (!llmHelper.isConfigured()) return res.status(400).json({ error: "LLM not configured." });

  const report = session.assessmentReport;
  const servers = report.servers;

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

  const envPriority = wavePlanLogic.autoAssignment.environmentPriority;
  const scoredGroups = Object.entries(groups).map(([name, srvs]) => {
    let envScore = 3;
    const nameLower = name.toLowerCase();
    for (const [key, val] of Object.entries(envPriority)) {
      if (nameLower.includes(key)) { envScore = val; break; }
    }
    return { name, servers: srvs, serverCount: srvs.length, score: envScore + Math.log2(srvs.length + 1) };
  });
  scoredGroups.sort((a, b) => a.score - b.score);

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

  // Distribute remaining across migration waves (greedy balanced)
  const migrationBuckets = [];
  for (let i = 0; i < totalMigrationWaves; i++) migrationBuckets.push([]);

  for (const g of remaining) {
    const waveIdx = migrationBuckets.reduce((minIdx, wave, idx, arr) => {
      const minCount = arr[minIdx].reduce((s, x) => s + x.serverCount, 0);
      const curCount = wave.reduce((s, x) => s + x.serverCount, 0);
      return curCount < minCount ? idx : minIdx;
    }, 0);
    migrationBuckets[waveIdx].push(g);
    baseAssignment[g.name] = waveIdx + 1; // wave 1-indexed
  }

  console.log(`[WavePlan] Rule-based assignment:`, JSON.stringify(baseAssignment));

  // ===== STEP 2: Ask LLM for refinements based on user instructions =====
  // Collect metadata for each group
  const metadataColumns = ["Tier", "Environment", "Criticality", "Priority", "Risk", "Classification", "App Tier", "Business Criticality"];
  const groupDescriptions = Object.entries(groups).map(([name, srvs]) => {
    const metadata = {};
    for (const srv of srvs) {
      if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (metadataColumns.some(mc => col.toLowerCase().includes(mc.toLowerCase()))) {
            if (!metadata[col]) metadata[col] = new Set();
            if (srv.extraColumns[col]) metadata[col].add(srv.extraColumns[col]);
          }
        }
      }
      if (srv.environment) {
        if (!metadata["Environment"]) metadata["Environment"] = new Set();
        metadata["Environment"].add(srv.environment);
      }
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
[{"group": "GroupName", "toWave": 3, "reason": "User instructed Tier 1 to last wave"}]

Rules:
- Wave numbers must be between 0 and ${totalMigrationWaves}
- "last wave" means wave ${totalMigrationWaves}
- "first wave" means wave 1 (wave 0 is always pilot)
- Only move groups that match the user's criteria
- Return ONLY the JSON array, no other text`;

  let moves = [];
  try {
    const response = await llmHelper.call(
      "You are a migration planning assistant. Your job is to interpret the user's instructions and determine which server groups need to be moved to different waves. Return ONLY a JSON array of moves. If no moves needed, return []. NEVER ask questions.",
      refinementPrompt,
      { json: true, maxTokens: 4000, timeout: 45000 }
    );

    if (response && Array.isArray(response)) {
      moves = response;
    } else if (response && typeof response === "object" && !Array.isArray(response)) {
      // Try to extract array from object
      const arrProp = Object.values(response).find(v => Array.isArray(v));
      if (arrProp) moves = arrProp;
    }
    console.log(`[WavePlan] LLM suggested ${moves.length} moves:`, JSON.stringify(moves));
  } catch (err) {
    console.warn(`[WavePlan] LLM refinement failed (using rule-based): ${err.message}`);
    // Continue with rule-based — this is fine
  }

  // ===== STEP 3: Apply LLM moves on top of rule-based assignment =====
  const finalAssignment = { ...baseAssignment };
  const groupMeta = {};

  // Always populate groupMeta with tags (Tier, Environment, etc.) for display in AI Insight column
  for (const [name, srvs] of Object.entries(groups)) {
    const tags = {};
    for (const srv of srvs) {
      if (srv.extraColumns) {
        for (const col of Object.keys(srv.extraColumns)) {
          if (metadataColumns.some(mc => col.toLowerCase().includes(mc.toLowerCase()))) {
            const val = srv.extraColumns[col];
            if (val) {
              if (!tags[col]) tags[col] = new Set();
              tags[col].add(val);
            }
          }
        }
      }
      if (srv.environment) {
        if (!tags["environment"]) tags["environment"] = new Set();
        tags["environment"].add(srv.environment);
      }
    }
    // Convert sets to joined strings
    const flatTags = {};
    for (const [k, v] of Object.entries(tags)) { flatTags[k.toLowerCase()] = [...v].join(", "); }
    groupMeta[name] = { reason: "", tags: flatTags };
  }

  // Build case-insensitive lookup for group matching
  const groupsLower = {};
  for (const key of Object.keys(groups)) { groupsLower[key.toLowerCase().trim()] = key; }

  for (const move of moves) {
    if (!move.group || move.toWave === undefined) continue;
    const toWave = Math.max(0, Math.min(totalMigrationWaves, parseInt(move.toWave) || 0));
    // Match group name (case-insensitive)
    const actualName = groups[move.group] ? move.group : groupsLower[move.group.toLowerCase().trim()];
    if (actualName) {
      finalAssignment[actualName] = toWave;
      groupMeta[actualName].reason = move.reason || `Moved from wave ${baseAssignment[actualName]} → ${toWave}`;
      console.log(`[WavePlan] Moved "${actualName}" from wave ${baseAssignment[actualName]} → wave ${toWave} (${move.reason})`);
    } else {
      console.warn(`[WavePlan] LLM suggested moving "${move.group}" but no matching group found`);
    }
  }

  // Build response in format expected by /api/waveplan/update
  res.json({ assignments: finalAssignment, groupMeta, moves, baseAssignment });
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
  const summaryData = [
    ["Assessment Report - " + (customerName || "Customer")],
    [],
    ["Assessment Name", assessmentName || "Assessment"],
    ["Customer", customerName || ""],
    ["Target Region", region || ""],
    ["Total Servers", s.totalServers],
    [],
    ["Monthly Compute (USD)", s.totalMonthlyCompute],
    ["Monthly Storage (USD)", s.totalMonthlyStorage],
    ["Monthly Security (USD)", s.totalMonthlySecurity],
    ["Total Monthly (USD)", s.totalMonthlyCost],
    ["Total Annual (USD)", s.totalAnnualCost],
    [],
    ["Pricing Configuration per Environment"],
    ["Environment", "Servers", "Pricing Model", "License"],
  ];
  for (const env of (environments || ["All"])) {
    const config = (envConfigs && envConfigs[env]) || {};
    const count = (envReports && envReports[env] && envReports[env].totalServers) || (envCounts && envCounts[env]) || 0;
    summaryData.push([env, count, pricingLabels[config.pricingModel] || config.pricingModel || "N/A", config.useAhub ? "AHUB" : "PAYG"]);
  }

  // Sheet 2: Server Recommendations
  const serverHeaders = ["Server Name", "Environment", "OS", "Cores", "RAM (GB)", "Recommended VM", "VM Cores", "VM RAM (GB)", "Disks", "Compute/mo (USD)", "Storage/mo (USD)", "Total/mo (USD)", "Suitability", "LLM Reason"];
  const serverData = [serverHeaders];
  for (const srv of report.servers) {
    serverData.push([
      srv.serverName || "",
      srv.environment || "",
      srv.osName || "",
      srv.cores || 0,
      srv.memoryMB ? +(srv.memoryMB / 1024).toFixed(1) : 0,
      srv.recommendedVm || "",
      srv.vmCores || "",
      srv.vmMemoryMB ? +(srv.vmMemoryMB / 1024).toFixed(1) : "",
      (srv.diskDetails || []).map(d => d.azureTier + "(" + d.sourceSizeGB + "GB)").join("; "),
      +(srv.computeMonthlyCost || 0).toFixed(2),
      +(srv.storageMonthlyCost || 0).toFixed(2),
      +(srv.totalMonthlyCost || 0).toFixed(2),
      srv.suitability || "",
      srv.llmReason || "",
    ]);
  }

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.aoa_to_sheet(summaryData);
  ws1["!cols"] = [{ wch: 30 }, { wch: 15 }, { wch: 20 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws1, "Cost Summary");

  const ws2 = XLSX.utils.aoa_to_sheet(serverData);
  ws2["!cols"] = [{ wch: 25 }, { wch: 12 }, { wch: 20 }, { wch: 6 }, { wch: 9 }, { wch: 22 }, { wch: 8 }, { wch: 10 }, { wch: 40 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 15 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws2, "Server Recommendations");

  const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const filename = `${customerName || "Customer"}_${assessmentName || "Assessment"}.xlsx`;
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(buffer);
});

// BOM Excel (.xlsx)
app.post("/api/export/bom-xlsx", (req, res) => {
  const { customerName, region, environments, envConfigs, envCounts, envReports, bomItems } = req.body;
  // bomItems: [{label, value}]
  const pricingLabels = { "payg": "Pay As You Go", "1yr_ri": "1 Yr RI", "3yr_ri": "3 Yr RI", "spot": "Spot" };

  const data = [
    ["Bill of Materials (BOM)"],
    ["Customer", customerName || ""],
    ["Region", region || ""],
    [],
    ["Pricing Configuration per Environment"],
    ["Environment", "Servers", "Pricing Model", "License"],
  ];
  for (const env of (environments || ["All"])) {
    const config = (envConfigs && envConfigs[env]) || {};
    const count = (envReports && envReports[env] && envReports[env].totalServers) || (envCounts && envCounts[env]) || 0;
    data.push([env, count, pricingLabels[config.pricingModel] || config.pricingModel || "N/A", config.useAhub ? "AHUB" : "PAYG"]);
  }
  data.push([]);
  data.push(["Items", "Cost per Month (USD)"]);
  for (const item of (bomItems || [])) {
    data.push([item.label, item.value]);
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  ws["!cols"] = [{ wch: 35 }, { wch: 20 }, { wch: 20 }, { wch: 15 }];
  XLSX.utils.book_append_sheet(wb, ws, "BOM");

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

      // LLM config is saved locally but only activated when user explicitly selects endpoint+deployment
      // (or when pre-auth restores a valid session with saved config)
      if (config.llm && config.llm.endpoint && config.llm.apiKey) {
        // Only auto-configure if API key auth (doesn't need Azure login)
        llmHelper.configure(config.llm);
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
