import React from 'react'
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'
import { emberBackground, theme } from './theme'

export const OutroCard: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const name = spring({ frame, fps, config: { damping: 200 } })
  const chip = spring({ frame, fps, delay: 14, config: { damping: 200 } })
  const repo = interpolate(frame, [28, 44], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <AbsoluteFill
      style={{
        background: emberBackground,
        justifyContent: 'center',
        alignItems: 'center',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 34,
        }}
      >
        <div
          style={{
            opacity: name,
            fontFamily: theme.display,
            fontSize: 120,
            color: theme.ticket,
          }}
        >
          redline<span style={{ color: theme.amber }}>.</span>
        </div>
        <div
          style={{
            opacity: chip,
            transform: `translateY(${(1 - chip) * 20}px)`,
            fontFamily: theme.mono,
            fontSize: 28,
            color: theme.amber,
            background: 'rgba(28, 20, 16, 0.85)',
            border: `1px solid ${theme.line}`,
            borderRadius: 12,
            padding: '14px 26px',
          }}
        >
          npx skills add codenamegary/redline
        </div>
        <div
          style={{
            opacity: repo,
            fontFamily: theme.mono,
            fontSize: 22,
            letterSpacing: '0.06em',
            color: theme.muted,
          }}
        >
          github.com/codenamegary/redline · MIT
        </div>
      </div>
    </AbsoluteFill>
  )
}
