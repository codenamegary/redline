import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { Static } from "typebox"
import { z } from "zod"

const repoUrl = process.env.REDLINE_REPO ?? "https://github.com/codenamegary/redline.git"

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..")

const appRoot = (): string => join(homeDir(), "app")

const looksLikeApp = (dir: string): boolean =>
  existsSync(join(dir, "src", "main.ts")) && existsSync(join(dir, "install.sh"))

const homeDir = (): string => process.env.REDLINE_HOME ?? join(homedir(), ".redline")

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
  messages: z.array(z.object({ author: z.string(), body: z.string() })),
})

type Thread = z.infer<typeof ThreadSchema>

const FeedbackViewSchema = z.object({
  version: z.string(),
  updatedAt: z.string(),
  threads: z.array(ThreadSchema),
  artifactStatus: z.string(),
  artifactUpdatedAt: z.string(),
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
  if (looksLikeApp(packageRoot)) return packageRoot
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
      const tags: string[] = []
      if (thread.anchorVersion !== undefined) tags.push("pinned on " + thread.anchorVersion)
      if (thread.status === "resolved" && thread.resolvedInVersion !== undefined) {
        tags.push("resolved in " + thread.resolvedInVersion)
      }
      const tagText = tags.length > 0 ? " (" + tags.join(", ") + ")" : ""
      return (
        String(index + 1) + ". [" + thread.status + "]" + tagText + " " + target + ": " + (last?.body ?? "") + extra
      )
    })
    .join("\n")
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method: method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

type CreateParams = Static<ReturnType<typeof createParamsSchema>>

const createParamsSchema = () =>
  Type.Object({
    title: Type.String({ description: "Short human-readable title" }),
    prompt: Type.Optional(
      Type.String({ description: "Original instruction or brief this artifact answers" }),
    ),
    note: Type.Optional(Type.String({ description: "Note recorded on the first version" })),
    html: Type.String({
      description:
        "Complete self-contained HTML document: inline CSS and JS, inline SVG diagrams, no external requests",
    }),
  })

export default function (pi: ExtensionAPI): void {
  pi.registerTool({
    name: "create_artifact",
    label: "Create artifact",
    description:
      "Create a redline design artifact (architecture doc, decision record, API contract, diagram, UI mockup, any self-contained HTML) and open it for human review. Returns the review URL to share with the user.",
    promptSnippet: "Create an HTML design artifact for human redline review",
    promptGuidelines: [
      "Use create_artifact when the user wants a reviewable HTML artifact such as an architecture doc, decision record, API contract, diagram, or UI mockup. Share the returned review URL with the user, then call wait_for_feedback.",
    ],
    parameters: createParamsSchema(),
    async execute(_toolCallId, params: CreateParams, _signal, _onUpdate, _ctx) {
      const base = await ensureDaemon()
      const body = await requestJson(
        base,
        "/api/v1/artifacts",
        jsonInit("POST", {
          title: params.title,
          prompt: params.prompt ?? "",
          note: params.note,
          html: params.html,
        }),
      )
      const summary = SummarySchema.parse(body)
      const text = [
        "Artifact created: " + summary.id + " (" + summary.current + ")",
        "Review URL: " + summary.reviewUrl,
        "Give this URL to the user, then call wait_for_feedback to block until they comment or approve.",
      ].join("\n")
      return { content: [{ type: "text", text: text }], details: summary }
    },
  })

  pi.registerTool({
    name: "update_artifact",
    label: "Update artifact",
    description:
      "Publish a revised version of a redline artifact. The new version becomes current and the artifact returns to review status. Keep section ids stable so existing pins still resolve.",
    promptSnippet: "Publish a revised version of a redline artifact",
    parameters: Type.Object({
      artifactId: Type.String({ description: "Artifact id from create_artifact" }),
      html: Type.String({ description: "Complete revised HTML document" }),
      note: Type.Optional(
        Type.String({ description: "Short summary of what changed in this version" }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const base = await ensureDaemon()
      const body = await requestJson(
        base,
        "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/versions",
        jsonInit("POST", { html: params.html, note: params.note }),
      )
      const summary = SummarySchema.parse(body)
      const text =
        "Published " +
        summary.current +
        " of " +
        summary.id +
        ". Review URL: " +
        summary.reviewUrl +
        ". Call wait_for_feedback next."
      return { content: [{ type: "text", text: text }], details: summary }
    },
  })

  pi.registerTool({
    name: "get_feedback",
    label: "Get feedback",
    description:
      "Read the comment threads and approval status of a redline artifact right now. Returns every thread on the artifact, open ones first: pinned-on/resolved-in versions, element selectors, quoted text, and the conversation.",
    promptSnippet: "Read current redline feedback for an artifact",
    parameters: Type.Object({
      artifactId: Type.String({ description: "Artifact id" }),
      version: Type.Optional(
        Type.String({ description: "Only threads pinned on this version. Default: all threads." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const base = await ensureDaemon()
      const query = params.version === undefined ? "" : "?version=" + encodeURIComponent(params.version)
      const body = await requestJson(
        base,
        "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/feedback" + query,
      )
      const view = FeedbackViewSchema.parse(body)
      const text =
        "Artifact " +
        params.artifactId +
        " " +
        view.version +
        ", status: " +
        view.artifactStatus +
        " (" +
        String(view.threads.filter((thread: Thread) => thread.status === "open").length) +
        " open)" +
        "\n" +
        renderThreads(view)
      return { content: [{ type: "text", text: text }], details: view }
    },
  })

  pi.registerTool({
    name: "wait_for_feedback",
    label: "Wait for feedback",
    description:
      "Block until the user leaves new feedback or approves the artifact, or until the timeout. This is how a review round ends. Esc cancels the wait.",
    promptSnippet: "Block until the user comments on or approves a redline artifact",
    parameters: Type.Object({
      artifactId: Type.String({ description: "Artifact id" }),
      timeoutSeconds: Type.Optional(
        Type.Number({ description: "Max seconds to block, default 120, max 300" }),
      ),
      after: Type.Optional(
        Type.String({
          description:
            "ISO timestamp; wake only for changes after it. By default any open threads return immediately, otherwise the call blocks from now.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, _ctx) {
      const base = await ensureDaemon()
      const timeoutSeconds = Math.min(Math.max(Math.trunc(params.timeoutSeconds ?? 120), 1), 300)
      const artifactPath =
        "/api/v1/artifacts/" + encodeURIComponent(params.artifactId) + "/feedback"
      onUpdate?.({
        content: [
          {
            type: "text",
            text:
              "Waiting up to " + String(timeoutSeconds) + "s for feedback on " + params.artifactId,
          },
        ],
        details: {},
      })
      try {
        const initial = FeedbackViewSchema.parse(await requestJson(base, artifactPath, { signal: signal }))
        if (params.after === undefined) {
          const openCount = initial.threads.filter((thread: Thread) => thread.status === "open").length
          if (openCount > 0) {
            const text =
              "Feedback already waiting on " +
              params.artifactId +
              " (" +
              initial.version +
              ", status: " +
              initial.artifactStatus +
              "):\n" +
              renderThreads(initial)
            return { content: [{ type: "text", text: text }], details: initial }
          }
        }
        const after =
          params.after ??
          (initial.updatedAt > initial.artifactUpdatedAt
            ? initial.updatedAt
            : initial.artifactUpdatedAt)
        const body = await requestJson(
          base,
          artifactPath +
            "?wait=" +
            String(timeoutSeconds) +
            "&after=" +
            encodeURIComponent(after),
          { signal: signal },
        )
        const view = FeedbackViewSchema.parse(body)
        const changed = view.updatedAt > after || view.artifactUpdatedAt > after
        const text = changed
          ? "New activity on " +
            params.artifactId +
            " (" +
            view.version +
            ", status: " +
            view.artifactStatus +
            "):\n" +
            renderThreads(view)
          : "No new feedback within " +
            String(timeoutSeconds) +
            "s. Status is still " +
            view.artifactStatus +
            "."
        return { content: [{ type: "text", text: text }], details: view }
      } catch (error) {
        if (signal?.aborted) {
          return { content: [{ type: "text", text: "wait_for_feedback cancelled" }], details: {} }
        }
        throw error
      }
    },
  })

  pi.registerTool({
    name: "list_artifacts",
    label: "List artifacts",
    description: "List all redline artifacts with status and open thread counts.",
    promptSnippet: "List redline artifacts",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
      const base = await ensureDaemon()
      const body = await requestJson(base, "/api/v1/artifacts")
      const summaries = z.array(SummarySchema).parse(body)
      const text =
        summaries.length === 0
          ? "No artifacts yet."
          : summaries
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
      return { content: [{ type: "text", text: text }], details: { artifacts: summaries } }
    },
  })

  pi.registerCommand("redline", {
    description: "Show redline server status and gallery URL",
    handler: async (_args, ctx) => {
      try {
        const base = await ensureDaemon()
        const body = await requestJson(base, "/api/v1/artifacts")
        const summaries = z.array(SummarySchema).parse(body)
        const open = summaries.reduce((total: number, summary: Summary) => total + summary.openThreads, 0)
        ctx.ui.notify(
          "redline: " +
            String(summaries.length) +
            " artifact(s), " +
            String(open) +
            " open thread(s), gallery: " +
            base +
            "/",
          "info",
        )
      } catch (error) {
        ctx.ui.notify("redline: " + (error instanceof Error ? error.message : "unknown error"), "error")
      }
    },
  })
}
