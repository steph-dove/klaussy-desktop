// Built-in catalog of common MCP servers shown as one-click "add" cards. Each
// entry is a template the add form pre-fills; verified against vendors' MCP docs
// (mid-2026), fully editable. See main/util/mcp-config.js for how they're written.
//
// Most are OAuth remotes (auth:'oauth', no token); stdio servers needing secrets
// (auth:'env') declare requiredEnv and are set via the shell profile, not config.
//
// Entry: { id, name, category, description, type:'stdio'|'http'|'sse',
//   command/args | url, auth:'oauth'|'env'|'app'|'none', requiredEnv, optionalEnv,
//   requiredArgs, docsUrl, note }.

const CATEGORIES = [
  'Dev tools',
  'Project management',
  'Communication',
  'Reliability & observability',
  'Payments & design',
];

const CATALOG = [
  // ---- Dev tools ----
  {
    id: 'github',
    name: 'GitHub',
    category: 'Dev tools',
    description: 'Repos, issues, PRs, Actions, code search.',
    type: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth',
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server',
    note: 'Official remote server — sign in with OAuth on first use.',
  },
  {
    id: 'filesystem',
    name: 'Filesystem',
    category: 'Dev tools',
    description: 'Read/write files within directories you allow.',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    auth: 'none',
    requiredArgs: [{ label: 'Allowed directory', placeholder: '/Users/you/projects' }],
    docsUrl: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    note: 'Pass one or more directories the server is allowed to touch.',
  },

  // ---- Project management ----
  {
    id: 'linear',
    name: 'Linear',
    category: 'Project management',
    description: 'Issues, projects, and cycles in Linear.',
    type: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    docsUrl: 'https://linear.app/docs/mcp',
    note: 'Official remote server — sign in with OAuth on first use.',
  },
  {
    id: 'atlassian',
    name: 'Atlassian (Jira & Confluence)',
    category: 'Project management',
    description: 'Jira issues, Confluence pages, JSM, Bitbucket.',
    type: 'http',
    url: 'https://mcp.atlassian.com/v1/mcp/authv2',
    auth: 'oauth',
    docsUrl: 'https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    note: 'Official Rovo remote server — sign in with OAuth on first use.',
  },
  {
    id: 'notion',
    name: 'Notion',
    category: 'Project management',
    description: 'Search and edit Notion pages and databases.',
    type: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    docsUrl: 'https://developers.notion.com/guides/mcp/get-started-with-mcp',
    note: 'Official remote server — sign in with OAuth on first use.',
  },
  {
    id: 'asana',
    name: 'Asana',
    category: 'Project management',
    description: 'Tasks, projects, and portfolios in Asana.',
    type: 'http',
    url: 'https://mcp.asana.com/v2/mcp',
    auth: 'oauth',
    docsUrl: 'https://developers.asana.com/docs/using-asanas-mcp-server',
    note: 'Official remote server — sign in with OAuth on first use.',
  },

  // ---- Communication ----
  {
    id: 'slack',
    name: 'Slack',
    category: 'Communication',
    description: 'Read and post to Slack channels.',
    type: 'http',
    url: 'https://mcp.slack.com/mcp',
    auth: 'oauth',
    docsUrl: 'https://docs.slack.dev/ai/slack-mcp-server/',
    note: 'Official Slack-hosted server — sign in with OAuth on first use.',
  },

  // ---- Reliability & observability ----
  {
    id: 'sentry',
    name: 'Sentry',
    category: 'Reliability & observability',
    description: 'Issues, errors, and releases from Sentry.',
    type: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    docsUrl: 'https://mcp.sentry.dev/',
    note: 'Official remote server — sign in with OAuth on first use.',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    category: 'Reliability & observability',
    description: 'Metrics, monitors, logs, APM, and incidents.',
    type: 'http',
    url: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',
    auth: 'oauth',
    docsUrl: 'https://docs.datadoghq.com/mcp_server/setup/',
    note: 'Official remote server (US1) — sign in with OAuth. For another site, swap the host (e.g. mcp.datadoghq.eu).',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    category: 'Reliability & observability',
    description: 'Dashboards, Prometheus/Loki queries, alerts.',
    type: 'stdio',
    command: 'uvx',
    args: ['mcp-grafana'],
    auth: 'env',
    requiredEnv: [
      { key: 'GRAFANA_URL', label: 'Grafana URL', placeholder: 'http://localhost:3000' },
      { key: 'GRAFANA_SERVICE_ACCOUNT_TOKEN', label: 'Service account token', placeholder: 'glsa_...' },
    ],
    docsUrl: 'https://github.com/grafana/mcp-grafana',
    note: 'Needs uv (uvx) installed. Use a service-account token — GRAFANA_API_KEY is deprecated.',
  },
  {
    id: 'pagerduty',
    name: 'PagerDuty',
    category: 'Reliability & observability',
    description: 'Incidents, services, and on-call schedules.',
    type: 'http',
    url: 'https://mcp.pagerduty.com/mcp',
    auth: 'oauth',
    docsUrl: 'https://developer.pagerduty.com/docs/mcp-tooling-remote-server',
    note: 'Official remote server (US) — sign in on first use. EU: mcp.eu.pagerduty.com/mcp.',
  },
  {
    id: 'honeycomb',
    name: 'Honeycomb',
    category: 'Reliability & observability',
    description: 'Query traces and events in Honeycomb.',
    type: 'http',
    url: 'https://mcp.honeycomb.io/mcp',
    auth: 'oauth',
    docsUrl: 'https://docs.honeycomb.io/integrations/mcp/',
    note: 'Official remote server (US) — sign in with OAuth. EU: mcp.eu1.honeycomb.io/mcp.',
  },

  // ---- Payments & design ----
  {
    id: 'stripe',
    name: 'Stripe',
    category: 'Payments & design',
    description: 'Customers, payments, invoices, and docs.',
    type: 'http',
    url: 'https://mcp.stripe.com',
    auth: 'oauth',
    docsUrl: 'https://docs.stripe.com/mcp',
    note: 'Official remote server — sign in with OAuth on first use.',
  },
  {
    id: 'figma',
    name: 'Figma',
    category: 'Payments & design',
    description: 'Read Figma files, frames, and design data.',
    type: 'http',
    url: 'http://127.0.0.1:3845/mcp',
    auth: 'app',
    docsUrl: 'https://developers.figma.com/docs/figma-mcp-server/',
    note: 'Served by the Figma desktop app — enable it in Figma › Preferences › Enable Dev Mode MCP server, then this connects locally.',
  },
];

module.exports = { CATALOG, CATEGORIES };
