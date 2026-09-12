import { render, screen } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { describe, expect, it } from "vitest"
import { SiteHeader } from "./SiteHeader"

const renderHeader = () =>
  render(
    <MemoryRouter>
      <SiteHeader tagline="test tagline" />
    </MemoryRouter>,
  )

describe("SiteHeader", () => {
  it("shows the redline mark icon before the wordmark", () => {
    renderHeader()
    const header = screen.getByRole("banner")
    const mark = header.querySelector('[data-testid="redline-mark"]')
    expect(mark).not.toBeNull()
    const heading = screen.getByRole("heading", { level: 1 })
    expect(heading.contains(mark as Node)).toBe(true)
  })

  it("keeps the heading to the wordmark alone — no '— artifact review' suffix", () => {
    renderHeader()
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent(/^redline$/)
  })
})
