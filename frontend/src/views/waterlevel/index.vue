<template>
  <section class="page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          归属按监测点位管理：每个点位只由本点位监测人维护，读数与警戒水位非本人提交一律退回；
          已采集记录整条只读，阈值调整后挂起记录按同一规则重算并保留差异，超限结论自动落入防涝预警待拟稿清单。
        </p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记水位监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
        <button class="btn ghost" type="button" @click="resetDomain">重置演示数据</button>
      </div>
    </header>

    <div class="identity-bar">
      <label class="filter-item">
        <span>当前监测人（切换后再操作可模拟别的点位提交）</span>
        <select :value="store.operator" @change="onOperatorChange">
          <option v-for="name in operatorOptions" :key="name" :value="name">{{ name }}</option>
        </select>
      </label>
      <span class="identity-hint">
        本工作台共 {{ points.length }} 个监测点位；点位归属与阈值见下方「监测点位归属与警戒水位」。
      </span>
    </div>

    <div v-if="banner" class="alert-banner" :class="bannerOk ? 'ok' : 'err'" @click="banner = ''">
      {{ banner }}（点击关闭）
    </div>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <section class="point-panel">
      <h3>监测点位归属与警戒水位</h3>
      <p class="panel-hint">
        警戒水位是点位属性，只由「归属监测人」调整；调整后挂起记录（待采集/已采集）立即按同一规则重算超限标记，
        重算差异与已判定记录的冻结说明保留在审计痕迹里。
      </p>
      <table class="data-table point-table">
        <thead>
          <tr>
            <th>点位编码</th>
            <th>监测点位</th>
            <th>归属监测人</th>
            <th>当前警戒水位</th>
            <th>版本/最近修改</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="point in points" :key="point.code">
            <td>{{ point.code }}</td>
            <td>{{ point.name }}</td>
            <td>
              {{ point.owner }}
              <span v-if="point.owner === store.operator" class="tag tag-self">本人点位</span>
              <span v-else class="tag tag-other">非本人</span>
            </td>
            <td>{{ point.warningLevel.toFixed(2) }} m</td>
            <td>v{{ point.version }} · {{ point.updatedBy }} {{ point.updatedAt }}</td>
            <td>
              <button
                v-if="point.owner === store.operator"
                class="link"
                type="button"
                @click="beginThreshold(point)"
              >
                调整警戒水位
              </button>
              <span v-else class="muted-text">仅 {{ point.owner }} 可改</span>
            </td>
          </tr>
        </tbody>
      </table>
      <form v-if="thresholdForm" class="inline-form" @submit.prevent="submitThreshold">
        <span>
          为「{{ thresholdForm.pointName }}」设置新警戒水位（当前
          {{ thresholdForm.oldLevel.toFixed(2) }}m，所持版本 v{{ thresholdForm.version }}）：
        </span>
        <input v-model="thresholdForm.level" type="number" step="0.1" min="0" placeholder="如 7.0" />
        <button class="btn primary" type="submit">提交并重算挂起记录</button>
        <button class="btn ghost" type="button" @click="thresholdForm = null">取消</button>
      </form>
    </section>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
      <button class="btn ghost" type="button" @click="reload">刷新（处理并发版本）</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="String(row.id)">
          <td>{{ row.监测编号 }}</td>
          <td>
            {{ row.监测点位 }}
            <span class="tag tag-owner">{{ row.ownedBy }}</span>
            <span v-if="!row.live" class="tag tag-frozen">历史只读</span>
          </td>
          <td>{{ formatReading(row.水位读数) }}</td>
          <td>
            {{ formatLevel(row.viewWarningLevel) }}
            <span v-if="row.live" class="tag tag-live">随点位</span>
            <span v-else class="tag tag-frozen">采集时快照</span>
          </td>
          <td>{{ row.采集时间 || '—' }}</td>
          <td>{{ row.监测人 }}</td>
          <td :class="row.viewExceeded ? 'verdict-exceeded' : 'verdict-ok'">
            {{ row.viewVerdict }}
          </td>
          <td>{{ row.监测状态 }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">详情</button>
            <button
              v-if="row.status === '待采集'"
              class="link"
              type="button"
              @click="openEdit(row)"
            >
              修改
            </button>
            <button
              v-if="row.status === '待采集'"
              class="link"
              type="button"
              @click="doAction('submit', row)"
            >
              提交采集
            </button>
            <button
              v-if="row.status === '已采集'"
              class="link"
              type="button"
              @click="doAction('normal', row)"
            >
              判定正常
            </button>
            <button
              v-if="row.status === '已采集'"
              class="link"
              type="button"
              @click="doAction('exceeded', row)"
            >
              标记超警戒
            </button>
            <span v-if="row.status !== '待采集' && row.status !== '已采集'" class="muted-text">已冻结</span>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无符合条件的水位监测数据</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条水位监测记录（总数 {{ rows.length }} 条）</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 登记 / 修改记录 -->
    <div v-if="formMode" class="modal-mask" @click.self="formMode = null">
      <div class="modal">
        <h3>{{ formMode === 'create' ? '登记水位监测记录' : `修改记录 ${formModel.code}` }}</h3>
        <p v-if="formMode === 'edit'" class="panel-hint">
          仅待采集记录可改；所持版本 v{{ formModel.version }}，若期间已有人先提交，保存会被并发校验挡回。
        </p>
        <div class="form-grid">
          <label class="filter-item">
            <span>监测点位</span>
            <select v-model="formModel.pointCode" :disabled="formMode === 'edit'">
              <option v-for="point in points" :key="point.code" :value="point.code">
                {{ point.name }}（归属：{{ point.owner }}）
              </option>
            </select>
          </label>
          <label class="filter-item">
            <span>监测编号（同一点位下不可重号）</span>
            <input v-model="formModel.code" placeholder="如 SW-BH-0009" />
          </label>
          <label class="filter-item">
            <span>水位读数 m（待采集可留空）</span>
            <input v-model="formModel.reading" type="number" step="0.01" min="0" placeholder="如 8.2" />
          </label>
          <label class="filter-item">
            <span>采集时间</span>
            <input v-model="formModel.collectedAt" placeholder="如 2026-10-05 08:00" />
          </label>
        </div>
        <p class="panel-hint">
          提交人：{{ store.operator }}。若所选点位归属监测人不是当前身份，保存时将按越权退回并写明越在哪。
        </p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="submitForm">保存</button>
          <button class="btn ghost" type="button" @click="formMode = null">取消</button>
        </div>
      </div>
    </div>

    <!-- 详情：与列表共用 evaluateRow，口径一致 -->
    <div v-if="detailRow" class="modal-mask" @click.self="detailRow = null">
      <div class="modal">
        <h3>监测记录详情 · {{ detailRow.监测编号 }}</h3>
        <table class="detail-table">
          <tbody>
            <tr><th>监测点位</th><td>{{ detailRow.监测点位 }}（{{ detailRow.点位编码 }}）</td></tr>
            <tr><th>点位归属监测人</th><td>{{ detailRow.ownedBy }}</td></tr>
            <tr><th>水位读数</th><td>{{ formatReading(detailRow.水位读数) }}</td></tr>
            <tr>
              <th>警戒水位</th>
              <td>
                {{ formatLevel(detailVerdict?.effectiveWarningLevel ?? null) }}
                <span v-if="detailVerdict?.frozen" class="tag tag-frozen">判定时阈值快照，阈值改动不影响本记录</span>
                <span v-else class="tag tag-live">跟随点位当前阈值</span>
              </td>
            </tr>
            <tr><th>采集时间</th><td>{{ detailRow.采集时间 || '—' }}</td></tr>
            <tr><th>监测人</th><td>{{ detailRow.监测人 }}</td></tr>
            <tr>
              <th>超限判定</th>
              <td :class="detailVerdict?.exceeded ? 'verdict-exceeded' : 'verdict-ok'">
                {{ detailVerdict?.label ?? '—' }}
                <span class="panel-hint">（读数 ≥ 警戒水位 即超警戒，列表与详情同一规则）</span>
              </td>
            </tr>
            <tr><th>记录版本</th><td>v{{ detailRow.rowVersion }}</td></tr>
            <tr><th>判定时间 / 判定人</th><td>{{ detailRow.判定时间 || '—' }} / {{ detailRow.判定人 || '—' }}</td></tr>
            <tr><th>只读状态</th><td>{{ detailRow.live ? '挂起中（阈值随点位重算）' : '已判定历史记录，整条只读并保持当时取值' }}</td></tr>
          </tbody>
        </table>
        <div class="modal-actions">
          <button class="btn" type="button" @click="detailRow = null">关闭</button>
        </div>
      </div>
    </div>

    <!-- 审计痕迹 -->
    <section class="audit-panel">
      <button class="btn ghost" type="button" @click="showAudit = !showAudit">
        {{ showAudit ? '收起' : '展开' }}变更与退回痕迹（{{ auditEntries.length }}）
      </button>
      <table v-if="showAudit" class="data-table audit-table">
        <thead>
          <tr>
            <th>时间</th>
            <th>操作人</th>
            <th>操作</th>
            <th>对象</th>
            <th>结果</th>
            <th>说明（含越权/重号/并发/重算差异）</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="entry in auditEntries" :key="entry.id" :class="entry.ok ? '' : 'audit-denied'">
            <td>{{ entry.at }}</td>
            <td>{{ entry.operator }}</td>
            <td>{{ entry.action }}</td>
            <td>{{ entry.target }}</td>
            <td>{{ entry.ok ? '成功' : '退回' }}</td>
            <td>{{ entry.detail }}</td>
          </tr>
        </tbody>
      </table>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, moduleMeta } from '@/api/local-service'
import {
  changeWarningLevel,
  createWaterRow,
  evaluateRow,
  judgeExceeded,
  judgeNormal,
  listAudit,
  listPoints,
  listWaterViewRows,
  resetWaterLevelDomain,
  submitCollect,
  updateWaterRow,
  type WaterLevelViewRow,
} from '@/api/waterlevel-service'
import { useSessionStore } from '@/stores/session'
import type { WaterLevelAuditEntry, WaterLevelPoint, WaterLevelVerdict } from '@/data/types'

const store = useSessionStore()
const meta = moduleMeta('waterlevel')

const columns = ['监测编号', '监测点位', '水位读数', '警戒水位', '采集时间', '监测人', '超标判定', '监测状态']
const filterFields = ['监测编号', '监测点位', '监测人']
const statuses = ['待采集', '已采集', '水位正常', '超警戒']

const rows = ref<WaterLevelViewRow[]>([])
const points = ref<WaterLevelPoint[]>([])
const auditEntries = ref<WaterLevelAuditEntry[]>([])
const errorMessage = ref('')
const banner = ref('')
const bannerOk = ref(false)
const filters = ref<Record<string, string>>({})
const showAudit = ref(false)

const operatorOptions = computed(() => {
  const owners = points.value.map((point) => point.owner)
  return Array.from(new Set(['值班管理员', ...owners]))
})

const filteredRows = computed(() => {
  const pairs = Object.entries(filters.value).filter(([, value]) => value.trim() !== '')
  if (!pairs.length) return rows.value
  return rows.value.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
})

const stats = computed(() => [
  { label: '待采集点位', value: rows.value.filter((row) => row.status === '待采集').length },
  { label: '挂起记录（待判定）', value: rows.value.filter((row) => row.status === '待采集' || row.status === '已采集').length },
  { label: '当前超限点位数（统一规则）', value: new Set(rows.value.filter((row) => row.viewExceeded).map((row) => row.点位编码)).size },
  { label: '超警戒历史结论', value: rows.value.filter((row) => row.status === '超警戒').length },
])

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function flashBanner(message: string, ok: boolean) {
  banner.value = message
  bannerOk.value = ok
}

function formatReading(value: number | ''): string {
  return value === '' || value === undefined ? '—' : `${Number(value).toFixed(2)} m`
}
function formatLevel(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} m`
}

function onOperatorChange(event: Event) {
  store.setOperator((event.target as HTMLSelectElement).value)
}

function reload() {
  errorMessage.value = ''
  points.value = listPoints()
  rows.value = listWaterViewRows()
  auditEntries.value = listAudit()
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function resetDomain() {
  resetWaterLevelDomain()
  reload()
  thresholdForm.value = null
  formMode.value = null
  detailRow.value = null
  flashBanner('水位监测领域（记录、点位台账、审计痕迹、自动待拟稿单）已恢复到播种状态。', true)
}

// --- 阈值调整 ---------------------------------------------------------------

type ThresholdForm = {
  code: string
  pointName: string
  oldLevel: number
  version: number
  level: string
}
const thresholdForm = ref<ThresholdForm | null>(null)

function beginThreshold(point: WaterLevelPoint) {
  thresholdForm.value = {
    code: point.code,
    pointName: point.name,
    oldLevel: point.warningLevel,
    version: point.version,
    level: String(point.warningLevel),
  }
}

function submitThreshold() {
  const form = thresholdForm.value
  if (!form) return
  const result = changeWarningLevel(form.code, form.level, form.version, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    flashBanner(result.message, false)
  } else {
    const changed = (result.diffs ?? []).filter((diff) => diff.changed)
    flashBanner(
      `${result.message}${changed.length ? ` 标记变化：${changed.map((d) => `${d.监测编号} ${d.before}→${d.after}`).join('；')}` : ''}`,
      true,
    )
  }
  thresholdForm.value = null
  reload()
}

// --- 登记 / 修改 -------------------------------------------------------------

type FormState = {
  id: number
  pointCode: string
  code: string
  reading: string
  collectedAt: string
  version: number
}
const formMode = ref<'create' | 'edit' | null>(null)
const formModel = reactive<FormState>({ id: 0, pointCode: '', code: '', reading: '', collectedAt: '', version: 1 })

function openCreate() {
  const own = points.value.find((point) => point.owner === store.operator)
  formMode.value = 'create'
  Object.assign(formModel, {
    id: 0,
    pointCode: own?.code ?? points.value[0]?.code ?? '',
    code: '',
    reading: '',
    collectedAt: '',
    version: 1,
  })
}

function openEdit(row: WaterLevelViewRow) {
  formMode.value = 'edit'
  Object.assign(formModel, {
    id: row.id,
    pointCode: row.点位编码,
    code: row.监测编号,
    reading: row.水位读数 === '' ? '' : String(row.水位读数),
    collectedAt: row.采集时间,
    version: row.rowVersion,
  })
}

function submitForm() {
  const reading: number | '' = formModel.reading.trim() === '' ? '' : Number(formModel.reading)
  const payload = {
    监测编号: formModel.code,
    点位编码: formModel.pointCode,
    水位读数: reading,
    采集时间: formModel.collectedAt.trim(),
    rowVersion: formModel.version,
  }
  const result = formMode.value === 'create'
    ? createWaterRow(payload, store.operator)
    : updateWaterRow(formModel.id, payload, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    flashBanner(result.message, false)
  } else {
    flashBanner(result.message, true)
    formMode.value = null
  }
  reload()
}

// --- 行动作 -----------------------------------------------------------------

function doAction(kind: 'submit' | 'normal' | 'exceeded', row: WaterLevelViewRow) {
  const result = kind === 'submit'
    ? submitCollect(row.id, store.operator)
    : kind === 'normal'
      ? judgeNormal(row.id, store.operator)
      : judgeExceeded(row.id, store.operator)
  if (!result.ok) {
    errorMessage.value = result.message
    flashBanner(result.message, false)
  } else {
    flashBanner(result.message, true)
  }
  reload()
}

// --- 详情 -------------------------------------------------------------------

const detailRow = ref<WaterLevelViewRow | null>(null)
const detailVerdict = ref<WaterLevelVerdict | null>(null)

function openDetail(row: WaterLevelViewRow) {
  const point = points.value.find((item) => item.code === row.点位编码)
  detailRow.value = row
  detailVerdict.value = evaluateRow(row, point)
}

onMounted(reload)
</script>

<style scoped>
.identity-bar {
  display: flex;
  align-items: flex-end;
  gap: 16px;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.identity-hint {
  font-size: 12px;
  color: var(--muted);
}
.alert-banner {
  border-radius: 8px;
  padding: 8px 12px;
  font-size: 13px;
  margin-bottom: 12px;
  cursor: pointer;
}
.alert-banner.ok {
  background: #ecfdf3;
  border: 1px solid #75e0a7;
  color: #05603a;
}
.alert-banner.err {
  background: #fef3f2;
  border: 1px solid #fecdca;
  color: #b42318;
}
.point-panel,
.audit-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  margin: 12px 0;
}
.point-panel h3 {
  margin: 2px 0 6px;
  font-size: 14px;
}
.panel-hint {
  font-size: 12px;
  color: var(--muted);
  margin: 4px 0;
}
.point-table {
  margin-top: 6px;
}
.inline-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-top: 10px;
  padding: 8px 10px;
  background: #f8fafc;
  border: 1px dashed var(--border);
  border-radius: 6px;
  font-size: 13px;
}
.inline-form input {
  width: 110px;
  padding: 4px 8px;
}
.tag {
  display: inline-block;
  font-size: 11px;
  border-radius: 999px;
  padding: 0 8px;
  margin-left: 4px;
  line-height: 18px;
}
.tag-self { background: #dbeafe; color: #1d4ed8; }
.tag-other { background: #f1f5f9; color: #64748b; }
.tag-owner { background: #eef2ff; color: #4338ca; }
.tag-live { background: #fef9c3; color: #854d0e; }
.tag-frozen { background: #f1f5f9; color: #475569; }
.muted-text {
  font-size: 12px;
  color: var(--muted);
}
.verdict-exceeded {
  color: #b42318;
  font-weight: 600;
}
.verdict-ok {
  color: #05603a;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(15, 23, 42, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  background: #fff;
  border-radius: 10px;
  width: 620px;
  max-width: 92vw;
  max-height: 86vh;
  overflow: auto;
  padding: 16px 18px;
}
.modal h3 {
  margin: 0 0 10px;
  font-size: 15px;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 14px;
}
.detail-table {
  width: 100%;
  border-collapse: collapse;
}
.detail-table th,
.detail-table td {
  border: 1px solid var(--border);
  padding: 6px 10px;
  font-size: 13px;
  text-align: left;
  vertical-align: top;
}
.detail-table th {
  width: 150px;
  background: #f8fafc;
}
.audit-table {
  margin-top: 8px;
}
.audit-denied {
  background: #fef3f2;
}
.audit-denied td:last-child {
  color: #b42318;
}
</style>
