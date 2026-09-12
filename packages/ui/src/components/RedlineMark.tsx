import React from "react"

export type RedlineMarkProps = {
  size?: number
  className?: string
}

// The app mark (same art as /favicon.svg), inlined so every surface can
// badge its header without an extra request. Decorative: the adjacent
// "redline" wordmark carries the meaning.
export const RedlineMark: React.FC<RedlineMarkProps> = ({ size = 20, className }) => (
  <svg
    data-testid="redline-mark"
    aria-hidden="true"
    viewBox="0 0 64 64"
    width={size}
    height={size}
    className={className}
  >
    <rect x="2" y="2" width="60" height="60" rx="14" fill="#18181b" />
    <line x1="27.7" y1="36.6" x2="41.2" y2="48" stroke="#63636b" strokeWidth="7" />
    <path d="M25.5 17.5 H33 A9 9 0 0 1 33 35.5 H25.5" fill="none" stroke="#63636b" strokeWidth="7" />
    <rect x="16" y="14" width="7" height="36" fill="#ef4444" />
  </svg>
)
