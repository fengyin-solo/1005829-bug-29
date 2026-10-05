/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  // 领域扩展字段（阈值快照、重算差异链、来源引用等）也挂在行上，统一放行；
  // 页面读取仍以各领域自己的强类型（如 WaterRow）为准。
  [field: string]: unknown
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

// ─────────────────────────────────────────────────────────────────────────
// 水位监测领域模型：归属卡到点位，阈值、读数、留痕与并发版本都在这里落数据结构
// ─────────────────────────────────────────────────────────────────────────

/** 点位目录：一个监测点位只有一名维护监测人，归属判定以点位为准，不认监测编号。 */
export type WaterPoint = {
  /** 点位编码，唯一，监测记录的归属键 */
  code: string
  /** 点位名称 */
  name: string
  /** 本点位唯一维护人，只有本人能改本点位的读数与警戒水位 */
  monitor: string
  /** 当前生效的警戒水位（米） */
  threshold: number
  /** 点位阈值版本，警戒水位每改一次加一，用于两位监测员并发改阈值时只认先到版本 */
  version: number
}

/** 阈值重算前后的差异；改点位阈值后，同点位仍挂着的记录逐条留一份。 */
export type RecalcTrace = {
  time: string
  operator: string
  oldThreshold: number
  newThreshold: number
  beforeFlag: WaterFlag
  afterFlag: WaterFlag
}

/** 一条字段级修改痕迹，用于回答「谁改的、改了什么」。 */
export type WaterChangeAtom = {
  field: string
  from: string
  to: string
}

export type WaterFlag = '超警戒' | '水位正常' | '待判定'

export const WATER_STATUS_OPEN = '待采集'
export const WATER_STATUS_LOCKED = '已采集'
export const WATER_FIELDS = [
  '监测编号',
  '监测点位',
  '水位读数',
  '警戒水位',
  '采集时间',
  '监测人',
  '超标判定',
  '监测状态',
] as const

export type WaterRow = EntryRow & {
  pointCode: string
  pointName: string
  monitor: string
  code: string
  /** 读数（米）；待采集时可空，提交采集时必须已填写 */
  reading: number | null
  /** 记录入表时的阈值快照；已采集记录整条冻结，详情页始终用这份历史取值 */
  thresholdSnapshot: number
  overFlag: WaterFlag
  /** 乐观锁版本：任何一次成功修改都加一，后到者拿着旧版本提交一律退回 */
  version: number
  /** 阈值重算差异链，只对「仍挂着」的记录追加 */
  recalcs: RecalcTrace[]
}

/** 水位域审计：不管放行还是退回都记，越权与撞号也要留痕。 */
export type WaterAuditEntry = {
  id: number
  time: string
  operator: string
  action: string
  /** 关联点位；撞号、越权这类可能没有具体记录 */
  pointCode?: string
  pointName?: string
  /** 关联监测记录（若有） */
  recordId?: number
  recordCode?: string
  /** true=被系统挡回；false=操作成功 */
  denied: boolean
  changes?: WaterChangeAtom[]
  detail: string
}

/** 防涝预警待拟稿条目：只有水位超警戒的结论落得到这里。 */
export type FloodDraft = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  预警编号: string
  预警级别: string
  影响区域: string
  预警依据: string
  拟稿人: string
  发布时间: string
  解除时间: string
  预警状态: string
  /** 来源水位记录 id，同一条水位记录只落一条，重提不重复 */
  sourceRecordId: number
}
