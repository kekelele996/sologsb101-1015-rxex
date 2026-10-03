/**
 * 管护划转状态管理（Pinia）
 * 维护划转记录的发起、接手、退回、对账与裁定；划转期间锁定古树，两边不能同时改同一株树。
 */
import { reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { TransferDraft, TransferRecord } from '../types/transfer'
import {
  acceptTransfer,
  initDatabase,
  initiateTransfer,
  rejectTransfer,
  reportMismatch,
} from '../utils/db'
import { useTreeStore } from './treeStore'

export const useTransferStore = defineStore('transfer', () => {
  const lastMessage = ref('')
  const revision = ref(0)
  /** 发起划转的弹窗草稿 */
  const draft = reactive<TransferDraft>({ treeId: '', toOwner: '', note: '' })

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function setDraft(patch: Partial<TransferDraft>): void {
    Object.assign(draft, patch)
  }

  function resetDraft(): void {
    draft.treeId = ''
    draft.toOwner = ''
    draft.note = ''
  }

  /** 发起划转 */
  async function initiate(treeId: string, toOwner: string, note: string): Promise<TransferRecord | null> {
    try {
      const record = await initiateTransfer(treeId, toOwner, note)
      revision.value += 1
      lastMessage.value = `已发起「${record.treeCode}」的管护划转：${record.fromOwner} → ${record.toOwner}`
      await useTreeStore().refreshCounts()
      return record
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '发起划转失败'
      return null
    }
  }

  /** 接手单位确认接手 */
  async function accept(transferId: string): Promise<boolean> {
    try {
      await acceptTransfer(transferId)
      revision.value += 1
      lastMessage.value = '已确认接手，古树及检查 / 措施 / 加固件随树划转'
      await useTreeStore().refreshCounts()
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '接手失败'
      return false
    }
  }

  /** 接手单位退回（没接稳的部分退还原单位继续办） */
  async function reject(transferId: string, reason: string): Promise<boolean> {
    try {
      await rejectTransfer(transferId, reason)
      revision.value += 1
      lastMessage.value = '已退回，古树仍归原单位管护'
      await useTreeStore().refreshCounts()
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '退回失败'
      return false
    }
  }

  /** 两边按树的编号对账，对不上的先摆到档案页等人裁定 */
  async function mismatch(transferId: string, note: string): Promise<boolean> {
    try {
      await reportMismatch(transferId, note)
      revision.value += 1
      lastMessage.value = '已标记为对账对不上，摆在档案页等人裁定'
      await useTreeStore().refreshCounts()
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '标记失败'
      return false
    }
  }

  /** 裁定后接手 */
  async function adjudicateAccept(transferId: string): Promise<boolean> {
    try {
      await acceptTransfer(transferId)
      revision.value += 1
      lastMessage.value = '裁定：确认接手'
      await useTreeStore().refreshCounts()
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '裁定失败'
      return false
    }
  }

  /** 裁定后退回 */
  async function adjudicateReject(transferId: string, reason: string): Promise<boolean> {
    try {
      await rejectTransfer(transferId, reason)
      revision.value += 1
      lastMessage.value = '裁定：退回原单位继续办'
      await useTreeStore().refreshCounts()
      return true
    } catch (err) {
      lastMessage.value = err instanceof Error ? err.message : '裁定失败'
      return false
    }
  }

  return {
    lastMessage,
    revision,
    draft,
    init,
    setDraft,
    resetDraft,
    initiate,
    accept,
    reject,
    mismatch,
    adjudicateAccept,
    adjudicateReject,
  }
})
