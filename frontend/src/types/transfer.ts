/**
 * 管护划转（Transfer）
 * 古树管护责任在养护单位之间划转：整棵树连同树体检查、复壮措施、加固件一起交给接手单位，
 * 但原单位已经定过的长势复评结论留在原单位名下，不被接手单位改写。
 * 划转期间锁定古树，两边不能同时改同一株树。
 */

/** 划转状态：待接手 / 已接手 / 已退回 / 待裁定 */
export type TransferStatus = 'pending' | 'accepted' | 'rejected' | 'adjudicating'

export const TRANSFER_STATUS_OPTIONS: TransferStatus[] = [
  'pending',
  'accepted',
  'rejected',
  'adjudicating',
]

export const TRANSFER_STATUS_LABEL: Record<TransferStatus, string> = {
  pending: '待接手',
  accepted: '已接手',
  rejected: '已退回',
  adjudicating: '待裁定',
}

export const TRANSFER_STATUS_TAG_TYPE: Record<TransferStatus, 'warning' | 'success' | 'info' | 'danger'> = {
  pending: 'warning',
  accepted: 'success',
  rejected: 'info',
  adjudicating: 'danger',
}

export interface TransferRecord {
  id: string
  /** 划转的古树 */
  treeId: string
  /** 古树编号快照（两边按编号对账用） */
  treeCode: string
  /** 古树树种快照 */
  treeSpecies: string
  /** 原管护单位 */
  fromOwner: string
  /** 接手单位 */
  toOwner: string
  /** 划转状态 */
  status: TransferStatus
  /** 随树划转的树体检查数（快照） */
  surveyCount: number
  /** 随树划转的复壮措施数（快照） */
  measureCount: number
  /** 随树划转的加固件数（快照） */
  supportCount: number
  /** 对账是否一致（两边按编号对账对得上） */
  reconciled: boolean
  /** 对不上 / 退回的说明 */
  mismatchNote: string
  /** 划转备注 */
  note: string
  createdAt: string
  updatedAt: string
  /** 处理完成时间（接手 / 退回 / 裁定） */
  resolvedAt: string | null
  revision: number
}

/** 发起划转的表单草稿 */
export interface TransferDraft {
  treeId: string
  toOwner: string
  note: string
}
