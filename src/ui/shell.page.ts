import { escapeHtml } from "./markup"
import { ArtifactVersion } from "../store/artifact.models"

export type ShellData = {
  artifactId: string
  title: string
  prompt: string
  status: string
  current: string
  versions: ArtifactVersion[]
  apiBase: string
}

export const clientScript = `(function () {
  "use strict"
  var data = JSON.parse(document.getElementById("redline-data").textContent)
  var frame = document.getElementById("frame")
  var overlay = document.getElementById("overlay")
  var threadsEl = document.getElementById("threads")
  var composerEl = document.getElementById("composer")
  var composerBody = document.getElementById("composer-body")
  var composerTarget = document.getElementById("composer-target")
  var versionSelect = document.getElementById("version")
  var statusEl = document.getElementById("status")
  var presenceEl = document.getElementById("presence")
  var presenceLabel = document.getElementById("presence-label")
  var bannerEl = document.getElementById("banner")
  var iterateBtn = document.getElementById("iterate")
  var approveBtn = document.getElementById("approve")
  var dingBox = document.getElementById("ding")
  var pinBtn = document.getElementById("pin-mode")
  var generalBtn = document.getElementById("general-btn")
  var state = {
    version: data.current,
    current: data.current,
    status: data.status,
    attached: false,
    reviewerAttached: false,
    workerRunning: false,
    threads: [],
    versions: data.versions,
    pinMode: false,
    anchor: null,
    snapshot: "",
    expanded: {},
    followCurrent: true,
    selectSnapshot: ""
  }

  function api(path, options) {
    return fetch(data.apiBase + path, options).then(function (response) {
      if (!response.ok) {
        return response.text().then(function (body) {
          throw new Error("request failed (" + response.status + "): " + body)
        })
      }
      return response.json()
    })
  }

  function jsonMethod(method, body) {
    return { method: method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }
  }

  var dingOn = true
  try { dingOn = localStorage.getItem("redline.ding") !== "off" } catch (e) {}
  dingBox.checked = dingOn
  dingBox.addEventListener("change", function () {
    dingOn = dingBox.checked
    try { localStorage.setItem("redline.ding", dingOn ? "on" : "off") } catch (e) {}
  })

  function playDing() {
    if (!dingOn) return
    var AudioCtor = window.AudioContext || window.webkitAudioContext
    if (!AudioCtor) return
    try {
      if (!playDing.ctx) playDing.ctx = new AudioCtor()
      var ctx = playDing.ctx
      if (ctx.state === "suspended") ctx.resume()
      var now = ctx.currentTime
      ;[[880, 0], [1174.66, 0.13]].forEach(function (part) {
        var osc = ctx.createOscillator()
        var gain = ctx.createGain()
        osc.type = "sine"
        osc.frequency.value = part[0]
        var start = now + part[1]
        gain.gain.setValueAtTime(0.0001, start)
        gain.gain.exponentialRampToValueAtTime(0.2, start + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.45)
        osc.connect(gain)
        gain.connect(ctx.destination)
        osc.start(start)
        osc.stop(start + 0.5)
      })
    } catch (e) {}
  }

  function maybeDing(prevStatus) {
    if (prevStatus === "iterating" && state.status === "review") playDing()
  }

  function feedbackUrl() {
    return "/artifacts/" + data.artifactId + "/feedback"
  }

  function pendingVersion() {
    for (var i = 0; i < state.versions.length; i++) {
      var entry = state.versions[i]
      if (entry.batch && !entry.publishedAt) return entry
    }
    return null
  }

  function currentApprovedAt() {
    for (var i = 0; i < state.versions.length; i++) {
      if (state.versions[i].version === state.current) return state.versions[i].approvedAt
    }
    return undefined
  }

  function refresh() {
    return api(feedbackUrl()).then(function (view) {
      var prevStatus = state.status
      state.threads = view.threads
      state.status = view.artifactStatus
      state.attached = view.agentAttached === true
      state.reviewerAttached = view.reviewerAttached === true
      state.workerRunning = view.workerRunning === true
      state.current = view.current
      state.versions = view.versions
      maybeDing(prevStatus)
      // Auto-follow: when a new version is published, load it — unless the
      // user deliberately switched to an older version.
      if (state.followCurrent && state.status === "review" && state.current !== state.version) {
        switchPreview(state.current)
      }
      render()
    })
  }

  function numberedThreads() {
    var out = []
    var n = 0
    state.threads.forEach(function (thread) {
      if (thread.status !== "open" || !thread.anchor || !thread.anchor.rect) return
      // Pins are placed on the version they were pinned on; skip them when a
      // different version is in the preview.
      if (thread.anchorVersion && thread.anchorVersion !== state.version) return
      n += 1
      out.push({ thread: thread, number: n })
    })
    return out
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined && text !== null) node.textContent = text
    return node
  }

  function render() {
    initVersionSelect()
    renderHeader()
    renderThreads()
    renderPins()
  }

  function renderHeader() {
    var iterating = state.status === "iterating"
    var review = state.status === "review"
    var approved = review && currentApprovedAt() !== undefined
    statusEl.textContent = approved ? "approved" : iterating ? "iterating" : review ? "in review" : "draft"
    statusEl.className = "pill " + (approved ? "approved" : state.status)
    presenceEl.className = "presence " + (iterating ? "working" : state.attached ? "on" : "off")
    presenceLabel.textContent = state.workerRunning
      ? "worker running"
      : iterating
        ? "agent working"
        : state.reviewerAttached
          ? "reviewer attached"
          : state.attached
            ? "waiting in agent"
            : "no agent"
    iterateBtn.disabled = !review || !state.attached
    iterateBtn.title = iterating
      ? "Agent is already iterating"
      : review && !state.attached
        ? "Agent not attached - nudge it in chat, then Iterate"
        : "Send open threads to the agent as one batch"
    approveBtn.disabled = !review || approved
    approveBtn.textContent = approved ? "Approved" : "Approve"
    approveBtn.title = approved
      ? state.current + " approved \\u2014 done for now (Iterate to continue)"
      : review
        ? "Done for now: approve " + state.current + " (always iterable later)"
        : "Finish the iterating round first"
    generalBtn.disabled = !review
    pinBtn.disabled = !review || state.pinMode
    if (!review && state.pinMode) setPinMode(false)
    var pending = pendingVersion()
    if (iterating && pending) {
      var count = pending.batch && pending.batch.threadIds ? pending.batch.threadIds.length : 0
      bannerEl.textContent =
        "Agent is iterating \\u2192 " + pending.version + " (" + String(count) + " thread" + (count === 1 ? "" : "s") + " in batch). Replies still reach it after this round."
      bannerEl.hidden = false
    } else {
      bannerEl.hidden = true
    }
  }

  function renderThreads() {
    var numbered = numberedThreads()
    var numbers = {}
    numbered.forEach(function (entry) { numbers[entry.thread.id] = entry.number })
    threadsEl.textContent = ""
    var open = state.threads.filter(function (t) { return t.status === "open" })
    var resolved = state.threads.filter(function (t) { return t.status === "resolved" })
    threadsEl.appendChild(el("div", "section-title", "Open (" + open.length + ")"))
    open.forEach(function (thread) { threadsEl.appendChild(threadCard(thread, numbers[thread.id])) })
    if (resolved.length > 0) {
      threadsEl.appendChild(el("div", "section-title dim", "Resolved (" + resolved.length + ")"))
      resolved.forEach(function (thread) { threadsEl.appendChild(threadCard(thread, numbers[thread.id])) })
    }
  }

  function switchPreview(version) {
    state.version = version
    versionSelect.value = version
    frame.src = "/a/" + data.artifactId + "/" + version + "/index.html"
  }

  function headChips(thread) {
    var wrap = el("div", "head-chips")
    if (thread.anchorVersion && thread.anchorVersion !== state.version) {
      var pinned = el("span", "chip pinned", "pinned on " + thread.anchorVersion)
      pinned.title = "Show " + thread.anchorVersion + " to see this pin"
      pinned.addEventListener("click", function (event) {
        event.stopPropagation()
        switchPreview(thread.anchorVersion)
      })
      wrap.appendChild(pinned)
    }
    if (thread.status === "resolved") {
      wrap.appendChild(el("span", "chip resolved-chip", "resolved in " + (thread.resolvedInVersion || "earlier version")))
      wrap.appendChild(el("span", "chevron", state.expanded[thread.id] ? "\\u25be" : "\\u25b8"))
    }
    return wrap
  }

  function messageRow(message) {
    var row = el("div", "message")
    row.appendChild(el("span", "author " + message.author, message.author))
    if (message.kind === "thinking") {
      row.appendChild(el("span", "spinner"))
      row.appendChild(el("span", "body thinking-text", "thinking\\u2026"))
    } else {
      row.appendChild(el("span", "body", message.body))
    }
    return row
  }

  function threadCard(thread, number) {
    var resolved = thread.status === "resolved"
    var collapsed = resolved && !state.expanded[thread.id]
    var review = state.status === "review"
    var card = el("div", "thread" + (resolved ? " resolved" : "") + (collapsed ? " collapsed" : ""))
    card.dataset.threadId = thread.id
    var head = el("div", "thread-head")
    if (number) head.appendChild(el("span", "badge", String(number)))
    head.appendChild(el("span", "thread-target", thread.anchor ? thread.anchor.text || "Pinned comment" : "General comment"))
    head.appendChild(headChips(thread))
    card.appendChild(head)
    var body = el("div", "thread-body")
    thread.messages.forEach(function (message) { body.appendChild(messageRow(message)) })
    var actions = el("div", "thread-actions")
    var replyInput = document.createElement("input")
    replyInput.type = "text"
    replyInput.placeholder = "Reply..."
    replyInput.className = "reply"
    actions.appendChild(replyInput)
    var replyBtn = el("button", "small", "Reply")
    replyBtn.addEventListener("click", function () {
      var text = replyInput.value.trim()
      if (!text) return
      api("/artifacts/" + data.artifactId + "/threads/" + thread.id + "/messages", jsonMethod("POST", { body: text, author: "user" })).then(refresh)
    })
    actions.appendChild(replyBtn)
    if (review) {
      var toggleBtn = el("button", "small", thread.status === "open" ? "Resolve" : "Reopen")
      toggleBtn.addEventListener("click", function () {
        var next = thread.status === "open" ? "resolved" : "open"
        api("/artifacts/" + data.artifactId + "/threads/" + thread.id, jsonMethod("PATCH", { status: next })).then(refresh)
      })
      actions.appendChild(toggleBtn)
    }
    body.appendChild(actions)
    card.appendChild(body)
    head.addEventListener("click", function () {
      if (resolved) {
        state.expanded[thread.id] = !state.expanded[thread.id]
        render()
        return
      }
      flashAnchor(thread)
      focusSidebarCard(thread.id)
    })
    return card
  }

  function renderPins() {
    overlay.textContent = ""
    var doc = frame.contentDocument
    if (!doc || !doc.body) return
    var win = frame.contentWindow
    numberedThreads().forEach(function (entry) {
      var rect = entry.thread.anchor.rect
      var pin = el("div", "pin", String(entry.number))
      pin.style.left = (rect.x - win.scrollX) + "px"
      pin.style.top = (rect.y - win.scrollY) + "px"
      pin.title = entry.thread.anchor.text || "Comment"
      pin.addEventListener("click", function (event) {
        event.stopPropagation()
        flashAnchor(entry.thread)
        focusSidebarCard(entry.thread.id)
      })
      overlay.appendChild(pin)
    })
  }

  function flashAnchor(thread) {
    var doc = frame.contentDocument
    if (!doc || !thread.anchor) return
    var target = doc.querySelector(thread.anchor.selector)
    if (!target) return
    target.scrollIntoView({ block: "center", behavior: "smooth" })
    target.classList.add("redline-flash")
    setTimeout(function () { target.classList.remove("redline-flash") }, 1600)
  }

  function focusSidebarCard(threadId) {
    var card = threadsEl.querySelector('[data-thread-id="' + threadId + '"]')
    if (!card) return
    card.classList.add("active")
    card.scrollIntoView({ block: "nearest" })
    setTimeout(function () { card.classList.remove("active") }, 1600)
  }

  function buildSelector(doc, element) {
    if (element.id) return "#" + CSS.escape(element.id)
    var parts = []
    var node = element
    while (node && node.nodeType === 1 && node !== doc.documentElement) {
      if (node.id) {
        parts.unshift("#" + CSS.escape(node.id))
        break
      }
      var segment = node.tagName.toLowerCase()
      var parent = node.parentElement
      if (parent) {
        var sameKind = Array.prototype.filter.call(parent.children, function (child) {
          return child.tagName === node.tagName
        })
        if (sameKind.length > 1) segment += ":nth-of-type(" + (sameKind.indexOf(node) + 1) + ")"
      }
      parts.unshift(segment)
      node = parent
    }
    return parts.join(" ")
  }

  function openComposer(anchor, targetLabel) {
    state.anchor = anchor
    composerTarget.textContent = targetLabel
    composerEl.hidden = false
    composerBody.value = ""
    composerBody.focus()
  }

  function closeComposer() {
    composerEl.hidden = true
    state.anchor = null
  }

  function setPinMode(enabled) {
    state.pinMode = enabled
    pinBtn.classList.toggle("active", enabled)
    overlay.classList.toggle("armed", enabled)
    pinBtn.textContent = enabled ? "Click an element..." : "+ Comment"
  }

  pinBtn.addEventListener("click", function () { if (!pinBtn.disabled) setPinMode(!state.pinMode) })

  overlay.addEventListener("click", function (event) {
    if (!state.pinMode) return
    event.preventDefault()
    var doc = frame.contentDocument
    if (!doc || !doc.body) return
    var frameRect = frame.getBoundingClientRect()
    var element = doc.elementFromPoint(event.clientX - frameRect.left, event.clientY - frameRect.top)
    if (!element) return
    var rect = element.getBoundingClientRect()
    var anchor = {
      selector: buildSelector(doc, element),
      text: (element.textContent || "").trim().slice(0, 120),
      rect: {
        x: rect.x + frame.contentWindow.scrollX,
        y: rect.y + frame.contentWindow.scrollY,
        width: rect.width,
        height: rect.height,
      },
    }
    setPinMode(false)
    openComposer(anchor, anchor.text ? "on: " + anchor.text : "on: " + anchor.selector)
  })

  generalBtn.addEventListener("click", function () {
    openComposer(null, "general comment (not pinned to an element)")
  })

  document.getElementById("composer-cancel").addEventListener("click", closeComposer)

  document.getElementById("composer-save").addEventListener("click", function () {
    var body = composerBody.value.trim()
    if (!body || state.anchor === undefined) return
    api("/artifacts/" + data.artifactId + "/feedback", jsonMethod("POST", {
      version: state.version,
      anchor: state.anchor,
      body: body,
      author: "user",
    })).then(function () {
      closeComposer()
      refresh()
    })
  })

  iterateBtn.addEventListener("click", function () {
    if (iterateBtn.disabled) return
    iterateBtn.disabled = true
    api("/artifacts/" + data.artifactId + "/iterations", jsonMethod("POST", {})).then(function () {
      state.followCurrent = true
      refresh()
    })
  })

  approveBtn.addEventListener("click", function () {
    if (approveBtn.disabled) return
    api("/artifacts/" + data.artifactId + "/versions/" + state.current + "/approve", jsonMethod("POST", {})).then(refresh)
  })

  function initVersionSelect() {
    var sig = JSON.stringify(state.versions.map(function (entry) {
      return [entry.version, entry.note || "", entry.approvedAt || "", entry.publishedAt || ""]
    }))
    if (sig === state.selectSnapshot) return
    state.selectSnapshot = sig
    versionSelect.textContent = ""
    state.versions.forEach(function (entry) {
      var option = document.createElement("option")
      option.value = entry.version
      var bits = [entry.version]
      if (entry.note) bits.push(entry.note)
      if (entry.approvedAt) bits.push("approved")
      if (entry.batch && !entry.publishedAt) bits.push("awaiting agent")
      option.textContent = bits.join(" \\u00b7 ")
      if (entry.version === state.version) option.selected = true
      versionSelect.appendChild(option)
    })
  }

  versionSelect.addEventListener("change", function () {
    // Manual switches stop auto-follow: the user chose to read an older
    // version and should not be yanked forward on publish.
    state.followCurrent = false
    state.version = versionSelect.value
    frame.src = "/a/" + data.artifactId + "/" + state.version + "/index.html"
    render()
  })

  frame.addEventListener("load", function () {
    var doc = frame.contentDocument
    if (!doc) return
    var style = doc.createElement("style")
    style.textContent = ".redline-flash { outline: 3px solid #e5484d !important; outline-offset: 2px; }"
    doc.head.appendChild(style)
    frame.contentWindow.addEventListener("scroll", renderPins, true)
    frame.contentWindow.addEventListener("resize", renderPins)
    renderPins()
  })

  setInterval(function () {
    if (!composerEl.hidden) return
    api(feedbackUrl()).then(function (view) {
      var prevStatus = state.status
      var snapshot = JSON.stringify([
        view.artifactStatus,
        view.current,
        view.agentAttached,
        view.reviewerAttached,
        view.workerRunning,
        view.threads,
        view.versions
      ])
      if (snapshot === state.snapshot) return
      state.snapshot = snapshot
      state.threads = view.threads
      state.status = view.artifactStatus
      state.attached = view.agentAttached === true
      state.reviewerAttached = view.reviewerAttached === true
      state.workerRunning = view.workerRunning === true
      state.current = view.current
      state.versions = view.versions
      maybeDing(prevStatus)
      if (state.followCurrent && state.status === "review" && state.current !== state.version) {
        switchPreview(state.current)
      }
      render()
    })
  }, 5000)

  frame.src = "/a/" + data.artifactId + "/" + state.version + "/index.html"
  refresh()
})()
`

const shellStyle = `
  :root { color-scheme: dark }
  * { box-sizing: border-box }
  body { margin: 0; font: 14px/1.45 system-ui, -apple-system, sans-serif; background: #0f1115; color: #e6e8ee; height: 100vh; display: flex; flex-direction: column }
  header { display: flex; align-items: center; gap: 12px; padding: 8px 14px; border-bottom: 1px solid #262b36; background: #14171e }
  .brand { color: #e5484d; font-weight: 700; text-decoration: none }
  #title { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 28vw }
  .pill { padding: 2px 10px; border-radius: 999px; font-size: 12px; border: 1px solid; white-space: nowrap }
  .pill.review { color: #f5a524; border-color: #6b5320; background: rgba(245, 165, 36, .08) }
  .pill.iterating { color: #f5a524; border-color: #6b5320; background: rgba(245, 165, 36, .08) }
  .pill.approved { color: #46d68c; border-color: #2a5c40; background: rgba(70, 214, 140, .08) }
  .pill.draft { color: #9aa3b2; border-color: #3a4152; background: rgba(154, 163, 178, .08) }
  .presence { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; border: 1px solid #3a4152; border-radius: 999px; padding: 2px 10px; color: #9aa3b2; white-space: nowrap }
  .presence .dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7487 }
  .presence.on { color: #46d68c; border-color: #2a5c40 }
  .presence.on .dot { background: #46d68c }
  .presence.working { color: #f5a524; border-color: #6b5320 }
  .presence.working .dot { background: #f5a524; animation: pulse 1s ease-in-out infinite }
  @keyframes pulse { 50% { opacity: .35 } }
  button { background: #1d2230; color: #e6e8ee; border: 1px solid #333b4d; border-radius: 6px; padding: 6px 12px; cursor: pointer; font: inherit }
  button:hover { border-color: #4c5878 }
  button.active { background: #e5484d; border-color: #e5484d; color: #fff }
  button[disabled] { opacity: .4; cursor: not-allowed }
  #iterate { background: #e5484d; border-color: #e5484d; color: #fff; font-weight: 600 }
  #iterate[disabled] { background: #1d2230; border-color: #333b4d; color: #9aa3b2 }
  #approve { border-color: #2a5c40; color: #46d68c }
  .spacer { flex: 1 }
  #banner { border-bottom: 1px solid #6b5320; background: rgba(245, 165, 36, .08); color: #f5a524; padding: 6px 14px; font-size: 13px }
  #banner[hidden] { display: none }
  main { flex: 1; display: flex; min-height: 0 }
  #stage { flex: 1; position: relative; background: #fff }
  #frame { width: 100%; height: 100%; border: 0; display: block }
  #overlay { position: absolute; inset: 0; pointer-events: none }
  #overlay.armed { pointer-events: auto; cursor: crosshair; background: rgba(229, 72, 77, .06) }
  .pin { position: absolute; width: 24px; height: 24px; border-radius: 50%; background: #e5484d; color: #fff; font-size: 12px; font-weight: 700; display: flex; align-items: center; justify-content: center; transform: translate(-50%, -50%); cursor: pointer; box-shadow: 0 2px 6px rgba(0, 0, 0, .35); pointer-events: auto }
  #sidebar { width: 360px; border-left: 1px solid #262b36; background: #14171e; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px }
  .hint { color: #9aa3b2; font-size: 12px }
  #composer { border: 1px solid #333b4d; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: #191d27 }
  #composer[hidden] { display: none }
  #composer-target { color: #f5a524; font-size: 12px; word-break: break-all }
  textarea { min-height: 64px; resize: vertical; background: #0f1115; color: #e6e8ee; border: 1px solid #333b4d; border-radius: 6px; padding: 8px; font: inherit }
  .composer-actions { display: flex; gap: 8px; justify-content: flex-end }
  .composer-actions button.primary { background: #e5484d; border-color: #e5484d; color: #fff }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #9aa3b2; margin-top: 6px }
  .section-title.dim { opacity: .7 }
  .thread { border: 1px solid #262b36; border-radius: 8px; padding: 10px; display: flex; flex-direction: column; gap: 6px; background: #171a21 }
  .thread.resolved { opacity: .55 }
  .thread.active { border-color: #e5484d }
  .thread-head { display: flex; gap: 8px; align-items: center; cursor: pointer; min-width: 0 }
  .head-chips { margin-left: auto; display: flex; align-items: center; gap: 6px; flex-shrink: 0 }
  .chip { font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid; white-space: nowrap }
  .chip.pinned { color: #f5a524; border-color: #6b5320; cursor: pointer }
  .chip.pinned:hover { background: rgba(245, 165, 36, .12) }
  .chip.resolved-chip { color: #46d68c; border-color: #2a5c40 }
  .chevron { color: #9aa3b2; font-size: 11px }
  .thread.collapsed .thread-body { display: none }
  .badge { background: #e5484d; color: #fff; border-radius: 999px; min-width: 20px; height: 20px; display: inline-flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700; flex-shrink: 0 }
  .thread-target { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
  .message { display: flex; gap: 8px; font-size: 13px; align-items: baseline }
  .message .spinner { align-self: center }
  .author { font-size: 11px; padding: 1px 6px; border-radius: 4px; border: 1px solid; height: fit-content; flex-shrink: 0 }
  .author.user { color: #8ab4ff; border-color: #34437a }
  .author.agent { color: #46d68c; border-color: #2a5c40 }
  .body { white-space: pre-wrap; word-break: break-word }
  .thinking-text { color: #6b7487; font-style: italic }
  .spinner { width: 12px; height: 12px; border: 2px solid #333b4d; border-top-color: #46d68c; border-radius: 50%; animation: spin .8s linear infinite; flex-shrink: 0 }
  @keyframes spin { to { transform: rotate(360deg) } }
  .thread-actions { display: flex; gap: 6px; margin-top: 2px }
  .reply { flex: 1; background: #0f1115; border: 1px solid #333b4d; border-radius: 6px; color: #e6e8ee; padding: 5px 8px; font: inherit; min-width: 0 }
  button.small { padding: 4px 8px; font-size: 12px }
  select { background: #1d2230; color: #e6e8ee; border: 1px solid #333b4d; border-radius: 6px; padding: 5px 8px; font: inherit; max-width: 220px }
  label { color: #9aa3b2; font-size: 12px; display: flex; align-items: center; gap: 6px }
  #ding { accent-color: #e5484d; cursor: pointer; margin: 0 }
  .brief { border: 1px solid #262b36; border-radius: 8px; padding: 8px 10px; font-size: 12px; color: #9aa3b2 }
  .brief summary { cursor: pointer; color: #c6cbd6 }
  .brief p { margin: 8px 0 0; white-space: pre-wrap }
`

export const renderShellPage = (data: ShellData): string => {
  const dataJson = JSON.stringify(data).replaceAll("<", "\\u003c")
  const title = escapeHtml(data.title)
  const approvedAt = data.versions.find((entry) => entry.version === data.current)?.approvedAt
  const statusPill = approvedAt !== undefined
    ? '<span id="status" class="pill approved">approved</span>'
    : data.status === "iterating"
      ? '<span id="status" class="pill iterating">iterating</span>'
      : data.status === "review"
        ? '<span id="status" class="pill review">in review</span>'
        : '<span id="status" class="pill draft">draft</span>'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - redline</title>
<style>${shellStyle}</style>
</head>
<body>
<header>
  <a class="brand" href="/">redline</a>
  <span id="title">${title}</span>
  ${statusPill}
  <span id="presence" class="presence off"><span class="dot"></span><span id="presence-label">checking&hellip;</span></span>
  <label>Version <select id="version"></select></label>
  <label><input type="checkbox" id="ding"> ding when done</label>
  <span class="spacer"></span>
  <button id="general-btn">General</button>
  <button id="pin-mode">+ Comment</button>
  <button id="iterate">Iterate</button>
  <button id="approve">Approve</button>
</header>
<div id="banner" hidden></div>
<main>
  <section id="stage">
    <iframe id="frame" title="artifact"></iframe>
    <div id="overlay"></div>
  </section>
  <aside id="sidebar">
    ${data.prompt.length > 0 ? '<details class="brief"><summary>Brief</summary><p>' + escapeHtml(data.prompt) + "</p></details>" : ""}
    <div class="hint">Comment on anything &mdash; the agent answers live in the thread. Hit <b>Iterate</b> to send the batch: the agent rewrites the artifact and publishes the next version. <b>Approve</b> just means done for now.</div>
    <div id="composer" hidden>
      <div id="composer-target"></div>
      <textarea id="composer-body" placeholder="What should change?"></textarea>
      <div class="composer-actions">
        <button id="composer-cancel">Cancel</button>
        <button id="composer-save" class="primary">Save</button>
      </div>
    </div>
    <div id="threads"></div>
  </aside>
</main>
<script id="redline-data" type="application/json">${dataJson}</script>
<script>${clientScript}</script>
</body>
</html>
`
}
