import { QueryClientProvider } from "@tanstack/react-query"
import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createQueryClient } from "../../app/query.client"
import { GalleryPage } from "./page"

const artifacts = [
  {
    id: "2026-09-07-120000-demo",
    title: "Demo artifact",
    status: "review",
    createdAt: "2026-09-07T12:00:00.000Z",
    updatedAt: "2026-09-07T13:00:00.000Z",
    current: "v1",
    versionCount: 2,
    openThreads: 1,
    reviewUrl: "http://127.0.0.1:4739/a/2026-09-07-120000-demo",
    assetsCount: 0,
    reviewer: "idle",
    worker: "idle",
  },
]

describe("GalleryPage", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith("/health")) {
          return new Response(JSON.stringify({ ok: true, service: "redline", version: "dev", home: "/home/x/.redline" }))
        }
        return new Response(JSON.stringify(artifacts))
      }),
    )
  })

  it("renders artifact cards from the API", async () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <GalleryPage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    expect(await screen.findByRole("link", { name: "Demo artifact" })).toBeInTheDocument()
    expect(screen.getByText("1 open thread")).toBeInTheDocument()
    expect(screen.getByText("review loop for design artifacts: architecture docs, decision records, API contracts, diagrams, UI mockups")).toBeInTheDocument()
  })
})
