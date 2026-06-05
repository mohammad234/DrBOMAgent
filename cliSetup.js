/**
 * CLI Startup - Handles pre-launch prompts:
 * 1. Optional Azure login via az CLI (leverages existing az login session)
 * 2. Optional LLM configuration
 * 
 * Results are passed to the server as startup state.
 */

const readline = require("readline");
const { execSync } = require("child_process");

function createRL() {
  return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

/**
 * Get Azure token via az CLI (leverages existing az login session).
 * If not logged in, runs az login first (opens browser automatically).
 */
async function azureLoginViaCLI() {
  console.log("\n  Checking Azure CLI login status...");

  try {
    // Check if az CLI is available
    try {
      execSync("az --version", { stdio: "ignore" });
    } catch {
      console.log("  ✗ Azure CLI (az) not found. Install from: https://aka.ms/installazurecli");
      console.log("    Or skip and login via the web page later.\n");
      return null;
    }

    // Check if already logged in
    let needLogin = false;
    try {
      execSync("az account show", { stdio: "ignore" });
      console.log("  ✓ Already logged in to Azure CLI.");
    } catch {
      needLogin = true;
    }

    // Run az login if needed (opens browser automatically)
    if (needLogin) {
      console.log("  Opening browser for Azure login...");
      try {
        execSync("az login", { stdio: "inherit" });
      } catch {
        console.log("  ✗ Azure login failed or was cancelled.");
        return null;
      }
    }

    // Get access token for Azure Management
    console.log("  Acquiring access token...");
    const tokenJson = execSync(
      'az account get-access-token --resource https://management.azure.com/ --query "{accessToken:accessToken,expiresOn:expiresOn,tenant:tenant}" -o json',
      { encoding: "utf-8" }
    );
    const tokenData = JSON.parse(tokenJson);

    if (!tokenData.accessToken) {
      console.log("  ✗ Could not get access token.");
      return null;
    }

    // Calculate expiresIn from expiresOn
    const expiresOn = new Date(tokenData.expiresOn).getTime();
    const expiresIn = Math.floor((expiresOn - Date.now()) / 1000);

    console.log("  ✓ Azure login successful!\n");
    return {
      accessToken: tokenData.accessToken,
      refreshToken: null, // az CLI manages refresh internally
      expiresIn: expiresIn > 0 ? expiresIn : 3600,
      tenant: tokenData.tenant,
    };
  } catch (err) {
    console.log(`  Login error: ${err.message}`);
    return null;
  }
}

/**
 * Run interactive CLI setup before launching the server.
 * Only Azure login. LLM is configured via the web panel.
 */
async function runSetup() {
  const config = {
    azureToken: null,
    azureClientId: null,
    azureTenantId: null,
    llm: {
      endpoint: process.env.AZURE_OPENAI_ENDPOINT || "",
      apiKey: process.env.AZURE_OPENAI_KEY || "",
      deploymentName: process.env.AZURE_OPENAI_DEPLOYMENT || "",
    },
  };

  console.log(`\n  ╔══════════════════════════════════════════════╗`);
  console.log(`  ║   Dr. BOM Agent - Setup                      ║`);
  console.log(`  ╚══════════════════════════════════════════════╝\n`);

  // Skip interactive Azure CLI login in favor of web-based login via the UI.
  // The server will expose a web login flow; do not prompt on the command line.
  console.log("  ○ Skipping CLI Azure login (use web page login if needed).");

  // No azureToken returned here; web-based login can populate token later.
  config.azureToken = null;

  // Use env vars for LLM if set (no interactive prompt)
  if (config.llm.endpoint && !config.llm.apiKey) {
    config.llm.useTokenAuth = true;
  }

  return config;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runSetup, azureLoginViaCLI };
