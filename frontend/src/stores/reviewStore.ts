/**
 * 长势复评状态管理（Pinia）
 * 维护长势筛选条件与复评结论派生值；长势为衰弱 / 濒危时强制填写后续措施。
 */
import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import type { Review, ReviewDraft, Trend, Vigor } from '../types/review'
import { VIGOR_NEED_FOLLOW_UP, VIGOR_OPTIONS } from '../types/review'
import { ROW_REVISION, db, initDatabase, putReview, removeReview } from '../utils/db'
import { nowIso, uuid } from '../utils/id'
import { useTreeStore } from './treeStore'
import { useTransferStore } from './transferStore'

/** 长势复评筛选条件 */
export interface ReviewFilters {
  keyword: string
  treeId: string | 'all'
  vigor: Vigor | 'all'
  trend: Trend | 'all'
}

/** 复评结论校验结果 */
export interface ReviewValidation {
  ok: boolean
  message: string
}

export const useReviewStore = defineStore('review', () => {
  const filters = reactive<ReviewFilters>({ keyword: '', treeId: 'all', vigor: 'all', trend: 'all' })
  const selectedIds = ref<string[]>([])
  const lastMessage = ref('')
  const revision = ref(0)

  /** 长势分布统计，供复评页徽标使用 */
  const vigorStats = computed<Record<Vigor, number>>(() => {
    const result = { 旺盛: 0, 一般: 0, 衰弱: 0, 濒危: 0 } as Record<Vigor, number>
    const treeStore = useTreeStore()
    VIGOR_OPTIONS.forEach((vigor) => {
      result[vigor] = treeStore.reviews.filter((row) => row.vigor === vigor).length
    })
    return result
  })

  /** 长势为衰弱 / 濒危且未填写后续措施的古树数量 */
  const followUpMissing = computed<number>(() => {
    const treeStore = useTreeStore()
    return treeStore.trees.filter((tree) => {
      const list = treeStore.reviews
        .filter((row) => row.treeId === tree.id)
        .sort((a, b) => a.date.localeCompare(b.date))
      const latest = list.length > 0 ? list[list.length - 1] : null
      if (latest === null) return false
      return VIGOR_NEED_FOLLOW_UP.includes(latest.vigor) && latest.followUp.trim() === ''
    }).length
  })

  /** 需要填写后续措施的长势等级 */
  const requireFollowUp = (vigor: Vigor): boolean => VIGOR_NEED_FOLLOW_UP.includes(vigor)

  /** 校验复评表单：衰弱 / 濒危必须填写后续措施 */
  function validate(draft: ReviewDraft): ReviewValidation {
    if (requireFollowUp(draft.vigor) && draft.followUp.trim() === '') {
      return { ok: false, message: `长势为「${draft.vigor}」时必须填写后续措施，否则无法保存。` }
    }
    if (draft.conclusion.trim() === '') {
      return { ok: false, message: '请填写复评结论。' }
    }
    return { ok: true, message: '' }
  }

  async function init(): Promise<void> {
    await initDatabase()
    revision.value += 1
  }

  function setFilters(patch: Partial<ReviewFilters>): void {
    Object.assign(filters, patch)
  }

  function resetFilters(): void {
    filters.keyword = ''
    filters.treeId = 'all'
    filters.vigor = 'all'
    filters.trend = 'all'
    selectedIds.value = []
  }

  function setSelectedIds(ids: string[]): void {
    selectedIds.value = [...ids]
  }

  async function createReview(draft: ReviewDraft): Promise<Review | null> {
    const check = validate(draft)
    if (!check.ok) {
      lastMessage.value = check.message
      return null
    }
    const treeStore = useTreeStore()
    const transferStore = useTransferStore()
    // 冻结期间双方都不能改这株树，新增复评同样拦下
    const lockReason = transferStore.guardTreeWritable(draft.treeId)
    if (lockReason !== null) {
      lastMessage.value = lockReason
      return null
    }
    const tree = treeStore.trees.find((item) => item.id === draft.treeId)
    const ownerUnit = tree?.owner ?? ''
    if (ownerUnit === '') {
      lastMessage.value = '该古树管护单位缺失，请先在档案中落实归属后再登记复评。'
      return null
    }
    const stamp = nowIso()
    const row: Review = {
      id: uuid('review'),
      treeId: draft.treeId,
      date: draft.date,
      vigor: draft.vigor,
      trend: draft.trend,
      conclusion: draft.conclusion.trim(),
      followUp: draft.followUp.trim(),
      // 结论归属：按出具时的管护单位定名，后续管护划转不改写这一归属
      ownerUnit,
      createdAt: stamp,
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await putReview(row)
    revision.value += 1
    lastMessage.value = `已登记 ${row.date} 长势复评：${row.vigor}（${row.trend}），结论归入「${ownerUnit}」名下`
    return row
  }

  async function updateReview(reviewId: string, draft: ReviewDraft): Promise<ReviewValidation> {
    const check = validate(draft)
    if (!check.ok) {
      lastMessage.value = check.message
      return check
    }
    const existing = await db.reviews.get(reviewId)
    if (!existing) return { ok: false, message: '复评记录不存在' }
    const treeStore = useTreeStore()
    const transferStore = useTransferStore()
    const lockReason = transferStore.guardTreeWritable(existing.treeId)
    if (lockReason !== null) {
      lastMessage.value = lockReason
      return { ok: false, message: lockReason }
    }
    const tree = treeStore.trees.find((item) => item.id === existing.treeId)
    const ownerReason = transferStore.guardReviewWritable(existing, tree?.owner ?? '')
    if (ownerReason !== null) {
      lastMessage.value = ownerReason
      return { ok: false, message: ownerReason }
    }
    await putReview({
      ...existing,
      treeId: draft.treeId,
      date: draft.date,
      vigor: draft.vigor,
      trend: draft.trend,
      conclusion: draft.conclusion.trim(),
      followUp: draft.followUp.trim(),
      // ownerUnit 保持定案值，编辑不改归属
      ownerUnit: existing.ownerUnit,
    })
    revision.value += 1
    lastMessage.value = '复评记录已更新（结论归属单位保持不变）'
    return { ok: true, message: '' }
  }

  async function deleteReview(reviewId: string): Promise<boolean> {
    const existing = await db.reviews.get(reviewId)
    if (!existing) return false
    const treeStore = useTreeStore()
    const transferStore = useTransferStore()
    const lockReason = transferStore.guardTreeWritable(existing.treeId)
    if (lockReason !== null) {
      lastMessage.value = lockReason
      return false
    }
    const tree = treeStore.trees.find((item) => item.id === existing.treeId)
    const ownerReason = transferStore.guardReviewWritable(existing, tree?.owner ?? '')
    if (ownerReason !== null) {
      lastMessage.value = ownerReason
      return false
    }
    await removeReview(reviewId)
    selectedIds.value = selectedIds.value.filter((id) => id !== reviewId)
    revision.value += 1
    return true
  }

  async function refreshCounts(): Promise<void> {
    await useTreeStore().refreshCounts()
  }

  return {
    filters,
    selectedIds,
    lastMessage,
    revision,
    vigorStats,
    followUpMissing,
    requireFollowUp,
    validate,
    init,
    setFilters,
    resetFilters,
    setSelectedIds,
    createReview,
    updateReview,
    deleteReview,
    refreshCounts,
  }
})
