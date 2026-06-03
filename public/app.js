// ============ STATE ============
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
  stepsCompleted: { 1: false, 2: false, 3: false, 4: false, 5: false, 6: false, 7: false },
};

const steps = document.querySelectorAll(".step");
const panels = document.querySelectorAll(".panel");

// ============ MAKE ALL STEPS CLICKABLE ============
steps.forEach(s => {
  s.style.cursor = "pointer";
  s.addEventListener("click", () => {
    const n = parseInt(s.dataset.step);
    goToStep(n);
  });
});

// ============ CONFIG PANEL LOGIC ============
const configPanel = document.getElementById("configPanel");
const panelOverlay = document.getElementById("panelOverlay");

document.getElementById("openConfigPanel").addEventListener("click", () => openPanel());
document.getElementById("closeConfigPanel").addEventListener("click", () => closePanel());
panelOverlay.addEventListener("click", () => closePanel());

function openPanel() {
  configPanel.classList.add("open");
  panelOverlay.classList.remove("hidden");
}
function closePanel() {
  configPanel.classList.remove("open");
  panelOverlay.classList.add("hidden");
}

// ============ ON LOAD: Check pre-auth and LLM status ============
(async function init() {
  try {
    const authRes = await fetch("/api/auth/status");
    const authStatus = await authRes.json();
    if (authStatus.authenticated) {
      const claimRes = await fetch("/api/auth/claim-preauth", { method: "POST" });
      const claimData = await claimRes.json();
      if (claimData.success) {
        state.tokenId = claimData.tokenId;
        setAzureConnected(true);
        loadSubscriptions();
      }
    }
  } catch (e) {
    console.log("Auth check skipped:", e.message);
  }
  // LLM badge only shows when user explicitly selects endpoint+deployment in config panel
  // Do NOT auto-activate from saved config or server memory
})();

function setAzureConnected(connected) {
  state.azureConnected = connected;
  const indicator = document.getElementById("azureStatusIndicator");
  const loggedOutView = document.getElementById("azureLoggedOutView");
  const loggedInView = document.getElementById("azureLoggedInView");
  const subSelect = document.getElementById("subscriptionSelect");
  const notice = document.getElementById("needLoginNotice");

  if (connected) {
    indicator.className = "status-indicator on"; indicator.title = "Connected";
    loggedOutView.classList.add("hidden"); loggedInView.classList.remove("hidden");
    subSelect.disabled = false;
    if (notice) notice.classList.add("hidden");
  } else {
    indicator.className = "status-indicator off"; indicator.title = "Not connected";
    loggedOutView.classList.remove("hidden"); loggedInView.classList.add("hidden");
    subSelect.disabled = true;
    if (notice) notice.classList.remove("hidden");
  }
}

function setLlmConnected(configured) {
  state.llmConfigured = configured;
  const indicator = document.getElementById("llmStatusIndicator");
  const badge = document.getElementById("agenticModeLabel");
  const toggle = document.getElementById("aiModeToggle");
  const llmOptContainer = document.getElementById("llmOptToggleContainer");
  if (configured && state.azureConnected) {
    indicator.className = "status-indicator on"; indicator.title = "Configured";
    badge.classList.remove("hidden");
    if (toggle) toggle.checked = true;
    if (llmOptContainer) llmOptContainer.classList.remove("hidden");
  } else {
    indicator.className = "status-indicator off"; indicator.title = "Not configured";
    badge.classList.add("hidden");
    if (toggle) toggle.checked = false;
    if (llmOptContainer) llmOptContainer.classList.add("hidden");
  }
}

// AI Mode toggle — allows user to disable AI without removing config
document.getElementById("aiModeToggle").addEventListener("change", (e) => {
  state.llmConfigured = e.target.checked;
  const badge = document.getElementById("agenticModeLabel");
  const indicator = document.getElementById("llmStatusIndicator");
  if (e.target.checked) {
    badge.querySelector("span").innerHTML = '<i class="bi bi-lightning"></i> AI Mode: ON';
    indicator.className = "status-indicator on"; indicator.title = "Configured";
  } else {
    badge.querySelector("span").innerHTML = '<i class="bi bi-lightning"></i> AI Mode: OFF';
    indicator.className = "status-indicator off"; indicator.title = "Disabled by user";
  }
});

// ============ AZURE LOGIN ============
document.getElementById("azureLoginBtn").addEventListener("click", async () => {
  const btn = document.getElementById("azureLoginBtn");
  const deviceCodeBox = document.getElementById("deviceCodeBox");
  btn.disabled = true; btn.textContent = "Logging in...";
  deviceCodeBox.classList.remove("hidden");
  deviceCodeBox.innerHTML = '<p style="color:#6db3f2;text-align:center;margin:8px 0;">Authenticating via Azure CLI...</p>';

  try {
    const res = await fetch("/api/auth/device-code", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    if (data.status === "success") {
      state.tokenId = data.tokenId;
      setAzureConnected(true);
      loadSubscriptions();
      deviceCodeBox.classList.add("hidden");
      btn.textContent = "\u{1F512} Login to Azure"; btn.disabled = false;
      showStatus("loginStatus", "Connected!", "success");
    } else { throw new Error(data.error || "Login failed"); }
  } catch (e) {
    deviceCodeBox.classList.add("hidden");
    btn.textContent = "\u{1F512} Login to Azure"; btn.disabled = false;
    showStatus("loginStatus", `Error: ${e.message}`, "error");
  }
});

// ============ SUBSCRIPTIONS ============
async function loadSubscriptions() {
  const sel = document.getElementById("subscriptionSelect");
  sel.innerHTML = '<option value="">Loading...</option>';
  try {
    const res = await fetch("/api/azure/subscriptions", { headers: { "X-Token-Id": state.tokenId } });
    if (!res.ok) throw new Error((await res.json()).error);
    const subs = await res.json();
    sel.innerHTML = '<option value="">-- Select Subscription --</option>';
    subs.forEach(s => {
      const o = document.createElement("option");
      o.value = s.subscriptionId;
      o.textContent = `${s.displayName} (${s.subscriptionId})`;
      sel.appendChild(o);
    });
  } catch {
    sel.innerHTML = '<option value="">Failed to load</option>';
  }
}

document.getElementById("subscriptionSelect").addEventListener("change", (e) => {
  state.subscriptionId = e.target.value;
  updateSubIndicator();
  if (state.subscriptionId) loadOpenAIAccounts();
});

function updateSubIndicator() {
  const ind = document.getElementById("subStatusIndicator");
  if (state.subscriptionId) { ind.className = "status-indicator on"; ind.title = "Selected"; }
  else { ind.className = "status-indicator off"; ind.title = "Not selected"; }
}

// ============ AZURE OPENAI — Dropdown fetch ============
async function loadOpenAIAccounts() {
  const sel = document.getElementById("openaiAccountSelect");
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading OpenAI resources...</option>';
  try {
    const res = await fetch(`/api/azure/openai-accounts?subscriptionId=${encodeURIComponent(state.subscriptionId)}`, {
      headers: { "X-Token-Id": state.tokenId },
    });
    const accounts = await res.json();
    if (!res.ok) { sel.innerHTML = `<option value="">Error: ${accounts.error}</option>`; return; }
    if (accounts.length === 0) { sel.innerHTML = '<option value="">No OpenAI resources found</option>'; return; }
    sel.innerHTML = '<option value="">-- Select OpenAI Resource --</option>';
    accounts.forEach(a => {
      const o = document.createElement("option");
      o.value = JSON.stringify({ id: a.id, endpoint: a.endpoint, name: a.name });
      o.textContent = `${a.name} (${a.location})`;
      sel.appendChild(o);
    });
    sel.disabled = false;
  } catch (e) { sel.innerHTML = `<option value="">Error: ${e.message}</option>`; }
}

document.getElementById("openaiAccountSelect").addEventListener("change", async (e) => {
  const depSel = document.getElementById("openaiDeploymentSelect");
  if (!e.target.value) { depSel.innerHTML = '<option value="">Select resource first</option>'; depSel.disabled = true; return; }
  const account = JSON.parse(e.target.value);
  depSel.disabled = true;
  depSel.innerHTML = '<option value="">Loading deployments...</option>';
  try {
    const res = await fetch(`/api/azure/openai-deployments?accountId=${encodeURIComponent(account.id)}`, {
      headers: { "X-Token-Id": state.tokenId },
    });
    const deployments = await res.json();
    if (!res.ok) { depSel.innerHTML = `<option value="">Error: ${deployments.error}</option>`; return; }
    if (deployments.length === 0) { depSel.innerHTML = '<option value="">No deployments found</option>'; return; }
    depSel.innerHTML = '<option value="">-- Select Deployment --</option>';
    deployments.forEach(d => {
      const o = document.createElement("option");
      o.value = d.name;
      o.textContent = `${d.name} (${d.model} ${d.modelVersion})`;
      depSel.appendChild(o);
    });
    depSel.disabled = false;
  } catch (e) { depSel.innerHTML = `<option value="">Error: ${e.message}</option>`; }
});

// Provider type toggle
document.getElementById("aiProviderType").addEventListener("change", (e) => {
  const isServerless = e.target.value === "serverless";
  document.getElementById("azureOpenAISection").classList.toggle("hidden", isServerless);
  document.getElementById("serverlessSection").classList.toggle("hidden", !isServerless);
  setLlmConnected(false);
  document.getElementById("llmConfigStatus").textContent = "";
  // Load serverless endpoints if selected
  if (isServerless && state.subscriptionId) loadServerlessEndpoints();
});

// Load serverless model endpoints
async function loadServerlessEndpoints() {
  const sel = document.getElementById("serverlessEndpointSelect");
  sel.disabled = true;
  sel.innerHTML = '<option value="">Loading serverless models...</option>';
  try {
    const res = await fetch(`/api/azure/serverless-endpoints?subscriptionId=${encodeURIComponent(state.subscriptionId)}`, {
      headers: { "X-Token-Id": state.tokenId },
    });
    const endpoints = await res.json();
    if (!res.ok) { sel.innerHTML = `<option value="">Error: ${endpoints.error}</option>`; return; }
    if (endpoints.length === 0) { sel.innerHTML = '<option value="">No serverless models found</option>'; return; }
    sel.innerHTML = '<option value="">-- Select Model --</option>';
    endpoints.forEach(ep => {
      const o = document.createElement("option");
      o.value = JSON.stringify({ endpoint: ep.endpoint, model: ep.model, name: ep.name });
      o.textContent = `${ep.name} (${ep.model}) - ${ep.workspace}`;
      sel.appendChild(o);
    });
    sel.disabled = false;
  } catch (e) { sel.innerHTML = `<option value="">Error: ${e.message}</option>`; }
}

// Configure serverless endpoint
document.getElementById("serverlessEndpointSelect").addEventListener("change", async () => {
  const sel = document.getElementById("serverlessEndpointSelect");
  const apiKeyInput = document.getElementById("serverlessApiKey");
  if (!sel.value) { setLlmConnected(false); return; }

  const ep = JSON.parse(sel.value);
  const apiKey = apiKeyInput.value.trim();
  if (!apiKey) {
    document.getElementById("llmConfigStatus").textContent = "Enter API key for this endpoint";
    return;
  }

  try {
    const res = await fetch("/api/llm/config", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token-Id": state.tokenId },
      body: JSON.stringify({ endpoint: ep.endpoint, deploymentName: ep.model, apiKey, providerType: "serverless" }),
    });
    const data = await res.json();
    if (data.success) {
      setLlmConnected(true);
      document.getElementById("llmConfigStatus").textContent = "\u2713 Connected (Serverless)!";
    } else {
      document.getElementById("llmConfigStatus").textContent = "Error: " + (data.error || "Config failed");
    }
  } catch (e) {
    document.getElementById("llmConfigStatus").textContent = "Error: " + e.message;
  }
});

// Also trigger config when API key is entered
document.getElementById("serverlessApiKey").addEventListener("change", () => {
  const sel = document.getElementById("serverlessEndpointSelect");
  if (sel.value) sel.dispatchEvent(new Event("change"));
});

// Auto-save LLM config when deployment is selected
document.getElementById("openaiDeploymentSelect").addEventListener("change", async (e) => {
  const accountSel = document.getElementById("openaiAccountSelect");
  const depSel = document.getElementById("openaiDeploymentSelect");
  if (!accountSel.value || !depSel.value) {
    setLlmConnected(false);
    document.getElementById("llmConfigStatus").textContent = "";
    return;
  }

  const account = JSON.parse(accountSel.value);
  const deploymentName = depSel.value;
  const endpoint = account.endpoint;

  try {
    const res = await fetch("/api/llm/config", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token-Id": state.tokenId },
      body: JSON.stringify({ endpoint, deploymentName, useTokenAuth: true, providerType: "azure-openai" }),
    });
    const data = await res.json();
    if (data.success) {
      setLlmConnected(true);
      document.getElementById("llmConfigStatus").textContent = "\u2713 Connected!";
    } else {
      document.getElementById("llmConfigStatus").textContent = "Error: " + (data.error || "Config failed");
    }
  } catch (e) {
    document.getElementById("llmConfigStatus").textContent = "Error: " + e.message;
  }
});

// ============ NAVIGATION ============
function goToStep(n) {
  state.currentStep = n;
  steps.forEach((s, i) => {
    s.classList.remove("active", "done");
    if (state.stepsCompleted[i + 1]) s.classList.add("done");
    if (i + 1 === n) s.classList.add("active");
  });
  panels.forEach(p => p.classList.add("hidden"));
  document.getElementById(`step${n}`).classList.remove("hidden");
  window.scrollTo({ top: 0, behavior: "smooth" });
  // Update customer name display on all steps
  updateCustomerNameDisplay();
  // Initialize Step 5 pricing when navigating there or to steps that depend on it
  if (n >= 5 && state.assessmentReport && !state.step5Initialized) initStep5Pricing();
  // Always refresh BOM when navigating to Step 6 so LZ/BCDR changes are reflected
  if (n === 6 && state.assessmentReport) populateBOM();
  // Initialize Wave Plan when navigating to Step 7
  if (n === 7) initWavePlan();
}

// ============ STEP 1: UPLOAD ============
const uploadArea = document.getElementById("uploadArea");
const fileInput = document.getElementById("fileInput");
const uploadProgress = document.getElementById("uploadProgress");
const uploadError = document.getElementById("uploadError");

uploadArea.addEventListener("click", () => fileInput.click());
uploadArea.addEventListener("dragover", e => { e.preventDefault(); uploadArea.classList.add("dragover"); });
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
uploadArea.addEventListener("drop", e => { e.preventDefault(); uploadArea.classList.remove("dragover"); if (e.dataTransfer.files[0]) uploadFile(e.dataTransfer.files[0]); });
fileInput.addEventListener("change", () => { if (fileInput.files[0]) uploadFile(fileInput.files[0]); });

async function uploadFile(file) {
  const customerInput = document.getElementById("customerNameInput");
  const nameVal = (customerInput.value || "").trim();
  if (!nameVal) {
    customerInput.classList.add("is-invalid");
    customerInput.focus();
    fileInput.value = ""; // Reset so re-selecting same file triggers change event
    return;
  }
  customerInput.classList.remove("is-invalid");
  state.customerName = nameVal;
  uploadError.classList.add("hidden");
  uploadProgress.classList.remove("hidden");
  const fill = uploadProgress.querySelector(".progress-bar");
  fill.style.width = "40%"; fill.textContent = `Processing ${file.name}...`;

  const form = new FormData();
  form.append("inventory", file);

  try {
    const res = await fetch("/api/upload", { method: "POST", body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    fill.style.width = "100%"; fill.textContent = "Done!";
    state.sessionId = data.sessionId;
    state.stepsCompleted[1] = true;
    setTimeout(() => { populateResults(data); goToStep(2); }, 400);
  } catch (err) {
    uploadProgress.classList.add("hidden");
    uploadError.classList.remove("hidden");
    uploadError.textContent = `Error: ${err.message}`;
    fileInput.value = ""; // Reset so same file can be retried
  }
}

// ============ STEP 2: REVIEW ============
function populateResults(data) {
  state.lastSourceColumns = data.sourceColumns || [];
  state.lastUploadData = data; // store for after accept

  // Render column mapping table (PRIMARY focus)
  const tbody = document.querySelector("#columnMappingTable tbody");
  tbody.innerHTML = "";
  if (data.mappingInfo && data.mappingInfo.length > 0) {
    data.mappingInfo.forEach(m => {
      const tr = document.createElement("tr");
      const isMapped = m.type === "direct" || m.type === "computed";
      const sourceText = m.source || "—";
      const reason = m.reason || (isMapped ? "Mapped" : "No mapping");
      const rowClass = isMapped ? "mapping-row-ok" : "mapping-row-miss";
      tr.className = rowClass;
      tr.innerHTML = `<td>${esc(sourceText)}</td><td>${esc(m.target)}</td><td>${esc(reason)}</td>`;
      tbody.appendChild(tr);
    });
  }

  // Hide conversion results until user accepts
  document.getElementById("conversionResults").classList.add("hidden");
  document.getElementById("proceedToProject").classList.add("hidden");
}

// Accept Mapping button — show conversion results and enable proceed
document.getElementById("acceptMappingBtn").addEventListener("click", () => {
  const data = state.lastUploadData;
  if (!data) return;

  // Show conversion results
  document.getElementById("conversionResults").classList.remove("hidden");
  document.getElementById("validCount").textContent = data.validRows;
  document.getElementById("invalidCount").textContent = data.invalidRows;
  document.getElementById("totalCount").textContent = data.totalRows;

  const errSec = document.getElementById("errorsSection");
  if (data.errors && data.errors.length > 0) {
    errSec.classList.remove("hidden");
    const tbody = document.querySelector("#errorsTable tbody");
    tbody.innerHTML = "";
    data.errors.forEach(e => {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${esc(e.serverName)}</td><td>${esc(e.error)}</td>`;
      tbody.appendChild(tr);
    });
  } else { errSec.classList.add("hidden"); }

  document.getElementById("reportContent").textContent = data.report;

  // Enable proceed button
  document.getElementById("proceedToProject").classList.remove("hidden");
  document.getElementById("mappingAcceptStatus").textContent = "\u2713 Mapping accepted. Azure Migrate CSV generated.";
  document.getElementById("mappingAcceptStatus").style.color = "#28a745";
  state.stepsCompleted[2] = true;
});

document.getElementById("downloadAzMigrate").addEventListener("click", () => window.open(`/api/download/${state.sessionId}/azmigrate`));
document.getElementById("downloadExcluded").addEventListener("click", () => window.open(`/api/download/${state.sessionId}/excluded`));
document.getElementById("downloadReport").addEventListener("click", () => window.open(`/api/download/${state.sessionId}/report`));
document.getElementById("reuploadBtn").addEventListener("click", () => { uploadProgress.classList.add("hidden"); fileInput.value = ""; goToStep(1); });
document.getElementById("proceedToProject").addEventListener("click", () => { detectAndBuildEnvTabs(); goToStep(3); });

// AI Fix Mapping button (in column mapping table)
document.getElementById("aiFixMappingBtn").addEventListener("click", async () => {
  const btn = document.getElementById("aiFixMappingBtn");
  btn.disabled = true; btn.textContent = "AI is analyzing mapping...";

  try {
    const res = await fetch("/api/llm/suggest-mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceColumns: state.lastSourceColumns || [] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    // Update the mapping table with AI suggestions
    const tbody = document.querySelector("#columnMappingTable tbody");
    const suggestion = data.suggestion || {};
    tbody.innerHTML = "";
    for (const [targetCol, val] of Object.entries(suggestion)) {
      const tr = document.createElement("tr");
      const sourceText = val === null ? "—" : (typeof val === "object" ? (val.formula || JSON.stringify(val)) : val);
      const isMapped = val !== null;
      const reason = val === null ? "No match found" : (typeof val === "object" ? "Computed (AI)" : "AI matched");
      tr.className = isMapped ? "mapping-row-ok" : "mapping-row-miss";
      tr.innerHTML = `<td>${esc(sourceText)}</td><td>${esc(targetCol)}</td><td>${esc(reason)}</td>`;
      tbody.appendChild(tr);
    }
    btn.textContent = "\u2713 AI Mapping Applied";
  } catch (err) {
    alert(`AI error: ${err.message}`);
    btn.textContent = "\u{1F916} Let AI Agent Handle Mapping";
  }
  btn.disabled = false;
});

// ============ STEP 3: VM ASSESSMENT ============

// VM Series — default set
const VM_SERIES_DEFAULT = [
  { id: "Standard_A", name: "A-Series", defaultEnabled: false },
  { id: "Standard_B", name: "B-Series (Burstable)", defaultEnabled: false },
  { id: "Standard_D", name: "D-Series (General)", defaultEnabled: true },
  { id: "Standard_E", name: "E-Series (Memory)", defaultEnabled: true },
  { id: "Standard_F", name: "F-Series (Compute)", defaultEnabled: false },
  { id: "Standard_L", name: "L-Series (Storage)", defaultEnabled: false },
  { id: "Standard_M", name: "M-Series (Large)", defaultEnabled: false },
];

// Multi-environment state
state.environments = ["All"];
state.envConfigs = {};
state.envReports = {};
state.envNeedsRerun = {};
state.envComplete = {};
state.combinedSummary = null;

// Customer name global
document.getElementById("customerNameInput").addEventListener("input", (e) => {
  state.customerName = e.target.value.trim();
  if (state.customerName) e.target.classList.remove("is-invalid");
  updateCustomerNameDisplay();
});

function updateCustomerNameDisplay() {
  const name = state.customerName || "";
  const text = name ? `Customer: ${name}` : "";
  ["step2CustomerName", "step3CustomerName", "step4CustomerName", "step5CustomerName", "step6CustomerName", "step7CustomerName"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  });
}

// Region pre-fetch
document.getElementById("targetRegionSelect").addEventListener("change", async () => {
  const region = document.getElementById("targetRegionSelect").value;
  const statusEl = document.getElementById("regionCacheStatus");
  statusEl.textContent = "Pre-fetching SKUs...";
  try {
    const res = await fetch(`/api/assessment/prefetch-region?region=${region}`);
    const data = await res.json();
    statusEl.textContent = `\u2713 ${data.skuCount} SKUs cached`;
    if (data.securityPerServer) state.securityPricePerServer = data.securityPerServer;
    setTimeout(() => { statusEl.textContent = ""; }, 3000);
  } catch (e) { statusEl.textContent = "Cache fetch failed"; }
});

// Build environment tabs after step 2 completes
async function detectAndBuildEnvTabs() {
  if (!state.sessionId) return;
  try {
    const res = await fetch(`/api/session/${state.sessionId}/environments`);
    const data = await res.json();
    state.environments = data.environments || ["All"];
    state.envCounts = data.envCounts || {};
    buildEnvTabs(state.environments, state.envCounts);
  } catch (e) {
    state.environments = ["All"];
    state.envCounts = {};
    buildEnvTabs(["All"], {});
  }
}

function buildEnvTabs(environments, envCounts) {
  const tabList = document.getElementById("envTabs");
  const tabContent = document.getElementById("envTabContent");
  tabList.innerHTML = "";
  tabContent.innerHTML = "";

  environments.forEach((env, idx) => {
    const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
    const count = envCounts[env] || "";
    const isFirst = idx === 0;

    // Tab nav item
    const li = document.createElement("li");
    li.className = "nav-item";
    li.innerHTML = `<button class="nav-link ${isFirst ? "active" : ""} py-2 px-3" id="tab-${envId}" data-bs-toggle="tab" data-bs-target="#pane-${envId}" type="button" role="tab">
      ${esc(env)}${count ? ` <span class="badge bg-secondary">${count}</span>` : ""}
      <span id="envStatus-${envId}" class="env-status-badge ms-1"></span>
    </button>`;
    tabList.appendChild(li);

    // Tab pane with config
    const pane = document.createElement("div");
    pane.className = `tab-pane fade ${isFirst ? "show active" : ""} env-tab-pane`;
    pane.id = `pane-${envId}`;
    pane.setAttribute("role", "tabpanel");
    pane.innerHTML = buildEnvConfigHtml(env, envId);
    tabContent.appendChild(pane);

    // Init default config for this env
    state.envConfigs[env] = {
      pricingModel: "3yr_ri",
      useAhub: true,
      enabledSeries: VM_SERIES_DEFAULT.filter(s => s.defaultEnabled).map(s => s.id),
      cpuArchitecture: "amd",
      storageTier: "auto",
      securityEnabled: true,
    };
    state.envNeedsRerun[env] = true;
    state.envComplete[env] = false;
  });

  // Attach event listeners to all env config controls
  environments.forEach(env => {
    const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
    // Pricing/AHUB/Security changes → instant recalculate for this env
    const pricingSel = document.getElementById(`pricing-${envId}`);
    const ahubSel = document.getElementById(`ahub-${envId}`);
    const secCheck = document.getElementById(`security-${envId}`);
    const archSel = document.getElementById(`arch-${envId}`);
    const storageSel = document.getElementById(`storage-${envId}`);

    if (pricingSel) pricingSel.addEventListener("change", () => { updateEnvConfig(env); recalculateEnv(env); });
    if (ahubSel) ahubSel.addEventListener("change", () => { updateEnvConfig(env); recalculateEnv(env); });
    if (secCheck) secCheck.addEventListener("change", () => { updateEnvConfig(env); recalculateEnv(env); });
    // Arch/series/storage changes → mark needs re-run
    if (archSel) archSel.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); });
    if (storageSel) storageSel.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); });

    // Series checkboxes
    const seriesCbs = document.querySelectorAll(`#series-${envId} input[type=checkbox]`);
    seriesCbs.forEach(cb => cb.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); }));
  });
}

function buildEnvConfigHtml(env, envId) {
  const seriesHtml = VM_SERIES_DEFAULT.map(s => {
    const checked = s.defaultEnabled ? "checked" : "";
    return `<label class="d-inline-flex align-items-center gap-1 px-2 py-1 bg-white border rounded small" style="cursor:pointer;">
      <input type="checkbox" value="${s.id}" ${checked}> ${s.name}
    </label>`;
  }).join("");

  return `
    <div id="envRerun-${envId}" class="alert alert-warning py-1 px-2 small mb-2 hidden"><i class="bi bi-exclamation-triangle"></i> Config changed — re-run assessment needed</div>
    <div class="card bg-light">
      <div class="card-body p-3">
        <div class="mb-3">
          <label class="form-label small fw-semibold mb-1">VM Series:</label>
          <div id="series-${envId}" class="d-flex flex-wrap gap-2">${seriesHtml}</div>
        </div>
        <div class="mb-3">
          <label class="form-label small fw-semibold mb-1">CPU Architecture:</label>
          <select class="form-select form-select-sm" id="arch-${envId}" style="max-width:280px;">
            <option value="amd" selected>AMD (Recommended)</option>
            <option value="intel">Intel</option>
            <option value="auto">Automatic (Best Fit)</option>
          </select>
        </div>
        <div class="mb-3">
          <label class="form-label small fw-semibold mb-1">Storage:</label>
          <select class="form-select form-select-sm" id="storage-${envId}" style="max-width:280px;">
            <option value="auto" selected>As per IOPS/Throughput (Default)</option>
            <option value="PremiumSSD">Premium SSD (Override)</option>
            <option value="StandardSSD">Standard SSD (Override)</option>
            <option value="StandardHDD">Standard HDD (Override)</option>
          </select>
        </div>
        <div class="row g-3 mb-3">
          <div class="col-md-6">
            <label class="form-label small fw-semibold mb-1">Pricing Model:</label>
            <select class="form-select form-select-sm" id="pricing-${envId}">
              <option value="payg">Pay As You Go</option>
              <option value="1yr_ri">1-Year Reserved Instance</option>
              <option value="3yr_ri" selected>3-Year Reserved Instance</option>
            </select>
          </div>
          <div class="col-md-6">
            <label class="form-label small fw-semibold mb-1">License:</label>
            <select class="form-select form-select-sm" id="ahub-${envId}">
              <option value="ahub" selected>Azure Hybrid Benefit (AHUB)</option>
              <option value="no_ahub">No AHUB (Include License)</option>
            </select>
          </div>
        </div>
        <div class="form-check">
          <input type="checkbox" class="form-check-input" id="security-${envId}" checked>
          <label class="form-check-label small fw-semibold" for="security-${envId}">Security (Defender for Server P2)</label>
        </div>
      </div>
    </div>
    <!-- Per-env progress & summary -->
    <div id="envProgress-${envId}" class="hidden mt-2">
      <div class="d-flex align-items-center gap-2 small">
        <div class="spinner-border spinner-border-sm text-primary" role="status"></div>
        <span id="envProgressText-${envId}">Assessing...</span>
      </div>
    </div>
    <div id="envSummary-${envId}" class="hidden mt-3">
      <div class="row g-2">
        <div class="col-4"><div class="summary-card-compute text-center p-2 rounded-3"><div class="fw-bold small" id="envCompute-${envId}">USD 0</div><div style="font-size:0.65em;opacity:0.8;">Compute</div></div></div>
        <div class="col-4"><div class="summary-card-storage text-center p-2 rounded-3"><div class="fw-bold small" id="envStorage-${envId}">USD 0</div><div style="font-size:0.65em;opacity:0.8;">Storage</div></div></div>
        <div class="col-4"><div class="summary-card-security text-center p-2 rounded-3"><div class="fw-bold small" id="envSecurity-${envId}">USD 0</div><div style="font-size:0.65em;opacity:0.8;">Security</div></div></div>
      </div>
    </div>
  `;
}

function updateEnvConfig(env) {
  const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
  const seriesCbs = document.querySelectorAll(`#series-${envId} input[type=checkbox]:checked`);
  state.envConfigs[env] = {
    pricingModel: document.getElementById(`pricing-${envId}`)?.value || "3yr_ri",
    useAhub: document.getElementById(`ahub-${envId}`)?.value === "ahub",
    enabledSeries: Array.from(seriesCbs).map(cb => cb.value),
    cpuArchitecture: document.getElementById(`arch-${envId}`)?.value || "amd",
    storageTier: document.getElementById(`storage-${envId}`)?.value || "auto",
    securityEnabled: document.getElementById(`security-${envId}`)?.checked !== false,
  };
}

function markNeedsRerun(env) {
  state.envNeedsRerun[env] = true;
  // Only show re-run indicator if assessment has run at least once for this env
  if (!state.envComplete[env]) return;
  const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
  const rerunEl = document.getElementById(`envRerun-${envId}`);
  if (rerunEl) rerunEl.classList.remove("hidden");
}

// Instant recalculate for single env (pricing/AHUB/security change)
async function recalculateEnv(env) {
  if (!state.envReports[env] || !state.sessionId) return;
  const region = document.getElementById("targetRegionSelect").value;
  const assessmentName = document.getElementById("assessmentNameInput").value.trim() || "Assessment";
  const config = state.envConfigs[env];

  try {
    const res = await fetch("/api/assessment/recalculate-env", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Token-Id": state.tokenId },
      body: JSON.stringify({ sessionId: state.sessionId, envName: env, region, assessmentName, ...config }),
    });
    if (res.ok) {
      const data = await res.json();
      state.envReports[env] = data.envReport;
      state.combinedSummary = data.combined;
      state.assessmentReport = data.combined;
      updateEnvSummary(env, data.envReport);
      updateCombinedTotal(data.combined);
      // Update Step 4 if rendered
      if (document.getElementById("assessSummaryCards").innerHTML) renderAssessmentReport(data.combined);
    }
  } catch (e) { console.error("Env recalculate error:", e.message); }
}

function updateEnvSummary(env, report) {
  const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
  const s = report.summary;
  document.getElementById(`envCompute-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlyCompute)}`;
  document.getElementById(`envStorage-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlyStorage)}`;
  document.getElementById(`envSecurity-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlySecurity)}`;
  document.getElementById(`envSummary-${envId}`).classList.remove("hidden");
}

function updateCombinedTotal(combined) {
  const s = combined.summary;
  document.getElementById("combinedCompute").textContent = `USD ${fmtCost(s.totalMonthlyCompute)}`;
  document.getElementById("combinedStorage").textContent = `USD ${fmtCost(s.totalMonthlyStorage)}`;
  document.getElementById("combinedSecurity").textContent = `USD ${fmtCost(s.totalMonthlySecurity)}`;
  document.getElementById("combinedTotal").textContent = `USD ${fmtCost(s.totalMonthlyCost)}`;
  document.getElementById("combinedTotalBar").classList.remove("hidden");
  // Show env pricing summary below combined bar
  renderEnvPricingSummary("envPricingSummary3");
}

function renderEnvPricingSummary(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const region = document.getElementById("targetRegionSelect")?.selectedOptions[0]?.text || document.getElementById("targetRegionSelect")?.value || "";
  const pricingLabels = { "payg": "Pay As You Go", "1yr_ri": "1 Yr RI", "3yr_ri": "3 Yr RI", "spot": "Spot" };
  const envs = state.environments || [];
  if (envs.length <= 1 && envs[0] === "All") {
    // Single env — simple display
    const config = state.envConfigs["All"] || {};
    const serverCount = state.envCounts?.["All"] || state.assessmentReport?.summary?.totalServers || 0;
    container.innerHTML = `
      <div class="card border-0 bg-light">
        <div class="card-body py-2 px-3 small">
          <strong><i class="bi bi-geo-alt"></i> Region:</strong> ${esc(region)}
          &nbsp;|&nbsp; <strong>Pricing:</strong> ${pricingLabels[config.pricingModel] || config.pricingModel || "N/A"}
          &nbsp;|&nbsp; <strong>License:</strong> ${config.useAhub ? "Azure Hybrid Benefit (AHUB)" : "Pay As You Go"}
          &nbsp;|&nbsp; <strong>Servers:</strong> ${serverCount}
        </div>
      </div>`;
  } else {
    // Multi-env — show per-env breakdown
    let rows = "";
    for (const env of envs) {
      const config = state.envConfigs[env] || {};
      const serverCount = state.envReports?.[env]?.summary?.totalServers || state.envCounts?.[env] || 0;
      const pricing = pricingLabels[config.pricingModel] || config.pricingModel || "N/A";
      const license = config.useAhub ? "AHUB" : "PAYG License";
      rows += `<tr><td class="fw-semibold">${esc(env)}</td><td>${serverCount} servers</td><td>${pricing}</td><td>${license}</td></tr>`;
    }
    container.innerHTML = `
      <div class="card border-0 bg-light">
        <div class="card-body py-2 px-3">
          <div class="small mb-1"><strong><i class="bi bi-geo-alt"></i> Region:</strong> ${esc(region)}</div>
          <table class="table table-sm table-borderless mb-0 small">
            <thead><tr><th>Environment</th><th>Servers</th><th>Pricing Model</th><th>License</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  }
  container.classList.remove("hidden");
}

// Run Assessment — multi-environment
// Clear assessment name validation on input
document.getElementById("assessmentNameInput").addEventListener("input", (e) => {
  if (e.target.value.trim()) e.target.classList.remove("is-invalid");
});

document.getElementById("runAssessmentBtn").addEventListener("click", async () => {
  const btn = document.getElementById("runAssessmentBtn");
  const assessmentName = document.getElementById("assessmentNameInput").value.trim();
  const region = document.getElementById("targetRegionSelect").value;
  const subId = state.subscriptionId || document.getElementById("subscriptionSelect").value;
  const errorEl = document.getElementById("assessmentError");

  if (!state.customerName || !state.customerName.trim()) { alert("Please enter Customer Name in the Setup panel (top-right gear icon)"); return; }
  if (!assessmentName) {
    const assessInput = document.getElementById("assessmentNameInput");
    assessInput.classList.add("is-invalid");
    assessInput.focus();
    return;
  }
  if (!state.sessionId) { alert("Please upload and map inventory first (Step 1 & 2)"); return; }

  // Collect configs for envs that need (re)run
  const envsToRun = {};
  for (const env of state.environments) {
    if (state.envNeedsRerun[env] || !state.envComplete[env]) {
      updateEnvConfig(env);
      if (state.envConfigs[env].enabledSeries.length === 0) { alert(`Select at least one VM series for ${env}`); return; }
      envsToRun[env] = state.envConfigs[env];
    }
  }

  if (Object.keys(envsToRun).length === 0) { alert("All environments are up to date."); return; }

  btn.disabled = true;
  errorEl.classList.add("hidden");
  const globalProgress = document.getElementById("globalAssessProgress");
  const globalText = document.getElementById("globalProgressText");
  const globalBar = document.getElementById("globalProgressBar");
  globalProgress.classList.remove("hidden");
  globalBar.style.width = "0%";
  globalText.textContent = "Starting assessment...";

  // Show per-env progress spinners
  for (const env of Object.keys(envsToRun)) {
    const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
    const el = document.getElementById(`envProgress-${envId}`);
    if (el) el.classList.remove("hidden");
  }

  try {
    const response = await fetch("/api/assessment/run-multi", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Token-Id": state.tokenId },
      body: JSON.stringify({ sessionId: state.sessionId, subscriptionId: subId, region, assessmentName, customerName: state.customerName, envConfigs: envsToRun, skipLlm: !document.getElementById("llmOptToggle").checked }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = JSON.parse(line.substring(6));

        if (data.type === "progress") {
          globalText.textContent = data.label;
          globalBar.style.width = "30%";
        } else if (data.type === "env-progress") {
          const pct = Math.round((data.envIdx / data.totalEnvs) * 70) + 30;
          globalBar.style.width = `${pct}%`;
          globalText.textContent = data.label;
          const envId = data.envName.replace(/[^a-zA-Z0-9]/g, "_");
          const txt = document.getElementById(`envProgressText-${envId}`);
          if (txt) txt.textContent = `Assessing ${data.envName} (${data.serverCount} servers)...`;
        } else if (data.type === "env-substatus") {
          // Sub-status update (e.g., LLM optimization batch progress)
          const envId = data.envName.replace(/[^a-zA-Z0-9]/g, "_");
          const txt = document.getElementById(`envProgressText-${envId}`);
          if (txt) txt.textContent = data.substatus;
          globalText.textContent = `${data.envName}: ${data.substatus}`;
        } else if (data.type === "env-complete") {
          const env = data.envName;
          const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
          state.envReports[env] = data.report;
          state.envComplete[env] = true;
          state.envNeedsRerun[env] = false;
          // Hide spinner, show green check, hide re-run indicator
          const progressEl = document.getElementById(`envProgress-${envId}`);
          if (progressEl) progressEl.classList.add("hidden");
          const rerunEl = document.getElementById(`envRerun-${envId}`);
          if (rerunEl) rerunEl.classList.add("hidden");
          const statusEl = document.getElementById(`envStatus-${envId}`);
          if (statusEl) statusEl.innerHTML = '<i class="bi bi-check-circle-fill text-success"></i>';
          updateEnvSummary(env, data.report);
        } else if (data.type === "all-complete") {
          globalBar.style.width = "100%";
          globalText.textContent = "All environments assessed!";
          setTimeout(() => { globalProgress.classList.add("hidden"); }, 2000);
          state.combinedSummary = data.combined;
          state.assessmentReport = data.combined;
          state.stepsCompleted[3] = true;
          // Force Step 5 and BOM to reinitialize with new assessment data
          state.step5ForceReset = true;
          state.step5Initialized = false;
          state.bomPopulated = false;
          updateCombinedTotal(data.combined);
          document.getElementById("proceedToResults").classList.remove("hidden");
        } else if (data.type === "error") {
          errorEl.classList.remove("hidden");
          errorEl.textContent = data.message;
        }
      }
    }
  } catch (e) {
    errorEl.classList.remove("hidden");
    errorEl.textContent = `Error: ${e.message}`;
    globalProgress.classList.add("hidden");
  }
  btn.disabled = false;
});

document.getElementById("backToStep2").addEventListener("click", () => goToStep(2));
document.getElementById("proceedToResults").addEventListener("click", () => { renderAssessmentReport(state.assessmentReport); goToStep(4); });

// ============ STEP 4: ASSESSMENT RESULTS ============

function renderAssessmentReport(report) {
  if (!report) return;

  // Show env pricing config summary at top of Step 4
  renderEnvPricingSummary("envPricingSummary4");

  // Summary cards
  const cards = document.getElementById("assessSummaryCards");
  const s = report.summary;
  cards.innerHTML = `
    <div class="col"><div class="assess-summary-card blue"><div class="card-value">${s.totalServers}</div><div class="card-label">Total Servers</div></div></div>
    <div class="col"><div class="assess-summary-card green"><div class="card-value">${s.suitable}</div><div class="card-label">Suitable</div></div></div>
    <div class="col"><div class="assess-summary-card orange"><div class="card-value">${s.notSuitable}</div><div class="card-label">Not Suitable</div></div></div>
    <div class="col"><div class="assess-summary-card blue"><div class="card-value">USD ${fmtCost(s.totalMonthlyCost)}</div><div class="card-label">Monthly Total</div></div></div>
    <div class="col"><div class="assess-summary-card purple"><div class="card-value">USD ${fmtCost(s.totalAnnualCost)}</div><div class="card-label">Annual Total</div></div></div>
    <div class="col"><div class="assess-summary-card blue"><div class="card-value">USD ${fmtCost(s.totalMonthlyCompute)}</div><div class="card-label">Compute/mo</div></div></div>
    <div class="col"><div class="assess-summary-card green"><div class="card-value">USD ${fmtCost(s.totalMonthlyStorage)}</div><div class="card-label">Storage/mo</div></div></div>
    <div class="col"><div class="assess-summary-card orange"><div class="card-value">USD ${fmtCost(s.totalMonthlySecurity)}</div><div class="card-label">Security/mo</div></div></div>
  `;

  // Cost breakdown
  const breakdown = document.getElementById("assessCostBreakdown");
  const pricingLabelsMap = { "payg": "Pay As You Go", "1yr_ri": "1 Yr RI", "3yr_ri": "3 Yr RI", "spot": "Spot" };
  let pricingModelHtml = "";
  const envs = state.environments || [];
  if (envs.length <= 1 && envs[0] === "All") {
    const config = state.envConfigs["All"] || {};
    pricingModelHtml = `<tr><td>Pricing Model:</td><td><strong>${pricingLabelsMap[config.pricingModel] || report.pricingModel}</strong></td></tr>
      <tr><td>License:</td><td><strong>${config.useAhub ? "Azure Hybrid Benefit (AHUB)" : "Pay As You Go"}</strong></td></tr>`;
  } else {
    pricingModelHtml = `<tr><td>Pricing Config:</td><td><strong>Multi-Environment (see above)</strong></td></tr>`;
  }
  breakdown.innerHTML = `
    <div class="card border-primary">
      <div class="card-body">
        <h6 class="fw-semibold mb-3">Cost Summary</h6>
        <table class="table table-sm mb-0 small">
          <tr><td>Assessment Name:</td><td><strong>${esc(report.assessmentName)}</strong></td></tr>
          <tr><td>Target Region:</td><td><strong>${report.region}</strong></td></tr>
          ${pricingModelHtml}
          <tr><td>Total Servers:</td><td><strong>${s.totalServers}</strong></td></tr>
          <tr class="border-top"><td>Monthly Compute:</td><td><strong>USD ${fmtCost(s.totalMonthlyCompute)}</strong></td></tr>
          <tr><td>Monthly Storage:</td><td><strong>USD ${fmtCost(s.totalMonthlyStorage)}</strong></td></tr>
          <tr><td>Monthly Security (Defender for Server P2):</td><td><strong>USD ${fmtCost(s.totalMonthlySecurity)}</strong></td></tr>
          <tr class="border-top border-primary"><td class="fw-bold fs-6">Total Monthly:</td><td class="fw-bold fs-6">USD ${fmtCost(s.totalMonthlyCost)}</td></tr>
          <tr><td class="fw-bold fs-6">Total Annual:</td><td class="fw-bold fs-6">USD ${fmtCost(s.totalAnnualCost)}</td></tr>
        </table>
      </div>
    </div>
  `;

  // Detect if "Application Name" column exists
  let hasAppName = false;
  let hasEnvironment = false;
  for (const srv of report.servers) {
    if (srv.extraColumns?.["Application Name"] || srv.extraColumns?.["Application"]) { hasAppName = true; }
    if (srv.environment) { hasEnvironment = true; }
    if (hasAppName && hasEnvironment) break;
  }
  const appNameKey = hasAppName ? (report.servers[0]?.extraColumns?.["Application Name"] !== undefined ? "Application Name" : "Application") : null;

  // Server detail table — selective columns only
  const thead = document.querySelector("#assessDetailTable thead");
  const tbody = document.querySelector("#assessDetailTable tbody");
  let headerHtml = `<th>#</th><th>Server Name</th>`;
  if (appNameKey) headerHtml += `<th>Application</th>`;
  if (hasEnvironment) headerHtml += `<th>Environment</th>`;
  headerHtml += `<th>OS</th><th>Cores</th><th>RAM (GB)</th><th>Recommended VM</th><th>Storage SKU</th><th>Compute/mo</th><th>Storage/mo</th><th>Security/mo</th><th>Total/mo</th>`;
  thead.innerHTML = `<tr>${headerHtml}</tr>`;

  tbody.innerHTML = report.servers.map((srv, i) => {
    const ramGB = Math.round(srv.memoryMB / 1024 * 10) / 10;
    const diskStr = srv.diskDetails?.map(d => d.azureTier).join(", ") || "-";
    let row = `<td>${i + 1}</td><td>${esc(srv.serverName)}</td>`;
    if (appNameKey) row += `<td>${esc(srv.extraColumns?.[appNameKey] || "")}</td>`;
    if (hasEnvironment) row += `<td>${esc(srv.environment || "")}</td>`;
    row += `<td>${esc(srv.osName)}</td>`;
    row += `<td>${srv.cores}</td>`;
    row += `<td>${ramGB}</td>`;
    row += `<td><strong>${esc(srv.recommendedVm)}</strong></td>`;
    row += `<td style="font-size:0.8em;">${esc(diskStr)}</td>`;
    row += `<td>$${fmtCost(srv.computeMonthlyCost)}</td>`;
    row += `<td>$${fmtCost(srv.storageMonthlyCost)}</td>`;
    row += `<td>$${fmtCost(srv.securityMonthlyCost || 0)}</td>`;
    row += `<td><strong>$${fmtCost(srv.totalMonthlyCost)}</strong></td>`;
    return `<tr>${row}</tr>`;
  }).join("");

  // Show "Next: BOM" button
  document.getElementById("proceedToAssessmentUpload").classList.remove("hidden");
}

function fmtCost(n) { return (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Copy table
document.getElementById("copyAssessTableBtn").addEventListener("click", () => {
  const table = document.getElementById("assessDetailTable");
  const range = document.createRange();
  range.selectNode(table);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  document.execCommand("copy");
  window.getSelection().removeAllRanges();
  alert("Table copied to clipboard!");
});

// Download Excel
document.getElementById("downloadAssessExcel").addEventListener("click", async () => {
  if (!state.assessmentReport) return;
  const report = state.assessmentReport;
  const region = document.getElementById("targetRegionSelect")?.selectedOptions[0]?.text || "";
  const customerName = state.customerName || "Customer";
  const assessName = report.assessmentName || "Assessment";

  // Build env info for the server
  const envReportsInfo = {};
  for (const env of (state.environments || ["All"])) {
    envReportsInfo[env] = { totalServers: state.envReports?.[env]?.summary?.totalServers || state.envCounts?.[env] || 0 };
  }

  try {
    const resp = await fetch("/api/export/assessment-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        customerName,
        assessmentName: assessName,
        region,
        environments: state.environments || ["All"],
        envConfigs: state.envConfigs,
        envReports: envReportsInfo,
        envCounts: state.envCounts,
      }),
    });
    if (!resp.ok) { alert("Export failed: " + (await resp.text())); return; }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${customerName}_${assessName}.xlsx`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export error: " + err.message);
  }
});

document.getElementById("backToStep3").addEventListener("click", () => goToStep(3));
document.getElementById("proceedToAssessmentUpload").addEventListener("click", () => { state.stepsCompleted[4] = true; initStep5Pricing(); goToStep(5); });

// Flag to track if Step 5 has been initialized (prevents reset on back/forth navigation)
state.step5Initialized = false;
state.step5ForceReset = false; // Set true when Run Assessment triggers re-init


// ============ STEP 5: LZ & BCDR ============

// Step 5 state
state.lzPricing = null; // cached landing zone SKU data
state.egressPricing = null;
state.backupPricing = null;
state.asrPricing = null;
state.step5Costs = { egress: 0, lz: 0, backup: 0, asr: 0 };

// Fetch all Step 5 pricing when entering Step 5
async function initStep5Pricing() {
  // If already initialized and not forced to reset, just recalculate with current selections
  if (state.step5Initialized && !state.step5ForceReset) {
    calculateEgressCost();
    calculateLZCosts();
    calculateBackupCost();
    calculateASRCost();
    return;
  }
  state.step5ForceReset = false;

  const region = document.getElementById("targetRegionSelect").value;
  const regionLabel = document.getElementById("targetRegionSelect").selectedOptions[0]?.text || region;
  const serverCount = state.assessmentReport ? state.assessmentReport.summary.totalServers : 0;

  // Show which region pricing is based on
  const regionNote = document.querySelector("#step5 .text-muted.small.mb-3");
  if (regionNote) regionNote.textContent = `Pricing for region: ${regionLabel}. All fields are editable.`;

  // Immediately populate BCDR checkboxes and egress defaults (no API needed)
  buildBCDREnvCheckboxes();
  document.getElementById("egressPerServer").value = 5;
  const defaultTotalGB = serverCount * 5;
  document.getElementById("egressTotalGB").value = defaultTotalGB;
  calculateEgressCost();
  calculateBackupCost();
  calculateASRCost();

  // Fetch all pricing in parallel (with 15s server-side timeout)
  const [egressRes, backupRes, asrRes, lzRes] = await Promise.all([
    fetch(`/api/pricing/egress?region=${region}`).then(r => r.json()).catch(() => null),
    fetch(`/api/pricing/backup?region=${region}`).then(r => r.json()).catch(() => null),
    fetch(`/api/pricing/asr?region=${region}`).then(r => r.json()).catch(() => null),
    fetch(`/api/pricing/landing-zone?region=${region}`).then(r => r.json()).catch(() => null),
  ]);

  state.egressPricing = egressRes;
  state.backupPricing = backupRes;
  state.asrPricing = asrRes;
  state.lzPricing = lzRes;

  // Update egress with fetched rate
  if (egressRes) {
    document.getElementById("egressRateInfo").textContent = `Rate: $${egressRes.ratePerGB}/GB (${regionLabel}) \u2014 first 5 GB free`;
    document.getElementById("egressPerServer").value = egressRes.benchmark?.conservative || 5;
    const totalGB = serverCount * (parseInt(document.getElementById("egressPerServer").value) || 5);
    document.getElementById("egressTotalGB").value = totalGB;
  }
  calculateEgressCost();

  // Populate Landing Zone SKU dropdowns
  if (lzRes && lzRes.components) {
    populateLZDropdown("lz_firewall_sku", lzRes.components.firewall, "Standard");
    populateLZDropdown("lz_vpn_sku", lzRes.components.vpnGateway, null);
    populateLZDropdown("lz_er_sku", lzRes.components.expressRoute, null);
    populateLZDropdown("lz_bastion_sku", lzRes.components.bastion, null);
    populateLZDropdown("lz_monitor_sku", lzRes.components.logAnalytics, null);
  }
  calculateLZCosts();

  // Recalculate BCDR with fetched pricing
  calculateBackupCost();
  calculateASRCost();

  state.step5Initialized = true;
}

function populateLZDropdown(selectId, componentData, defaultSku) {
  const select = document.getElementById(selectId);
  if (!select || !componentData) return;
  select.innerHTML = '<option value="0">-- None --</option>';
  const skus = componentData.skus || [];
  for (const sku of skus) {
    const opt = document.createElement("option");
    opt.value = sku.monthly;
    opt.textContent = `${sku.sku} ($${fmtCost(sku.monthly)}/mo)`;
    opt.dataset.skuName = sku.sku;
    if (defaultSku && sku.sku.toLowerCase().includes(defaultSku.toLowerCase())) opt.selected = true;
    select.appendChild(opt);
  }
  // If no match for default, select first real option
  if (defaultSku && select.selectedIndex === 0 && skus.length > 0) {
    select.selectedIndex = 1;
  }
}

function calculateEgressCost() {
  const egressEnabled = document.getElementById("egressEnabled").checked;
  const controlsDiv = document.getElementById("egressControls");

  // If egress is excluded, hide controls and set cost to 0
  if (!egressEnabled) {
    controlsDiv.classList.add("hidden");
    state.step5Costs.egress = 0;
    document.getElementById("egressCostBadge").textContent = `USD 0.00`;
    document.getElementById("egressCalcInfo").textContent = "Egress excluded from calculation";
    updateStep5Totals();
    return;
  }
  controlsDiv.classList.remove("hidden");

  const method = document.getElementById("egressMethod").value;
  const serverCount = state.assessmentReport ? state.assessmentReport.summary.totalServers : 0;
  const perServerGroup = document.getElementById("egressPerServerGroup");
  const totalGBInput = document.getElementById("egressTotalGB");
  const totalLabel = document.getElementById("egressTotalLabel");
  let totalGB;

  if (method === "per_server") {
    perServerGroup.classList.remove("hidden");
    totalLabel.textContent = "Total Egress (GB/mo):";
    totalGBInput.readOnly = true;
    const perServer = parseFloat(document.getElementById("egressPerServer").value) || 0;
    totalGB = serverCount * perServer;
    totalGBInput.value = totalGB;
  } else {
    // Fixed mode: hide per-server, show editable total
    perServerGroup.classList.add("hidden");
    totalLabel.textContent = "Monthly Egress (GB):";
    totalGBInput.readOnly = false;
    totalGB = parseFloat(totalGBInput.value) || 0;
  }

  // If 0 GB, cost is 0
  if (totalGB <= 0) {
    state.step5Costs.egress = 0;
    document.getElementById("egressCostBadge").textContent = `USD 0.00`;
    document.getElementById("egressCalcInfo").textContent = method === "per_server"
      ? `Calc: ${serverCount} servers × 0 GB = 0 GB/mo → USD 0.00/mo`
      : `Calc: 0 GB/mo → USD 0.00/mo`;
    updateStep5Totals();
    return;
  }

  // Tiered calculation (handle Infinity from JSON as null)
  const tiers = state.egressPricing?.tiers || [
    { rangeStart: 0, rangeEnd: 5, ratePerGB: 0 },
    { rangeStart: 5, rangeEnd: 10240, ratePerGB: 0.087 },
    { rangeStart: 10240, rangeEnd: 51200, ratePerGB: 0.083 },
    { rangeStart: 51200, rangeEnd: 153600, ratePerGB: 0.07 },
    { rangeStart: 153600, rangeEnd: null, ratePerGB: 0.05 },
  ];
  let cost = 0;
  let remaining = totalGB;
  for (const tier of tiers) {
    const end = tier.rangeEnd === null || tier.rangeEnd === Infinity ? Infinity : tier.rangeEnd;
    const tierSize = end === Infinity ? remaining : (end - tier.rangeStart);
    const used = Math.min(remaining, tierSize);
    if (used <= 0) break;
    cost += used * tier.ratePerGB;
    remaining -= used;
  }

  state.step5Costs.egress = Math.round(cost * 100) / 100;
  document.getElementById("egressCostBadge").textContent = `USD ${fmtCost(cost)}`;

  // Show calculation breakdown
  const infoEl = document.getElementById("egressCalcInfo");
  if (method === "per_server") {
    infoEl.textContent = `Calc: ${serverCount} servers × ${parseFloat(document.getElementById("egressPerServer").value) || 0} GB = ${totalGB} GB/mo → USD ${fmtCost(cost)}/mo (first 5 GB free)`;
  } else {
    infoEl.textContent = `Calc: ${totalGB} GB/mo → USD ${fmtCost(cost)}/mo (first 5 GB free, tiered pricing above)`;
  }
  updateStep5Totals();
}

function calculateLZCosts() {
  let total = 0;
  const components = ["firewall", "vpn", "er", "bastion", "monitor"];
  for (const c of components) {
    const enabled = document.getElementById(`lz_${c}_on`)?.checked;
    const skuSelect = document.getElementById(`lz_${c}_sku`);
    const qty = parseInt(document.getElementById(`lz_${c}_qty`)?.value) || 0;
    const unitCost = parseFloat(skuSelect?.value) || 0;
    const cost = enabled ? unitCost * qty : 0;
    document.getElementById(`lz_${c}_cost`).textContent = fmtCost(cost);
    total += cost;
  }
  state.step5Costs.lz = Math.round(total * 100) / 100;
  document.getElementById("lzComponentsTotal").textContent = `USD ${fmtCost(total)}`;
  updateStep5Totals();
}

function buildBCDREnvCheckboxes() {
  const envs = state.environments || ["All"];
  const backupContainer = document.getElementById("backupEnvCheckboxes");
  const asrContainer = document.getElementById("asrEnvCheckboxes");
  backupContainer.innerHTML = "";
  asrContainer.innerHTML = "";

  // Get server counts per env from envReports
  for (const env of envs) {
    const count = state.envReports[env]?.summary?.totalServers || state.assessmentReport?.summary?.totalServers || 0;
    // Backup: default unchecked
    backupContainer.innerHTML += `<label class="badge bg-light text-dark border small" style="cursor:pointer;">
      <input type="checkbox" class="form-check-input me-1 backup-env-cb" value="${env}" data-count="${count}"> ${env} (${count})
    </label>`;
    // ASR: default only Prod selected
    const asrChecked = env.toLowerCase() === "prod" ? "checked" : "";
    asrContainer.innerHTML += `<label class="badge bg-light text-dark border small" style="cursor:pointer;">
      <input type="checkbox" class="form-check-input me-1 asr-env-cb" value="${env}" ${asrChecked} data-count="${count}"> ${env} (${count})
    </label>`;
  }

  // Attach listeners
  document.querySelectorAll(".backup-env-cb").forEach(cb => cb.addEventListener("change", calculateBackupCost));
  document.querySelectorAll(".asr-env-cb").forEach(cb => cb.addEventListener("change", calculateASRCost));
}

function calculateBackupCost() {
  const pricing = state.backupPricing || { instanceFeePerVM: 10, storageLRSPerGB: 0.05, storageGRSPerGB: 0.10, retentionMultipliers: { "30_days": 1.5, "90_days": 2.0, "1_year": 3.0 } };
  const retention = document.getElementById("backupRetention").value;
  const redundancy = document.getElementById("backupRedundancy").value;
  const changeRate = parseFloat(document.getElementById("backupChangeRate").value) || 3;
  const multiplier = pricing.retentionMultipliers[retention] || 1.5;
  const storageRate = redundancy === "grs" ? pricing.storageGRSPerGB : pricing.storageLRSPerGB;

  // Get selected env server counts + total disk
  let totalServers = 0;
  let totalDiskGB = 0;
  document.querySelectorAll(".backup-env-cb:checked").forEach(cb => {
    const env = cb.value;
    const report = state.envReports[env] || state.assessmentReport;
    if (report) {
      const servers = report.servers || [];
      totalServers += servers.length;
      for (const srv of servers) {
        if (srv.diskDetails) {
          for (const d of srv.diskDetails) totalDiskGB += (d.sourceSizeGB || 0);
        }
      }
    }
  });

  const backupStorageGB = Math.round(totalDiskGB * multiplier);
  const instanceCost = totalServers * pricing.instanceFeePerVM;
  const storageCost = backupStorageGB * storageRate;
  const totalCost = Math.round((instanceCost + storageCost) * 100) / 100;

  const backupTB = (backupStorageGB / 1024).toFixed(1);
  document.getElementById("backupCalcInfo").textContent =
    `${totalServers} servers, ${(totalDiskGB / 1024).toFixed(1)} TB source → ${backupTB} TB backup storage | Instance: $${fmtCost(instanceCost)} + Storage (${redundancy.toUpperCase()}): $${fmtCost(storageCost)}`;
  document.getElementById("backupCostBadge").textContent = `USD ${fmtCost(totalCost)}/mo`;

  state.step5Costs.backup = totalCost;
  state.step5BackupInfo = { servers: totalServers, storageTB: backupTB };
  updateStep5Totals();
}

function calculateASRCost() {
  const pricing = state.asrPricing || { pricePerServer: 25 };
  let totalServers = 0;
  document.querySelectorAll(".asr-env-cb:checked").forEach(cb => {
    const env = cb.value;
    const report = state.envReports[env] || state.assessmentReport;
    if (report) totalServers += (report.servers || []).length;
  });

  const totalCost = Math.round(totalServers * pricing.pricePerServer * 100) / 100;
  document.getElementById("asrCalcInfo").textContent = `${totalServers} servers × $${pricing.pricePerServer}/server = $${fmtCost(totalCost)}/mo`;
  document.getElementById("asrCostBadge").textContent = `USD ${fmtCost(totalCost)}/mo`;

  state.step5Costs.asr = totalCost;
  state.step5ASRInfo = { servers: totalServers };
  updateStep5Totals();
}

function updateStep5Totals() {
  const c = state.step5Costs;
  document.getElementById("step5EgressTotal").textContent = `USD ${fmtCost(c.egress)}`;
  document.getElementById("step5LZTotal").textContent = `USD ${fmtCost(c.lz)}`;
  document.getElementById("step5BackupTotal").textContent = `USD ${fmtCost(c.backup)}`;
  document.getElementById("step5ASRTotal").textContent = `USD ${fmtCost(c.asr)}`;
  const grand = c.egress + c.lz + c.backup + c.asr;
  document.getElementById("step5GrandTotal").textContent = `USD ${fmtCost(grand)}`;
}

// Event listeners for Step 5 controls
document.getElementById("egressEnabled").addEventListener("change", calculateEgressCost);
document.getElementById("egressMethod").addEventListener("change", calculateEgressCost);
document.getElementById("egressPerServer").addEventListener("input", calculateEgressCost);
document.getElementById("egressTotalGB").addEventListener("input", calculateEgressCost);
document.getElementById("backupRetention").addEventListener("change", calculateBackupCost);
document.getElementById("backupRedundancy").addEventListener("change", calculateBackupCost);
document.getElementById("backupChangeRate").addEventListener("input", calculateBackupCost);

// LZ component listeners
document.querySelectorAll(".lz-sku-select").forEach(sel => {
  sel.addEventListener("change", () => {
    // Auto-enable checkbox and set qty=1 when a real SKU is selected
    const id = sel.id; // e.g. "lz_firewall_sku"
    const component = id.replace("lz_", "").replace("_sku", ""); // e.g. "firewall"
    const checkbox = document.getElementById(`lz_${component}_on`);
    const qtyInput = document.getElementById(`lz_${component}_qty`);
    if (parseFloat(sel.value) > 0) {
      // User selected a real SKU — auto-enable and set qty to at least 1
      if (checkbox && !checkbox.checked) checkbox.checked = true;
      if (qtyInput && (parseInt(qtyInput.value) || 0) < 1) qtyInput.value = 1;
    } else {
      // User selected "-- None --" — disable
      if (checkbox) checkbox.checked = false;
      if (qtyInput) qtyInput.value = 0;
    }
    calculateLZCosts();
  });
});
document.querySelectorAll(".lz-enable").forEach(cb => cb.addEventListener("change", calculateLZCosts));
["lz_firewall_qty", "lz_vpn_qty", "lz_er_qty", "lz_bastion_qty", "lz_monitor_qty"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", calculateLZCosts);
});

document.getElementById("backToStep4").addEventListener("click", () => goToStep(4));
document.getElementById("proceedToStep6").addEventListener("click", () => { state.stepsCompleted[5] = true; populateBOM(); goToStep(6); });


// ============ STEP 6: BOM ============

function populateBOM() {
  const report = state.assessmentReport;
  if (!report) return;
  const s = report.summary;
  const serverCount = s.totalServers;
  const isFirstRender = !state.bomPopulated;

  // Show region
  const regionText = document.getElementById("targetRegionSelect")?.selectedOptions[0]?.text || "";
  const regionEl = document.getElementById("step6Region");
  if (regionEl) regionEl.textContent = regionText ? `Region: ${regionText}` : "";

  // BOM doesn't need per-env pricing summary (user sees it in Step 4)

  // Pre-fill Compute, Storage, Security with info labels
  document.getElementById("bom_compute").value = (s.totalMonthlyCompute || 0).toFixed(2);
  document.getElementById("bom_computeInfo").textContent = `(${serverCount} servers)`;
  document.getElementById("bom_storage").value = (s.totalMonthlyStorage || 0).toFixed(2);
  // Count total disks
  let totalDisks = 0;
  for (const srv of report.servers) { totalDisks += (srv.diskDetails?.length || 0); }
  document.getElementById("bom_storageInfo").textContent = `(${totalDisks} disks)`;
  document.getElementById("bom_security").value = (s.totalMonthlySecurity || 0).toFixed(2);
  document.getElementById("bom_securityInfo").textContent = `(${serverCount} servers)`;

  // Landing Zone values from Step 5
  const components = ["firewall", "vpn", "er", "bastion", "monitor"];
  for (const c of components) {
    const enabled = document.getElementById(`lz_${c}_on`)?.checked;
    const skuSelect = document.getElementById(`lz_${c}_sku`);
    const qty = parseInt(document.getElementById(`lz_${c}_qty`)?.value) || 0;
    const unitCost = parseFloat(skuSelect?.value) || 0;
    const cost = enabled ? unitCost * qty : 0;
    document.getElementById(`bom_${c}_val`).textContent = fmtCost(cost);
    // SKU label
    const selectedOpt = skuSelect?.selectedOptions[0];
    const skuName = selectedOpt?.dataset?.skuName || "";
    document.getElementById(`bom_${c}_sku_label`).textContent = skuName && enabled ? `(${skuName})` : "";
  }

  // Egress
  const egressGB = parseInt(document.getElementById("egressTotalGB").value) || 0;
  document.getElementById("bom_egress_val").textContent = fmtCost(state.step5Costs.egress);
  document.getElementById("bom_egress_info").textContent = `(${egressGB} GB/mo)`;

  // Backup
  document.getElementById("bom_backup_val").textContent = fmtCost(state.step5Costs.backup);
  const backupTB = state.step5BackupInfo?.storageTB || "0";
  document.getElementById("bom_backup_info").textContent = `(for ${backupTB} TB)`;

  // ASR
  document.getElementById("bom_asr_val").textContent = fmtCost(state.step5Costs.asr);
  const asrServers = state.step5ASRInfo?.servers || 0;
  document.getElementById("bom_asr_info").textContent = asrServers > 0 ? `(${asrServers} servers)` : "";

  // License calculation
  let winCores = 0, sqlCores = 0;
  for (const srv of report.servers) {
    const isWindows = srv.isWindows || (srv.osName || "").toLowerCase().includes("windows");
    if (isWindows) winCores += (srv.vmCores || 0);
    const nameLC = (srv.serverName || "").toLowerCase();
    const osLC = (srv.osName || "").toLowerCase();
    if (nameLC.includes("sql") || osLC.includes("sql")) sqlCores += (srv.vmCores || 0);
  }
  document.getElementById("bom_winCores").textContent = winCores;
  document.getElementById("bom_sqlCores").textContent = sqlCores;
  if (isFirstRender) {
    document.getElementById("bom_winlicense").value = (0).toFixed(2);
    document.getElementById("bom_sqllicense").value = (0).toFixed(2);
    document.getElementById("bom_linuxlicense").value = (0).toFixed(2);
    document.getElementById("bom_otherdb").value = (0).toFixed(2);
    state.bomPopulated = true;
  }

  updateBOMTotal();
}

function updateBOMTotal() {
  // Editable inputs
  const editableIds = ["bom_compute", "bom_storage", "bom_security", "bom_winlicense", "bom_sqllicense", "bom_linuxlicense", "bom_otherdb"];
  let total = 0;
  for (const id of editableIds) { total += parseFloat(document.getElementById(id)?.value) || 0; }

  // Read-only LZ + BCDR from Step 5
  const c = state.step5Costs;
  total += c.egress + c.lz + c.backup + c.asr;

  document.getElementById("bom_totalMonthly").textContent = `USD ${fmtCost(total)}`;
  document.getElementById("bom_totalAnnual").textContent = `USD ${fmtCost(total * 12)}`;
}

// Attach live recalculation to BOM editable inputs
document.querySelectorAll("#bomCostTable .bom-input").forEach(input => {
  input.addEventListener("input", updateBOMTotal);
});

document.getElementById("backToStep5").addEventListener("click", () => goToStep(5));
document.getElementById("proceedToStep7").addEventListener("click", () => { state.stepsCompleted[6] = true; goToStep(7); });

// Copy BOM table to clipboard
document.getElementById("copyBOMBtn").addEventListener("click", () => {
  const table = document.getElementById("bomCostTable");
  if (!table) return;
  // Build text version
  let text = "";
  for (const row of table.rows) {
    const cells = [];
    for (const cell of row.cells) {
      const input = cell.querySelector("input");
      cells.push(input ? input.value : cell.textContent.trim());
    }
    text += cells.join("\t") + "\n";
  }
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById("copyBOMBtn");
    btn.innerHTML = '<i class="bi bi-check"></i> Copied!';
    setTimeout(() => { btn.innerHTML = '<i class="bi bi-clipboard"></i> Copy'; }, 2000);
  });
});

// BOM Excel Download
document.getElementById("downloadBOMExcel").addEventListener("click", async () => {
  const report = state.assessmentReport;
  if (!report) return;
  const region = document.getElementById("targetRegionSelect")?.selectedOptions[0]?.text || "";
  const customerName = state.customerName || "Customer";

  // Collect BOM items from DOM
  const bomItems = [];
  bomItems.push({ label: "Compute", value: parseFloat(document.getElementById("bom_compute")?.value) || 0 });
  bomItems.push({ label: "Managed Disks", value: parseFloat(document.getElementById("bom_storage")?.value) || 0 });
  bomItems.push({ label: "Defender for Servers P2", value: parseFloat(document.getElementById("bom_security")?.value) || 0 });
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Landing Zone", value: "" });
  const lzItems = [
    ["Azure Firewall", "bom_firewall_val"],
    ["VPN Gateway", "bom_vpn_val"],
    ["ExpressRoute", "bom_er_val"],
    ["Azure Bastion", "bom_bastion_val"],
    ["Azure Monitor", "bom_monitor_val"],
  ];
  for (const [label, id] of lzItems) {
    bomItems.push({ label: "  " + label, value: parseFloat(document.getElementById(id)?.textContent) || 0 });
  }
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Network Egress", value: parseFloat(document.getElementById("bom_egress_val")?.textContent) || 0 });
  bomItems.push({ label: "Azure Backup", value: parseFloat(document.getElementById("bom_backup_val")?.textContent) || 0 });
  bomItems.push({ label: "Azure Site Recovery", value: parseFloat(document.getElementById("bom_asr_val")?.textContent) || 0 });
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Licensing", value: "" });
  bomItems.push({ label: "  Windows License", value: parseFloat(document.getElementById("bom_winlicense")?.value) || 0 });
  bomItems.push({ label: "  SQL License", value: parseFloat(document.getElementById("bom_sqllicense")?.value) || 0 });
  bomItems.push({ label: "  Linux", value: parseFloat(document.getElementById("bom_linuxlicense")?.value) || 0 });
  bomItems.push({ label: "  Other Databases", value: parseFloat(document.getElementById("bom_otherdb")?.value) || 0 });
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Total Monthly Cost", value: document.getElementById("bom_totalMonthly")?.textContent || "" });
  bomItems.push({ label: "Total Annual Cost", value: document.getElementById("bom_totalAnnual")?.textContent || "" });

  const envReportsInfo = {};
  for (const env of (state.environments || ["All"])) {
    envReportsInfo[env] = { totalServers: state.envReports?.[env]?.summary?.totalServers || state.envCounts?.[env] || 0 };
  }

  try {
    const resp = await fetch("/api/export/bom-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customerName,
        region,
        environments: state.environments || ["All"],
        envConfigs: state.envConfigs,
        envReports: envReportsInfo,
        envCounts: state.envCounts,
        bomItems,
      }),
    });
    if (!resp.ok) { alert("Export failed: " + (await resp.text())); return; }
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${customerName}_BOM.xlsx`; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    alert("Export error: " + err.message);
  }
});

// ============ STEP 7: WAVE PLAN ============
document.getElementById("backToStep6").addEventListener("click", () => goToStep(6));

let wavePlanData = null;
let wavePlanGroupingModes = [];

// Initialize Wave Plan when entering Step 7
function initWavePlan() {
  // Set default start date (today + 7 days)
  const start = new Date(Date.now() + 7 * 86400000);
  document.getElementById("wpStartDate").value = start.toISOString().split("T")[0];

  // Detect available grouping columns
  fetch(`/api/waveplan/detect-groups?sessionId=${state.sessionId}`)
    .then(r => r.json())
    .then(data => {
      wavePlanGroupingModes = data.groupingModes || [];
      const sel = document.getElementById("wpGroupBy");
      sel.innerHTML = "";
      for (const mode of wavePlanGroupingModes) {
        const opt = document.createElement("option");
        opt.value = mode.id;
        opt.dataset.column = mode.column || "";
        opt.textContent = mode.label + (mode.detected ? ` (${mode.values?.length || 0} groups)` : " — not detected");
        opt.disabled = !mode.detected;
        sel.appendChild(opt);
      }
      // Select first detected mode
      const firstDetected = wavePlanGroupingModes.find(m => m.detected);
      if (firstDetected) sel.value = firstDetected.id;

      // Enable LLM btn if configured & update status badge
      updateWpLlmStatus();

      // Apply config defaults
      if (data.config) {
        document.getElementById("wpLzDesign").value = data.config.lzDesignWeeks;
        document.getElementById("wpLzProvision").value = data.config.lzProvisionWeeks;
        document.getElementById("wpPilotDuration").value = data.config.pilotDurationWeeks || 8;
        document.getElementById("wpNumWaves").value = data.config.numMigrationWaves;
        document.getElementById("wpWaveDuration").value = data.config.waveDurationWeeks;
        document.getElementById("wpBuffer").value = data.config.bufferDays;
      }

      // Show pilot guidance
      showPilotGuidance(data.totalServers, wavePlanGroupingModes);
    })
    .catch(err => wpShowStatus("Failed to detect grouping: " + err.message, "error"));
}

// Live LLM status for Wave Plan page
function updateWpLlmStatus() {
  const badge = document.getElementById("wpLlmStatusBadge");
  const textarea = document.getElementById("wpUserInstructions");
  const box = document.getElementById("wpLlmInstructionBox");
  if (state.llmConfigured) {
    textarea.disabled = false;
    textarea.placeholder = "e.g. Keep SAP servers together in same wave, migrate dev/test first, SWIFT must go last, Wave 2 should focus on databases...";
    box.style.opacity = "1";
    badge.className = "badge bg-success ms-2";
    badge.style.fontSize = "10px";
    badge.textContent = "AI connected";
  } else {
    textarea.disabled = true;
    textarea.placeholder = "Connect AI in settings to enable. Type instructions like: Keep SAP servers together, migrate dev/test first...";
    box.style.opacity = "0.5";
    badge.className = "badge bg-secondary ms-2";
    badge.style.fontSize = "10px";
    badge.textContent = "AI not connected";
  }
}

// Re-check LLM status every 3s while on Step 7 (detects if user connects AI mid-page)
setInterval(() => {
  if (state.currentStep === 7) updateWpLlmStatus();
}, 3000);

function wpShowStatus(msg, type) {
  const el = document.getElementById("wpStatus");
  el.classList.remove("hidden", "alert-success", "alert-danger", "alert-info", "alert-warning");
  const map = { success: "alert-success", error: "alert-danger", info: "alert-info", loading: "alert-warning" };
  el.className = `alert py-2 small ${map[type] || "alert-info"}`;
  el.textContent = msg;
}

function wpHideStatus() { document.getElementById("wpStatus").classList.add("hidden"); }

function showPilotGuidance(totalServers, modes) {
  const el = document.getElementById("wpPilotGuidance");
  const infoEl = document.getElementById("wpPilotInfo");
  if (!totalServers) { el.classList.add("hidden"); return; }

  updateCapacityGuidance(totalServers);
  el.classList.remove("hidden");
}

function updateCapacityGuidance(totalServers) {
  const pilotW = parseInt(document.getElementById("wpPilotDuration").value) || 8;
  const pilotThroughput = parseInt(document.getElementById("wpPilotThroughput").value) || 10;
  const numWaves = parseInt(document.getElementById("wpNumWaves").value) || 3;
  const waveDurW = parseInt(document.getElementById("wpWaveDuration").value) || 2;
  const waveThroughput = parseInt(document.getElementById("wpWaveThroughput").value) || 30;

  const maxPilotVMs = pilotW * pilotThroughput;
  const maxWaveVMs = waveDurW * waveThroughput;
  const totalCapacity = maxPilotVMs + (numWaves * maxWaveVMs);

  const infoEl = document.getElementById("wpPilotInfo");
  const capacityEl = document.getElementById("wpTotalCapacity");

  let capacityClass = "";
  if (totalServers && totalCapacity < totalServers) {
    capacityClass = ` <span class="text-danger fw-bold">⚠ Insufficient capacity for ${totalServers} VMs!</span>`;
  } else if (totalServers) {
    capacityClass = ` <span class="text-success">✓ Sufficient for ${totalServers} VMs</span>`;
  }

  infoEl.innerHTML = `<strong>Pilot:</strong> ${pilotW} wks × ${pilotThroughput} VMs/wk = <strong>${maxPilotVMs} VMs max</strong> (max 3 groups) &nbsp;|&nbsp; <strong>Each wave:</strong> ${waveDurW} wks × ${waveThroughput} VMs/wk = <strong>${maxWaveVMs} VMs max</strong>`;
  capacityEl.innerHTML = `${totalCapacity} VMs (pilot ${maxPilotVMs} + ${numWaves} waves × ${maxWaveVMs})${capacityClass}`;
}

// Recalculate guidance when any input changes
["wpPilotDuration", "wpPilotThroughput", "wpNumWaves", "wpWaveDuration", "wpWaveThroughput"].forEach(id => {
  document.getElementById(id).addEventListener("input", () => {
    const totalServers = state.assessmentReport?.summary?.totalServers || 0;
    if (totalServers) updateCapacityGuidance(totalServers);
  });
});

// Generate Wave Plan (smart: uses AI if connected + instructions provided, otherwise rule-based)
document.getElementById("wpGenerateBtn").addEventListener("click", async () => {
  const sel = document.getElementById("wpGroupBy");
  const selectedMode = wavePlanGroupingModes.find(m => m.id === sel.value);
  const userInstructions = document.getElementById("wpUserInstructions").value.trim();
  const useAI = state.llmConfigured && userInstructions.length > 0;

  wpShowStatus(useAI ? "Generating wave plan with AI assistance..." : "Generating wave plan (rule-based)...", "loading");

  const body = {
    sessionId: state.sessionId,
    numWaves: parseInt(document.getElementById("wpNumWaves").value) || 3,
    lzDesignWeeks: parseInt(document.getElementById("wpLzDesign").value) || 4,
    lzProvisionWeeks: parseInt(document.getElementById("wpLzProvision").value) || 2,
    pilotDurationWeeks: parseInt(document.getElementById("wpPilotDuration").value) || 8,
    pilotThroughputPerWeek: parseInt(document.getElementById("wpPilotThroughput").value) || 10,
    waveDurationWeeks: parseInt(document.getElementById("wpWaveDuration").value) || 2,
    waveThroughputPerWeek: parseInt(document.getElementById("wpWaveThroughput").value) || 30,
    bufferDays: parseInt(document.getElementById("wpBuffer").value) || 3,
    startDate: document.getElementById("wpStartDate").value,
    groupBy: sel.value,
    groupColumn: selectedMode?.column || null,
  };

  try {
    if (useAI) {
      // Hybrid approach: rule-based distribution + LLM refinement based on user instructions
      wpShowStatus("Generating rule-based plan, then applying AI refinements...", "loading");
      const llmBody = { ...body, userInstructions };
      const res = await fetch("/api/waveplan/llm-suggest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(llmBody) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "AI suggestion failed");

      const movesApplied = data.moves ? data.moves.length : 0;

      // Apply final assignments via update endpoint (rebuilds timeline with UI durations)
      const updateBody = { sessionId: state.sessionId, assignments: data.assignments, groupMeta: data.groupMeta, config: body };
      const res2 = await fetch("/api/waveplan/update", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(updateBody) });
      const plan = await res2.json();
      if (!res2.ok) throw new Error(plan.error || "Failed to apply assignments");
      wavePlanData = plan;
      renderWavePlan(plan);
      const totalAssigned = plan.waves.reduce((s, w) => s + w.totalServers, 0);
      const moveNote = movesApplied > 0 ? ` (AI applied ${movesApplied} move${movesApplied > 1 ? "s" : ""} per your instructions)` : " (no moves needed — rule-based was already optimal)";
      wpShowStatus(`Wave plan generated: ${plan.waves.length} waves, ${totalAssigned} servers assigned${moveNote}`, "success");
    } else {
      // Rule-based generation
      const res = await fetch("/api/waveplan/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed");
      wavePlanData = data;
      renderWavePlan(data);
      wpShowStatus(`Wave plan generated (rule-based): ${data.waves.length} waves, ${data.waves.reduce((s, w) => s + w.totalServers, 0)} servers assigned`, "success");
    }
  } catch (err) {
    wpShowStatus("Error: " + err.message, "error");
  }
});

// Render Wave Plan
function renderWavePlan(plan) {
  document.getElementById("wpTimeline").classList.remove("hidden");
  document.getElementById("wpExportBtns").classList.remove("hidden");

  // Show capacity warning if returned by server
  if (plan.capacityWarning) {
    wpShowStatus(plan.capacityWarning, "error");
  }

  const tbody = document.getElementById("wpTimelineBody");
  tbody.innerHTML = "";

  for (const wave of plan.waves) {
    const scopeText = wave.groups.map(g => g.name).join(", ");
    // Collect unique tag values across groups in this wave for quick visual confirmation
    const waveTags = {};
    for (const g of wave.groups) {
      if (g.tags) {
        for (const [k, v] of Object.entries(g.tags)) {
          if (v) { if (!waveTags[k]) waveTags[k] = new Set(); waveTags[k].add(v); }
        }
      }
    }
    const tagsText = Object.entries(waveTags).map(([k, vs]) => `${k}: ${[...vs].join(", ")}`).join(" | ");
    const overCap = wave.overCapacity;
    const capacityLabel = wave.maxCapacity ? ` / ${wave.maxCapacity}` : "";
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="fw-semibold">${escHtml(wave.name)}</td>
      <td class="small">${fmtDateDisplay(wave.startDate)}</td>
      <td class="small">${fmtDateDisplay(wave.endDate)}</td>
      <td class="small text-truncate" style="max-width:200px" title="${escHtml(scopeText)}">${escHtml(scopeText) || '<span class="text-muted">—</span>'}</td>
      <td class="small text-truncate" style="max-width:150px" title="${escHtml(tagsText)}">${tagsText ? `<span class="text-info">${escHtml(tagsText)}</span>` : '<span class="text-muted">—</span>'}</td>
      <td class="text-center">${wave.totalServers}${capacityLabel ? `<span class="text-muted small">${capacityLabel}</span>` : ""}</td>
      <td class="text-end">$${wave.waveCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="text-end fw-bold">$${wave.cumulativeCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    `;
    if (wave.waveNumber === 0) tr.classList.add("table-info");
    if (overCap) tr.classList.add("table-danger");
    tbody.appendChild(tr);
  }

  renderGantt(plan);
  renderWaveDetails(plan);
  checkBOMMatch(plan);
}

// Gantt bar chart
function renderGantt(plan) {
  const container = document.getElementById("wpGantt");
  if (!plan.waves.length) { container.innerHTML = ""; return; }

  const allStart = new Date(plan.waves[0].startDate);
  const allEnd = new Date(plan.waves[plan.waves.length - 1].endDate);
  const totalDays = Math.max(1, (allEnd - allStart) / 86400000);
  const barHeight = 32;
  const gap = 4;
  const colors = ["#0d6efd", "#198754", "#fd7e14", "#6f42c1", "#dc3545", "#20c997", "#d63384", "#6610f2", "#ffc107", "#0dcaf0"];

  let html = `<div style="position:relative; height:${(barHeight + gap) * plan.waves.length + 30}px; min-width:600px;">`;
  // Week markers
  const totalWeeks = Math.ceil(totalDays / 7);
  for (let w = 0; w <= totalWeeks; w++) {
    const pct = (w * 7 / totalDays) * 100;
    if (pct <= 100) {
      html += `<div style="position:absolute; left:${pct}%; top:0; bottom:20px; border-left:1px dashed #dee2e6;"></div>`;
      html += `<div class="text-muted" style="position:absolute; left:${pct}%; bottom:0; font-size:10px; transform:translateX(-50%);">W${w}</div>`;
    }
  }

  plan.waves.forEach((wave, idx) => {
    const wStart = (new Date(wave.startDate) - allStart) / 86400000;
    const wEnd = (new Date(wave.endDate) - allStart) / 86400000;
    const left = (wStart / totalDays) * 100;
    const width = Math.max(1, ((wEnd - wStart) / totalDays) * 100);
    const color = colors[idx % colors.length];
    const top = idx * (barHeight + gap);
    html += `<div style="position:absolute; left:${left}%; width:${width}%; top:${top}px; height:${barHeight}px; background:${color}; border-radius:4px; display:flex; align-items:center; padding:0 8px; color:#fff; font-size:11px; font-weight:600; white-space:nowrap; overflow:hidden;" title="${wave.name}: ${fmtDateDisplay(wave.startDate)} → ${fmtDateDisplay(wave.endDate)} (${wave.totalServers} VMs)">${wave.name} <span style="margin-left:auto; opacity:0.8;">${wave.totalServers} VMs</span></div>`;
  });

  html += "</div>";
  container.innerHTML = html;
}

// Expandable wave details (accordion)
function renderWaveDetails(plan) {
  const container = document.getElementById("wpWaveDetails");
  container.innerHTML = "";

  for (const wave of plan.waves) {
    const id = `wpWave${wave.waveNumber}`;
    let groupsHtml = "";
    for (const g of wave.groups) {
      // Build tag badges from LLM metadata
      let tagsHtml = "";
      if (g.tags && Object.keys(g.tags).length) {
        tagsHtml = Object.entries(g.tags)
          .filter(([, v]) => v)
          .map(([k, v]) => `<span class="badge bg-info text-dark ms-1">${escHtml(k)}: ${escHtml(v)}</span>`)
          .join("");
      }
      const reasonHtml = g.reason ? `<div class="small text-success fst-italic mt-1"><i class="bi bi-lightbulb"></i> ${escHtml(g.reason)}</div>` : "";

      groupsHtml += `<div class="mb-2"><strong>${escHtml(g.name)}</strong> <span class="badge bg-secondary">${g.serverCount} VMs</span>${tagsHtml}`;
      if (g.servers && g.servers.length) {
        groupsHtml += `<div class="small text-muted mt-1">${g.servers.slice(0, 10).map(s => escHtml(s)).join(", ")}${g.servers.length > 10 ? ` ... +${g.servers.length - 10} more` : ""}</div>`;
      }
      groupsHtml += reasonHtml;
      groupsHtml += `</div>`;
    }

    let phasesHtml = "";
    if (wave.phases) {
      phasesHtml = `<div class="mb-2"><strong>Phases:</strong> ${wave.phases.map(p => `${p.label}${p.weeks ? ` (${p.weeks} wks)` : ""}`).join(" → ")}</div>`;
    }

    container.innerHTML += `
      <div class="accordion-item">
        <h2 class="accordion-header" id="heading-${id}">
          <button class="accordion-button collapsed py-2 small" type="button" data-bs-toggle="collapse" data-bs-target="#collapse-${id}">
            <span class="fw-bold me-2">${escHtml(wave.name)}</span>
            <span class="badge bg-primary me-2">${wave.totalServers} VMs</span>
            <span class="text-muted">$${wave.waveCost.toLocaleString(undefined, { minimumFractionDigits: 2 })}/mo</span>
          </button>
        </h2>
        <div id="collapse-${id}" class="accordion-collapse collapse" data-bs-parent="#wpWaveDetails">
          <div class="accordion-body small">
            ${phasesHtml}
            <div><strong>Duration:</strong> ${wave.durationWeeks} weeks (${wave.startDate} → ${wave.endDate})</div>
            <div class="mt-2"><strong>Groups in scope:</strong></div>
            ${groupsHtml || '<div class="text-muted">No groups assigned</div>'}
          </div>
        </div>
      </div>
    `;
  }
}

// Check if final cumulative cost matches BOM
function checkBOMMatch(plan) {
  const el = document.getElementById("wpCostCheck");
  if (!plan.waves.length) { el.classList.add("hidden"); return; }

  const finalCum = plan.waves[plan.waves.length - 1].cumulativeCost;
  // Get BOM total (compute + storage + security from assessment)
  const report = state.assessmentReport;
  if (!report) { el.classList.add("hidden"); return; }
  const bomCoreTotal = (report.summary.totalMonthlyCompute || 0) + (report.summary.totalMonthlyStorage || 0) + (report.summary.totalMonthlySecurity || 0);

  el.classList.remove("hidden");
  const diff = Math.abs(finalCum - bomCoreTotal);
  if (diff < 1) {
    el.className = "alert py-2 small alert-success";
    el.innerHTML = `<i class="bi bi-check-circle-fill"></i> Final cumulative cost ($${finalCum.toFixed(2)}/mo) matches BOM compute+storage+security ($${bomCoreTotal.toFixed(2)}/mo)`;
  } else {
    el.className = "alert py-2 small alert-warning";
    el.innerHTML = `<i class="bi bi-exclamation-triangle-fill"></i> Final cumulative ($${finalCum.toFixed(2)}/mo) differs from BOM compute+storage+security ($${bomCoreTotal.toFixed(2)}/mo) by $${diff.toFixed(2)}`;
  }
}

function escHtml(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

// Format ISO date (YYYY-MM-DD) to DD-MM-YYYY for display
function fmtDateDisplay(isoStr) {
  if (!isoStr) return "";
  const [y, m, d] = isoStr.split("-");
  return `${d}-${m}-${y}`;
}

// Export Wave Plan as XLSX (server-side formatted)
document.getElementById("wpExportBtn").addEventListener("click", () => {
  if (!wavePlanData || !state.sessionId) return;
  window.open(`/api/waveplan/export-xlsx?sessionId=${encodeURIComponent(state.sessionId)}`, "_blank");
});

// Export Gantt chart as PNG
document.getElementById("wpExportGanttBtn").addEventListener("click", async () => {
  const ganttEl = document.getElementById("wpGanttContainer");
  if (!ganttEl || typeof html2canvas === "undefined") return;
  try {
    const canvas = await html2canvas(ganttEl, { backgroundColor: "#ffffff", scale: 2 });
    const a = document.createElement("a");
    a.href = canvas.toDataURL("image/png");
    a.download = `WavePlan_Gantt_${state.customerName || "export"}.png`;
    a.click();
  } catch (err) {
    wpShowStatus("Failed to export Gantt: " + err.message, "error");
  }
});

// Hook: Initialize wave plan when navigating to Step 7 (handled in goToStep)

// ============ HELPERS ============
function showStatus(id, msg, type) {
  const el = document.getElementById(id);
  el.classList.remove("hidden", "alert-success", "alert-danger", "alert-info", "alert-warning");
  const typeMap = { success: "alert-success", error: "alert-danger", info: "alert-info", loading: "alert-warning" };
  el.className = `alert py-2 small ${typeMap[type] || "alert-info"}`;
  el.textContent = msg;
}

function addLog(container, msg, type) {
  const d = document.createElement("div");
  d.className = `log-entry ${type}`;
  d.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  container.appendChild(d); container.scrollTop = container.scrollHeight;
}

function esc(str) { const d = document.createElement("div"); d.textContent = str || ""; return d.innerHTML; }

function fmt(val) {
  if (val === "" || val === undefined || val === null) return "";
  const n = parseFloat(val);
  if (isNaN(n)) return String(val);
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Convert simple HTML table string to Spreadsheet XML rows — UNUSED, kept for reference
// function htmlTableToSSXML(htmlTable) { ... }

// XML/HTML-safe escape for Excel export
function escXml(str) {
  return String(str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ============ HISTORY SIDEBAR ============
const historySidebar = document.getElementById("historySidebar");
const historyOverlay = document.getElementById("panelOverlay");

document.getElementById("openHistoryBtn").addEventListener("click", () => {
  historySidebar.classList.add("open");
  historyOverlay.classList.remove("hidden");
  loadHistorySessions();
});
document.getElementById("closeHistoryBtn").addEventListener("click", closeHistory);
historyOverlay.addEventListener("click", () => {
  closeHistory();
  document.getElementById("configPanel").classList.remove("open");
});

function closeHistory() {
  historySidebar.classList.remove("open");
  if (!document.getElementById("configPanel").classList.contains("open")) {
    historyOverlay.classList.add("hidden");
  }
}

async function loadHistorySessions() {
  const container = document.getElementById("historySessionsList");
  const emptyMsg = document.getElementById("historyEmpty");
  try {
    const resp = await fetch("/api/sessions");
    if (!resp.ok) return;
    const list = await resp.json();
    if (!list || list.length === 0) {
      container.innerHTML = "";
      emptyMsg.classList.remove("hidden");
      return;
    }
    emptyMsg.classList.add("hidden");
    list.sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));

    container.innerHTML = list.map(s => {
      const date = new Date(s.savedAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const name = s.customerName || s.assessmentName || s.fileName.replace(".json", "");
      const servers = s.totalRows || 0;
      const lastStep = s.stepsCompleted?.wavePlan ? "Wave Plan" : s.stepsCompleted?.bom ? "BOM" : s.stepsCompleted?.lzBcdr ? "LZ/BCDR" : s.stepsCompleted?.assessment ? "Assessment" : "Upload";
      // Build output items based on completed steps
      const outputs = [];
      if (s.stepsCompleted?.upload) outputs.push('<i class="bi bi-check-circle-fill text-success"></i> Azure Migrate CSV');
      if (s.stepsCompleted?.assessment) outputs.push('<i class="bi bi-check-circle-fill text-success"></i> Assessment Report');
      if (s.stepsCompleted?.bom) outputs.push('<i class="bi bi-check-circle-fill text-success"></i> Full BOM');
      if (s.stepsCompleted?.wavePlan) outputs.push('<i class="bi bi-check-circle-fill text-success"></i> Wave Plan');
      const outputHtml = outputs.length ? `<div class="session-outputs mt-1">${outputs.join('<br>')}</div>` : '';
      return `<div class="list-group-item" data-file="${escXml(s.fileName)}">
        <div class="session-name">${escXml(name)}</div>
        <div class="session-meta"><i class="bi bi-upload"></i> ${escXml(s.sourceFile || 'Unknown file')} &middot; ${servers} servers</div>
        ${outputHtml}
        <div class="d-flex justify-content-between align-items-center mt-1">
          <span class="session-step-badge">${lastStep}</span>
          <span class="session-meta">${date}</span>
        </div>
      </div>`;
    }).join("");
  } catch (err) {
    console.warn("[History] Load failed:", err.message);
  }
}

// Handle session click in sidebar
document.getElementById("historySessionsList").addEventListener("click", async (e) => {
  const item = e.target.closest("[data-file]");
  if (!item) return;
  const fileName = item.dataset.file;
  try {
    const resp = await fetch("/api/sessions/load", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName })
    });
    if (!resp.ok) { alert("Failed to load session"); return; }
    const data = await resp.json();

    // Restore state
    state.sessionId = data.sessionId;
    state.customerName = data.customerName || "";
    document.getElementById("customerNameInput").value = state.customerName;
    updateCustomerNameDisplay();

    // Restore assessment name
    if (data.assessmentName) {
      document.getElementById("assessmentNameInput").value = data.assessmentName;
    }

    // Ensure Step 5 and BOM re-initialize with fresh data
    state.step5Initialized = false;
    state.step5ForceReset = true;
    state.bomPopulated = false;

    // Restore environments and build env tabs (Step 3)
    if (data.environments && data.environments.length) {
      state.environments = data.environments;
      // Build env tabs using server endpoint (it reads from restored session)
      await detectAndBuildEnvTabs();
    }

    // Restore assessment data
    if (data.assessmentReport) {
      state.assessmentReport = data.assessmentReport;
      state.combinedSummary = data.assessmentReport;
    }
    if (data.envAssessments) {
      state.envReports = {};
      if (!state.envComplete) state.envComplete = {};
      for (const [env, report] of Object.entries(data.envAssessments)) {
        state.envReports[env] = report;
        state.envComplete[env] = true;
        // Update per-env summary if DOM elements exist
        try { updateEnvSummary(env, report); } catch(e) {}
      }
    }

    // Restore BOM data
    if (data.bomData) {
      state.bomData = data.bomData;
    }

    // Navigate to last completed step
    let targetStep = 1;
    if (data.stepsCompleted?.wavePlan) targetStep = 7;
    else if (data.stepsCompleted?.bom) targetStep = 6;
    else if (data.stepsCompleted?.lzBcdr) targetStep = 5;
    else if (data.stepsCompleted?.assessment) targetStep = 4;
    else targetStep = 2;

    // Mark steps completed
    if (data.stepsCompleted?.upload) state.stepsCompleted[1] = true;
    if (data.stepsCompleted?.assessment) { state.stepsCompleted[2] = true; state.stepsCompleted[3] = true; state.stepsCompleted[4] = true; }
    if (data.stepsCompleted?.lzBcdr) state.stepsCompleted[5] = true;
    if (data.stepsCompleted?.bom) state.stepsCompleted[6] = true;
    if (data.stepsCompleted?.wavePlan) state.stepsCompleted[7] = true;

    // Render assessment totals and detail report
    if (data.assessmentReport && data.assessmentReport.summary) {
      updateCombinedTotal(data.assessmentReport);
      renderAssessmentReport(data.assessmentReport);
    }

    // Show the "Proceed" button on Step 3 if assessment done
    if (data.stepsCompleted?.assessment) {
      const proceedBtn = document.getElementById("proceedToResults");
      if (proceedBtn) proceedBtn.classList.remove("hidden");
      // Also show "Next: LZ & BCDR" on Step 4
      const proceedLz = document.getElementById("proceedToAssessmentUpload");
      if (proceedLz) proceedLz.classList.remove("hidden");
    }

    closeHistory();
    goToStep(targetStep);
  } catch (err) {
    alert("Error loading session: " + err.message);
  }
});

// Auto-load history on page load to show badge count
loadHistorySessions();

