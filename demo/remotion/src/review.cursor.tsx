import React from 'react'
import { Easing, interpolate, useCurrentFrame } from 'remotion'
import { theme } from './theme'
import { FPS, CursorEffect, MediaCut } from './timings'

// A synthetic mouse pointer for actions the screen recording did not capture.
// Rendered inside the camera transform, in native source pixels, so it tracks
// the zoom. Spawns at `from`, glides to `to`, ripples at `click`, and fades
// out by `until`.
export const SyntheticCursor: React.FC<{
  readonly cursor: CursorEffect
  readonly cut: MediaCut
}> = ({ cursor, cut }) => {
  const frame = useCurrentFrame()
  const t = cut.start + (frame / FPS) * cut.rate

  if (t < cursor.start || t > cursor.until) {
    return null
  }

  const glide = interpolate(t, [cursor.start, cursor.arrive], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.bezier(0.3, 0.7, 0.3, 1)),
  })
  const x = cursor.from[0] + (cursor.to[0] - cursor.from[0]) * glide
  const y = cursor.from[1] + (cursor.to[1] - cursor.from[1]) * glide
  const opacity = interpolate(
    t,
    [cursor.start, cursor.start + 0.12, cursor.until - 0.2, cursor.until],
    [0, 1, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    },
  )
  const press = interpolate(
    t,
    [cursor.click, cursor.click + 0.07, cursor.click + 0.15],
    [0, 1, 0],
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    },
  )
  const ripple = interpolate(t, [cursor.click, cursor.click + 0.35], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  })

  return (
    <>
      {ripple > 0 && ripple < 1 ? (
        <div
          style={{
            position: 'absolute',
            left: cursor.to[0],
            top: cursor.to[1],
            width: 14,
            height: 14,
            marginLeft: -7,
            marginTop: -7,
            borderRadius: '50%',
            border: `3px solid ${theme.amber}`,
            opacity: 1 - ripple,
            transform: `scale(${0.4 + ripple * 2.6})`,
          }}
        />
      ) : null}
      <div
        style={{
          position: 'absolute',
          left: x,
          top: y,
          opacity,
          transform: `scale(${1 - press * 0.15})`,
          transformOrigin: '2px 2px',
        }}
      >
        <svg width={26} height={30} viewBox="0 0 26 30">
          <path
            d="M2 1 L2 22.5 L7.8 17 L11.3 24.8 L15.4 23 L11.8 15.4 L19 14.6 Z"
            fill="#ffffff"
            stroke={theme.ash}
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </svg>
      </div>
    </>
  )
}
