const { App } = require("@slack/bolt");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");

process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

const MCP_URL = process.env.MCP_URL || "http://localhost:3939/mcp";
const SLACK_USER_TOKEN = process.env.SLACK_USER_TOKEN;

// Real-Time Search API: looks for prior workspace discussion related to a new bug report,
// so the triage card can flag likely duplicates with a link back to the original thread.
async function searchRelatedDiscussion(query) {
  if (!SLACK_USER_TOKEN || !query) return [];
  try {
    const res = await fetch("https://slack.com/api/assistant.search.context", {
      method: "POST",
      headers: { Authorization: "Bearer " + SLACK_USER_TOKEN, "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ query, content_types: ["messages"], limit: 3 }),
    });
    const data = await res.json();
    if (!data.ok) return [];
    return data.results?.messages || [];
  } catch {
    return [];
  }
}

async function callTool(name, args) {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  const client = new Client({ name: "cortex-triage-slack-bridge", version: "1.0.0" });
  await client.connect(transport);
  try {
    const res = await client.callTool({ name, arguments: args }, undefined, { timeout: 90000 });
    return res.content.map((c) => c.text).join("\n");
  } finally {
    await client.close();
  }
}

// Intent routing is delegated to the slack-router Lemma agent (real LLM reasoning,
// not keyword matching) via the route_message MCP tool. `senderId`/`senderName` come
// from the actual Slack event, never from the LLM, so identity-linking can't be spoofed
// by what someone types.
async function route(text, senderId, senderName) {
  const raw = await callTool("route_message", { message: text });
  const decision = JSON.parse(raw);
  if (!decision.tool || decision.tool === "none") return null;
  if (decision.tool === "triage_bug_report") {
    return { tool: decision.tool, args: { title: decision.title || text.slice(0, 120), body: decision.body || text, source: "slack" } };
  }
  if (decision.tool === "list_open_bugs") {
    return { tool: decision.tool, args: decision.severity ? { severity: decision.severity } : {} };
  }
  if (decision.tool === "compile_release_notes") {
    return { tool: decision.tool, args: decision.version ? { version: decision.version } : {} };
  }
  if (decision.tool === "get_bug") {
    return { tool: decision.tool, args: { bug_id: decision.bug_id } };
  }
  if (decision.tool === "decide_bug") {
    return {
      tool: decision.tool,
      args: { bug_id: decision.bug_id, decision: decision.decision, reason: decision.reason || "" },
    };
  }
  if (decision.tool === "link_slack_identity") {
    return {
      tool: decision.tool,
      args: { github_login: decision.github_login, slack_user_id: senderId, slack_username: senderName || "" },
    };
  }
  return null;
}

const SEVERITY_EMOJI = { P1: "🔴", P2: "🟠", P3: "🟡" };

function decideButtons(bugId) {
  return {
    type: "actions",
    block_id: `decide_${bugId}`,
    elements: [
      { type: "button", text: { type: "plain_text", text: "Backlog" }, style: "primary", action_id: "decide_backlog", value: bugId },
      { type: "button", text: { type: "plain_text", text: "Defer 14d" }, action_id: "decide_defer", value: bugId },
      { type: "button", text: { type: "plain_text", text: "Close" }, style: "danger", action_id: "decide_close", value: bugId },
    ],
  };
}

// Returns { text, blocks } — text is always set as a plain fallback (required by Slack
// for notifications/accessibility), blocks are the rich Block Kit rendering when available.
function formatResult(tool, raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { text: raw };
  }

  if (tool === "triage_bug_report") {
    if (data.error) return { text: `Triage failed: ${data.error}` };
    const emoji = SEVERITY_EMOJI[data.severity] || "⚪";
    const text = `${emoji} Triaged — severity ${data.severity} (${data.bug_type})`;
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *Triaged — severity ${data.severity}* _(${data.bug_type})_\n${data.reasoning}` } },
      { type: "section", text: { type: "mrkdwn", text: `*Suggested fix:* ${data.fix_title}\n${data.fix_suggestion}` } },
    ];
    if (data.assignee_login) {
      const who = data.assignee_slack_user_id ? `<@${data.assignee_slack_user_id}>` : `\`${data.assignee_login}\` (not yet linked to Slack — they can say "I'm ${data.assignee_login} on GitHub")`;
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Suggested owner:* ${who}\n_${data.assignee_reason || ""}_` } });
    }
    blocks.push(
      { type: "context", elements: [{ type: "mrkdwn", text: `Risk: ${data.risk_level} • Bug ID: \`${data.bug_id}\`` }] },
      decideButtons(data.bug_id)
    );
    return { text, blocks };
  }

  if (tool === "link_slack_identity") {
    return { text: `Got it — linked GitHub \`${data.github_login}\` to you. Future suggested-owner cards will @-mention you directly.` };
  }

  if (tool === "list_open_bugs") {
    const items = data.items || [];
    if (!items.length) return { text: "No open bugs found." };
    const blocks = [{ type: "section", text: { type: "mrkdwn", text: `*Open backlog* (${items.length})` } }];
    for (const b of items) {
      const emoji = SEVERITY_EMOJI[b.severity] || "⚪";
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${emoji} *${b.severity}* ${b.title} _(${b.bug_type}, ${b.decision_status}${b.assignee_login ? ", " + b.assignee_login : ""})_\n\`${b.id}\``,
        },
      });
    }
    return { text: `Open backlog (${items.length})`, blocks };
  }

  if (tool === "decide_bug") {
    if (!data.ok) return { text: `Couldn't record that decision: ${data.detail || "unknown error"}` };
    return { text: `Done — ${data.detail}` };
  }

  if (tool === "get_bug") {
    const b = (data.items || [data])[0];
    if (!b || !b.id) return { text: "Couldn't find that bug." };
    const emoji = SEVERITY_EMOJI[b.severity] || "⚪";
    const blocks = [
      { type: "section", text: { type: "mrkdwn", text: `${emoji} *${b.severity}* ${b.title} _(${b.bug_type}, ${b.decision_status})_` } },
    ];
    if (b.fix_title) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `*Suggested fix:* ${b.fix_title}\n${b.fix_suggestion || ""}` } });
    }
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: `Bug ID: \`${b.id}\`` }] }, decideButtons(b.id));
    return { text: `${b.severity} ${b.title}`, blocks };
  }

  if (tool === "compile_release_notes") {
    if (data.error) return { text: `Release notes failed: ${data.error}` };
    return {
      text: `Release notes — ${data.version}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Release notes — ${data.version}* (${data.bug_count} bugs)` } },
        { type: "section", text: { type: "mrkdwn", text: data.notes_markdown || "(no notes generated)" } },
      ],
    };
  }

  return { text: raw };
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

let lastChannelId = null;

app.event("message", async ({ event }) => {
  console.log("RAW message event:", JSON.stringify(event));
});

app.message(async ({ message, say }) => {
  console.log("app.message fired:", JSON.stringify(message));
  if (message.channel) lastChannelId = message.channel;
  if (message.subtype || !message.text) return;
  if (/\bsend (the )?digest\b/i.test(message.text)) {
    await postDigest();
    return;
  }
  let intent;
  try {
    intent = await route(message.text, message.user, "");
  } catch (e) {
    await say(`Something went wrong while figuring out what you meant: ${e.message}`);
    return;
  }
  if (!intent) {
    await say(
      "I can help with: triaging a bug report, the open backlog, a specific bug's details, closing/backlogging/deferring a bug, release notes, or linking your GitHub handle so I can @-mention you when you're the suggested owner. Try something like `triage this bug: <description>`, `what's our P1 backlog`, `close bug <id>`, `I'm <github-login> on GitHub`, or `release notes for v1.0`."
    );
    return;
  }
  await say(`On it — running \`${intent.tool}\`...`);
  try {
    const raw = await callTool(intent.tool, intent.args);
    const result = formatResult(intent.tool, raw);
    if (intent.tool === "triage_bug_report") {
      const related = await searchRelatedDiscussion(intent.args.title);
      if (related.length) {
        result.blocks = result.blocks || [];
        result.blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text:
              "🔎 *Possibly related discussion found:*\n" +
              related
                .slice(0, 3)
                .map((m) => `<${m.permalink}|${(m.text || "").slice(0, 100).replace(/\n/g, " ")}>`)
                .join("\n"),
          },
        });
      }
    }
    await say(result);
  } catch (e) {
    await say(`Something went wrong: ${e.message}`);
  }
});

const BUTTON_DECISIONS = { decide_backlog: "backlog", decide_defer: "defer", decide_close: "close" };

app.action(/^decide_(backlog|defer|close)$/, async ({ ack, action, body, say }) => {
  await ack();
  const decision = BUTTON_DECISIONS[action.action_id];
  const bugId = action.value;
  const actor = body.user?.username || body.user?.name || "slack";
  try {
    const raw = await callTool("decide_bug", { bug_id: bugId, decision, reason: `via Slack button by ${actor}`, decided_by: actor });
    await say(formatResult("decide_bug", raw));
  } catch (e) {
    await say(`Something went wrong: ${e.message}`);
  }
});

// Proactive digest: posts unprompted to the last channel/DM the agent was used in.
// In production this would target a fixed ops channel on a daily cron; for the demo
// it's interval-driven (DIGEST_INTERVAL_MS) and self-targets wherever it was last used.
const DIGEST_INTERVAL_MS = Number(process.env.DIGEST_INTERVAL_MS || 0);

async function postDigest() {
  if (!lastChannelId) return;
  try {
    const [p1Raw, p2Raw] = await Promise.all([
      callTool("list_open_bugs", { severity: "P1" }),
      callTool("list_open_bugs", { severity: "P2" }),
    ]);
    const p1 = (JSON.parse(p1Raw).items || []).length;
    const p2 = (JSON.parse(p2Raw).items || []).length;
    await app.client.chat.postMessage({
      channel: lastChannelId,
      text: `Daily digest: ${p1} open P1, ${p2} open P2`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `📋 *Daily backlog digest*\n🔴 *${p1}* open P1 • 🟠 *${p2}* open P2` } },
        { type: "context", elements: [{ type: "mrkdwn", text: "Ask me \"what's our P1 backlog\" for the full list." }] },
      ],
    });
  } catch (e) {
    console.error("[digest] failed:", e.message);
  }
}

if (DIGEST_INTERVAL_MS > 0) {
  setInterval(postDigest, DIGEST_INTERVAL_MS);
  console.log(`[digest] scheduled every ${DIGEST_INTERVAL_MS}ms`);
}

(async () => {
  await app.start();
  console.log("Cortex-Triage Slack bridge is running (Socket Mode)");
})();
