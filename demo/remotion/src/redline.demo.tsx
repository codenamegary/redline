import React from 'react'
import { TransitionSeries, linearTiming } from '@remotion/transitions'
import { fade } from '@remotion/transitions/fade'
import { TerminalSection } from './terminal.section'
import { ReviewSection } from './review.section'
import { OutroCard } from './outro.card'
import {
  FPS,
  outroSeconds,
  reviewFrames,
  terminalFrames,
  transitionFrames,
} from './timings'

export const RedlineDemo: React.FC = () => {
  return (
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={terminalFrames}>
        <TerminalSection />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: transitionFrames })}
      />
      <TransitionSeries.Sequence durationInFrames={reviewFrames}>
        <ReviewSection />
      </TransitionSeries.Sequence>
      <TransitionSeries.Transition
        presentation={fade()}
        timing={linearTiming({ durationInFrames: transitionFrames })}
      />
      <TransitionSeries.Sequence durationInFrames={outroSeconds * FPS}>
        <OutroCard />
      </TransitionSeries.Sequence>
    </TransitionSeries>
  )
}
