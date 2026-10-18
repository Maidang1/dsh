'use client'
/**
 * On narrow screens the two main panes are switched by tabs instead of being
 * squeezed side by side (docs/01 §10). On wide screens the bar is hidden and
 * both panes show; the CSS decides, so nothing measures the viewport.
 */
interface Props<T extends string> {
  label: string
  panes: ReadonlyArray<{ id: T; title: string }>
  current: T
  onSelect(id: T): void
}

export function NarrowTabs<T extends string>({ label, panes, current, onSelect }: Props<T>) {
  return (
    <div className="narrow-tabs segmented" role="tablist" aria-label={label}>
      {panes.map(pane => (
        <button key={pane.id} type="button" role="tab" aria-selected={pane.id === current} onClick={() => onSelect(pane.id)}>
          {pane.title}
        </button>
      ))}
    </div>
  )
}

/** Class for a pane that only hides on narrow screens when it is not the current tab. */
export const narrowPane = (shown: boolean) => (shown ? '' : ' is-narrow-hidden')
