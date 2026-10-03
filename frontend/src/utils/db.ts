/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import { UNASSIGNED_OWNER } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type {
  Transfer,
  TransferIssue,
  TransferIssueResolution,
  TransferState,
} from '../types/transfer'
import { nowIso, today } from './id'
import { seedDatabase } from './seed'

/** 数据库名 */
export const DB_NAME = 'gbheritagetree'

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 3

/** 数据行结构修订号 */
export const ROW_REVISION = 3

class HeritageTreeDatabase extends Dexie {
  trees!: Table<Tree, string>
  surveys!: Table<Survey, string>
  measures!: Table<Measure, string>
  supports!: Table<Support, string>
  reviews!: Table<Review, string>
  transfers!: Table<Transfer, string>
  transferIssues!: Table<TransferIssue, string>

  constructor() {
    super(DB_NAME)

    // ---------- v1：初版结构 ----------
    this.version(1).stores({
      trees: 'id, code, species, protectLevel, ageYears, createdAt',
      surveys: 'id, treeId, date',
      measures: 'id, treeId, type, state, date',
      supports: 'id, treeId, type, installDate',
      reviews: 'id, treeId, date, vigor',
    })

    // ---------- v2：补齐索引与回写字段，并迁移历史数据 ----------
    this.version(2)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        // 复合索引 [treeId+date]：按古树 + 日期快速取检查记录
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend',
      })
      .upgrade(async (tx) => {
        // 迁移 1：补齐 revision / createdAt / updatedAt
        const tables = [
          tx.table('trees'),
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of tables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
            if (typeof row.createdAt !== 'string') row.createdAt = nowIso()
            if (typeof row.updatedAt !== 'string') row.updatedAt = row.createdAt
          })
        }
        // 迁移 2：古树补齐「最近复壮日期」
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastMeasureDate !== 'string') row.lastMeasureDate = ''
        })
        // 迁移 3：复评补齐「后续措施」
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.followUp !== 'string') row.followUp = ''
        })
        // 迁移 4：加固件补齐「最近检查日期」
        await tx.table('supports').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.lastCheckDate !== 'string') row.lastCheckDate = ''
          if (typeof row.checkCycleMon !== 'number') row.checkCycleMon = 12
        })
      })

    // ---------- v3：管护责任划转 ----------
    // - 新增 transfers / transferIssues 两张表；
    // - reviews 补 ownerUnit 索引（复评结论的归属单位，定案后不随划转改写）；
    // - 老数据缺归属时先按现状回填（古树 owner、复评 ownerUnit），回填后才允许启用划转。
    this.version(DB_SCHEMA_VERSION)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner',
        surveys: 'id, treeId, [treeId+date], date, siteNote',
        measures: 'id, treeId, type, state, date, operator',
        supports: 'id, treeId, type, installDate, lastCheckDate',
        reviews: 'id, treeId, date, vigor, trend, ownerUnit',
        transfers: 'id, batchNo, treeId, treeCode, state, date',
        transferIssues: 'id, batchNo, treeId, kind, resolution',
      })
      .upgrade(async (tx) => {
        // 先按现状回填古树管护单位，并建立 treeId → owner 映射
        const ownerById = new Map<string, string>()
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.owner !== 'string' || row.owner.trim() === '') {
            row.owner = UNASSIGNED_OWNER
          }
          ownerById.set(String(row.id), String(row.owner))
          row.revision = ROW_REVISION
          row.updatedAt = nowIso()
        })
        // 复评结论归属：按出具结论时的现状挂到管护单位名下；历史结论永不被划转改写
        await tx.table('reviews').toCollection().modify((row: Record<string, unknown>) => {
          if (typeof row.ownerUnit !== 'string' || row.ownerUnit.trim() === '') {
            row.ownerUnit = ownerById.get(String(row.treeId)) ?? UNASSIGNED_OWNER
          }
          row.revision = ROW_REVISION
        })
        // 其余表行修订号统一推进
        for (const name of ['surveys', 'measures', 'supports']) {
          await tx.table(name).toCollection().modify((row: Record<string, unknown>) => {
            row.revision = ROW_REVISION
          })
        }
      })
  }
}

export const db = new HeritageTreeDatabase()

/* ------------------------------ 初始化与播种 ------------------------------ */

let initPromise: Promise<void> | null = null

/**
 * 打开数据库并在首屏自动播种演示数据（幂等：仅当主表为空时播种）。
 * 多次调用共用同一个 Promise，避免并发重复播种。
 */
export function initDatabase(): Promise<void> {
  if (initPromise === null) {
    initPromise = (async (): Promise<void> => {
      await db.open()
      // 库里已有数据缺归属时：打开先按现状回填管护单位，之后才允许启用划转（幂等）。
      await backfillOwnership()
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
        await backfillOwnership()
      }
    })()
  }
  return initPromise
}

/* -------------------------- 归属回填（启用划转前置） -------------------------- */

export interface BackfillResult {
  /** 本次补填的古树数（owner 原本为空） */
  treesBackfilled: number
  /** 本次补填的复评结论数（ownerUnit 原本为空） */
  reviewsBackfilled: number
  /** 当前仍挂在「未划分」占位单位下、需要人工落实归属的古树数 */
  unassignedTreeCount: number
  /** 是否还有复评结论未落实归属单位 */
  hasMissingOwnership: boolean
}

/**
 * 按现状回填管护单位（幂等）：
 * - 古树 owner 缺失 → 回填为 UNASSIGNED_OWNER 占位；
 * - 复评 ownerUnit 缺失 → 回填为该树当前 owner（复评结论归在出具方名下）。
 * 每次打开库与导入存档后都跑一遍，确保划转功能不会在缺归属的数据上启用。
 */
export async function backfillOwnership(): Promise<BackfillResult> {
  return db.transaction('rw', db.trees, db.reviews, async () => {
    let treesBackfilled = 0
    let reviewsBackfilled = 0
    const trees = await db.trees.toArray()
    const ownerById = new Map<string, string>()
    for (const tree of trees) {
      const owner = tree.owner.trim() === '' ? UNASSIGNED_OWNER : tree.owner
      ownerById.set(tree.id, owner)
      if (owner !== tree.owner) {
        treesBackfilled += 1
        await db.trees.update(tree.id, { owner, updatedAt: nowIso(), revision: ROW_REVISION })
      }
    }
    const reviews = await db.reviews.toArray()
    for (const review of reviews) {
      if (review.ownerUnit.trim() !== '') continue
      reviewsBackfilled += 1
      await db.reviews.update(review.id, {
        ownerUnit: ownerById.get(review.treeId) ?? UNASSIGNED_OWNER,
        updatedAt: nowIso(),
        revision: ROW_REVISION,
      })
    }
    const [finalTrees, finalReviews] = await Promise.all([db.trees.toArray(), db.reviews.toArray()])
    const unassignedTreeCount = finalTrees.filter((tree) => tree.owner === UNASSIGNED_OWNER).length
    const hasMissingOwnership =
      finalTrees.some((tree) => tree.owner.trim() === '') ||
      finalReviews.some((row) => row.ownerUnit.trim() === '')
    return { treesBackfilled, reviewsBackfilled, unassignedTreeCount, hasMissingOwnership }
  })
}

/* -------------------------------- 古树 -------------------------------- */

export async function listTrees(): Promise<Tree[]> {
  const rows = await db.trees.toArray()
  return rows.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN'))
}

export async function getTree(id: string): Promise<Tree | undefined> {
  return db.trees.get(id)
}

export async function putTree(row: Tree): Promise<void> {
  await db.trees.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

/** 删除古树并级联清理其检查、措施、加固与复评记录 */
export async function removeTree(id: string): Promise<void> {
  await db.transaction('rw', db.trees, db.surveys, db.measures, db.supports, db.reviews, async () => {
    await db.surveys.where('treeId').equals(id).delete()
    await db.measures.where('treeId').equals(id).delete()
    await db.supports.where('treeId').equals(id).delete()
    await db.reviews.where('treeId').equals(id).delete()
    await db.trees.delete(id)
  })
}

/* ------------------------------ 树体检查 ------------------------------ */

export async function listSurveys(): Promise<Survey[]> {
  const rows = await db.surveys.toArray()
  return rows.sort((a, b) => a.treeId.localeCompare(b.treeId) || a.date.localeCompare(b.date))
}

export async function listSurveysByTree(treeId: string): Promise<Survey[]> {
  const rows = await db.surveys.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putSurvey(row: Survey): Promise<void> {
  await db.surveys.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSurvey(id: string): Promise<void> {
  await db.surveys.delete(id)
}

/* ------------------------------ 复壮措施 ------------------------------ */

export async function listMeasures(): Promise<Measure[]> {
  const rows = await db.measures.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listMeasuresByTree(treeId: string): Promise<Measure[]> {
  const rows = await db.measures.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

/**
 * 写入复壮措施。
 * 措施状态为「已完成」时，回写古树的最近复壮日期（仅当本次日期更新时）。
 */
export async function putMeasure(row: Measure): Promise<void> {
  await db.transaction('rw', db.trees, db.measures, async () => {
    await db.measures.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
    if (row.state !== '已完成') return
    const tree = await db.trees.get(row.treeId)
    if (!tree) return
    if (tree.lastMeasureDate >= row.date) return
    await db.trees.update(tree.id, { lastMeasureDate: row.date, updatedAt: nowIso() })
  })
}

export async function removeMeasure(id: string): Promise<void> {
  await db.measures.delete(id)
}

/** 批量修改措施状态；改为「已完成」时同步回写古树最近复壮日期 */
export async function batchSetMeasureState(ids: string[], state: MeasureState): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db.measures.bulkGet(ids)
  const list = rows.filter((row): row is Measure => row !== undefined)
  for (const row of list) {
    await putMeasure({ ...row, state })
  }
  return list.length
}

/* ------------------------------ 加固件 ------------------------------ */

export async function listSupports(): Promise<Support[]> {
  const rows = await db.supports.toArray()
  return rows.sort((a, b) => a.installDate.localeCompare(b.installDate))
}

export async function listSupportsByTree(treeId: string): Promise<Support[]> {
  return db.supports.where('treeId').equals(treeId).toArray()
}

export async function putSupport(row: Support): Promise<void> {
  await db.supports.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeSupport(id: string): Promise<void> {
  await db.supports.delete(id)
}

/** 登记本次检查：把最近检查日期置为给定日期（默认今天） */
export async function markSupportChecked(id: string, date = today()): Promise<void> {
  await db.supports.update(id, { lastCheckDate: date, updatedAt: nowIso() })
}

/* ------------------------------ 长势复评 ------------------------------ */

export async function listReviews(): Promise<Review[]> {
  const rows = await db.reviews.toArray()
  return rows.sort((a, b) => b.date.localeCompare(a.date))
}

export async function listReviewsByTree(treeId: string): Promise<Review[]> {
  const rows = await db.reviews.where('treeId').equals(treeId).toArray()
  return rows.sort((a, b) => a.date.localeCompare(b.date))
}

export async function putReview(row: Review): Promise<void> {
  await db.reviews.put({ ...row, updatedAt: nowIso(), revision: ROW_REVISION })
}

export async function removeReview(id: string): Promise<void> {
  await db.reviews.delete(id)
}

/* ---------------------------- 管护责任划转 ---------------------------- */

export async function listTransfers(): Promise<Transfer[]> {
  const rows = await db.transfers.toArray()
  return rows.sort((a, b) =>
    a.batchNo === b.batchNo
      ? a.treeCode.localeCompare(b.treeCode, 'zh-Hans-CN')
      : b.batchNo.localeCompare(a.batchNo, 'zh-Hans-CN')
  )
}

export async function listTransferIssues(): Promise<TransferIssue[]> {
  const rows = await db.transferIssues.toArray()
  return rows.sort((a, b) =>
    a.resolution === b.resolution
      ? b.createdAt.localeCompare(a.createdAt)
      : a.resolution === '待裁定'
        ? -1
        : b.resolution === '待裁定'
          ? 1
          : b.createdAt.localeCompare(a.createdAt)
  )
}

/** 取下一批次号：HF-YYYYMMDD-NN（同日序号两位） */
async function nextBatchNo(date: string): Promise<string> {
  const prefix = `HF-${date.replace(/-/g, '')}-`
  const all = await db.transfers.toCollection().primaryKeys()
  const issueKeys = await db.transferIssues.toCollection().primaryKeys()
  let max = 0
  for (const key of [...all, ...issueKeys]) {
    const id = String(key)
    const idx = id.indexOf(prefix)
    if (idx === -1) continue
    const tail = id.slice(idx + prefix.length)
    const num = parseInt(tail.split('-')[0] ?? '', 10)
    if (!Number.isNaN(num) && num > max) max = num
  }
  return `${prefix}${String(max + 1).padStart(2, '0')}`
}

export interface CreateHandoverInput {
  codes: string[]
  fromUnit: string
  toUnit: string
  date: string
}

export interface CreateHandoverResult {
  batchNo: string
  transferIds: string[]
  issueIds: string[]
}

/**
 * 按编号对账后发起一批划转（一事务）。
 * - 编号两边对得上且当前管护单位确为移交方 → 建「待接收」划转单，整株树随之冻结；
 * - 清单有、档案无 / 归属单位对不上 / 该树已有未结划转 → 挂账，等人工裁定，不移动树木；
 * - 整棵树（树体检查、复壮措施、加固件）随树走，子记录不复制不改 owner；
 * - 历史长势复评结论一行不动，继续记在其原归属单位（review.ownerUnit）名下。
 */
export async function createHandover(input: CreateHandoverInput): Promise<CreateHandoverResult> {
  const fromUnit = input.fromUnit.trim()
  const toUnit = input.toUnit.trim()
  if (fromUnit === '' || toUnit === '') throw new Error('请填写移交单位与接手单位')
  if (fromUnit === toUnit) throw new Error('移交单位与接手单位不能相同')
  if (input.codes.length === 0) throw new Error('移交清单为空：请先填写古树编号')

  return db.transaction('rw', db.trees, db.transfers, db.transferIssues, async () => {
    const trees = await db.trees.toArray()
    const byCode = new Map<string, Tree>()
    trees.forEach((tree) => {
      if (!byCode.has(tree.code)) byCode.set(tree.code, tree)
    })
    // 已经在冻结中的树不允许重复发起，避免两边同时改同一株树
    const pending = await db.transfers.where('state').equals('待接收').toArray()
    const pendingTreeIds = new Set(pending.map((row) => row.treeId))

    const batchNo = await nextBatchNo(input.date)
    const stamp = nowIso()
    const transfers: Transfer[] = []
    const issues: TransferIssue[] = []
    let seq = 0

    for (const code of input.codes) {
      seq += 1
      const suffix = String(seq).padStart(3, '0')
      const tree = byCode.get(code)
      if (tree === undefined) {
        issues.push({
          id: `tissue-${batchNo}-${suffix}`,
          batchNo,
          treeCode: code,
          kind: '档案无此编号',
          treeId: '',
          fromUnit,
          toUnit,
          detail: '移交清单列有该编号，但古树档案中查无此树，暂不划转。',
          resolution: '待裁定',
          decisionNote: '',
          decidedAt: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        })
        continue
      }
      if (pendingTreeIds.has(tree.id)) {
        issues.push({
          id: `tissue-${batchNo}-${suffix}`,
          batchNo,
          treeCode: code,
          kind: '归属与清单不符',
          treeId: tree.id,
          fromUnit,
          toUnit,
          detail: '该树已有一笔待接收的划转未结，需等接收或退回后再办，暂不重复划转。',
          resolution: '待裁定',
          decisionNote: '',
          decidedAt: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        })
        continue
      }
      if (tree.owner !== fromUnit) {
        issues.push({
          id: `tissue-${batchNo}-${suffix}`,
          batchNo,
          treeCode: code,
          kind: '归属与清单不符',
          treeId: tree.id,
          fromUnit,
          toUnit,
          detail: `清单记载移交方为「${fromUnit}」，档案现状管护单位为「${tree.owner}」，归属对不上，暂不划转。`,
          resolution: '待裁定',
          decisionNote: '',
          decidedAt: '',
          createdAt: stamp,
          updatedAt: stamp,
          revision: ROW_REVISION,
        })
        continue
      }
      transfers.push({
        id: `transfer-${batchNo}-${suffix}`,
        batchNo,
        treeCode: code,
        treeId: tree.id,
        fromUnit,
        toUnit,
        date: input.date,
        state: '待接收',
        handledAt: '',
        note: '',
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
    }

    if (transfers.length === 0 && issues.length === 0) {
      throw new Error('没有可入账的编号')
    }
    await db.transfers.bulkPut(transfers)
    await db.transferIssues.bulkPut(issues)
    return {
      batchNo,
      transferIds: transfers.map((row) => row.id),
      issueIds: issues.map((row) => row.id),
    }
  })
}

export interface HandleTransferInput {
  transferId: string
  /** 接收 → 已接收；退回 → 已退回 */
  action: 'accept' | 'return'
  note?: string
}

/**
 * 接手方处理一笔划转：
 * - 接收：整棵树跟着走，只把古树管护单位改成接手单位；树体检查 / 措施 / 加固件随树仍在；
 *   历史复评结论的 ownerUnit 一律不改，继续留在原单位名下；
 * - 退回：接手方没接稳的部分退还原单位继续办，owner 保持为原单位，仅记录退回状态。
 * 两个动作都把冻结解除，避免两边长期不能改同一株树。
 */
export async function handleHandover(input: HandleTransferInput): Promise<Transfer> {
  return db.transaction('rw', db.trees, db.transfers, db.reviews, async () => {
    const transfer = await db.transfers.get(input.transferId)
    if (!transfer) throw new Error('划转单不存在或已被删除')
    if (transfer.state !== '待接收') throw new Error(`该划转单已为「${transfer.state}」，不能重复处理`)

    const tree = await db.trees.get(transfer.treeId)
    if (!tree) throw new Error('划转关联的古树档案已不存在')

    const nextState: TransferState = input.action === 'accept' ? '已接收' : '已退回'
    const stamp = nowIso()
    if (input.action === 'accept') {
      // 只改档案的当前管护单位；reviews.ownerUnit 保持不动 → 原结论留原单位名下
      await db.trees.update(tree.id, {
        owner: transfer.toUnit,
        updatedAt: stamp,
        revision: ROW_REVISION,
      })
    }
    const updated: Transfer = {
      ...transfer,
      state: nextState,
      handledAt: today(),
      note: (input.note ?? '').trim(),
      updatedAt: stamp,
      revision: ROW_REVISION,
    }
    await db.transfers.put(updated)
    return updated
  })
}

/** 裁定一笔对账挂账 */
export async function resolveTransferIssue(
  issueId: string,
  resolution: Exclude<TransferIssueResolution, '待裁定'>,
  decisionNote: string
): Promise<void> {
  await db.transaction('rw', db.transferIssues, db.trees, db.transfers, async () => {
    const issue = await db.transferIssues.get(issueId)
    if (!issue) throw new Error('挂账记录不存在')
    if (issue.resolution !== '待裁定') throw new Error('该挂账已裁定，不能重复裁定')
    if (resolution === '并入移交') {
      if (issue.treeId === '') {
        throw new Error('档案中查无此树，不能直接并入移交；请先在档案页补档或裁定为不移交')
      }
      const tree = await db.trees.get(issue.treeId)
      if (!tree) throw new Error('关联古树已不存在')
      const pending = await db.transfers.where('state').equals('待接收').toArray()
      if (pending.some((row) => row.treeId === tree.id)) {
        throw new Error('该树已有待接收划转，不能重复并入')
      }
      const stamp = nowIso()
      // 以档案现状归属为准移交；挂账批次沿用，便于追溯
      const transfer: Transfer = {
        id: `transfer-${issue.batchNo}-r${issueId.slice(-3)}`,
        batchNo: issue.batchNo,
        treeCode: tree.code,
        treeId: tree.id,
        fromUnit: tree.owner,
        toUnit: issue.toUnit,
        date: today(),
        state: '待接收',
        handledAt: '',
        note: `挂账裁定并入：${decisionNote || issue.detail}`,
        createdAt: stamp,
        updatedAt: stamp,
        revision: ROW_REVISION,
      }
      await db.transfers.put(transfer)
    }
    await db.transferIssues.update(issueId, {
      resolution,
      decisionNote: decisionNote.trim(),
      decidedAt: today(),
      updatedAt: nowIso(),
      revision: ROW_REVISION,
    })
  })
}

/* ---------------------------- 整库快照 ---------------------------- */

export interface DatabaseSnapshot {
  name: string
  schemaVersion: number
  exportedAt: string
  trees: Tree[]
  surveys: Survey[]
  measures: Measure[]
  supports: Support[]
  reviews: Review[]
  transfers: Transfer[]
  transferIssues: TransferIssue[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, transfers, transferIssues] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.transfers.toArray(),
    db.transferIssues.toArray(),
  ])
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    trees,
    surveys,
    measures,
    supports,
    reviews,
    transfers,
    transferIssues,
  }
}

/** 用快照覆盖整库（导入存档）；导入后同样先回填归属，再恢复划转状态 */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers, db.transferIssues],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.transfers.clear(),
        db.transferIssues.clear(),
      ])
      await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
      await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
      // 旧版存档没有划转表时按空集处理
      await db.transfers.bulkPut(
        (snapshot.transfers ?? []).map((row) => ({ ...row, revision: ROW_REVISION }))
      )
      await db.transferIssues.bulkPut(
        (snapshot.transferIssues ?? []).map((row) => ({ ...row, revision: ROW_REVISION }))
      )
    }
  )
  // 导入数据可能缺归属：打开/导入都先按现状回填，之后才能启用划转
  await backfillOwnership()
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers, db.transferIssues],
    async () => {
      await Promise.all([
        db.trees.clear(),
        db.surveys.clear(),
        db.measures.clear(),
        db.supports.clear(),
        db.reviews.clear(),
        db.transfers.clear(),
        db.transferIssues.clear(),
      ])
    }
  )
  await seedDatabase()
  await backfillOwnership()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, transfers, transferIssues] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.transfers.count(),
    db.transferIssues.count(),
  ])
  return { trees, surveys, measures, supports, reviews, transfers, transferIssues }
}
