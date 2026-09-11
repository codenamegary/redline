import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { Thread } from "@redline/http-contracts/artifact.models"
import { REPLY_ROWS, ThreadsPanel } from "./ThreadsPanel"

const now = "2026-09-07T12:00:00.000Z"

const openThread: Thread = {
  id: "t1",
  status: "open",
  anchor: { selector: "#hero", text: "Hero" },
  anchorVersion: "v1",
  messages: [{ id: "m1", author: "user", kind: "text", body: "Fix this", createdAt: now }],
  createdAt: now,
}

const resolvedThread: Thread = {
  ...openThread,
  id: "t2",
  status: "resolved",
  resolvedInVersion: "v1",
}

const setup = (overrides?: { review?: boolean; threads?: Thread[]; expanded?: Record<string, boolean> }) => {
  const onReply = vi.fn()
  const onToggleStatus = vi.fn()
  render(
    <ThreadsPanel
      threads={overrides?.threads ?? [openThread]}
      review={overrides?.review ?? true}
      numbers={new Map([["t1", 1], ["t2", 2]])}
      expanded={overrides?.expanded ?? {}}
      activeThreadId={undefined}
      busy={false}
      onToggleExpanded={vi.fn()}
      onFlash={vi.fn()}
      onReply={onReply}
      onToggleStatus={onToggleStatus}
      onSwitchVersion={vi.fn()}
    />,
  )
  return { onReply, onToggleStatus }
}

describe("ThreadsPanel reply composer", () => {
  it("renders a 3-line, non-user-resizable textarea with buttons underneath", () => {
    setup()
    const box = screen.getByPlaceholderText(/Reply/)
    expect(box.tagName).toBe("TEXTAREA")
    expect(box).toHaveAttribute("rows", String(REPLY_ROWS))
    expect(box).toHaveClass("resize-none")
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Resolve" })).toBeInTheDocument()
  })

  it("sends the trimmed reply on ⌘/ctrl+enter and clears the box", () => {
    const { onReply } = setup()
    const box = screen.getByPlaceholderText(/Reply/)
    fireEvent.change(box, { target: { value: "  nice catch  " } })
    fireEvent.keyDown(box, { key: "Enter", metaKey: true })
    expect(onReply).toHaveBeenCalledWith("t1", "nice catch")
    expect(box).toHaveValue("")
  })

  it("does not send on plain enter", () => {
    const { onReply } = setup()
    const box = screen.getByPlaceholderText(/Reply/)
    fireEvent.change(box, { target: { value: "hello" } })
    fireEvent.keyDown(box, { key: "Enter" })
    expect(onReply).not.toHaveBeenCalled()
    expect(box).toHaveValue("hello")
  })

  it("sends via the Reply button", () => {
    const { onReply } = setup()
    fireEvent.change(screen.getByPlaceholderText(/Reply/), { target: { value: "ship it" } })
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    expect(onReply).toHaveBeenCalledWith("t1", "ship it")
  })

  it("resolves an open thread and reopens a resolved one", () => {
    const { onToggleStatus } = setup({ threads: [openThread, resolvedThread], expanded: { t2: true } })
    fireEvent.click(screen.getByRole("button", { name: "Resolve" }))
    expect(onToggleStatus).toHaveBeenCalledWith("t1", "resolved")
    fireEvent.click(screen.getByRole("button", { name: "Reopen" }))
    expect(onToggleStatus).toHaveBeenCalledWith("t2", "open")
  })

  it("hides resolve controls when the artifact is not in review", () => {
    setup({ review: false })
    expect(screen.queryByRole("button", { name: "Resolve" })).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Reply" })).toBeInTheDocument()
  })
})
