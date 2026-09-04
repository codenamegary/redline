import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { Plugin, tool } from "@opencode-ai/plugin"
import { z } from "zod"

import {
  asResponseSummary,
  buildCreateResponseText,
  buildUpdateResponseText,
} from "../agent.response"

// opencode plugin for the redline review server. Mirrors src/pi/redline.extension.ts:
// same five tool names, same HTTP API (see skills/redline/SKILL.md). The review loop is
// turn-based: comments wake the agent for replies only; the user's Iterate action
// freezes open threads into a batch and wakes the agent for work (publishing is
// 409-gated server-side); approval is a version stamp meaning "done for now". The
// server daemon is lazily bootstrapped on first use: the app is found or cloned into
// ~/.redline/app, dependencies are installed via install.sh, and the daemon is
// started and rediscovered via ~/.redline/server.json.

const repoUrl = process.env.REDLINE_REPO ?? "https://github.com/codenamegary/redline.git"

const packageRoot = (): string => {
  if (process.env.REDLINE_PACKAGE_ROOT !== undefined) return process.env.REDLINE_PACKAGE_ROOT
  // The canonical copy of this file lives in <repo>/src/opencode/.
  const candidate = dirname(dirname(fileURLToPath(import.meta.url)))
  if (existsSync(join(candidate, "src", "main.ts"))) return candidate
  return appRoot()
}

const homeDir = (): string => process.env.REDLINE_HOME ?? join(homedir(), ".redline")

const appRoot = (): string => join(homeDir(), "app")

const looksLikeApp = (dir: string): boolean =>
  existsSync(join(dir, "src", "main.ts")) && existsSync(join(dir, "install.sh"))

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const ServerInfoSchema = z.object({ host: z.string(), port: z.number().int() })

type ServerInfo = z.infer<typeof ServerInfoSchema>

const SummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  current: z.string(),
  versionCount: z.number(),
  openThreads: z.number(),
  reviewUrl: z.string(),
  reviewer: z.enum(["none", "starting", "idle"]).optional(),
})

type Summary = z.infer<typeof SummarySchema>

const ThreadSchema = z.object({
  id: z.string(),
  status: z.string(),
  anchor: z
    .object({ selector: z.string(), text: z.string() })
    .nullable(),
  anchorVersion: z.string().optional(),
  resolvedInVersion: z.string().optional(),
  messages: z.array(z.object({ author: z.string(), kind: z.string().optional(), body: z.string() })),
})

type Thread = z.infer<typeof ThreadSchema>

const VersionRowSchema = z.object({
  version: z.string(),
  note: z.string().optional(),
  publishedAt: z.string().optional(),
  approvedAt: z.string().optional(),
  batch: z
    .object({ threadIds: z.array(z.string()), submittedAt: z.string() })
    .optional(),
})

type VersionRow = z.infer<typeof VersionRowSchema>

const epoch = "1970-01-01T00:00:00.000Z"

const maxIso = (values: string[]): string => values.reduce((latest, value) => (value > latest ? value : latest))

const pendingRow = (view: FeedbackView): VersionRow | undefined =>
  view.versions.find((row) => row.batch !== undefined && row.publishedAt === undefined)

const FeedbackViewSchema = z.object({
  version: z.string(),
  current: z.string(),
  updatedAt: z.string(),
  iteratedAt: z.string(),
  threads: z.array(ThreadSchema),
  artifactStatus: z.string(),
  artifactUpdatedAt: z.string(),
  approvedAt: z.string().optional(),
  agentAttached: z.boolean().optional(),
  versions: z.array(VersionRowSchema),
})

type FeedbackView = z.infer<typeof FeedbackViewSchema>

const ProblemSchema = z.object({ title: z.string(), detail: z.string().optional() })

const readServerInfo = async (): Promise<ServerInfo | undefined> => {
  try {
    const raw = await readFile(join(homeDir(), "server.json"), "utf8")
    const parsed: unknown = JSON.parse(raw)
    const result = ServerInfoSchema.safeParse(parsed)
    return result.success ? result.data : undefined
  } catch {
    return undefined
  }
}

const baseUrlFor = (info: ServerInfo | undefined): string => {
  const rawHost = info?.host === "0.0.0.0" ? "127.0.0.1" : info?.host
  return "http://" + (rawHost ?? "127.0.0.1") + ":" + String(info?.port ?? 4739)
}

const probe = async (base: string): Promise<boolean> => {
  try {
    const response = await fetch(base + "/api/v1/health", { signal: AbortSignal.timeout(600) })
    return response.ok
  } catch {
    return false
  }
}

const commandExists = (command: string): Promise<boolean> =>
  new Promise((resolve) => {
    const check = spawn(command, ["--version"], { stdio: "ignore" })
    check.on("error", () => resolve(false))
    check.on("close", (code) => resolve(code === 0))
  })

const runCommand = (command: string, args: string[], cwd: string, timeoutMs = 600000): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(command, args, { cwd: cwd, timeout: timeoutMs, encoding: "utf8" }, (error, _stdout, stderr) => {
      if (error === null) {
        resolve()
        return
      }
      const tail = String(stderr ?? "")
        .split("\n")
        .filter((line: string) => line.length > 0)
        .slice(-4)
        .join("\n")
      reject(new Error(command + " " + args.join(" ") + " failed: " + (tail.length > 0 ? tail : error.message)))
    })
  })

const ensureApp = async (): Promise<string> => {
  if (looksLikeApp(packageRoot())) return packageRoot()
  const target = appRoot()
  if (looksLikeApp(target)) return target
  await mkdir(dirname(target), { recursive: true })
  await runCommand("git", ["clone", "--depth", "1", repoUrl, target], dirname(target))
  if (!looksLikeApp(target)) {
    throw new Error("redline bootstrap failed: " + target + " has no src/main.ts after clone")
  }
  return target
}

const spawnDaemon = async (root: string): Promise<void> => {
  const mainScript = join(root, "src", "main.ts")
  const hasBun = await commandExists("bun")
  const child = hasBun
    ? spawn("bun", ["run", mainScript, "serve"], {
        cwd: root,
        env: process.env,
        stdio: "ignore",
        detached: true,
      })
    : spawn("npx", ["-y", "tsx", mainScript, "serve"], {
        cwd: root,
        env: process.env,
        stdio: "ignore",
        detached: true,
      })
  child.unref()
}

const pollUntilReady = async (base: string, attemptsLeft: number): Promise<string> => {
  if (await probe(base)) return base
  if (attemptsLeft <= 0) throw new Error("redline daemon did not become ready at " + base)
  await sleep(500)
  return pollUntilReady(base, attemptsLeft - 1)
}

let daemonReady: string | undefined

const ensureDaemon = async (): Promise<string> => {
  if (daemonReady !== undefined && (await probe(daemonReady))) return daemonReady

  const root = await ensureApp()
  const installer = join(root, "install.sh")
  if (existsSync(installer)) {
    await runCommand("bash", [installer, "--ensure-daemon"], root, 300000)
  } else {
    const base = baseUrlFor(await readServerInfo())
    if (!(await probe(base))) await spawnDaemon(root)
  }
  const base = baseUrlFor(await readServerInfo())
  daemonReady = await pollUntilReady(base, 120)
  return daemonReady
}

const parseBody = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const requestJson = async (base: string, path: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(base + path, init)
  const text = await response.text()
  if (!response.ok) {
    const problem = ProblemSchema.safeParse(parseBody(text))
    const detail = problem.success
      ? problem.data.detail ?? problem.data.title
      : text.slice(0, 300)
    throw new Error("redline request failed (" + String(response.status) + "): " + detail)
  }
  return parseBody(text)
}

const renderThreads = (view: FeedbackView): string => {
  if (view.threads.length === 0) return "No feedback threads yet."
  return view.threads
    .map((thread: Thread, index: number) => {
      const target =
        thread.anchor === null
          ? "general"
          : thread.anchor.text.length > 0
            ? thread.anchor.text.slice(0, 60)
            : thread.anchor.selector
      const last = thread.messages[thread.messages.length - 1]
      const extra =
        thread.messages.length > 1
          ? " (+" + String(thread.messages.length - 1) + " earlier message(s))"
          : ""
      const thinking = last?.kind === "thinking" ? " [agent thinking \u2014 replace this placeholder]" : ""
      const tags: string[] = []
      if (thread.anchorVersion !== undefined) tags.push("pinned on " + thread.anchorVersion)
      if (thread.status === "resolved" && thread.resolvedInVersion !== undefined) {
        tags.push("resolved in " + thread.resolvedInVersion)
      }
      const tagText = tags.length > 0 ? " (" + tags.join(", ") + ")" : ""
      return (
        String(index + 1) +
        ". [" +
        thread.status +
        "]" +
        tagText +
        " " +
        target +
        ": " +
        (last?.body ?? "") +
        thinking +
        extra
      )
    })
    .join("\n")
}

const workDutyText = (view: FeedbackView, artifactId: string): string => {
  const pending = pendingRow(view)
  const count = pending?.batch?.threadIds.length ?? 0
  return (
    "WORK DUTY on " +
    artifactId +
    ": iteration " +
    (pending?.version ?? view.current) +
    " was submitted with " +
    String(count) +
    " thread(s) in the frozen batch:\n" +
    renderThreads(view) +
    "\nAddress the batch, then publish with update_artifact (note = what changed). Publishing returns the artifact to review. Meanwhile you may reply in threads."
  )
}

const replyDutyText = (view: FeedbackView, artifactId: string): string => {
  const open = view.threads.filter((thread: Thread) => thread.status === "open").length
  return (
    "REPLY DUTY on " +
    artifactId +
    " (" +
    view.current +
    ", status " +
    view.artifactStatus +
    ", " +
    String(open) +
    " open):\n" +
    renderThreads(view) +
    "\nConversation only: replace thinking placeholders via PATCH or post replies. update_artifact is rejected (409) until the user hits Iterate."
  )
}

const jsonInit = (method: string, body: unknown, signal?: AbortSignal): RequestInit => ({
  method: method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
  signal: signal,
})

export const RedlinePlugin: Plugin = async () => {
  return {
    tool: {
      create_artifact: tool({
        description:
          "Create a redline design artifact (architecture doc, decision record, API contract, diagram, UI mockup, any self-contained HTML) and open it for human review. Returns the review URL to share with the user.",
        args: {
          title: tool.schema.string().describe("Short human-readable title"),
          prompt: tool.schema.string().optional().describe("Original instruction or brief this artifact answers"),
          note: tool.schema.string().optional().describe("Note recorded on the first version"),
          html: tool.schema
            .string()
            .describe(
              "Complete self-contained HTML document: inline CSS and JS, inline SVG diagrams, no external requests",
            ),
        },
        async execute(params, ctx) {
          const base = await ensureDaemon()
          const body = await requestJson(
            base,
            "/api/v1/artifacts",
            jsonInit("POST", {
              title: params.title,
              prompt: params.prompt ?? "",
              note: params.note,
              html: params.html,
              // Origin capture for server-side notify pings. The tool
              // context has no opencode server URL, so only the session id
              // travels; the redline server resolves the URL itself.
              origin: { host: "opencode", sessionId: ctx.sessionID },
            }),
          )
          const summary = SummarySchema.parse(body)
          return buildCreateResponseText(asResponseSummary(summary))
        },
      }),

      update_artifact: tool({
        description:
          "Publish the pending iteration of a redline artifact as a new version. Only legal while the artifact is iterating (the user hit Iterate); publishing stamps the version and returns the artifact to review. Keep section ids stable so existing pins still resolve.",
        args: {
          artifactId: tool.schema.string().describe("Artifact id from create_artifact"),
          html: tool.schema.string().describe("Complete revised HTML document"),
          note: tool.schema.string().optional().describe("Short summary of what changed in this version"),
        },
        async execute(params) {
          const base = await ensureDaemon()
          const body = await requestJson(
            base,
            "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/versions",
            jsonInit("POST", { html: params.html, note: params.note }),
          )
          const summary = SummarySchema.parse(body)
          return buildUpdateResponseText(asResponseSummary(summary))
        },
      }),

      get_feedback: tool({
        description:
          "Read the comment threads and loop status of a redline artifact right now. Returns every thread on the artifact, open ones first: pinned-on/resolved-in versions, element selectors, quoted text, pending thinking placeholders, presence, and pending iterations.",
        args: {
          artifactId: tool.schema.string().describe("Artifact id"),
          version: tool.schema
            .string()
            .optional()
            .describe("Only threads pinned on this version. Default: all threads."),
        },
        async execute(params) {
          const base = await ensureDaemon()
          const query = params.version === undefined ? "" : "?version=" + encodeURIComponent(params.version)
          const body = await requestJson(
            base,
            "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/feedback" + query,
          )
          const view = FeedbackViewSchema.parse(body)
          const openCount = view.threads.filter((thread: Thread) => thread.status === "open").length
          const pending = pendingRow(view)
          const header =
            "Artifact " +
            params.artifactId +
            " " +
            view.current +
            ", status: " +
            view.artifactStatus +
            ", agent: " +
            (view.agentAttached ? "attached" : "not attached") +
            " (" +
            String(openCount) +
            " open)"
          const pendingLine =
            pending !== undefined
              ? "\nPending iteration " + pending.version + " with " + String(pending.batch?.threadIds.length ?? 0) + " thread(s) \u2014 address the batch and publish with update_artifact."
              : view.approvedAt !== undefined
                ? "\n" + view.current + " approved \u2014 done for now."
                : ""
          return header + pendingLine + "\n" + renderThreads(view)
        },
      }),

      wait_for_feedback: tool({
        description:
          "Block until the user comments (reply duty: answer in threads, never publish), hits Iterate (work duty: address the frozen batch and publish), or approves the current version (exit: done for now, hand control back). Esc cancels the wait.",
        args: {
          artifactId: tool.schema.string().describe("Artifact id"),
          timeoutSeconds: tool.schema
            .number()
            .optional()
            .describe("Max seconds to block, default 120, max 300"),
          after: tool.schema
            .string()
            .optional()
            .describe(
              "ISO timestamp; wake only for changes after it. By default open threads or a pending iteration return immediately, otherwise the call blocks from now.",
            ),
        },
        async execute(params, ctx) {
          const base = await ensureDaemon()
          const timeoutSeconds = Math.min(Math.max(Math.trunc(params.timeoutSeconds ?? 120), 1), 300)
          const artifactPath = "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/feedback"
          ctx.metadata({
            title: "Waiting up to " + String(timeoutSeconds) + "s for feedback on " + params.artifactId,
          })
          try {
            const initial = FeedbackViewSchema.parse(
              await requestJson(base, artifactPath, { signal: ctx.abort }),
            )
            // An iteration in flight is always work, whatever else happened.
            if (initial.artifactStatus === "iterating" || pendingRow(initial) !== undefined) {
              return workDutyText(initial, params.artifactId)
            }
            if (params.after === undefined) {
              const openCount = initial.threads.filter((thread: Thread) => thread.status === "open").length
              if (openCount > 0) {
                return (
                  "Feedback already waiting on " +
                  params.artifactId +
                  " (" +
                  initial.current +
                  ", status: " +
                  initial.artifactStatus +
                  "):\n" +
                  renderThreads(initial)
                )
              }
            }
            const after =
              params.after ??
              maxIso([
                initial.updatedAt,
                initial.artifactUpdatedAt,
                initial.iteratedAt,
                initial.approvedAt ?? epoch,
              ])
            const body = await requestJson(
              base,
              artifactPath + "?wait=" + String(timeoutSeconds) + "&after=" + encodeURIComponent(after),
              { signal: ctx.abort },
            )
            const view = FeedbackViewSchema.parse(body)
            if (view.artifactStatus === "iterating" || pendingRow(view) !== undefined) {
              return workDutyText(view, params.artifactId)
            }
            if (view.approvedAt !== undefined && view.approvedAt > after) {
              return (
                "EXIT on " +
                params.artifactId +
                ": " +
                view.current +
                " approved \u2014 done for now. Report the sign-off and hand control back to the user. The artifact stays open: a later Iterate re-attaches you."
              )
            }
            const changed = view.updatedAt > after || view.artifactUpdatedAt > after
            return changed
              ? replyDutyText(view, params.artifactId)
              : "No new feedback within " +
                  String(timeoutSeconds) +
                  "s. Status is still " +
                  view.artifactStatus +
                  "."
          } catch (error) {
            if (ctx.abort.aborted) return "wait_for_feedback cancelled"
            throw error
          }
        },
      }),

      list_artifacts: tool({
        description: "List all redline artifacts with status and open thread counts.",
        args: {},
        async execute() {
          const base = await ensureDaemon()
          const body = await requestJson(base, "/api/v1/artifacts")
          const summaries = z.array(SummarySchema).parse(body)
          if (summaries.length === 0) return "No artifacts yet."
          return summaries
            .map(
              (summary: Summary) =>
                "- " +
                summary.title +
                " (" +
                summary.id +
                ") " +
                summary.status +
                ", " +
                summary.current +
                ", " +
                String(summary.openThreads) +
                " open thread(s), " +
                summary.reviewUrl,
            )
            .join("\n")
        },
      }),
    },
  }
}

