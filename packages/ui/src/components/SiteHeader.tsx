import React from "react"
import { Link } from "react-router"

export type SiteHeaderProps = {
  tagline: string
  home?: string
  children?: React.ReactNode
}

export const SiteHeader: React.FC<SiteHeaderProps> = ({ tagline, home, children }) => (
  <header className="border-b border-edge px-7 pt-5 pb-3.5">
    <h1 className="m-0 text-xl font-semibold">
      <span className="text-redline">redline</span>
      <span className="text-mist"> — artifact review</span>
    </h1>
    <p className="mt-1.5 mb-0 text-[13px] text-mist">{tagline}</p>
    <p className="mt-1 mb-0 flex items-center gap-3 text-[13px] text-mist">
      {home !== undefined ? (
        <span>
          home: <code className="rounded bg-card px-1.5 py-0.5 font-mono text-xs">{home}</code>
        </span>
      ) : null}
      <Link to="/settings" className="text-link no-underline hover:underline">
        Settings
      </Link>
      {children}
    </p>
  </header>
)
