const fs = require("fs");
const os = require("os");
const path = require("path");

const POD_ID = process.env.LEMMA_POD_ID || "019ef9bc-8454-758f-8d39-e3a4c66a9cfe";
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".lemma", "config.json");
// Where refreshed tokens get persisted across restarts. Defaults next to this file so
// it works the same on a deploy host (no ~/.lemma directory there) as it does locally.
const TOKEN_CACHE_PATH = process.env.LEMMA_TOKEN_CACHE_PATH || path.join(__dirname, ".lemma-auth-cache.json");

let cached = null;

function loadInitialAuth() {
  // 1) explicit env vars (what a deploy host should set)
  if (process.env.LEMMA_BASE_URL && process.env.LEMMA_ACCESS_TOKEN && process.env.LEMMA_REFRESH_TOKEN) {
    return {
      baseUrl: process.env.LEMMA_BASE_URL,
      token: process.env.LEMMA_ACCESS_TOKEN,
      refreshToken: process.env.LEMMA_REFRESH_TOKEN,
    };
  }
  // 2) a previously persisted refresh (survives this process restarting)
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    const c = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, "utf8"));
    return { baseUrl: c.base_url, token: c.access_token, refreshToken: c.refresh_token };
  }
  // 3) local `lemma` CLI's own config file (dev machine convenience)
  const cfg = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, "utf8"));
  const s = cfg.servers[cfg.active_server];
  return { baseUrl: s.base_url, token: s.auth.access_token, refreshToken: s.auth.refresh_token };
}

function getAuth() {
  if (!cached) cached = loadInitialAuth();
  return cached;
}

function persist(auth) {
  try {
    fs.writeFileSync(
      TOKEN_CACHE_PATH,
      JSON.stringify({ base_url: auth.baseUrl, access_token: auth.token, refresh_token: auth.refreshToken }, null, 2)
    );
  } catch (e) {
    console.error("[lemma-client] failed to persist refreshed token:", e.message);
  }
}

// Pure HTTP refresh — no CLI/OS dependency, works on any host. Endpoint reverse-engineered
// from the official lemma-sdk Python package's refresh_cli_session (lemma_sdk/auth.py).
async function refreshAuth() {
  const auth = getAuth();
  const res = await fetch(`${auth.baseUrl.replace(/\/$/, "")}/auth/cli/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ refresh_token: auth.refreshToken }),
  });
  if (!res.ok) {
    throw new Error(`Lemma auth refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cached = { baseUrl: auth.baseUrl, token: data.access_token, refreshToken: data.refresh_token };
  persist(cached);
}

async function request(method, urlPath, body, _retried) {
  const { baseUrl, token } = getAuth();
  const res = await fetch(baseUrl + urlPath, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 401 && !_retried) {
    await refreshAuth();
    return request(method, urlPath, body, true);
  }
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`Lemma API ${method} ${urlPath} -> ${res.status}: ${text}`);
  }
  return data;
}

// Polls until the run finishes, or until `untilNodeId` has produced output (whichever
// comes first) — lets callers return as soon as the part they care about is ready instead
// of waiting on slow downstream side-effects (Jira/GitHub/Slack calls further down the graph).
async function runWorkflow(workflowName, formNodeId, inputs, untilNodeId) {
  let run = await request("POST", `/pods/${POD_ID}/workflows/${workflowName}/runs`);
  if (formNodeId) {
    run = await request("POST", `/pods/${POD_ID}/workflow-runs/${run.id}/form`, {
      node_id: formNodeId,
      inputs,
    });
  }
  for (let i = 0; i < 60; i++) {
    const ctx = run.execution_context || {};
    const settled = run.status && run.status !== "PENDING" && run.status !== "RUNNING";
    const nodeReady = untilNodeId && ctx[untilNodeId];
    if (settled || nodeReady) break;
    await new Promise((r) => setTimeout(r, 1000));
    run = await request("GET", `/pods/${POD_ID}/workflow-runs/${run.id}`);
  }
  return run;
}

async function query(sql) {
  const res = await request("POST", `/pods/${POD_ID}/datastore/query`, { query: sql });
  return res;
}

async function runFunction(functionName, inputData) {
  const res = await request("POST", `/pods/${POD_ID}/functions/${functionName}/runs`, { input_data: inputData });
  return res;
}

module.exports = { runWorkflow, query, runFunction, POD_ID };
