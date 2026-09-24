import { memo } from 'react'
import type { InjectFace, PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNodeViewProps, PerformanceUsageInjected, TurnTailOwnerProps } from '../contract/slots.ts'
import { MessageIconActions } from './MessageIconActions.tsx'
import { TurnUsagePanel } from './TurnUsagePanel.tsx'
import { assistantText } from './turn-assistant.ts'
import { hasAssistantReplyContent } from '../contract/assistant-content.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatSnapshot } from '../contract/snapshot.ts'
import css from './TurnTailNodeView.module.css'

type TurnTailNodeViewProps = ChatNodeViewProps<'turn-tail'>
  & PropsRenderSlots<
    'conversation.chat.turnTail' | 'conversation.chat.turn-stats' | 'conversation.chat.assistant-actions'
  >
  & InjectFace<PerformanceUsageInjected>

function lastContent(snapshot: ChatSnapshot, turn: number, skipWarning: boolean): ChatNode | undefined {
  const keys = snapshot.locations.getTurn(turn)
  for (let index = keys.length - 1; index >= 0; index--) {
    const node = snapshot.nodes.get(keys[index] as string) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-tail' || node.kind === 'turn-process'
      || (skipWarning && node.kind === 'turn-max-tokens')) continue
    return node
  }
  return undefined
}

/** Turn-local actions and feature tail over the Location index, independent of Assistant placement. */
export const TurnTailNodeView = memo(function TurnTailNodeView({
  node, openFile, forkAt, renderSlot, t, useChat, usePerformanceUsage,
}: TurnTailNodeViewProps) {
  const detailed = usePerformanceUsage(mode => mode) === 'detailed'
  const data = node.data
  const hasLaterChatNode = useChat(snapshot =>
    (lastContent(snapshot, data.turn, true)?.anchorSeq ?? -1) > (data.closing?.finalNode.seq ?? data.seq))
  const endsWithResponse = useChat((snapshot) => {
    if (snapshot.timeline.turnOrder.at(-1) !== data.turn) return false
    const last = lastContent(snapshot, data.turn, false)
    const block = last?.kind === 'assistant-step' ? last.data.blocks.findLast(candidate =>
      (candidate.kind !== 'text' && candidate.kind !== 'reasoning') || candidate.text.trim() !== '') : undefined
    return block !== undefined && hasAssistantReplyContent([block])
  })
  const turn = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  if (turn === undefined) return null
  const closing = data.closing
  const owner: TurnTailOwnerProps = { turn, seq: closing?.finalNode.seq ?? data.seq, openFile }
  const tail = renderSlot('conversation.chat.turnTail', owner)
  // The row's own trailing figures, kept apart from the chain above: the chain
  // elects one entry for the line before the row, while every contribution here
  // renders, so figures a reader wants beside the usage pills are never dropped
  // for the files row a Turn may also have produced.
  const stats = renderSlot('conversation.chat.turn-stats', owner)
  // Interruption-frozen partials carry no messageId, so they address no
  // durable message and contribute no per-message actions.
  const messageId = closing?.finalNode.messageId
  const assistantActions = messageId === undefined
    ? null
    : renderSlot('conversation.chat.assistant-actions', { messageId })
  // A Turn interrupted before any finalized text still owns the same accounting
  // and the same extension tail, so its row renders without the closing-message
  // actions instead of dropping both. `hasLaterChatNode` is a snapshot read, so
  // the hook keeps running for every arm.
  const hasAccountedUsage = data.tokenUsage !== undefined
  const rendersRow = closing !== null || tail !== null || hasAccountedUsage || hasLaterChatNode
  if (!rendersRow) return null

  return (
    <div
      className={css.root}
      data-turn-tail={data.turn}
      data-actions-reveal={endsWithResponse ? 'always' : 'hover'}
    >
      {tail}
      <MessageIconActions
        text={closing === null ? '' : assistantText(closing.blocks)}
        time={closing?.time}
        clock="end"
        // The branch action owns boundary resolution: it sends the real
        // turn/end seq it already has, and the Host cuts exactly there. An
        // interrupted Turn has no closing message to address, so the branch
        // control is withheld rather than pointing at a settled boundary.
        {...closing === null ? {} : { onBranch: () => { forkAt(data.seq) } }}
        branchUnavailable={data.branchUnavailable || hasLaterChatNode}
        className={css.actions}
        extraActions={assistantActions}
        usageAction={detailed && data.tokenUsage !== undefined
          ? <TurnUsagePanel usage={data.tokenUsage} t={t} />
          : null}
        statsAction={stats}
        t={t}
      />
    </div>
  )
})
