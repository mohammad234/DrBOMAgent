/**
 * LLM Helper - Azure AI integration for intelligent fallback.
 * 
 * Supports:
 * A) Azure OpenAI deployments (*.openai.azure.com)
 * B) Azure AI Foundry serverless models (*.models.ai.azure.com or model inference API)
 * 
 * Auth modes:
 * 1. API Key (api-key header)
 * 2. Azure AD Token (Bearer token via az CLI)
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
  providerType: "auto",  // "azure-openai" | "serverless" | "auto" (auto-detect from endpoint)
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

  console.log(`[LLM] Configured: provider=${llmConfig.providerType}, endpoint=${llmConfig.endpoint}, deployment=${llmConfig.deploymentName}`);
}

function isConfigured() {
  if (!llmConfig.endpoint) return false;
  // Serverless endpoints don't always need a deployment name (it's in the URL)
  if (llmConfig.providerType === "azure-openai" && !llmConfig.deploymentName) return false;
  // Either API key or token auth must be available
  return !!(llmConfig.apiKey || llmConfig.useTokenAuth);
}

function getStatus() {
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

    // Token limit: Azure OpenAI uses max_completion_tokens, serverless models use max_tokens
    if (llmConfig.providerType === "serverless") {
      body.max_tokens = options.maxTokens || 2000;
    } else {
      body.max_completion_tokens = options.maxTokens || 2000;
    }

    if (options.json) {
      body.response_format = { type: "json_object" };
    }

    // Only include temperature if explicitly set (some models like o1/o3 don't support it)
    if (options.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    // Add model field for serverless inference endpoints that need it
    if (llmConfig.providerType === "serverless" && llmConfig.deploymentName) {
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
async function suggestColumnMapping(sourceColumns, targetColumns) {
  const prompts = loadPrompts();
  const systemPrompt = prompts.columnMapping.system;
  const userContent = prompts.columnMapping.user
    .replace("{{sourceColumns}}", JSON.stringify(sourceColumns))
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

module.exports = { configure, isConfigured, getStatus, call, suggestColumnMapping, fixDataValue, interpretAssessmentColumns };
