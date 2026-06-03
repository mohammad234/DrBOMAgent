const XLSX = require('xlsx');
const path = require('path');
const assessment = require('./assessment');

async function main() {
  const REGION = 'southeastasia';
  
  console.log('--- Fetching VM SKU catalog for', REGION, '---');
  const vmResult = await assessment.fetchVmSizesWithSub(REGION);
  let vmSizes = vmResult.data;
  
  // If no specs (no ARM token), synthesize from SKU names
  if (vmSizes.length === 0) {
    console.log('No ARM token — synthesizing VM specs from pricing catalog...');
    // Re-fetch just to get names
    const pricingResult = await assessment.fetchAllVmPricing(REGION, 'payg');
    const allNames = Object.keys(pricingResult.data);
    console.log('SKUs from pricing:', allNames.length);
    vmSizes = allNames.map(name => {
      const match = name.match(/^Standard_([A-Z]+)(\d+)/i);
      if (!match) return null;
      const family = match[1].toUpperCase();
      const size = parseInt(match[2]);
      // Memory-optimized: E, M = 8GB/core; General: D = 4GB/core
      const memPerCore = (family.startsWith('E') || family.startsWith('M')) ? 8 : 4;
      return {
        name,
        numberOfCores: size,
        memoryInMB: size * memPerCore * 1024,
        maxDataDiskCount: Math.max(4, size * 2),
      };
    }).filter(Boolean);
    console.log('Synthesized VM specs:', vmSizes.length);
  } else {
    console.log('Total VM SKUs:', vmSizes.length);
  }

  const amdVms = assessment.filterByArchitecture(vmSizes, 'amd');
  const intelVms = assessment.filterByArchitecture(vmSizes, 'intel');
  console.log('AMD VMs:', amdVms.length, '| Intel VMs:', intelVms.length);

  // Load Azure Migrate report
  const wb = XLSX.readFile(path.join(__dirname, '..', 'AzMigrateAssessReport-MYRegion.xlsx'));
  const machines = XLSX.utils.sheet_to_json(wb.Sheets['All_Assessed_Machines']);
  console.log('Total machines in report:', machines.length);
  console.log('Columns:', Object.keys(machines[0]).join(', '));

  // Use first 20 servers for comparison
  const sample = machines.slice(0, 20);
  const servers = sample.map(r => ({
    '*Server name': r['Machine name'] || r.Machine || r['Machine Name'] || Object.values(r)[0],
    '*Cores': r.Cores || r['Cores'],
    '*Memory (In MB)': r['Memory (MB)'] || r['Memory(MB)'],
    '*OS name': r['Operating system'] || r['OS Name'] || 'Windows',
    'OS version': '',
    'Storage in use (In GB)': r['Storage (GB)'] || r['Storage(GB)'] || 100,
    'Disk 1 size (In GB)': r['Storage (GB)'] || r['Storage(GB)'] || 100,
  }));

  console.log('\nSample server[0]:', JSON.stringify(servers[0]));
  console.log('Sample raw[0]:', JSON.stringify(sample[0]).substring(0, 300));

  // Series matching Azure Migrate: D + E only
  const series = ['Standard_D', 'Standard_E'];
  
  // Run with AMD filter
  console.log('\n=== AMD MODE (should match Azure Migrate) ===');
  const firstPassAmd = assessment.runFirstPassMatching(servers, vmSizes, series, 'amd');
  
  // Find the correct column name for recommended size
  const recKey = Object.keys(sample[0]).find(k => k.toLowerCase().includes('recommended')) || 'Recommended size';
  const nameKey = Object.keys(sample[0]).find(k => k.toLowerCase().includes('machine')) || 'Machine';
  
  console.log('Machine'.padEnd(25) + 'AzMigrate VM'.padEnd(24) + 'Our VM (AMD)'.padEnd(24) + 'Match?');
  console.log('-'.repeat(90));
  let matchCount = 0;
  for (let i = 0; i < sample.length; i++) {
    const azVm = sample[i][recKey] || 'N/A';
    const ourVm = firstPassAmd[i].vmMatch?.name || 'No match';
    const machineName = (sample[i][nameKey] || '').substring(0, 24);
    const match = azVm === ourVm ? '✓' : '';
    if (azVm === ourVm) matchCount++;
    console.log(`${machineName.padEnd(25)}${azVm.padEnd(24)}${ourVm.padEnd(24)}${match}`);
  }
  console.log(`\nExact match: ${matchCount}/${sample.length}`);
}

main().catch(e => console.error(e));
