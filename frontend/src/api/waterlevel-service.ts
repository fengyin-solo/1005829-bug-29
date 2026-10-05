import {
  listCollection,
  listRows,
  resetCollection,
  resetRows,
  saveCollection,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ThresholdRecomputeDiff,
  WaterLevelAuditEntry,
  WaterLevelPoint,
  WaterLevelRow,
  WaterLevelVerdict,
} from '@/data/types'

// 水位监测领域服务：归属卡到点位后，所有写操作都集中在这里校验，
// 列表与详情共用 evaluateRow() 同一套判定口径，杜绝「列表标记变了、详情还按旧阈值算」。

const ROW_KEY = 'waterlevel'
const WARN_KEY = 'floodwarn'
const POINTS = 'waterlevel-points'
const AUDIT = 'waterlevel-audit'

const COLLECTED = '已采集'
const NORMAL = '水位正常'
const EXCEEDED = '超警戒'
const PENDING_COLLECT = '待采集'

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toNumber(value: number | '' | string | undefined): number | null {
  if (value === '' || value === undefined || value === null) return null
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isFinite(n) ? n : null
}

// ---------------------------------------------------------------------------
// 集合读写
// ---------------------------------------------------------------------------

export function listWaterRows(): WaterLevelRow[] {
  return listRows(ROW_KEY) as WaterLevelRow[]
}

function saveWaterRows(rows: WaterLevelRow[]): void {
  saveRows(ROW_KEY, rows as EntryRow[])
}

export function listPoints(): WaterLevelPoint[] {
  return listCollection<WaterLevelPoint>(POINTS)
}

function savePoints(points: WaterLevelPoint[]): void {
  saveCollection(POINTS, points)
}

export function listAudit(): WaterLevelAuditEntry[] {
  return listCollection<WaterLevelAuditEntry>(AUDIT)
}

function appendAudit(entry: Omit<WaterLevelAuditEntry, 'id' | 'at'>): WaterLevelAuditEntry {
  const entries = listAudit()
  const next: WaterLevelAuditEntry = {
    id: entries.reduce((max, item) => Math.max(max, item.id), 0) + 1,
    at: nowStamp(),
    ...entry,
  }
  saveCollection(AUDIT, [next, ...entries])
  return next
}

export function pointOf(row: WaterLevelRow): WaterLevelPoint | undefined {
  return listPoints().find((point) => point.code === row.点位编码)
}

// ---------------------------------------------------------------------------
// 统一判定：列表和详情都从这里取超限结论
// ---------------------------------------------------------------------------

/**
 * 一条记录当前生效的判定。
 * - 待采集 / 已采集（挂起中）：警戒水位跟随点位最新阈值，读数与阈值都齐备才算数；
 * - 水位正常 / 超警戒（已判定的历史记录）：整条冻结，按采集时阈值快照展示与判定，
 *   阈值再怎么改，原有记录保持当时的取值。
 */
export function evaluateRow(row: WaterLevelRow, point?: WaterLevelPoint): WaterLevelVerdict {
  const frozen = row.status === NORMAL || row.status === EXCEEDED
  const reading = toNumber(row.水位读数)
  const effectiveWarningLevel = frozen
    ? toNumber(row.frozenWarningLevel ?? row.警戒水位)
    : point
      ? point.warningLevel
      : toNumber(row.警戒水位)
  if (reading === null || effectiveWarningLevel === null) {
    return {
      reading,
      warningLevel: effectiveWarningLevel,
      exceeded: false,
      label: '待判定',
      effectiveWarningLevel,
      frozen,
    }
  }
  const exceeded = reading >= effectiveWarningLevel
  return {
    reading,
    warningLevel: effectiveWarningLevel,
    exceeded,
    label: exceeded ? EXCEEDED : NORMAL,
    effectiveWarningLevel,
    frozen,
  }
}

/** 给列表用的展示行：警戒水位列与超标判定列全部以统一判定结果为准。 */
export type WaterLevelViewRow = WaterLevelRow & {
  viewWarningLevel: number | null
  viewVerdict: string
  viewExceeded: boolean
  live: boolean
  ownedBy: string
}

export function listWaterViewRows(): WaterLevelViewRow[] {
  const points = listPoints()
  return listWaterRows().map((row) => {
    const point = points.find((item) => item.code === row.点位编码)
    const verdict = evaluateRow(row, point)
    return {
      ...row,
      viewWarningLevel: verdict.effectiveWarningLevel,
      viewVerdict: verdict.label,
      viewExceeded: verdict.exceeded,
      live: !verdict.frozen,
      ownedBy: point?.owner ?? '',
    }
  })
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function findPoint(code: string): WaterLevelPoint | undefined {
  return listPoints().find((point) => point.code === code)
}

/** 归属卡到点位：不是本点位监测人，任何写操作一律退回，并写明越在哪。 */
function requireOwner(point: WaterLevelPoint, operator: string, action: string): ActionResult | null {
  if (!operator) {
    return { ok: false, message: `当前没有值班身份，不能${action}；请先选择当前监测人。` }
  }
  if (operator !== point.owner) {
    return {
      ok: false,
      message:
        `退回：越权操作。点位「${point.name}」归属监测人为 ${point.owner}，`
        + `当前操作人 ${operator} 不是本点位监测人，无权${action}。`,
    }
  }
  return null
}

/** 同一监测点位下监测编号不能重号，重号挡回并指出撞了谁。 */
function findDuplicateCode(
  code: string,
  pointCode: string,
  excludeId?: number,
): WaterLevelRow | undefined {
  return listWaterRows().find(
    (row) =>
      row.点位编码 === pointCode
      && row.监测编号 === code
      && (excludeId === undefined || row.id !== excludeId),
  )
}

// ---------------------------------------------------------------------------
// 防涝预警待拟稿清单同步
// ---------------------------------------------------------------------------

function listWarnings(): EntryRow[] {
  return listRows(WARN_KEY)
}

function saveWarnings(rows: EntryRow[]): void {
  saveRows(WARN_KEY, rows)
}

function latestExceededRow(pointCode: string): WaterLevelRow | undefined {
  return listWaterRows()
    .filter((row) => row.点位编码 === pointCode && row.status === EXCEEDED)
    .sort((a, b) => (a.判定时间 && b.判定时间 ? (a.判定时间 < b.判定时间 ? 1 : -1) : 0))[0]
}

function warnBasis(point: WaterLevelPoint, row: WaterLevelRow): string {
  const verdict = evaluateRow(row, point)
  return (
    `水位监测结论「${EXCEEDED}」：监测编号 ${row.监测编号}，`
    + `水位读数 ${verdict.reading?.toFixed(2)}m，`
    + `采集时警戒水位 ${toNumber(row.frozenWarningLevel)?.toFixed(2)}m`
    + `（${row.判定时间 ?? row.采集时间} ${row.判定人 ?? row.监测人}判定）。`
  )
}

/**
 * 水位超限的结论落到防涝预警的待拟稿清单：
 * 同一点位只维护一张待拟稿单，已有则更新依据，没有则自动新建。
 * 返回同步过程中做了什么，便于写进操作结果与审计。
 */
function syncWarnDraft(pointCode: string): { action: string; message: string; warnId?: string } {
  const point = findPoint(pointCode)
  if (!point) return { action: '待拟稿同步', message: '' }
  const latest = latestExceededRow(pointCode)
  const warnings = listWarnings()
  const existing = warnings.find(
    (item) => String(item['点位编码'] ?? '') === pointCode && item.status === '待拟稿',
  )
  if (!latest) {
    return {
      action: '待拟稿同步',
      message: existing
        ? `点位「${point.name}」当前无超警戒结论，待拟稿清单保留原单（${existing['预警编号']}）不自动撤回，可人工处理。`
        : `点位「${point.name}」当前无超警戒结论，未生成待拟稿单。`,
    }
  }
  if (existing) {
    const next = warnings.map((item) =>
      item === existing
        ? { ...item, 预警依据: warnBasis(point, latest), 来源记录: latest.id }
        : item,
    )
    saveWarnings(next)
    return {
      action: '待拟稿同步',
      message: `待拟稿单 ${existing['预警编号']} 的预警依据已更新为最新超限结论 ${latest.监测编号}。`,
      warnId: String(existing['预警编号']),
    }
  }
  const id = warnings.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1
  const stamp = nowStamp().slice(0, 10).replace(/-/g, '')
  const seq = String(id).padStart(3, '0')
  const draft: EntryRow = {
    id,
    status: '待拟稿',
    pending: true,
    abnormal: false,
    预警编号: `WARN-AUTO-${stamp}-${seq}`,
    预警级别: '黄色预警',
    影响区域: `${point.name}周边片区`,
    预警依据: warnBasis(point, latest),
    拟稿人: '',
    发布时间: '',
    解除时间: '',
    预警状态: '',
    点位编码: point.code,
    来源记录: latest.id,
    自动生成: true,
  }
  saveWarnings([...warnings, draft])
  return {
    action: '待拟稿同步',
    message: `超警戒结论已落入防涝预警待拟稿清单，自动生成预警单 ${draft['预警编号']}。`,
    warnId: String(draft['预警编号']),
  }
}

// ---------------------------------------------------------------------------
// 写操作
// ---------------------------------------------------------------------------

export type WaterRowDraft = {
  监测编号: string
  点位编码: string
  水位读数: number | ''
  采集时间: string
  rowVersion: number
}

function validateReading(reading: number | ''): number | null {
  const n = toNumber(reading)
  if (reading !== '' && n === null) return null
  if (n !== null && n < 0) return null
  return n
}

/** 登记新记录：只允许本点位监测人登记本点位；编号在同一点位下查重。 */
export function createWaterRow(draft: WaterRowDraft, operator: string): ActionResult {
  const point = findPoint(draft.点位编码)
  const target = `新记录（${draft.监测编号 || '未填编号'}）`
  if (!point) {
    const message = '退回：没有选择有效的监测点位，不能登记水位监测记录。'
    appendAudit({ operator, action: '登记记录', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const denied = requireOwner(point, operator, '登记水位监测记录')
  if (denied) {
    appendAudit({ operator, action: '登记记录', target: `${draft.监测编号 || '新记录'}@${point.name}`, ok: false, detail: denied.message })
    return denied
  }
  const code = draft.监测编号.trim()
  if (!code) {
    return { ok: false, message: '退回：监测编号不能为空。' }
  }
  const dup = findDuplicateCode(code, point.code)
  if (dup) {
    const message =
      `退回：监测编号重号。点位「${point.name}」下「${code}」已被记录 ${dup.id} 号`
      + `（${dup.监测人} 登记，当前状态「${dup.status}」）占用，请换一个编号。`
    appendAudit({ operator, action: '登记记录', target: `${code}@${point.name}`, ok: false, detail: message })
    return { ok: false, message }
  }
  const reading = validateReading(draft.水位读数)
  if (reading === null) {
    return { ok: false, message: '退回：水位读数必须是不小于 0 的数字；暂未采集时请留空。' }
  }
  const rows = listWaterRows()
  const id = rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
  const row: WaterLevelRow = {
    id,
    status: PENDING_COLLECT,
    pending: true,
    abnormal: false,
    监测编号: code,
    监测点位: point.name,
    点位编码: point.code,
    水位读数: reading ?? '',
    警戒水位: point.warningLevel,
    frozenWarningLevel: '',
    采集时间: draft.采集时间 || '',
    监测人: point.owner,
    超标判定: '待判定',
    监测状态: PENDING_COLLECT,
    判定时间: '',
    判定人: '',
    rowVersion: 1,
  }
  saveWaterRows([...rows, row])
  appendAudit({
    operator,
    action: '登记记录',
    target: `${code}@${point.name}`,
    ok: true,
    detail: `新登记 ${PENDING_COLLECT} 记录，当前点位警戒水位 ${point.warningLevel.toFixed(2)}m。`,
  })
  return { ok: true, message: `已登记监测记录 ${code}（${point.name}，${PENDING_COLLECT}）。` }
}

/**
 * 修改待采集记录的读数/编号/采集时间：
 * 仅本点位监测人；已采集及之后整条只读；同点位重号挡回；版本号过期按并发冲突处理。
 */
export function updateWaterRow(
  id: number,
  patch: Pick<WaterRowDraft, '监测编号' | '水位读数' | '采集时间' | 'rowVersion'>,
  operator: string,
): ActionResult {
  const rows = listWaterRows()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水位监测记录。` }
  }
  const current = rows[index]
  const point = findPoint(current.点位编码)
  const target = `${current.监测编号}@${current.监测点位}`
  if (!point) {
    return { ok: false, message: '退回：记录所属点位台账缺失，不能修改。' }
  }
  const denied = requireOwner(point, operator, '修改水位读数')
  if (denied) {
    appendAudit({ operator, action: '修改记录', target, ok: false, detail: denied.message })
    return denied
  }
  if (current.status !== PENDING_COLLECT) {
    const message =
      `退回：记录 ${current.监测编号} 监测状态为「${current.status}」，已采集的记录整条只读，`
      + '读数、阈值与判定均不可再改；历史取值保持采集时的结果。'
    appendAudit({ operator, action: '修改记录', target, ok: false, detail: message })
    return { ok: false, message }
  }
  if (patch.rowVersion !== current.rowVersion) {
    const message =
      `并发冲突：记录 ${current.监测编号} 已被 ${current.监测人} 先提交过一版（版本 ${current.rowVersion}），`
      + `你手里的是版本 ${patch.rowVersion}，只认先到的那一版，请刷新后基于最新版本再改。`
    appendAudit({ operator, action: '修改记录', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const code = patch.监测编号.trim()
  if (!code) {
    return { ok: false, message: '退回：监测编号不能为空。' }
  }
  const dup = findDuplicateCode(code, point.code, id)
  if (dup) {
    const message =
      `退回：监测编号重号。点位「${point.name}」下「${code}」已被记录 ${dup.id} 号`
      + `（${dup.监测人} 登记）占用，与记录 ${id} 撞号，请换一个编号。`
    appendAudit({ operator, action: '修改记录', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const reading = validateReading(patch.水位读数)
  if (reading === null) {
    return { ok: false, message: '退回：水位读数必须是不小于 0 的数字；暂未采集时请留空。' }
  }
  const updated: WaterLevelRow = {
    ...current,
    监测编号: code,
    水位读数: reading ?? '',
    警戒水位: point.warningLevel,
    采集时间: patch.采集时间 || '',
    rowVersion: current.rowVersion + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveWaterRows(next)
  appendAudit({
    operator,
    action: '修改记录',
    target: `${code}@${point.name}`,
    ok: true,
    detail:
      `读数 ${current.水位读数 === '' ? '空' : Number(current.水位读数).toFixed(2) + 'm'}`
      + ` → ${reading === null ? '空' : reading.toFixed(2) + 'm'}；版本 ${current.rowVersion} → ${updated.rowVersion}。`,
  })
  return { ok: true, message: `记录 ${code} 已更新，只保留先到的这一版（版本 ${updated.rowVersion}）。` }
}

/**
 * 提交采集：待采集 → 已采集。提交时按点位当前阈值固化阈值快照，整条转只读。
 */
export function submitCollect(id: number, operator: string): ActionResult {
  const rows = listWaterRows()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水位监测记录。` }
  }
  const current = rows[index]
  const point = findPoint(current.点位编码)
  const target = `${current.监测编号}@${current.监测点位}`
  if (!point) {
    return { ok: false, message: '退回：记录所属点位台账缺失，不能提交采集。' }
  }
  const denied = requireOwner(point, operator, '提交采集')
  if (denied) {
    appendAudit({ operator, action: '提交采集', target, ok: false, detail: denied.message })
    return denied
  }
  if (current.status !== PENDING_COLLECT) {
    const message = `退回：记录 ${current.监测编号} 已是「${current.status}」，不能重复提交采集；已采集记录整条只读。`
    appendAudit({ operator, action: '提交采集', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const reading = toNumber(current.水位读数)
  if (reading === null) {
    const message = `退回：记录 ${current.监测编号} 还没有水位读数，不能提交采集。`
    appendAudit({ operator, action: '提交采集', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const stamp = current.采集时间 || nowStamp()
  const updated: WaterLevelRow = {
    ...current,
    status: COLLECTED,
    监测状态: COLLECTED,
    采集时间: stamp,
    警戒水位: point.warningLevel,
    frozenWarningLevel: point.warningLevel,
    超标判定: '待判定',
    rowVersion: current.rowVersion + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveWaterRows(next)
  appendAudit({
    operator,
    action: '提交采集',
    target,
    ok: true,
    detail:
      `读数 ${reading.toFixed(2)}m 已采集，固化采集时警戒水位 ${point.warningLevel.toFixed(2)}m；`
      + '记录转只读，超限标记按统一规则计算。',
  })
  return { ok: true, message: `记录 ${current.监测编号} 已提交采集（读数 ${reading.toFixed(2)}m），整条转只读。` }
}

function conclude(id: number, asExceeded: boolean, operator: string): ActionResult {
  const verb = asExceeded ? '标记超警戒' : '判定正常'
  const rows = listWaterRows()
  const index = rows.findIndex((row) => row.id === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的水位监测记录。` }
  }
  const current = rows[index]
  const point = findPoint(current.点位编码)
  const target = `${current.监测编号}@${current.监测点位}`
  if (!point) {
    return { ok: false, message: '退回：记录所属点位台账缺失，不能判定。' }
  }
  const denied = requireOwner(point, operator, verb)
  if (denied) {
    appendAudit({ operator, action: verb, target, ok: false, detail: denied.message })
    return denied
  }
  if (current.status !== COLLECTED) {
    const message =
      `退回：只有「${COLLECTED}」的记录才能${verb}；记录 ${current.监测编号} 当前为「${current.status}」`
      + (current.status === NORMAL || current.status === EXCEEDED ? '，已判定记录保持当时取值。' : '，请先提交采集。')
    appendAudit({ operator, action: verb, target, ok: false, detail: message })
    return { ok: false, message }
  }
  const verdict = evaluateRow(current, point)
  if (verdict.reading === null || verdict.effectiveWarningLevel === null) {
    return { ok: false, message: `退回：记录 ${current.监测编号} 读数或警戒水位缺失，无法${verb}。` }
  }
  if (verdict.exceeded !== asExceeded) {
    const message =
      `退回：${verb}与统一判定规则不符。记录 ${current.监测编号} 读数 ${verdict.reading.toFixed(2)}m、`
      + `警戒水位 ${verdict.effectiveWarningLevel.toFixed(2)}m，系统判定为「${verdict.label}」，`
      + '列表与详情都以该结论为准，不能手工标成相反结果。'
    appendAudit({ operator, action: verb, target, ok: false, detail: message })
    return { ok: false, message }
  }
  const label = asExceeded ? EXCEEDED : NORMAL
  const updated: WaterLevelRow = {
    ...current,
    status: label,
    pending: !asExceeded,
    abnormal: asExceeded,
    监测状态: label,
    超标判定: asExceeded ? '超警戒' : '未超限',
    判定时间: nowStamp(),
    判定人: operator,
    // 判定按哪个阈值算，就把哪个阈值固化下来；此后阈值再改，这条记录保持当时取值。
    frozenWarningLevel: verdict.effectiveWarningLevel ?? '',
    rowVersion: current.rowVersion + 1,
  }
  const next = [...rows]
  next[index] = updated
  saveWaterRows(next)
  appendAudit({
    operator,
    action: verb,
    target,
    ok: true,
    detail:
      `读数 ${verdict.reading.toFixed(2)}m ${asExceeded ? '≥' : '<'} 判定时警戒水位 ${verdict.effectiveWarningLevel.toFixed(2)}m，`
      + `判定「${label}」，阈值快照与结论自此冻结。`,
  })
  const sync = syncWarnDraft(point.code)
  if (sync.message) {
    appendAudit({
      operator,
      action: sync.action,
      target: `${point.name}（${point.code}）`,
      ok: true,
      detail: sync.message,
    })
  }
  return {
    ok: true,
    message: `记录 ${current.监测编号} 判定为「${label}」。${sync.message}`,
  }
}

export function judgeNormal(id: number, operator: string): ActionResult {
  return conclude(id, false, operator)
}

export function judgeExceeded(id: number, operator: string): ActionResult {
  return conclude(id, true, operator)
}

export type ThresholdChangeResult = ActionResult & {
  diffs?: ThresholdRecomputeDiff[]
  oldLevel?: number
  newLevel?: number
  pointName?: string
}

/**
 * 调整点位警戒水位：
 * 1. 仅本点位监测人可改，乐观锁挡住后到的一版；
 * 2. 挂起记录（待采集/已采集）按同一份统一规则重算超限标记；
 * 3. 重算前后的差异逐条保留（审计痕迹），只记录标记真正变化的行；
 * 4. 已判定（水位正常/超警戒）记录保持当时的取值，绝不回改。
 */
export function changeWarningLevel(
  code: string,
  newLevelInput: number | string,
  expectedVersion: number,
  operator: string,
): ThresholdChangeResult {
  const points = listPoints()
  const index = points.findIndex((point) => point.code === code)
  if (index < 0) {
    return { ok: false, message: `没有找到点位编码为 ${code} 的监测点位。` }
  }
  const point = points[index]
  const target = `${point.name}（${point.code}）`
  const denied = requireOwner(point, operator, '调整警戒水位')
  if (denied) {
    appendAudit({ operator, action: '调整警戒水位', target, ok: false, detail: denied.message })
    return denied
  }
  if (expectedVersion !== point.version) {
    const message =
      `并发冲突：点位「${point.name}」的警戒水位已被 ${point.updatedBy} 先改过一版（版本 ${point.version}），`
      + `你手里的是版本 ${expectedVersion}，只认先到的那一版，请刷新后基于最新版本再改。`
    appendAudit({ operator, action: '调整警戒水位', target, ok: false, detail: message })
    return { ok: false, message }
  }
  const n = typeof newLevelInput === 'number' ? newLevelInput : Number(String(newLevelInput).trim())
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: '退回：新的警戒水位必须是大于 0 的数字。' }
  }
  const oldLevel = point.warningLevel
  if (n === oldLevel) {
    return { ok: false, message: `新警戒水位与现值相同（${oldLevel.toFixed(2)}m），没有改动。` }
  }

  const stamp = nowStamp()
  const nextPoint: WaterLevelPoint = {
    ...point,
    warningLevel: n,
    version: point.version + 1,
    updatedAt: stamp,
    updatedBy: operator,
  }
  const nextPoints = [...points]
  nextPoints[index] = nextPoint
  savePoints(nextPoints)

  // 重算挂起记录：before 用旧阈值、after 用新阈值，走同一个 evaluateRow。
  const oldPointView: WaterLevelPoint = { ...point }
  const newPointView: WaterLevelPoint = { ...nextPoint }
  const diffs: ThresholdRecomputeDiff[] = []
  const rows = listWaterRows()
  let recomputed = 0
  let frozenKept = 0
  const nextRows = rows.map((row) => {
    if (row.点位编码 !== code) return row
    const verdictBefore = evaluateRow(row, oldPointView)
    if (verdictBefore.frozen) {
      frozenKept += 1
      return row
    }
    recomputed += 1
    const verdictAfter = evaluateRow({ ...row, 警戒水位: n }, newPointView)
    const changed = verdictBefore.label !== verdictAfter.label
      || verdictBefore.exceeded !== verdictAfter.exceeded
    if (verdictAfter.reading !== null) {
      diffs.push({
        id: row.id,
        监测编号: row.监测编号,
        监测点位: row.监测点位,
        oldThreshold: oldLevel,
        newThreshold: n,
        reading: verdictAfter.reading,
        before: verdictBefore.label,
        after: verdictAfter.label,
        changed,
      })
    }
    // 已采集记录整条只读：读数、状态、快照一律不动，仅列表/详情按新阈值统一展示超限标记；
    // 待采集记录也不改业务字段，只把展示用阈值跟随到点位最新值。
    if (row.status === PENDING_COLLECT) {
      return { ...row, 警戒水位: n, rowVersion: row.rowVersion + 1 }
    }
    return row
  })
  saveWaterRows(nextRows)

  const changedDiffs = diffs.filter((diff) => diff.changed)
  appendAudit({
    operator,
    action: '调整警戒水位',
    target,
    ok: true,
    detail:
      `警戒水位 ${oldLevel.toFixed(2)}m → ${n.toFixed(2)}m，点位版本 ${point.version} → ${nextPoint.version}。`
      + `挂起记录按统一规则重算 ${recomputed} 条，超限标记变化 ${changedDiffs.length} 条`
      + (changedDiffs.length
        ? `：${changedDiffs.map((d) => `${d.监测编号}（${d.before}→${d.after}，读数 ${d.reading?.toFixed(2)}m）`).join('；')}`
        : '（无）')
      + `。已判定历史记录 ${frozenKept} 条保持当时取值不变。`,
  })
  const sync = syncWarnDraft(code)
  if (sync.message) {
    appendAudit({
      operator,
      action: sync.action,
      target,
      ok: true,
      detail: sync.message,
    })
  }
  return {
    ok: true,
    message:
      `点位「${point.name}」警戒水位已由 ${oldLevel.toFixed(2)}m 改为 ${n.toFixed(2)}m；`
      + `挂起记录重算 ${recomputed} 条、标记变化 ${changedDiffs.length} 条，`
      + `已判定记录 ${frozenKept} 条保持原值。${sync.message}`,
    diffs,
    oldLevel,
    newLevel: n,
    pointName: point.name,
  }
}

/** 把水位监测记录、点位台账、审计痕迹以及由超限结论生成的待拟稿单恢复到播种状态。 */
export function resetWaterLevelDomain(): void {
  resetRows(ROW_KEY)
  resetRows(WARN_KEY)
  resetCollection(POINTS)
  resetCollection(AUDIT)
}

/** 供页面与测试读取关联模块数据（如防涝预警待拟稿清单）。 */
export function readLinkedRows(key: string): EntryRow[] {
  return listRows(key)
}
