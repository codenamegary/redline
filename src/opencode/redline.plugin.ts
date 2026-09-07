import { execFile, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir } from "node:fs/promises"
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
// same four tool names, same HTTP API (see skills/redline/SKILL.md). After create,
// share the URL and stop: redline's reviewer and worker lanes run the review loop,
// and notify (when on) posts a one-line status ping into this session via the
// OpenCode HTTP server. The host never waits, replies, or publishes unless the
// user asks it to create or publish an artifact. Origin is stored as
// { host: "opencode", sessionId } for those pings. The daemon is lazily
// bootstrapped on first use: app found or cloned into ~/.redline/app,
// install.sh, discovered via a health probe on 127.0.0.1:$REDLINE_PORT (default 4739).

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

const baseUrl = (): string =>
  "http://127.0.0.1:" + String(process.env.REDLINE_PORT ?? "4739")

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
    if (!(await probe(baseUrl()))) await spawnDaemon(root)
  }
  daemonReady = await pollUntilReady(baseUrl(), 120)
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
              "Complete HTML document. Tailwind CDN script allowed (https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4); all other CSS and JS inline, inline SVG diagrams, no other external requests",
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
              // Origin capture for server-side notify pings plus the
              // project directory for worker repo context. The tool
              // context has no opencode server URL, so only the session id
              // travels; the redline server resolves the URL itself.
              origin: {
                host: "opencode",
                sessionId: ctx.sessionID,
                cwd: ctx.directory.length > 0 ? ctx.directory : undefined,
              },
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
          "Read the comment threads and loop status of a redline artifact right now. Returns every thread on the artifact, newest first: pinned-on/resolved-in versions, element selectors, quoted text, pending thinking placeholders, presence, and pending iterations. The last agent line on a thread may be a worker-lane note (working / addressed / failed), not a new user pin.",
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

