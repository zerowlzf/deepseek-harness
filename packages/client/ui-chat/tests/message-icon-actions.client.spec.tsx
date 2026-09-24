// @vitest-environment jsdom

/**
 * The message action row's end-info cluster: the shipped clock, the Turn-usage
 * trigger, and the readings plugins contribute between them.
 */
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { ChatViewSlotProps } from '../src/client/contract/slots.ts'
import { MessageIconActions } from '../src/client/chat/MessageIconActions.tsx'
import { zh } from '../src/client/locale.ts'

const t: ChatViewSlotProps['t'] = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
})

describe('message icon actions', () => {
  it('seats a contributed Turn reading between the usage trigger and the clock', () => {
    render(
      <MessageIconActions
        text="answer"
        time={Date.UTC(2026, 8, 24, 3, 22)}
        clock="end"
        usageAction={<span data-testid="usage">usage</span>}
        endReadings={<span data-testid="reading">cost</span>}
        t={t}
      />,
    )
    const usage = screen.getByTestId('usage')
    const cluster = usage.parentElement as HTMLElement
    // The reading states a figure the Turn's accounting already holds, so it
    // belongs to the end-info cluster: after the usage trigger, before the clock,
    // and never inside the control cluster the branch action closes.
    expect([...cluster.children].map(node => node.getAttribute('data-testid') ?? 'clock'))
      .toEqual(['usage', 'reading', 'clock'])
    expect(cluster.children[1]?.textContent).toBe('cost')
  })

  it('leaves the cluster as usage and clock when nothing contributes a reading', () => {
    render(
      <MessageIconActions
        text="answer"
        time={Date.UTC(2026, 8, 24, 3, 22)}
        clock="end"
        usageAction={<span data-testid="usage">usage</span>}
        t={t}
      />,
    )
    const usage = screen.getByTestId('usage')
    const cluster = usage.parentElement as HTMLElement
    expect([...cluster.children].map(node => node.getAttribute('data-testid') ?? 'clock'))
      .toEqual(['usage', 'clock'])
  })

  it('keeps a user clock ahead of the icons', () => {
    render(
      <MessageIconActions
        text="prompt"
        time={Date.UTC(2026, 8, 24, 3, 22)}
        clock="start"
        t={t}
      />,
    )
    // A user row leads with its clock and carries no end-info cluster: the
    // readings seat belongs to the completed-Turn row alone.
    const row = document.querySelector('[data-clock="start"]') as HTMLElement
    expect(row.firstElementChild?.className).toContain('timeStart')
    expect(row.children[1]?.tagName).toBe('BUTTON')
  })
})
