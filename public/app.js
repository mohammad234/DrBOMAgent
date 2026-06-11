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
  llmProviderType: null,
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
document.getElementById("aiConnectionPill")?.addEventListener("click", () => openPanel());
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
  // Sync UI with backend LLM state. Backend retains config across browser refreshes;
  // without this, the UI hides the AI Optimization toggle but the (HTML-default-checked)
  // checkbox still tells the server to run LLM. Read /api/llm/status, and if configured
  // reveal the toggle (kept OFF by default — user opts in explicitly).
  try {
    const llmRes = await fetch("/api/llm/status");
    const llmStatus = await llmRes.json();
    if (llmStatus && llmStatus.configured) {
      state.llmProviderType = llmStatus.providerType;
      const isGithub = llmStatus.providerType === "github-models";
      if (!isGithub) {
        // Surface the correct Azure sub-section (azure-openai vs serverless).
        const providerSel = document.getElementById("aiProviderType");
        if (providerSel && llmStatus.providerType && providerSel.value !== llmStatus.providerType) {
          providerSel.value = llmStatus.providerType;
          providerSel.dispatchEvent(new Event("change"));
        }
      } else {
        // Restored GitHub Models session — make the saved state HONEST in the UI.
        // The PAT is never echoed back from the server (security), but the user
        // needs visible evidence that a saved token is being used.
        const modelSel = document.getElementById("githubModelSelect");
        if (llmStatus.deploymentName && modelSel) {
          // If the saved model isn't already an option (e.g. came from the dynamic
          // catalog), insert it so the selection actually shows.
          if (!Array.from(modelSel.options).some(o => o.value === llmStatus.deploymentName)) {
            const opt = document.createElement("option");
            opt.value = llmStatus.deploymentName;
            opt.textContent = llmStatus.deploymentName + " (saved)";
            modelSel.insertBefore(opt, modelSel.firstChild);
          }
          modelSel.value = llmStatus.deploymentName;
        }
        const patInput = document.getElementById("githubPatInput");
        if (patInput) {
          patInput.placeholder = "•••••••• (using saved token — paste a new one to replace)";
        }
        const ghStatus = document.getElementById("githubConfigStatus");
        if (ghStatus) ghStatus.innerHTML = '<i class="bi bi-check-circle text-success"></i> Connected with saved token from previous session. <button id="ghClearSavedBtn" type="button" class="btn btn-link btn-sm p-0 align-baseline" style="font-size:0.85em;">Clear saved token</button>';
        // Wire the inline "Clear saved token" link to the existing disconnect flow.
        const clearBtn = document.getElementById("ghClearSavedBtn");
        if (clearBtn) clearBtn.addEventListener("click", () => document.getElementById("aiDisconnectBtn")?.click());
        // Show the Connect button as already-connected even though PAT field is empty.
        if (window.__githubControls) window.__githubControls.markConnected("saved", llmStatus.deploymentName);
      }
      setLlmConnected(true, llmStatus.providerType);
    }
  } catch (e) {
    console.log("LLM status check skipped:", e.message);
  }
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

function setLlmConnected(configured, providerType) {
  state.llmConfigured = configured;
  if (providerType) state.llmProviderType = providerType;
  const activeProvider = providerType || state.llmProviderType || document.getElementById("aiProviderType")?.value;
  const isGithub = activeProvider === "github-models";
  const azureIndicator = document.getElementById("llmStatusIndicator");
  const githubIndicator = document.getElementById("githubStatusIndicator");
  const azureBadge = document.getElementById("azureActiveBadge");
  const githubBadge = document.getElementById("githubActiveBadge");
  const azureStatusText = document.getElementById("llmConfigStatus");
  const githubStatusText = document.getElementById("githubConfigStatus");
  const badge = document.getElementById("agenticModeLabel");
  const toggle = document.getElementById("aiModeToggle");
  const llmOptContainer = document.getElementById("llmOptToggleContainer");
  const llmOptToggle = document.getElementById("llmOptToggle");
  // GitHub Models doesn't need Azure login; Azure providers do.
  const allowOn = configured && (isGithub || state.azureConnected);

  // Reset both indicators and badges, then light the active group only.
  if (azureIndicator) { azureIndicator.className = "status-indicator off"; azureIndicator.title = "Not configured"; }
  if (githubIndicator) { githubIndicator.className = "status-indicator off"; githubIndicator.title = "Not configured"; }
  if (azureBadge) azureBadge.classList.add("hidden");
  if (githubBadge) githubBadge.classList.add("hidden");

  if (allowOn) {
    const targetIndicator = isGithub ? githubIndicator : azureIndicator;
    const targetBadge = isGithub ? githubBadge : azureBadge;
    const inactiveStatusText = isGithub ? azureStatusText : githubStatusText;
    if (targetIndicator) { targetIndicator.className = "status-indicator on"; targetIndicator.title = "Configured"; }
    if (targetBadge) targetBadge.classList.remove("hidden");
    // Clear the stale "✓ Connected (…)" message on the other side so the user
    // can tell which provider is actually live right now.
    if (inactiveStatusText) inactiveStatusText.textContent = "";
    badge.classList.remove("hidden");
    if (toggle) toggle.checked = true;
    if (llmOptContainer) llmOptContainer.classList.remove("hidden");
    // AI Optimization defaults to OFF — user opts in explicitly because it adds latency.
    if (llmOptToggle) llmOptToggle.checked = false;
    updateAiConnectionPill(true, isGithub ? "GitHub Models" : (activeProvider === "serverless" ? "Foundry Serverless" : "Azure OpenAI"));
  } else {
    badge.classList.add("hidden");
    if (toggle) toggle.checked = false;
    if (llmOptContainer) llmOptContainer.classList.add("hidden");
    if (llmOptToggle) llmOptToggle.checked = false;
    updateAiConnectionPill(false);
  }
}

// Update the AI connection pill in the main header. Reflects the overall LLM
// status so the user can tell at a glance — BEFORE starting Step 1 — whether
// AI features will run.
function updateAiConnectionPill(connected, providerLabel) {
  const pill = document.getElementById("aiConnectionPill");
  if (!pill) return;
  const label = pill.querySelector(".ai-pill-label");
  if (connected) {
    pill.classList.add("connected");
    if (label) label.textContent = providerLabel ? `AI: ${providerLabel}` : "AI: Connected";
    pill.title = "AI is connected. Click to open Setup.";
  } else {
    pill.classList.remove("connected");
    if (label) label.textContent = "AI: Not connected";
    pill.title = "AI is not connected. Click to open Setup.";
  }
}

// Reset the GitHub Models card to a clean idle state. Used when the user switches
// to Azure — the server has already wiped the saved PAT, so the UI must follow.
function clearGithubAiUi() {
  const pat = document.getElementById("githubPatInput");
  if (pat) { pat.value = ""; pat.placeholder = "ghp_\u2026 (with models:read scope)"; delete pat.dataset.savedTokenInUse; }
  const sel = document.getElementById("githubModelSelect");
  if (sel) {
    // Drop any dynamically injected "(saved)" option so the dropdown reverts to defaults.
    Array.from(sel.options).forEach(o => { if (/\(saved\)$/.test(o.textContent)) o.remove(); });
    if (sel.options.length) sel.selectedIndex = 0;
  }
  const status = document.getElementById("githubConfigStatus");
  if (status) status.textContent = "";
  if (window.__githubControls) window.__githubControls.markDisconnected();
}

// Reset just the AI sub-section of the Azure card (keep login + subscription intact —
// those are still valid sessions). Used when the user switches to GitHub Models.
function clearAzureAiUi() {
  const accSel = document.getElementById("openaiAccountSelect");
  if (accSel) accSel.selectedIndex = 0;
  const depSel = document.getElementById("openaiDeploymentSelect");
  if (depSel) { depSel.innerHTML = '<option value="">-- Select Deployment --</option>'; depSel.disabled = true; }
  const slSel = document.getElementById("serverlessEndpointSelect");
  if (slSel) { slSel.innerHTML = '<option value="">-- Select Model --</option>'; slSel.disabled = true; }
  const slKey = document.getElementById("serverlessApiKey");
  if (slKey) slKey.value = "";
  const status = document.getElementById("llmConfigStatus");
  if (status) status.textContent = "";
}

// AI Mode toggle — allows user to disable AI without removing config
document.getElementById("aiModeToggle").addEventListener("change", (e) => {
  state.llmConfigured = e.target.checked;
  const badge = document.getElementById("agenticModeLabel");
  const isGithub = state.llmProviderType === "github-models";
  const indicator = document.getElementById(isGithub ? "githubStatusIndicator" : "llmStatusIndicator");
  if (e.target.checked) {
    badge.querySelector("span").innerHTML = '<i class="bi bi-lightning"></i> AI Mode: ON';
    if (indicator) { indicator.className = "status-indicator on"; indicator.title = "Configured"; }
    updateAiConnectionPill(true, isGithub ? "GitHub Models" : (state.llmProviderType === "serverless" ? "Foundry Serverless" : "Azure OpenAI"));
  } else {
    badge.querySelector("span").innerHTML = '<i class="bi bi-lightning"></i> AI Mode: OFF';
    if (indicator) { indicator.className = "status-indicator off"; indicator.title = "Disabled by user"; }
    updateAiConnectionPill(false);
  }
});

// Disconnect AI: clear server-side LLM config so the user can switch providers
// (or just remove credentials) without re-configuring the other side first.
document.getElementById("aiDisconnectBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  btn.disabled = true; btn.textContent = "Disconnecting…";
  try {
    await fetch("/api/llm/disconnect", { method: "POST" });
    // Wipe local state + UI hints so it really looks disconnected.
    state.llmProviderType = null;
    document.getElementById("githubPatInput").value = "";
    document.getElementById("llmConfigStatus").textContent = "";
    document.getElementById("githubConfigStatus").textContent = "Disconnected. Configure a provider to enable AI.";
    if (window.__githubControls) window.__githubControls.markDisconnected();
    setLlmConnected(false);
  } catch (err) {
    document.getElementById("githubConfigStatus").textContent = "Disconnect failed: " + err.message;
  } finally {
    btn.disabled = false; btn.textContent = "Disconnect";
  }
});

// Re-test connection: hit the provider with a tiny ping. On failure the server
// auto-clears the bad credentials, so we also reset the UI to a clean state.
document.getElementById("aiRetestBtn")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  const resultEl = document.getElementById("aiRetestResult");
  btn.disabled = true; btn.textContent = "Testing…";
  if (resultEl) { resultEl.className = "small mt-1 text-white-50"; resultEl.style.fontSize = "0.78em"; resultEl.textContent = "Pinging provider…"; }
  try {
    const res = await fetch("/api/llm/retest", { method: "POST" });
    const data = await res.json();
    if (data.ok) {
      if (resultEl) { resultEl.className = "small mt-1 text-success"; resultEl.style.fontSize = "0.78em"; resultEl.textContent = `\u2713 ${data.providerType} is responding`; }
      setTimeout(() => { if (resultEl) resultEl.classList.add("hidden"); }, 4000);
    } else {
      // Server already cleared the bad config — sync the UI to match.
      if (resultEl) {
        resultEl.className = "small mt-1 text-warning";
        resultEl.style.fontSize = "0.78em";
        const statusBit = data.status ? ` (HTTP ${data.status})` : "";
        resultEl.textContent = `\u2717 Re-test failed${statusBit}: ${data.error || "no response"}. Credentials cleared — please reconnect.`;
        resultEl.classList.remove("hidden");
      }
      state.llmProviderType = null;
      document.getElementById("githubPatInput").value = "";
      document.getElementById("githubPatInput").placeholder = "ghp_… (with models:read scope)";
      document.getElementById("githubConfigStatus").textContent = "";
      document.getElementById("llmConfigStatus").textContent = "";
      if (window.__githubControls) window.__githubControls.markDisconnected();
      setLlmConnected(false);
    }
  } catch (err) {
    if (resultEl) { resultEl.className = "small mt-1 text-warning"; resultEl.style.fontSize = "0.78em"; resultEl.textContent = "Re-test request failed: " + err.message; resultEl.classList.remove("hidden"); }
  } finally {
    btn.disabled = false; btn.textContent = "Re-test";
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

// Provider type toggle (Azure AI card: openai vs serverless only — GitHub Models is its own group)
document.getElementById("aiProviderType").addEventListener("change", (e) => {
  const v = e.target.value;
  const isServerless = v === "serverless";
  document.getElementById("azureOpenAISection").classList.toggle("hidden", isServerless);
  document.getElementById("serverlessSection").classList.toggle("hidden", !isServerless);
  // Switching the Azure sub-provider only blanks the Azure side; GitHub stays as-is.
  if (state.llmProviderType !== "github-models") setLlmConnected(false, v);
  document.getElementById("llmConfigStatus").textContent = "";
  if (isServerless && state.subscriptionId) loadServerlessEndpoints();
});

// GitHub Models: enable Connect button only when PAT + model are present.
// Also: when the user finishes pasting the PAT, fetch the actual model catalog
// from GitHub so the dropdown only shows models they have access to (avoids
// the 403 "no_access" surprise on first real LLM call).
(function wireGithubModelsControls() {
  const pat = document.getElementById("githubPatInput");
  const model = document.getElementById("githubModelSelect");
  const btn = document.getElementById("githubModelsSaveBtn");
  const status = document.getElementById("githubConfigStatus");
  if (!pat || !model || !btn) return;

  // Track what was last successfully connected so we can disable the button until
  // the user changes the PAT or model (mirrors Azure's auto-save-then-lock pattern).
  let connectedSnapshot = { pat: "", model: "" };

  const setButtonConnected = () => {
    btn.classList.remove("btn-primary");
    btn.classList.add("btn-success");
    btn.innerHTML = '<i class="bi bi-check-circle"></i> Connected';
    btn.disabled = true;
  };
  const setButtonIdle = () => {
    btn.classList.remove("btn-success");
    btn.classList.add("btn-primary");
    btn.textContent = "Connect GitHub Models";
  };

  const refresh = () => {
    const hasInputs = !!pat.value.trim() && !!model.value;
    const isUnchanged = pat.value.trim() === connectedSnapshot.pat && model.value === connectedSnapshot.model;
    if (!hasInputs) {
      setButtonIdle();
      btn.disabled = true;
      return;
    }
    if (isUnchanged && connectedSnapshot.pat) {
      // Same credentials that are currently connected — show as connected, disable.
      setButtonConnected();
      return;
    }
    // New / changed credentials — back to idle and enabled.
    setButtonIdle();
    btn.disabled = false;
  };

  let catalogLoadedFor = null;

  async function loadCatalog(p) {
    if (!p || catalogLoadedFor === p) return;
    status.textContent = "Loading available models…";
    model.disabled = true;
    try {
      const res = await fetch("/api/llm/github-models/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ githubPat: p }),
      });
      const data = await res.json();
      if (!res.ok) {
        status.textContent = (data.error || "Could not load models") + " Using built-in list — pick a free-tier model to try.";
        // Leave the hard-coded fallback list in place so the user can still try.
        return;
      }
      const prevSelected = model.value;
      model.innerHTML = "";
      if (!data.models || data.models.length === 0) {
        const opt = document.createElement("option");
        opt.value = ""; opt.textContent = "(no chat models accessible to this PAT)";
        model.appendChild(opt);
      } else {
        data.models.forEach(m => {
          const opt = document.createElement("option");
          opt.value = m.id;
          opt.textContent = `${m.name}${m.tier ? ` — ${m.tier} tier` : ""}`;
          model.appendChild(opt);
        });
        // Preserve previous selection if still available, else pick first low-tier model.
        if (Array.from(model.options).some(o => o.value === prevSelected)) {
          model.value = prevSelected;
        }
      }
      status.textContent = `${data.models.length} model(s) available with this PAT.`;
      catalogLoadedFor = p;
    } catch (err) {
      status.textContent = "Could not load models: " + err.message;
    } finally {
      model.disabled = false;
      refresh();
    }
  }

  pat.addEventListener("input", () => { refresh(); });
  // Trigger catalog load when PAT field loses focus (gives the user a chance to finish pasting).
  pat.addEventListener("blur", () => loadCatalog(pat.value.trim()));
  model.addEventListener("change", refresh);

  btn.addEventListener("click", async () => {
    const githubPat = pat.value.trim();
    const selectedModel = model.value;
    if (!githubPat || !selectedModel) return;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Testing & connecting…';
    status.textContent = "";
    try {
      const res = await fetch("/api/llm/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ providerType: "github-models", githubPat, model: selectedModel }),
      });
      const data = await res.json();
      if (data.success) {
        // Server has wiped Azure credentials — mirror that in the Azure card UI.
        clearAzureAiUi();
        setLlmConnected(true, "github-models");
        status.textContent = "\u2713 Connected (GitHub Models)";
        connectedSnapshot = { pat: githubPat, model: selectedModel };
        setButtonConnected();
      } else {
        setLlmConnected(false, "github-models");
        status.textContent = "Error: " + (data.error || "Config failed");
        setButtonIdle();
        btn.disabled = false;
      }
    } catch (err) {
      setLlmConnected(false, "github-models");
      status.textContent = "Error: " + err.message;
      setButtonIdle();
      btn.disabled = false;
    }
  });

  // Expose a way for the boot-time status restore + disconnect handler to sync
  // the button state with reality.
  window.__githubControls = {
    markConnected: (p, m) => { connectedSnapshot = { pat: p || "saved", model: m || "" }; setButtonConnected(); },
    markDisconnected: () => { connectedSnapshot = { pat: "", model: "" }; setButtonIdle(); btn.disabled = true; },
  };
})();

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
      // Server has wiped GitHub credentials — mirror that in the GitHub card UI.
      clearGithubAiUi();
      setLlmConnected(true, "serverless");
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
      // Server has wiped GitHub credentials — mirror that in the GitHub card UI.
      clearGithubAiUi();
      setLlmConnected(true, "azure-openai");
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
    if (!res.ok) {
      if (data.errorCode === "LLM_REQUIRED") {
        uploadProgress.classList.add("hidden");
        uploadError.classList.remove("hidden");
        uploadError.innerHTML = `<strong>\u{1F916} AI model required.</strong> ${data.message || data.error}` +
          (data.weakTargets && data.weakTargets.length ? `<br><small>Unmapped: ${data.weakTargets.join(", ")}</small>` : "") +
          `<br><a href="#" id="openSettingsLink">Open Settings to configure the AI model</a>`;
        const link = document.getElementById("openSettingsLink");
        if (link) link.addEventListener("click", (e) => { e.preventDefault(); const btn = document.getElementById("settingsBtn"); if (btn) btn.click(); });
        fileInput.value = "";
        return;
      }
      throw new Error(data.error);
    }
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
  state.activeSpec = data.activeSpec || null;

  // Render column mapping table (PRIMARY focus)
  renderMappingTable(data.mappingInfo || []);

  // Sheet summary line (multi-tab inventories like CAH PROD+DR).
  const sheetSummaryEl = document.getElementById("sheetSummary");
  if (sheetSummaryEl) {
    const parts = [];
    if (Array.isArray(data.sheetSummary) && data.sheetSummary.length > 0) {
      parts.push(`Detected sheets: ${data.sheetSummary.map(s => `${s.sheet} (${s.rowCount})`).join(", ")}`);
    }
    parts.push(`Mapping source: ${data.mappingSource || "auto"}`);
    sheetSummaryEl.textContent = parts.join("\u00a0\u00a0\u2022\u00a0\u00a0");
    sheetSummaryEl.classList.remove("hidden");
  }

  // AI status banner — explicit, prominent, replaces inline aiNotice text.
  renderAiStatus(data);

  // Inventory quality warning banner.
  showInventoryQualityIssue(data.inventoryQualityIssue);

  // Hide conversion results until user accepts
  document.getElementById("conversionResults").classList.add("hidden");
  document.getElementById("proceedToProject").classList.add("hidden");
}

function renderMappingTable(mappingInfo) {
  const tbody = document.querySelector("#columnMappingTable tbody");
  tbody.innerHTML = "";
  for (const m of mappingInfo) {
    const tr = document.createElement("tr");
    const isMapped = m.type === "direct" || m.type === "computed";
    const sourceText = m.source || "\u2014";
    const reason = m.reason || (isMapped ? "Mapped" : "No mapping");
    tr.className = isMapped ? "mapping-row-ok" : "mapping-row-miss";
    tr.innerHTML = `<td>${esc(sourceText)}</td><td>${esc(m.target)}</td><td>${esc(reason)}</td>`;
    tbody.appendChild(tr);
  }
}

function showInventoryQualityIssue(issue) {
  const el = document.getElementById("inventoryQualityWarn");
  if (!el) return;
  if (!issue) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const list = (issue.details || []).map(d => `<li><code>${esc(d.target)}</code> filled in only ${(d.filledRatio * 100).toFixed(0)}% of rows</li>`).join("");
  el.innerHTML = `<strong>\u26a0\ufe0f Inventory quality issue.</strong> ${esc(issue.message)}${list ? `<ul>${list}</ul>` : ""}`;
  el.classList.remove("hidden");
}

// Renders the AI verification status banner above the mapping table. Tells the user
// at a glance whether (a) rules covered everything, or (b) the AI was triggered to
// refine weak mappings, and which targets it touched.
function renderAiStatus(data) {
  const el = document.getElementById("aiStatusBanner");
  if (!el) return;
  const status = data.aiStatus || "not-needed";
  const notice = data.aiNotice || {};
  let cls = "alert alert-info";
  let html = "";
  if (status === "not-needed") {
    cls = "alert alert-success";
    html = `<strong>\u2705 Rule-based mapping complete.</strong> All required columns were mapped from the source inventory. AI was not needed.`;
  } else if (status === "triggered-applied") {
    cls = "alert alert-primary";
    const targets = (notice.targets || []).map(t => `<code>${esc(t)}</code>`).join(", ");
    const weak = (notice.originalWeakTargets || []).map(t => `<code>${esc(t)}</code>`).join(", ");
    html = `<strong>\u{1F916} AI verification triggered.</strong> Rule-based mapping had weak coverage for ${weak}. AI refined ${notice.targets.length} target(s): ${targets}.`;
  } else if (status === "triggered-no-change") {
    cls = "alert alert-info";
    html = `<strong>\u{1F916} AI verification triggered.</strong> ${esc(notice.reason || "AI confirmed rule-based mapping.")}`;
  } else if (status === "triggered-failed") {
    cls = "alert alert-warning";
    html = `<strong>\u26a0\ufe0f AI verification failed.</strong> ${esc(notice.reason || "Unknown error")}. Falling back to rule-based mapping \u2014 review carefully.`;
  }
  el.className = cls;
  el.innerHTML = html;
  el.classList.remove("hidden");
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

// AI Fix Mapping button (in column mapping table) — actually re-runs the conversion.
document.getElementById("aiFixMappingBtn").addEventListener("click", async () => {
  const btn = document.getElementById("aiFixMappingBtn");
  const originalLabel = "\u{1F916} Let AI Agent Handle Mapping";
  btn.disabled = true; btn.textContent = "AI is analyzing & remapping...";

  if (!state.sessionId) {
    btn.disabled = false; btn.textContent = originalLabel;
    alert("Please upload an inventory file first.");
    return;
  }

  try {
    const res = await fetch("/api/llm/suggest-mapping", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "AI mapping failed");

    // Refresh the mapping table with whatever the server returned (applied or preview).
    renderMappingTable(data.mappingInfo || []);

    if (data.applied === false) {
      // AI ran but the result is too poor to apply automatically.
      showInventoryQualityIssue(data.inventoryQualityIssue || {
        message: "AI mapping did not produce a usable result.",
        details: [],
      });
      btn.textContent = "\u26a0 AI could not produce a usable mapping";
      btn.disabled = false;
      return;
    }

    // Update cached upload-shape data so the Accept Mapping button uses the AI results.
    const merged = Object.assign({}, state.lastUploadData, {
      mappingInfo: data.mappingInfo,
      activeSpec: data.activeSpec,
      validRows: data.validRows,
      invalidRows: data.invalidRows,
      totalRows: data.totalRows,
      errors: data.errors,
      report: data.report,
      hasErrors: data.hasErrors,
      mappingSource: data.mappingSource,
      inventoryQualityIssue: null,
    });
    state.lastUploadData = merged;
    state.activeSpec = data.activeSpec || null;
    showInventoryQualityIssue(null);

    // If the user has already pressed Accept, also refresh the visible counts so they
    // see the AI improvement immediately.
    const conv = document.getElementById("conversionResults");
    if (conv && !conv.classList.contains("hidden")) {
      document.getElementById("validCount").textContent = data.validRows;
      document.getElementById("invalidCount").textContent = data.invalidRows;
      document.getElementById("totalCount").textContent = data.totalRows;
      const errSec = document.getElementById("errorsSection");
      if (data.errors && data.errors.length > 0) {
        errSec.classList.remove("hidden");
        const ebody = document.querySelector("#errorsTable tbody");
        ebody.innerHTML = "";
        data.errors.forEach(e => {
          const tr = document.createElement("tr");
          tr.innerHTML = `<td>${esc(e.serverName)}</td><td>${esc(e.error)}</td>`;
          ebody.appendChild(tr);
        });
      } else { errSec.classList.add("hidden"); }
      document.getElementById("reportContent").textContent = data.report || "";
    }

    btn.textContent = `\u2713 AI Mapping Applied (${data.validRows}/${data.totalRows} valid)`;
  } catch (err) {
    alert(`AI error: ${err.message}`);
    btn.textContent = originalLabel;
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

    // Init default config for this env. Cost mode auto-defaults to 'dr-defer'
    // for any environment named 'DR' (case-insensitive variants) so the user is
    // never silently double-counting DR-site servers as primary L&S compute.
    state.envConfigs[env] = {
      pricingModel: "3yr_ri",
      useAhub: true,
      enabledSeries: VM_SERIES_DEFAULT.filter(s => s.defaultEnabled).map(s => s.id),
      cpuArchitecture: "amd",
      storageTier: detectDefaultStorageTier(env),
      securityEnabled: true,
      sizingMode: document.getElementById("globalSizingMode")?.value || "auto",
      paygHoursPerMonth: 730,
      costMode: detectDefaultCostMode(env),
      cpuOptimisationFactor: parseFloat(document.getElementById("cpuOptFactor")?.value) || 0.70,
      ramOptimisationFactor: parseFloat(document.getElementById("ramOptFactor")?.value) || 0.80,
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
    const paygHoursInput = document.getElementById(`paygHours-${envId}`);
    const paygHoursWrap = document.getElementById(`paygHoursWrap-${envId}`);
    const paygHoursHelp = document.getElementById(`paygHoursHelp-${envId}`);

    // Show/hide PAYG hours input based on pricing model
    const togglePaygHoursVisibility = () => {
      const isPayg = (pricingSel?.value === "payg");
      if (paygHoursWrap) paygHoursWrap.classList.toggle("hidden", !isPayg);
      if (paygHoursHelp) paygHoursHelp.classList.toggle("hidden", !isPayg);
    };
    togglePaygHoursVisibility();

    if (pricingSel) pricingSel.addEventListener("change", () => {
      togglePaygHoursVisibility();
      updateEnvConfig(env);
      recalculateEnv(env);
    });
    if (ahubSel) ahubSel.addEventListener("change", () => { updateEnvConfig(env); recalculateEnv(env); });
    if (secCheck) secCheck.addEventListener("change", () => { updateEnvConfig(env); recalculateEnv(env); });
    // Arch/series/storage changes → mark needs re-run
    if (archSel) archSel.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); });
    if (storageSel) storageSel.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); });

    // PAYG hours: live recalculate (debounced) on input, immediate on blur/Enter.
    // On blur we also snap the visible value back into [1, 744] so users see the clamp.
    if (paygHoursInput) {
      let debTimer = null;
      paygHoursInput.addEventListener("input", () => {
        clearTimeout(debTimer);
        debTimer = setTimeout(() => { updateEnvConfig(env); recalculateEnv(env); }, 350);
      });
      paygHoursInput.addEventListener("change", () => {
        clearTimeout(debTimer);
        let v = parseInt(paygHoursInput.value, 10);
        if (!Number.isFinite(v) || v <= 0) v = 730;
        if (v > 744) v = 744;
        paygHoursInput.value = v;
        updateEnvConfig(env);
        recalculateEnv(env);
      });
    }

    // Series checkboxes
    const seriesCbs = document.querySelectorAll(`#series-${envId} input[type=checkbox]`);
    seriesCbs.forEach(cb => cb.addEventListener("change", () => { updateEnvConfig(env); markNeedsRerun(env); }));

    // Cost-mode change. lns <-> dr-defer is an instant recalc (cost-only re-route);
    // switching INTO 'exclude' (or out of it) requires a re-run because it bypasses
    // the matching engine entirely.
    const costModeSel = document.getElementById(`costMode-${envId}`);
    if (costModeSel) {
      costModeSel.addEventListener("change", () => {
        const newMode = costModeSel.value;
        const oldMode = state.envConfigs[env]?.costMode || "lns";
        updateEnvConfig(env);
        if (newMode === "exclude" || oldMode === "exclude") {
          markNeedsRerun(env);
        } else {
          recalculateEnv(env);
        }
      });
    }
  });

  // Wire the global Sizing Mode override (single dropdown, applies to ALL envs).
  // Changing sizing mode requires a re-run because cores/memory targets change.
  const globalSizing = document.getElementById("globalSizingMode");
  if (globalSizing && globalSizing.dataset.bound !== "1") {
    globalSizing.dataset.bound = "1";
    const ioInputs = document.getElementById("industryOptInputs");
    // Show/hide factor inputs based on mode + update helper text
    const syncSizingHelper = () => {
      const mode = globalSizing.value || "auto";
      const helpText = document.getElementById("sizingModeHelpText");
      if (helpText) {
        helpText.textContent =
          mode === "auto" ? "Auto picks the safest method per server based on telemetry availability."
          : mode === "as-allocated" ? "Sizing will match allocated CPU/Memory for every server."
          : mode === "performance-based" ? "Performance-based applied where utilization data exists; rows without data fall back safely."
          : "Industry-optimized: reduces over-allocated cores/RAM by the factors on the right. Use when no perf data is available (Gartner/Microsoft FastTrack guidance).";
      }
      if (ioInputs) ioInputs.classList.toggle("hidden", mode !== "industry-optimized");
    };
    syncSizingHelper();
    globalSizing.addEventListener("change", () => {
      syncSizingHelper();
      environments.forEach(e => {
        updateEnvConfig(e);
        markNeedsRerun(e);
      });
    });
    // Factor inputs: any change re-flows to all env configs + marks re-run.
    ["cpuOptFactor", "ramOptFactor"].forEach(id => {
      const el = document.getElementById(id);
      if (!el || el.dataset.bound === "1") return;
      el.dataset.bound = "1";
      el.addEventListener("change", () => {
        environments.forEach(e => { updateEnvConfig(e); markNeedsRerun(e); });
      });
    });
  }
}

function buildEnvConfigHtml(env, envId) {
  const seriesHtml = VM_SERIES_DEFAULT.map(s => {
    const checked = s.defaultEnabled ? "checked" : "";
    return `<label class="d-inline-flex align-items-center gap-1 px-2 py-1 bg-white border rounded small" style="cursor:pointer;">
      <input type="checkbox" value="${s.id}" ${checked}> ${s.name}
    </label>`;
  }).join("");
  const defaultMode = detectDefaultCostMode(env);
  const drDeferSel = defaultMode === "dr-defer" ? "selected" : "";
  const lnsSel = defaultMode === "lns" ? "selected" : "";
  const exclSel = defaultMode === "exclude" ? "selected" : "";
  const drBannerHtml = defaultMode === "dr-defer" ? `
    <div id="envDrBanner-${envId}" class="alert alert-info py-2 px-3 small mb-2">
      <i class="bi bi-shield-exclamation me-1"></i>
      <strong>This environment looks like a DR site.</strong> It will still be SKU-sized, but its cost is
      <strong>excluded from the Lift &amp; Shift total</strong> and surfaced in Step 5 (DR Strategy)
      where the right Azure DR pattern (Active-Active, Hot ASR, Cold ASR, Backup-Restore) decides the final cost.
    </div>` : "";

  return `
    <div id="envRerun-${envId}" class="alert alert-warning py-1 px-2 small mb-2 hidden"><i class="bi bi-exclamation-triangle"></i> Config changed — re-run assessment needed</div>
    ${drBannerHtml}
    <div class="card bg-light">
      <div class="card-body p-3">
        <div class="mb-3">
          <label class="form-label small fw-semibold mb-1">Cost Treatment:</label>
          <select class="form-select form-select-sm" id="costMode-${envId}" style="max-width:380px;">
            <option value="lns" ${lnsSel}>Include in Lift &amp; Shift total (default)</option>
            <option value="dr-defer" ${drDeferSel}>Size, but defer cost to DR Strategy (Step 5)</option>
            <option value="exclude" ${exclSel}>Exclude from sizing entirely</option>
          </select>
          <div class="form-text" style="font-size:0.7rem; line-height:1.2;">
            <strong>Defer:</strong> SKU-sizes the servers (used by active-active / Hot ASR strategies) but excludes them from the L&amp;S compute total.
            <strong>Exclude:</strong> skips sizing entirely (use for decommissioned servers).
          </div>
        </div>
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
          <label class="form-label small fw-semibold mb-1">Storage Profile:</label>
          <select class="form-select form-select-sm" id="storage-${envId}" style="max-width:380px;">
            <option value="auto" selected>Auto — engine picks tier per disk (Standard SSD default)</option>
            <option value="PremiumSSD">Production tier — Premium SSD (high IOPS)</option>
            <option value="StandardSSD">Balanced tier — Standard SSD</option>
            <option value="StandardHDD">Cost-optimised — Standard HDD (Dev/Test/cold)</option>
          </select>
          <div class="form-text" style="font-size:0.7rem; line-height:1.2;">
            Storage size is never shrunk (data-loss risk). The tier choice is where real cost savings live — Standard HDD is ~70% cheaper than Standard SSD for cold/non-prod workloads.
          </div>
        </div>
        <div class="row g-3 mb-3">
          <div class="col-md-6">
            <label class="form-label small fw-semibold mb-1">Pricing Model:</label>
            <div class="d-flex gap-2 align-items-start">
              <select class="form-select form-select-sm" id="pricing-${envId}" style="flex:1; min-width:0;">
                <option value="payg">Pay As You Go</option>
                <option value="1yr_ri">1-Year Reserved Instance</option>
                <option value="3yr_ri" selected>3-Year Reserved Instance</option>
              </select>
              <div id="paygHoursWrap-${envId}" class="input-group input-group-sm hidden" style="width:140px; flex:0 0 140px;" title="Hours per month used for PAYG cost. Default 730 = monthly billing average. Maximum 744 = 31 × 24 hrs.">
                <input type="number" class="form-control" id="paygHours-${envId}" value="730" min="1" max="744" step="1" aria-label="PAYG hours per month">
                <span class="input-group-text" style="font-size:0.75rem;">hrs/mo</span>
              </div>
            </div>
            <div id="paygHoursHelp-${envId}" class="form-text hidden" style="font-size:0.7rem; line-height:1.2;">PAYG runtime per month (1–744). Default 730 ≈ 24×7 billing avg. Lower values model VMs that auto-shut outside business hours.</div>
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
      <div id="envSummaryNote-${envId}" class="small text-info mb-1 hidden"></div>
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
  // Parse + clamp PAYG hours: [1, 744]. Empty/invalid → 730.
  const hoursRaw = document.getElementById(`paygHours-${envId}`)?.value;
  let paygHours = parseInt(hoursRaw, 10);
  if (!Number.isFinite(paygHours) || paygHours <= 0) paygHours = 730;
  if (paygHours > 744) paygHours = 744;
  const costModeRaw = document.getElementById(`costMode-${envId}`)?.value;
  const costMode = (costModeRaw === "dr-defer" || costModeRaw === "exclude") ? costModeRaw : "lns";
  // Industry-optimisation factors come from global inputs. Clamped [0.30, 1.00];
  // engine clamps again server-side as belt-and-braces.
  const cpuOptRaw = parseFloat(document.getElementById("cpuOptFactor")?.value);
  const ramOptRaw = parseFloat(document.getElementById("ramOptFactor")?.value);
  const cpuOptF = Number.isFinite(cpuOptRaw) ? Math.min(1.0, Math.max(0.30, cpuOptRaw)) : 0.70;
  const ramOptF = Number.isFinite(ramOptRaw) ? Math.min(1.0, Math.max(0.30, ramOptRaw)) : 0.80;
  state.envConfigs[env] = {
    pricingModel: document.getElementById(`pricing-${envId}`)?.value || "3yr_ri",
    useAhub: document.getElementById(`ahub-${envId}`)?.value === "ahub",
    enabledSeries: Array.from(seriesCbs).map(cb => cb.value),
    cpuArchitecture: document.getElementById(`arch-${envId}`)?.value || "amd",
    storageTier: document.getElementById(`storage-${envId}`)?.value || "auto",
    securityEnabled: document.getElementById(`security-${envId}`)?.checked !== false,
    sizingMode: document.getElementById("globalSizingMode")?.value || "auto",
    paygHoursPerMonth: paygHours,
    costMode,
    cpuOptimisationFactor: cpuOptF,
    ramOptimisationFactor: ramOptF,
  };
}

// Default cost-mode based on env name. Pure heuristic: any env clearly named
// 'DR' / 'Disaster Recovery' defaults to 'dr-defer'. Everything else to 'lns'.
function detectDefaultCostMode(env) {
  if (!env) return "lns";
  const norm = String(env).trim().toLowerCase().replace(/[\s_\-./]/g, "");
  if (norm === "dr" || norm === "disasterrecovery" || norm === "drsite") return "dr-defer";
  return "lns";
}

// Default Storage Profile based on env name. Conservative defaults: non-prod
// gets HDD (cheap, IO doesn't matter), everything else stays 'auto' so the
// engine picks per-disk based on IOPS hints (falling back to Standard SSD).
function detectDefaultStorageTier(env) {
  if (!env) return "auto";
  const norm = String(env).trim().toLowerCase().replace(/[\s_\-./]/g, "");
  if (norm === "dev" || norm === "development" || norm === "test" || norm === "sit" || norm === "qa" || norm === "decom" || norm === "decommissioned") return "StandardHDD";
  return "auto";
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
  const ds = report.deferredSummary || { totalMonthlyCost: 0, totalServers: 0 };
  const mode = report.costMode || state.envConfigs[env]?.costMode || "lns";
  document.getElementById(`envCompute-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlyCompute)}`;
  document.getElementById(`envStorage-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlyStorage)}`;
  document.getElementById(`envSecurity-${envId}`).textContent = `USD ${fmtCost(s.totalMonthlySecurity)}`;
  document.getElementById(`envSummary-${envId}`).classList.remove("hidden");
  // Note line above the summary cards explains a non-default cost mode.
  const noteEl = document.getElementById(`envSummaryNote-${envId}`);
  if (noteEl) {
    if (mode === "dr-defer" && ds.totalServers > 0) {
      noteEl.classList.remove("hidden", "text-info", "text-warning");
      noteEl.classList.add("text-info");
      noteEl.innerHTML = `<i class="bi bi-shield-check"></i> <strong>${ds.totalServers} servers sized for DR.</strong> USD ${fmtCost(ds.totalMonthlyCost)}/mo deferred to Step 5 (DR Strategy) — not added to L&S total.`;
    } else if (mode === "exclude") {
      noteEl.classList.remove("hidden", "text-info", "text-warning");
      noteEl.classList.add("text-warning");
      noteEl.innerHTML = `<i class="bi bi-x-octagon"></i> <strong>Excluded from sizing</strong> — ${s.totalServers} servers in this environment are not part of the assessment.`;
    } else {
      noteEl.classList.add("hidden");
      noteEl.innerHTML = "";
    }
  }
}

function updateCombinedTotal(combined) {
  const s = combined.summary;
  const ds = combined.deferredSummary || { totalMonthlyCost: 0, totalServers: 0 };
  const xs = combined.excludedSummary || { totalServers: 0 };
  document.getElementById("combinedCompute").textContent = `USD ${fmtCost(s.totalMonthlyCompute)}`;
  document.getElementById("combinedStorage").textContent = `USD ${fmtCost(s.totalMonthlyStorage)}`;
  document.getElementById("combinedSecurity").textContent = `USD ${fmtCost(s.totalMonthlySecurity)}`;
  document.getElementById("combinedTotal").textContent = `USD ${fmtCost(s.totalMonthlyCost)}`;
  document.getElementById("combinedTotalBar").classList.remove("hidden");
  // Deferred / excluded annotation under the combined bar.
  let annotationEl = document.getElementById("combinedDeferredNote");
  if (!annotationEl) {
    const bar = document.getElementById("combinedTotalBar");
    if (bar && bar.parentNode) {
      annotationEl = document.createElement("div");
      annotationEl.id = "combinedDeferredNote";
      annotationEl.className = "small text-muted mt-1";
      bar.parentNode.insertBefore(annotationEl, bar.nextSibling);
    }
  }
  if (annotationEl) {
    const parts = [];
    if (ds.totalServers > 0) {
      parts.push(`<span class="text-info"><i class="bi bi-shield-check"></i> <strong>+ USD ${fmtCost(ds.totalMonthlyCost)}/mo</strong> deferred to DR Strategy (${ds.totalServers} servers sized)</span>`);
    }
    if (xs.totalServers > 0) {
      parts.push(`<span class="text-warning"><i class="bi bi-x-octagon"></i> <strong>${xs.totalServers} servers excluded</strong></span>`);
    }
    annotationEl.innerHTML = parts.join(" &nbsp;·&nbsp; ");
    annotationEl.style.display = parts.length ? "" : "none";
  }
  // Show env pricing summary below combined bar
  renderEnvPricingSummary("envPricingSummary3");
  // Sizing summary banner (Step 3) — visible alongside the combined total bar.
  renderSizingSummaryBanner(combined.sizingSummary, "sizingSummaryBannerStep3");
  // Inventory vs Azure optimisation footprint (cores, RAM, storage).
  renderSizingOptimisationSummary(combined);
}

// Render the "Sizing Optimisation Summary" card: inventory cores/RAM vs Azure
// recommended cores/RAM, with delta percentages. Counts L&S servers only so it
// reflects the actual scope the customer is paying for. Excluded and deferred
// servers are flagged in a footnote so the user can audit which servers were
// dropped.
function renderSizingOptimisationSummary(combined) {
  const el = document.getElementById("sizingOptimisationSummary");
  if (!el) return;
  const s = combined.summary || {};
  const opt = combined.optimisationSummary || {};
  const invCores = opt.inventoryCores ?? s.inventoryCores ?? 0;
  const invRamGB = Math.round((opt.inventoryRamMB ?? s.inventoryRamMB ?? 0) / 1024);
  const recCores = opt.recommendedCores ?? s.recommendedCores ?? 0;
  const recRamGB = Math.round((opt.recommendedRamMB ?? s.recommendedRamMB ?? 0) / 1024);
  const cpuPct = opt.coresSavedPct ?? (invCores > 0 ? Math.round((1 - recCores / invCores) * 1000) / 10 : 0);
  const ramPct = opt.ramSavedPct ?? (invRamGB > 0 ? Math.round((1 - recRamGB / invRamGB) * 1000) / 10 : 0);
  const storageTB = ((opt.sourceDiskGB ?? s.sourceDiskGB ?? 0) / 1024).toFixed(1);
  // If both totals are zero (no assessment yet) hide the card.
  if (invCores === 0 && recCores === 0) {
    el.classList.add("hidden");
    return;
  }
  const ds = combined.deferredSummary || { totalServers: 0 };
  const xs = combined.excludedSummary || { totalServers: 0 };
  const scopeFootnote = (ds.totalServers > 0 || xs.totalServers > 0)
    ? `<div class="text-muted small mt-1">Includes only Lift &amp; Shift servers. ${ds.totalServers > 0 ? ds.totalServers + " deferred to DR Strategy excluded. " : ""}${xs.totalServers > 0 ? xs.totalServers + " excluded from sizing." : ""}</div>`
    : `<div class="text-muted small mt-1">Includes all ${s.totalServers || 0} sized servers.</div>`;
  const pctBadge = (pct) => {
    if (Math.abs(pct) < 0.1) return `<span class="badge bg-secondary">0%</span>`;
    if (pct > 0) return `<span class="badge bg-success">−${pct}%</span>`;
    return `<span class="badge bg-warning text-dark">+${Math.abs(pct)}%</span>`;
  };
  el.innerHTML = `
    <div class="card border-info">
      <div class="card-body py-2 px-3">
        <h6 class="small fw-semibold mb-2 text-info"><i class="bi bi-arrows-collapse"></i> Sizing Optimisation Summary</h6>
        <table class="table table-sm table-borderless mb-0 small align-middle">
          <thead class="text-muted">
            <tr>
              <th></th>
              <th class="text-end">Inventory (on-prem)</th>
              <th class="text-end">Recommended (Azure L&amp;S)</th>
              <th class="text-end">Reduction</th>
            </tr>
          </thead>
          <tbody>
            <tr><td>Servers</td><td class="text-end">${s.totalServers || 0}</td><td class="text-end">${s.totalServers || 0}</td><td class="text-end text-muted">—</td></tr>
            <tr><td><strong>vCPU cores</strong></td><td class="text-end">${invCores.toLocaleString()}</td><td class="text-end fw-semibold">${recCores.toLocaleString()}</td><td class="text-end">${pctBadge(cpuPct)}</td></tr>
            <tr><td><strong>RAM (GB)</strong></td><td class="text-end">${invRamGB.toLocaleString()}</td><td class="text-end fw-semibold">${recRamGB.toLocaleString()}</td><td class="text-end">${pctBadge(ramPct)}</td></tr>
            <tr><td>Storage (TB)</td><td class="text-end">${storageTB}</td><td class="text-end">${storageTB}</td><td class="text-end text-muted">0% (size preserved)</td></tr>
          </tbody>
        </table>
        ${scopeFootnote}
        ${renderReconciliationLine(combined)}
      </div>
    </div>`;
  el.classList.remove("hidden");
}

// One-line reconciliation: tells the user where every inventory server ended
// up so missing-server complaints get answered before they're raised.
// Surfaced as a yellow row when there's any unaccounted gap, gray when clean.
function renderReconciliationLine(combined) {
  const r = combined.reconciliation;
  if (!r || !r.inventoryCount) return "";
  const parts = [];
  parts.push(`<strong>${r.inventoryCount}</strong> in inventory`);
  parts.push(`<strong>${r.lnsCount}</strong> Lift &amp; Shift`);
  if (r.deferredCount > 0) parts.push(`<strong>${r.deferredCount}</strong> Deferred to DR Strategy`);
  if (r.excludedCount > 0) parts.push(`<strong>${r.excludedCount}</strong> Excluded`);
  const gap = r.unaccountedCount;
  const isClean = gap === 0;
  const cls = isClean ? "text-muted" : "text-warning fw-semibold";
  let html = `<div class="${cls} mt-2" style="font-size:0.78rem;"><i class="bi bi-${isClean ? 'check-circle' : 'exclamation-triangle'}"></i> Server reconciliation: ${parts.join(" \u00b7 ")}`;
  if (!isClean) {
    html += ` \u00b7 <strong>${gap} unaccounted</strong> (likely fell into 'Unknown' env from blank/duplicate hostnames in inventory \u2014 re-run after a fresh upload to fix).`;
  } else {
    html += ` \u00b7 all inventory servers accounted for.`;
  }
  html += `</div>`;
  return html;
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
    const report = state.envReports?.["All"] || state.assessmentReport;
    const serverCount = report?.summary?.totalServers || state.envCounts?.["All"] || 0;
    const pricingLabel = pricingLabels[config.pricingModel] || config.pricingModel || "N/A";
    const paygHrsSuffix = (config.pricingModel === "payg" && config.paygHoursPerMonth)
      ? ` (${config.paygHoursPerMonth} hrs/mo)` : "";
    const lic = computeEnvLicenseCores(report, config);
    container.innerHTML = `
      <div class="card border-0 bg-light">
        <div class="card-body py-2 px-3">
          <div class="small mb-1">
            <strong><i class="bi bi-geo-alt"></i> Region:</strong> ${esc(region)}
            &nbsp;|&nbsp; <strong>Pricing:</strong> ${pricingLabel}${paygHrsSuffix}
            &nbsp;|&nbsp; <strong>License:</strong> ${config.useAhub ? "Azure Hybrid Benefit (AHUB)" : "Azure-included (no AHUB)"}
            &nbsp;|&nbsp; <strong>Servers:</strong> ${serverCount}
          </div>
          ${renderLicenseChips(lic, config)}
        </div>
      </div>`;
  } else {
    // Multi-env — show per-env breakdown with license cores per env
    let rows = "";
    for (const env of envs) {
      const config = state.envConfigs[env] || {};
      const report = state.envReports?.[env];
      const serverCount = report?.summary?.totalServers || state.envCounts?.[env] || 0;
      const pricingLabel = pricingLabels[config.pricingModel] || config.pricingModel || "N/A";
      const paygHrsSuffix = (config.pricingModel === "payg" && config.paygHoursPerMonth)
        ? ` (${config.paygHoursPerMonth} hrs/mo)` : "";
      const license = config.useAhub ? "AHUB" : "Azure-included";
      const lic = computeEnvLicenseCores(report, config);
      const winCell = config.useAhub
        ? `<span class="badge bg-warning text-dark" title="BYOL: customer must procure ${lic.winCores} Windows Server cores for AHUB">${lic.winCores || 0}</span>`
        : `<span class="text-muted small" title="Windows Server licence is bundled into Azure compute price (no BYOL needed)">— Azure</span>`;
      const sqlCell = lic.sqlCores > 0
        ? `<span class="badge bg-warning text-dark" title="BYOL: customer must procure ${lic.sqlCores} SQL Server cores">${lic.sqlCores}</span>`
        : `<span class="text-muted small">0</span>`;
      const otherCell = lic.linuxCores > 0
        ? `<span class="text-muted small" title="${lic.linuxCores} non-Windows cores. Most Linux VMs include the OS in the Azure price; RHEL/SUSE BYOS require licences.">${lic.linuxCores}</span>`
        : `<span class="text-muted small">0</span>`;
      rows += `<tr>
        <td class="fw-semibold">${esc(env)}</td>
        <td>${serverCount}</td>
        <td>${pricingLabel}${paygHrsSuffix}</td>
        <td>${license}</td>
        <td class="text-end">${winCell}</td>
        <td class="text-end">${sqlCell}</td>
        <td class="text-end">${otherCell}</td>
      </tr>`;
    }
    container.innerHTML = `
      <div class="card border-0 bg-light">
        <div class="card-body py-2 px-3">
          <div class="small mb-1"><strong><i class="bi bi-geo-alt"></i> Region:</strong> ${esc(region)}</div>
          <table class="table table-sm table-borderless mb-0 small align-middle">
            <thead>
              <tr>
                <th>Environment</th>
                <th>Servers</th>
                <th>Pricing Model</th>
                <th>License</th>
                <th class="text-end" title="Windows Server cores customer must procure for AHUB. 0 when no AHUB (Azure-included).">Win Cores BYOL</th>
                <th class="text-end" title="SQL Server cores customer must procure (BYOL).">SQL Cores BYOL</th>
                <th class="text-end" title="Total non-Windows cores. Informational — most Linux is free; RHEL/SUSE BYOS need licences.">Other OS Cores</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <div class="text-muted mt-1" style="font-size:0.7rem;">
            <strong>BYOL = Bring Your Own License.</strong> Win Cores show <em>0</em> when AHUB is OFF because Azure includes the Windows Server licence in the compute price.
            SQL is always BYOL. Other OS cores are informational (most Linux distros are free; RHEL/SUSE on BYOS require subscriptions).
          </div>
        </div>
      </div>`;
  }
  container.classList.remove("hidden");
}

// Compute Windows / SQL / Linux core totals for an env's report. Used by both
// the env-pricing summary table (Step 3/4) and the BOM XLSX export.
function computeEnvLicenseCores(report, config) {
  const out = { winCores: 0, sqlCores: 0, linuxCores: 0 };
  if (!report || !report.servers) return out;
  // Skip excluded/deferred rows: deferred rows are sized but not in this env's
  // L&S total — they belong to the DR Strategy section, not Win/SQL BYOL.
  for (const srv of report.servers) {
    if (srv.costExcluded) continue;
    const isWindows = srv.isWindows || /windows/i.test(srv.osName || "");
    const cores = srv.vmCores || 0;
    if (isWindows) out.winCores += cores;
    else out.linuxCores += cores;
    const nameLC = (srv.serverName || "").toLowerCase();
    const osLC = (srv.osName || "").toLowerCase();
    if (nameLC.includes("sql") || osLC.includes("sql")) out.sqlCores += cores;
  }
  // AHUB-off means Azure bundles the Windows licence — no BYOL needed.
  if (config && config.useAhub === false) out.winCores = 0;
  return out;
}

// Compact chip row used in the single-env summary card.
function renderLicenseChips(lic, config) {
  const winChip = config.useAhub
    ? `<span class="badge bg-warning text-dark me-1" title="Customer must procure ${lic.winCores} Windows Server cores for AHUB">Win BYOL: ${lic.winCores} cores</span>`
    : `<span class="badge bg-light text-dark border me-1">Win: Azure-included</span>`;
  const sqlChip = lic.sqlCores > 0
    ? `<span class="badge bg-warning text-dark me-1" title="SQL Server cores customer must procure (BYOL)">SQL BYOL: ${lic.sqlCores} cores</span>`
    : `<span class="badge bg-light text-dark border me-1">SQL: 0 cores</span>`;
  const otherChip = lic.linuxCores > 0
    ? `<span class="badge bg-light text-dark border" title="Non-Windows cores. Most Linux is free; RHEL/SUSE BYOS need licences.">Other OS: ${lic.linuxCores} cores</span>`
    : "";
  return `<div class="small">${winChip}${sqlChip}${otherChip}</div>`;
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
      body: JSON.stringify({ sessionId: state.sessionId, subscriptionId: subId, region, assessmentName, customerName: state.customerName, envConfigs: envsToRun, skipLlm: !state.llmConfigured || !document.getElementById("llmOptToggle").checked }),
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

// Renders the sizing-summary banner (Bootstrap alert) into the given container.
// `summary` shape comes from assessment.js buildSizingSummary / server.js combined.
//
// IMPORTANT: the three primary buckets (asAllocated / performanceBased /
// performanceBasedPartial) are mutually exclusive and sum to totalServers.
// `flooredCount`, `cappedCount`, and `*FallbackCount` are SUB-FLAGS that overlap
// with those buckets, so they're shown INLINE under the bucket they belong to
// (telemetry gaps under As-Allocated; floored/capped under Performance-Based)
// to avoid any "does this add up?" confusion.
function renderSizingSummaryBanner(summary, containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!summary || !summary.totalServers) { el.innerHTML = ""; return; }

  const {
    modeRequested, totalServers,
    asAllocated = 0, performanceBased = 0, performanceBasedPartial = 0,
    flooredCount = 0, cappedCount = 0,
    zeroFallbackCount = 0, missingFallbackCount = 0,
  } = summary;

  const fallbackTotal = zeroFallbackCount + missingFallbackCount;
  const perfTotal = performanceBased + performanceBasedPartial;
  const requestedPerf = modeRequested === "performance-based";
  const heavyFallback = requestedPerf && totalServers > 0 && (asAllocated / totalServers) > 0.5;
  const alertClass = heavyFallback ? "alert alert-warning" : "alert alert-info";

  const modeLabel = {
    "auto": "Auto (Recommended)",
    "as-allocated": "As-Allocated",
    "performance-based": "Performance-Based",
    "mixed": "Mixed (per environment)",
  }[modeRequested] || modeRequested || "Auto";

  // Build "rows" — one per primary bucket, with sub-flags shown inline so the
  // relationship is obvious (e.g. "119 Performance-Based — 97 hit the 20% floor").
  const rows = [];

  if (asAllocated) {
    const subBits = [];
    if (fallbackTotal) subBits.push(`${fallbackTotal} fell back due to missing telemetry`);
    rows.push(`
      <div class="d-flex align-items-baseline gap-2">
        <span class="badge bg-secondary" style="min-width:5em;">${asAllocated}</span>
        <strong>As-Allocated</strong>
        ${subBits.length ? `<span class="text-muted small">&mdash; ${subBits.join("; ")}</span>` : ""}
      </div>
    `);
  }

  if (performanceBased || performanceBasedPartial) {
    const subBits = [];
    if (flooredCount) subBits.push(`${flooredCount} hit the 20% utilization floor (safe minimum)`);
    if (cappedCount) subBits.push(`${cappedCount} hit the 100% utilization cap`);
    if (performanceBasedPartial) subBits.push(`${performanceBasedPartial} used partial telemetry (one metric only)`);
    rows.push(`
      <div class="d-flex align-items-baseline gap-2">
        <span class="badge bg-primary" style="min-width:5em;">${perfTotal}</span>
        <strong>Performance-Based</strong>
        ${subBits.length ? `<span class="text-muted small">&mdash; ${subBits.join("; ")}</span>` : ""}
      </div>
    `);
  }

  let warnMsg = "";
  if (heavyFallback) {
    warnMsg = `<div class="small mt-2"><i class="bi bi-exclamation-triangle"></i> <strong>Heads up:</strong> You requested Performance-Based, but ${asAllocated} of ${totalServers} servers had no usable utilization data and were sized as-allocated for safety.</div>`;
  }

  el.innerHTML = `
    <div class="${alertClass} mb-0 py-2 px-3" role="alert">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-1">
        <i class="bi bi-rulers fs-5"></i>
        <strong class="me-1">Sizing Mode:</strong>
        <span class="me-2">${modeLabel}</span>
        <span class="vr"></span>
        <span class="text-muted small">${totalServers} server${totalServers === 1 ? "" : "s"} sized</span>
      </div>
      <div class="d-flex flex-column gap-1 ps-1">
        ${rows.join("")}
      </div>
      ${warnMsg}
    </div>
  `;
}

function renderAssessmentReport(report) {
  if (!report) return;

  // Show env pricing config summary at top of Step 4
  renderEnvPricingSummary("envPricingSummary4");

  // Sizing summary banner (Step 4)
  renderSizingSummaryBanner(report.sizingSummary, "sizingSummaryBanner");

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

// Count Lift & Shift servers across all envs (i.e. servers whose compute is in
// the primary L&S total). Excludes:
//   - costExcluded (env or per-server)
//   - costDeferredToDr (deferred to DR Strategy, e.g. DR env, or orphan-app pushed to DR)
// Returns { total, deferred, excluded } so calc-info can explain what was filtered.
function computeLnsServerCounts() {
  const out = { total: 0, deferred: 0, excluded: 0 };
  const servers = state.assessmentReport?.servers || [];
  for (const s of servers) {
    if (s.costExcluded) { out.excluded++; continue; }
    if (s.costDeferredToDr) { out.deferred++; continue; }
    out.total++;
  }
  return out;
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
  // Egress counts L&S servers only — i.e. servers whose compute lands in the
  // primary Lift & Shift total. Excluded servers and DR-deferred servers are
  // dropped because:
  //   - excluded → not migrated, no egress
  //   - deferred (cold ASR / Standard ASR target) → only replication traffic,
  //     which is implicit in the DR Strategy cost line (storage row)
  // Active-Active / Hot ASR DR servers DO produce egress, but their egress is
  // app-specific and best estimated separately in deep assessment.
  const lnsCounts = computeLnsServerCounts();
  const serverCount = lnsCounts.total;
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
      ? `Calc: ${serverCount} L&S servers × 0 GB = 0 GB/mo → USD 0.00/mo`
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

  // Show calculation breakdown + a sub-note explaining what was excluded so
  // the user can audit the server count against their inventory.
  const infoEl = document.getElementById("egressCalcInfo");
  const exclusions = [];
  if (lnsCounts.deferred > 0) exclusions.push(`${lnsCounts.deferred} deferred to DR Strategy`);
  if (lnsCounts.excluded > 0) exclusions.push(`${lnsCounts.excluded} excluded from sizing`);
  const exclusionNote = exclusions.length > 0 ? ` (${exclusions.join(", ")})` : "";
  if (method === "per_server") {
    infoEl.textContent = `Calc: ${serverCount} L&S servers${exclusionNote} × ${parseFloat(document.getElementById("egressPerServer").value) || 0} GB = ${totalGB} GB/mo → USD ${fmtCost(cost)}/mo (first 5 GB free)`;
  } else {
    infoEl.textContent = `Calc: ${totalGB} GB/mo → USD ${fmtCost(cost)}/mo (first 5 GB free, tiered pricing above)${exclusionNote ? ` · Server count for reference: ${serverCount}${exclusionNote}` : ""}`;
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
  buildBackupEnvPolicyTable();

  // Initialise the new DR Strategy matrix (replaces the old per-env ASR checkboxes)
  initDrStrategy();

  // Pre-fill the Architecture Diagram inputs with sensible defaults from the
  // current session (customer name + target region + environments).
  prefillAlzDiagramInputs();
}

// Build the per-env backup policy table. Each detected env gets its own row
// with: include checkbox, server count, retention dropdown, redundancy
// dropdown, and a status badge for envs not in L&S scope.
//
// Defaults follow banking convention (where regulator-driven retention rules
// dominate):  Production → 1 year + GRS, UAT → 90 days + LRS, everything else
// → 30 days + LRS. User can override every row.
function buildBackupEnvPolicyTable() {
  const wrap = document.getElementById("backupEnvPolicies");
  if (!wrap) return;
  const envs = state.environments || ["All"];
  // Persist per-env policy state so toggling Step 5 visits doesn't lose user's
  // choices. Initialise once per env.
  state.backupPolicies = state.backupPolicies || {};
  for (const env of envs) {
    if (!state.backupPolicies[env]) {
      state.backupPolicies[env] = {
        include: defaultBackupInclude(env),
        retention: defaultBackupRetention(env),
        redundancy: defaultBackupRedundancy(env),
      };
    }
  }

  const rowHtml = envs.map(env => {
    const count = state.envReports[env]?.summary?.totalServers || state.assessmentReport?.summary?.totalServers || 0;
    const cfg = state.envConfigs?.[env] || {};
    const policy = state.backupPolicies[env];
    const checked = policy.include ? "checked" : "";
    const retOpts = ["30_days", "90_days", "1_year"].map(v =>
      `<option value="${v}" ${policy.retention === v ? "selected" : ""}>${RETENTION_LABEL[v]}</option>`
    ).join("");
    const redOpts = [
      { v: "lrs", label: "LRS — single zone" },
      { v: "zrs", label: "ZRS — 3 zones, same region" },
      { v: "grs", label: "GRS — paired region" },
    ].map(o =>
      `<option value="${o.v}" ${policy.redundancy === o.v ? "selected" : ""}>${o.label}</option>`
    ).join("");
    let scopeBadge = "";
    if (cfg.costMode === "exclude") {
      scopeBadge = `<span class="badge bg-warning text-dark ms-1" title="Excluded from VM Assessment">excluded</span>`;
    } else if (cfg.costMode === "dr-defer") {
      scopeBadge = `<span class="badge bg-info ms-1" title="Deferred to DR Strategy. Backing up DR replicas is uncommon — usually the AG/ASR replica IS the backup.">deferred</span>`;
    }
    return `<tr data-env="${escAttr(env)}">
      <td><div class="form-check"><input class="form-check-input backup-env-include" type="checkbox" ${checked} id="bkupInc-${escAttr(env)}"><label class="form-check-label small fw-semibold" for="bkupInc-${escAttr(env)}">${esc(env)}</label>${scopeBadge}</div></td>
      <td class="text-end small">${count}</td>
      <td><select class="form-select form-select-sm backup-env-retention">${retOpts}</select></td>
      <td><select class="form-select form-select-sm backup-env-redundancy">${redOpts}</select></td>
    </tr>`;
  }).join("");

  wrap.innerHTML = `
    <table class="table table-sm align-middle mb-0 small">
      <thead class="table-light">
        <tr>
          <th>Environment</th>
          <th class="text-end" style="width:80px;">Servers</th>
          <th style="width:200px;">Retention</th>
          <th style="width:130px;">Redundancy</th>
        </tr>
      </thead>
      <tbody>${rowHtml}</tbody>
    </table>`;

  wrap.querySelectorAll(".backup-env-include, .backup-env-retention, .backup-env-redundancy").forEach(el => {
    el.addEventListener("change", () => { capturePoliciesAndRecalc(); });
  });
}

const RETENTION_LABEL = {
  "30_days": "30 days (1.5× multiplier)",
  "90_days": "90 days (2× multiplier)",
  "1_year":  "1 year (3× multiplier)",
};

// Default include — same logic as the old per-env checkbox: deferred / excluded
// envs are unchecked by default; everything else checked.
function defaultBackupInclude(env) {
  const cfg = state.envConfigs?.[env] || {};
  if (cfg.costMode === "dr-defer" || cfg.costMode === "exclude") return false;
  return true;
}

// Banking-default retention by env name. Conservative — Production gets 1 year
// (BNM/MAS audit windows), UAT gets 90 days, everything else gets 30.
function defaultBackupRetention(env) {
  if (!env) return "30_days";
  const norm = String(env).trim().toLowerCase().replace(/[\s_\-./]/g, "");
  if (norm === "prod" || norm === "production") return "1_year";
  if (norm === "uat" || norm === "stag" || norm === "staging" || norm === "preprod") return "90_days";
  return "30_days";
}

// Banking-default redundancy: GRS for Prod (cross-region durability for audit),
// LRS for everything else (operational recovery only, half the cost).
function defaultBackupRedundancy(env) {
  if (!env) return "lrs";
  const norm = String(env).trim().toLowerCase().replace(/[\s_\-./]/g, "");
  if (norm === "prod" || norm === "production") return "grs";
  return "lrs";
}

// Read current row state into state.backupPolicies, then recalc.
function capturePoliciesAndRecalc() {
  const wrap = document.getElementById("backupEnvPolicies");
  if (!wrap) return;
  wrap.querySelectorAll("tr[data-env]").forEach(tr => {
    const env = tr.getAttribute("data-env");
    const include = tr.querySelector(".backup-env-include")?.checked || false;
    const retention = tr.querySelector(".backup-env-retention")?.value || "30_days";
    const redundancy = tr.querySelector(".backup-env-redundancy")?.value || "lrs";
    state.backupPolicies[env] = { include, retention, redundancy };
  });
  calculateBackupCost();
}

// Default-fill the ALZ diagram form. Called from buildBCDREnvCheckboxes() so it
// runs every time Step 5 is set up.
function prefillAlzDiagramInputs() {
  const regionInput = document.getElementById("alzPrimaryRegion");
  const drInput = document.getElementById("alzDrRegion");
  const wgInput = document.getElementById("alzWorkloadGroups");
  if (!regionInput || !drInput || !wgInput) return;
  if (!regionInput.value) {
    const regionText = document.getElementById("targetRegionSelect")?.selectedOptions[0]?.text || "";
    regionInput.value = regionText;
  }
  if (!wgInput.value) {
    const envs = (state.environments || []).filter(e => e && e !== "All");
    wgInput.value = envs.length ? envs.join(", ") : "Production, Non-Production";
  }
}

function calculateBackupCost() {
  const pricing = state.backupPricing || { instanceFeePerVM: 10, storageLRSPerGB: 0.05, storageGRSPerGB: 0.10, retentionMultipliers: { "30_days": 1.5, "90_days": 2.0, "1_year": 3.0 } };
  const changeRate = parseFloat(document.getElementById("backupChangeRate").value) || 3;
  // Compression & dedup factor — Azure Backup gets typical 40-60% effective
  // savings on incremental backups. Clamp to [0, 90]: 0 means no savings,
  // 90 is an aggressive upper bound (VDI / heavily-templated VMs only).
  let compression = parseFloat(document.getElementById("backupCompression")?.value);
  if (!Number.isFinite(compression) || compression < 0) compression = 0;
  if (compression > 90) compression = 90;
  const compressionFactor = 1 - (compression / 100);

  // Aggregate cost per env using each env's own retention/redundancy policy.
  // This is the heart of the per-env model: each env sums its own source GB
  // and applies its own multiplier+rate, then the totals roll up.
  let totalServers = 0;
  let totalSourceGB = 0;
  let totalRawBackupGB = 0;        // before compression
  let totalEffectiveGB = 0;        // after compression — what Azure bills
  let storageCost = 0;
  let instanceCost = 0;
  const outOfScope = [];           // envs included but not in L&S scope
  const includedEnvs = [];         // for the per-env breakdown line

  const policies = state.backupPolicies || {};
  // First pass: clear any prior per-server backup attribution. We'll set new
  // values below for every server in an INCLUDED env. Servers in unincluded /
  // deferred / excluded envs end up with backupMonthlyCost = 0.
  const allServers = state.assessmentReport?.servers || [];
  // Build a fast lookup: combined report has one row per server (env-tagged)
  // so a Map by serverName lets us mirror per-server cost in O(1) instead of
  // re-scanning for every env iteration. ABMB has 1281 servers — without this
  // the inner find() turns the loop into ~1.2M ops on every backup recalc.
  const combinedByName = new Map();
  for (const srv of allServers) {
    srv.backupMonthlyCost = 0;
    combinedByName.set(srv.serverName, srv);
  }
  for (const env of (state.environments || [])) {
    const report = state.envReports[env];
    if (report) for (const srv of (report.servers || [])) srv.backupMonthlyCost = 0;
  }

  for (const env of (state.environments || [])) {
    const policy = policies[env];
    if (!policy || !policy.include) continue;
    const cfg = state.envConfigs?.[env] || {};
    if (cfg.costMode !== "lns") outOfScope.push({ env, mode: cfg.costMode });
    const report = state.envReports[env];
    if (!report) continue;
    const servers = report.servers || [];
    const multiplier = pricing.retentionMultipliers[policy.retention] || 1.5;
    // Three-way redundancy lookup. ZRS lives in same region across availability
    // zones — the right pick when data must stay in country (banking) but you
    // still want datacenter-failure protection. Falls back to LRS if redundancy
    // value is unrecognised so we never throw on a stale session.
    const rate = policy.redundancy === "grs" ? pricing.storageGRSPerGB
      : policy.redundancy === "zrs" ? (pricing.storageZRSPerGB || pricing.storageLRSPerGB * 1.25)
      : pricing.storageLRSPerGB;
    let envSourceGB = 0;
    let envEffectiveGB = 0;
    let envStorageCost = 0;
    // Per-server stamping: each server's backup cost = its own disks × env policy.
    // Sum-of-servers equals env total, so totals reconcile exactly.
    for (const srv of servers) {
      let srvSourceGB = 0;
      if (srv.diskDetails) {
        for (const d of srv.diskDetails) srvSourceGB += (d.sourceSizeGB || 0);
      }
      const srvEffectiveGB = srvSourceGB * multiplier * compressionFactor;
      const srvStorageCost = srvEffectiveGB * rate;
      const srvBackupTotal = srvStorageCost + pricing.instanceFeePerVM;
      const rounded = Math.round(srvBackupTotal * 100) / 100;
      // Stamp the cost on the env-level report row AND mirror it onto the
      // combined report row so all downstream views (BOM, wave plan, exports)
      // pick up the same number from whichever array they happen to read.
      srv.backupMonthlyCost = rounded;
      const combined = combinedByName.get(srv.serverName);
      if (combined) combined.backupMonthlyCost = rounded;
      envSourceGB += srvSourceGB;
      envEffectiveGB += srvEffectiveGB;
      envStorageCost += srvStorageCost;
    }
    const envRawGB = envSourceGB * multiplier;
    const envInstanceCost = servers.length * pricing.instanceFeePerVM;
    totalServers += servers.length;
    totalSourceGB += envSourceGB;
    totalRawBackupGB += envRawGB;
    totalEffectiveGB += envEffectiveGB;
    storageCost += envStorageCost;
    instanceCost += envInstanceCost;
    includedEnvs.push({
      env, servers: servers.length,
      sourceTB: (envSourceGB / 1024).toFixed(1),
      retention: policy.retention,
      redundancy: policy.redundancy,
      cost: envStorageCost + envInstanceCost,
    });
  }

  const totalCost = Math.round((instanceCost + storageCost) * 100) / 100;

  const sourceTB = (totalSourceGB / 1024).toFixed(1);
  const rawTB = (totalRawBackupGB / 1024).toFixed(1);
  const effectiveTB = (totalEffectiveGB / 1024).toFixed(1);
  const perServerInstance = totalServers > 0 ? (instanceCost / totalServers).toFixed(2) : "0.00";
  const compNote = compression > 0
    ? `${compression}% compression+dedup → ${effectiveTB} TB billable`
    : `no compression assumed → ${rawTB} TB billable`;
  const breakdownHtml = includedEnvs.length === 0
    ? `<span class="text-muted">No environments selected for backup.</span>`
    : includedEnvs.map(e =>
        `<div class="small"><strong>${esc(e.env)}</strong>: ${e.servers} srv · ${e.sourceTB} TB · ${RETENTION_LABEL[e.retention] || e.retention} · ${e.redundancy.toUpperCase()} → <strong>USD ${fmtCost(e.cost)}/mo</strong></div>`
      ).join("");
  document.getElementById("backupCalcInfo").innerHTML =
    `<strong>${totalServers} servers · ${sourceTB} TB source → ${rawTB} TB raw backup → ${compNote}</strong><br>` +
    `Instance fee: $${fmtCost(instanceCost)} ($${perServerInstance}/server avg — Azure tiers per 500 GB of source size) · ` +
    `Storage (mixed per-env policies): $${fmtCost(storageCost)}` +
    `<div class="mt-1 ps-2 border-start">${breakdownHtml}</div>` +
    `<span class="text-muted">Industry default 50% compression reflects typical Azure Backup. Tune for workload (VDI: 70-80% · encrypted DB: 10-20%).</span>`;
  document.getElementById("backupCostBadge").textContent = `USD ${fmtCost(totalCost)}/mo`;

  // Out-of-scope warning. Inject/update a banner just above the calc-info line.
  // Auto-removes when no out-of-scope envs are selected.
  let warnEl = document.getElementById("backupScopeWarning");
  if (outOfScope.length > 0) {
    if (!warnEl) {
      warnEl = document.createElement("div");
      warnEl.id = "backupScopeWarning";
      warnEl.className = "alert alert-warning small py-2 px-2 mb-2 mt-2";
      const infoEl = document.getElementById("backupCalcInfo");
      infoEl.parentNode.insertBefore(warnEl, infoEl);
    }
    const items = outOfScope.map(o => {
      const tag = o.mode === "exclude"
        ? `<strong>${esc(o.env)}</strong> is <em>excluded from VM Assessment</em> — those servers will not be migrated`
        : `<strong>${esc(o.env)}</strong> is <em>deferred to DR Strategy</em> — the DR replicas are usually NOT separately backed up (AG / ASR replication serves that role)`;
      return `<li>${tag}</li>`;
    }).join("");
    warnEl.innerHTML = `<i class="bi bi-exclamation-triangle"></i> <strong>Heads up — selected environments are not in Lift &amp; Shift scope:</strong><ul class="mb-0 mt-1">${items}</ul><div class="mt-1">Backup cost is still calculated as requested. Confirm during deep assessment whether you really need to back these up.</div>`;
  } else if (warnEl) {
    warnEl.remove();
  }

  state.step5Costs.backup = totalCost;
  state.step5BackupInfo = { servers: totalServers, storageTB: effectiveTB, perEnv: includedEnvs };
  updateStep5Totals();
}

function calculateASRCost() {
  // Legacy entry-point kept for compatibility — delegates to the DR Strategy
  // module which now owns the cost previously labelled "ASR".
  return recalcDrStrategy();
}

// ============ DR STRATEGY MATRIX (replaces flat ASR checkboxes) ============
// Cost categories returned by /api/dr-strategy/calculate map to a single line
// item in the BOM. The badge in the card shows the rolling total for the
// chosen criticality column + tier-strategy mapping. Switching the column or
// any tier dropdown triggers a debounced recalc. Default per-tier strategy is
// chosen from a built-in heuristic (matches the customer's MTD/RTO/RPO tiers
// that show up most often in inventories: 1+/1/2/3/4 etc.).

const DR_STRATEGY_OPTIONS = [
  { id: "none",            label: "None (no DR)",                  rpo: 0, rto: 0 },
  { id: "backup-restore",  label: "Backup-Restore (GRS)",           rpo: 24, rto: 24 },
  { id: "std-asr",         label: "Standard ASR (cold DR)",         rpo: 0.25, rto: 4 },
  { id: "hot-asr",         label: "Hot ASR (warm DR)",              rpo: 0.05, rto: 2 },
  { id: "active-active",   label: "Active-Active (cross-region)",   rpo: 0,    rto: 0.5 },
];

// Default strategy hint for a tier value. Pure heuristic so the user lands on
// something sensible immediately and can override per row. Order matters —
// first matching pattern wins.
function defaultStrategyFor(value) {
  const v = String(value || "").toLowerCase().trim();
  if (!v) return "none";
  // Tier 1+/critical/zero-RPO → Hot ASR
  if (/(^|\D)(1\+|t1\+|tier\s*1\+|critical|crit|gold|p0|s0|sev0|severity\s*0)(\D|$)/.test(v)) return "hot-asr";
  // Tier 1 / high → Standard ASR
  if (/(^|\D)(1|t1|tier\s*1|high|silver|p1|s1|sev1)(\D|$)/.test(v)) return "std-asr";
  // Tier 2 / medium → Standard ASR
  if (/(^|\D)(2|t2|tier\s*2|medium|med|bronze|p2|s2|sev2)(\D|$)/.test(v)) return "std-asr";
  // Tier 3 / low → Backup-Restore
  if (/(^|\D)(3|t3|tier\s*3|low|p3|s3|sev3)(\D|$)/.test(v)) return "backup-restore";
  // Tier 4 / no-DR → None
  if (/(^|\D)(4|t4|tier\s*4|none|no.?dr|n\/a|na)(\D|$)/.test(v)) return "none";
  return "std-asr";
}

async function initDrStrategy() {
  if (!state.sessionId || !state.assessmentReport) return;
  // Reset any previous run's local state for this Step 5 visit.
  state.drStrategy = state.drStrategy || { column: null, tierMap: {}, lastResult: null };
  // Default ASR price from cached pricing (already fetched on Step 5 load)
  const asrPriceInput = document.getElementById("drAsrPrice");
  if (asrPriceInput && state.asrPricing?.pricePerServer) {
    asrPriceInput.value = state.asrPricing.pricePerServer;
  }
  try {
    const res = await fetch(`/api/dr-strategy/columns?sessionId=${encodeURIComponent(state.sessionId)}`, {
      headers: state.tokenId ? { "X-Token-Id": state.tokenId } : {},
    });
    if (!res.ok) throw new Error(`columns ${res.status}`);
    const data = await res.json();
    state.drStrategy.candidates = data.candidates || [];
    state.drStrategy.suggested = data.suggested;
    populateDrColumnDropdown();
  } catch (e) {
    console.error("[DR Strategy] column fetch failed:", e.message);
    document.getElementById("drStrategyCalcInfo").textContent = "Could not load criticality candidates.";
  }
  // Wire control listeners (idempotent — re-running buildBCDREnvCheckboxes is safe)
  const colSel = document.getElementById("drCriticalityColumn");
  if (colSel && colSel.dataset.bound !== "1") {
    colSel.dataset.bound = "1";
    colSel.addEventListener("change", () => { rebuildDrTierTable(); recalcDrStrategy(); });
  }
  const priceInput = document.getElementById("drAsrPrice");
  if (priceInput && priceInput.dataset.bound !== "1") {
    priceInput.dataset.bound = "1";
    let debTimer = null;
    priceInput.addEventListener("input", () => {
      clearTimeout(debTimer);
      debTimer = setTimeout(recalcDrStrategy, 300);
    });
  }
  // Scope tabs replace the old "By Tier / By Application" toggle. Both views
  // are now always visible — the tabs only switch which set of servers feeds
  // the cost engine (deferred-only vs whole-estate). The Application Audit
  // accordion below the tier table is independent of the scope.
  const deferredTab = document.getElementById("drScopeDeferredTab");
  const wholeTab = document.getElementById("drScopeWholeTab");
  if (deferredTab && deferredTab.dataset.bound !== "1") {
    deferredTab.dataset.bound = "1";
    const switchScope = (s) => {
      state.drStrategy = state.drStrategy || {};
      state.drStrategy.scope = s;
      deferredTab.classList.toggle("active", s === "deferred");
      wholeTab.classList.toggle("active", s === "whole-estate");
      rebuildDrTierTable();
    };
    deferredTab.addEventListener("click", () => switchScope("deferred"));
    wholeTab.addEventListener("click", () => switchScope("whole-estate"));
  }
}

function populateDrColumnDropdown() {
  const sel = document.getElementById("drCriticalityColumn");
  if (!sel) return;
  const cands = state.drStrategy.candidates || [];
  // Preserve selection if user already picked one
  const current = sel.value;
  sel.innerHTML = `<option value="">— None (no tiering) —</option>`;
  for (const c of cands) {
    const opt = document.createElement("option");
    opt.value = c.column;
    opt.textContent = `${c.column} (${c.distinctCount} values, ${c.coverage}% coverage)`;
    sel.appendChild(opt);
  }
  if (current && cands.find(c => c.column === current)) {
    sel.value = current;
  } else if (state.drStrategy.suggested) {
    sel.value = state.drStrategy.suggested;
  }
  const hint = document.getElementById("drCriticalityColumnHint");
  if (hint) {
    if (state.drStrategy.suggested) {
      hint.textContent = `Auto-suggested: "${state.drStrategy.suggested}". Pick a different column if you tier servers another way.`;
    } else {
      hint.textContent = "No obvious tiering column found. Pick one or leave blank to apply a single strategy to all servers.";
    }
  }
  rebuildDrTierTable();
}

function rebuildDrTierTable() {
  const wrap = document.getElementById("drTierTableWrap");
  if (!wrap) return;
  const colSel = document.getElementById("drCriticalityColumn");
  const column = colSel ? colSel.value : "";
  const cands = state.drStrategy.candidates || [];
  const cand = cands.find(c => c.column === column);
  const scope = state.drStrategy?.scope === "whole-estate" ? "whole-estate" : "deferred";
  // Per-tier server counts + source storage filtered by current scope.
  // For the "Twins" column we ALSO compute env-distribution across the whole
  // estate (not scope-filtered) so the user can see how each tier maps to
  // primary apps regardless of which servers are being priced.
  const tierStats = computeTierStats(column, scope);
  const tierTwins = computeTierTwins(column);
  // Update scope-tab badges with current counts so user sees scope sizes.
  const allServers = state.assessmentReport?.servers || [];
  const deferredCount = allServers.filter(s => s.costDeferredToDr && !s.costExcluded).length;
  const wholeCount = allServers.filter(s => !s.costExcluded).length;
  const dBadge = document.getElementById("drScopeDeferredCount");
  const wBadge = document.getElementById("drScopeWholeCount");
  if (dBadge) dBadge.textContent = deferredCount;
  if (wBadge) wBadge.textContent = wholeCount;
  // If user is on Deferred tab but nothing is deferred, we render but show a
  // helpful empty-state message so they understand why no rows appear.
  const noDeferred = scope === "deferred" && deferredCount === 0;

  let rowsHtml = "";
  let totalServers = 0, totalSourceTB = 0;
  if (noDeferred) {
    rowsHtml = `<tr><td colspan="7" class="text-center text-muted small py-3"><i class="bi bi-info-circle"></i> No environments are set to <strong>Defer to DR Strategy</strong> in VM Assess. Either go back to Step 3 and defer your DR env, or switch to <strong>Whole Estate</strong> above.</td></tr>`;
  } else if (column && cand) {
    state.drStrategy.tierMap = state.drStrategy.tierMap || {};
    for (const v of cand.values) {
      const stat = tierStats[v.value] || { count: 0, sourceTB: 0 };
      // Skip tiers with zero servers in current scope (e.g. when on Deferred,
      // tiers that have no DR-side servers shouldn't clutter the table).
      if (stat.count === 0) continue;
      const existing = state.drStrategy.tierMap[v.value] || {};
      const strategy = existing.strategy || defaultStrategyFor(v.value);
      const stratOpts = DR_STRATEGY_OPTIONS.map(o => `<option value="${o.id}" ${o.id === strategy ? "selected" : ""}>${o.label}</option>`).join("");
      const def = DR_STRATEGY_OPTIONS.find(o => o.id === strategy) || DR_STRATEGY_OPTIONS[0];
      const rpoVal = existing.rpoHours ?? def.rpo;
      const rtoVal = existing.rtoHours ?? def.rto;
      const tbStr = stat.sourceTB > 0 ? `${stat.sourceTB.toFixed(1)} TB` : "—";
      totalServers += stat.count;
      totalSourceTB += stat.sourceTB;
      rowsHtml += `<tr data-tier="${escAttr(v.value)}">
        <td class="fw-semibold">${esc(v.value)}</td>
        <td class="text-end">${stat.count}</td>
        <td class="text-end text-muted small" title="Total source disk size for this tier in the current scope">${tbStr}</td>
        <td class="small text-muted" title="Distribution across environments (whole estate)">${formatTwinCounts(tierTwins[v.value])}</td>
        <td><select class="form-select form-select-sm dr-strategy-sel">${stratOpts}</select></td>
        <td><input type="text" class="form-control form-control-sm dr-rpo" value="${esc(formatHours(rpoVal))}" placeholder="hrs"></td>
        <td><input type="text" class="form-control form-control-sm dr-rto" value="${esc(formatHours(rtoVal))}" placeholder="hrs"></td>
        <td class="text-end" data-tier-cost>—</td>
      </tr>`;
    }
    const unmappedExists = (tierStats["__unmapped__"]?.count || 0) > 0;
    if (unmappedExists) {
      const stat = tierStats["__unmapped__"];
      const existing = state.drStrategy.tierMap["__unmapped__"] || {};
      const strategy = existing.strategy || "none";
      const stratOpts = DR_STRATEGY_OPTIONS.map(o => `<option value="${o.id}" ${o.id === strategy ? "selected" : ""}>${o.label}</option>`).join("");
      const tbStr = stat.sourceTB > 0 ? `${stat.sourceTB.toFixed(1)} TB` : "—";
      totalServers += stat.count;
      totalSourceTB += stat.sourceTB;
      rowsHtml += `<tr data-tier="__unmapped__" class="table-light">
        <td class="fst-italic text-muted">(no value)</td>
        <td class="text-end" data-unmapped-count>${stat.count}</td>
        <td class="text-end text-muted small">${tbStr}</td>
        <td class="small text-muted">${formatTwinCounts(tierTwins["__unmapped__"])}</td>
        <td><select class="form-select form-select-sm dr-strategy-sel">${stratOpts}</select></td>
        <td>—</td><td>—</td>
        <td class="text-end" data-tier-cost>—</td>
      </tr>`;
    }
  } else {
    // Single bucket — no criticality column picked. Apply one strategy to everything.
    const stat = tierStats["__default__"] || { count: 0, sourceTB: 0 };
    const existing = state.drStrategy.tierMap["__default__"] || {};
    const strategy = existing.strategy || "std-asr";
    const stratOpts = DR_STRATEGY_OPTIONS.map(o => `<option value="${o.id}" ${o.id === strategy ? "selected" : ""}>${o.label}</option>`).join("");
    const def = DR_STRATEGY_OPTIONS.find(o => o.id === strategy) || DR_STRATEGY_OPTIONS[0];
    const tbStr = stat.sourceTB > 0 ? `${stat.sourceTB.toFixed(1)} TB` : "—";
    totalServers += stat.count;
    totalSourceTB += stat.sourceTB;
    rowsHtml = `<tr data-tier="__default__">
      <td class="fw-semibold">All servers</td>
      <td class="text-end">${stat.count}</td>
      <td class="text-end text-muted small">${tbStr}</td>
      <td class="small text-muted">${formatTwinCounts(tierTwins["__default__"])}</td>
      <td><select class="form-select form-select-sm dr-strategy-sel">${stratOpts}</select></td>
      <td><input type="text" class="form-control form-control-sm dr-rpo" value="${esc(formatHours(existing.rpoHours ?? def.rpo))}" placeholder="hrs"></td>
      <td><input type="text" class="form-control form-control-sm dr-rto" value="${esc(formatHours(existing.rtoHours ?? def.rto))}" placeholder="hrs"></td>
      <td class="text-end" data-tier-cost>—</td>
    </tr>`;
  }

  // Total row gets injected after the recalc updates costs (we read tier-cost
  // cells once they're populated). For now placeholder is "—".
  const totalRow = `<tr class="table-secondary fw-semibold" data-total-row>
    <td>Total</td>
    <td class="text-end">${totalServers}</td>
    <td class="text-end small">${totalSourceTB > 0 ? totalSourceTB.toFixed(1) + " TB" : "—"}</td>
    <td></td><td></td><td></td><td></td>
    <td class="text-end" data-grand-cost>—</td>
  </tr>`;

  wrap.innerHTML = `
    ${renderDrStrategyGuidance()}
    ${renderScopeContextBanner(scope, totalServers, deferredCount, wholeCount)}
    <table class="table table-sm table-bordered align-middle mb-0 small">
      <thead class="table-light">
        <tr>
          <th>${column ? esc(column) : "Tier"}</th>
          <th class="text-end" style="width:70px;" title="Servers in this tier within the selected scope">Servers</th>
          <th class="text-end" style="width:80px;" title="Total source disk for this tier (in scope) \u2014 drives replicated-storage cost">Source</th>
          <th style="width:140px;" title="Whole-estate distribution: how this tier's servers split across environments">App Twins</th>
          <th style="width:230px;">DR Strategy</th>
          <th style="width:90px;">RPO (hr)</th>
          <th style="width:90px;">RTO (hr)</th>
          <th class="text-end" style="width:130px;">Monthly Cost</th>
        </tr>
      </thead>
      <tbody>${rowsHtml}${rowsHtml.includes("data-tier") ? totalRow : ""}</tbody>
    </table>`;
  // Bind row inputs. Strategy-change auto-applies the strategy's RPO/RTO defaults
  // so users see realistic numbers without having to type them.
  wrap.querySelectorAll(".dr-strategy-sel").forEach(el => {
    el.addEventListener("change", (e) => {
      const tr = e.target.closest("tr[data-tier]");
      const def = DR_STRATEGY_OPTIONS.find(o => o.id === e.target.value) || DR_STRATEGY_OPTIONS[0];
      const rpoIn = tr.querySelector(".dr-rpo");
      const rtoIn = tr.querySelector(".dr-rto");
      if (rpoIn) rpoIn.value = formatHours(def.rpo);
      if (rtoIn) rtoIn.value = formatHours(def.rto);
      captureDrTierMap();
      recalcDrStrategy();
    });
  });
  wrap.querySelectorAll(".dr-rpo, .dr-rto").forEach(el => {
    el.addEventListener("change", () => { captureDrTierMap(); recalcDrStrategy(); });
    el.addEventListener("input", () => {
      clearTimeout(state.drStrategy._inpTimer);
      state.drStrategy._inpTimer = setTimeout(() => { captureDrTierMap(); recalcDrStrategy(); }, 350);
    });
  });
  captureDrTierMap();
  recalcDrStrategy();
  // Always re-render the App Audit accordion content so it stays current.
  renderDrAppView();
}

// Format env-distribution counts for the "App Twins" column.
function formatTwinCounts(byEnv) {
  if (!byEnv) return "—";
  const ordered = ["Production", "Prod", "UAT", "SIT", "Development", "Dev", "Test", "DR"];
  const seen = new Set();
  const parts = [];
  for (const o of ordered) {
    if (byEnv[o] != null) { parts.push(`${byEnv[o]} ${o.slice(0, 4)}`); seen.add(o); }
  }
  for (const [k, v] of Object.entries(byEnv)) {
    if (!seen.has(k)) parts.push(`${v} ${k.slice(0, 4)}`);
  }
  return parts.length === 0 ? "—" : parts.join(" \u00b7 ");
}

// Compact context banner so the user always knows which servers are being priced.
function renderScopeContextBanner(scope, totalInTable, deferredCount, wholeCount) {
  if (scope === "whole-estate") {
    return `<div class="alert alert-secondary py-1 px-2 small mb-2"><i class="bi bi-globe"></i>
      <strong>Whole Estate scope:</strong> applying DR to all ${wholeCount} non-excluded servers (what-if scenario).
      Deferred-only scope shows ${deferredCount} servers.</div>`;
  }
  if (deferredCount === 0) {
    return `<div class="alert alert-warning py-1 px-2 small mb-2"><i class="bi bi-exclamation-triangle"></i>
      <strong>No deferred servers.</strong> Either go back to Step 3 and set an env (typically <code>DR</code>)
      to <em>Defer to DR Strategy</em>, or switch to <strong>Whole Estate</strong> to apply DR across all servers.</div>`;
  }
  return `<div class="alert alert-info py-1 px-2 small mb-2"><i class="bi bi-shield-check"></i>
    <strong>Deferred Servers scope:</strong> applying DR to the ${deferredCount} servers your VM Assess marked as
    <em>Defer to DR Strategy</em> (typically the DR site replicas).</div>`;
}

// Format an RPO/RTO hour value for display. Strings (e.g. "—" for None
// strategy) pass through; numbers are normalised so 0.1 stays "0.1" but
// 24.000 becomes "24".
function formatHours(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (!Number.isFinite(v)) return "";
  if (v === 0) return "0";
  if (v < 1) return v.toString(); // "0.1", "0.25"
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

// Aggregate per-tier server counts + total source disk size, FILTERED BY SCOPE.
// Used by the table to show counts that match the cost engine's scope.
function computeTierStats(column, scope) {
  const out = {};
  const servers = state.assessmentReport?.servers || [];
  for (const s of servers) {
    if (s.costExcluded) continue;
    if (scope === "deferred" && !s.costDeferredToDr) continue;
    // 'whole-estate': include everything (excluded already filtered above)
    const tier = column ? ((s.extraColumns || {})[column] || "").toString().trim() || "__unmapped__" : "__default__";
    if (!out[tier]) out[tier] = { sourceTB: 0, count: 0 };
    out[tier].count++;
    let sumGB = 0;
    for (const d of (s.diskDetails || [])) sumGB += (d.sourceSizeGB || 0);
    out[tier].sourceTB += sumGB / 1024;
  }
  return out;
}

// Count distribution of tier values across environments (whole estate, never
// scope-filtered). Used by the "App Twins" column so the user always sees
// e.g. "Tier 1: 2 Prod · 1 UAT · 1 DR" regardless of which scope is active.
function computeTierTwins(column) {
  const out = {};
  const servers = state.assessmentReport?.servers || [];
  for (const s of servers) {
    if (s.costExcluded) continue;
    const tier = column ? ((s.extraColumns || {})[column] || "").toString().trim() || "__unmapped__" : "__default__";
    if (!out[tier]) out[tier] = {};
    const env = s.environment || "Unknown";
    out[tier][env] = (out[tier][env] || 0) + 1;
  }
  return out;
}

// One-off help card explaining what each Azure DR pattern achieves so users
// can match RTO/RPO targets to the right strategy. Particularly useful for
// banking customers with strict tier-based DR policies (RPO≈0 → AA / Hot ASR,
// RPO 24hr → Standard ASR / Backup-Restore, etc.).
function renderDrStrategyGuidance() {
  const collapsed = state.drStrategy?._guidanceCollapsed ? "" : "show";
  return `
    <div class="accordion accordion-flush mb-2" id="drGuidanceAcc">
      <div class="accordion-item border rounded">
        <h2 class="accordion-header">
          <button class="accordion-button collapsed py-2 small" type="button" data-bs-toggle="collapse" data-bs-target="#drGuidanceBody">
            <i class="bi bi-info-circle me-1"></i> How to match RTO/RPO targets to the right strategy
          </button>
        </h2>
        <div id="drGuidanceBody" class="accordion-collapse collapse ${collapsed}">
          <div class="accordion-body py-2 small">
            <table class="table table-sm table-borderless mb-0 small">
              <thead class="table-light">
                <tr><th>Strategy</th><th>Achievable RPO</th><th>Achievable RTO</th><th>What you pay</th><th>Use when…</th></tr>
              </thead>
              <tbody>
                <tr><td><strong>Active-Active</strong></td><td><strong>0 (sync)</strong></td><td>≤30 min</td><td>100% DR compute + 100% storage</td><td>RPO must be zero. Mission-critical, regulator demands continuous availability.</td></tr>
                <tr><td><strong>Hot ASR</strong></td><td>seconds (near 0)</td><td>≤2 hr</td><td>30% DR compute + storage + ASR licence</td><td>Near-zero RPO acceptable, RTO ≤4hr. Warm DR pool means fast failover.</td></tr>
                <tr><td><strong>Standard ASR</strong></td><td>~15 min</td><td>≤4 hr (≤24 hr with config)</td><td>0 standing compute + storage + ASR licence</td><td>RPO ≤1hr, RTO ≤24hr. DR VMs spin up only on failover. Most cost-effective for tiered workloads.</td></tr>
                <tr><td><strong>Backup-Restore</strong></td><td>24 hr (daily)</td><td>~24 hr</td><td>GRS backup storage (already in Backup line)</td><td>RPO 24hr+ acceptable, RTO 24hr+ acceptable. Cheapest DR, but slowest recovery.</td></tr>
                <tr><td><strong>None</strong></td><td>—</td><td>—</td><td>0</td><td>App not in DR scope. Best-effort recovery from fresh build / source.</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>`;
}

function captureDrTierMap() {
  const wrap = document.getElementById("drTierTableWrap");
  if (!wrap) return;
  const map = {};
  wrap.querySelectorAll("tr[data-tier]").forEach(tr => {
    const key = tr.getAttribute("data-tier");
    const strategy = tr.querySelector(".dr-strategy-sel")?.value || "none";
    const rpoStr = tr.querySelector(".dr-rpo")?.value;
    const rtoStr = tr.querySelector(".dr-rto")?.value;
    // parseFloat handles "0.25" / "24" / "0.05" cleanly. Empty / "—" / NaN
    // fall back to the strategy's default so the cell is never silently null.
    const def = DR_STRATEGY_OPTIONS.find(o => o.id === strategy) || DR_STRATEGY_OPTIONS[0];
    const rpoP = rpoStr === undefined ? NaN : parseFloat(rpoStr);
    const rtoP = rtoStr === undefined ? NaN : parseFloat(rtoStr);
    const rpo = Number.isFinite(rpoP) ? rpoP : (Number.isFinite(def.rpo) ? def.rpo : null);
    const rto = Number.isFinite(rtoP) ? rtoP : (Number.isFinite(def.rto) ? def.rto : null);
    map[key] = { strategy, rpoHours: rpo, rtoHours: rto };
  });
  state.drStrategy.tierMap = map;
}

async function recalcDrStrategy() {
  if (!state.sessionId || !state.assessmentReport) return;
  const colSel = document.getElementById("drCriticalityColumn");
  const column = colSel ? colSel.value : "";
  const asrPrice = parseFloat(document.getElementById("drAsrPrice")?.value) || 25;
  const tierMap = state.drStrategy?.tierMap || {};
  const scope = state.drStrategy?.scope === "whole-estate" ? "whole-estate" : "deferred";
  try {
    const res = await fetch("/api/dr-strategy/calculate", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(state.tokenId ? { "X-Token-Id": state.tokenId } : {}) },
      body: JSON.stringify({ sessionId: state.sessionId, column, tierMap, asrPricePerServer: asrPrice, scope }),
    });
    if (!res.ok) throw new Error(`calc ${res.status}`);
    const data = await res.json();
    state.drStrategy.lastResult = data;
    // Backend may have downgraded scope (e.g. user picked deferred but nothing
    // is deferred) — reflect the final scope it used.
    if (data.scope) state.drStrategy.scope = data.scope;
    renderDrStrategyResult(data);
    // Push the rolled-up cost into Step 5's existing structure so BOM and
    // step5GrandTotal continue to work without changes.
    state.step5Costs.asr = data.totals.monthlyCost;
    state.step5ASRInfo = {
      servers: (data.tierResults || []).reduce((a, r) => a + (r.serverCount || 0), 0),
      strategies: data.tierResults.map(r => `${r.tier}=${r.strategy}`).join(", "),
    };
    updateStep5Totals();
  } catch (e) {
    console.error("[DR Strategy] recalc failed:", e.message);
    document.getElementById("drStrategyCalcInfo").textContent = `Calculation failed: ${e.message}`;
  }
}

function renderDrStrategyResult(data) {
  const wrap = document.getElementById("drTierTableWrap");
  if (!wrap) return;
  const byTier = {};
  for (const t of (data.tierResults || [])) byTier[t.tierKey] = t;
  wrap.querySelectorAll("tr[data-tier]").forEach(tr => {
    const key = tr.getAttribute("data-tier");
    const t = byTier[key];
    const cell = tr.querySelector("[data-tier-cost]");
    if (cell) cell.textContent = t ? `USD ${fmtCost(t.monthlyCost)}` : "—";
    const unmappedCount = tr.querySelector("[data-unmapped-count]");
    if (unmappedCount && t) unmappedCount.textContent = t.serverCount;
  });
  // Populate the grand-total row's cost cell so the matrix self-reconciles.
  const grandCell = wrap.querySelector("[data-grand-cost]");
  if (grandCell) grandCell.textContent = `USD ${fmtCost(data.totals?.monthlyCost || 0)}`;
  const total = data.totals?.monthlyCost || 0;
  document.getElementById("drStrategyCostBadge").textContent = `USD ${fmtCost(total)}/mo`;
  // Calc-info line: explain the totals and any unmapped count.
  const totals = data.totals || {};
  const parts = [
    `Compute USD ${fmtCost(totals.drCompute || 0)}`,
    `Storage USD ${fmtCost(totals.drStorage || 0)}`,
    `Licence USD ${fmtCost(totals.drLicense || 0)}`,
  ];
  document.getElementById("drStrategyCalcInfo").textContent = `Total: ${parts.join("  ·  ")}.`;
  // App audit accordion always renders \u2014 keep its content in sync with the
  // latest pairing snapshot whenever the strategy result lands.
  renderDrAppView();
  // Conflict check: if the user left a DR-named env in 'Lift & Shift' mode AND
  // they're now applying a DR strategy, the same servers are double-counted
  // (once in L&S compute total, once in this DR Strategy box). Surface a
  // warning with a one-click "defer" button so the BOM stays defensible.
  renderDrConflictWarning();
}

// Detect environments whose name looks like 'DR' but whose costMode is still
// the default 'lns'. When a DR Strategy is active these servers are paying
// twice. We surface a banner above the matrix with a one-click fix.
function renderDrConflictWarning() {
  const wrap = document.getElementById("drTierTableWrap");
  if (!wrap || !wrap.parentNode) return;
  let banner = document.getElementById("drConflictBanner");
  const drNameRegex = /^(dr|d\.?r|disaster.?recovery|dr.?site)$/i;
  const conflicting = (state.environments || []).filter(env => {
    const norm = String(env || "").trim().toLowerCase().replace(/[\s_\-./]/g, "");
    const looksLikeDr = norm === "dr" || norm === "drsite" || norm === "disasterrecovery";
    const cfg = state.envConfigs[env] || {};
    return looksLikeDr && (cfg.costMode || "lns") === "lns";
  });
  if (conflicting.length === 0) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "drConflictBanner";
    banner.className = "alert alert-warning py-2 px-3 small mb-2 d-flex align-items-start gap-2";
    wrap.parentNode.insertBefore(banner, wrap);
  }
  const envList = conflicting.map(e => `<strong>${esc(e)}</strong>`).join(", ");
  const totalSrv = conflicting.reduce((a, e) => a + (state.envReports?.[e]?.summary?.totalServers || 0), 0);
  banner.innerHTML = `
    <i class="bi bi-exclamation-triangle-fill text-warning"></i>
    <div class="flex-grow-1">
      <strong>Possible double-count:</strong> ${envList} (${totalSrv} servers) is still in <em>Lift &amp; Shift</em> mode while a DR Strategy is being applied above.
      The DR-side compute for those servers is counted twice — once as L&amp;S compute, once as DR Strategy cost.
      Move the DR environment to <em>Defer to DR Strategy</em> so its sized SKUs feed the strategy multiplier (Hot ASR / Active-Active) without inflating the L&amp;S total.
    </div>
    <button type="button" class="btn btn-warning btn-sm" id="drDeferEnvBtn">
      <i class="bi bi-shield-check"></i> Defer ${conflicting.length === 1 ? "this env" : "these envs"} now
    </button>`;
  document.getElementById("drDeferEnvBtn")?.addEventListener("click", async () => {
    for (const env of conflicting) {
      const cfg = state.envConfigs[env] = state.envConfigs[env] || {};
      cfg.costMode = "dr-defer";
      // Reflect in the env-tab dropdown so the user sees the change visually
      const envId = env.replace(/[^a-zA-Z0-9]/g, "_");
      const sel = document.getElementById(`costMode-${envId}`);
      if (sel) sel.value = "dr-defer";
      // Trigger an instant cost-only recalc on the env (no re-matching needed
      // for an lns→dr-defer flip — the rows are already sized).
      await recalculateEnv(env);
    }
    // Re-run DR strategy to reflect the new (smaller) primary base.
    recalcDrStrategy();
  });
}

// switchDrView() removed — the old tier/app toggle was replaced by Scope tabs
// (Deferred Servers vs Whole Estate). Both tier matrix and app audit are now
// always rendered: tier table on top, app audit accordion below.

function renderDrAppView() {
  const wrap = document.getElementById("drAppTableWrap");
  if (!wrap) return;
  const pairing = state.assessmentReport?.applicationPairing;
  if (!pairing || !pairing.column || !pairing.apps?.length) {
    wrap.innerHTML = `<div class="alert alert-warning small mb-0"><i class="bi bi-exclamation-triangle"></i> No <strong>Business Application</strong> column found in the inventory. Reconciliation view needs an app column to pair DR servers with their primary counterparts.</div>`;
    return;
  }
  const result = state.drStrategy?.lastResult;
  const colSel = document.getElementById("drCriticalityColumn");
  const tierColumn = colSel?.value || "";

  // Build a quick lookup: for each server, what tier value does it have?
  const tierByServer = new Map();
  if (tierColumn) {
    for (const s of state.assessmentReport.servers) {
      tierByServer.set(s.serverName, ((s.extraColumns || {})[tierColumn] || "").toString().trim() || "(no value)");
    }
  }
  const strategyByTier = new Map();
  for (const t of (result?.tierResults || [])) strategyByTier.set(t.tierKey, t.strategy);

  // For each app, determine its dominant tier (most common tier value among its servers)
  // and roll up its DR-side cost from its servers' contribution.
  const rows = pairing.apps.map(app => {
    const counts = { prod: 0, uat: 0, dr: 0, other: 0, total: app.total };
    for (const s of app.servers) {
      const e = (s.env || "").toLowerCase();
      if (/^prod/.test(e)) counts.prod++;
      else if (/^uat/.test(e)) counts.uat++;
      else if (/^dr|disaster/.test(e)) counts.dr++;
      else counts.other++;
    }
    // Dominant tier among this app's servers
    const tierCounts = new Map();
    for (const s of app.servers) {
      const t = tierByServer.get(s.name) || "(no value)";
      tierCounts.set(t, (tierCounts.get(t) || 0) + 1);
    }
    let dominantTier = "(no value)";
    let dominantCount = 0;
    for (const [t, c] of tierCounts) if (c > dominantCount) { dominantTier = t; dominantCount = c; }
    const tierKey = dominantTier === "(no value)" ? "__unmapped__" : dominantTier;
    const strategy = strategyByTier.get(tierKey) || "none";
    return { app: app.name, tier: dominantTier, strategy, counts, pairingStatus: app.pairingStatus || "no-dr" };
  }).sort((a, b) => b.counts.total - a.counts.total);

  const stratLabel = id => (DR_STRATEGY_OPTIONS.find(o => o.id === id) || {}).label || id;

  // Categorise apps that have DR servers into 3 groups for the fix-it section
  const orphanApps = rows.filter(r => r.pairingStatus === "orphan-dr");
  const uatOnlyApps = rows.filter(r => r.pairingStatus === "uat-only");
  const pairedApps = rows.filter(r => r.pairingStatus === "paired");
  const allAppsForDropdown = pairing.apps.map(a => a.name).sort();
  const decisions = state.drStrategy?.orphanDecisions || {};

  // Helper: render the fix-it card for one orphan / uat-only app.
  // Default action = "lns" (Keep in L&S) for pre-sales conservative pricing.
  function fixItCard(r, isUatOnly) {
    const dec = decisions[r.app] || { action: "lns" };
    const action = dec.action || "lns";
    const stratValue = dec.strategy || "std-asr";
    const mapValue = dec.mapToApp || "";
    const stratOpts = DR_STRATEGY_OPTIONS.filter(o => o.id !== "none").map(o =>
      `<option value="${o.id}" ${stratValue === o.id ? "selected" : ""}>${o.label}</option>`).join("");
    const mapOpts = `<option value="">— pick app —</option>` + allAppsForDropdown
      .filter(a => a !== r.app)
      .map(a => `<option value="${escAttr(a)}" ${mapValue === a ? "selected" : ""}>${esc(a)}</option>`).join("");
    const sel = (val) => action === val ? "checked" : "";
    const subRowsVisible = (val) => action === val ? "" : "hidden";
    const cardClass = isUatOnly ? "border-info" : "border-warning";
    const headerClass = isUatOnly ? "text-info" : "text-warning";
    const headerIcon = isUatOnly ? "bi-info-circle" : "bi-exclamation-triangle";
    const headerLabel = isUatOnly
      ? `Paired with UAT only (no Production twin)`
      : `Orphan — no Prod/UAT/SIT/Dev twin`;
    return `
      <div class="card ${cardClass} mb-2" data-orphan-app="${escAttr(r.app)}">
        <div class="card-body p-2">
          <div class="d-flex justify-content-between align-items-start mb-2 flex-wrap gap-2">
            <div>
              <strong>${esc(r.app)}</strong>
              <span class="badge bg-light text-dark border ms-2">${r.counts.dr} DR ${r.counts.dr === 1 ? "server" : "servers"}</span>
              <span class="badge bg-light text-dark border ms-1">${r.counts.uat || 0} UAT</span>
              <span class="badge bg-light text-dark border ms-1">${r.counts.prod || 0} Prod</span>
            </div>
            <small class="${headerClass}"><i class="bi ${headerIcon}"></i> ${headerLabel}</small>
          </div>
          <div class="d-flex flex-column gap-1">
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 orphan-action" name="orphan-${escAttr(r.app)}" value="lns" ${sel("lns")}>
              <span><strong>Keep in Lift &amp; Shift total</strong> <span class="badge bg-success-subtle text-success-emphasis border border-success-subtle">recommended for pre-sales</span><br>
              <span class="text-muted">Conservative pricing — every server is counted. Validate at deep assessment whether they are shared infra (keep), mislabelled (re-tag), or ghost (exclude).</span></span>
            </label>
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 orphan-action" name="orphan-${escAttr(r.app)}" value="dr-strategy" ${sel("dr-strategy")}>
              <span><strong>Apply DR strategy directly</strong><br>
              <span class="text-muted">Use when these are confirmed DR servers for shared infra (e.g. AD DCs at the DR site).</span>
              <span class="d-inline-block ${subRowsVisible("dr-strategy")} mt-1" data-sub="dr-strategy">
                <select class="form-select form-select-sm orphan-strategy" style="display:inline-block; width:auto;">${stratOpts}</select>
              </span></span>
            </label>
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 orphan-action" name="orphan-${escAttr(r.app)}" value="map" ${sel("map")}>
              <span><strong>Mapped to a primary app</strong> (mislabelled inventory)<br>
              <span class="text-muted">Reconciles this app to another — useful when the inventory tag is wrong.</span>
              <span class="d-inline-block ${subRowsVisible("map")} mt-1" data-sub="map">
                <select class="form-select form-select-sm orphan-map" style="display:inline-block; width:auto;">${mapOpts}</select>
              </span></span>
            </label>
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 orphan-action" name="orphan-${escAttr(r.app)}" value="exclude" ${sel("exclude")}>
              <span><strong>Exclude from migration</strong><br>
              <span class="text-muted">Use only when confirmed ghost / decommissioned. Validate with the customer first.</span></span>
            </label>
          </div>
        </div>
      </div>`;
  }

  const orphanFixItHtml = (orphanApps.length === 0 && uatOnlyApps.length === 0)
    ? `<div class="alert alert-success small mb-2"><i class="bi bi-check-circle"></i> <strong>All DR servers are paired with a Prod or UAT counterpart</strong> — no orphans.</div>`
    : `
      <div class="alert alert-warning small mb-2 py-2">
        <i class="bi bi-exclamation-triangle"></i>
        <strong>${orphanApps.length + uatOnlyApps.length} app${(orphanApps.length + uatOnlyApps.length) === 1 ? " has" : "s have"} DR servers without a clear Production twin.</strong>
        Default treatment is <strong>Keep in Lift &amp; Shift</strong> (conservative pre-sales pricing). Review each below and refine during deep assessment.
      </div>
      <div class="row g-2 mb-3">
        <div class="col-12">
          ${orphanApps.map(r => fixItCard(r, false)).join("")}
          ${uatOnlyApps.map(r => fixItCard(r, true)).join("")}
        </div>
      </div>`;

  // SQL replica candidates section — apps that have BOTH a Prod SQL VM AND a
  // DR SQL VM. Default treatment is Always-On AG / Mirroring (active-active)
  // because that's both the common DBA pattern AND the conservative-pricing
  // choice (Active-Active > Standard ASR). User can downgrade per app.
  const sqlCandidates = state.assessmentReport?.sqlReplicaCandidates || [];
  const sqlDecisions = state.drStrategy?.sqlDecisions || {};
  const sqlCard = (cand) => {
    const dec = sqlDecisions[cand.app] || { action: "ag" };
    const action = dec.action || "ag";
    const sel = (v) => action === v ? "checked" : "";
    return `
      <div class="card border-primary mb-2" data-sql-app="${escAttr(cand.app)}">
        <div class="card-body p-2">
          <div class="d-flex justify-content-between align-items-start mb-2 flex-wrap gap-2">
            <div>
              <strong>${esc(cand.app)}</strong>
              <span class="badge bg-light text-dark border ms-2">${cand.sqlProdCount} Prod SQL</span>
              <span class="badge bg-light text-dark border ms-1">${cand.sqlDrCount} DR SQL</span>
            </div>
            <small class="text-primary"><i class="bi bi-database"></i> SQL replica candidate</small>
          </div>
          <div class="text-muted small mb-2">
            Prod SQL: <code>${cand.sqlProdServers.map(esc).join(", ")}</code><br>
            DR SQL: <code>${cand.sqlDrServers.map(esc).join(", ")}</code>
          </div>
          <div class="d-flex flex-column gap-1">
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 sql-action" name="sql-${escAttr(cand.app)}" value="ag" ${sel("ag")}>
              <span><strong>SQL Always-On AG / Database Mirroring</strong> <span class="badge bg-success-subtle text-success-emphasis border border-success-subtle">recommended</span><br>
              <span class="text-muted">DR SQL VMs treated as <em>active-active</em> replicas — sized at 100% compute, full storage, no ASR licence. Failover handled by SQL AG, not ASR.</span></span>
            </label>
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 sql-action" name="sql-${escAttr(cand.app)}" value="asr" ${sel("asr")}>
              <span><strong>Standalone SQL with ASR</strong><br>
              <span class="text-muted">DR SQL VMs treated as cold ASR target — 0 standing compute, full replicated storage, ASR licence per VM. Use only when SQL is NOT in an AG.</span></span>
            </label>
            <label class="small d-flex align-items-start gap-2">
              <input type="radio" class="form-check-input mt-1 sql-action" name="sql-${escAttr(cand.app)}" value="tier" ${sel("tier")}>
              <span><strong>Use this app's tier strategy</strong><br>
              <span class="text-muted">SQL servers follow whatever DR strategy was assigned to this app's tier (no special handling).</span></span>
            </label>
          </div>
        </div>
      </div>`;
  };
  const sqlFixItHtml = sqlCandidates.length === 0 ? "" : `
    <div class="alert alert-info small mb-2 py-2">
      <i class="bi bi-database"></i>
      <strong>${sqlCandidates.length} app${sqlCandidates.length === 1 ? " has" : "s have"} SQL servers in both Prod and DR.</strong>
      These are likely <strong>SQL Always-On AG or Database Mirroring</strong> setups — DR-side SQL VMs run 24×7 as active replicas, not as cold ASR targets.
      Default treatment is Always-On AG. Confirm or override per app below.
    </div>
    <div class="row g-2 mb-3">
      <div class="col-12">
        ${sqlCandidates.map(sqlCard).join("")}
      </div>
    </div>`;

  // Paired apps go in the standard reconciliation table.
  const tableHtml = pairedApps.length === 0 ? "" : `
    <h6 class="small mb-1">Paired applications (${pairedApps.length})</h6>
    <div class="table-responsive" style="max-height:340px;">
      <table class="table table-sm table-bordered align-middle small mb-0">
        <thead class="table-light position-sticky top-0">
          <tr>
            <th>Business Application</th>
            <th class="text-end">Total</th>
            <th class="text-end">Prod</th>
            <th class="text-end">UAT</th>
            <th class="text-end">DR</th>
            <th>Tier</th>
            <th>Strategy</th>
          </tr>
        </thead>
        <tbody>${pairedApps.map(r => `<tr>
          <td class="fw-semibold">${esc(r.app)}</td>
          <td class="text-end">${r.counts.total}</td>
          <td class="text-end">${r.counts.prod || ""}</td>
          <td class="text-end">${r.counts.uat || ""}</td>
          <td class="text-end ${r.counts.dr ? "text-info fw-semibold" : ""}">${r.counts.dr || ""}</td>
          <td>${esc(r.tier)}</td>
          <td><span class="badge bg-secondary">${esc(stratLabel(r.strategy))}</span></td>
        </tr>`).join("")}</tbody>
      </table>
    </div>`;

  wrap.innerHTML = `${sqlFixItHtml}${orphanFixItHtml}${tableHtml}`;

  // Update the App Audit accordion's header badge with a count of items needing
  // attention (orphan/uat-only apps + SQL candidates) so the user knows whether
  // it's worth opening the section.
  const auditBadge = document.getElementById("drAppAuditBadge");
  if (auditBadge) {
    const issues = orphanApps.length + uatOnlyApps.length + sqlCandidates.length;
    auditBadge.textContent = issues > 0
      ? `${issues} need${issues === 1 ? "s" : ""} review`
      : `${pairing.apps.length} apps · all paired`;
    auditBadge.className = issues > 0
      ? "badge bg-warning text-dark ms-2"
      : "badge bg-success ms-2";
  }

  // Wire fix-it card listeners. Any change → recompute decisions object → POST.
  wrap.querySelectorAll(".orphan-action, .orphan-strategy, .orphan-map").forEach(el => {
    el.addEventListener("change", () => {
      // When a radio changes, also reveal/hide its sub-row siblings.
      if (el.classList.contains("orphan-action")) {
        const card = el.closest("[data-orphan-app]");
        if (card) {
          card.querySelectorAll("[data-sub]").forEach(sub => {
            sub.classList.toggle("hidden", sub.getAttribute("data-sub") !== el.value);
          });
        }
      }
      pushOrphanDecisions();
    });
  });
  // SQL card listeners: any radio change → push SQL decisions
  wrap.querySelectorAll(".sql-action").forEach(el => {
    el.addEventListener("change", pushSqlDecisions);
  });
}

// Collect every fix-it card's current state and POST it. Default = "lns".
async function pushOrphanDecisions() {
  if (!state.sessionId) return;
  const wrap = document.getElementById("drAppTableWrap");
  if (!wrap) return;
  const decisions = {};
  wrap.querySelectorAll("[data-orphan-app]").forEach(card => {
    const app = card.getAttribute("data-orphan-app");
    const action = card.querySelector(".orphan-action:checked")?.value || "lns";
    const entry = { action };
    if (action === "dr-strategy") entry.strategy = card.querySelector(".orphan-strategy")?.value || "std-asr";
    if (action === "map") {
      const m = card.querySelector(".orphan-map")?.value;
      if (m) entry.mapToApp = m;
      else return; // skip incomplete map decisions
    }
    decisions[app] = entry;
  });
  state.drStrategy = state.drStrategy || {};
  state.drStrategy.orphanDecisions = decisions;
  try {
    const res = await fetch("/api/dr-strategy/orphan-decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(state.tokenId ? { "X-Token-Id": state.tokenId } : {}) },
      body: JSON.stringify({ sessionId: state.sessionId, decisions }),
    });
    if (!res.ok) throw new Error(`orphan-decisions ${res.status}`);
    const data = await res.json();
    state.assessmentReport = data.combined;
    // Re-run DR strategy to reflect new buckets (orphans pushed to L&S leave
    // the DR pool; orphans forced to a strategy create new synthetic rows).
    await recalcDrStrategy();
    // Also refresh per-env summary cards + combined total.
    if (state.environments) {
      for (const env of state.environments) {
        const r = data.combined.servers ? null : null;
        // We don't have per-env reports back from this endpoint, but the
        // combined refresh + recalcDrStrategy will reload Step 4's view.
      }
    }
    // Rerender the by-app view itself so badges/totals reflect new state.
    renderDrAppView();
    // L&S server count may have shifted (orphans pushed to L&S or back to DR),
    // so refresh egress which is per-server-driven.
    calculateEgressCost();
  } catch (e) { console.error("[Orphan decisions] failed:", e.message); }
}

// Collect every SQL fix-it card's current state and POST it. Default = "ag".
async function pushSqlDecisions() {
  if (!state.sessionId) return;
  const wrap = document.getElementById("drAppTableWrap");
  if (!wrap) return;
  const decisions = {};
  wrap.querySelectorAll("[data-sql-app]").forEach(card => {
    const app = card.getAttribute("data-sql-app");
    const action = card.querySelector(".sql-action:checked")?.value || "ag";
    decisions[app] = { action };
  });
  state.drStrategy = state.drStrategy || {};
  state.drStrategy.sqlDecisions = decisions;
  try {
    const res = await fetch("/api/dr-strategy/sql-decisions", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(state.tokenId ? { "X-Token-Id": state.tokenId } : {}) },
      body: JSON.stringify({ sessionId: state.sessionId, decisions }),
    });
    if (!res.ok) throw new Error(`sql-decisions ${res.status}`);
    const data = await res.json();
    state.assessmentReport = data.combined;
    await recalcDrStrategy();
    renderDrAppView();
    // SQL decisions don't change L&S vs deferred totals (SQL DR rows are
    // already in the deferred bucket), but recompute egress defensively to
    // keep the calc-info note in sync.
    calculateEgressCost();
  } catch (e) { console.error("[SQL decisions] failed:", e.message); }
}

function escAttr(s) { return String(s).replace(/"/g, "&quot;").replace(/'/g, "&#39;"); }

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
// Per-env retention/redundancy listeners are bound dynamically inside
// buildBackupEnvPolicyTable. Only the global change-rate + compression remain
// page-level wired listeners since those apply to the whole table.
document.getElementById("backupChangeRate").addEventListener("input", calculateBackupCost);
document.getElementById("backupCompression")?.addEventListener("input", calculateBackupCost);

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

// Fetch the ALZ diagram XML from the backend using the values currently in the
// form. Returns a string of mxfile XML, or throws.
async function fetchAlzDiagramXml() {
  const customerName = (state.customerName || "").trim();
  if (!customerName) throw new Error("Set a Customer Name in Step 1 first.");
  const primaryRegion = document.getElementById("alzPrimaryRegion")?.value.trim() || "";
  const drRegion = document.getElementById("alzDrRegion")?.value.trim() || "";
  const wgRaw = document.getElementById("alzWorkloadGroups")?.value.trim() || "";
  const workloadGroups = wgRaw.split(",").map(s => s.trim()).filter(Boolean);

  const res = await fetch("/api/architecture/landing-zone", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ customerName, primaryRegion, drRegion, workloadGroups }),
  });
  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(errBody.error || `HTTP ${res.status}`);
  }
  return await res.text();
}

// Preview the ALZ diagram inline using the diagrams.net embed protocol.
// We wait for the iframe's `init` message, then push the XML via postMessage \u2014
// avoids URL-length limits and works with the chromeless viewer UI.
document.getElementById("previewAlzDiagram")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  const status = document.getElementById("alzDiagramStatus");
  const previewBox = document.getElementById("alzDiagramPreview");
  const frame = document.getElementById("alzDiagramFrame");
  if (!previewBox || !frame) return;

  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Loading\u2026';
  if (status) { status.textContent = ""; status.className = "text-muted small"; }

  try {
    const xml = await fetchAlzDiagramXml();

    // One-shot message listener: the embed posts `{event:'init'}` when ready.
    const onMsg = (ev) => {
      // Only react to messages from the diagrams.net embed origin.
      if (ev.source !== frame.contentWindow) return;
      let data;
      try { data = typeof ev.data === "string" ? JSON.parse(ev.data) : ev.data; } catch { return; }
      if (data && data.event === "init") {
        frame.contentWindow.postMessage(JSON.stringify({
          action: "load",
          xml,
          autosave: 0,
        }), "*");
        window.removeEventListener("message", onMsg);
        if (status) { status.textContent = "\u2713 Preview loaded"; status.className = "text-success small"; }
      }
    };
    window.addEventListener("message", onMsg);

    // Chromeless viewer with minimal UI. `proto=json` enables the postMessage API.
    frame.src = "https://embed.diagrams.net/?embed=1&ui=min&spin=1&proto=json&saveAndExit=0&noSaveBtn=1&noExitBtn=1";
    previewBox.classList.remove("hidden");
  } catch (err) {
    if (status) { status.textContent = "Preview failed: " + err.message; status.className = "text-danger small"; }
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-eye"></i> Preview';
  }
});

document.getElementById("closeAlzPreview")?.addEventListener("click", () => {
  const previewBox = document.getElementById("alzDiagramPreview");
  const frame = document.getElementById("alzDiagramFrame");
  if (previewBox) previewBox.classList.add("hidden");
  if (frame) frame.src = "about:blank"; // tear down the embed
});

// Download the customer-branded Azure Landing Zone diagram (.drawio).
// Pulls customer name from session state and the rest from the form inputs.
document.getElementById("downloadAlzDiagram")?.addEventListener("click", async (e) => {
  e.preventDefault();
  const btn = e.currentTarget;
  const status = document.getElementById("alzDiagramStatus");
  const customerName = (state.customerName || "").trim();
  if (!customerName) {
    if (status) { status.textContent = "Set a Customer Name in Step 1 first."; status.className = "text-danger small"; }
    return;
  }
  const primaryRegion = document.getElementById("alzPrimaryRegion")?.value.trim() || "";
  const drRegion = document.getElementById("alzDrRegion")?.value.trim() || "";
  const wgRaw = document.getElementById("alzWorkloadGroups")?.value.trim() || "";
  const workloadGroups = wgRaw.split(",").map(s => s.trim()).filter(Boolean);

  btn.disabled = true; btn.innerHTML = '<span class="spinner-border spinner-border-sm me-1"></span>Generating…';
  if (status) { status.textContent = ""; status.className = "text-muted small"; }
  try {
    const res = await fetch("/api/architecture/landing-zone", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ customerName, primaryRegion, drRegion, workloadGroups }),
    });
    if (!res.ok) {
      const errBody = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(errBody.error || `HTTP ${res.status}`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `ALZ_${customerName.replace(/[^a-zA-Z0-9_-]/g, "_")}.drawio`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    if (status) { status.textContent = "\u2713 Downloaded. Open in app.diagrams.net or the VS Code Draw.io extension."; status.className = "text-success small"; }
  } catch (err) {
    if (status) { status.textContent = "Failed: " + err.message; status.className = "text-danger small"; }
  } finally {
    btn.disabled = false; btn.innerHTML = '<i class="bi bi-download"></i> Download .drawio';
  }
});


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

  // License core counts — BYOL conversation. Only count L&S servers; deferred
  // and excluded rows aren't paying for Azure compute so they aren't licensed
  // License core counts — BYOL conversation. Only count L&S servers; deferred
  // and excluded rows aren't paying for Azure compute so they aren't licensed
  // here either. SQL is a subset of Windows when SQL on Windows; we still tally
  // it separately so pre-sales can quote SQL Server licences alongside Windows.
  // Respect AHUB per env: when AHUB is off the licence is bundled into Azure
  // compute (not BYOL), so those cores shouldn't appear on the BYOL line —
  // matches the per-env table semantics.
  let winCores = 0, sqlCores = 0, linuxCores = 0;
  for (const srv of report.servers) {
    if (srv.costExcluded || srv.costDeferredToDr) continue;
    const osLC = (srv.osName || "").toLowerCase();
    const nameLC = (srv.serverName || "").toLowerCase();
    const isWindows = srv.isWindows || /windows|win2008|win2003|win2012|win2016|win2019|win2022/.test(osLC);
    const isLinux = /linux|red\s*hat|rhel|centos|ubuntu|debian|suse|oracle\s*linux|amazon\s*linux/.test(osLC);
    const cores = Number(srv.vmCores) || 0;
    const envCfg = state.envConfigs?.[srv.environment] || {};
    const ahubOnForEnv = envCfg.useAhub !== false;
    if (isWindows && ahubOnForEnv) winCores += cores;
    else if (isLinux) linuxCores += cores;
    // SQL cores: same AHUB-respect — if Windows and AHUB-off, SQL licence is
    // also bundled, so don't count it as BYOL. SQL on Linux (always BYOL) still
    // counts.
    if ((nameLC.includes("sql") || osLC.includes("sql")) && (!isWindows || ahubOnForEnv)) sqlCores += cores;
  }
  document.getElementById("bom_winCores").textContent = winCores;
  document.getElementById("bom_sqlCores").textContent = sqlCores;
  // The Linux row has no dedicated cores span in the HTML; inject one so the
  // operator can see Azure cores beside the BYOL/RHEL Cloud Access price field.
  const linuxRow = document.getElementById("bom_linuxlicense")?.closest("tr");
  const linuxLabel = linuxRow?.querySelector(".bom-sub-item");
  if (linuxLabel) linuxLabel.innerHTML = `Linux &mdash; Total Cores: <span id="bom_linuxCores">${linuxCores}</span>`;
  state.bomLicenseCores = { winCores, sqlCores, linuxCores };
  if (isFirstRender) {
    // Leave inputs blank so pre-sales fills in the BYOL/SA rate. A literal 0.00
    // misleads procurement into thinking the licence cost is genuinely zero.
    document.getElementById("bom_winlicense").value = "";
    document.getElementById("bom_sqllicense").value = "";
    document.getElementById("bom_linuxlicense").value = "";
    document.getElementById("bom_otherdb").value = "";
    document.getElementById("bom_winlicense").placeholder = "BYOL/SA rate $/mo";
    document.getElementById("bom_sqllicense").placeholder = "BYOL/SA rate $/mo";
    document.getElementById("bom_linuxlicense").placeholder = "RHEL/SUSE plan $/mo";
    document.getElementById("bom_otherdb").placeholder = "$/mo";
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
    // Strip thousands separators before parseFloat \u2014 fmtCost emits "12,345.67"
    // and parseFloat would otherwise truncate at the comma to 12.
    const raw = (document.getElementById(id)?.textContent || "0").replace(/,/g, "");
    bomItems.push({ label: "  " + label, value: parseFloat(raw) || 0 });
  }
  bomItems.push({ label: "", value: "" });
  // Step 5 numeric values — read from state.step5Costs (numbers), NOT from
  // textContent which is comma-formatted ("54,123.45") and would parseFloat
  // back to 54. Bug previously surfaced as Backup=$54 / ASR=$42 in the export.
  bomItems.push({ label: "Network Egress", value: Number(state.step5Costs?.egress) || 0 });
  bomItems.push({ label: "Azure Backup", value: Number(state.step5Costs?.backup) || 0 });
  bomItems.push({ label: "Azure Site Recovery", value: Number(state.step5Costs?.asr) || 0 });
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Licensing (cores shown for BYOL / SA quoting; rate filled by pre-sales)", value: "" });
  // Use NaN sentinel for blank rates so the export can render "" instead of 0.
  const winRate = parseFloat(document.getElementById("bom_winlicense")?.value);
  const sqlRate = parseFloat(document.getElementById("bom_sqllicense")?.value);
  const linuxRate = parseFloat(document.getElementById("bom_linuxlicense")?.value);
  const otherRate = parseFloat(document.getElementById("bom_otherdb")?.value);
  const cores = state.bomLicenseCores || { winCores: 0, sqlCores: 0, linuxCores: 0 };
  bomItems.push({ label: "  Windows License", cores: cores.winCores, value: Number.isFinite(winRate) ? winRate : "" });
  bomItems.push({ label: "  SQL License", cores: cores.sqlCores, value: Number.isFinite(sqlRate) ? sqlRate : "" });
  bomItems.push({ label: "  Linux", cores: cores.linuxCores, value: Number.isFinite(linuxRate) ? linuxRate : "" });
  bomItems.push({ label: "  Other Databases", value: Number.isFinite(otherRate) ? otherRate : "" });
  bomItems.push({ label: "", value: "" });
  bomItems.push({ label: "Total Monthly Cost", value: document.getElementById("bom_totalMonthly")?.textContent || "" });
  bomItems.push({ label: "Total Annual Cost", value: document.getElementById("bom_totalAnnual")?.textContent || "" });

  const envReportsInfo = {};
  for (const env of (state.environments || ["All"])) {
    envReportsInfo[env] = { totalServers: state.envReports?.[env]?.summary?.totalServers || state.envCounts?.[env] || 0 };
  }

  // Snapshot the Step 5 configuration so the BOM XLSX can render dedicated
  // LZ + Backup sheets. Server-side state.drStrategy is already on the session.
  const step5Snapshot = {
    egress: {
      enabled: document.getElementById("egressEnabled")?.checked,
      method: document.getElementById("egressMethod")?.value,
      perServer: parseFloat(document.getElementById("egressPerServer")?.value) || 0,
      totalGB: parseFloat(document.getElementById("egressTotalGB")?.value) || 0,
      monthlyCost: state.step5Costs.egress,
    },
    landingZone: ["firewall", "vpn", "er", "bastion", "monitor"].map(c => {
      const skuSelect = document.getElementById(`lz_${c}_sku`);
      const qty = parseInt(document.getElementById(`lz_${c}_qty`)?.value) || 0;
      const unitCost = parseFloat(skuSelect?.value) || 0;
      const enabled = document.getElementById(`lz_${c}_on`)?.checked;
      const skuName = skuSelect?.selectedOptions?.[0]?.dataset?.skuName || "";
      return {
        component: c,
        enabled: !!enabled,
        sku: skuName,
        qty,
        unitMonthlyCost: unitCost,
        monthlyCost: enabled ? unitCost * qty : 0,
      };
    }),
    backup: {
      changeRate: parseFloat(document.getElementById("backupChangeRate")?.value) || 0,
      compression: parseFloat(document.getElementById("backupCompression")?.value) || 0,
      perEnvPolicies: state.backupPolicies || {},
      perEnvBreakdown: state.step5BackupInfo?.perEnv || [],
      monthlyCost: state.step5Costs.backup,
    },
    drStrategy: { monthlyCost: state.step5Costs.asr },
    grandTotal: state.step5Costs.egress + state.step5Costs.lz + state.step5Costs.backup + state.step5Costs.asr,
  };

  try {
    // Per-server backup is computed only in the browser by calculateBackupCost(),
    // so the server's session.assessmentReport.servers[].backupMonthlyCost is 0.
    // Ship a name->cost map alongside the export so the server can stamp it onto
    // the per-server BOM rows. Includes ALL servers (L&S, deferred, excluded)
    // because backup is per-env-policy, not per-cost-treatment.
    const perServerBackup = {};
    for (const srv of (state.assessmentReport?.servers || [])) {
      if (!srv?.serverName) continue;
      const v = Number(srv.backupMonthlyCost);
      if (Number.isFinite(v) && v > 0) perServerBackup[srv.serverName] = v;
    }
    for (const env of (state.environments || [])) {
      const r = state.envReports?.[env];
      for (const srv of (r?.servers || [])) {
        if (!srv?.serverName) continue;
        const v = Number(srv.backupMonthlyCost);
        if (Number.isFinite(v) && v > 0 && !perServerBackup[srv.serverName]) {
          perServerBackup[srv.serverName] = v;
        }
      }
    }
    const resp = await fetch("/api/export/bom-xlsx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        customerName,
        region,
        environments: state.environments || ["All"],
        envConfigs: state.envConfigs,
        envReports: envReportsInfo,
        envCounts: state.envCounts,
        bomItems,
        step5Snapshot,
        perServerBackup,
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
let wavePlanTotalServers = 0; // L&S-only count from detect-groups (excludes DR-deferred & excluded). summary.totalServers in state.assessmentReport still counts DR-deferred rows, so do not use that here.
let lastUserInstructions = "";

// Determine which tag keys the user actually referenced in their instructions.
// Returns a Set of lowercase keys, or null if no instructions / nothing matched
// (caller should then show all tags as before).
function relevantTagKeysFromInstructions(instructions, plan) {
  const text = (instructions || "").toString().toLowerCase().trim();
  if (!text || !plan || !plan.waves) return null;
  // Aggregate every tag key + its values across all groups
  const allTags = {}; // key -> Set(values)
  for (const w of plan.waves) {
    for (const g of w.groups || []) {
      if (!g.tags) continue;
      for (const [k, v] of Object.entries(g.tags)) {
        if (!v) continue;
        const key = k.toLowerCase();
        if (!allTags[key]) allTags[key] = new Set();
        for (const part of String(v).split(/\s*,\s*/)) {
          if (part) allTags[key].add(part.toLowerCase());
        }
      }
    }
  }
  const matched = new Set();
  for (const [key, vals] of Object.entries(allTags)) {
    // (1) Match by key tokens (>=3 chars), e.g. "environment" or "tier" appearing in the text
    const keyTokens = key.split(/\W+/).filter(t => t && t.length >= 3);
    let hit = keyTokens.some(t => text.includes(t));
    // (2) Match by any of the key's values appearing in the text. Combine key+value
    //     forms as well (e.g. "tier1", "prod") for short numeric values.
    if (!hit) {
      for (const val of vals) {
        if (!val) continue;
        if (val.length >= 3 && new RegExp(`\\b${val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)) { hit = true; break; }
        // key+value concatenated, e.g. "tier1", "tier 1"
        for (const kt of keyTokens) {
          const re = new RegExp(`\\b${kt}[\\s\\-_]*${val.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "i");
          if (re.test(text)) { hit = true; break; }
        }
        if (hit) break;
      }
    }
    if (hit) matched.add(key);
  }
  return matched.size > 0 ? matched : null;
}

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
      wavePlanTotalServers = data.totalServers || 0;
      showPilotGuidance(wavePlanTotalServers, wavePlanGroupingModes);
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
    if (wavePlanTotalServers) updateCapacityGuidance(wavePlanTotalServers);
  });
});

// Generate Wave Plan (smart: uses AI if connected + instructions provided, otherwise rule-based)
document.getElementById("wpGenerateBtn").addEventListener("click", async () => {
  const sel = document.getElementById("wpGroupBy");
  const selectedMode = wavePlanGroupingModes.find(m => m.id === sel.value);
  const userInstructions = document.getElementById("wpUserInstructions").value.trim();
  lastUserInstructions = userInstructions;
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
      const moveNote = movesApplied > 0
        ? ` — AI applied ${movesApplied} move${movesApplied > 1 ? "s" : ""} per your instructions`
        : " — rule-based already satisfies your instructions (no moves needed)";
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

// Patch a freshly-returned wave plan with backup attribution from local state.
// The server doesn't know per-server backup cost (calculated only by the BOM
// page), so its wave.waveBackup is always 0 and wave.waveCost excludes backup.
// Build a name->backup map and re-stamp wave totals + cumulative chain.
function patchWaveBackupCosts(plan) {
  if (!plan || !Array.isArray(plan.waves)) return;
  const backupByName = new Map();
  const collect = (srv) => {
    if (!srv || !srv.serverName) return;
    const v = Number(srv.backupMonthlyCost) || 0;
    // Pick the larger value if the same name appears in multiple report copies
    // (combined report + per-env reports) so DR-deferred 0s don't override a
    // real value stamped on the L&S row.
    const prev = backupByName.get(srv.serverName) || 0;
    if (v > prev) backupByName.set(srv.serverName, v);
  };
  for (const srv of (state.assessmentReport?.servers || [])) collect(srv);
  for (const env of (state.environments || [])) {
    const r = state.envReports?.[env];
    for (const srv of (r?.servers || [])) collect(srv);
  }
  if (backupByName.size === 0) return; // nothing to patch (BOM step not run yet)

  let cum = 0;
  for (const wave of plan.waves) {
    let waveBackup = 0;
    for (const g of (wave.groups || [])) {
      for (const name of (g.servers || [])) waveBackup += backupByName.get(name) || 0;
    }
    waveBackup = Math.round(waveBackup * 100) / 100;
    const priorBackup = Number(wave.waveBackup) || 0;
    const baseCost = (Number(wave.waveCost) || 0) - priorBackup; // strip any zero or stale backup
    const newWaveCost = Math.round((baseCost + waveBackup) * 100) / 100;
    wave.waveBackup = waveBackup;
    wave.waveCost = newWaveCost;
    cum = Math.round((cum + newWaveCost) * 100) / 100;
    wave.cumulativeCost = cum;
  }
}

// Render Wave Plan
function renderWavePlan(plan) {
  document.getElementById("wpTimeline").classList.remove("hidden");
  document.getElementById("wpExportBtns").classList.remove("hidden");

  // Backup costs are computed client-side in calculateBackupCost() and never
  // reach the server's session.assessmentReport, so wave.waveBackup / waveCost
  // come back without backup attribution. Patch them here from local state so
  // the UI (and any subsequent export that reads wavePlanData) shows real
  // backup numbers.
  patchWaveBackupCosts(plan);

  // Show capacity warning if returned by server
  if (plan.capacityWarning) {
    wpShowStatus(plan.capacityWarning, "error");
  }

  const tbody = document.getElementById("wpTimelineBody");
  tbody.innerHTML = "";

  // If the user gave instructions, restrict the AI Insight column to only the tag
  // keys they referenced (e.g. instruction "Tier 1 to last wave" => only `system tier`).
  const relevantKeys = relevantTagKeysFromInstructions(lastUserInstructions, plan);

  for (const wave of plan.waves) {
    const scopeText = wave.groups.map(g => g.name).join(", ");
    // Collect unique tag values across groups in this wave for quick visual confirmation
    const waveTags = {};
    for (const g of wave.groups) {
      if (g.tags) {
        for (const [k, v] of Object.entries(g.tags)) {
          if (!v) continue;
          if (relevantKeys && !relevantKeys.has(k.toLowerCase())) continue;
          if (!waveTags[k]) waveTags[k] = new Set();
          waveTags[k].add(v);
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
      <td class="p-1"><textarea class="form-control form-control-sm wp-strategic-intent" data-wave="${wave.waveNumber}" rows="3" placeholder="Strategic intent &amp; validation gates" style="font-size:0.78rem; min-height:60px;">${escHtml(wave.strategicIntent || "")}</textarea></td>
      <td class="text-center">${wave.totalServers}${capacityLabel ? `<span class="text-muted small">${capacityLabel}</span>` : ""}</td>
      <td class="text-end">$${wave.waveCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="text-end small text-muted">$${(wave.waveBackup || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
      <td class="text-end fw-bold">$${wave.cumulativeCost.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
    `;
    if (wave.waveNumber === 0) tr.classList.add("table-info");
    if (overCap) tr.classList.add("table-danger");
    tbody.appendChild(tr);
  }

  // Wire up the editable Strategic Intent cells. Persists on blur — debounced
  // saves on every keystroke would generate dozens of session-disk writes for
  // a long paragraph; blur is the natural commit point.
  attachStrategicIntentListeners(plan);

  renderGantt(plan);
  renderWaveDetails(plan);
  checkBOMMatch(plan);
}

// Persists per-wave Strategic Intent edits to the backend. Updates the
// in-memory plan object on success so a subsequent regen sees the latest text.
async function saveStrategicIntent(plan, waveNumber, text) {
  try {
    const res = await fetch("/api/waveplan/update-meta", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: state.sessionId, waveNumber, strategicIntent: text }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.warn("Failed to save Strategic Intent:", err.error || res.statusText);
      return;
    }
    // Update local plan record so /update or /generate sees the new text.
    const wave = plan.waves.find(w => w.waveNumber === waveNumber);
    if (wave) wave.strategicIntent = text;
  } catch (e) {
    console.warn("Strategic Intent save error:", e);
  }
}

function attachStrategicIntentListeners(plan) {
  const tbody = document.getElementById("wpTimelineBody");
  if (!tbody) return;
  tbody.querySelectorAll("textarea.wp-strategic-intent").forEach(ta => {
    ta.addEventListener("blur", () => {
      const waveNumber = parseInt(ta.dataset.wave, 10);
      saveStrategicIntent(plan, waveNumber, ta.value);
    });
  });
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
  const relevantKeys = relevantTagKeysFromInstructions(lastUserInstructions, plan);

  for (const wave of plan.waves) {
    const id = `wpWave${wave.waveNumber}`;
    let groupsHtml = "";
    for (const g of wave.groups) {
      // Build tag badges from LLM metadata
      let tagsHtml = "";
      if (g.tags && Object.keys(g.tags).length) {
        tagsHtml = Object.entries(g.tags)
          .filter(([k, v]) => v && (!relevantKeys || relevantKeys.has(k.toLowerCase())))
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

//Pay as you to by hours
//Load Wave Plan config by customer input
//exclude certain env from TCO or Better DR planning with identifying 
//Future Scope Integrate in copilot
//Assessment for VMWare migration, SAP MIgration, Citrix Machine, Desktop as a service
//Modernizaton Scenarios and app classification Rehost, Refactor, Rearchitect, Rebuild, Replace
//Generate wave plan always use AI with or without user instruction because it is llm optimization
//and one call only

//Immediate next steps:

//in the wave plan timeline show Date time and not just bars
// which appplication has been DR, so decide to do exclude certain app
//perhaps by rto rpo and do asr on that instead so this is more comprehensive
// Same goes for Bacup strategy
//deploy to sandbox with no history loadm and about and download label in sidebar
 
