/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名：gbheritagetree
 * - 含数据结构版本号与 v1 → v2 升级迁移逻辑（升级时按 version().stores() 补齐索引）
 * - 提供各表增删改查、整库快照导入导出与重置
 * 纯前端应用：不依赖任何后端服务或外部接口。
 */
import Dexie, { type Table } from 'dexie'
import type { Tree } from '../types/tree'
import type { Survey } from '../types/survey'
import type { Measure, MeasureState } from '../types/measure'
import type { Support } from '../types/support'
import type { Review } from '../types/review'
import type { TransferRecord } from '../types/transfer'
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
  transfers!: Table<TransferRecord, string>

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

    // ---------- v3：管护划转 ----------
    // 新增 transfers 表；为 surveys / measures / supports / reviews 补齐 owner（管护单位归属），
    // 为 trees 补齐 activeTransferId。打开时先按古树现状回填管护单位，之后才启用移交。
    this.version(3)
      .stores({
        trees: 'id, code, species, protectLevel, ageYears, createdAt, updatedAt, owner, activeTransferId',
        surveys: 'id, treeId, [treeId+date], date, siteNote, owner',
        measures: 'id, treeId, type, state, date, operator, owner',
        supports: 'id, treeId, type, installDate, lastCheckDate, owner',
        reviews: 'id, treeId, date, vigor, trend, owner',
        transfers: 'id, treeId, treeCode, fromOwner, toOwner, status, createdAt',
      })
      .upgrade(async (tx) => {
        // 迁移 5：为古树补齐 activeTransferId
        await tx.table('trees').toCollection().modify((row: Record<string, unknown>) => {
          if (row.activeTransferId === undefined) row.activeTransferId = null
        })
        // 迁移 6：按古树现状回填管护单位（owner）。
        // 库里已有数据缺归属，打开时先按现状回填管护单位，之后才启用移交。
        const trees = await tx.table('trees').toArray()
        const ownerByTree = new Map<string, string>()
        for (const tree of trees) {
          ownerByTree.set(String(tree.id), typeof tree.owner === 'string' ? tree.owner : '')
        }
        const childTables = [
          tx.table('surveys'),
          tx.table('measures'),
          tx.table('supports'),
          tx.table('reviews'),
        ]
        for (const table of childTables) {
          await table.toCollection().modify((row: Record<string, unknown>) => {
            if (typeof row.owner === 'string' && row.owner !== '') return
            const treeId = String(row.treeId ?? '')
            row.owner = ownerByTree.get(treeId) ?? ''
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
      // 首屏自动播种演示数据：仅当主表为空时执行（幂等）
      if ((await db.trees.count()) === 0) {
        await seedDatabase()
      }
    })()
  }
  return initPromise
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
  transfers: TransferRecord[]
}

/** 导出整库快照 */
export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [trees, surveys, measures, supports, reviews, transfers] = await Promise.all([
    db.trees.toArray(),
    db.surveys.toArray(),
    db.measures.toArray(),
    db.supports.toArray(),
    db.reviews.toArray(),
    db.transfers.toArray(),
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
  }
}

/** 用快照覆盖整库（导入存档） */
export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.transfers.clear(),
    ])
    await db.trees.bulkPut(snapshot.trees.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.surveys.bulkPut(snapshot.surveys.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.measures.bulkPut(snapshot.measures.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.supports.bulkPut(snapshot.supports.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.reviews.bulkPut(snapshot.reviews.map((row) => ({ ...row, revision: ROW_REVISION })))
    await db.transfers.bulkPut(snapshot.transfers.map((row) => ({ ...row, revision: ROW_REVISION })))
  })
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction('rw', [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers], async () => {
    await Promise.all([
      db.trees.clear(),
      db.surveys.clear(),
      db.measures.clear(),
      db.supports.clear(),
      db.reviews.clear(),
      db.transfers.clear(),
    ])
  })
  await seedDatabase()
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [trees, surveys, measures, supports, reviews, transfers] = await Promise.all([
    db.trees.count(),
    db.surveys.count(),
    db.measures.count(),
    db.supports.count(),
    db.reviews.count(),
    db.transfers.count(),
  ])
  return { trees, surveys, measures, supports, reviews, transfers }
}

/* ------------------------------ 管护划转 ------------------------------ */

export async function listTransfers(): Promise<TransferRecord[]> {
  const rows = await db.transfers.toArray()
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getTransfer(id: string): Promise<TransferRecord | undefined> {
  return db.transfers.get(id)
}

/**
 * 发起管护划转。
 * 整棵树连同树体检查、复壮措施、加固件一起交给接手单位；
 * 长势复评结论留在原单位名下（不随树划转）。
 * 划转期间锁定古树，两边不能同时改同一株树。
 */
export async function initiateTransfer(treeId: string, toOwner: string, note: string): Promise<TransferRecord> {
  const tree = await db.trees.get(treeId)
  if (!tree) throw new Error('古树不存在')
  if (tree.activeTransferId) throw new Error('该古树已有进行中的划转，不能重复划转')
  const target = toOwner.trim()
  if (target === '') throw new Error('请填写接手单位')
  if (target === tree.owner) throw new Error('接手单位与当前管护单位相同，无需划转')

  const [surveyCount, measureCount, supportCount] = await Promise.all([
    db.surveys.where('treeId').equals(treeId).count(),
    db.measures.where('treeId').equals(treeId).count(),
    db.supports.where('treeId').equals(treeId).count(),
  ])

  const record: TransferRecord = {
    id: `transfer-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    treeId,
    treeCode: tree.code,
    treeSpecies: tree.species,
    fromOwner: tree.owner,
    toOwner: target,
    status: 'pending',
    surveyCount,
    measureCount,
    supportCount,
    reconciled: false,
    mismatchNote: '',
    note: note.trim(),
    createdAt: nowIso(),
    updatedAt: nowIso(),
    resolvedAt: null,
    revision: ROW_REVISION,
  }

  await db.transaction('rw', db.trees, db.transfers, async () => {
    await db.transfers.put(record)
    await db.trees.update(treeId, { activeTransferId: record.id, updatedAt: nowIso() })
  })

  return record
}

/**
 * 接手单位确认接手。
 * 古树管护单位改为接手单位；树体检查、复壮措施、加固件随树划转（owner 改为接手单位）；
 * 长势复评结论留在原单位名下（owner 不变）。划转结束，解除锁定。
 */
export async function acceptTransfer(transferId: string): Promise<void> {
  const record = await db.transfers.get(transferId)
  if (!record) throw new Error('划转记录不存在')
  if (record.status !== 'pending' && record.status !== 'adjudicating') {
    throw new Error('该划转已处理，不能重复接手')
  }
  const tree = await db.trees.get(record.treeId)
  if (!tree) throw new Error('古树不存在')

  await db.transaction(
    'rw',
    [db.trees, db.surveys, db.measures, db.supports, db.reviews, db.transfers],
    async () => {
      // 整棵树跟着走：管护单位改为接手单位，解除锁定
      await db.trees.update(record.treeId, {
        owner: record.toOwner,
        activeTransferId: null,
        updatedAt: nowIso(),
      })
      // 树体检查、复壮措施、加固件随树划转
      await db.surveys
        .where('treeId')
        .equals(record.treeId)
        .modify({ owner: record.toOwner, updatedAt: nowIso() })
      await db.measures
        .where('treeId')
        .equals(record.treeId)
        .modify({ owner: record.toOwner, updatedAt: nowIso() })
      await db.supports
        .where('treeId')
        .equals(record.treeId)
        .modify({ owner: record.toOwner, updatedAt: nowIso() })
      // 长势复评结论留在原单位名下：owner 不改写
      await db.transfers.update(transferId, {
        status: 'accepted',
        reconciled: true,
        mismatchNote: '',
        updatedAt: nowIso(),
        resolvedAt: nowIso(),
      })
    },
  )
}

/**
 * 接手单位退回（没接稳的部分退还原单位继续办）。
 * 古树仍归原单位管护，解除锁定。
 */
export async function rejectTransfer(transferId: string, reason: string): Promise<void> {
  const record = await db.transfers.get(transferId)
  if (!record) throw new Error('划转记录不存在')
  if (record.status !== 'pending' && record.status !== 'adjudicating') {
    throw new Error('该划转已处理，不能退回')
  }

  await db.transaction('rw', db.trees, db.transfers, async () => {
    await db.trees.update(record.treeId, { activeTransferId: null, updatedAt: nowIso() })
    await db.transfers.update(transferId, {
      status: 'rejected',
      reconciled: false,
      mismatchNote: reason.trim() || '接手单位退回',
      updatedAt: nowIso(),
      resolvedAt: nowIso(),
    })
  })
}

/**
 * 两边按树的编号对账，对不上的先摆到档案页等人裁定。
 * 接手单位发现编号 / 数量对不上时，标记为待裁定。
 */
export async function reportMismatch(transferId: string, note: string): Promise<void> {
  const record = await db.transfers.get(transferId)
  if (!record) throw new Error('划转记录不存在')
  if (record.status !== 'pending') throw new Error('该划转已处理，不能标记对不上')

  await db.transfers.update(transferId, {
    status: 'adjudicating',
    reconciled: false,
    mismatchNote: note.trim() || '两边按编号对账对不上，待裁定',
    updatedAt: nowIso(),
  })
}

/** 裁定后接手：待裁定的划转经裁定后确认接手 */
export async function adjudicateAccept(transferId: string): Promise<void> {
  await acceptTransfer(transferId)
}

/** 裁定后退回：待裁定的划转经裁定后退回原单位 */
export async function adjudicateReject(transferId: string, reason: string): Promise<void> {
  await rejectTransfer(transferId, reason)
}
