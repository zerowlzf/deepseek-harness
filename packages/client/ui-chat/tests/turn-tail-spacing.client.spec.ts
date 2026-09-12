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

describe('composer stats trailing divider', () => {
  // `renderSlot` mounts its own `[data-slot]` anchor even with no entries, so a
  // rendered-node check would draw the divider for every composition. The rule
  // states both halves: hidden by default, shown while the hole has a child.
  it('hides the divider by default and shows it only for an occupied hole', () => {
    const css = read('StatsPills.module.css')
    expect(css).toMatch(/\.trailingRule\s*\{[^}]*display:\s*none/s)
    expect(css).toMatch(
      /\.root:has\(\.trailingProbe > \[data-slot='conversation\.composer\.stats'\] > \*\) \.trailingRule\s*\{[^}]*display:\s*block/s,
    )
    // The wrapper is a pass-through, so the row measures the contribution's own
    // items rather than a box of ours.
    expect(css).toMatch(/\.trailingProbe\s*\{[^}]*display:\s*contents/s)
  })
})
