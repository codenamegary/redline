import React from 'react'
import { Composition } from 'remotion'
import { RedlineDemo } from './redline.demo'
import { HEIGHT, FPS, WIDTH, demoFrames } from './timings'

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="RedlineDemo"
      component={RedlineDemo}
      durationInFrames={demoFrames}
      fps={FPS}
      width={WIDTH}
      height={HEIGHT}
      defaultProps={{}}
    />
  )
}
