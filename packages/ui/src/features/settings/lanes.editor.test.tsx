import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { LanesEditor } from "./LanesEditor"

const form = { preset: "custom" as const, command: "opencode acp" }

const renderEditor = () =>
  render(
    <LanesEditor lane="worker" form={form} defaults={undefined} disabled={false} onChange={() => {}} onTest={() => {}} />,
  )

describe("LanesEditor", () => {
  it("has no Adapter dropdown — lanes are always ACP", () => {
    renderEditor()
    expect(screen.queryByLabelText("Adapter")).not.toBeInTheDocument()
    expect(screen.getAllByRole("combobox")).toHaveLength(1)
  })

  it("explains what belongs in the ACP command box", () => {
    renderEditor()
    expect(screen.getByText(/agent client protocol/i)).toBeInTheDocument()
  })

  it("always offers the ACP probe", () => {
    renderEditor()
    expect(screen.getByRole("button", { name: "Test" })).toBeInTheDocument()
  })
})
