import React from 'react'
import {
  AbsoluteFill,
  Easing,
  OffthreadVideo,
  Series,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion'
import { theme } from './theme'
import { SyntheticCursor } from './review.cursor'
import { FPS, HEIGHT, WIDTH, MediaCut, cutFrames, reviewCuts } from './timings'

// Native size of demo/02-redline.mp4.
const SOURCE_WIDTH = 1920
const SOURCE_HEIGHT = 1080
// Timeline seconds spent easing into and out of each zoom window, converted
// to source seconds per cut (faster cuts need proportionally more source
// time so the ease feels the same on screen).
const ZOOM_RAMP_TIMELINE = 0.25

type Camera = {
  readonly zoom: number
  readonly focus: readonly [number, number]
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

// The zoomed window containing `t`, eased in and out; full frame between
// windows.
const cameraAt = (cut: MediaCut, t: number): Camera => {
  const ramp = ZOOM_RAMP_TIMELINE * cut.rate

  for (const effect of cut.zooms ?? []) {
    if (t < effect.start - ramp || t > effect.end + ramp) {
      continue
    }
    const progress = interpolate(
      t,
      [effect.start - ramp, effect.start, effect.end, effect.end + ramp],
      [0, 1, 1, 0],
      {
        extrapolateLeft: 'clamp',
        extrapolateRight: 'clamp',
        easing: Easing.inOut(Easing.bezier(0.42, 0, 0.58, 1)),
      },
    )
    const originX = effect.focusFrom?.[0] ?? effect.focus[0]
    const originY = effect.focusFrom?.[1] ?? effect.focus[1]

    return {
      zoom: 1 + (effect.zoom - 1) * progress,
      focus: [
        originX + (effect.focus[0] - originX) * progress,
        originY + (effect.focus[1] - originY) * progress,
      ],
    }
  }

  return { zoom: 1, focus: [SOURCE_WIDTH / 2, SOURCE_HEIGHT / 2] }
}

// Series.Sequence elements must be direct children of <Series>, so the cut
// views are inlined here instead of wrapped in a component.
export const ReviewSection: React.FC = () => {
  return (
    <Series>
      {reviewCuts.map((cut) => (
        <Series.Sequence key={cut.label} durationInFrames={cutFrames(cut)}>
          <ReviewCutView cut={cut} />
        </Series.Sequence>
      ))}
    </Series>
  )
}

const ReviewCutView: React.FC<{ readonly cut: MediaCut }> = ({ cut }) => {
  const frame = useCurrentFrame()
  const sourceSeconds = cut.start + (frame / FPS) * cut.rate
  const camera = cameraAt(cut, sourceSeconds)
  const scale = (WIDTH / SOURCE_WIDTH) * camera.zoom
  const tx = clamp(
    camera.focus[0] * scale - WIDTH / 2,
    0,
    SOURCE_WIDTH * scale - WIDTH,
  )
  const ty = clamp(
    camera.focus[1] * scale - HEIGHT / 2,
    0,
    SOURCE_HEIGHT * scale - HEIGHT,
  )

  return (
    <AbsoluteFill style={{ overflow: 'hidden', backgroundColor: theme.ash }}>
      <AbsoluteFill
        style={{
          transform: `translate(${-tx}px, ${-ty}px) scale(${scale})`,
          transformOrigin: '0 0',
        }}
      >
        <OffthreadVideo
          src={staticFile('02-redline.mp4')}
          trimBefore={Math.round(cut.start * FPS)}
          playbackRate={cut.rate}
          muted
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: SOURCE_WIDTH,
            height: SOURCE_HEIGHT,
          }}
        />
        {cut.cursors?.map((cursor) => (
          <SyntheticCursor key={cursor.label} cursor={cursor} cut={cut} />
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  )
}
