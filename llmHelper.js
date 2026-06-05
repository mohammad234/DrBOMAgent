/**
 * LLM Helper - Azure AI integration for intelligent fallback.
 * 
 * Supports:
 * A) Azure OpenAI deployments (*.openai.azure.com)
 * B) Azure AI Foundry serverless models (*.models.ai.azure.com or model inference API)
 * C) GitHub Models (free, OpenAI-compatible, https://models.github.ai/inference)
 * 
 * Auth modes:
 * 1. API Key (api-key header) — Azure OpenAI / serverless
 * 2. Azure AD Token (Bearer token via az CLI) — Azure OpenAI / serverless
 * 3. GitHub PAT (Bearer token) — GitHub Models
 * 
 * PRINCIPLE: Works without LLM. Local logic is always primary.
 * LLM is a schematic fallback for specific, bounded tasks.
 */

const { execSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function loadPrompts() {
  const promptsPath = path.join(__dirname, "prompts.json");
  return JSON.parse(fs.readFileSync(promptsPath, "utf8"));
}

let llmConfig = {
  endpoint: "",          // e.g. https://myinstance.openai.azure.com
  apiKey: "",            // optional if using token auth
  deploymentName: "",    // e.g. gpt-4o
  apiVersion: "2025-04-01-preview",
  useTokenAuth: false,   // true = use az CLI token instead of API key
  providerType: "auto",  // "azure-openai" | "serverless" | "github-models" | "auto"
  // GitHub Models specific:
  githubPat: "",         // GitHub Personal Access Token (fine-grained, models:read)
  model: "",             // e.g. "openai/gpt-4o-mini" — GitHub Models uses publisher/name
};

/**
 * Detect provider type from endpoint URL.
 * - *.openai.azure.com → Azure OpenAI
 * - *.models.ai.azure.com → Serverless (Foundry MaaS)
 * - Contains /models/ in path → Model Inference API
 * - Otherwise → try Azure OpenAI format
 */
function detectProvider(endpoint) {
  if (!endpoint) return "azure-openai";
  const lower = endpoint.toLowerCase();
  if (lower.includes(".models.ai.azure.com")) return "serverless";
  if (lower.includes("/models")) return "serverless";
  return "azure-openai";
}

function configure(config) {
  // Explicit reset: clear everything so isConfigured() returns false.
  if (config && config.reset === true) {
    llmConfig.providerType = "auto";
    llmConfig.endpoint = "";
    llmConfig.apiKey = "";
    llmConfig.deploymentName = "";
    llmConfig.useTokenAuth = false;
    llmConfig.githubPat = "";
    llmConfig.model = "";
    console.log("[LLM] Cleared (user disconnected).");
    return;
  }

  // GitHub Models is a self-contained provider (PAT + model only). Skip endpoint mangling
  // and let it short-circuit so accidental Azure-style keys don't override its state.
  if (config.providerType === "github-models") {
    llmConfig.providerType = "github-models";
    if (config.githubPat !== undefined) llmConfig.githubPat = config.githubPat;
    if (config.model) llmConfig.model = config.model;
    // Clear Azure-only fields so isConfigured() doesn't mix providers.
    llmConfig.endpoint = "";
    llmConfig.apiKey = "";
    llmConfig.deploymentName = "";
    llmConfig.useTokenAuth = false;
    console.log(`[LLM] Configured: provider=github-models, model=${llmConfig.model}`);
    return;
  }

  if (config.endpoint) {
    // Strip trailing slash and common path suffixes users may copy from Azure AI Foundry/Portal
    llmConfig.endpoint = config.endpoint
      .replace(/\/+$/, "")
      .replace(/\/openai(\/v\d+)?$/, "")
      .replace(/\/v\d+$/, "")
      .replace(/\/+$/, "");
  }
  if (config.apiKey !== undefined) llmConfig.apiKey = config.apiKey;
  if (config.deploymentName) llmConfig.deploymentName = config.deploymentName;
  if (config.apiVersion) llmConfig.apiVersion = config.apiVersion;
  if (config.useTokenAuth !== undefined) llmConfig.useTokenAuth = config.useTokenAuth;
  if (config.providerType) llmConfig.providerType = config.providerType;

  // Auto-detect provider type if set to "auto"
  if (!config.providerType || config.providerType === "auto") {
    llmConfig.providerType = detectProvider(llmConfig.endpoint);
  }

  // If no API key provided but endpoint exists, assume token auth
  if (llmConfig.endpoint && !llmConfig.apiKey) {
    llmConfig.useTokenAuth = true;
  }

  // Clear GitHub-only fields when switching back to Azure providers.
  llmConfig.githubPat = "";

  console.log(`[LLM] Configured: provider=${llmConfig.providerType}, endpoint=${llmConfig.endpoint}, deployment=${llmConfig.deploymentName}`);
}

function isConfigured() {
  if (llmConfig.providerType === "github-models") {
    return !!(llmConfig.githubPat && llmConfig.model);
  }
  if (!llmConfig.endpoint) return false;
  // Serverless endpoints don't always need a deployment name (it's in the URL)
  if (llmConfig.providerType === "azure-openai" && !llmConfig.deploymentName) return false;
  // Either API key or token auth must be available
  return !!(llmConfig.apiKey || llmConfig.useTokenAuth);
}

function getStatus() {
  if (llmConfig.providerType === "github-models") {
    return {
      configured: isConfigured(),
      endpoint: "models.github.ai",
      deploymentName: llmConfig.model || "",
      authMode: llmConfig.githubPat ? "GitHub PAT" : "Not set",
      providerType: "github-models",
    };
  }
  return {
    configured: isConfigured(),
    endpoint: llmConfig.endpoint ? llmConfig.endpoint.replace(/\/.*$/, "/...") : "",
    deploymentName: llmConfig.deploymentName || "",
    authMode: llmConfig.useTokenAuth ? "Azure AD Token (az CLI)" : (llmConfig.apiKey ? "API Key" : "Not set"),
    providerType: llmConfig.providerType || "auto",
  };
}

/**
 * Get a fresh Azure AD token for Cognitive Services via az CLI.
 * Token is fetched on each call (az CLI caches tokens internally).
 */
function getAzureADToken() {
  try {
    const tokenJson = execSync(
      'az account get-access-token --resource https://cognitiveservices.azure.com/ --query accessToken -o tsv',
      { encoding: "utf-8", timeout: 15000 }
    );
    return tokenJson.trim();
  } catch (err) {
    console.error(`Failed to get Azure AD token for Cognitive Services: ${err.message}`);
    return null;
  }
}

/**
 * Build the correct URL and headers based on provider type.
 */
function buildRequest() {
  let url;
  const headers = { "Content-Type": "application/json" };

  if (llmConfig.providerType === "github-models") {
    // GitHub Models inference API — OpenAI-compatible, free tier available.
    // Auth: fine-grained PAT with `models:read` scope.
    url = "https://models.github.ai/inference/chat/completions";
    headers["Authorization"] = `Bearer ${llmConfig.githubPat}`;
    headers["Accept"] = "application/vnd.github+json";
    headers["X-GitHub-Api-Version"] = "2022-11-28";
    return { url, headers };
  }

  if (llmConfig.providerType === "serverless") {
    // Azure AI Foundry serverless / Model Inference API
    // URL format: {endpoint}/v1/chat/completions (or just /chat/completions)
    const base = llmConfig.endpoint.replace(/\/+$/, "");
    if (base.includes(".models.ai.azure.com")) {
      // MaaS serverless endpoint — already includes model routing
      url = `${base}/v1/chat/completions`;
    } else {
      // Generic model inference endpoint
      url = `${base}/chat/completions`;
    }

    // Serverless models typically use api-key auth
    if (llmConfig.apiKey) {
      headers["api-key"] = llmConfig.apiKey;
    } else if (llmConfig.useTokenAuth) {
      const token = getAzureADToken();
      if (!token) return null;
      headers["Authorization"] = `Bearer ${token}`;
    }
  } else {
    // Azure OpenAI
    url = `${llmConfig.endpoint}/openai/deployments/${llmConfig.deploymentName}/chat/completions?api-version=${llmConfig.apiVersion}`;

    if (llmConfig.useTokenAuth) {
      const token = getAzureADToken();
      if (!token) return null;
      headers["Authorization"] = `Bearer ${token}`;
    } else if (llmConfig.apiKey) {
      headers["api-key"] = llmConfig.apiKey;
    }
  }

  return { url, headers };
}

/**
 * Make a schematic LLM call with a specific system prompt and user content.
 * Returns null if LLM is not configured (graceful fallback).
 */
async function call(systemPrompt, userContent, options = {}) {
  if (!isConfigured()) return null;

  const request = buildRequest();
  if (!request) {
    console.error("LLM call skipped: could not build request (token auth failed?).");
    return null;
  }
  const { url, headers } = request;

  try {
    const body = {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
    };

    // Token limit: Azure OpenAI uses max_completion_tokens, others (serverless / GitHub Models) use max_tokens
    if (llmConfig.providerType === "azure-openai") {
      body.max_completion_tokens = options.maxTokens || 2000;
    } else {
      body.max_tokens = options.maxTokens || 2000;
    }

    if (options.json) {
      body.response_format = { type: "json_object" };
    }

    // Only include temperature if explicitly set (some models like o1/o3 don't support it)
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    // Add `model` field for any provider whose endpoint isn't already deployment-routed.
    if (llmConfig.providerType === "github-models" && llmConfig.model) {
      body.model = llmConfig.model;
    } else if (llmConfig.providerType === "serverless" && llmConfig.deploymentName) {
      body.model = llmConfig.deploymentName;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeout || 60000);
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      const err = await response.text();
      console.error(`LLM call failed (${response.status}): ${err}`);
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    if (options.json) {
      // Try direct parse first
      try { return JSON.parse(content); } catch {}
      // Strip markdown code fences and retry
      const cleaned = content.replace(/```json?\s*/gi, "").replace(/```/g, "").trim();
      try { return JSON.parse(cleaned); } catch {}
      // Return raw content as string so caller can handle it
      console.error("[LLM] Failed to parse JSON from response, returning raw content");
      return cleaned;
    }
    return content;
  } catch (err) {
    console.error(`LLM call error: ${err.message}`);
    return null;
  }
}

/**
 * TASK: Suggest column mapping for unknown source columns.
 * Uses prompts from prompts.json for maintainability.
 */
async function suggestColumnMapping(sourceColumns, targetColumns, sampleRows, baselineSpec) {
  const prompts = loadPrompts();
  const systemPrompt = prompts.columnMapping.system;
  const userContent = prompts.columnMapping.user
    .replace("{{sourceColumns}}", JSON.stringify(sourceColumns))
    .replace("{{sampleRows}}", JSON.stringify(sampleRows || [], null, 2))
    .replace("{{baselineSpec}}", JSON.stringify(baselineSpec || {}, null, 2))
    .replace("{{targetColumns}}", JSON.stringify(targetColumns));

  return await call(systemPrompt, userContent, { json: true });
}

/**
 * TASK: Fix/transform a data value that doesn't match expected format.
 */
async function fixDataValue(columnName, rawValue, expectedFormat, context) {
  const prompts = loadPrompts();
  const systemPrompt = prompts.fixDataValue.system;
  const userContent = prompts.fixDataValue.user
    .replace("{{columnName}}", columnName)
    .replace("{{rawValue}}", rawValue)
    .replace("{{expectedFormat}}", expectedFormat)
    .replace("{{context}}", context || "None");

  return await call(systemPrompt, userContent, {});
}

/**
 * TASK: Interpret assessment data when column names don't match expected.
 */
async function interpretAssessmentColumns(sheetColumns, expectedColumns) {
  const prompts = loadPrompts();
  const systemPrompt = prompts.interpretAssessmentColumns.system;
  const userContent = prompts.interpretAssessmentColumns.user
    .replace("{{sheetColumns}}", JSON.stringify(sheetColumns))
    .replace("{{expectedColumns}}", JSON.stringify(expectedColumns));

  return await call(systemPrompt, userContent, { json: true });
}

/**
 * Fetch the list of GitHub Models the given PAT has access to.
 * Returns { ok: true, models: [...] } or { ok: false, error: "...", status }.
 * Models are filtered to text-in/text-out chat models (no embedding / multimodal-only).
 */
async function listGithubModels(pat) {
  if (!pat) return { ok: false, error: "PAT is required" };
  try {
    const res = await fetch("https://models.github.ai/catalog/models", {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${pat}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    const contentType = res.headers.get("content-type") || "";
    if (!res.ok) {
      const body = await res.text();
      // GitHub's abuse-detection layer returns an HTML page (not JSON) with status 200 or 403.
      // Detect this and surface a clean message instead of dumping HTML into the UI.
      if (contentType.includes("text/html") || /<html/i.test(body)) {
        return { ok: false, status: res.status, error: "GitHub temporarily blocked this request (abuse-detection). Wait a few minutes before trying again." };
      }
      return { ok: false, status: res.status, error: body || `HTTP ${res.status}` };
    }
    // Even with status 200 the abuse page can come back HTML — guard for that.
    if (contentType.includes("text/html")) {
      return { ok: false, status: 429, error: "GitHub temporarily blocked this request (abuse-detection). Wait a few minutes before trying again." };
    }
    const all = await res.json();
    const filtered = (Array.isArray(all) ? all : [])
      .filter(m => {
        const inMod = m.supported_input_modalities || [];
        const outMod = m.supported_output_modalities || [];
        const caps = m.capabilities || [];
        // Keep chat-capable, text-in/text-out models. Drop embedding-only and image-out.
        const isTextOut = outMod.includes("text");
        const isTextIn = inMod.includes("text");
        const isEmbedding = caps.includes("embedding") || (m.tags || []).includes("embeddings");
        return isTextIn && isTextOut && !isEmbedding;
      })
      .map(m => ({
        id: m.id,
        name: m.name || m.id,
        publisher: m.publisher,
        tier: m.rate_limit_tier || "",
      }))
      // Stable, predictable ordering: low-tier first (more daily requests), then by name.
      .sort((a, b) => {
        const tierRank = (t) => (t === "low" ? 0 : t === "high" ? 1 : 2);
        const d = tierRank(a.tier) - tierRank(b.tier);
        return d !== 0 ? d : a.name.localeCompare(b.name);
      });
    return { ok: true, models: filtered };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Do a minimal chat completion call to validate that the given PAT can
 * actually invoke the given model. Returns { ok: true } or { ok, error, status }.
 */
async function validateGithubModels(pat, model) {
  if (!pat || !model) return { ok: false, error: "PAT and model are required" };
  try {
    const res = await fetch("https://models.github.ai/inference/chat/completions", {
      method: "POST",
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${pat}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      let parsed = body;
      try { parsed = JSON.parse(body)?.error?.message || body; } catch {}
      return { ok: false, status: res.status, error: parsed };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Re-test the currently configured provider against its endpoint with a tiny
 * request. Used by the "Re-test connection" UI to detect tokens that became
 * invalid between server start and now. Returns { ok, status?, error?, providerType }.
 */
async function validateCurrent() {
  if (!isConfigured()) {
    return { ok: false, error: "No LLM provider is configured", providerType: llmConfig.providerType || "" };
  }
  if (llmConfig.providerType === "github-models") {
    const r = await validateGithubModels(llmConfig.githubPat, llmConfig.model);
    return { ...r, providerType: "github-models" };
  }
  // Azure (azure-openai / serverless): do a minimal ping via call(). null = failure,
  // but call() doesn't surface the HTTP status — good enough for a "still working?" check.
  const out = await call("You are a connectivity test.", "ping", { maxTokens: 1, timeout: 15000 });
  if (out === null) return { ok: false, error: "Azure endpoint did not respond successfully (see server log)", providerType: llmConfig.providerType };
  return { ok: true, providerType: llmConfig.providerType };
}

module.exports = { configure, isConfigured, getStatus, call, suggestColumnMapping, fixDataValue, interpretAssessmentColumns, listGithubModels, validateGithubModels, validateCurrent };
