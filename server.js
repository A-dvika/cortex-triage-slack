const express = require("express");
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StreamableHTTPServerTransport } = require("@modelcontextprotocol/sdk/server/streamableHttp.js");
const { z } = require("zod");
const lemma = require("./lemma-client");

// Without these, an unhandled rejection anywhere (e.g. a transient Lemma API hiccup)
// kills the whole process by Node's default behavior, silently dropping the server.
process.on("unhandledRejection", (err) => console.error("[unhandledRejection]", err));
process.on("uncaughtException", (err) => console.error("[uncaughtException]", err));

function buildServer() {
  const server = new McpServer({ name: "cortex-triage", version: "1.0.0" });

  server.registerTool(
    "triage_bug_report",
    {
      title: "Triage a bug report",
      description:
        "Classify and severity-score a raw bug report, suggest a fix, and persist it to the Cortex-Triage backlog. Use this whenever someone pastes or describes a bug/issue and wants it triaged.",
      inputSchema: {
        title: z.string().describe("Short title for the bug"),
        body: z.string().optional().describe("Full description of the bug"),
        source: z.enum(["github", "jira", "slack", "email", "manual"]).default("slack"),
        reporter: z.string().optional(),
        url: z.string().optional(),
      },
    },
    async ({ title, body, source, reporter, url }) => {
      const run = await lemma.runWorkflow(
        "triage-issue",
        "intake",
        {
          title,
          body: body || "",
          source: source || "slack",
          reporter: reporter || "",
          url: url || "",
          external_id: "",
        },
        // Wait through the owner-suggestion step too (not just persist) so the card can
        // show who has context on this code, not just that the bug was saved.
        "owner"
      );
      const ctx = run.execution_context || {};
      const assigneeLogin = ctx.owner && ctx.owner.assignee_login;
      const slackUser = assigneeLogin ? await lemma.resolveSlackUser(assigneeLogin) : null;
      const summary = {
        status: run.status,
        bug_id: ctx.persist && ctx.persist.bug_id,
        severity: ctx.triage && ctx.triage.severity,
        bug_type: ctx.triage && ctx.triage.bug_type,
        reasoning: ctx.triage && ctx.triage.reasoning,
        fix_title: ctx.suggest && ctx.suggest.fix_title,
        fix_suggestion: ctx.suggest && ctx.suggest.fix_suggestion,
        risk_level: ctx.suggest && ctx.suggest.risk_level,
        assignee_login: assigneeLogin || null,
        assignee_reason: ctx.owner && ctx.owner.reason,
        assignee_slack_user_id: slackUser && slackUser.slack_user_id,
        error: run.error,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  server.registerTool(
    "link_slack_identity",
    {
      title: "Link a GitHub login to a Slack user",
      description:
        "Records that a given GitHub username corresponds to a given Slack user, so future suggested-owner cards can @-mention them directly instead of just showing a GitHub handle. Use when someone says something like 'I'm <github-login> on GitHub' or 'my github is X'.",
      inputSchema: {
        github_login: z.string(),
        slack_user_id: z.string(),
        slack_username: z.string().optional(),
      },
    },
    async ({ github_login, slack_user_id, slack_username }) => {
      await lemma.linkSlackIdentity(github_login, slack_user_id, slack_username || "");
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, github_login, slack_user_id }, null, 2) }] };
    }
  );

  server.registerTool(
    "list_open_bugs",
    {
      title: "List open bugs",
      description:
        "List currently open bugs in the Cortex-Triage backlog, optionally filtered by severity (P1/P2/P3). Use this to answer questions like 'what's our P1 backlog look like' or 'any new bugs today'.",
      inputSchema: {
        severity: z.enum(["P1", "P2", "P3"]).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
    },
    async ({ severity, limit }) => {
      const whereClause = severity ? `where b.severity = '${severity}' and b.decision_status != 'closed'` : `where b.decision_status != 'closed'`;
      const sql = `select b.id, b.title, b.severity, b.bug_type, b.decision_status, b.assignee_login, b.created_at
                   from bugs b ${whereClause}
                   order by b.severity asc, b.created_at desc
                   limit ${Number(limit) || 20}`;
      const res = await lemma.query(sql);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.registerTool(
    "get_bug",
    {
      title: "Get bug details",
      description: "Look up full details (including suggested fix) for a single bug by its id.",
      inputSchema: { bug_id: z.string().describe("UUID of the bug") },
    },
    async ({ bug_id }) => {
      const sql = `select b.*, f.title as fix_title, f.suggestion as fix_suggestion, f.code_snippet as fix_code, f.risk_level
                   from bugs b left join fixes f on f.bug_id = b.id
                   where b.id = '${bug_id}'
                   limit 1`;
      const res = await lemma.query(sql);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }
  );

  server.registerTool(
    "route_message",
    {
      title: "Route a free-form Slack message",
      description:
        "Internal: classifies a free-form user message into one of the other tools and extracts its arguments, using the slack-router Lemma agent.",
      inputSchema: { message: z.string() },
    },
    async ({ message }) => {
      const run = await lemma.runWorkflow("route-message", "intake", { message }, "route");
      const ctx = run.execution_context || {};
      return { content: [{ type: "text", text: JSON.stringify(ctx.route || {}, null, 2) }] };
    }
  );

  server.registerTool(
    "decide_bug",
    {
      title: "Record a triage decision on a bug",
      description:
        "Records a human decision on a triaged bug: assign, defer, backlog, or close. Use when someone says to close/backlog/defer/assign a specific bug (they must give or have just been given its id).",
      inputSchema: {
        bug_id: z.string().describe("UUID of the bug"),
        decision: z.enum(["assign", "defer", "backlog", "close"]),
        reason: z.string().optional(),
        decided_by: z.string().optional(),
        defer_days: z.number().int().optional(),
      },
    },
    async ({ bug_id, decision, reason, decided_by, defer_days }) => {
      const res = await lemma.runFunction("decide_bug", {
        bug_id,
        decision,
        reason: reason || "",
        decided_by: decided_by || "slack",
        defer_days: defer_days || 14,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.output_data || res, null, 2) }] };
    }
  );

  server.registerTool(
    "compile_release_notes",
    {
      title: "Compile release notes",
      description: "Compile a draft of release notes from recently fixed/closed bugs. Use this when someone asks to draft or generate release notes.",
      inputSchema: { version: z.string().optional().describe("Version label, e.g. v1.4.0") },
    },
    async ({ version }) => {
      const run = await lemma.runWorkflow(
        "compile-release-notes",
        "intake",
        { version: version || "v0.1.0" },
        "persist"
      );
      const ctx = run.execution_context || {};
      const summary = {
        status: run.status,
        version: version || "v0.1.0",
        notes_markdown: ctx.compile && ctx.compile.notes_markdown,
        highlights: ctx.compile && ctx.compile.highlights,
        breaking_changes: ctx.compile && ctx.compile.breaking_changes,
        bug_count: ctx.gather && ctx.gather.bug_count,
        error: run.error,
      };
      return { content: [{ type: "text", text: JSON.stringify(summary, null, 2) }] };
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 3939;
app.listen(PORT, () => {
  console.log(`Cortex-Triage MCP server listening on http://localhost:${PORT}/mcp`);
});
