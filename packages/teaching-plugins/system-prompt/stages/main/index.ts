/**
 * Teaching subset of upstream SystemPrompt
 * (packages/core/system-prompt/src/index.ts @ 687f282e).
 *
 * Kept: the `systemPrompt` service key, named and ordered sections, finite
 * order validation, duplicate names rejected per layer, scoped sections that
 * shadow outer ones, disposers bound to the caller's Cordis effect,
 * `system-prompt/change` on registration and disposal, tool-schema providers.
 * Not kept: runtime contexts, variables and interpolation, complete sections,
 * tool ordering config, the `system-prompt/assemble` waterfall.
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { ROOT_SCOPE, scopeChainOf } from '../../../shared/scope.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    systemPrompt: SystemPrompt
  }
  interface Events {
    'system-prompt/change'(): void
  }
}

export interface PromptSection {
  readonly name: string
  readonly order: number
  readonly text: string
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface SectionEntry {
  readonly scopeId: string
  readonly section: PromptSection
  /** The fiber that registered it; its unload disposes the entry. */
  readonly owner: Context['fiber']
}

export interface PromptAssembly {
  sections: Array<{ name: string; text: string }>
  tools: ToolSchema[]
}

export interface Config {
  persona?: string
}

function compareSections(a: PromptSection, b: PromptSection) {
  return a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export class SystemPrompt extends Service {
  private readonly layers = new Map<string, Map<string, SectionEntry>>()
  private readonly toolProviders = new Set<() => ToolSchema[]>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'systemPrompt')
    this.section({ name: 'deployment:persona', order: 0, text: config.persona ?? 'You are a helpful assistant.' })
  }

  // lesson:section-register
  /**
   * Register a section in the caller's scope. The returned disposer is the
   * caller's Cordis effect, so unloading the caller removes the section.
   */
  section(section: PromptSection): () => void {
    if (!Number.isFinite(section.order)) {
      throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
    }
    const caller = this.ctx
    const scopeId = scopeChainOf(caller).at(-1) ?? ROOT_SCOPE
    return caller.effect(() => {
      const layer = this.layers.get(scopeId) ?? new Map<string, SectionEntry>()
      if (layer.has(section.name)) {
        throw new Error(scopeId === ROOT_SCOPE
          ? `prompt section "${section.name}" is already registered`
          : `prompt section "${section.name}" is already registered in this scope`)
      }
      layer.set(section.name, { scopeId, section, owner: caller.fiber })
      this.layers.set(scopeId, layer)
      caller.emit('system-prompt/change')
      return () => {
        layer.delete(section.name)
        caller.emit('system-prompt/change')
      }
    }, 'systemPrompt.section()')
  }
  // end lesson:section-register

  /** Register a provider of tool schemas visible to every assembly. */
  tools(provider: () => ToolSchema[]): () => void {
    const caller = this.ctx
    return caller.effect(() => {
      this.toolProviders.add(provider)
      caller.emit('system-prompt/change')
      return () => {
        this.toolProviders.delete(provider)
        caller.emit('system-prompt/change')
      }
    }, 'systemPrompt.tools()')
  }

  /** Every registered section, for observation. */
  entries(): SectionEntry[] {
    return [...this.layers.values()].flatMap(layer => [...layer.values()])
  }

  /**
   * Merge the scope chain farthest first so the nearest scope wins a name,
   * then order sections by `order`, then by code-unit name.
   */
  assemble(scopeChain: readonly string[] = [ROOT_SCOPE]): PromptAssembly {
    const byName = new Map<string, PromptSection>()
    for (const scopeId of scopeChain) {
      for (const [name, entry] of this.layers.get(scopeId) ?? []) byName.set(name, entry.section)
    }
    const sections = [...byName.values()].sort(compareSections).map(({ name, text }) => ({ name, text }))
    const tools = [...this.toolProviders]
      .flatMap(provider => provider())
      .map(tool => ({ ...tool, parameters: structuredClone(tool.parameters) }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { sections, tools }
  }
}

/** Drop empty sections and join the rest with blank lines, as upstream renderPrompt does. */
export function renderPrompt(assembly: PromptAssembly): string {
  return assembly.sections.map(section => section.text).filter(text => text.length > 0).join('\n\n')
}

export default SystemPrompt
