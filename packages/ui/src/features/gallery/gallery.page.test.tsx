import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen, within } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createQueryClient } from "../../app/query.client"
import { GalleryPage } from "./GalleryPage"

const feedbackView = (
  versions: { version: string; approvedAt?: string }[],
  approvedAt?: string,
  threads: unknown[] = [],
  date = "2026-09-07",
) => ({
  version: versions[versions.length - 1]?.version,
  current: versions[versions.length - 1]?.version,
  updatedAt: "2026-09-07T13:00:00.000Z",
  iteratedAt: "2026-09-07T13:00:00.000Z",
  artifactStatus: "review",
  artifactUpdatedAt: "2026-09-07T13:00:00.000Z",
  approvedAt: approvedAt,
  versions: versions.map((entry, index) => ({
    version: entry.version,
    createdAt: date + "T12:00:00.000Z",
    publishedAt: date + "T12:" + String(30 + index).padStart(2, "0") + ":00.000Z",
    approvedAt: entry.approvedAt,
  })),
  threads: threads,
})

const threadOn = (version: string, id: string) => ({
  id: id,
  status: "open",
  anchor: null,
  anchorVersion: version,
  messages: [
    {
      id: id + "-m1",
      author: "user",
      kind: "text",
      body: "tighten the header",
      createdAt: "2026-09-07T12:40:00.000Z",
    },
  ],
  createdAt: "2026-09-07T12:40:00.000Z",
})

const artifacts = [
  {
    id: "2026-09-07-120000-current",
    title: "Current approved",
    status: "review",
    createdAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T13:00:00.000Z",
    current: "v2",
    versionCount: 2,
    openThreads: 1,
    reviewUrl: "http://127.0.0.1:4739/a/2026-09-07-120000-current",
    assetsCount: 0,
    reviewer: "idle",
    worker: "idle",
  },
  {
    id: "2026-09-08-090000-past",
    title: "Previously approved",
    status: "review",
    createdAt: "2026-09-08T09:00:00.000Z",
    updatedAt: "2026-09-08T10:00:00.000Z",
    current: "v3",
    versionCount: 3,
    openThreads: 0,
    reviewUrl: "http://127.0.0.1:4739/a/2026-09-08-090000-past",
    assetsCount: 0,
    reviewer: "idle",
    worker: "idle",
  },
  {
    id: "2026-09-09-100000-plain",
    title: "Plain artifact",
    status: "review",
    createdAt: "2026-09-09T10:00:00.000Z",
    updatedAt: "2026-09-09T11:00:00.000Z",
    current: "v1",
    versionCount: 2,
    openThreads: 0,
    reviewUrl: "http://127.0.0.1:4739/a/2026-09-09-100000-plain",
    assetsCount: 0,
    reviewer: "idle",
    worker: "idle",
  },
]

const feedbackById: Record<string, unknown> = {
  "2026-09-07-120000-current": feedbackView(
    [
      { version: "v1" },
      { version: "v2", approvedAt: "2026-09-07T13:00:00.000Z" },
    ],
    "2026-09-07T13:00:00.000Z",
    [threadOn("v2", "t1")],
  ),
  "2026-09-08-090000-past": feedbackView(
    [
      { version: "v1" },
      { version: "v2", approvedAt: "2026-09-08T10:00:00.000Z" },
      { version: "v3" },
    ],
    undefined,
    [],
    "2026-09-08",
  ),
}

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ ok: true, service: "redline", version: "dev", home: "/home/x/.redline" }))
        }
        const feedbackMatch = url.match(/\/api\/v1\/artifacts\/([^/]+)\/feedback$/)
        if (feedbackMatch !== null) {
          const view = feedbackById[feedbackMatch[1]]
          return view === undefined
            ? new Response(JSON.stringify({ title: "not found", status: 404 }), { status: 404 })
            : new Response(JSON.stringify(view))
        }
        return new Response(JSON.stringify(artifacts))
      }),
    )
  })

  it("renders approval state and version drawer rows from the feedback views", async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <GalleryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole("link", { name: "Current approved" })).toBeInTheDocument()

    const cards = screen.getAllByRole("article")
    const sealedCard = within(cards[0])
    const pastCard = within(cards[1])

    // Current version approved and stable: approved badge, and the drawer
    // carries one row per version (newest first) with timestamps.
    expect(await sealedCard.findByText("2026-09-07 12:31")).toBeInTheDocument()
    expect(sealedCard.getByText("approved")).toBeInTheDocument()
    expect(sealedCard.getByText("2026-09-07 12:30")).toBeInTheDocument()

    // Threads pinned on a version count in its drawer row.
    expect(sealedCard.getByText("1 comment")).toBeInTheDocument()

    // Drawer rows deep-link into the review UI with that version open.
    const sealedHrefs = sealedCard.getAllByRole("link").map((link) => link.getAttribute("href"))
    expect(sealedHrefs).toContain("/a/2026-09-07-120000-current?v=v2")
    expect(sealedHrefs).toContain("/a/2026-09-07-120000-current?v=v1")

    // An older version carries the last approval: the badge stays honest
    // ("in review"), the drawer keeps the green tick on v2.
    expect(pastCard.getByText("in review")).toBeInTheDocument()
    expect(await pastCard.findByText("2026-09-08 12:32")).toBeInTheDocument()
    const pastHrefs = pastCard.getAllByRole("link").map((link) => link.getAttribute("href"))
    expect(pastHrefs).toContain("/a/2026-09-08-090000-past?v=v2")
    expect(screen.getAllByText("in review")).toHaveLength(2)

    // No feedback view reachable: the card falls back to the plain row
    // with no drawer rows.
    expect(within(cards[2]).getByText(/2 versions/)).toBeInTheDocument()
    expect(within(cards[2]).queryByText("2026-09-09 10:00")).not.toBeInTheDocument()
    expect(screen.getByText("review loop for design artifacts: architecture docs, decision records, API contracts, diagrams, UI mockups")).toBeInTheDocument()
  })
})
