/**
 * Assessment Configuration
 * Configurable parameters for VM matching, pricing, and prompts.
 * Keep all tunables here for easy adjustment.
 */

// ============ VM SERIES DEFINITIONS ============
const VM_SERIES = [
  { id: "Standard_A", name: "A-Series (Basic)", desc: "Entry-level, dev/test", defaultEnabled: false },
  { id: "Standard_B", name: "B-Series (Burstable)", desc: "Low-cost burstable workloads", defaultEnabled: false },
  { id: "Standard_D", name: "D-Series (General Purpose)", desc: "Balanced CPU/memory", defaultEnabled: true },
  { id: "Standard_E", name: "E-Series (Memory Optimized)", desc: "High memory-to-core ratio", defaultEnabled: true },
  { id: "Standard_F", name: "F-Series (Compute Optimized)", desc: "High CPU-to-memory ratio", defaultEnabled: true },
  { id: "Standard_L", name: "L-Series (Storage Optimized)", desc: "High disk throughput", defaultEnabled: true },
  { id: "Standard_M", name: "M-Series (Memory Intensive)", desc: "Very large memory workloads", defaultEnabled: true },
  { id: "Standard_NC", name: "NC-Series (GPU)", desc: "GPU compute (AI/ML)", defaultEnabled: false },
  { id: "Standard_NV", name: "NV-Series (GPU Visualization)", desc: "GPU for VDI", defaultEnabled: false },
];

// ============ PRICING MODELS ============
const PRICING_MODELS = [
  { id: "payg", name: "Pay As You Go", filter: "priceType eq 'Consumption'", divisor: 1, label: "PAYG" },
  { id: "1yr_ri", name: "1-Year Reserved Instance", filter: "priceType eq 'Reservation' and reservationTerm eq '1 Year'", divisor: 12, label: "1yr RI" },
  { id: "3yr_ri", name: "3-Year Reserved Instance", filter: "priceType eq 'Reservation' and reservationTerm eq '3 Years'", divisor: 36, label: "3yr RI" },
];

// ============ AHUB OPTIONS ============
const AHUB_OPTIONS = [
  { id: "ahub", name: "Azure Hybrid Benefit (AHUB)", desc: "Use existing Windows Server licenses", default: true },
  { id: "no_ahub", name: "No AHUB (Include License)", desc: "Pay full Windows license cost", default: false },
];

// ============ AZURE REGIONS ============
const AZURE_REGIONS = [
  { value: "southeastasia", label: "Southeast Asia (Singapore)" },
  { value: "eastasia", label: "East Asia (Hong Kong)" },
  { value: "australiaeast", label: "Australia East (Sydney)" },
  { value: "japaneast", label: "Japan East (Tokyo)" },
  { value: "centralindia", label: "Central India (Pune)" },
  { value: "uksouth", label: "UK South (London)" },
  { value: "northeurope", label: "North Europe (Ireland)" },
  { value: "westeurope", label: "West Europe (Netherlands)" },
  { value: "centralus", label: "Central US (Iowa)" },
  { value: "eastus", label: "East US (Virginia)" },
  { value: "eastus2", label: "East US 2 (Virginia)" },
  { value: "westus2", label: "West US 2 (Washington)" },
  { value: "koreacentral", label: "Korea Central (Seoul)" },
  { value: "malaysiawest", label: "Malaysia West (Kuala Lumpur)" },
];

// ============ DISK TIERS ============
const MANAGED_DISK_TIERS = [
  // Premium SSD
  { tier: "P4", sizeGB: 32, iops: 120, throughputMBps: 25, type: "PremiumSSD" },
  { tier: "P6", sizeGB: 64, iops: 240, throughputMBps: 50, type: "PremiumSSD" },
  { tier: "P10", sizeGB: 128, iops: 500, throughputMBps: 100, type: "PremiumSSD" },
  { tier: "P15", sizeGB: 256, iops: 1100, throughputMBps: 125, type: "PremiumSSD" },
  { tier: "P20", sizeGB: 512, iops: 2300, throughputMBps: 150, type: "PremiumSSD" },
  { tier: "P30", sizeGB: 1024, iops: 5000, throughputMBps: 200, type: "PremiumSSD" },
  { tier: "P40", sizeGB: 2048, iops: 7500, throughputMBps: 250, type: "PremiumSSD" },
  { tier: "P50", sizeGB: 4096, iops: 7500, throughputMBps: 250, type: "PremiumSSD" },
  { tier: "P60", sizeGB: 8192, iops: 16000, throughputMBps: 500, type: "PremiumSSD" },
  { tier: "P70", sizeGB: 16384, iops: 18000, throughputMBps: 750, type: "PremiumSSD" },
  { tier: "P80", sizeGB: 32767, iops: 20000, throughputMBps: 900, type: "PremiumSSD" },
  // Standard SSD
  { tier: "E4", sizeGB: 32, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E6", sizeGB: 64, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E10", sizeGB: 128, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E20", sizeGB: 512, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E30", sizeGB: 1024, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E40", sizeGB: 2048, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  { tier: "E50", sizeGB: 4096, iops: 500, throughputMBps: 60, type: "StandardSSD" },
  // Standard HDD
  { tier: "S4", sizeGB: 32, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S6", sizeGB: 64, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S10", sizeGB: 128, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S20", sizeGB: 512, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S30", sizeGB: 1024, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S40", sizeGB: 2048, iops: 500, throughputMBps: 60, type: "StandardHDD" },
  { tier: "S50", sizeGB: 4096, iops: 500, throughputMBps: 60, type: "StandardHDD" },
];

// ============ MATCHING PARAMETERS ============
const MATCHING_CONFIG = {
  headroomPercent: 20, // Add 20% headroom to requirements
  preferredFamilyBonus: 0, // Bonus score for preferred families
  nonPreferredPenalty: 10, // Penalty for non-recommended families
  batchSizeForLLM: 30, // Max servers per LLM batch call
  maxVmSizesInPrompt: 60, // Max VM sizes to include in LLM prompt context
};

// ============ LLM PROMPTS ============
const PROMPTS = {
  matchingSystem: `You are an Azure cloud architect specializing in VM right-sizing for migrations.
You will receive:
1. A batch of on-premises servers with their specs (cores, RAM, OS, disks)
2. A first-pass VM match suggestion for each
3. Available Azure VM sizes in the target region

Your task: Review and OPTIMIZE the VM matching. Consider:
- Workload type inference from server name/OS (e.g., SQL servers need memory-optimized E-series)
- Avoid over-provisioning: choose the smallest VM that meets requirements with ~20% headroom
- For Windows servers, prefer sizes eligible for Azure Hybrid Benefit
- For Linux workloads, B-series (burstable) may suffice for low-utilization servers
- D-series for general purpose, E-series for memory-intensive, F-series for CPU-intensive
- Consider CPU utilization if provided (< 20% = good candidate for downsizing)

Return a JSON array with optimized matches. Keep the same structure but update vmMatch if you have a better recommendation.
Only change matches where you have a clear improvement. Add a brief "reason" field explaining changes.`,

  matchingUser: `## Servers to match (batch {{batchNum}} of {{totalBatches}}):
{{servers}}

## Available VM sizes in {{region}} (subset):
{{vmSizes}}

Return JSON array:
[{"serverName": "...", "vmMatch": {"name": "Standard_D2s_v5", "cores": 2, "memoryMB": 8192}, "reason": "..."}]
Only include servers where you changed the recommendation. Omit unchanged ones.`,
};

module.exports = {
  VM_SERIES,
  PRICING_MODELS,
  AHUB_OPTIONS,
  AZURE_REGIONS,
  MANAGED_DISK_TIERS,
  MATCHING_CONFIG,
  PROMPTS,
};
