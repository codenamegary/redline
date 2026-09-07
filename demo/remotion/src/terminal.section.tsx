import React from 'react'
import { OffthreadVideo, Series, staticFile } from 'remotion'
import {
  FPS,
  HEIGHT,
  WIDTH,
  cutFrames,
  terminalCuts,
} from './timings'

// Series.Sequence elements must be direct children of <Series>, so the cut
// views are inlined here instead of wrapped in a component.
export const TerminalSection: React.FC = () => {
  return (
    <Series>
      {terminalCuts.map((cut) => (
        <Series.Sequence key={cut.label} durationInFrames={cutFrames(cut)}>
          <OffthreadVideo
            src={staticFile('01-terminal.mp4')}
            trimBefore={Math.round(cut.start * FPS)}
            playbackRate={cut.rate}
            muted
            style={{ width: WIDTH, height: HEIGHT, objectFit: 'cover' }}
          />
        </Series.Sequence>
      ))}
    </Series>
  )
}
