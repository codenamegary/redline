import { QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createQueryClient } from "../../app/query.client"
import { ReviewShell } from "./ReviewShell"

const now = "2026-09-07T12:00:00.000Z"

const artifact = {
  id: "2026-09-07-120000-demo",
  title: "Demo artifact",
  prompt: "A demo",
  status: "review",
  createdAt: now,
  updatedAt: now,
  current: "v1",
  versions: [{ version: "v1", createdAt: now, publishedAt: now }],
}

const feedback = {
  version: "v1",
  current: "v1",
  updatedAt: now,
  iteratedAt: now,
  artifactStatus: "review",
  artifactUpdatedAt: now,
  versions: artifact.versions,
  threads: [
    {
      id: "t1",
      status: "open",
      anchor: null,
      messages: [{ id: "m1", author: "user", kind: "text", body: "Hello", createdAt: now }],
      createdAt: now,
    },
  ],
}

const renderShell = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={["/a/2026-09-07-120000-demo"]}>
        <ReviewShell id="2026-09-07-120000-demo" />
      </MemoryRouter>
    </QueryClientProvider>,
  )

describe("ReviewShell sidebar", () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
        if (url.endsWith("/feedback")) {
          return new Response(JSON.stringify(feedback))
        }
        return new Response(JSON.stringify(artifact))
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("puts the artifact title in the page title, restoring it on unmount", async () => {
    // Mirror index.html: production ships <title>redline</title> in the head.
    document.head.innerHTML = "<title>redline</title>"
    try {
      const { unmount } = renderShell()
      await screen.findByText("Demo artifact")
      expect(document.title).toBe("Demo artifact")
      unmount()
      expect(document.title).toBe("redline")
    } finally {
      document.head.innerHTML = ""
    }
  })

  it("shows the redline mark icon in the review header", async () => {
    renderShell()
    await screen.findByText("Demo artifact")
    const header = screen.getByRole("banner")
    const mark = header.querySelector('[data-testid="redline-mark"]')
    expect(mark).not.toBeNull()
  })

  it("collapses and expands the sidebar, persisting the state", async () => {
    renderShell()
    const hide = await screen.findByRole("button", { name: "Hide comments sidebar" })
    fireEvent.click(hide)
    expect(localStorage.getItem("redline.sidebar.collapsed")).toBe("true")

    const show = screen.getByRole("button", { name: "Show comments sidebar" })
    fireEvent.click(show)
    expect(localStorage.getItem("redline.sidebar.collapsed")).toBe("false")
    expect(screen.getByRole("button", { name: "Hide comments sidebar" })).toBeInTheDocument()
  })

  it("shows the open thread count on the collapsed rail", async () => {
    renderShell()
    fireEvent.click(await screen.findByRole("button", { name: "Hide comments sidebar" }))
    expect(screen.getByText("1")).toBeInTheDocument()
  })

  it("persists the width after a drag", async () => {
    renderShell()
    const separator = await screen.findByRole("separator")
    // jsdom viewport is 1024px wide: dragging to x=524 gives width 500.
    fireEvent.pointerDown(separator, { button: 0, clientX: 524 })
    fireEvent.pointerMove(window, { clientX: 524 })
    fireEvent.pointerUp(window)
    await waitFor(() => expect(localStorage.getItem("redline.sidebar.width")).toBe("500"))
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "500px" })
  })

  it("restores persisted width and collapsed state on mount", async () => {
    localStorage.setItem("redline.sidebar.width", "420")
    localStorage.setItem("redline.sidebar.collapsed", "true")
    renderShell()
    await screen.findByRole("button", { name: "Show comments sidebar" })
    expect(screen.queryByRole("separator")).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole("button", { name: "Show comments sidebar" }))
    expect(screen.getByRole("complementary")).toHaveStyle({ width: "420px" })
  })
})
