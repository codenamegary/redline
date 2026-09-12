---
name: redline
description: Create and iterate on rich HTML design artifacts (architecture docs, decision records, API contracts, data flows, diagrams, UI mockups) with human redline feedback via the local redline server. Use when the user wants to visualize, document, mock up, or explain a design and review it with comments.
---

# Redline: design artifact review

redline serves HTML artifacts in a browser shell where the user pins comments, and redline's own agents answer in the threads and publish new versions. You render and create the artifact, share the review URL, and stop. Approval is just "done for now" — a stamp on a version, never a dead end. Everything lives under `~/.redline`; the server exposes it over HTTP.

## The loop contract

The review loop runs inside redline, not in your session. Two lanes: a reviewer answers comments in threads, and a worker publishes on Iterate. Each lane has its own adapter (`acp` or `none`), preset, command, and prompt template. The reviewer fills thinking placeholders, and a fresh worker session gets the current version's file path under `~/.redline`, returns the next document, and the server publishes it. While that runs, batch threads get agent notes: `Working on this for vN.` on claim, `Addressed in vN.` plus the publish note on success, `Iteration failed: …` on error (the artifact rolls back to review with every thread still open). Those notes are status, not new user pins. Approve unbinds both lanes and still means done for now.

Your job: create the artifact, give the user the review URL, stop. You never wait for feedback, reply in threads, or publish — redline owns all three.

If the user explicitly asks you to read feedback or publish a new version, `GET /api/v1/artifacts/:id/feedback` and `POST /api/v1/artifacts/:id/versions` are there for that.

## Workflow

Stage HTML only inside the current workspace. Never write HTML to `/tmp`, `$TMPDIR`, `~/.redline`, or any path outside the workspace. Those writes prompt for permission.

1. Decide the artifact's shape: architecture doc, decision record, API contract, data flow, comparison, UI mockup, explainer. One artifact = one idea. Split unrelated topics into separate artifacts.
2. Author a complete single-file HTML document:
   - Load Tailwind via the browser CDN and start from the base skeleton below. The Tailwind CDN script is the only external request allowed: all other CSS and JS stays inline, inline SVG for diagrams. No remote images. Generated local images are fine (see Images & static assets).
   - Give every major section, diagram node, table, and embedded UI demo a stable `id`. Pins reference these selectors, so stable ids keep feedback attached across versions.
   - Readability first: system font stack, clear headings, generous line height, responsive down to ~1000px. Pick dark or light deliberately.
   - Interactive bits are encouraged when they explain: toggles, tabs, step-throughs, small simulations. Keep them dependency-free.
   - For API contracts: one block per endpoint with a stable id (for example `id="post-orders"`), showing method, path, request and response examples.
   - For architecture: label every box and edge, add a legend, and put trade-off prose next to the diagram.
   - Start with a header: title plus a one-paragraph summary of the decision or idea.
3. Write the document to `.redline-drafts/<short-slug>.html` in the current workspace. Use the Write tool. Do not use `mktemp`, `/tmp`, or a path outside the workspace.
4. Read the draft. POST it to the server as `html` (see HTTP endpoints below). Pass the file contents as the string, not a path. The response includes the review URL. If the document references generated images, upload them now (see Images & static assets) before sharing the URL. Same rule when the user asked you to publish a pending iteration: upload assets for the pending version first, then publish.
5. Delete the draft files. Remove `.redline-drafts/` if it is empty. Do not commit the drafts.
6. Share the URL, say what to look at, and stop.

## Base skeleton (Tailwind via CDN)

Start every artifact from this skeleton. Tailwind's browser build compiles utility classes at load time, so there is nothing to build and no other dependency.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title}</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
  <style type="text/tailwindcss">
    @theme {
      /* example tokens — rename, revalue, add freely.
         --color-* tokens generate utilities: bg-accent, text-accent-soft, ... */
      --color-accent:      oklch(0.55 0.2 260);
      --color-accent-soft: oklch(0.95 0.04 260);
    }
    /* examples, not a framework: copy only what you use, or define your own. */
    .rl-card     { @apply rounded-xl border border-black/10 bg-white p-5; }
    .rl-callout  { @apply rounded-lg border-l-4 border-accent bg-accent-soft/40 p-4; }
    .rl-endpoint { @apply rounded-lg bg-zinc-900 p-4 font-mono text-sm text-zinc-100; }
    .rl-badge    { @apply inline-block rounded-full bg-accent px-2 py-0.5 text-xs font-semibold; }
    .rl-table    { @apply w-full text-sm; }
    .rl-table th { @apply border-b py-2 text-left font-semibold opacity-60; }
    .rl-table td { @apply border-b border-black/5 py-2; }
    .rl-kbd      { @apply rounded border border-black/20 bg-white px-1.5 font-mono text-xs; }
  </style>
</head>
<body class="bg-zinc-50 text-zinc-900 antialiased">
  <!-- header: title plus a one-paragraph summary, then content -->
</body>
</html>
```

These classes are a menu, not a framework. Copy only the ones you use; delete or restyle the rest. Define your own component classes in the same block whenever markup repeats — name them however you like, the `rl-` prefix is convention only. Any utility composes with or overrides a component class (`class="rl-card p-10"`). Theme tokens exist so one value re-skins the whole artifact; pick accent colors that fit the content. Everything Tailwind offers is available: the skeleton is a starting point, never a constraint.

## HTTP endpoints

The server speaks plain HTTP at `http://127.0.0.1:4739` (or the port in `$REDLINE_PORT`). Base URL below is `http://127.0.0.1:4739`.

| Endpoint | Purpose |
|------|---------|
| `POST /api/v1/artifacts` | `{title, html, cwd, prompt?, note?}` → 201 with a summary incl. `reviewUrl`. `cwd` is mandatory: the absolute project directory the artifact came from — Iterate sessions spawn there. Share it and stop |
| `POST /api/v1/artifacts/:id/versions` | `{html, note?}` publishes the pending iteration (409 unless iterating), status returns to review |
| `POST /api/v1/artifacts/:id/assets` | `{version, filename, data}` (base64) attaches a static image to one version (5 MB max). Upload before the HTML that references it |
| `GET /api/v1/artifacts/:id/feedback` | threads, presence, pending iteration. `?version=vN` filters to one version |
| `GET /api/v1/artifacts` | all artifacts with open thread counts |

## Images & static assets

Artifacts stay single-file HTML. Generated images ride along as per-version assets: the server stores them at `~/.redline/artifacts/<id>/<version>-assets/<filename>` and serves them at `/a/<id>/<version>/<filename>`, so a plain relative `src` inside the artifact HTML just works.

If you can generate images (an image tool or model is available to you) and the artifact calls for one — photo-real mockups, rendered textures, complex illustrations — do this:

1. Check that image generation is wanted: `GET /api/v1/settings` and read `imageGen`. When `enabled` is false, generate only if the user asked for images directly. `agent` and `model` say what the human configured, if anything.
2. Generate into `.redline-drafts/` in the current workspace, same staging rules as HTML. Never `/tmp`.
3. Upload each file to the target version — `POST /api/v1/artifacts/:id/assets` with `{version, filename, data}` (base64 contents). `version` is `v1` for a fresh create, or the pending version from the feedback view when publishing an iteration.
4. Reference the file with a relative path: `<img src="hero.png">`. Never absolute paths, `file://`, or remote URLs.
5. Delete the draft after the upload succeeds.

Rules: png, jpg, jpeg, gif, webp, svg, avif. 5 MB per file. One filename per version — re-uploading the same name is a 409, so pick a new name for a new image. Upload before sharing the URL or publishing the version that references the file; a missing src shows a broken image mid-review.

## Server settings

Lanes live at `/settings` in the review UI (linked from the gallery header). Reviewer, Worker, and Image Gen tabs. The preset dropdown fills the command box. ACP presets: OpenCode, Cursor Agent (`~/.local/bin/agent acp`), Claude Code, Gemini, Codex. Each ACP lane has a Test button (an ACP handshake probe) and a template reset. Save probes every configured lane and rejects the save with failure detail. Settings apply live, no restart. Never edit `~/.redline/settings.json` by hand. If the user reports that nothing answers their pins, point them at `/settings` — the reviewer lane is `none`. The Image Gen tab is config-only: an on/off toggle plus the agent and model the human uses for image generation; redline never spawns it.

One limit worth knowing. ACP has no portable model flag, so bake model choices into a custom command. `GET /api/v1/artifacts/:id/worker` is debug only (configured vs live lanes). Do not use it in the review loop.

## Bootstrap (server not running yet)

Bootstrap the daemon yourself. No human needed:

1. Ensure a running daemon (idempotent, safe to re-run). Fetch the installer straight from main — no repo clone, no local copy to go stale:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/codenamegary/redline/main/install.sh | bash -s -- --ensure-daemon
   ```

   Downloads the prebuilt release binary into `~/.redline/bin` when needed (only curl + tar + a sha256 tool required — no bun, node, or deps), starts or restarts the daemon after an update, and waits for health. Logs: `~/.redline/server.log`.

2. Only `--from-source` (running the daemon from a checkout instead of the binary) needs a repo checkout at `~/.redline/app` (clone or set `REDLINE_APP` to an existing one):

   ```bash
   [ -f ~/.redline/app/install.sh ] || git clone --depth 1 https://github.com/codenamegary/redline.git ~/.redline/app
   ```

   In source mode, `--ensure-daemon` pulls the checkout to latest before starting.

   Inside a full checkout (it contains `install.sh` and `packages/server/src/main.ts`)? Use that directory and set `REDLINE_APP` to it.

Skill text updates come from the skills CLI (`npx skills update`). Do not ask the user to run update commands.

## Curl quick reference

The server speaks plain HTTP at `http://127.0.0.1:4739` (or the port in `$REDLINE_PORT`). To check it, probe `/api/v1/health`. If nothing answers, bootstrap it (above).

Stage HTML the same way as the workflow: write `.redline-drafts/<short-slug>.html` in the current workspace, then POST the file contents as `html`. Never write the draft to `/tmp`. Delete the draft after the request succeeds.

```bash
# create — cwd is mandatory: the absolute directory of the project the artifact describes
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts -H 'content-type: application/json' \
  -d '{"title":"...","html":"<h1>...</h1>","cwd":"'$PWD'"}'
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
# attach a generated image to v1 (then reference it as <img src="hero.png">)
curl -s -X POST http://127.0.0.1:4739/api/v1/artifacts/<id>/assets -H 'content-type: application/json' \
  -d '{"version":"v1","filename":"hero.png","data":"'"$(base64 -w0 .redline-drafts/hero.png)"'"}'
# check the server-side lanes and prompt templates
curl -s http://127.0.0.1:4739/api/v1/settings
```

Feedback is also plain JSON on disk at `~/.redline/artifacts/<id>/v<N>-feedback.json`, readable with the `read` tool. Per-version files are the storage of record; the HTTP view merges them.

## Feedback shape

Each thread has `id`, `status` (`open` or `resolved`), `anchor` (`selector`, `text`, `rect`; `null` for general comments), `anchorVersion` (the version the thread was pinned on), `resolvedInVersion` (the version that was current when it was resolved; absent while open), and `messages` (`author`: `user` or `agent`, `kind`: `text` or `thinking`, `body`, `createdAt`). A `thinking` message is a server-synthesized placeholder (shown with a spinner in the UI) waiting for the reviewer lane's answer. Regular messages are immutable.

Threads belong to the artifact, not to a version. The default feedback view always returns every thread, newest first, including threads pinned on older versions. Resolved threads stay readable (collapsed in the review UI, tagged with the version that resolved them). `?version=vN` filters to threads pinned on vN. The user resolves threads, never you.

The view also carries `current`, `artifactStatus` (`draft`, `review`, `iterating`), `agentAttached` (true when a reviewer lane is bound, a worker lane is running, or a feedback long-poll is in flight), plus additive per-lane booleans `reviewerAttached` and `workerRunning`, `iteratedAt`, `approvedAt` (when the current version is signed off), and the version ledger — one row per iteration: `version`, `note`, `publishedAt`, `approvedAt`, `assets` (uploaded image filenames, when the version has any), and `batch` (`threadIds`, `submittedAt`) while it is the frozen work contract. A row with a batch and no `publishedAt` is the pending iteration.
