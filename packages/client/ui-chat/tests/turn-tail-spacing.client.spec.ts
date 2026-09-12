/** CSS checks for the completed-turn footer's 20px content spacing. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/client/chat/${name}`, import.meta.url)), 'utf8')

describe('completed-turn spacing', () => {
  it('combines the flow and footer offsets around turn-tail content', () => {
    expect(read('ChatView.module.css')).toMatch(/margin-top:\s*var\(--dsh-chat-flow-gap, 16px\)/)
    const tail = read('TurnTailNodeView.module.css')
    expect(tail).toMatch(/\.root\s*\{[^}]*gap:\s*16px/s)
    expect(tail).toMatch(/\.actions\s*\{[^}]*margin-top:\s*4px/s)
  })
})

describe('composer stats trailing figures', () => {
  // The hole is a flex item of the shipped row, so the row's own 12px gap
  // spaces it and the figures read at the same rhythm as the pills beside them.
  it('spaces a contribution with the row gap rather than a divider of its own', () => {
    const css = read('StatsPills.module.css')
    expect(css).toMatch(/\.root\s*\{[^}]*gap:\s*12px/s)
    expect(css).not.toMatch(/trailingRule|trailingProbe/)
  })
})

describe('completed-turn stats cluster', () => {
  // The pills rebate 6px of the row's 8px gap between themselves; a figure after
  // them rebates the same, so every pair in the row reads at one rhythm. The
  // hole's anchor is `display: contents`, which is why the rule lands on the
  // contribution's own root.
  it('rebates the trailing figure into the stat-pill cluster', () => {
    const css = read('TurnTailNodeView.module.css')
    expect(css).toMatch(
      /\.actions > span \+ \[data-slot='conversation\.chat\.turn-stats'\] > \*\s*\{[^}]*margin-left:\s*-6px/s,
    )
    expect(read('TurnUsagePanel.module.css')).toMatch(/\.root \+ \.root\s*\{[^}]*margin-left:\s*-6px/s)
  })
})
