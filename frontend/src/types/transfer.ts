/**
 * 古树管护责任划转（Transfer）
 * 一株树连同树体检查、复壮措施与加固件整体移交给接手单位；
 * 划转期间整株树冻结（两边都不能改），待接手方接收或退回后解冻。
 * 注意：长势复评结论不随移交改写，其归属始终记在复评行自身的 ownerUnit 上。
 */

/** 划转单状态：待接收（冻结中） / 已接收 / 已退回（退还原单位继续办） */
export type TransferState = '待接收' | '已接收' | '已退回'

export const TRANSFER_STATE_OPTIONS: TransferState[] = ['待接收', '已接收', '已退回']

/** 冻结中的状态：此状态下原单位与接手单位都不能改这株树 */
export const TRANSFER_LOCKED_STATE: TransferState = '待接收'

/** 对账挂账原因：档案有 / 移交清单没有，清单有 / 档案没有，或编号归属单位对不上 */
export type TransferIssueKind = '档案无此编号' | '清单无此编号' | '归属与清单不符'

export const TRANSFER_ISSUE_KIND_OPTIONS: TransferIssueKind[] = ['档案无此编号', '清单无此编号', '归属与清单不符']

/** 挂账裁定结果：等待裁定 / 裁定并入移交 / 裁定不移交 */
export type TransferIssueResolution = '待裁定' | '并入移交' | '不移交'

export const TRANSFER_ISSUE_RESOLUTION_OPTIONS: TransferIssueResolution[] = ['待裁定', '并入移交', '不移交']

/** 一次按编号对账后发起的划转单（一株树一行） */
export interface Transfer {
  id: string
  /** 同一批次编号，如 HF-20261003-01，同一次「发起划转」共享 */
  batchNo: string
  /** 移交清单上填写的古树编号（对账依据，冻结后不再变动） */
  treeCode: string
  /** 命中的古树 id；挂账未命中时为空串 */
  treeId: string
  /** 原管护单位（发起方） */
  fromUnit: string
  /** 接手管护单位 */
  toUnit: string
  /** 发起日期 YYYY-MM-DD */
  date: string
  state: TransferState
  /** 已接收 / 已退回时的处理日期 */
  handledAt: string
  /** 处理备注（退回原因等） */
  note: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 按树编号对账对不上的挂账记录，摆到档案页等人工裁定 */
export interface TransferIssue {
  id: string
  /** 关联批次编号（清单无此编号时可来自最近一次对账批次） */
  batchNo: string
  /** 对不上的古树编号 */
  treeCode: string
  kind: TransferIssueKind
  /** 档案侧能命中的古树 id；档案无此编号时为空串 */
  treeId: string
  /** 涉及的原管护单位（清单有 / 档案无时为清单填写的单位） */
  fromUnit: string
  /** 涉及的接手管护单位 */
  toUnit: string
  /** 挂账说明：缺在哪一边 */
  detail: string
  resolution: TransferIssueResolution
  /** 裁定备注 */
  decisionNote: string
  /** 裁定日期 */
  decidedAt: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 发起划转的表单草稿 */
export interface TransferDraft {
  /** 逐行或换行分隔的古树编号清单 */
  codesText: string
  fromUnit: string
  toUnit: string
  date: string
}
