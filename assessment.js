/**
 * Assessment Module (v3) — Config-driven from SKUSizingLogic.json
 * - Uses Retail Prices API for BOTH VM SKU catalog and disk pricing (no ARM API)
 * - All sizing logic driven by SKUSizingLogic.json
 * - Fixes: disk pricing (correct meter filter), disk type (Standard SSD default),
 *   security cost, and retired VM SKU avoidance
 */

const fs = require("fs");
const path = require("path");
const llmHelper = require("./llmHelper");

// Load sizing config from JSON — single source of truth
const SIZING_CONFIG_PATH = path.join(__dirname, "SKUSizingLogic.json");
let sizingConfig = JSON.parse(fs.readFileSync(SIZING_CONFIG_PATH, "utf-8"));

function reloadSizingConfig() {
  sizingConfig = JSON.parse(fs.readFileSync(SIZING_CONFIG_PATH, "utf-8"));
}

// ============ RIGHT-SIZING (industry-standard, Azure Migrate aligned) ============
// Decides cores/RAM required to serve the workload, given:
//   - allocated cores/RAM (always known)
//   - observed CPU% / Memory% utilization (optional, may be missing or zero)
// Mode "auto" picks per-row: performance-based when utilization is present + valid,
// otherwise falls back to as-allocated. Edge-case handling matches Azure Migrate's
// guidance and is fully driven by the SKUSizingLogic.json `performanceBased` block.
function parseUtilization(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // Accept "23", "23%", "0.23" (decimal fraction), " 80 %"
  const m = s.match(/^([\d.]+)\s*%?$/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  if (isNaN(v)) return null;
  if (v > 0 && v <= 1) v = v * 100; // decimal fraction -> percent
  return v;
}

// Numeric clamp helper used by sizing-mode factor handling.
function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// `modeOverride` (optional): "as-allocated" | "performance-based" | "auto"
// | "industry-optimized" — when supplied, takes precedence over
// sizingConfig.rightSizing.mode. This is how the UI's global "Sizing Mode"
// override flows in without mutating shared config.
//
// `factors` (optional): { cpuOptimisationFactor, ramOptimisationFactor }
// Used ONLY when mode === "industry-optimized". When omitted, falls back to
// the config defaults (0.70 / 0.80). Values are clamped to [0.30, 1.00] to
// stay safe — going below 0.3 would risk producing unusably small VMs.
function computeRequiredResources(server, cores, memoryMB, modeOverride, factors) {
  const rs = sizingConfig.rightSizing || {};
  const mode = modeOverride || rs.mode || "as-allocated";
  const asAlloc = rs.asAllocated || { cpuComfortFactor: 1.0, ramComfortFactor: 1.0 };
  const perf = rs.performanceBased || {};
  const minPct = typeof perf.minimumUtilizationPercent === "number" ? perf.minimumUtilizationPercent : 20;
  const maxPct = typeof perf.maximumUtilizationPercent === "number" ? perf.maximumUtilizationPercent : 100;
  const cpuFactor = perf.cpuComfortFactor || 1.3;
  const ramFactor = perf.ramComfortFactor || 1.3;

  // Always-allocated path
  if (mode === "as-allocated") {
    return {
      reqCores: Math.ceil(cores * asAlloc.cpuComfortFactor),
      reqMemMB: Math.ceil(memoryMB * asAlloc.ramComfortFactor),
      sizingMode: "as-allocated",
      sizingReason: "Mode=as-allocated (no telemetry sizing).",
      cpuUtilUsed: null,
      memUtilUsed: null,
    };
  }

  // Industry-optimised path — no telemetry needed. Applies a conservative
  // downsize factor to combat typical on-prem over-allocation. Floors at
  // configured minimums so we never produce sub-2vCPU / sub-4GB VMs.
  if (mode === "industry-optimized") {
    const io = rs.industryOptimized || {};
    const minCores = sizingConfig.compute?.minimums?.vCPUs || 2;
    const minMemMB = (sizingConfig.compute?.minimums?.memoryGB || 4) * 1024;
    const cpuF = clamp(factors?.cpuOptimisationFactor ?? io.cpuFactor ?? 0.70, 0.30, 1.00);
    const ramF = clamp(factors?.ramOptimisationFactor ?? io.ramFactor ?? 0.80, 0.30, 1.00);
    const reqCores = Math.max(minCores, Math.ceil(cores * cpuF));
    const reqMemMB = Math.max(minMemMB, Math.ceil(memoryMB * ramF));
    return {
      reqCores,
      reqMemMB,
      sizingMode: "industry-optimized",
      sizingReason: `Industry-optimised: CPU × ${cpuF} → ${reqCores} cores · RAM × ${ramF} → ${Math.round(reqMemMB / 1024)} GB (floored at ${minCores}c / ${minMemMB / 1024}GB)`,
      cpuUtilUsed: null,
      memUtilUsed: null,
    };
  }

  const cpuRaw = server["CPU utilization percentage"] ?? server["CPU utilization"];
  const memRaw = server["Memory utilization percentage"] ?? server["Memory utilization"];
  const cpuPct = parseUtilization(cpuRaw);
  const memPct = parseUtilization(memRaw);

  // Per-row decision: any field that is missing OR explicitly zero falls back to as-allocated
  // for that field. Zero is treated as "untrusted measurement" because a server reporting 0%
  // CPU is more often a broken agent / off VM than a genuinely useless workload, and undersizing
  // a real workload to the minimum SKU is far more dangerous than over-provisioning by 20-30%.
  function decideEffectivePct(rawPct, kind) {
    if (rawPct === null) return { pct: null, reason: `${kind} utilization missing -> ${perf.treatMissingAs || "as-allocated"}` };
    if (rawPct === 0) return { pct: null, reason: `${kind} utilization is 0% (likely measurement gap / VM off) -> ${perf.treatZeroAs || "as-allocated"}` };
    if (rawPct > maxPct) return { pct: maxPct, reason: `${kind} utilization ${rawPct}% capped at ${maxPct}%` };
    if (rawPct < minPct) return { pct: minPct, reason: `${kind} utilization ${rawPct}% floored to ${minPct}% (industry minimum)` };
    return { pct: rawPct, reason: `${kind} utilization ${rawPct}% (within band)` };
  }

  const cpuDecision = decideEffectivePct(cpuPct, "CPU");
  const memDecision = decideEffectivePct(memPct, "Memory");

  const reqCores = cpuDecision.pct == null
    ? Math.ceil(cores * asAlloc.cpuComfortFactor)
    : Math.max(1, Math.ceil(cores * (cpuDecision.pct / 100) * cpuFactor));

  const reqMemMB = memDecision.pct == null
    ? Math.ceil(memoryMB * asAlloc.ramComfortFactor)
    : Math.max(512, Math.ceil(memoryMB * (memDecision.pct / 100) * ramFactor));

  // Mode label for visibility in the report
  let sizingMode;
  if (cpuDecision.pct == null && memDecision.pct == null) sizingMode = "as-allocated";
  else if (cpuDecision.pct != null && memDecision.pct != null) sizingMode = "performance-based";
  else sizingMode = "performance-based (partial)";

  return {
    reqCores,
    reqMemMB,
    sizingMode,
    sizingReason: `${cpuDecision.reason}; ${memDecision.reason}`,
    cpuUtilUsed: cpuDecision.pct,
    memUtilUsed: memDecision.pct,
  };
}


// ============ IN-MEMORY CACHE ============
const cache = {
  vmSkus: {},       // { region: { data: [...], fetchedAt } }  — from Retail API
  vmPricing: {},    // { `${region}_${pricingModel}`: { vmName: {windows:{}, linux:{}} } }
  diskPricing: {},  // { `${region}_${diskType}`: { tier: { monthlyCost } } }
};

const CACHE_TTL = 3600000; // 1 hour

function getCached(store, key) {
  const entry = store[key];
  if (entry && (Date.now() - entry.fetchedAt) < CACHE_TTL) return entry.data;
  return null;
}

function setCache(store, key, data) {
  store[key] = { data, fetchedAt: Date.now() };
}

// ============ FETCH VM SKUs via Retail Prices API ============
// Uses prices API to discover available VM SKUs + specs for a region (no ARM/subscription needed)
async function fetchVmSizesWithSub(region, subscriptionId, token) {
  const cached = getCached(cache.vmSkus, region);
  if (cached) return { data: cached, fromCache: true };

  console.log(`[Assessment] Fetching VM SKU catalog from Retail Prices API for ${region}...`);
  const vmSkuMap = {}; // { skuName: { name, numberOfCores, memoryInMB, maxDataDiskCount } }

  // Fetch PAYG consumption prices to build SKU catalog (these exist for all available VMs)
  let url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and priceType eq 'Consumption' and unitOfMeasure eq '1 Hour'`;
  let pageCount = 0;
  const maxPages = sizingConfig.retailApi?.maxPages || 30;
  const excludePatterns = sizingConfig.matching?.excludePatterns || [];

  while (url && pageCount < maxPages) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.Items) {
        for (const item of data.Items) {
          if (!item.armSkuName) continue;
          // Skip Spot, Low Priority, Promo
          const skip = excludePatterns.some(p =>
            item.skuName?.includes(p) || item.meterName?.includes(p) || item.productName?.includes(p)
          );
          if (skip) continue;

          const skuName = item.armSkuName;
          if (!vmSkuMap[skuName]) {
            vmSkuMap[skuName] = {
              name: skuName,
              numberOfCores: 0,
              memoryInMB: 0,
              maxDataDiskCount: 0,
              _priced: true,
            };
          }
        }
      }
      url = data.NextPageLink || null;
      pageCount++;
    } catch (e) {
      console.log(`[Assessment] VM SKU catalog fetch error: ${e.message}`);
      break;
    }
  }

  // Fetch actual specs via Resource SKUs API (if token available) to get cores/memory
  if (token && subscriptionId) {
    try {
      const skuUrl = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Compute/locations/${region}/vmSizes?api-version=2024-07-01`;
      const res = await fetch(skuUrl, { headers: { Authorization: `Bearer ${token}` } });
      const json = await res.json();
      const armData = json.value || [];
      for (const vm of armData) {
        if (vmSkuMap[vm.name]) {
          vmSkuMap[vm.name].numberOfCores = vm.numberOfCores;
          vmSkuMap[vm.name].memoryInMB = vm.memoryInMB;
          vmSkuMap[vm.name].maxDataDiskCount = vm.maxDataDiskCount;
        }
      }
    } catch (e) {
      console.log(`[Assessment] ARM SKU specs fetch failed (non-fatal): ${e.message}`);
    }
  }

  // Fallback: synthesize specs from SKU names for any VM still missing specs
  // Azure naming convention: Standard_<Family><Size><Variant>_v<Version>
  // Variant letters between size and _v indicate sub-family:
  //   "ls" / "als" / "dls"  -> low-memory  (2 GB/vCPU)   e.g. D4als_v6, D4ls_v5
  //   plain D / Da / Dad / Das / Dads      -> general (4 GB/vCPU)   e.g. D4as_v5
  //   E / M / L family                     -> memory-opt (8 GB/vCPU) e.g. E4as_v5
  //   F / Fa / Fas                         -> compute-opt (2 GB/vCPU) e.g. F4s_v2
  for (const vm of Object.values(vmSkuMap)) {
    if (vm.numberOfCores > 0 && vm.memoryInMB > 0) continue; // already has specs
    const match = vm.name.match(/^Standard_([A-Z]+)(\d+)([a-z]*)/i);
    if (!match) continue;
    const family = match[1].toUpperCase();
    const size = parseInt(match[2]);
    const variant = (match[3] || "").toLowerCase();
    if (!size) continue;
    // Memory ratio based on family + variant
    let memPerCore = 4; // default (D-series general)
    if (family.startsWith("E") || family.startsWith("M") || family.startsWith("L")) {
      memPerCore = 8;
    } else if (family.startsWith("F")) {
      memPerCore = 2;
    }
    // Low-memory variants (ls / als / dls) override family default to 2 GB/vCPU
    if (/^a?d?ls$/.test(variant) || variant === "ls" || variant === "als" || variant === "dls") {
      memPerCore = 2;
    }
    vm.numberOfCores = size;
    vm.memoryInMB = size * memPerCore * 1024;
    vm.maxDataDiskCount = Math.max(4, size * 2);
  }

  // Filter to only SKUs that have both pricing and specs
  const data = Object.values(vmSkuMap).filter(vm => vm.numberOfCores > 0 && vm.memoryInMB > 0);
  console.log(`[Assessment] ${data.length} VM SKUs with pricing+specs for ${region}`);

  if (data.length > 0) setCache(cache.vmSkus, region, data);
  return { data, fromCache: false };
}

// ============ CPU ARCHITECTURE FILTER ============
// AMD SKUs: Standard_D<N>a*_v* (have 'a' after the size number)
// Intel SKUs: Standard_D<N>*_v* (no 'a' after size number)
// Pattern: After the family letter + number, AMD has 'a' as first letter, Intel doesn't
function filterByArchitecture(vmList, architecture) {
  if (!architecture || architecture === "auto") return vmList;

  return vmList.filter(vm => {
    const name = vm.name; // e.g., Standard_D8as_v5, Standard_E4ds_v4
    // Extract the part after "Standard_<Family><Number>" — e.g., "as_v5", "ds_v4", "s_v5"
    const match = name.match(/^Standard_[A-Z]+\d+(.*)$/i);
    if (!match) return true; // can't parse, keep it
    const suffix = match[1]; // e.g., "as_v5", "ds_v5", "s_v5", "als_v5", "ads_v5"

    if (architecture === "amd") {
      // AMD: suffix starts with 'a' (e.g., as_v5, ads_v5, als_v5, a_v4)
      return suffix.startsWith("a");
    } else if (architecture === "intel") {
      // Intel: suffix does NOT start with 'a' (e.g., s_v5, ds_v5, ds_v4)
      return !suffix.startsWith("a");
    }
    return true;
  });
}

// ============ FIRST-PASS VM MATCHING (config-driven) ============
// `sizedOverride` (optional): pre-computed result of computeRequiredResources. When
// provided, this function uses it directly instead of recomputing. runFirstPassMatching
// passes this so the global sizing-mode override is honored.
function firstPassVmMatch(server, vmSizes, enabledSeries, cpuArchitecture, sizedOverride) {
  const minCores = sizingConfig.compute?.minimums?.vCPUs || 2;
  const minMemGB = sizingConfig.compute?.minimums?.memoryGB || 4;
  const cores = parseInt(server["*Cores"]) || minCores;
  const memoryMB = parseInt(server["*Memory (In MB)"]) || (minMemGB * 1024);
  const memoryGB = memoryMB / 1024;

  // Use family selection from config: ram-per-core-ratio
  const ramPerCore = memoryGB / (cores || 1);
  const familyRules = sizingConfig.compute.familySelection.rules;
  let selectedFamilies = null;
  for (const rule of familyRules) {
    if (ramPerCore <= rule.maxRamPerCore) {
      selectedFamilies = rule.families;
      break;
    }
  }
  if (!selectedFamilies) {
    selectedFamilies = familyRules[familyRules.length - 1].families;
  }

  // Apply right-sizing (industry-standard, edge-case-safe). See computeRequiredResources.
  const sized = sizedOverride || computeRequiredResources(server, cores, memoryMB);
  const reqCores = sized.reqCores;
  const reqMemMB = sized.reqMemMB;

  // Filter by enabled series (user UI selection takes priority)
  // Match series prefix followed by a digit to avoid "Standard_D" matching "Standard_DC"
  let seriesFiltered = vmSizes.filter(vm =>
    enabledSeries.some(s => {
      if (!vm.name.startsWith(s)) return false;
      const rest = vm.name.slice(s.length);
      return rest.length > 0 && /^\d/.test(rest);
    })
  );

  // Apply CPU architecture filter (AMD/Intel/Auto)
  seriesFiltered = filterByArchitecture(seriesFiltered.length > 0 ? seriesFiltered : vmSizes, cpuArchitecture);

  const pool = seriesFiltered.length > 0 ? seriesFiltered : vmSizes;

  // Filter VMs meeting minimum requirements
  const candidates = pool.filter(vm =>
    vm.numberOfCores >= reqCores && vm.memoryInMB >= reqMemMB
  );

  if (candidates.length === 0) {
    // Fallback: largest VM available
    const sorted = [...pool].sort((a, b) => (b.numberOfCores * b.memoryInMB) - (a.numberOfCores * a.memoryInMB));
    return sorted[0] || null;
  }

  // ============ UNIFIED SCORING (over-provision aware) ============
  // Replaces the previous hard family lock + req-only waste sort. The previous
  // logic ignored over-source waste, so a 4c/8GB source could be matched to a
  // 4c/16GB SKU with zero penalty (RAM doubled). This scorer:
  //   - keeps family preference but as a *soft* penalty, so a same-cost SKU
  //     in a less-preferred family can win when it avoids over-provisioning
  //   - penalises (vmCores - reqCores) and (vmMem - reqMem)  → minimise over-req waste
  //   - penalises max(0, vmCores - sourceCores) and max(0, vmMem - sourceMem)
  //     more strongly → strongly avoid exceeding source (right-sizing intent)
  const guard = sizingConfig.compute?.selectionAlgorithm?.overProvisionGuard || {};
  const guardEnabled = guard.enabled !== false; // default on
  const wReqCpu  = guard.weightReqCpu        ?? 1.0;
  const wReqMem  = guard.weightReqMem        ?? 0.5;   // per GB
  const wSrcCpu  = guard.weightSrcOverCpu    ?? 4.0;   // per core over source
  const wSrcMem  = guard.weightSrcOverMem    ?? 2.0;   // per GB over source
  const wFamily  = guard.familyMissPenalty   ?? 0.5;   // per index step

  const familyPrefixMap = sizingConfig.compute.familySelection.familyPrefixMap || {};
  const familyIndexOf = (vmName) => {
    for (let i = 0; i < selectedFamilies.length; i++) {
      const f = selectedFamilies[i];
      const pattern = familyPrefixMap[f];
      if (pattern) {
        const re = new RegExp("^" + pattern.replace("{n}", "\\d+") + "$");
        if (re.test(vmName)) return i;
      } else if (vmName.includes(f)) {
        return i;
      }
    }
    return selectedFamilies.length; // off-list = fixed penalty (one step beyond last)
  };

  const sourceCores = cores;
  const sourceMemMB = memoryMB;
  const scoreOf = (vm) => {
    const overReqC = vm.numberOfCores - reqCores;
    const overReqM = (vm.memoryInMB - reqMemMB) / 1024;
    const overSrcC = Math.max(0, vm.numberOfCores - sourceCores);
    const overSrcM = Math.max(0, (vm.memoryInMB - sourceMemMB) / 1024);
    const fam = familyIndexOf(vm.name);
    return (
      wReqCpu * overReqC +
      wReqMem * overReqM +
      (guardEnabled ? wSrcCpu * overSrcC : 0) +
      (guardEnabled ? wSrcMem * overSrcM : 0) +
      wFamily * fam
    );
  };

  candidates.sort((a, b) => {
    const sa = scoreOf(a);
    const sb = scoreOf(b);
    if (sa !== sb) return sa - sb;
    if (a.numberOfCores !== b.numberOfCores) return a.numberOfCores - b.numberOfCores;
    if (a.memoryInMB !== b.memoryInMB) return a.memoryInMB - b.memoryInMB;
    return a.name.localeCompare(b.name);
  });

  let winner = candidates[0];

  // ============ OPTIONAL SNAP-DOWN ============
  // If the winner exceeds source by more than maxOverSrcPct in either dimension,
  // try to find a SKU that stays within source by relaxing the req constraint
  // down to a tolerated floor. The intent: when right-sizing has already shaved
  // CPU/RAM by 20-30%, ending up with a VM larger than the on-prem source means
  // the optimisation worked on paper but produced no real saving. In that case
  // we'd rather under-provision slightly (the source workload was already
  // running there) than over-provision by 50-100%.
  if (guardEnabled && (guard.snapDown?.enabled !== false) && winner) {
    const maxOverCpuPct = guard.snapDown?.maxOverCpuPct ?? 25;  // % over source allowed
    const maxOverMemPct = guard.snapDown?.maxOverMemPct ?? 25;
    const reqRelaxPct   = guard.snapDown?.reqRelaxPct   ?? 15;  // how far below req we'll go

    const overC = sourceCores > 0 ? ((winner.numberOfCores - sourceCores) / sourceCores) * 100 : 0;
    const overM = sourceMemMB > 0 ? ((winner.memoryInMB - sourceMemMB) / sourceMemMB) * 100 : 0;

    if (overC > maxOverCpuPct || overM > maxOverMemPct) {
      const floorC = Math.max(minCores, Math.ceil(reqCores * (1 - reqRelaxPct / 100)));
      const floorM = Math.max(minMemGB * 1024, Math.ceil(reqMemMB * (1 - reqRelaxPct / 100)));
      const snapPool = pool.filter(vm =>
        vm.numberOfCores >= floorC &&
        vm.memoryInMB   >= floorM &&
        vm.numberOfCores <= sourceCores &&
        vm.memoryInMB   <= sourceMemMB
      );
      if (snapPool.length > 0) {
        snapPool.sort((a, b) => {
          // closest to req without exceeding source
          const da = Math.abs(a.numberOfCores - reqCores) + Math.abs((a.memoryInMB - reqMemMB) / 1024);
          const db = Math.abs(b.numberOfCores - reqCores) + Math.abs((b.memoryInMB - reqMemMB) / 1024);
          if (da !== db) return da - db;
          if (a.numberOfCores !== b.numberOfCores) return b.numberOfCores - a.numberOfCores;
          return b.memoryInMB - a.memoryInMB;
        });
        winner = snapPool[0];
      }
    }
  }

  return winner;
}

// ============ FIRST-PASS DISK MATCHING (config-driven) ============
function firstPassDiskMatch(diskSizeGB, diskTypeOverride) {
  if (!diskSizeGB || diskSizeGB <= 0) return null;

  const diskType = diskTypeOverride || sizingConfig.storage.diskType || "StandardSSD";
  const tierTable = sizingConfig.storage.sizing.tierTable[diskType];
  if (!tierTable) return null;

  // Find smallest tier that fits
  const match = tierTable.find(t => t.maxGiB >= diskSizeGB);
  if (match) {
    return { tier: match.tier, sizeGB: match.maxGiB, type: diskType };
  }

  // Oversize guard: use largest tier
  const largest = tierTable[tierTable.length - 1];
  return { tier: largest.tier, sizeGB: largest.maxGiB, type: diskType };
}

// ============ RUN FIRST-PASS MATCHING ============
// `sizingModeOverride` (optional): "as-allocated" | "performance-based" | "auto"
// | "industry-optimized" — global override from the UI. When undefined,
// sizingConfig.rightSizing.mode is used.
// `optimisationFactors` (optional): { cpuOptimisationFactor, ramOptimisationFactor }
// applied only when mode === "industry-optimized". Defaults from config when omitted.
function runFirstPassMatching(servers, vmSizes, enabledSeries, cpuArchitecture, storageTier, sizingModeOverride, optimisationFactors) {
  const series = enabledSeries || (sizingConfig.vmSeriesPreference || [])
    .filter(s => s.defaultEnabled).map(s => s.id);
  const arch = cpuArchitecture || sizingConfig.cpuArchitecture?.default || "auto";
  const diskType = storageTier || sizingConfig.storage.diskType || "StandardSSD";
  const minCores = sizingConfig.compute?.minimums?.vCPUs || 2;
  const minMemGB = sizingConfig.compute?.minimums?.memoryGB || 4;

  return servers.map(server => {
    const cores = parseInt(server["*Cores"]) || minCores;
    const memoryMB = parseInt(server["*Memory (In MB)"]) || (minMemGB * 1024);
    const sized = computeRequiredResources(server, cores, memoryMB, sizingModeOverride, optimisationFactors);
    const vmMatch = firstPassVmMatch(server, vmSizes, series, arch, sized);

    const diskMatches = [];
    for (let i = 1; i <= 10; i++) {
      const diskSize = parseInt(server[`Disk ${i} size (In GB)`]);
      if (diskSize > 0) {
        diskMatches.push({ diskNumber: i, sourceSizeGB: diskSize, azureDisk: firstPassDiskMatch(diskSize, diskType) });
      }
    }
    if (diskMatches.length === 0) {
      const storageInUse = parseInt(server["Storage in use (In GB)"]);
      if (storageInUse > 0) {
        diskMatches.push({ diskNumber: 1, sourceSizeGB: storageInUse, azureDisk: firstPassDiskMatch(storageInUse, diskType) });
      }
    }

    return {
      serverName: server["*Server name"],
      cores,
      memoryMB,
      osName: server["*OS name"] || "",
      osVersion: server["OS version"] || "",
      vmMatch: vmMatch ? { name: vmMatch.name, cores: vmMatch.numberOfCores, memoryMB: vmMatch.memoryInMB } : null,
      diskMatches,
      sizing: sized,
      _extraColumns: server._extraColumns || {},
    };
  });
}

// ============ LLM OPTIMIZATION ============
async function llmOptimizeMatching(firstPassResults, vmSizes, region, enabledSeries, onProgress) {
  if (!llmHelper.isConfigured()) {
    return firstPassResults;
  }

  const notify = onProgress || (() => {});
  const BATCH_SIZE = sizingConfig.matching?.batchSizeForLLM || 60;
  const batches = [];
  for (let i = 0; i < firstPassResults.length; i += BATCH_SIZE) {
    batches.push(firstPassResults.slice(i, i + BATCH_SIZE));
  }

  const series = enabledSeries || (sizingConfig.vmSeriesPreference || [])
    .filter(s => s.defaultEnabled).map(s => s.id);
  const maxInPrompt = sizingConfig.matching?.maxVmSizesInPrompt || 60;
  const vmSummary = vmSizes
    .filter(vm => series.some(f => vm.name.startsWith(f)))
    .slice(0, maxInPrompt)
    .map(vm => `${vm.name}: ${vm.numberOfCores}cores, ${vm.memoryInMB}MB, ${vm.maxDataDiskCount}disks`)
    .join("\n");

  const matchingSystem = `You are an Azure cloud architect specializing in VM right-sizing for migrations.
You will receive:
1. A batch of on-premises servers with their specs (cores, RAM, OS, disks)
2. A first-pass VM match suggestion for each
3. Available Azure VM sizes in the target region

Your task: Review and OPTIMIZE the VM matching. Consider:
- Workload type inference from server name/OS (e.g., SQL servers need memory-optimized E-series)
- Avoid over-provisioning: choose the smallest VM that meets requirements
- For Windows servers, prefer sizes eligible for Azure Hybrid Benefit
- D-series for general purpose, E-series for memory-intensive, F-series for CPU-intensive
- Only suggest VMs from current generation (v4, v5, v6) - avoid retired SKUs (v2, v3)

Return a JSON array with optimized matches. Keep the same structure but update vmMatch if you have a better recommendation.
Only change matches where you have a clear improvement. Add a brief "reason" field explaining changes.`;

  const optimized = [...firstPassResults];

  // Pre-flight: test LLM connectivity with a tiny fast call before committing to full batch loop
  try {
    console.log("[Assessment] Testing LLM connectivity...");
    notify("Testing AI connection...");
    const testResult = await llmHelper.call("Reply with OK", "test", { maxTokens: 5, timeout: 5000 });
    if (testResult === null) {
      console.log("[Assessment] LLM pre-flight failed (null response) — skipping LLM optimization, using first-pass results.");
      notify("AI unavailable — using rule-based sizing");
      return firstPassResults;
    }
    console.log("[Assessment] LLM connected. Starting optimization...");
  } catch (e) {
    console.log(`[Assessment] LLM pre-flight error: ${e.message} — skipping LLM optimization.`);
    notify("AI unavailable — using rule-based sizing");
    return firstPassResults;
  }

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    notify(`AI optimizing: batch ${batchIdx + 1}/${batches.length} (${batches[batchIdx].length} servers)...`);
    console.log(`[Assessment] LLM optimization batch ${batchIdx + 1}/${batches.length} (${batches[batchIdx].length} servers)...`);
    const batch = batches[batchIdx];
    const serversSummary = batch.map(s =>
      `${s.serverName}: ${s.cores}cores, ${s.memoryMB}MB RAM, OS=${s.osName}, ` +
      `disks=[${s.diskMatches.map(d => d.sourceSizeGB + "GB").join(",")}], ` +
      `firstPassVM=${s.vmMatch?.name || "none"}`
    ).join("\n");

    const userContent = `## Servers to match (batch ${batchIdx + 1} of ${batches.length}):
${serversSummary}

## Available VM sizes in ${region} (subset):
${vmSummary}

Return JSON array:
[{"serverName": "...", "vmMatch": {"name": "Standard_D2s_v5", "cores": 2, "memoryMB": 8192}, "reason": "..."}]
Only include servers where you changed the recommendation. Omit unchanged ones.`;

    try {
      const result = await llmHelper.call(matchingSystem, userContent, { json: true, maxTokens: 4000, timeout: 45000 });
      if (result === null) {
        console.log(`[Assessment] LLM batch ${batchIdx + 1} returned null — skipping remaining batches, using first-pass results.`);
        break;
      }
      if (Array.isArray(result)) {
        for (const rec of result) {
          const idx = optimized.findIndex(s => s.serverName === rec.serverName);
          if (idx >= 0 && rec.vmMatch) {
            optimized[idx].vmMatch = rec.vmMatch;
            optimized[idx].llmReason = rec.reason || "";
            optimized[idx].llmOptimized = true;
          }
        }
      }
    } catch (e) {
      console.log(`[Assessment] LLM batch ${batchIdx + 1} failed: ${e.message} — skipping remaining batches.`);
      break;
    }
  }

  return optimized;
}

// ============ PRICING: VM (Retail API) ============
async function fetchAllVmPricing(region, pricingModel, onProgress) {
  const cacheKey = `${region}_${pricingModel}`;
  const cached = getCached(cache.vmPricing, cacheKey);
  if (cached) return { data: cached, fromCache: true };

  const pricingModels = sizingConfig.pricingModels;
  const pricingDef = pricingModels.find(p => p.id === pricingModel) || pricingModels[2];
  const prices = {};

  let url = `https://prices.azure.com/api/retail/prices?$filter=serviceName eq 'Virtual Machines' and armRegionName eq '${region}' and ${pricingDef.filter}`;
  let pageCount = 0;
  const maxPages = sizingConfig.retailApi?.maxPages || 30;

  console.log(`[Pricing] Fetching VM pricing (${pricingDef.label}) for ${region}...`);

  while (url && pageCount < maxPages) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.Items) {
        for (const item of data.Items) {
          if (!item.armSkuName) continue;
          // Skip Spot/Low Priority
          if (item.skuName?.includes("Spot") || item.skuName?.includes("Low Priority")) continue;
          if (item.meterName?.includes("Spot") || item.meterName?.includes("Low Priority")) continue;

          const key = item.armSkuName;
          if (!prices[key]) prices[key] = {};
          const os = item.productName.toLowerCase().includes("windows") ? "windows" : "linux";
          if (!prices[key][os]) {
            // PAYG: retailPrice is hourly, multiply by 730 for monthly
            // RI: retailPrice is total reservation cost, divide by term months (divisor)
            const monthlyCost = pricingDef.id === "payg"
              ? round2(item.retailPrice * 730)
              : round2(item.retailPrice / pricingDef.divisor);
            prices[key][os] = {
              retailPrice: item.retailPrice,
              monthlyCost,
              currencyCode: item.currencyCode,
              meterName: item.meterName,
              productName: item.productName,
            };
          }
        }
      }
      url = data.NextPageLink || null;
      pageCount++;
      if (onProgress) onProgress({ page: pageCount, skus: Object.keys(prices).length });
    } catch (e) {
      console.log(`[Pricing] VM page fetch error: ${e.message}`);
      break;
    }
  }

  console.log(`[Pricing] ${Object.keys(prices).length} VM SKUs priced for ${region} (${pricingDef.label})`);
  if (Object.keys(prices).length > 0) setCache(cache.vmPricing, cacheKey, prices);
  return { data: prices, fromCache: false };
}

// ============ PRICING: DISKS (Retail API — FIXED) ============
async function fetchAllDiskPricing(region) {
  const diskType = sizingConfig.storage.diskType || "StandardSSD";
  const cacheKey = `${region}_${diskType}`;
  const cached = getCached(cache.diskPricing, cacheKey);
  if (cached) return { data: cached, fromCache: true };

  const prices = {};
  const storageConfig = sizingConfig.storage;
  const retailApiConfig = sizingConfig.retailApi || {};
  const excludePatterns = retailApiConfig.diskMeterExcludePatterns || ["Disk Mount", "Disk Operations", "ZRS", "Burst", "Snapshot"];
  const redundancyFilter = retailApiConfig.diskRedundancyFilter || "LRS";

  // Fetch pricing for all disk types (so we can price any disk recommendation)
  const diskProductMap = {
    "PremiumSSD": "Premium SSD Managed Disks",
    "StandardSSD": "Standard SSD Managed Disks",
    "StandardHDD": "Standard HDD Managed Disks",
  };

  for (const [dt, productName] of Object.entries(diskProductMap)) {

    let url = `https://prices.azure.com/api/retail/prices?$filter=armRegionName eq '${region}' and productName eq '${productName}' and priceType eq 'Consumption'`;
    let pageCount = 0;

    while (url && pageCount < 5) {
      try {
        const res = await fetch(url);
        const data = await res.json();
        if (data.Items) {
          for (const item of data.Items) {
            // CRITICAL FIX: Only accept actual disk capacity meters
            // Must match pattern like "E10 LRS Disk" or "P30 LRS Disk"
            // Exclude: "Disk Mount", "Disk Operations", "ZRS", "Burst", "Snapshot"
            const meterName = item.meterName || "";

            // Check exclusion patterns
            const excluded = excludePatterns.some(p => meterName.includes(p));
            if (excluded) continue;

            // Must contain the redundancy type (LRS)
            if (!meterName.includes(redundancyFilter)) continue;

            // Must be a disk capacity meter (ends with "LRS Disk" or similar)
            // Pattern: "<TierName> LRS Disk" — NOT "LRS Disk Mount" or "LRS Disk Operations"
            const diskMeterRegex = new RegExp(`^([PES]\\d+) ${redundancyFilter} Disk$`);
            const tierMatch = meterName.match(diskMeterRegex);
            if (!tierMatch) continue;

            // Must be monthly (not per-transaction)
            if (item.unitOfMeasure !== "1/Month") continue;

            const tier = tierMatch[1];
            if (!prices[tier]) {
              prices[tier] = {
                retailPrice: item.retailPrice,
                monthlyCost: round2(item.retailPrice),
                currencyCode: item.currencyCode,
                meterName: item.meterName,
                productName: item.productName,
                diskType: dt,
              };
            }
          }
        }
        url = data.NextPageLink || null;
        pageCount++;
      } catch (e) {
        console.log(`[Pricing] Disk fetch error for ${productName}: ${e.message}`);
        break;
      }
    }
  }

  console.log(`[Pricing] ${Object.keys(prices).length} disk tier prices for ${region}`);
  if (Object.keys(prices).length > 0) setCache(cache.diskPricing, cacheKey, prices);
  return { data: prices, fromCache: false };
}

// ============ PRICING: SECURITY (Defender for Server P2 — Retail API) ============
async function fetchSecurityPricing(region) {
  const cacheKey = `security_${region}`;
  const cached = getCached(cache.diskPricing, cacheKey); // reuse diskPricing store for simplicity
  if (cached) return { data: cached, fromCache: true };

  console.log(`[Pricing] Fetching Defender for Server P2 pricing for ${region}...`);

  // Try region-specific first, then global
  const filters = [
    `serviceName eq 'Microsoft Defender for Cloud' and armRegionName eq '${region}' and skuName eq 'Standard'`,
    `serviceName eq 'Microsoft Defender for Cloud' and armRegionName eq 'Global' and skuName eq 'Standard'`,
  ];

  let perServerMonth = null;

  for (const filter of filters) {
    if (perServerMonth !== null) break;
    const url = `https://prices.azure.com/api/retail/prices?$filter=${filter}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.Items) {
        for (const item of data.Items) {
          // Look for Defender for Servers Plan 2 monthly meter
          const meter = (item.meterName || "").toLowerCase();
          const product = (item.productName || "").toLowerCase();
          if ((meter.includes("plan 2") || meter.includes("p2") || product.includes("servers plan 2") || product.includes("server plan 2")) && item.unitOfMeasure === "1/Month") {
            perServerMonth = item.retailPrice;
            break;
          }
        }
      }
    } catch (e) {
      console.log(`[Pricing] Security pricing fetch error: ${e.message}`);
    }
  }

  // Fallback to config value if API didn't return
  if (perServerMonth === null) {
    perServerMonth = sizingConfig.security?.defenderForCloud?.monthlyCostPerServer || 15.00;
    console.log(`[Pricing] Defender P2 price not found via API, using config fallback: $${perServerMonth}`);
  } else {
    console.log(`[Pricing] Defender for Server P2: $${perServerMonth}/server/month`);
  }

  const result = { perServerMonth: round2(perServerMonth) };
  setCache(cache.diskPricing, cacheKey, result);
  return { data: result, fromCache: false };
}

// ============ REMATCH: Find next best SKU with available pricing ============
function rematchVmWithPricing(server, vmSizes, vmPricing, enabledSeries, excludeSkus, cpuArchitecture, sizingModeOverride) {
  const minCores = sizingConfig.compute?.minimums?.vCPUs || 2;
  const minMemGB = sizingConfig.compute?.minimums?.memoryGB || 4;
  const cores = server.cores || minCores;
  const memoryMB = server.memoryMB || (minMemGB * 1024);
  const memoryGB = memoryMB / 1024;

  const ramPerCore = memoryGB / (cores || 1);
  const familyRules = sizingConfig.compute.familySelection.rules;
  let selectedFamilies = null;
  for (const rule of familyRules) {
    if (ramPerCore <= rule.maxRamPerCore) {
      selectedFamilies = rule.families;
      break;
    }
  }
  if (!selectedFamilies) {
    selectedFamilies = familyRules[familyRules.length - 1].families;
  }

  // Reuse the per-row sizing decision from first-pass when available, so the rematched
  // SKU honors the same global override (or telemetry decision) that picked the original.
  const sized = server.sizing || computeRequiredResources(server, cores, memoryMB, sizingModeOverride);
  const reqCores = sized.reqCores;
  const reqMemMB = sized.reqMemMB;

  const series = enabledSeries || (sizingConfig.vmSeriesPreference || [])
    .filter(s => s.defaultEnabled).map(s => s.id);

  let seriesFiltered = vmSizes.filter(vm =>
    series.some(s => vm.name.startsWith(s))
  );
  // Apply architecture filter
  seriesFiltered = filterByArchitecture(seriesFiltered.length > 0 ? seriesFiltered : vmSizes, cpuArchitecture);
  const pool = seriesFiltered.length > 0 ? seriesFiltered : vmSizes;

  // Get candidates that meet requirements AND have pricing AND are not excluded
  const candidates = pool.filter(vm =>
    vm.numberOfCores >= reqCores &&
    vm.memoryInMB >= reqMemMB &&
    !excludeSkus.includes(vm.name) &&
    vmPricing[vm.name] // Must have pricing in selected model
  );

  if (candidates.length === 0) return null;

  // Sort same as firstPassVmMatch: family preference, then minimize waste
  candidates.sort((a, b) => {
    const famIdxA = selectedFamilies.findIndex(f => a.name.includes(f));
    const famIdxB = selectedFamilies.findIndex(f => b.name.includes(f));
    const famA = famIdxA >= 0 ? famIdxA : selectedFamilies.length + 10;
    const famB = famIdxB >= 0 ? famIdxB : selectedFamilies.length + 10;
    if (famA !== famB) return famA - famB;

    const wasteA = (a.numberOfCores - reqCores) + (a.memoryInMB - reqMemMB) / 1024;
    const wasteB = (b.numberOfCores - reqCores) + (b.memoryInMB - reqMemMB) / 1024;
    return wasteA - wasteB;
  });

  return candidates[0];
}

// ============ GENERATE REPORT (with security cost + rematch logic) ============
function generateAssessmentReport(matchedServers, vmPricing, diskPricing, options) {
  const { assessmentName, region, pricingModel, useAhub, vmSizes, enabledSeries, cpuArchitecture, securityEnabled: secOverride, securityPerServerPrice, sizingModeOverride, paygHoursPerMonth, costMode, cpuOptimisationFactor, ramOptimisationFactor } = options;
  const pricingModels = sizingConfig.pricingModels;
  const pricingDef = pricingModels.find(p => p.id === pricingModel) || pricingModels[2];
  const isRI = pricingModel !== "payg"; // 1yr or 3yr RI
  // Industry-optimised factors pass through to rematch so it honours the same
  // sizing decision the first-pass made. Stored locally for re-use below.
  const optimisationFactors = { cpuOptimisationFactor, ramOptimisationFactor };
  // Cost mode: 'lns' (default) = include in Lift-&-Shift totals.
  // 'dr-defer' = SKU-size + price each row, but exclude from L&S totals; surface
  // separately so Step 5 (DR Strategy) can read the sized SKUs and apply the
  // chosen DR pattern's multiplier (e.g. 100% for active-active, 30% for hot ASR,
  // 0% standing for cold ASR).
  const effectiveCostMode = costMode === "dr-defer" ? "dr-defer" : "lns";
  const isDeferred = effectiveCostMode === "dr-defer";

  // PAYG hours-per-month override. Default falls back to the prebaked value (730)
  // by signalling "use stored monthlyCost as-is". A clamped numeric value triggers
  // dynamic recompute = retailPrice * hours.
  const defaultPaygHours = sizingConfig.pricing?.payg?.hoursPerMonth || 730;
  const hoursRaw = Number(paygHoursPerMonth);
  const customPaygHours = (!isRI && Number.isFinite(hoursRaw) && hoursRaw > 0)
    ? Math.min(Math.max(hoursRaw, 1), 744) // clamp to [1, 744] (max hours in a month)
    : null;
  const effectivePaygHours = customPaygHours || defaultPaygHours;
  // Helper: resolve compute monthly cost from a pricing entry, scaling PAYG by hours when overridden.
  const resolveMonthly = (entry) => {
    if (!entry) return 0;
    if (!isRI && customPaygHours && typeof entry.retailPrice === "number") {
      return round2(entry.retailPrice * customPaygHours);
    }
    return entry.monthlyCost || 0;
  };

  // Security cost — use override from options if provided, otherwise config.
  // Defender for Servers P2 is billed HOURLY (~$0.02/hr ≈ $15/server-month at
  // 730 hrs). When the user overrides PAYG hours-per-month for compute, scale
  // Defender by the same factor so the BOM stays internally consistent
  // (otherwise compute drops to 25% while security stays at 100% — that's a bug).
  // RI flows leave securityHoursFactor at 1.0 because reservations imply 24/7.
  const securityConfig = sizingConfig.security?.defenderForCloud;
  const securityEnabled = secOverride !== undefined ? secOverride : (securityConfig?.include !== false);
  const securityBasePerServer = securityEnabled ? (securityPerServerPrice || securityConfig?.monthlyCostPerServer || 15.00) : 0;
  const securityHoursFactor = customPaygHours ? (customPaygHours / 730) : 1.0;
  const securityPerServer = round2(securityBasePerServer * securityHoursFactor);

  let totalMonthlyCompute = 0;
  let totalMonthlyStorage = 0;
  let totalMonthlySecurity = 0;
  // Deferred totals (only populated when costMode === 'dr-defer'). They mirror
  // the L&S totals so Step 5 can pick up the full picture without re-running
  // anything.
  let deferredMonthlyCompute = 0;
  let deferredMonthlyStorage = 0;
  let deferredMonthlySecurity = 0;
  let suitableCount = 0;
  let notSuitableCount = 0;
  let rematchCount = 0;

  const serverDetails = matchedServers.map(server => {
    const isWindows = (server.osName || "").toLowerCase().includes("windows");
    let vmName = server.vmMatch?.name;
    let computeMonthlyCost = 0;
    let suitability = "Suitable";
    let note = server.llmReason || "";

    // Resolve pricing for the matched VM
    let pricingResolved = false;
    if (vmName && vmPricing[vmName]) {
      let entry;
      if (useAhub && isWindows && vmPricing[vmName]["linux"]) {
        entry = vmPricing[vmName]["linux"];
      } else {
        const os = isWindows ? "windows" : "linux";
        entry = vmPricing[vmName][os] || vmPricing[vmName]["linux"] || vmPricing[vmName]["windows"];
      }
      computeMonthlyCost = resolveMonthly(entry);
      if (computeMonthlyCost > 0) pricingResolved = true;
    }

    // REMATCH LOGIC: If RI selected and matched SKU has no RI pricing, find next best SKU with pricing
    if (vmName && !pricingResolved && isRI && vmSizes && vmSizes.length > 0) {
      const originalVm = vmName;
      const excludeList = [vmName]; // exclude the original that has no pricing
      const MAX_REMATCH_ATTEMPTS = 5;
      let attempts = 0;

      while (!pricingResolved && attempts < MAX_REMATCH_ATTEMPTS) {
        const nextBest = rematchVmWithPricing(server, vmSizes, vmPricing, enabledSeries, excludeList, cpuArchitecture, sizingModeOverride);
        if (!nextBest) break;

        // Check if this SKU actually has pricing
        const candidate = nextBest.name;
        if (vmPricing[candidate]) {
          let entry;
          if (useAhub && isWindows && vmPricing[candidate]["linux"]) {
            entry = vmPricing[candidate]["linux"];
          } else {
            const os = isWindows ? "windows" : "linux";
            entry = vmPricing[candidate][os] || vmPricing[candidate]["linux"] || vmPricing[candidate]["windows"];
          }
          computeMonthlyCost = resolveMonthly(entry);
          if (computeMonthlyCost > 0) {
            vmName = candidate;
            pricingResolved = true;
            rematchCount++;
            note = `Rematched from ${originalVm} → ${candidate}. Reason: ${originalVm} does not have ${pricingDef.label} pricing (older/retired SKU family). Next best match selected.`;
          }
        }
        excludeList.push(candidate);
        attempts++;
      }

      if (!pricingResolved) {
        note = `No ${pricingDef.label} pricing available for ${originalVm} or any alternative SKUs matching requirements.`;
      }
    }

    // For PAYG: keep whatever first match is; if no pricing entry exists, just note it
    if (vmName && !pricingResolved && !isRI) {
      note = note || `${vmName} has no PAYG pricing in selected region.`;
    }

    if (!vmName) {
      suitability = "Not suitable";
      notSuitableCount++;
    } else if (!pricingResolved) {
      suitability = "Suitable (pricing unavailable)";
      suitableCount++;
    } else {
      suitableCount++;
    }

    let storageMonthlyCost = 0;
    const diskDetails = server.diskMatches.map(d => {
      const tier = d.azureDisk?.tier;
      const price = tier && diskPricing[tier] ? diskPricing[tier].monthlyCost : 0;
      storageMonthlyCost += price;
      return {
        diskNumber: d.diskNumber,
        sourceSizeGB: d.sourceSizeGB,
        azureTier: tier || "Unknown",
        azureSizeGB: d.azureDisk?.sizeGB || 0,
        diskType: d.azureDisk?.type || sizingConfig.storage.diskType,
        monthlyCost: price,
      };
    });

    const serverSecurityCost = securityEnabled ? securityPerServer : 0;

    if (isDeferred) {
      deferredMonthlyCompute += computeMonthlyCost;
      deferredMonthlyStorage += storageMonthlyCost;
      deferredMonthlySecurity += serverSecurityCost;
    } else {
      totalMonthlyCompute += computeMonthlyCost;
      totalMonthlyStorage += storageMonthlyCost;
      totalMonthlySecurity += serverSecurityCost;
    }

    return {
      serverName: server.serverName,
      cores: server.cores,
      memoryMB: server.memoryMB,
      osName: server.osName,
      osVersion: server.osVersion,
      recommendedVm: vmName || "No match",
      vmCores: vmName ? (vmSizes?.find(v => v.name === vmName)?.numberOfCores || server.vmMatch?.cores || 0) : 0,
      vmMemoryMB: vmName ? (vmSizes?.find(v => v.name === vmName)?.memoryInMB || server.vmMatch?.memoryMB || 0) : 0,
      computeMonthlyCost: round2(computeMonthlyCost),
      diskDetails,
      storageMonthlyCost: round2(storageMonthlyCost),
      securityMonthlyCost: round2(serverSecurityCost),
      totalMonthlyCost: round2(computeMonthlyCost + storageMonthlyCost + serverSecurityCost),
      // When true, this row's cost is NOT counted in the env's L&S totals; it is
      // surfaced under report.deferredSummary for Step 5 (DR Strategy) to pick up.
      costDeferredToDr: isDeferred,
      suitability,
      isWindows,
      extraColumns: server._extraColumns || {},
      // Right-sizing transparency: surface what the engine decided per server.
      sizingMode: server.sizing?.sizingMode || "as-allocated",
      sizingReason: server.sizing?.sizingReason || "",
      cpuUtilUsed: server.sizing?.cpuUtilUsed ?? null,
      memUtilUsed: server.sizing?.memUtilUsed ?? null,
      reqCores: server.sizing?.reqCores ?? server.cores,
      reqMemoryMB: server.sizing?.reqMemMB ?? server.memoryMB,
      note, // Last column: explains rematch or any special notes
    };
  });

  return {
    assessmentName,
    region,
    timestamp: new Date().toISOString(),
    pricingModel: pricingDef.label + (useAhub ? " + AHUB" : ""),
    pricingModelId: pricingModel,
    useAhub,
    paygHoursPerMonth: !isRI ? effectivePaygHours : null,
    diskType: sizingConfig.storage.diskType,
    securityProduct: securityEnabled ? "Microsoft Defender for Cloud" : "None",
    costMode: effectiveCostMode,
    sizingSummary: buildSizingSummary(serverDetails, sizingModeOverride || sizingConfig.rightSizing?.mode || "as-allocated"),
    summary: (() => {
      // Compute inventory-vs-recommended optimisation totals from serverDetails
      // so they reconcile with whatever is in the report. Storage GB sums the
      // source disk sizes (Azure-side disk size is essentially the same — we
      // never shrink disks).
      let invCores = 0, invRamMB = 0, recCores = 0, recRamMB = 0, srcDiskGB = 0;
      for (const s of serverDetails) {
        invCores += s.cores || 0;
        invRamMB += s.memoryMB || 0;
        recCores += s.vmCores || 0;
        recRamMB += s.vmMemoryMB || 0;
        for (const d of (s.diskDetails || [])) srcDiskGB += d.sourceSizeGB || 0;
      }
      return {
        totalServers: matchedServers.length,
        suitable: suitableCount,
        notSuitable: notSuitableCount,
        rematched: rematchCount,
        totalMonthlyCompute: round2(totalMonthlyCompute),
        totalMonthlyStorage: round2(totalMonthlyStorage),
        totalMonthlySecurity: round2(totalMonthlySecurity),
        totalMonthlyCost: round2(totalMonthlyCompute + totalMonthlyStorage + totalMonthlySecurity),
        totalAnnualCompute: round2(totalMonthlyCompute * 12),
        totalAnnualStorage: round2(totalMonthlyStorage * 12),
        totalAnnualSecurity: round2(totalMonthlySecurity * 12),
        totalAnnualCost: round2((totalMonthlyCompute + totalMonthlyStorage + totalMonthlySecurity) * 12),
        // Inventory-vs-recommended optimisation footprint. Used by the Sizing
        // Optimisation Summary card in the UI and by both XLSX exports.
        inventoryCores: invCores,
        inventoryRamMB: invRamMB,
        recommendedCores: recCores,
        recommendedRamMB: recRamMB,
        sourceDiskGB: Math.round(srcDiskGB),
      };
    })(),
    // Deferred summary: what this env's cost WOULD have been if it weren't deferred.
    // Always present (zeros when not deferred). Step 5 reads this when applying DR strategies.
    deferredSummary: {
      totalServers: isDeferred ? matchedServers.length : 0,
      totalMonthlyCompute: round2(deferredMonthlyCompute),
      totalMonthlyStorage: round2(deferredMonthlyStorage),
      totalMonthlySecurity: round2(deferredMonthlySecurity),
      totalMonthlyCost: round2(deferredMonthlyCompute + deferredMonthlyStorage + deferredMonthlySecurity),
    },
    servers: serverDetails,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// Aggregates per-server sizing decisions into a summary block for the UI banner.
// `modeRequested` is what the user (or config) asked for. The actual breakdown counts
// reflect what the per-row engine actually applied (e.g., a row with no telemetry will
// show as as-allocated even if the user requested performance-based — this is the
// correct, safe behavior, and the banner copy explains it).
function buildSizingSummary(serverDetails, modeRequested) {
  const summary = {
    modeRequested,
    totalServers: serverDetails.length,
    asAllocated: 0,
    performanceBased: 0,
    performanceBasedPartial: 0,
    flooredCount: 0,
    cappedCount: 0,
    zeroFallbackCount: 0,
    missingFallbackCount: 0,
  };
  for (const s of serverDetails) {
    const mode = s.sizingMode || "as-allocated";
    if (mode === "as-allocated") summary.asAllocated++;
    else if (mode === "performance-based") summary.performanceBased++;
    else if (mode === "performance-based (partial)") summary.performanceBasedPartial++;
    const reason = s.sizingReason || "";
    if (/floored/.test(reason)) summary.flooredCount++;
    if (/capped/.test(reason)) summary.cappedCount++;
    if (/measurement gap/.test(reason)) summary.zeroFallbackCount++;
    if (/missing/.test(reason)) summary.missingFallbackCount++;
  }
  return summary;
}

module.exports = {
  fetchVmSizesWithSub,
  runFirstPassMatching,
  llmOptimizeMatching,
  fetchAllVmPricing,
  fetchAllDiskPricing,
  fetchSecurityPricing,
  generateAssessmentReport,
  rematchVmWithPricing,
  filterByArchitecture,
  reloadSizingConfig,
  computeRequiredResources,
  get sizingConfig() { return sizingConfig; },
  cache,
  round2,
};
