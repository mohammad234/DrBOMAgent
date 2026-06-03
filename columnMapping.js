/**
 * Column mapping from ABMB Inventory List to Azure Migrate Import Template.
 * 
 * Keys = Azure Migrate template columns
 * Values = source column name from the inventory xlsx, or a function that derives the value.
 */

const columnMapping = {
  // Direct mappings (source column name)
  "*Server name": "Host name",
  "IP addresses": "IP Address",
  "*Cores": (row) => {
    // vCores = CPU count (sockets) × CPU core count (cores/socket) × CPU core thread (threads/core)
    const sockets = parseInt(row["CPU count"]) || 0;
    const coresPerSocket = parseInt(row["CPU core count"]) || 1;
    const threadsPerCore = parseInt(row["CPU core thread"]) || 1;
    return sockets * coresPerSocket * threadsPerCore;
  },
  "*Memory (In MB)": "RAM (MB)",
  "OS version": "OS Version",

  // Derived mappings (functions that receive the source row object)
  "*OS name": (row) => {
    const os = row["Operating System"] || "";
    const version = row["OS Version"] || "";
    return `${os} ${version}`.trim();
  },

  "OS architecture": (row) => {
    // Extract architecture from Description field and map to Azure Migrate valid values
    // Valid: x64, x86, amd64, 32-bit, 64-bit
    const desc = row["Description"] || "";
    if (desc.includes("x86_64") || desc.includes("amd64")) return "x64";
    if (desc.includes("i686") || desc.includes("i386")) return "x86";
    if (desc.includes("aarch64")) return "64-bit";
    return "";
  },

  "Server type": (row) => {
    const isVirtual = (row["Is Virtual"] || "").toString().toUpperCase();
    if (isVirtual === "TRUE") return "Virtual";
    if (isVirtual === "FALSE") return "Physical";
    return "";
  },

  "Hypervisor": (row) => {
    const manufacturer = row["Manufacturer"] || "";
    if (manufacturer.toLowerCase().includes("vmware")) return "Vmware";
    if (manufacturer.toLowerCase().includes("hyper-v") || manufacturer.toLowerCase().includes("microsoft")) return "Hyper-V";
    if (manufacturer.toLowerCase().includes("xen")) return "Xen";
    // KVM is not a valid Azure Migrate hypervisor value, leave empty
    return "";
  },

  "Storage in use (In GB)": "Disk space (GB)",
  "Number of disks": () => "1",
  "Disk 1 size (In GB)": "Disk space (GB)",

  // Columns with no mapping (will be empty)
  "CPU utilization percentage": null,
  "Memory utilization percentage": null,
  "Network adapters": null,
  "Network In throughput": null,
  "Network Out throughput": null,
  "Boot type": null,
  "Disk 1 read throughput (MB per second)": null,
  "Disk 1 write throughput (MB per second)": null,
  "Disk 1 read ops (operations per second)": null,
  "Disk 1 write ops (operations per second)": null,
  "Disk 2 size (In GB)": null,
  "Disk 2 read throughput (MB per second)": null,
  "Disk 2 write throughput (MB per second)": null,
  "Disk 2 read ops (operations per second)": null,
  "Disk 2 write ops (operations per second)": null,
};

module.exports = columnMapping;
