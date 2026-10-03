/**
 * 划转对账工具：两边按古树编号核对。
 * 纯函数，不触碰数据库，便于单测与界面预览对账结果。
 */
import type { Tree } from '../types/tree'

/** 拆分移交清单文本：支持换行、逗号、顿号、分号、空白分隔，去空去重保序 */
export function parseCodes(text: string): string[] {
  const seen = new Set<string>()
  const codes: string[] = []
  text
    .split(/[\s,，、;；]+/)
    .map((code) => code.trim())
    .forEach((code) => {
      if (code === '' || seen.has(code)) return
      seen.add(code)
      codes.push(code)
    })
  return codes
}

export interface ReconcileMatch {
  code: string
  treeId: string
  owner: string
}

export interface ReconcileResult {
  /** 编号两边都对得上的（清单有、档案有，且编号一致） */
  matched: ReconcileMatch[]
  /** 移交清单有、档案里查无此编号 */
  missingInArchive: string[]
  /** 档案里有、本次移交清单没列上的古树编号 */
  missingInList: ReconcileMatch[]
}

/**
 * 按古树编号对账。
 * @param codes 本次移交清单上的编号（已去重）
 * @param trees 档案库内在档古树
 */
export function reconcileByCode(codes: string[], trees: Tree[]): ReconcileResult {
  const byCode = new Map<string, Tree>()
  trees.forEach((tree) => {
    // 编号理论上唯一；若历史数据重复，以先出现者为准并交由挂账暴露问题
    if (!byCode.has(tree.code)) byCode.set(tree.code, tree)
  })

  const matched: ReconcileMatch[] = []
  const missingInArchive: string[] = []
  codes.forEach((code) => {
    const tree = byCode.get(code)
    if (tree === undefined) {
      missingInArchive.push(code)
      return
    }
    matched.push({ code, treeId: tree.id, owner: tree.owner })
  })

  const listed = new Set(codes)
  const missingInList: ReconcileMatch[] = trees
    .filter((tree) => !listed.has(tree.code))
    .map((tree) => ({ code: tree.code, treeId: tree.id, owner: tree.owner }))

  return { matched, missingInArchive, missingInList }
}

/** 规范化编号用于比较（去空白），对账一律走精确相等 */
export function normalizeCode(code: string): string {
  return code.trim()
}
