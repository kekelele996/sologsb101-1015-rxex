/**
 * 长势复评（Review）
 * 长势为「衰弱」或「濒危」时必须填写后续措施。
 */

/** 长势等级 */
export type Vigor = '旺盛' | '一般' | '衰弱' | '濒危'

/** 长势趋势 */
export type Trend = '好转' | '持平' | '下降'

export const VIGOR_OPTIONS: Vigor[] = ['旺盛', '一般', '衰弱', '濒危']
export const TREND_OPTIONS: Trend[] = ['好转', '持平', '下降']

/** 需要强制填写后续措施的长势等级 */
export const VIGOR_NEED_FOLLOW_UP: Vigor[] = ['衰弱', '濒危']

export interface Review {
  id: string
  /** 所属古树 */
  treeId: string
  /**
   * 管护单位归属（长势复评结论留在原单位名下，不随树划转）。
   * 即使古树整棵交给接手单位，原单位已经定过的复评结论仍归原单位所有。
   */
  owner: string
  /** 复评日期 YYYY-MM-DD */
  date: string
  /** 长势 */
  vigor: Vigor
  /** 趋势 */
  trend: Trend
  /** 复评结论 */
  conclusion: string
  /** 后续措施（长势为衰弱 / 濒危时必填） */
  followUp: string
  createdAt: string
  updatedAt: string
  revision: number
}

/** 新建 / 编辑长势复评的表单草稿 */
export interface ReviewDraft {
  treeId: string
  date: string
  vigor: Vigor
  trend: Trend
  conclusion: string
  followUp: string
}
