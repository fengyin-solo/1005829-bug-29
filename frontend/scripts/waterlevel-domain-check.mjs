// 领域规则验证：用内存版 localStorage 跑通水位监测归属模型的每条需求。
// 运行：node scripts/waterlevel-domain-check.mjs（由 esbuild 即时打包 TS 源码）。
import { build } from 'esbuild'
import { pathToFileURL } from 'node:url'
import { writeFileSync, rmSync } from 'node:fs'

const store = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, v),
    removeItem: (k) => void store.delete(k),
  },
}

const bundled = await build({
  entryPoints: ['src/api/waterlevel-service.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
  alias: { '@': process.cwd() + '/src' },
})
const out = 'scripts/.tmp-bundle.mjs'
writeFileSync(out, bundled.outputFiles[0].text)
const svc = await import(pathToFileURL(process.cwd() + '/' + out).href)

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.error(`  ✗ ${name} ${extra}`)
  }
}

const rows = () => svc.listWaterViewRows()
const points = () => svc.listPoints()
const audit = () => svc.listAudit()

console.log('1. 归属：别的点位监测人改本点位读数/阈值一律退回并写明越在哪')
const r4 = rows().find((r) => r.id === 4) // 人民路点位，归属李秀兰
let res = svc.updateWaterRow(4, { 监测编号: 'SW-RM-0004', 水位读数: 9.9, 采集时间: '2026-10-05', rowVersion: 1 }, '王海涛')
check('跨点位修改读数被退回', res.ok === false && res.message.includes('越权') && res.message.includes('王海涛') && res.message.includes('李秀兰'), res.message)
res = svc.changeWarningLevel('WL-RM02', 4.0, 1, '王海涛')
check('跨点位改警戒水位被退回并指出越在哪', res.ok === false && res.message.includes('越权') && res.message.includes('人民路下穿通道水位站'), res.message)
res = svc.submitCollect(4, '王海涛')
check('跨点位提交采集被退回', res.ok === false && res.message.includes('越权'), res.message)
res = svc.judgeExceeded(4, '王海涛')
check('跨点位判定被退回', res.ok === false && res.message.includes('越权'), res.message)
res = svc.createWaterRow({ 监测编号: 'SW-RM-0099', 点位编码: 'WL-RM02', 水位读数: '', 采集时间: '', rowVersion: 1 }, '王海涛')
check('跨点位登记被退回', res.ok === false && res.message.includes('越权'), res.message)
check('退回也留审计痕迹', audit().some((a) => !a.ok && a.operator === '王海涛' && a.detail.includes('越权')))

console.log('2. 已采集记录整条只读')
res = svc.updateWaterRow(4, { 监测编号: 'SW-RM-0004', 水位读数: 5.9, 采集时间: '2026-10-04', rowVersion: 1 }, '李秀兰')
check('本人也不能改已采集记录', res.ok === false && res.message.includes('整条只读'), res.message)
const before = rows().find((r) => r.id === 4)
check('已采集读数未被改动', before.水位读数 === 5.1)

console.log('3. 同一点位监测编号重号挡回并指出撞了谁')
res = svc.createWaterRow({ 监测编号: 'SW-RM-0005', 点位编码: 'WL-RM02', 水位读数: '', 采集时间: '', rowVersion: 1 }, '李秀兰')
check('与已存在编号撞号被挡回并指出撞了谁', res.ok === false && res.message.includes('重号') && res.message.includes('5 号'), res.message)
res = svc.createWaterRow({ 监测编号: 'SW-JF-0007', 点位编码: 'WL-RM02', 水位读数: 3.3, 采集时间: '', rowVersion: 1 }, '李秀兰')
check('重号只在同一点位内判：别的点位用过的编号在本点位可用', res.ok === true, res.message)
const created = rows().find((r) => r.监测编号 === 'SW-JF-0007' && r.点位编码 === 'WL-RM02')
check('新记录归属点位正确', created && created.监测人 === '李秀兰' && created.status === '待采集')

console.log('4. 警戒水位调整后挂起记录按同一规则重算，保留差异；已判定记录冻结')
// 人民路现阈值 5.6；挂起：#4 读数5.1（未超限）；改成 5.0 后 #4 变超限。
const r4v = rows().find((r) => r.id === 4)
check('重算前 #4 判定为未超限（待判定口径：标记为正常）', r4v.viewExceeded === false)
res = svc.changeWarningLevel('WL-RM02', 5.0, 1, '李秀兰')
check('阈值调整成功', res.ok === true, res.message)
const diff4 = res.diffs.find((d) => d.id === 4)
check('重算差异保留：#4 标记由水位正常变超警戒', diff4 && diff4.changed && diff4.before === '水位正常' && diff4.after === '超警戒' && diff4.oldThreshold === 5.6 && diff4.newThreshold === 5.0, JSON.stringify(diff4))
const r4after = svc.listWaterViewRows().find((r) => r.id === 4)
check('列表超限标记已变', r4after.viewExceeded === true && r4after.viewWarningLevel === 5.0)
const detailVerdict = svc.evaluateRow(svc.listWaterRows().find((r) => r.id === 4), points().find((p) => p.code === 'WL-RM02'))
check('详情与列表同一口径', detailVerdict.exceeded === true && detailVerdict.effectiveWarningLevel === 5.0)
check('已采集记录业务字段仍只读（读数、状态不变）', r4after.水位读数 === 5.1 && r4after.status === '已采集')
// #5 是已判定正常记录（采集时 5.6，读数4.2）：阈值降到 5.0 依旧正常，但关键是阈值快照冻结
const r5 = svc.listWaterViewRows().find((r) => r.id === 5)
check('已判定记录 #5 保持当时取值（快照 5.6、状态水位正常）', r5.viewWarningLevel === 5.6 && r5.status === '水位正常' && r5.viewVerdict === '水位正常')
const frozenHit = audit().find((a) => a.ok && a.action === '调整警戒水位' && a.target.includes('人民路'))
check('审计中写明已判定记录保持原值', frozenHit.detail.includes('已判定历史记录') && frozenHit.detail.includes('保持当时取值'))
// #3 是超警戒历史（9.4 ≥ 9.0 快照），滨湖阈值 8.5 不影响它
const r3 = svc.listWaterViewRows().find((r) => r.id === 3)
check('滨湖历史超限记录 #3 快照 9.0 与结论不受阈值影响', r3.viewWarningLevel === 9.0 && r3.viewExceeded === true)

console.log('5. 超限结论落到防涝预警待拟稿清单')
res = svc.judgeExceeded(4, '李秀兰')
check('按统一规则标记 #4 超警戒成功', res.ok === true, res.message)
check('判定提示已同步待拟稿', res.message.includes('待拟稿'))
const drafts = svc.readLinkedRows('floodwarn').filter((w) => w['点位编码'] === 'WL-RM02' && w.status === '待拟稿')
check('自动生成人民路待拟稿单', drafts.length === 1 && String(drafts[0]['预警编号']).startsWith('WARN-AUTO-'))
check('待拟稿单预警依据引用超限记录', String(drafts[0]['预警依据']).includes('SW-RM-0004'))

console.log('6. 同点位两位监测员并发：只认先到的一版')
// 点位级：张建国持有 WL-JF03 v1，期间无并发；模拟先被改一次，再拿旧版本提交
res = svc.changeWarningLevel('WL-JF03', 6.2, 1, '张建国')
check('第一次阈值修改成功（先到）', res.ok === true, res.message)
res = svc.changeWarningLevel('WL-JF03', 6.0, 1, '张建国')
check('持旧版本再提交被并发挡回', res.ok === false && res.message.includes('并发冲突') && res.message.includes('先'), res.message)
const jf = points().find((p) => p.code === 'WL-JF03')
check('只保留先到版本的阈值', jf.warningLevel === 6.2 && jf.version === 2)
// 记录级并发：待采集记录 #1（滨湖，王海涛）
const r1 = rows().find((r) => r.id === 1)
res = svc.updateWaterRow(1, { 监测编号: r1.监测编号, 水位读数: 8.9, 采集时间: '2026-10-05 08:00', rowVersion: 1 }, '王海涛')
check('记录第一次修改成功（版本 1→2）', res.ok === true)
res = svc.updateWaterRow(1, { 监测编号: r1.监测编号, 水位读数: 8.1, 采集时间: '2026-10-05 08:01', rowVersion: 1 }, '王海涛')
check('持旧版本的第二次修改被挡回', res.ok === false && res.message.includes('并发冲突'))
const r1now = svc.listWaterViewRows().find((r) => r.id === 1)
check('只认先到的读数 8.9', r1now.水位读数 === 8.9 && r1now.rowVersion === 2)

console.log('7. 判定必须与统一规则一致（防止手工乱标）')
// #6 解放大道读数 6.8，阈值已降到 6.2 → 超限；不能判正常
res = svc.judgeNormal(6, '张建国')
check('与规则相反的判定正常被挡回', res.ok === false && res.message.includes('统一判定规则') && res.message.includes('超警戒'), res.message)
res = svc.judgeExceeded(6, '张建国')
check('按规则标记超警戒成功并同步待拟稿', res.ok === true && res.message.includes('WARN-AUTO'))
// 同点位已有待拟稿单（#7 生成的）时应更新而不是重复建单
const jfDrafts = svc.readLinkedRows('floodwarn').filter((w) => w['点位编码'] === 'WL-JF03' && w.status === '待拟稿')
check('同点位待拟稿单只有一张（更新依据不重复建）', jfDrafts.length === 1 && Number(jfDrafts[0]['来源记录']) === 6)

console.log('8. 原有监测记录保持当时取值')
const all = svc.listWaterViewRows()
const frozen3 = all.find((r) => r.id === 3)
const frozen5 = all.find((r) => r.id === 5)
const frozen7 = all.find((r) => r.id === 7)
check('#3 超警戒结论不变（9.4 vs 快照9.0）', frozen3.status === '超警戒' && frozen3.viewWarningLevel === 9.0)
check('#5 正常结论不变（4.2 vs 快照5.6）', frozen5.status === '水位正常' && frozen5.viewWarningLevel === 5.6)
check('#7 超警戒结论不变（7.2 vs 快照6.5，点位阈值改动为6.2也不影响）', frozen7.status === '超警戒' && frozen7.viewWarningLevel === 6.5)

console.log(`\n结果：${pass} 通过，${fail} 失败`)
rmSync(out, { force: true })
process.exit(fail === 0 ? 0 : 1)
