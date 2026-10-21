/**
 * Scope-container geometry for the layered plugin tree (§2.3). A non-root
 * scope's members can sit in different layer bands, so one bounding box per
 * scope would span the bands between and swallow unrelated nodes. Instead each
 * scope gets one dashed container per (layer, row run) holding only its own
 * members: members are grouped by layer and row, and a row's members are split
 * into x-contiguous runs wherever a gap wide enough for a non-member node
 * separates them — so no non-member node ever lies inside a container.
 */

export interface ScopeBox {
  scopeId: string
  parentId: string | null
  layer: number
  x: number
  y: number
  width: number
  height: number
}

export interface ScopeBoxesInput {
  scopes: ReadonlyArray<{ id: string; parentId: string | null }>
  instances: ReadonlyArray<{ id: string; scopeId: string }>
  /** Canvas position (top-left) of each laid-out instance node. */
  positions: ReadonlyMap<string, { x: number; y: number }>
  /** instanceId → layer band. */
  layers: ReadonlyMap<string, number>
  nodeWidth: number
  nodeHeight: number
  /** Horizontal pitch between adjacent columns minus nodeWidth (grid gap). */
  columnGap: number
  padX: number
  padTop: number
  padBottom: number
}

export function scopeBoxes(input: ScopeBoxesInput): ScopeBox[] {
  const { positions, layers, nodeWidth, nodeHeight, columnGap, padX, padTop, padBottom } = input
  const boxes: ScopeBox[] = []
  for (const scope of input.scopes) {
    if (scope.id === 'root') continue
    const members = input.instances.filter(instance => instance.scopeId === scope.id && positions.has(instance.id))
    // One group per (layer, row): a box never spans bands or wrapped rows.
    const groups = new Map<string, { layer: number; members: Array<{ id: string; x: number; y: number }> }>()
    for (const member of members) {
      const position = positions.get(member.id)!
      const layer = layers.get(member.id) ?? 1
      const key = `${layer}:${position.y}`
      const group = groups.get(key) ?? { layer, members: [] }
      group.members.push({ id: member.id, x: position.x, y: position.y })
      groups.set(key, group)
    }
    for (const group of groups.values()) {
      const sorted = [...group.members].sort((a, b) => a.x - b.x)
      let runStart = 0
      const flush = (end: number) => {
        const run = sorted.slice(runStart, end)
        if (!run.length) return
        const left = run[0]!.x - padX
        const top = run[0]!.y - padTop
        boxes.push({
          scopeId: scope.id,
          parentId: scope.parentId,
          layer: group.layer,
          x: left,
          y: top,
          width: run.at(-1)!.x - left + nodeWidth + 4,
          height: nodeHeight + padTop + padBottom,
        })
      }
      for (let index = 1; index <= sorted.length; index++) {
        // A gap wider than one column pitch means a non-member column sits
        // between the two members; split so the box never covers it.
        if (index === sorted.length || sorted[index]!.x - sorted[index - 1]!.x > nodeWidth + columnGap + 1) {
          flush(index)
          runStart = index
        }
      }
    }
  }
  return boxes.sort((a, b) => a.scopeId.localeCompare(b.scopeId) || a.layer - b.layer || a.y - b.y || a.x - b.x)
}
