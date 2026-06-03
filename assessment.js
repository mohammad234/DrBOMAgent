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
  // D-series: ~4GB/core, E-series: ~8GB/core, F-series: ~2GB/core, M-series: ~8GB/core
  for (const vm of Object.values(vmSkuMap)) {
    if (vm.numberOfCores > 0 && vm.memoryInMB > 0) continue; // already has specs
    const match = vm.name.match(/^Standard_([A-Z]+)(\d+)/i);
    if (!match) continue;
    const family = match[1].toUpperCase();
    const size = parseInt(match[2]);
    if (!size) continue;
    // Memory ratio based on family
    let memPerCore = 4; // default (D-series)
    if (family.startsWith("E") || family.startsWith("M")) memPerCore = 8;
    else if (family.startsWith("F")) memPerCore = 2;
    else if (family.startsWith("L")) memPerCore = 8;
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
function firstPassVmMatch(server, vmSizes, enabledSeries, cpuArchitecture) {
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

  // Apply comfort factor based on sizing mode
  const rightSizing = sizingConfig.rightSizing;
  let reqCores = cores;
  let reqMemMB = memoryMB;
  if (rightSizing.mode === "as-allocated") {
    reqCores = Math.ceil(cores * rightSizing.asAllocated.cpuComfortFactor);
    reqMemMB = Math.ceil(memoryMB * rightSizing.asAllocated.ramComfortFactor);
  }

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

  // Sort: prefer config-recommended families, then minimize waste
  const familyPrefixMap = sizingConfig.compute.familySelection.familyPrefixMap || {};
  candidates.sort((a, b) => {
    // Family preference from config — use familyPrefixMap patterns
    const famIdxA = selectedFamilies.findIndex(f => {
      const pattern = familyPrefixMap[f];
      if (pattern) {
        // Convert "Standard_D{n}as_v5" to regex "Standard_D\d+as_v5"
        const re = new RegExp("^" + pattern.replace("{n}", "\\d+") + "$");
        return re.test(a.name);
      }
      return a.name.includes(f);
    });
    const famIdxB = selectedFamilies.findIndex(f => {
      const pattern = familyPrefixMap[f];
      if (pattern) {
        const re = new RegExp("^" + pattern.replace("{n}", "\\d+") + "$");
        return re.test(b.name);
      }
      return b.name.includes(f);
    });
    const famA = famIdxA >= 0 ? famIdxA : selectedFamilies.length + 10;
    const famB = famIdxB >= 0 ? famIdxB : selectedFamilies.length + 10;
    if (famA !== famB) return famA - famB;

    // Minimize waste
    const wasteA = (a.numberOfCores - reqCores) + (a.memoryInMB - reqMemMB) / 1024;
    const wasteB = (b.numberOfCores - reqCores) + (b.memoryInMB - reqMemMB) / 1024;
    return wasteA - wasteB;
  });

  return candidates[0];
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
function runFirstPassMatching(servers, vmSizes, enabledSeries, cpuArchitecture, storageTier) {
  const series = enabledSeries || (sizingConfig.vmSeriesPreference || [])
    .filter(s => s.defaultEnabled).map(s => s.id);
  const arch = cpuArchitecture || sizingConfig.cpuArchitecture?.default || "auto";
  const diskType = storageTier || sizingConfig.storage.diskType || "StandardSSD";

  return servers.map(server => {
    const vmMatch = firstPassVmMatch(server, vmSizes, series, arch);

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
      cores: parseInt(server["*Cores"]) || 0,
      memoryMB: parseInt(server["*Memory (In MB)"]) || 0,
      osName: server["*OS name"] || "",
      osVersion: server["OS version"] || "",
      vmMatch: vmMatch ? { name: vmMatch.name, cores: vmMatch.numberOfCores, memoryMB: vmMatch.memoryInMB } : null,
      diskMatches,
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
function rematchVmWithPricing(server, vmSizes, vmPricing, enabledSeries, excludeSkus, cpuArchitecture) {
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

  const rightSizing = sizingConfig.rightSizing;
  let reqCores = cores;
  let reqMemMB = memoryMB;
  if (rightSizing.mode === "as-allocated") {
    reqCores = Math.ceil(cores * rightSizing.asAllocated.cpuComfortFactor);
    reqMemMB = Math.ceil(memoryMB * rightSizing.asAllocated.ramComfortFactor);
  }

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
  const { assessmentName, region, pricingModel, useAhub, vmSizes, enabledSeries, cpuArchitecture, securityEnabled: secOverride, securityPerServerPrice } = options;
  const pricingModels = sizingConfig.pricingModels;
  const pricingDef = pricingModels.find(p => p.id === pricingModel) || pricingModels[2];
  const isRI = pricingModel !== "payg"; // 1yr or 3yr RI

  // Security cost — use override from options if provided, otherwise config
  const securityConfig = sizingConfig.security?.defenderForCloud;
  const securityEnabled = secOverride !== undefined ? secOverride : (securityConfig?.include !== false);
  const securityPerServer = securityEnabled ? (securityPerServerPrice || securityConfig?.monthlyCostPerServer || 15.00) : 0;

  let totalMonthlyCompute = 0;
  let totalMonthlyStorage = 0;
  let totalMonthlySecurity = 0;
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
      if (useAhub && isWindows && vmPricing[vmName]["linux"]) {
        computeMonthlyCost = vmPricing[vmName]["linux"].monthlyCost;
      } else {
        const os = isWindows ? "windows" : "linux";
        const pricing = vmPricing[vmName][os] || vmPricing[vmName]["linux"] || vmPricing[vmName]["windows"];
        if (pricing) computeMonthlyCost = pricing.monthlyCost;
      }
      if (computeMonthlyCost > 0) pricingResolved = true;
    }

    // REMATCH LOGIC: If RI selected and matched SKU has no RI pricing, find next best SKU with pricing
    if (vmName && !pricingResolved && isRI && vmSizes && vmSizes.length > 0) {
      const originalVm = vmName;
      const excludeList = [vmName]; // exclude the original that has no pricing
      const MAX_REMATCH_ATTEMPTS = 5;
      let attempts = 0;

      while (!pricingResolved && attempts < MAX_REMATCH_ATTEMPTS) {
        const nextBest = rematchVmWithPricing(server, vmSizes, vmPricing, enabledSeries, excludeList, cpuArchitecture);
        if (!nextBest) break;

        // Check if this SKU actually has pricing
        const candidate = nextBest.name;
        if (vmPricing[candidate]) {
          if (useAhub && isWindows && vmPricing[candidate]["linux"]) {
            computeMonthlyCost = vmPricing[candidate]["linux"].monthlyCost;
          } else {
            const os = isWindows ? "windows" : "linux";
            const pricing = vmPricing[candidate][os] || vmPricing[candidate]["linux"] || vmPricing[candidate]["windows"];
            if (pricing) computeMonthlyCost = pricing.monthlyCost;
          }
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

    totalMonthlyCompute += computeMonthlyCost;
    totalMonthlyStorage += storageMonthlyCost;
    totalMonthlySecurity += serverSecurityCost;

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
      suitability,
      isWindows,
      extraColumns: server._extraColumns || {},
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
    diskType: sizingConfig.storage.diskType,
    securityProduct: securityEnabled ? "Microsoft Defender for Cloud" : "None",
    summary: {
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
    },
    servers: serverDetails,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

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
  get sizingConfig() { return sizingConfig; },
  cache,
  round2,
};
