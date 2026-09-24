# Copilot SDK Incident Command Center

A focused business incident-management demo that embeds the GitHub Copilot SDK in a
Node.js backend. Incident Commander reads trusted operational context, streams its work
into a React application, and requires an explicit browser approval before every
state-changing tool call.

The repository is safe to publish: it contains synthetic incident data, no credentials,
and no user-authentication fallback.

## What the demo shows

- A polished incident dashboard with deterministic P1–P4 sample incidents
- A server-side custom Copilot agent named `incident-commander`
- Typed read tools that run automatically:
  `get_incident`, `get_incident_timeline`, `get_service_health`, and
  `list_related_incidents`
- Typed write tools that always require browser approval:
  `assign_incident`, `update_incident_status`, and `add_timeline_note`
- Streaming assistant text and visible tool activity
- SQLite persistence, correlated session/audit events, denial records, and immediate UI refresh
- GitHub App server-to-server authentication with organization-attributed Copilot usage
- A deterministic CLI and browser reset for repeatable customer demos

## Prerequisites

- Node.js `20.19+` or `22.12+`
- npm
- A GitHub organization with Copilot and the policy that enables Copilot requests from
  GitHub App installations
- A GitHub App installed on the organization with **All repositories** access

The current Copilot permission check requires an **All repositories** installation. A
selected-repositories installation is not sufficient, even though the installation
token itself is scoped to the configured repository ID.

## Install

```bash
npm install
cp .env.example .env
```

The application and tests work without live credentials. Without them, the dashboard
shows a truthful **unconfigured** authentication state and Copilot requests return an
actionable error; the server never silently falls back to a logged-in developer account.

## GitHub App setup

Follow the current
[server-to-server token documentation](https://docs.github.com/en/enterprise-cloud@latest/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens).

1. Create a GitHub App owned by the organization that should receive Copilot billing.
2. Under repository permissions, grant **Copilot requests: Read and write**.
3. Install the App on the organization with **All repositories** access.
4. Confirm the organization policy allows Copilot requests from GitHub App installations.
5. Generate and download an App private key.
6. Obtain the required IDs:
   - **App ID:** App settings page
   - **Installation ID:** the numeric ID in the installation URL, or the GitHub App
     installations API
   - **Repository ID:** `gh api repos/OWNER/REPOSITORY --jq .id`
7. Configure `.env`:

```dotenv
GITHUB_APP_ID=123456
GITHUB_APP_INSTALLATION_ID=78901234
GITHUB_REPOSITORY_ID=987654321
GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
COPILOT_MODEL=gpt-5
```

Multiline private keys are supported either as real newlines or escaped `\n` sequences.
Never commit `.env` or a private-key file.

At runtime the backend:

1. creates a short-lived GitHub App JWT;
2. requests an installation token for the configured repository with
   `copilot_requests: write`;
3. validates that GitHub returned a `ghs_` installation token;
4. starts the locally managed Copilot runtime with that token in
   `COPILOT_GITHUB_TOKEN`;
5. sets `useLoggedInUser: false`; and
6. stops and recreates the runtime with a refreshed token before expiry.

The installation token is intentionally **not** passed through the SDK `gitHubToken`
option, which is for user tokens.

> If the “Copilot requests” permission is not visible while creating the App, verify that
> the feature is available for the organization and account, then contact GitHub Support.
> Do not substitute an unrelated permission or a developer’s personal token for this demo.

## Run locally

```bash
npm run dev
```

Open <http://localhost:5173>. Vite proxies API requests to the Express server on port
`3001`.

For a production-style build:

```bash
npm run build
npm start
```

Express serves the built frontend and API from <http://localhost:3001>.

## Reset the demo

```bash
npm run db:reset
```

This idempotently recreates incidents, status, assignments, timeline entries, service
health, sessions, and audit data from the canonical seed. The **Reset demo data** button
performs the same operation after an explicit browser confirmation.

## Validation

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Tests cover the incident domain service, deterministic reset, tool definitions,
approval gating and denial, installation-token request shape, streaming API behavior,
and reset API confirmation.

## Troubleshooting authentication

The header badge and `GET /api/health/copilot` expose only a non-sensitive status:
`unconfigured`, `configured`, `healthy`, or `error`.

| Symptom                               | What to check                                                                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized`                    | The organization supports Copilot requests from GitHub App installations and the App/installation IDs are correct.                        |
| `403 ... user information`            | The installation token is supplied as `COPILOT_GITHUB_TOKEN`, not the SDK user-token option.                                              |
| `403 Forbidden` while minting a token | The App has `Copilot requests: Read and write`; the request contains the configured `repository_ids` value and `copilot_requests: write`. |
| `403 Forbidden` from the Copilot API  | The App installation uses **All repositories** access; reinstall if needed, then mint a new token.                                        |
| Requested model unavailable           | The organization policy allows `COPILOT_MODEL`, and the bundled Copilot runtime supports it.                                              |
| Wrong account is billed               | The GitHub App installation belongs to the intended organization, not a user account or another organization.                             |
| Invalid private key                   | Preserve the complete PEM header/footer and quote escaped newlines in `.env`.                                                             |

## Architecture

- `src/client` — React/Vite dashboard and streaming approval UI
- `src/server/app.ts` — Express API and production static serving
- `src/server/domain` — incident service and canonical seed data
- `src/server/db` — SQLite schema, migration, and deterministic reset
- `src/server/copilot` — GitHub App auth, managed SDK runtime, tools, permissions,
  approval broker, and event translation
- `src/shared` — end-to-end TypeScript API/domain contracts

The browser never receives GitHub credentials and never accesses SQLite. Copilot tools
call the same incident domain service as the API. That boundary is deliberately small so
the synthetic adapters can later be replaced by trusted ServiceNow, PagerDuty, Datadog,
internal API, or MCP integrations without changing the user experience.

See [DEMO-FLOW.md](./DEMO-FLOW.md) for the presenter script and diagrams.
