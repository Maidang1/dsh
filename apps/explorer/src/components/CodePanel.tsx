'use client'
/**
 * Project wrappers over Code Hike (docs/03 §4.2): these names are ours, not
 * Code Hike APIs. Domain data never depends on Code Hike's token structure.
 */
import React from 'react'
import { InnerLine, InnerPre, InnerToken, Pre, getPreRef } from 'codehike/code'
import type { AnnotationHandler, CustomPreProps, HighlightedCode } from 'codehike/code'
import { calculateTransitions, getStartingSnapshot } from 'codehike/utils/token-transitions'
import type { TokenTransitionsSnapshot } from 'codehike/utils/token-transitions'

const TRANSITION_MS = 300

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Animates tokens between stages; skipped entirely when the user prefers reduced motion. */
class TransitionPre extends React.Component<CustomPreProps> {
  ref: React.RefObject<HTMLPreElement>
  constructor(props: CustomPreProps) {
    super(props)
    this.ref = getPreRef(this.props)
  }
  override render() {
    return <InnerPre merge={this.props} style={{ position: 'relative' }} />
  }
  override getSnapshotBeforeUpdate() {
    return this.ref.current && !reducedMotion() ? getStartingSnapshot(this.ref.current) : null
  }
  override componentDidUpdate(_prev: CustomPreProps, _state: unknown, snapshot: TokenTransitionsSnapshot | null) {
    if (!snapshot || !this.ref.current) return
    for (const { element, keyframes, options } of calculateTransitions(this.ref.current, snapshot)) {
      const { translateX, translateY, ...rest } = keyframes
      const frames: Record<string, unknown> = { ...rest }
      if (translateX && translateY) frames.translate = [`${translateX[0]}px ${translateY[0]}px`, `${translateX[1]}px ${translateY[1]}px`]
      element.animate(frames as PropertyIndexedKeyframes, {
        duration: options.duration * TRANSITION_MS,
        delay: options.delay * TRANSITION_MS,
        easing: options.easing,
        fill: 'both',
      })
    }
  }
}

const tokenTransitions: AnnotationHandler = {
  name: 'token-transitions',
  PreWithRef: TransitionPre,
  Token: props => <InnerToken merge={props} style={{ display: 'inline-block' }} />,
}

/** Lines outside the focused anchors are dimmed but stay readable. */
const focus: AnnotationHandler = {
  name: 'focus',
  onlyIfAnnotated: true,
  Line: props => <InnerLine merge={props} className="code-line code-line--dim" />,
  AnnotatedLine: ({ annotation: _annotation, ...props }) => <InnerLine merge={props} className="code-line" data-focus="true" />,
}

/** Lines added since the previous stage carry a marker and text, not only color. */
const mark: AnnotationHandler = {
  name: 'mark',
  AnnotatedLine: ({ annotation: _annotation, ...props }) => (
    <div className="code-mark">
      <span className="code-mark__gutter" aria-hidden>+</span>
      <InnerLine merge={props} />
    </div>
  ),
  Line: props => (
    <div className="code-mark code-mark--none">
      <span className="code-mark__gutter" aria-hidden> </span>
      <InnerLine merge={props} />
    </div>
  ),
}

export function LessonCode({ code }: { code: HighlightedCode }) {
  return <Pre code={code} handlers={[mark, focus, tokenTransitions]} className="lesson-code" style={code.style} />
}
