import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createQueryClient } from "../../app/query.client"
import { GalleryPage } from "./GalleryPage"

const feedbackView = (versions: { version: string; approvedAt?: string }[], approvedAt?: string) => ({
  version: versions[versions.length - 1]?.version,
  current: versions[versions.length - 1]?.version,
  updatedAt: "2026-09-07T13:00:00.000Z",
  iteratedAt: "2026-09-07T13:00:00.000Z",
  artifactStatus: "review",
  artifactUpdatedAt: "2026-09-07T13:00:00.000Z",
  approvedAt: approvedAt,
  versions: versions.map((entry) => ({
    version: entry.version,
    createdAt: "2026-09-07T12:00:00.000Z",
    publishedAt: "2026-09-07T12:30:00.000Z",
    approvedAt: entry.approvedAt,
  })),
  threads: [],
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
  ),
  "2026-09-08-090000-past": feedbackView([
    { version: "v1" },
    { version: "v2", approvedAt: "2026-09-08T10:00:00.000Z" },
    { version: "v3" },
  ]),
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

  it("renders approval state and version chips from the feedback views", async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <GalleryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole("link", { name: "Current approved" })).toBeInTheDocument()

    // Current version approved: green badge, chips for the whole ledger.
    expect(await screen.findByText("approved")).toBeInTheDocument()
    expect(screen.getAllByText("v1").length).toBeGreaterThan(0)
    expect(screen.getAllByText("v2").length).toBeGreaterThan(0)

    // An older version carries the last approval: card stays "in review"
    // and shows the previously-approved note.
    expect(await screen.findByText(/v2 previously approved/)).toBeInTheDocument()
    expect(screen.getAllByText("in review")).toHaveLength(2)

    // No feedback view reachable: the card falls back to the plain row.
    expect(screen.getByText(/2 versions/)).toBeInTheDocument()
    expect(screen.getByText("review loop for design artifacts: architecture docs, decision records, API contracts, diagrams, UI mockups")).toBeInTheDocument()
  })
})
