import { escapeHtml } from "./markup"

// Preset → argv table for the client. Mirrors ACP_PRESETS in
// src/worker/presets.ts; kept literal so the page ships without a build
// step. Custom has no entry, which leaves the command input editable.
const presetArgvSource = `var PRESET_ARGV = {
  "opencode": ["opencode", "acp"],
  "claude-code": ["claude-code-acp"],
  "gemini": ["gemini", "--experimental-acp"],
  "codex": ["codex", "acp"]
}`

// Command string → argv splitter honoring double quotes, e.g.
// "opencode acp" → ["opencode", "acp"]. Exported as source so the page
// script embeds the exact code the tests evaluate.
export const splitCommandSource = `function splitCommand(line) {
  var out = []
  var current = ""
  var quoted = false
  for (var i = 0; i < line.length; i++) {
    var ch = line.charAt(i)
    if (quoted) {
      if (ch === '"') quoted = false
      else current += ch
    } else if (ch === '"') {
      quoted = true
    } else if (ch === " " || ch === "\\t") {
      if (current !== "") { out.push(current); current = "" }
    } else {
      current += ch
    }
  }
  if (current !== "") out.push(current)
  return out
}`

type LaneId = "reviewer" | "worker"

const adapterOptions = (): string =>
  '<option value="acp">ACP</option>' +
  '<option value="opencode-sdk">OpenCode SDK</option>' +
  '<option value="none">None (wait in the agent)</option>'

// Option labels carry the argv so the mapping is visible before saving.
const presetOptions = (): string =>
  '<option value="opencode">OpenCode &middot; opencode acp</option>' +
  '<option value="claude-code">Claude Code &middot; claude-code-acp</option>' +
  '<option value="gemini">Gemini CLI &middot; gemini --experimental-acp</option>' +
  '<option value="codex">Codex &middot; codex acp</option>' +
  '<option value="custom">Custom</option>'

const lanePane = (lane: LaneId): string => {
  const id = escapeHtml(lane)
  const label = escapeHtml(lane === "reviewer" ? "Reviewer" : "Worker")
  return (
    '<section id="pane-' + id + '" role="tabpanel" aria-labelledby="tab-' + id + '">' +
    '<h2>' + label + " lane</h2>" +
    '<div class="field">' +
    '<label for="' + id + '-adapter">Adapter</label>' +
    '<select id="' + id + '-adapter">' + adapterOptions() + "</select>" +
    "</div>" +
    '<div class="field">' +
    '<label for="' + id + '-preset">ACP preset</label>' +
    '<select id="' + id + '-preset">' + presetOptions() + "</select>" +
    "</div>" +
    '<div class="field">' +
    '<label for="' + id + '-command">ACP command</label>' +
    '<input type="text" id="' + id + '-command" value="opencode acp" spellcheck="false" autocomplete="off">' +
    "</div>" +
    '<div class="field">' +
    '<label for="' + id + '-model">Model</label>' +
    '<input type="text" id="' + id + '-model" value="" placeholder="leave empty for the agent default" autocomplete="off" spellcheck="false">' +
    "</div>" +
    '<div class="field">' +
    '<label for="' + id + '-prompt">Template</label>' +
    '<textarea id="' + id + '-prompt" rows="14" spellcheck="false"></textarea>' +
    "</div>" +
    '<div class="actions">' +
    '<button type="button" id="' + id + '-reset">Reset template</button>' +
    '<button type="button" id="' + id + '-test">Test</button>' +
    '<span class="hint" id="' + id + '-hint" hidden></span>' +
    "</div>" +
    "</section>"
  )
}

const clientScript = `(function () {
  "use strict"
  var data = JSON.parse(document.getElementById("redline-data").textContent)
  var toastEl = document.getElementById("toast")
  var LANES = ["reviewer", "worker"]

  ${presetArgvSource}

  ${splitCommandSource}

  function api(path, options) {
    return fetch(data.apiBase + path, options).then(function (response) {
      return response.text().then(function (body) {
        var parsed = null
        try { parsed = body ? JSON.parse(body) : null } catch (error) { parsed = null }
        if (!response.ok) {
          throw new Error((parsed && parsed.detail) || "request failed (" + response.status + ")")
        }
        return parsed
      })
    })
  }

  function jsonMethod(method, body) {
    return { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  }

  function laneEl(lane, suffix) { return document.getElementById(lane + "-" + suffix) }

  // Toasts go through textContent only: settings values are never HTML.
  function toast(message, ok) {
    toastEl.textContent = message
    toastEl.className = ok ? "toast" : "toast error"
  }

  // The Test button only makes sense for ACP; SDK lanes are validated by the
  // save probe and "none" has nothing to validate.
  function updateLaneUi(lane) {
    var adapter = laneEl(lane, "adapter").value
    laneEl(lane, "test").hidden = adapter !== "acp"
    var hint = laneEl(lane, "hint")
    if (adapter === "opencode-sdk") {
      hint.textContent = "OpenCode SDK lanes are validated on save."
      hint.hidden = false
    } else if (adapter === "none") {
      hint.textContent = "None needs no validation."
      hint.hidden = false
    } else {
      hint.hidden = true
    }
  }

  function populate(settings) {
    LANES.forEach(function (lane) {
      var config = settings[lane]
      laneEl(lane, "adapter").value = config.adapter
      laneEl(lane, "preset").value = config.preset
      laneEl(lane, "command").value = config.acpCommand.join(" ")
      laneEl(lane, "model").value = config.model
      laneEl(lane, "prompt").value = settings.prompts[lane]
      updateLaneUi(lane)
    })
    document.getElementById("notify-origin").value = settings.notifyOrigin ? "true" : "false"
    document.getElementById("server-url").value = settings.opencodeServerUrl
  }

  function lanePayload(lane) {
    return {
      adapter: laneEl(lane, "adapter").value,
      preset: laneEl(lane, "preset").value,
      acpCommand: splitCommand(laneEl(lane, "command").value),
      model: laneEl(lane, "model").value
    }
  }

  function savePayload() {
    return {
      reviewer: lanePayload("reviewer"),
      worker: lanePayload("worker"),
      notifyOrigin: document.getElementById("notify-origin").value === "true",
      opencodeServerUrl: document.getElementById("server-url").value.trim(),
      prompts: {
        reviewer: laneEl("reviewer", "prompt").value,
        worker: laneEl("worker", "prompt").value
      }
    }
  }

  var tabs = Array.prototype.slice.call(document.querySelectorAll("[role=tab]"))
  function selectTab(tab) {
    tabs.forEach(function (other) {
      var selected = other === tab
      other.setAttribute("aria-selected", selected ? "true" : "false")
      var pane = document.getElementById(other.getAttribute("aria-controls"))
      if (pane) pane.hidden = !selected
    })
  }
  tabs.forEach(function (tab) {
    tab.addEventListener("click", function () { selectTab(tab) })
  })
  document.querySelector("[role=tablist]").addEventListener("keydown", function (event) {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return
    var current = tabs.filter(function (tab) { return tab.getAttribute("aria-selected") === "true" })[0]
    var index = tabs.indexOf(current)
    var step = event.key === "ArrowRight" ? 1 : tabs.length - 1
    var next = tabs[(index + step) % tabs.length]
    selectTab(next)
    next.focus()
  })

  LANES.forEach(function (lane) {
    laneEl(lane, "adapter").addEventListener("change", function () { updateLaneUi(lane) })
    laneEl(lane, "preset").addEventListener("change", function () {
      // Custom has no mapping: the command stays as the user typed it.
      var argv = PRESET_ARGV[this.value]
      if (argv) laneEl(lane, "command").value = argv.join(" ")
    })
    laneEl(lane, "reset").addEventListener("click", function () {
      api("/settings/defaults").then(function (defaults) {
        laneEl(lane, "prompt").value = defaults.prompts[lane]
        toast("template reset (unsaved \\u2014 hit Save)", true)
      }).catch(function (error) { toast(error.message, false) })
    })
    laneEl(lane, "test").addEventListener("click", function () {
      var command = splitCommand(laneEl(lane, "command").value)
      if (command.length === 0) {
        toast("enter an ACP command first", false)
        return
      }
      toast("probing " + command.join(" ") + " \\u2026", true)
      api("/settings/probe", jsonMethod("POST", { lane: lane, adapter: "acp", acpCommand: command }))
        .then(function () { toast("probe ok", true) })
        .catch(function (error) { toast(error.message, false) })
    })
  })

  document.getElementById("save").addEventListener("click", function () {
    api("/settings", jsonMethod("PUT", savePayload()))
      .then(function () { toast("Saved", true) })
      .catch(function (error) { toast(error.message, false) })
  })

  api("/settings").then(populate).catch(function (error) { toast(error.message, false) })
})()
`

const settingsStyle = `
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  [hidden] { display: none !important }
  body { margin: 0; font: 14px/1.5 system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e8ee }
  header { padding: 20px 28px 14px; border-bottom: 1px solid #262b36 }
  header h1 { margin: 0; font-size: 20px }
  header h1 span { color: #e5484d }
  header .tagline { margin: 6px 0 0; color: #c6cbd6; font-size: 13px }
  header p { margin: 4px 0 0; color: #9aa3b2; font-size: 13px }
  header a { color: #8ab4ff; text-decoration: none }
  header a:hover { text-decoration: underline }
  main { padding: 20px 28px 40px; max-width: 760px }
  .tabs { display: flex; gap: 8px; margin-bottom: 18px }
  .tabs [role=tab] { border-radius: 8px 8px 0 0 }
  .tabs [role=tab][aria-selected=true] { background: #e5484d; border-color: #e5484d; color: #fff; font-weight: 600 }
  section[role=tabpanel] { border: 1px solid #262b36; background: #171a21; border-radius: 10px; padding: 18px 20px }
  section[role=tabpanel] h2 { margin: 0 0 14px; font-size: 15px }
  .field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 14px }
  label { color: #9aa3b2; font-size: 12px }
  select, input[type=text], textarea { background: #0f1115; color: #e6e8ee; border: 1px solid #333b4d; border-radius: 6px; padding: 7px 9px; font: inherit; max-width: 100% }
  textarea { resize: vertical; font-family: ui-monospace, monospace; font-size: 13px }
  select:focus-visible, input:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible { outline: 2px solid #8ab4ff; outline-offset: 2px }
  ::placeholder { color: #6b7487 }
  .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap }
  button { background: #1d2230; color: #e6e8ee; border: 1px solid #333b4d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit }
  button:hover { border-color: #4c5878 }
  button.primary { background: #e5484d; border-color: #e5484d; color: #fff; font-weight: 600 }
  .hint { color: #9aa3b2; font-size: 12px }
  .savebar { display: flex; align-items: center; gap: 12px; margin-top: 18px }
  .toast { color: #46d68c; font-size: 13px; min-height: 1em }
  .toast.error { color: #f5a524 }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important } }
`

export const renderSettingsPage = (): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Settings - redline</title>
<style>${settingsStyle}</style>
</head>
<body>
<header>
  <h1><span>redline</span> &mdash; settings</h1>
  <p class="tagline">agent lanes, prompt templates, and origin notifications</p>
  <p><a href="/">Back to gallery</a></p>
</header>
<main>
  <nav class="tabs" role="tablist" aria-label="Settings sections">
    <button type="button" role="tab" id="tab-reviewer" aria-controls="pane-reviewer" aria-selected="true">Reviewer</button>
    <button type="button" role="tab" id="tab-worker" aria-controls="pane-worker" aria-selected="false" tabindex="-1">Worker</button>
    <button type="button" role="tab" id="tab-notify" aria-controls="pane-notify" aria-selected="false" tabindex="-1">Notify</button>
  </nav>
  ${lanePane("reviewer")}
  ${lanePane("worker")}
  <section id="pane-notify" role="tabpanel" aria-labelledby="tab-notify" hidden>
    <h2>Notify</h2>
    <div class="field">
      <label for="notify-origin">Origin notifications</label>
      <select id="notify-origin">
        <option value="true">Post a one-line status when a duty finishes</option>
        <option value="false">Never post to the origin session</option>
      </select>
    </div>
    <div class="field">
      <label for="server-url">OpenCode server URL</label>
      <input type="text" id="server-url" value="http://127.0.0.1:4096" spellcheck="false" autocomplete="off">
      <p class="hint">Only used when create stored an origin and the lane adapter can notify.</p>
    </div>
  </section>
  <div class="savebar">
    <button type="button" id="save" class="primary">Save</button>
    <span id="toast" class="toast" role="status" aria-live="polite"></span>
  </div>
</main>
<script id="redline-data" type="application/json">{"apiBase":"/api/v1"}</script>
<script>${clientScript}</script>
</body>
</html>
`
