---
name: redline
description: Create and iterate on rich HTML design artifacts (architecture docs, decision records, API contracts, data flows, diagrams, UI mockups) with human redline feedback via the local redline server. Use when the user wants to visualize, document, mock up, or explain a design and review it with comments.
---

# Redline: design artifact review loop

redline serves HTML artifacts in a browser shell where the user pins comments on any element and approves. You create, wait, revise, repeat. Everything lives under `~/.redline`; the server exposes it over HTTP.

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
4. Give the user the review URL and say what to look at. Then call `wait_for_feedback` (timeoutSeconds up to 300).
5. When it wakes:
   - If a thread asks a question you can answer, reply in-thread (POST a message with author `agent`) and keep waiting.
   - Otherwise revise the full HTML and call `update_artifact` with a `note` summarizing the changes. Address everything actionable in one pass.
6. Call `wait_for_feedback` again. Loop until `artifactStatus` is `approved` or a wait comes back empty. After two empty waits, hand control back to the user instead of polling forever.

## Tools

| Tool | Purpose |
|------|---------|
| `create_artifact` | `{title, html, prompt?, note?}` returns the review URL |
| `update_artifact` | `{artifactId, html, note?}` publishes the next version, status returns to review |
| `get_feedback` | `{artifactId, version?}` threads and status right now |
| `wait_for_feedback` | `{artifactId, timeoutSeconds?, after?}` blocks until comments, approval, or timeout |
| `list_artifacts` | all artifacts with open thread counts |

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
# read or wait for feedback
curl -s "http://127.0.0.1:4739/api/v1/artifacts/<id>/feedback?wait=120&after=<iso-timestamp>"
# reply to a thread as the agent
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts/<id>/threads/<threadId>/messages \
  -H 'content-type: application/json' -d '{"body":"...","author":"agent"}'
# publish a revision
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts/<id>/versions -H 'content-type: application/json' \
  -d '{"html":"...","note":"what changed"}'
# status: draft, review, approved
curl -s -X PATCH http://127.0.0.1:4739/api/v1/artifacts/<id> -H 'content-type: application/json' \
  -d '{"status":"review"}'
```

Feedback is also plain JSON on disk at `~/.redline/artifacts/<id>/feedback/v<N>.json`, readable with the `read` tool. Per-version files are the storage of record; the HTTP view merges them.

## Feedback shape

Each thread has `id`, `status` (`open` or `resolved`), `anchor` (`selector`, `text`, `rect`; `null` for general comments), `anchorVersion` (the version the thread was pinned on), `resolvedInVersion` (the version that was current when it was resolved; absent while open), and `messages` (`author`: `user` or `agent`, `body`, `createdAt`).

Threads belong to the artifact, not to a version. The default feedback view always returns every thread, open ones first, including threads pinned on older versions. Resolved threads stay readable (collapsed in the review UI, tagged with the version that resolved them). `?version=vN` filters to threads pinned on vN. Resolve threads by fixing the artifact in the next version, not by editing the feedback.
