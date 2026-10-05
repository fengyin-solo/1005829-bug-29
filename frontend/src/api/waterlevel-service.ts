import {
  listRows,
  loadCollection,
  saveCollection,
  saveRows,
  syncFromStorage,
} from '@/data/local-store'
import type {
  EntryRow,
  FloodDraft,
  RecalcTrace,
  WaterAuditEntry,
  WaterChangeAtom,
  WaterFlag,
  WaterPoint,
  WaterRow,
} from '@/data/types'
import { WATER_STATUS_LOCKED, WATER_STATUS_OPEN } from '@/data/types'

// ─────────────────────────────────────────────────────────────────────────
// 水位监测领域服务
// 根因：以前归属只认监测编号，别的点位的人拿着编号就能改。现在归属一律卡点位：
// 点位目录里每个点位只有一名维护监测人，读数、阈值只有本人能动。
// ─────────────────────────────────────────────────────────────────────────

const POINTS_KEY = 'waterlevel-points'
const AUDIT_KEY = 'waterlevel-audit'

/** 点位目录（领域字典，也是权限来源）：监测人 ↔ 点位一一对应。 */
export const POINT_DIRECTORY: WaterPoint[] = [
  { code: 'PT-01', name: '临江路1号雨水井口', monitor: '周建国', threshold: 4.5, version: 1 },
  { code: 'PT-02', name: '河滨泵站前池', monitor: '林晓燕', threshold: 3.0, version: 1 },
  { code: 'PT-03', name: '东湖路下穿通道', monitor: '陈志远', threshold: 1.2, version: 1 },
]

/** 可切换的登录身份：非点位监测人（值班管理员）只能看，任何写操作都会被退回。 */
export const OPERATORS: { name: string; pointCode: string | null }[] = [
  { name: '值班管理员', pointCode: null },
  { name: '周建国', pointCode: 'PT-01' },
  { name: '林晓燕', pointCode: 'PT-02' },
  { name: '陈志远', pointCode: 'PT-03' },
]

export type DomainResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}

function nowText(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function evaluateFlag(reading: number | null, threshold: number): WaterFlag {
  if (reading === null || Number.isNaN(reading)) return '待判定'
  return reading >= threshold ? '超警戒' : '水位正常'
}

export function isLocked(row: WaterRow): boolean {
  return row.status === WATER_STATUS_LOCKED
}

/** 列表/详情共用的读数口径：挂着的记录始终跟点位当前阈值算，冻结的记录用入表快照。 */
function presented(row: WaterRow, point: WaterPoint): WaterRow {
  if (isLocked(row)) {
    return { ...row, 警戒水位: row.thresholdSnapshot, overFlag: row.overFlag }
  }
  const flag = evaluateFlag(row.reading, point.threshold)
  return { ...row, 警戒水位: point.threshold, overFlag: flag }
}

function points(): WaterPoint[] {
  return loadCollection<WaterPoint>(POINTS_KEY, POINT_DIRECTORY).map((p) => ({ ...p }))
}

function savePoints(next: WaterPoint[]): void {
  saveCollection(POINTS_KEY, next)
}

function rawRows(): WaterRow[] {
  return listRows('waterlevel') as unknown as WaterRow[]
}

function saveWaterRows(next: WaterRow[]): void {
  saveRows('waterlevel', next as unknown as EntryRow[])
}

function audits(): WaterAuditEntry[] {
  return loadCollection<WaterAuditEntry>(AUDIT_KEY, [])
}

function nextAuditId(rows: WaterAuditEntry[]): number {
  return rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
}

/** 留痕：成功与被挡回都记一条，回答「谁在什么时候动了哪条、成没成、为什么」。 */
function recordAudit(entry: Omit<WaterAuditEntry, 'id' | 'time'>): void {
  const rows = audits()
  rows.push({ ...entry, id: nextAuditId(rows), time: nowText() })
  saveCollection(AUDIT_KEY, rows)
}

function findPoint(rows: WaterPoint[], code: string): WaterPoint | undefined {
  return rows.find((p) => p.code === code)
}

/** 归属校验：不是本点位监测人，一律退回并写明越在哪（谁、要动哪个点位、该点位归谁）。 */
function assertOwner(
  operator: string,
  point: WaterPoint,
  action: string,
  recordCode?: string,
): DomainResult {
  if (operator !== point.monitor) {
    const target = recordCode ? `记录 ${recordCode}（点位「${point.name}」）` : `点位「${point.name}」`
    const message =
      `越权操作已退回：${action}的归属点位是「${point.name}」，` +
      `该点位只由监测人${point.monitor}维护，当前操作人${operator}不是本点位监测人。`
    recordAudit({
      operator,
      action,
      pointCode: point.code,
      pointName: point.name,
      recordCode,
      denied: true,
      detail: message + target,
    })
    return { ok: false, message }
  }
  return { ok: true, message: '' }
}

/** 已采集记录整条只读：阈值改了也不动它，返回被挡回的说明。 */
function assertNotLocked(
  row: WaterRow,
  operator: string,
  action: string,
): DomainResult {
  if (isLocked(row)) {
    const message =
      `操作已退回：记录 ${row.code}（点位「${row.pointName}」）监测状态为「已采集」，整条记录只读，` +
      `水位读数、警戒水位与历史判定（${row.overFlag}，按入表阈值 ${fmt(row.thresholdSnapshot)} 米）保持当时取值。`
    recordAudit({
      operator,
      action,
      pointCode: row.pointCode,
      pointName: row.pointName,
      recordId: row.id,
      recordCode: row.code,
      denied: true,
      detail: message,
    })
    return { ok: false, message }
  }
  return { ok: true, message: '' }
}

/** 乐观锁：页面打开后记录被别人先改过（version 变了），后到的这一版直接退回。 */
function assertVersion(row: WaterRow, expectedVersion: number, operator: string): DomainResult {
  if (row.version !== expectedVersion) {
    const message =
      `并发冲突，已按「先到先得」退回本次提交：记录 ${row.code} 已被更早到达的操作更新` +
      `（版本 ${expectedVersion} → ${row.version}），请刷新后以最新版本为准重试。`
    recordAudit({
      operator,
      action: '并发提交',
      pointCode: row.pointCode,
      pointName: row.pointName,
      recordId: row.id,
      recordCode: row.code,
      denied: true,
      detail: message,
    })
    return { ok: false, message }
  }
  return { ok: true, message: '' }
}

function fmt(n: number): string {
  return n.toFixed(2)
}

function parseReading(value: string): number | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : Number.NaN
}

// ── 查询 ────────────────────────────────────────────────────────────────

export type WaterView = {
  rows: WaterRow[]
  points: WaterPoint[]
  drafts: FloodDraft[]
  audit: WaterAuditEntry[]
}

export function listWater(): WaterView {
  const pointRows = points()
  const rows = rawRows()
    .map((row) => {
      const point = findPoint(pointRows, row.pointCode)
      return point ? presented(row, point) : row
    })
    .sort((a, b) => b.id - a.id)
  return {
    rows,
    points: pointRows,
    drafts: listRows('floodwarn') as unknown as FloodDraft[],
    audit: audits().slice().sort((a, b) => b.id - a.id),
  }
}

export function getWaterRecord(id: number): { row: WaterRow; point: WaterPoint } | null {
  const pointRows = points()
  const row = rawRows().find((r) => r.id === id)
  if (!row) return null
  const point = findPoint(pointRows, row.pointCode)
  if (!point) return null
  return { row: presented(row, point), point }
}

/** 当前操作人负责的点位；非监测人返回空，登记入口直接没有点位可选。 */
export function ownedPoint(operator: string): WaterPoint | null {
  return points().find((p) => p.monitor === operator) ?? null
}

// ── 登记 ────────────────────────────────────────────────────────────────

export type CreateInput = {
  operator: string
  pointCode: string
  code: string
  reading: string
}

export function createWaterRecord(input: CreateInput): DomainResult<number> {
  // 跨页签并发：先把别的页签已落盘的版本读回来，再做任何判定。
  syncFromStorage()
  const pointRows = points()
  const point = findPoint(pointRows, input.pointCode)
  if (!point) {
    const message = `登记已退回：监测点位「${input.pointCode}」不存在，请从本点位目录中选择。`
    recordAudit({ operator: input.operator, action: '登记水位监测记录', denied: true, detail: message })
    return { ok: false, message }
  }

  // 1) 归属卡点位：非本点位监测人，连登记都退回。
  const owned = assertOwner(input.operator, point, '登记水位监测记录')
  if (!owned.ok) return { ok: false, message: owned.message }

  const code = input.code.trim()
  if (!code) {
    return { ok: false, message: '登记已退回：监测编号不能为空。' }
  }

  // 2) 同一监测点位下监测编号不能重号；重号要指出撞了谁（记录 id、编号、状态）。
  const rows = rawRows()
  const clash = rows.find((r) => r.pointCode === point.code && r.code === code)
  if (clash) {
    const message =
      `登记已退回：同一监测点位「${point.name}」下监测编号 ${code} 已被占用，` +
      `撞号记录 #${clash.id}（${clash.code}，状态「${clash.status}」，监测人${clash.monitor}），请更换编号。`
    recordAudit({
      operator: input.operator,
      action: '登记水位监测记录',
      pointCode: point.code,
      pointName: point.name,
      recordId: clash.id,
      recordCode: clash.code,
      denied: true,
      detail: message,
    })
    return { ok: false, message }
  }

  const reading = parseReading(input.reading)
  if (Number.isNaN(reading as number) || (reading !== null && (reading as number) < 0)) {
    return { ok: false, message: '登记已退回：水位读数必须是不小于 0 的数字（米），或留空待采集后补录。' }
  }

  const id = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1
  const flag = evaluateFlag(reading, point.threshold)
  const row: WaterRow = {
    id,
    status: WATER_STATUS_OPEN,
    pending: true,
    abnormal: false,
    监测编号: code,
    监测点位: point.name,
    水位读数: reading === null ? '' : fmt(reading),
    警戒水位: point.threshold,
    采集时间: '',
    监测人: point.monitor,
    超标判定: flag,
    监测状态: WATER_STATUS_OPEN,
    pointCode: point.code,
    pointName: point.name,
    monitor: point.monitor,
    code,
    reading,
    thresholdSnapshot: point.threshold,
    overFlag: flag,
    version: 1,
    recalcs: [],
  }
  saveWaterRows([...rows, row])
  recordAudit({
    operator: input.operator,
    action: '登记水位监测记录',
    pointCode: point.code,
    pointName: point.name,
    recordId: id,
    recordCode: code,
    denied: false,
    changes: [
      { field: '监测编号', from: '', to: code },
      { field: '水位读数', from: '', to: reading === null ? '（未填）' : fmt(reading) },
    ],
    detail: `登记成功，归属点位「${point.name}」，当前阈值 ${fmt(point.threshold)} 米，超标判定「${flag}」。`,
  })
  return { ok: true, message: `已登记记录 ${code}，归属点位「${point.name}」。`, data: id }
}

// ── 改挂着的记录（读数、编号） ────────────────────────────────────────────

export type UpdateInput = {
  operator: string
  id: number
  expectedVersion: number
  code: string
  reading: string
}

export function updateOpenRecord(input: UpdateInput): DomainResult {
  syncFromStorage()
  const pointRows = points()
  const rows = rawRows()
  const index = rows.findIndex((r) => r.id === input.id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${input.id} 的水位监测记录。` }
  const row = rows[index]
  const point = findPoint(pointRows, row.pointCode)!

  // 已采集整条只读优先级最高：不管拿哪个版本、是不是本人，冻结记录都先挡。
  const locked = assertNotLocked(row, input.operator, '修改水位监测记录')
  if (!locked.ok) return locked
  const owned = assertOwner(input.operator, point, '修改水位监测记录', row.code)
  if (!owned.ok) return owned
  const conflict = assertVersion(row, input.expectedVersion, input.operator)
  if (!conflict.ok) return conflict
  const code = input.code.trim()
  if (!code) return { ok: false, message: '修改已退回：监测编号不能为空。' }
  const clash = rows.find((r) => r.id !== row.id && r.pointCode === point.code && r.code === code)
  if (clash) {
    const message =
      `修改已退回：同一监测点位「${point.name}」下监测编号 ${code} 已被占用，` +
      `撞号记录 #${clash.id}（${clash.code}，状态「${clash.status}」），请更换编号。`
    recordAudit({
      operator: input.operator,
      action: '修改水位监测记录',
      pointCode: point.code,
      pointName: point.name,
      recordId: clash.id,
      recordCode: clash.code,
      denied: true,
      detail: message,
    })
    return { ok: false, message }
  }

  const reading = parseReading(input.reading)
  if (Number.isNaN(reading as number) || (reading !== null && (reading as number) < 0)) {
    return { ok: false, message: '修改已退回：水位读数必须是不小于 0 的数字（米）。' }
  }

  const changes: WaterChangeAtom[] = []
  if (row.code !== code) changes.push({ field: '监测编号', from: row.code, to: code })
  const readingText = reading === null ? '' : fmt(reading)
  if ((row.reading === null ? '' : fmt(row.reading)) !== readingText) {
    changes.push({ field: '水位读数', from: row.reading === null ? '（未填）' : fmt(row.reading), to: reading === null ? '（未填）' : readingText })
  }
  if (changes.length === 0) {
    return { ok: false, message: '没有检测到改动，未写入。' }
  }

  // 挂着的记录按点位当前阈值即时重算超限标记——列表与详情共用这一份口径。
  const flag = evaluateFlag(reading, point.threshold)
  const updated: WaterRow = {
    ...row,
    code,
    reading,
    overFlag: flag,
    version: row.version + 1,
    thresholdSnapshot: point.threshold,
    监测编号: code,
    水位读数: readingText,
    警戒水位: point.threshold,
    超标判定: flag,
  }
  const next = [...rows]
  next[index] = updated
  saveWaterRows(next)
  recordAudit({
    operator: input.operator,
    action: '修改水位监测记录',
    pointCode: point.code,
    pointName: point.name,
    recordId: row.id,
    recordCode: code,
    denied: false,
    changes,
    detail: `已更新记录 ${code}，按当前阈值 ${fmt(point.threshold)} 米重算，超标判定「${row.overFlag}」→「${flag}」。`,
  })
  return { ok: true, message: `记录 ${code} 已更新，超标判定「${flag}」。` }
}

// ── 提交采集：记录在此刻整条冻结，超警戒结论落入防涝预警待拟稿清单 ──────────

export function submitCollected(input: { operator: string; id: number; expectedVersion: number }): DomainResult {
  syncFromStorage()
  const pointRows = points()
  const rows = rawRows()
  const index = rows.findIndex((r) => r.id === input.id)
  if (index < 0) return { ok: false, message: `没有找到编号为 ${input.id} 的水位监测记录。` }
  const row = rows[index]
  const point = findPoint(pointRows, row.pointCode)!

  const locked = assertNotLocked(row, input.operator, '提交采集')
  if (!locked.ok) return locked
  const owned = assertOwner(input.operator, point, '提交采集', row.code)
  if (!owned.ok) return owned
  const conflict = assertVersion(row, input.expectedVersion, input.operator)
  if (!conflict.ok) return conflict

  if (row.reading === null) {
    return { ok: false, message: `提交采集已退回：记录 ${row.code} 尚未填写水位读数，无法采集。` }
  }

  // 冻结时刻用点位当前阈值得出结论，并把阈值快照进记录，此后永不改。
  const time = nowText()
  const flag = evaluateFlag(row.reading, point.threshold)
  const frozen: WaterRow = {
    ...row,
    status: WATER_STATUS_LOCKED,
    pending: false,
    abnormal: flag === '超警戒',
    overFlag: flag,
    thresholdSnapshot: point.threshold,
    version: row.version + 1,
    采集时间: time,
    警戒水位: point.threshold,
    超标判定: flag,
    监测状态: WATER_STATUS_LOCKED,
  }
  const next = [...rows]
  next[index] = frozen
  saveWaterRows(next)

  // 超警戒结论落防涝预警待拟稿清单；同一水位记录只落一条，重复提交不会再生成。
  let draftMessage = ''
  const drafts = listRows('floodwarn') as unknown as FloodDraft[]
  if (flag === '超警戒' && !drafts.some((d) => d.sourceRecordId === row.id)) {
    const draftId = drafts.reduce((max, d) => Math.max(max, d.id), 0) + 1
    const warnCode = `WARN-WL-${String(draftId).padStart(4, '0')}`
    const draft: FloodDraft = {
      id: draftId,
      status: '待拟稿',
      pending: true,
      abnormal: false,
      预警编号: warnCode,
      预警级别: '超警戒',
      影响区域: point.name,
      预警依据: `水位监测记录 ${row.code}：读数 ${fmt(row.reading)} 米 ≥ 警戒水位 ${fmt(point.threshold)} 米（采集时间 ${time}）`,
      拟稿人: point.monitor,
      发布时间: '',
      解除时间: '',
      预警状态: '待拟稿',
      sourceRecordId: row.id,
    }
    saveRows('floodwarn', [...drafts, draft] as unknown as EntryRow[])
    draftMessage = ` 超警戒结论已落入防涝预警待拟稿清单（${warnCode}）。`
  }

  recordAudit({
    operator: input.operator,
    action: '提交采集',
    pointCode: point.code,
    pointName: point.name,
    recordId: row.id,
    recordCode: row.code,
    denied: false,
    changes: [
      { field: '监测状态', from: WATER_STATUS_OPEN, to: WATER_STATUS_LOCKED },
      { field: '超标判定', from: row.overFlag, to: flag },
    ],
    detail: `记录 ${row.code} 已采集并整条冻结，读数 ${fmt(row.reading)} 米、阈值 ${fmt(point.threshold)} 米、判定「${flag}」。${draftMessage}`,
  })
  return {
    ok: true,
    message:
      flag === '超警戒'
        ? `记录 ${row.code} 已采集：判定「超警戒」，已生成待拟稿预警。`
        : `记录 ${row.code} 已采集：判定「水位正常」，记录已冻结。`,
  }
}

// ── 调整点位警戒水位：本点位监测人专属，挂着的记录同规则重算并保留前后差异 ────

export function adjustThreshold(input: {
  operator: string
  pointCode: string
  expectedVersion: number
  threshold: string
}): DomainResult {
  syncFromStorage()
  const pointRows = points()
  const point = findPoint(pointRows, input.pointCode)
  if (!point) return { ok: false, message: `点位「${input.pointCode}」不存在。` }

  const owned = assertOwner(input.operator, point, '调整警戒水位')
  if (!owned.ok) return owned
  if (point.version !== input.expectedVersion) {
    const message =
      `并发冲突，已按「先到先得」退回：点位「${point.name}」的警戒水位已被更早到达的操作更新` +
      `（版本 ${input.expectedVersion} → ${point.version}），请刷新后重试。`
    recordAudit({
      operator: input.operator,
      action: '调整警戒水位',
      pointCode: point.code,
      pointName: point.name,
      denied: true,
      detail: message,
    })
    return { ok: false, message }
  }

  const value = Number(input.threshold.trim())
  if (!Number.isFinite(value) || value <= 0) {
    return { ok: false, message: '调整已退回：警戒水位必须是大于 0 的数字（米）。' }
  }
  if (value === point.threshold) {
    return { ok: false, message: `警戒水位仍是 ${fmt(value)} 米，没有变化，未写入。` }
  }

  const oldThreshold = point.threshold
  const time = nowText()
  const nextPoints = pointRows.map((p) =>
    p.code === point.code ? { ...p, threshold: value, version: p.version + 1 } : p,
  )
  savePoints(nextPoints)

  // 同点位仍挂着（待采集）的记录按同一份规则重算超限标记，逐条保留重算前后差异。
  // 已采集记录整条只读，保持当时取值，不参与重算。
  const rows = rawRows()
  const affected: string[] = []
  const nextRows = rows.map((row) => {
    if (row.pointCode !== point.code || isLocked(row)) return row
    const beforeFlag = evaluateFlag(row.reading, oldThreshold)
    const afterFlag = evaluateFlag(row.reading, value)
    const trace: RecalcTrace = {
      time,
      operator: input.operator,
      oldThreshold,
      newThreshold: value,
      beforeFlag,
      afterFlag,
    }
    affected.push(`${row.code}：${beforeFlag}→${afterFlag}`)
    return {
      ...row,
      thresholdSnapshot: value,
      overFlag: afterFlag,
      version: row.version + 1,
      警戒水位: value,
      超标判定: afterFlag,
      recalcs: [...row.recalcs, trace],
    }
  })
  saveWaterRows(nextRows)

  recordAudit({
    operator: input.operator,
    action: '调整警戒水位',
    pointCode: point.code,
    pointName: point.name,
    denied: false,
    changes: [{ field: '警戒水位', from: fmt(oldThreshold), to: fmt(value) }],
    detail:
      `点位「${point.name}」警戒水位 ${fmt(oldThreshold)} → ${fmt(value)} 米；` +
      `同点位 ${affected.length} 条挂着的记录已重算（${affected.length ? affected.join('；') : '无'}）；已采集记录保持当时取值。`,
  })
  return {
    ok: true,
    message:
      `点位「${point.name}」警戒水位已改为 ${fmt(value)} 米，${affected.length} 条挂着的记录已按新阈值重算并保留差异；` +
      `已采集记录保持当时取值不变。`,
  }
}
