---
name: redline
description: Create and iterate on rich HTML design artifacts (architecture docs, decision records, API contracts, data flows, diagrams, UI mockups) with human redline feedback via the local redline server. Use when the user wants to visualize, document, mock up, or explain a design and review it with comments.
---

# Redline: design artifact review loop

redline serves HTML artifacts in a browser shell where the user pins comments, talks with you live in the threads, and hits **Iterate** to hand you a frozen batch of feedback. You answer comments immediately (conversation only), then do the real work when Iterate is pressed. Approval is just "done for now" — a stamp on a version, never a dead end. Everything lives under `~/.redline`; the server exposes it over HTTP.

## The loop contract

The server can run its own agents. Two lanes: a reviewer answers comments in threads, and a worker publishes on Iterate. Each lane has its own adapter (`acp`, `opencode-sdk`, or `none`), preset, command, model, and prompt template. When the reviewer lane is configured, `create_artifact` says so in its response. Your job is then just: share the URL, stop. Replies and Iterate happen server-side. The reviewer fills thinking placeholders, and a fresh worker session gets the current version's file path under `~/.redline`, returns the next document, and the server publishes it. Approve unbinds both lanes and still means done for now. When the reviewer lane is `none`, the contract below is all yours.

Two wake reasons, one exit. The server enforces the split (publishing outside iterating is a 409), so stay in your lane:

- **Reply duty** — the user commented. Replace the thread's `thinking` placeholder with a real answer (PATCH), or post a reply. Answer questions, ack requests, say what you will do in the next iteration. Never touch the artifact here.
- **Work duty** — the user hit Iterate. A batch of open threads is frozen onto a pending version. Address the batch and publish with `update_artifact` (note = what changed). Publishing stamps the version and returns the artifact to review. Replying in threads while you work is fine.
- **Exit** — the user approved the current version. Report "approved @ vN — done for now" and hand control back. The artifact stays open; a later Iterate re-attaches you.

After two consecutive empty waits, hand control back instead of polling forever. Pending iterations recover automatically: the next `wait_for_feedback` or `get_feedback` surfaces them first.

## Workflow

1. Decide the artifact's shape: architecture doc, decision record, API contract, data flow, comparison, UI mockup, explainer. One artifact = one idea. Split unrelated topics into separate artifacts.
2. Author a complete single-file HTML document:
   - All CSS and JS inline. No external requests: no CDNs, web fonts, or remote images. Use inline SVG for diagrams.
   - Give every major section, diagram node, table, and embedded UI demo a stable `id`. Pins reference these selectors, so stable ids keep feedback attached across versions.
   - Readability first: system font stack, clear headings, generous line height, responsive down to ~1000px. Pick dark or light deliberately.
   - Interactive bits are encouraged when they explain: toggles, tabs, step-throughs, small simulations. Keep them dependency-free.
   - For API contracts: one block per endpoint with a stable id (for example `id="post-orders"`), showing method, path, request and response examples.
   - For architecture: label every box and edge, add a legend, and put trade-off prose next to the diagram.
   - Start with a header: title plus a one-paragraph summary of the decision or idea.
3. Call `create_artifact` with the full HTML. It returns a review URL.
4. Read `create_artifact`'s response text. It picks the loop:
   - **Reviewer configured**: give the user the review URL and say what to look at, then stop. Do not call `wait_for_feedback`. The server's reviewer and worker agents handle replies and iteration duties.
   - **No reviewer**: give the user the review URL and say what to look at. Then call `wait_for_feedback` (timeoutSeconds up to 300).
5. When it wakes, act on the duty in the result:
   - **Reply duty**: fill every thinking placeholder with a real answer (PATCH each one), keep waiting. A good reply says how you will address it, e.g. "will move the legend below the diagram in the next iteration".
   - **Work duty**: read the frozen batch, revise the full HTML, call `update_artifact` with a `note` summarizing the changes. Address everything actionable in one pass.
   - **Exit**: the user approved. Report it and stop.
6. Loop until an exit or two empty waits.

## Tools

| Tool | Purpose |
|------|---------|
| `create_artifact` | `{title, html, prompt?, note?}` returns the review URL. The response text is conditional: when the server has a reviewer it says to share the URL and stop, otherwise it says to call `wait_for_feedback` |
| `update_artifact` | `{artifactId, html, note?}` publishes the pending iteration (409 unless iterating), status returns to review. Same conditional response text |
| `get_feedback` | `{artifactId, version?}` threads, presence, pending iteration, right now |
| `wait_for_feedback` | `{artifactId, timeoutSeconds?, after?}` blocks until reply duty, work duty, exit, or timeout. The fallback path when no reviewer is configured on the server |
| `list_artifacts` | all artifacts with open thread counts |

## Server settings

Lanes live at `/settings` in the review UI (linked from the gallery header). Reviewer, Worker, and Notify tabs. The preset dropdown fills the command box. Each ACP lane has a Test button (an ACP handshake probe) and a template reset. Save probes every configured lane and rejects the save with failure detail. Settings apply live, no restart. Never edit `~/.redline/settings.json` by hand. If `create_artifact`'s response does not mention a configured reviewer, the host is in fallback mode: run the wait loop yourself.

Two limits worth knowing. ACP has no portable model flag, so the per-lane model only applies to the `opencode-sdk` adapter (on ACP, bake model flags into a custom command). Notify needs an `opencode-sdk` lane and an origin the plugin captured at create time.

## Bootstrap (server not running yet)

pi and OpenCode tools start the daemon on first call. Without those tools (Claude Code, Cursor, Antigravity, skill-only installs), bootstrap yourself. No human needed:

1. Prefer the canonical app at `~/.redline/app`. A skills-CLI install usually only has this skill folder, not `install.sh` or `src/`. Clone if missing:

   ```bash
   [ -f ~/.redline/app/install.sh ] || git clone --depth 1 https://github.com/codenamegary/redline.git ~/.redline/app
   ```

   If you are inside a full checkout (it contains `install.sh` and `src/main.ts`), you may use that directory instead and set `REDLINE_APP` to it.

2. Ensure deps and a running daemon (idempotent, safe to re-run). Also pulls the latest app when `~/.redline/app` is a git checkout:

   ```bash
   bash ~/.redline/app/install.sh --ensure-daemon
   ```

   Provisions a runtime if needed (bun, or a user-local bun when only node < 22 exists), installs dependencies, starts or restarts the daemon after an update, waits for health. Logs: `~/.redline/server.log`.

Skill text updates come from the skills CLI (`npx skills update`). Do not ask the user to run update commands.

## Without native tools

The server speaks plain HTTP. Discover it from `~/.redline/server.json` (host and port; default `http://127.0.0.1:4739`). If nothing answers on `/api/v1/health`, bootstrap it (above).

```bash
# create
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts -H 'content-type: application/json' \
  -d '{"title":"...","html":"<h1>...</h1>"}'
# read or wait for feedback (wakes on comments, Iterate, and approve)
curl -s "http://127.0.0.1:4739/api/v1/artifacts/<id>/feedback?wait=120&after=<iso-timestamp>"
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

Feedback is also plain JSON on disk at `~/.redline/artifacts/<id>/feedback/v<N>.json`, readable with the `read` tool. Per-version files are the storage of record; the HTTP view merges them.

## Feedback shape

Each thread has `id`, `status` (`open` or `resolved`), `anchor` (`selector`, `text`, `rect`; `null` for general comments), `anchorVersion` (the version the thread was pinned on), `resolvedInVersion` (the version that was current when it was resolved; absent while open), and `messages` (`author`: `user` or `agent`, `kind`: `text` or `thinking`, `body`, `createdAt`). A `thinking` message is a server-synthesized placeholder (shown with a spinner in the UI) waiting for your PATCH. Regular messages are immutable.

Threads belong to the artifact, not to a version. The default feedback view always returns every thread, open ones first, including threads pinned on older versions. Resolved threads stay readable (collapsed in the review UI, tagged with the version that resolved them). `?version=vN` filters to threads pinned on vN. The user resolves threads, never you.

The view also carries `current`, `artifactStatus` (`draft`, `review`, `iterating`), `agentAttached` (true when a `wait_for_feedback` long-poll is in flight, a reviewer lane is bound, or a worker lane is running), plus additive per-lane booleans `reviewerAttached` and `workerRunning`, `iteratedAt`, `approvedAt` (when the current version is signed off), and the version ledger — one row per iteration: `version`, `note`, `publishedAt`, `approvedAt`, and `batch` (`threadIds`, `submittedAt`) while it is the frozen work contract. A row with a batch and no `publishedAt` is the pending iteration.
