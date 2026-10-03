/**
 * 管护责任划转状态管理（Pinia）
 * 维护划转单、对账挂账与「归属回填是否完成」开关；
 * 派生冻结古树集合，供各业务页在写入前做拦截（两边别同时改同一株树）。
 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { liveQuery } from 'dexie'
import type {
  Transfer,
  TransferDraft,
  TransferIssue,
  TransferIssueResolution,
} from '../types/transfer'
import {
  backfillOwnership,
  createHandover,
  handleHandover,
  initDatabase,
  listTransferIssues,
  listTransfers,
  resolveTransferIssue,
  type BackfillResult,
} from '../utils/db'
import { parseCodes } from '../utils/transfer'
import { useTreeStore } from './treeStore'

let subscribed = false

export const useTransferStore = defineStore('transfer', () => {
  const transfers = ref<Transfer[]>([])
  const issues = ref<TransferIssue[]>([])
  const loading = ref(true)
  const ready = ref(false)

  /** 归属回填结果：库内缺归属的数据先按现状回填，之后才启用划转 */
  const backfill = ref<BackfillResult>({
    treesBackfilled: 0,
    reviewsBackfilled: 0,
    unassignedTreeCount: 0,
    hasMissingOwnership: false,
  })

  /** 待接收的划转单（冻结中） */
  const pendingTransfers = computed<Transfer[]>(() =>
    transfers.value.filter((row) => row.state === '待接收')
  )

  /** 冻结中的古树 id → 对应划转单；冻结期间原单位、接手单位都不能改 */
  const lockedMap = computed<Record<string, Transfer>>(() => {
    const map: Record<string, Transfer> = {}
    pendingTransfers.value.forEach((row) => {
      if (row.treeId !== '') map[row.treeId] = row
    })
    return map
  })

  const lockedTreeIds = computed<Set<string>>(() => new Set(Object.keys(lockedMap.value)))

  const pendingIssueCount = computed<number>(
    () => issues.value.filter((row) => row.resolution === '待裁定').length
  )

  /** 归属是否已落实到可启用划转的程度（无空归属且无「未划分」占位古树） */
  const ownershipReady = computed<boolean>(
    () => ready.value && !backfill.value.hasMissingOwnership && backfill.value.unassignedTreeCount === 0
  )

  function transferOfTree(treeId: string): Transfer | null {
    return lockedMap.value[treeId] ?? null
  }

  function isTreeLocked(treeId: string): boolean {
    return lockedMap.value[treeId] !== undefined
  }

  /**
   * 业务页写入前的统一拦截。
   * 返回 null 表示放行；否则返回不能修改的原因，由页面弹消息提示。
   */
  function guardTreeWritable(treeId: string): string | null {
    const transfer = lockedMap.value[treeId]
    if (transfer === undefined) return null
    return `该树正在办理管护划转（批次 ${transfer.batchNo}：${transfer.fromUnit} → ${transfer.toUnit}），待接收/退回期间双方都不能修改。`
  }

  /**
   * 复评结论写入前的归属拦截。
   * 已由原单位定过的结论（review.ownerUnit）不允许接手单位改写：
   * 只有当结论归属单位与该树当前管护单位一致时才放行。
   * 注意：冻结拦截需由调用方先用 guardTreeWritable 处理。
   */
  function guardReviewWritable(review: { ownerUnit: string }, treeOwner: string): string | null {
    if (review.ownerUnit.trim() !== '' && review.ownerUnit !== treeOwner) {
      return `这条长势复评结论由「${review.ownerUnit}」定案并留存在其名下，当前管护单位「${treeOwner}」不能改写。`
    }
    return null
  }

  async function init(): Promise<void> {
    await initDatabase()
    await refreshBackfill()
    if (!subscribed) {
      subscribed = true
      liveQuery(() => listTransfers()).subscribe({
        next: (rows) => {
          transfers.value = rows
          loading.value = false
          ready.value = true
        },
        error: () => {
          loading.value = false
        },
      })
      liveQuery(() => listTransferIssues()).subscribe({
        next: (rows) => {
          issues.value = rows
        },
        error: () => undefined,
      })
    }
  }

  async function refreshBackfill(): Promise<BackfillResult> {
    const result = await backfillOwnership()
    backfill.value = result
    return result
  }

  /** 发起一批划转：先按编号对账，对得上的建单冻结，对不上的挂账 */
  async function createFromDraft(draft: TransferDraft): Promise<{
    batchNo: string
    matched: number
    issueCount: number
  }> {
    if (!ownershipReady.value) {
      throw new Error('管护单位归属尚未回填完成，请先在古树档案中落实管护单位后再发起划转。')
    }
    const codes = parseCodes(draft.codesText)
    const result = await createHandover({
      codes,
      fromUnit: draft.fromUnit,
      toUnit: draft.toUnit,
      date: draft.date,
    })
    await useTreeStore().refreshCounts()
    return { batchNo: result.batchNo, matched: result.transferIds.length, issueCount: result.issueIds.length }
  }

  /** 接手方接收：整棵树跟着走，复评结论留在原单位名下 */
  async function accept(transferId: string, note: string): Promise<void> {
    await handleHandover({ transferId, action: 'accept', note })
    await refreshBackfill()
    await useTreeStore().refreshCounts()
  }

  /** 接手方退回：没接稳的部分退还原单位继续办 */
  async function returnBack(transferId: string, note: string): Promise<void> {
    await handleHandover({ transferId, action: 'return', note })
    await useTreeStore().refreshCounts()
  }

  /** 人工裁定一笔挂账 */
  async function decideIssue(
    issueId: string,
    resolution: Exclude<TransferIssueResolution, '待裁定'>,
    decisionNote: string
  ): Promise<void> {
    await resolveTransferIssue(issueId, resolution, decisionNote)
    await useTreeStore().refreshCounts()
  }

  return {
    transfers,
    issues,
    loading,
    ready,
    backfill,
    ownershipReady,
    pendingTransfers,
    lockedTreeIds,
    pendingIssueCount,
    init,
    refreshBackfill,
    transferOfTree,
    isTreeLocked,
    guardTreeWritable,
    guardReviewWritable,
    createFromDraft,
    accept,
    returnBack,
    decideIssue,
  }
})
