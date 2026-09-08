import React from "react"

export type SpinnerProps = {
  className?: string
}

export const Spinner: React.FC<SpinnerProps> = ({ className = "" }) => (
  <span
    aria-hidden
    className={`redline-spinner inline-block size-3 rounded-full border-2 border-edge-strong border-t-go ${className}`}
  />
)
