---
name: redline
description: Create and iterate on rich HTML design artifacts (architecture docs, decision records, API contracts, data flows, diagrams, UI mockups) with human redline feedback via the local redline server. Use when the user wants to visualize, document, mock up, or explain a design and review it with comments.
---

# Redline: design artifact review

redline serves HTML artifacts in a browser shell where the user pins comments, and redline's own agents answer in the threads and publish new versions. You render and create the artifact, share the review URL, and stop. Approval is just "done for now" — a stamp on a version, never a dead end. Everything lives under `~/.redline`; the server exposes it over HTTP.

## The loop contract

The review loop runs inside redline, not in your session. Two lanes: a reviewer answers comments in threads, and a worker publishes on Iterate. Each lane has its own adapter (`acp`, `opencode-sdk`, or `none`), preset, command, model, and prompt template. The reviewer fills thinking placeholders, and a fresh worker session gets the current version's file path under `~/.redline`, returns the next document, and the server publishes it. While that runs, batch threads get agent notes: `Working on this for vN.` on claim, `Addressed in vN.` plus the publish note on success, `Worker failed: …` on error (artifact stays iterating). Those notes are status, not new user pins. Approve unbinds both lanes and still means done for now.

Your job: create the artifact, give the user the review URL, stop. You never wait for feedback, reply in threads, or publish — redline owns all three. With Notify on, the server posts a one-line status into an OpenCode origin session after each duty (replies, publishes, worker failures, approvals). That ping is status only; it never asks you to reply, publish, or wait.

If the user explicitly asks you to read feedback or publish a new version, `get_feedback` and `update_artifact` are there for that. That is a direct request, not the review loop.

## Workflow

Stage HTML only inside the current workspace. Never write HTML to `/tmp`, `$TMPDIR`, `~/.redline`, or any path outside the workspace. Those writes prompt for permission.

1. Decide the artifact's shape: architecture doc, decision record, API contract, data flow, comparison, UI mockup, explainer. One artifact = one idea. Split unrelated topics into separate artifacts.
2. Author a complete single-file HTML document:
   - All CSS and JS inline. No external requests: no CDNs, web fonts, or remote images. Use inline SVG for diagrams.
   - Give every major section, diagram node, table, and embedded UI demo a stable `id`. Pins reference these selectors, so stable ids keep feedback attached across versions.
   - Readability first: system font stack, clear headings, generous line height, responsive down to ~1000px. Pick dark or light deliberately.
   - Interactive bits are encouraged when they explain: toggles, tabs, step-throughs, small simulations. Keep them dependency-free.
   - For API contracts: one block per endpoint with a stable id (for example `id="post-orders"`), showing method, path, request and response examples.
   - For architecture: label every box and edge, add a legend, and put trade-off prose next to the diagram.
   - Start with a header: title plus a one-paragraph summary of the decision or idea.
3. Write the document to `.redline-drafts/<short-slug>.html` in the current workspace. Use the Write tool. Do not use `mktemp`, `/tmp`, or a path outside the workspace.
4. Read the draft. Call `create_artifact` with the file contents as `html`. Pass the string, not a path. The tool returns the review URL. Same rule for `update_artifact` when the user asked you to publish.
5. Delete the draft file. Remove `.redline-drafts/` if it is empty. Do not commit the draft.
6. Share the URL, say what to look at, and stop. The response text confirms this whether or not a reviewer lane is configured.

## Tools

| Tool | Purpose |
|------|---------|
| `create_artifact` | `{title, html, prompt?, note?}` returns the review URL. Share it and stop |
| `update_artifact` | `{artifactId, html, note?}` publishes the pending iteration (409 unless iterating), status returns to review. Only on an explicit user ask |
| `get_feedback` | `{artifactId, version?}` threads, presence, pending iteration, right now. Only on an explicit user ask |
| `list_artifacts` | all artifacts with open thread counts |

## Server settings

Lanes live at `/settings` in the review UI (linked from the gallery header). Reviewer, Worker, and Notify tabs. The preset dropdown fills the command box. ACP presets: OpenCode, Cursor Agent (`~/.local/bin/agent acp`), Claude Code, Gemini, Codex. Each ACP lane has a Test button (an ACP handshake probe) and a template reset. Save probes every configured lane and rejects the save with failure detail. Settings apply live, no restart. Never edit `~/.redline/settings.json` by hand. If the user reports that nothing answers their pins, point them at `/settings` — the reviewer lane is probably `none`.

Two limits worth knowing. ACP has no portable model flag, so the per-lane model only applies to the `opencode-sdk` adapter (on ACP, bake model flags into a custom command). Notify needs an `opencode-sdk` lane and an origin with `host: "opencode"` captured at create time. `GET /api/v1/artifacts/:id/worker` is debug only (configured vs live lanes, origin). Do not use it in the review loop.

## Bootstrap (server not running yet)

pi and OpenCode tools start the daemon on first call. Without those tools (Claude Code, Cursor, Antigravity, skill-only installs), bootstrap yourself. No human needed:

1. Prefer the canonical app at `~/.redline/app`. A skills-CLI install usually only has this skill folder, not `install.sh` or `src/`. Clone if missing:

   ```bash
   [ -f ~/.redline/app/install.sh ] || git clone --depth 1 https://github.com/codenamegary/redline.git ~/.redline/app
   ```

   If you are inside a full checkout (it contains `install.sh` and `src/main.ts`), you may use that directory instead and set `REDLINE_APP` to it.

2. Ensure a running daemon (idempotent, safe to re-run). Also updates to the latest release when one exists:

   ```bash
   bash ~/.redline/app/install.sh --ensure-daemon
   ```

   Downloads the prebuilt release binary into `~/.redline/bin` when needed (only curl + tar required — no bun, node, or deps), starts or restarts the daemon after an update, and waits for health. Logs: `~/.redline/server.log`. `--from-source` runs the daemon from the checkout instead (needs bun or node 22+).

Skill text updates come from the skills CLI (`npx skills update`). Do not ask the user to run update commands.

## Without native tools

The server speaks plain HTTP at `http://127.0.0.1:4739` (or the port in `$REDLINE_PORT`). To check it, probe `/api/v1/health`. If nothing answers, bootstrap it (above).

Stage HTML the same way as the workflow: write `.redline-drafts/<short-slug>.html` in the current workspace, then POST the file contents as `html`. Never write the draft to `/tmp`. Delete the draft after the request succeeds.

```bash
# create
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts -H 'content-type: application/json' \
  -d '{"title":"...","html":"<h1>...</h1>"}'
# read feedback and loop status
curl -s http://127.0.0.1:4739/api/v1/artifacts/<id>/feedback
# answer a thinking placeholder (the only editable message kind)
curl -s -X PATCH http://127.0.0.1:4739/api/v1/artifacts/<id>/threads/<threadId>/messages/<messageId> \
  -H 'content-type: application/json' -d '{"body":"will move the legend below the diagram in v3"}'
# post an extra reply as the agent
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts/<id>/threads/<threadId>/messages \
  -H 'content-type: application/json' -d '{"body":"...","author":"agent"}'
# publish the pending iteration (409 unless the user hit Iterate)
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts/<id>/versions -H 'content-type: application/json' \
  -d '{"html":"...","note":"what changed"}'
# check the server-side lanes and prompt templates
curl -s http://127.0.0.1:4739/api/v1/settings
```

Feedback is also plain JSON on disk at `~/.redline/artifacts/<id>/v<N>-feedback.json`, readable with the `read` tool. Per-version files are the storage of record; the HTTP view merges them.

## Feedback shape

Each thread has `id`, `status` (`open` or `resolved`), `anchor` (`selector`, `text`, `rect`; `null` for general comments), `anchorVersion` (the version the thread was pinned on), `resolvedInVersion` (the version that was current when it was resolved; absent while open), and `messages` (`author`: `user` or `agent`, `kind`: `text` or `thinking`, `body`, `createdAt`). A `thinking` message is a server-synthesized placeholder (shown with a spinner in the UI) waiting for the reviewer lane's answer. Regular messages are immutable.

Threads belong to the artifact, not to a version. The default feedback view always returns every thread, newest first, including threads pinned on older versions. Resolved threads stay readable (collapsed in the review UI, tagged with the version that resolved them). `?version=vN` filters to threads pinned on vN. The user resolves threads, never you.

The view also carries `current`, `artifactStatus` (`draft`, `review`, `iterating`), `agentAttached` (true when a reviewer lane is bound, a worker lane is running, or a feedback long-poll is in flight), plus additive per-lane booleans `reviewerAttached` and `workerRunning`, `iteratedAt`, `approvedAt` (when the current version is signed off), and the version ledger — one row per iteration: `version`, `note`, `publishedAt`, `approvedAt`, and `batch` (`threadIds`, `submittedAt`) while it is the frozen work contract. A row with a batch and no `publishedAt` is the pending iteration.
