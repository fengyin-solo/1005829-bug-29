/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean | null
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

// ---------------------------------------------------------------------------
// 水位监测：归属卡到点位之后用到的领域类型
// ---------------------------------------------------------------------------

/**
 * 监测点位台账：警戒水位是「点位」的属性，不是某条监测记录的属性。
 * owner 即本点位监测人，只有 ta 能维护本点位的读数与警戒水位。
 * version 用于两位监测员同时改同一个点位时的乐观锁：先到的提交落库并把版本号 +1，
 * 后到的拿着旧版本号提交会被挡回。
 */
export type WaterLevelPoint = {
  code: string
  name: string
  owner: string
  warningLevel: number
  version: number
  updatedAt: string
  updatedBy: string
}

/**
 * 水位监测记录。
 * - 待采集记录：读数/编号等业务字段还可由本点位监测人修改；
 * - 已采集及之后的记录整条只读，警戒水位以「采集时快照」frozenWarningLevel 固化，
 *   历史取值（含当时阈值下的判定）永远不再变化；
 * - 超限标记列表与详情共用同一套判定函数，不存在两处口径不一致。
 * rowVersion 同样是乐观锁，防止同点位并发编辑互相覆盖。
 */
export type WaterLevelRow = EntryRow & {
  监测编号: string
  监测点位: string
  点位编码: string
  水位读数: number | ''
  警戒水位: number | ''
  frozenWarningLevel?: number | ''
  采集时间: string
  监测人: string
  超标判定: string
  监测状态: string
  判定时间?: string
  判定人?: string
  rowVersion: number
}

/** 列表与详情共用的判定结果，保证两处口径一致。 */
export type WaterLevelVerdict = {
  reading: number | null
  warningLevel: number | null
  exceeded: boolean
  label: string
  /** 当前展示用的警戒水位：待采集/已采集随点位最新阈值走，已判定记录取采集时快照。 */
  effectiveWarningLevel: number | null
  /** 已判定（水位正常/超警戒）的历史记录冻结，不再参与重算。 */
  frozen: boolean
}

/** 阈值重算前后的单条差异。 */
export type ThresholdRecomputeDiff = {
  id: number
  监测编号: string
  监测点位: string
  oldThreshold: number
  newThreshold: number
  reading: number | null
  before: string
  after: string
  changed: boolean
}

/** 审计痕迹：谁、在什么时候、对哪个点位/记录做了什么，成功还是被退回都留痕。 */
export type WaterLevelAuditEntry = {
  id: number
  at: string
  operator: string
  action: string
  target: string
  ok: boolean
  detail: string
}
