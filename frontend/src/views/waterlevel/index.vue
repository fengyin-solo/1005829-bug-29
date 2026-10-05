<template>
  <section class="page water-page" data-module="waterlevel">
    <header class="page-head">
      <div>
        <h2>水位监测管理</h2>
        <p class="page-desc">
          归属卡到点位：每个监测点位只由本点位监测人维护，水位读数与警戒水位只有本人能改，别的点位提交一律退回；
          监测状态为已采集的记录整条只读；同一到站编号在同一点位下不得重号；警戒水位调整后，挂着的记录按同一份规则重算并保留前后差异；
          超警戒结论自动落入防涝预警待拟稿清单。
        </p>
      </div>
      <div class="page-actions">
        <label class="operator-switch">
          <span>当前身份</span>
          <select v-model="operator">
            <option v-for="op in OPERATORS" :key="op.name" :value="op.name">
              {{ op.name }}{{ op.pointCode ? `（${pointNameOf(op.pointCode)}监测人）` : '（非点位监测人）' }}
            </option>
          </select>
        </label>
        <button class="btn primary" type="button" :disabled="!owned" @click="openCreate">登记水位监测记录</button>
        <button class="btn" type="button" @click="exportRows">导出水位监测清单</button>
      </div>
    </header>

    <p :class="['rule-banner', owned ? 'ok' : 'warn']">
      <template v-if="owned">
        您是点位「{{ owned.name }}」的监测人：只能登记/维护本点位记录、调整本点位警戒水位；对其他点位的任何写操作都会被退回并写明越界原因。
      </template>
      <template v-else>
        当前身份「{{ store.operator }}」不是任何监测点位的监测人，仅可查看；水位读数、警戒水位的修改与提交采集都会被退回。
      </template>
    </p>

    <div class="stat-row">
      <article class="stat-card">
        <span class="stat-label">待采集（挂着）记录</span>
        <strong class="stat-value">{{ stats.open }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">已采集（整条只读）</span>
        <strong class="stat-value">{{ stats.locked }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">超警戒记录</span>
        <strong class="stat-value stat-danger">{{ stats.over }}</strong>
      </article>
      <article class="stat-card">
        <span class="stat-label">防涝预警待拟稿</span>
        <strong class="stat-value stat-danger">{{ stats.drafts }}</strong>
      </article>
    </div>

    <h3 class="block-title">监测点位目录（归属与阈值）</h3>
    <div class="point-grid">
      <article
        v-for="point in view.points"
        :key="point.code"
        :class="['point-card', { mine: owned && owned.code === point.code }]"
      >
        <header>
          <span class="point-name">{{ point.name }}</span>
          <span class="point-code">{{ point.code }}</span>
        </header>
        <p class="point-line">监测人：<strong>{{ point.monitor }}</strong></p>
        <p class="point-line">
          警戒水位：<strong class="point-threshold">{{ point.threshold.toFixed(2) }} 米</strong>
          <span class="point-version">阈值版本 v{{ point.version }}</span>
        </p>
        <p class="point-line point-hanging">挂着待重算记录：{{ hangingCount(point.code) }} 条</p>
        <button
          v-if="store.operator === point.monitor"
          class="btn small primary"
          type="button"
          @click="openAdjust(point)"
        >
          调整本点位警戒水位
        </button>
        <span v-else class="point-lock">仅本点位监测人 {{ point.monitor }} 可调整</span>
      </article>
    </div>

    <p v-if="stats.drafts > 0" class="draft-banner">
      有 {{ stats.drafts }} 条超警戒结论已落入
      <RouterLink to="/floodwarn">防涝预警待拟稿清单</RouterLink>
      ，请前往拟稿发布。
    </p>

    <form class="filter-bar" @submit.prevent="() => reload()">
      <label class="filter-item">
        <span>监测编号</span>
        <input v-model="filters.code" placeholder="按监测编号检索" />
      </label>
      <label class="filter-item">
        <span>监测点位</span>
        <input v-model="filters.point" placeholder="按监测点位检索" />
      </label>
      <label class="filter-item">
        <span>监测状态</span>
        <select v-model="filters.status">
          <option value="">全部</option>
          <option value="待采集">待采集</option>
          <option value="已采集">已采集</option>
        </select>
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table water-table">
      <thead>
        <tr>
          <th>监测编号</th>
          <th>监测点位</th>
          <th>水位读数(米)</th>
          <th>判定用警戒水位(米)</th>
          <th>超标判定</th>
          <th>采集时间</th>
          <th>监测人</th>
          <th>版本</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in filteredRows" :key="row.id" :class="{ 'row-over': row.abnormal, 'row-locked': isLocked(row) }">
          <td>{{ row.code }}</td>
          <td>{{ row.pointName }}</td>
          <td>{{ row.reading === null ? '—' : row.reading.toFixed(2) }}</td>
          <td>{{ Number(row.警戒水位).toFixed(2) }}</td>
          <td>
            <span :class="['flag', flagClass(row.overFlag)]">{{ row.overFlag }}</span>
            <span v-if="isLocked(row)" class="snapshot-hint" title="记录采集时的阈值快照">（入表快照）</span>
          </td>
          <td>{{ row.采集时间 || '—' }}</td>
          <td>{{ row.monitor }}</td>
          <td>v{{ row.version }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="isLocked(row)">
              <button class="link" type="button" @click="openDetail(row.id)">详情</button>
              <span class="locked-hint">已采集·只读</span>
            </template>
            <template v-else>
              <button class="link" type="button" @click="openEdit(row)">维护读数/编号</button>
              <button class="link" type="button" @click="submitRecord(row)">提交采集</button>
              <button class="link" type="button" @click="openDetail(row.id)">详情</button>
            </template>
          </td>
        </tr>
        <tr v-if="!filteredRows.length">
          <td colspan="10" class="empty-state">暂无符合条件的水位监测记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ filteredRows.length }} 条水位监测记录</span>
      <span v-if="pageError" class="error-text">{{ pageError }}</span>
      <span v-if="pageOk" class="ok-text">{{ pageOk }}</span>
    </footer>

    <h3 class="block-title">操作留痕（越权、撞号、并发退回同样记录）</h3>
    <table class="data-table audit-table">
      <thead>
        <tr>
          <th>时间</th>
          <th>操作人</th>
          <th>动作</th>
          <th>点位 / 记录</th>
          <th>结果</th>
          <th>说明</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="entry in view.audit" :key="entry.id" :class="{ 'audit-denied': entry.denied }">
          <td>{{ entry.time }}</td>
          <td>{{ entry.operator }}</td>
          <td>{{ entry.action }}</td>
          <td>
            {{ entry.pointName || '—' }}{{ entry.recordCode ? ` / ${entry.recordCode}` : '' }}
          </td>
          <td>
            <span :class="['audit-result', entry.denied ? 'result-denied' : 'result-ok']">
              {{ entry.denied ? '已退回' : '成功' }}
            </span>
          </td>
          <td class="audit-detail">{{ entry.detail }}</td>
        </tr>
        <tr v-if="!view.audit.length">
          <td colspan="6" class="empty-state">暂无操作留痕</td>
        </tr>
      </tbody>
    </table>

    <!-- 登记 -->
    <div v-if="createOpen" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3>登记水位监测记录</h3>
        <p class="modal-line">归属点位：<strong>{{ owned?.name }}</strong>（监测人 {{ owned?.monitor }}）</p>
        <label class="form-item">
          <span>监测编号 *（同一到站编号在本点位下不可重号）</span>
          <input v-model="createForm.code" placeholder="例如 WATE-0010" />
        </label>
        <label class="form-item">
          <span>水位读数（米，可留空，提交采集前补录）</span>
          <input v-model="createForm.reading" placeholder="例如 4.62" />
        </label>
        <p class="form-hint">本点位当前警戒水位 {{ owned?.threshold.toFixed(2) }} 米，登记后即按该阈值给出超标判定。</p>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 维护挂着的记录 -->
    <div v-if="editTarget" class="modal-mask" @click.self="closeEdit">
      <div class="modal">
        <h3>维护水位监测记录 {{ editTarget.code }}</h3>
        <p class="modal-line">
          归属点位：<strong>{{ editTarget.pointName }}</strong> · 监测人 {{ editTarget.monitor }} ·
          当前判定用阈值 {{ Number(editTarget.警戒水位).toFixed(2) }} 米 · 当前判定「{{ editTarget.overFlag }}」
        </p>
        <p v-if="store.operator !== editTarget.monitor" class="error-text">
          您不是本点位监测人，提交将被退回（本点位监测人：{{ editTarget.monitor }}）。
        </p>
        <label class="form-item">
          <span>监测编号</span>
          <input v-model="editForm.code" />
        </label>
        <label class="form-item">
          <span>水位读数（米）</span>
          <input v-model="editForm.reading" placeholder="留空表示尚未读数" />
        </label>
        <p class="form-hint">保存后按点位当前阈值即时重算超标判定；记录版本 v{{ editTarget.version }}，他人先改过时本次提交会被退回。</p>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeEdit">取消</button>
          <button class="btn primary" type="button" @click="submitEdit">保存修改</button>
        </div>
      </div>
    </div>

    <!-- 调整点位警戒水位 -->
    <div v-if="adjustPoint" class="modal-mask" @click.self="closeAdjust">
      <div class="modal">
        <h3>调整警戒水位 · {{ adjustPoint.name }}</h3>
        <p class="modal-line">本点位监测人：{{ adjustPoint.monitor }} · 阈值版本 v{{ adjustPoint.version }}</p>
        <label class="form-item">
          <span>新警戒水位（米，当前 {{ adjustPoint.threshold.toFixed(2) }}）</span>
          <input v-model="adjustForm.threshold" placeholder="例如 4.20" />
        </label>
        <p class="form-hint">
          保存后，本点位 {{ hangingCount(adjustPoint.code) }} 条「待采集」记录将按同一份规则重算超标判定，并逐条保留重算前后差异；
          已采集记录整条只读，保持当时取值，不参与重算。
        </p>
        <p v-if="formError" class="error-text">{{ formError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeAdjust">取消</button>
          <button class="btn primary" type="button" @click="submitAdjust">保存并重算</button>
        </div>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="detailId !== null" class="modal-mask wide" @click.self="closeDetail">
      <div class="modal">
        <template v-if="detail">
          <h3>水位监测记录详情 · {{ detail.row.code }}</h3>
          <table class="data-table detail-table">
            <tbody>
              <tr><th>监测点位</th><td>{{ detail.row.pointName }}（{{ detail.row.pointCode }}）</td><th>本点位监测人</th><td>{{ detail.row.monitor }}</td></tr>
              <tr><th>水位读数</th><td>{{ detail.row.reading === null ? '未读数' : detail.row.reading.toFixed(2) + ' 米' }}</td><th>超标判定</th><td><span :class="['flag', flagClass(detail.row.overFlag)]">{{ detail.row.overFlag }}</span></td></tr>
              <tr><th>判定用警戒水位</th><td>{{ Number(detail.row.警戒水位).toFixed(2) }} 米</td><th>采集时间</th><td>{{ detail.row.采集时间 || '—' }}</td></tr>
              <tr><th>监测状态</th><td>{{ detail.row.status }}</td><th>记录版本</th><td>v{{ detail.row.version }}</td></tr>
            </tbody>
          </table>
          <p v-if="isLocked(detail.row)" class="form-hint locked-note">
            该记录已采集，整条只读：判定依据为采集入表时的阈值快照 {{ detail.row.thresholdSnapshot.toFixed(2) }} 米，
            之后点位警戒水位再怎么调整，这里都保持当时取值。
          </p>
          <p v-else class="form-hint">
            该记录仍挂着（待采集），超标判定随点位当前警戒水位（{{ detail.point.threshold.toFixed(2) }} 米）实时计算，与列表同一口径。
          </p>

          <h4 class="sub-title">阈值重算前后差异</h4>
          <table v-if="detail.row.recalcs.length" class="data-table">
            <thead>
              <tr><th>重算时间</th><th>操作人</th><th>阈值变化</th><th>判定变化</th></tr>
            </thead>
            <tbody>
              <tr v-for="(trace, i) in detail.row.recalcs" :key="i">
                <td>{{ trace.time }}</td>
                <td>{{ trace.operator }}</td>
                <td>{{ trace.oldThreshold.toFixed(2) }} → {{ trace.newThreshold.toFixed(2) }} 米</td>
                <td>{{ trace.beforeFlag }} → {{ trace.afterFlag }}</td>
              </tr>
            </tbody>
          </table>
          <p v-else class="form-hint">暂无重算记录。</p>

          <h4 class="sub-title">本记录操作留痕</h4>
          <table class="data-table">
            <thead>
              <tr><th>时间</th><th>操作人</th><th>动作</th><th>结果</th><th>说明</th></tr>
            </thead>
            <tbody>
              <tr v-for="entry in recordAudits(detail.row.id)" :key="entry.id" :class="{ 'audit-denied': entry.denied }">
                <td>{{ entry.time }}</td>
                <td>{{ entry.operator }}</td>
                <td>{{ entry.action }}</td>
                <td><span :class="['audit-result', entry.denied ? 'result-denied' : 'result-ok']">{{ entry.denied ? '已退回' : '成功' }}</span></td>
                <td class="audit-detail">{{ entry.detail }}</td>
              </tr>
              <tr v-if="!recordAudits(detail.row.id).length">
                <td colspan="5" class="empty-state">暂无留痕</td>
              </tr>
            </tbody>
          </table>
        </template>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="closeDetail">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'

import { downloadEntries } from '@/api/local-service'
import {
  adjustThreshold,
  createWaterRecord,
  isLocked,
  listWater,
  OPERATORS,
  ownedPoint,
  submitCollected,
  updateOpenRecord,
  type WaterView,
} from '@/api/waterlevel-service'
import { useSessionStore } from '@/stores/session'
import type { WaterPoint, WaterRow } from '@/data/types'

const store = useSessionStore()

const operator = computed({
  get: () => store.operator,
  set: (value: string) => {
    store.setOperator(value)
    pageError.value = ''
    pageOk.value = ''
  },
})

const view = ref<WaterView>(listWater())
const pageError = ref('')
const pageOk = ref('')
const filters = reactive({ code: '', point: '', status: '' })

const owned = computed(() => ownedPoint(store.operator))

const filteredRows = computed(() =>
  view.value.rows.filter((row) => {
    if (filters.code.trim() && !row.code.includes(filters.code.trim())) return false
    if (filters.point.trim() && !row.pointName.includes(filters.point.trim())) return false
    if (filters.status && row.status !== filters.status) return false
    return true
  }),
)

const stats = computed(() => ({
  open: view.value.rows.filter((r) => !isLocked(r)).length,
  locked: view.value.rows.filter((r) => isLocked(r)).length,
  over: view.value.rows.filter((r) => isLocked(r) && r.overFlag === '超警戒').length,
  drafts: view.value.drafts.filter((d) => d.status === '待拟稿').length,
}))

function pointNameOf(code: string): string {
  return view.value.points.find((p) => p.code === code)?.name ?? code
}

function hangingCount(code: string): number {
  return view.value.rows.filter((r) => r.pointCode === code && !isLocked(r)).length
}

function flagClass(flag: WaterRow['overFlag']): string {
  if (flag === '超警戒') return 'flag-over'
  if (flag === '水位正常') return 'flag-normal'
  return 'flag-pending'
}

function recordAudits(id: number) {
  return view.value.audit.filter((entry) => entry.recordId === id)
}

function resetFilters() {
  filters.code = ''
  filters.point = ''
  filters.status = ''
}

function exportRows() {
  downloadEntries('waterlevel')
}

function reload(okMessage = '') {
  view.value = listWater()
  pageError.value = ''
  pageOk.value = okMessage
}

function flashError(message: string) {
  pageError.value = message
  pageOk.value = ''
}

// ── 登记 ──
const createOpen = ref(false)
const createForm = reactive({ code: '', reading: '' })
const formError = ref('')

function openCreate() {
  if (!owned.value) {
    flashError('当前身份不是任何点位的监测人，不能登记水位监测记录。')
    return
  }
  createForm.code = ''
  createForm.reading = ''
  formError.value = ''
  createOpen.value = true
}
function closeCreate() {
  createOpen.value = false
}
function submitCreate() {
  if (!owned.value) return
  const result = createWaterRecord({
    operator: store.operator,
    pointCode: owned.value.code,
    code: createForm.code,
    reading: createForm.reading,
  })
  if (!result.ok) {
    formError.value = result.message
    return
  }
  createOpen.value = false
  reload(result.message)
}

// ── 维护 ──
const editTarget = ref<WaterRow | null>(null)
const editForm = reactive({ code: '', reading: '' })

function openEdit(row: WaterRow) {
  editTarget.value = row
  editForm.code = row.code
  editForm.reading = row.reading === null ? '' : String(row.reading)
  formError.value = ''
}
function closeEdit() {
  editTarget.value = null
}
function submitEdit() {
  if (!editTarget.value) return
  const result = updateOpenRecord({
    operator: store.operator,
    id: editTarget.value.id,
    expectedVersion: editTarget.value.version,
    code: editForm.code,
    reading: editForm.reading,
  })
  if (!result.ok) {
    formError.value = result.message
    reload()
    return
  }
  editTarget.value = null
  reload(result.message)
}

// ── 提交采集 ──
function submitRecord(row: WaterRow) {
  const result = submitCollected({ operator: store.operator, id: row.id, expectedVersion: row.version })
  if (!result.ok) {
    flashError(result.message)
    reload()
    return
  }
  reload(result.message)
}

// ── 调整阈值 ──
const adjustPoint = ref<WaterPoint | null>(null)
const adjustForm = reactive({ threshold: '' })

function openAdjust(point: WaterPoint) {
  adjustPoint.value = point
  adjustForm.threshold = String(point.threshold)
  formError.value = ''
}
function closeAdjust() {
  adjustPoint.value = null
}
function submitAdjust() {
  if (!adjustPoint.value) return
  const result = adjustThreshold({
    operator: store.operator,
    pointCode: adjustPoint.value.code,
    expectedVersion: adjustPoint.value.version,
    threshold: adjustForm.threshold,
  })
  if (!result.ok) {
    formError.value = result.message
    reload()
    return
  }
  adjustPoint.value = null
  reload(result.message)
}

// ── 详情 ──
const detailId = ref<number | null>(null)
const detail = computed(() => (detailId.value === null ? null : (
  (() => {
    const found = listWater().rows.find((r) => r.id === detailId.value)
    if (!found) return null
    const point = view.value.points.find((p) => p.code === found.pointCode) ?? null
    return point ? { row: found, point } : null
  })()
)))

function openDetail(id: number) {
  detailId.value = id
}
function closeDetail() {
  detailId.value = null
}

// 两个页签 = 两位监测员同时操作：另一个页签一落盘，这里立即同步，后到提交按版本冲突退回。
function onStorage(event: StorageEvent) {
  if (event.key && event.key.startsWith('drainage-pump:')) {
    view.value = listWater()
  }
}

onMounted(() => window.addEventListener('storage', onStorage))
onUnmounted(() => window.removeEventListener('storage', onStorage))
</script>
