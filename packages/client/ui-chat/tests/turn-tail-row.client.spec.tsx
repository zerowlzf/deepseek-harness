// @vitest-environment jsdom
/**
 * The completed-turn footer row across both shapes of a Turn's closing
 * evidence: a Turn that answered with text renders the copy/branch chrome
 * beside its tail, and a Turn interrupted before any finalized text still
 * renders the same row (so a tail contribution and the Turn's own usage
 * figures are not dropped) without offering actions that address no message.
 */
import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatConversationViewNode, ChatSnapshot } from '@deepseek-ai/dsh-client-ui-chat/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { TurnTailNodeView } from '../src/client/chat/TurnTailNodeView.tsx'
import { zh } from '../src/client/locale.ts'

const t: React.ComponentProps<typeof TurnTailNodeView>['t'] = makeTranslate(zh, commonZh)

afterEach(() => { cleanup() })

/** The tail shape this row renders from. */
interface Tail {
  readonly turn?: number
  readonly closing?: {
    readonly finalNode: { readonly seq: number; readonly messageId?: string }
    readonly blocks: readonly { readonly kind: string; readonly text: string }[]
    readonly time: number
  }
  readonly tokenUsage?: unknown
  /** Give the Turn recorded start and end events, which is what the time pill reads. */
  readonly timed?: boolean
}

/** One tail node plus the Chat snapshot surface this view reads. */
function bench(tail: Tail, laterTurn = false) {
  const node = nodeOf(tail.turn ?? 1, tail)
  const later = laterTurn ? nodeOf(2, {}) : undefined
  const nodes = (later === undefined ? [node] : [node, later]) as unknown as readonly ChatConversationViewNode[]
  // The Location index reports this Turn's own keys; a Turn with later evidence
  // reports that later key last, which is what makes this node non-tail.
  const keyOf = (turn: number): readonly string[] =>
    turn === 1 && laterTurn
      ? [node.key, later!.key]
      : nodes.filter(candidate => candidate.location.kind === 'turn'
        && candidate.location.turn.turn === turn).map(candidate => candidate.key)
  const snapshot = {
    nodes: { values: () => nodes },
    locations: { getTurn: (turn: number) => keyOf(turn) },
    timeline: { turnOrder: laterTurn ? [1, 2] : [1] },
  } as unknown as ChatSnapshot
  return { node, useChat: (<T,>(select: (value: ChatSnapshot) => T): T => select(snapshot)) }
}

/** One tail node whose data carries the Turn number (`data.turn`), plus its location. */
function nodeOf(turn: number, tail: Tail): ChatConversationViewNode {
  return {
    key: `turn-tail-${String(turn)}`,
    kind: 'turn-tail',
    anchorSeq: turn * 5,
    location: {
      kind: 'turn',
      turn: {
        turn,
        ...tail.timed === true
          ? { start: { time: 1_000 }, end: { time: 4_000 } }
          : {},
      },
    },
    data: {
      turn,
      seq: turn * 5,
      time: turn * 5_000,
      closing: tail.closing ?? null,
      branchUnavailable: false,
      ...(tail.tokenUsage === undefined ? {} : { tokenUsage: tail.tokenUsage }),
    },
  } as unknown as ChatConversationViewNode
}

/** Render one tail node view over a stub chain. */
function renderTail(
  tail: Tail,
  chain: (owner: unknown) => React.ReactNode = () => <b>tail</b>,
  laterTurn = false,
  slot: (key: string, owner: unknown) => React.ReactNode = () => null,
) {
  const fixture = bench(tail, laterTurn)
  return render(
    <TurnTailNodeView
      {...({
        node: fixture.node,
        openFile: vi.fn(),
        forkAt: vi.fn(),
        inspectCall: vi.fn(),
        useChat: fixture.useChat,
        useTurnData: (() => undefined) as never,
        renderSlot: ((key: string, owner: unknown) => slot(key, owner)) as never,
        renderSlotChain: ((_key: string, owner: unknown) => chain(owner)) as never,
        t,
      } as unknown as React.ComponentProps<typeof TurnTailNodeView>)}
    />,
  )
}

const CLOSING = {
  finalNode: { seq: 4, messageId: 'm1' },
  blocks: [{ kind: 'text', text: 'answer' }],
  time: 4_000,
} as const

describe('completed-turn footer row', () => {
  it('renders the closing-message actions beside the tail', () => {
    const view = renderTail({ closing: CLOSING })
    expect(view.container.querySelector('[data-turn-tail]')).not.toBeNull()
    // Copy plus the branch action a closing message makes addressable.
    expect(screen.getByLabelText('复制')).toBeDefined()
    expect(screen.getByLabelText('在新对话中分支')).toBeDefined()
  })

  it('renders the row for an interrupted turn without addressing a message', () => {
    const view = renderTail({})
    const row = view.container.querySelector('[data-turn-tail]')
    expect(row).not.toBeNull()
    // The tail contribution survives; copy stays as chrome but unavailable, and
    // no branch action appears because there is no closing message to fork.
    expect(row?.textContent).toContain('tail')
    expect(screen.queryByLabelText('在新对话中分支')).toBeNull()
    const copy = screen.getByLabelText('复制')
    expect(copy.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(copy)
    expect(screen.getByLabelText('复制').getAttribute('aria-disabled')).toBe('true')
  })

  it('keeps an interrupted turn that carries accounting, whose row is the usage strip', () => {
    // An interrupted turn has no copyable answer and no branch target, but its
    // accounting is exactly what the strip exists to show, so the row stays.
    const view = renderTail({ tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      () => null)
    expect(view.container.querySelector('[data-turn-tail]')).not.toBeNull()
    // Nothing to branch to and nothing to copy, so both controls stay absent or
    // unavailable; the row is there for the figures beside them.
    expect(view.container.querySelector('[aria-label="复制"]')?.getAttribute('aria-disabled')).toBe('true')
  })

  it('still drops an interrupted turn whose only content would be the shipped chrome', () => {
    // Nothing to copy, nothing to branch, no accounting: an empty action strip.
    const view = renderTail({}, () => null)
    expect(view.container.querySelector('[data-turn-tail]')).toBeNull()
  })

  it('keeps that same turn row once a contribution arrives', () => {
    const view = renderTail({ tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 } })
    const row = view.container.querySelector('[data-turn-tail]')
    expect(row).not.toBeNull()
    expect(row?.textContent).toContain('tail')
    expect(screen.getByLabelText('复制').getAttribute('aria-disabled')).toBe('true')
  })

  it('drops a turn with neither a closing message nor a tail contribution', () => {
    const view = renderTail({}, () => null)
    expect(view.container.querySelector('[data-turn-tail]')).toBeNull()
    expect(view.container.innerHTML).toBe('')
  })

  it('keeps that same turn row once a later turn makes it a non-tail node', () => {
    const view = renderTail({}, () => null, true)
    expect(view.container.querySelector('[data-turn-tail]')).not.toBeNull()
  })

  it('renders the trailing figures after the usage and time pills', () => {
    const slot = vi.fn((key: string, _owner: unknown) =>
      key === 'conversation.chat.turn-stats' ? <b>cost</b> : null)
    renderTail(
      { closing: CLOSING, timed: true, tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      () => null,
      false,
      slot,
    )
    // The hole takes the row's owner share, which is the Turn the figures belong to.
    const owners = slot.mock.calls.map(([, owner]) => owner as { turn?: { turn?: number } })
    expect(owners[0]?.turn?.turn).toBe(1)
    const row = screen.getByLabelText('复制').parentElement!
    const figures = screen.getByText('cost')
    // The contribution is part of the action row itself, and it reads after the
    // shipped figures: usage, then duration, then what the turn cost.
    expect(row.contains(figures)).toBe(true)
    const text = row.textContent ?? ''
    expect(text.indexOf('用量')).toBeLessThan(text.indexOf('用时'))
    expect(text.indexOf('用时')).toBeLessThan(text.indexOf('cost'))
  })
})
