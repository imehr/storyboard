import {Composition, Sequence, Audio, staticFile, spring, useCurrentFrame, useVideoConfig, Easing} from 'remotion';
import React from 'react';

// This file maps the storyboard JSON into a Remotion composition.  It is not
// executed in this environment but illustrates how to convert the YAML/JSON
// produced by the storyboard tool into an animated video.  Each slide becomes
// its own Sequence and individual elements are nested Sequences so they can
// animate relative to the start of the slide.

// Load the storyboard definition.  At build time, you should move the JSON
// into your project’s source directory or fetch it dynamically.
const storyboard = require('./brief_storyboard.json');

// Basic text components with simple fade‑in animations.  You can replace
// these with your own styled components.
const FadeInText: React.FC<{children: React.ReactNode; delayFrames: number; duration: number; fontSize?: number; bold?: boolean}> = ({children, delayFrames, duration, fontSize = 40, bold = false}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const progress = spring({
    frame: frame - delayFrames,
    fps,
    config: {
      damping: 200,
      stiffness: 100,
    },
  });
  const opacity = progress;
  return (
    <div style={{opacity, fontSize, fontWeight: bold ? 700 : 400, marginBottom: 8, lineHeight: 1.2}}>
      {children}
    </div>
  );
};

const BulletList: React.FC<{items: string[]; startFrame: number; delayPerItem: number}> = ({items, startFrame, delayPerItem}) => {
  return (
    <div style={{marginLeft: 20}}>
      {items.map((item, idx) => (
        <FadeInText key={idx} delayFrames={Math.round(startFrame + idx * delayPerItem)} duration={15} fontSize={32}>
          • {item}
        </FadeInText>
      ))}
    </div>
  );
};

const Paragraph: React.FC<{content: string; delayFrames: number}> = ({content, delayFrames}) => {
  return (
    <FadeInText delayFrames={delayFrames} duration={15} fontSize={28}>{content}</FadeInText>
  );
};

const CodeBlock: React.FC<{code: string; delayFrames: number}> = ({code, delayFrames}) => {
  const lines = code.split('\n');
  return (
    <pre style={{backgroundColor: '#f5f5f5', padding: 12, borderRadius: 4, fontSize: 26, fontFamily: 'monospace', opacity: 1}}>
      {lines.map((line, idx) => (
        <FadeInText key={idx} delayFrames={delayFrames + idx * 2} duration={10} fontSize={26}>{line}</FadeInText>
      ))}
    </pre>
  );
};

// Map each element type to a React component.  This function returns a
// Sequence that starts at the element's startSec and spans the remainder of
// the slide.  Animations are handled inside the components.
const renderElement = (element: any, fps: number, slideDuration: number) => {
  const startFrame = Math.round(element.startSec * fps);
  const durationFrames = Math.round((element.endSec ?? slideDuration) * fps) - startFrame;
  switch (element.kind) {
    case 'heading':
      return (
        <Sequence key={startFrame} from={startFrame} durationInFrames={durationFrames}>
          <FadeInText delayFrames={0} duration={durationFrames} fontSize={48} bold>{element.content}</FadeInText>
        </Sequence>
      );
    case 'paragraph':
      return (
        <Sequence key={startFrame} from={startFrame} durationInFrames={durationFrames}>
          <Paragraph content={element.content} delayFrames={0} />
        </Sequence>
      );
    case 'bulletList':
      // stagger bullets by 0.3 seconds (~9 frames at 30 fps)
      return (
        <Sequence key={startFrame} from={startFrame} durationInFrames={durationFrames}>
          <BulletList items={element.content} startFrame={0} delayPerItem={Math.round(0.3 * fps)} />
        </Sequence>
      );
    case 'code':
      return (
        <Sequence key={startFrame} from={startFrame} durationInFrames={durationFrames}>
          <CodeBlock code={element.content} delayFrames={0} />
        </Sequence>
      );
    default:
      return null;
  }
};

export const RemotionVideo: React.FC = () => {
  const {fps, width, height} = {fps: storyboard.meta.defaultFps, width: storyboard.meta.defaultResolution.width, height: storyboard.meta.defaultResolution.height};
  // Accumulate slide start frames
  let currentFrame = 0;
  return (
    <Composition
      id={storyboard.meta.videoId}
      component={() => {
        return (
          <>
            {storyboard.slides.map((slide: any, idx: number) => {
              const slideStart = currentFrame;
              const durationFrames = slide.durationSec * fps;
              currentFrame += durationFrames;
              return (
                <Sequence key={slide.id} from={slideStart} durationInFrames={durationFrames}>
                  {/* render slide elements */}
                  <div style={{padding: 80}}>
                    {slide.elements.map((el: any) => renderElement(el, fps, slide.durationSec))}
                  </div>
                  {/* Example of adding background music or sfx */}
                  {slide.audioTracks && slide.audioTracks.backgroundMusic !== 'none' && (
                    <Audio
                      src={staticFile(`audios/${slide.audioTracks.backgroundMusic}`)}
                      startFrom={0}
                      endAt={durationFrames}
                      // Additional volume control could be added here
                    />
                  )}
                </Sequence>
              );
            })}
          </>
        );
      }}
      durationInFrames={storyboard.meta.totalDurationSec * storyboard.meta.defaultFps}
      fps={storyboard.meta.defaultFps}
      width={storyboard.meta.defaultResolution.width}
      height={storyboard.meta.defaultResolution.height}
    />
  );
};