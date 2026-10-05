import { defineStore } from 'pinia'

// 当前登录的值班人。水位监测的归属卡到点位后，写操作都要拿这个身份和点位归属人比对；
// 提供切换入口是为了在同一工作台里模拟「别的点位监测人提交被退回」。
export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '值班管理员',
    shiftLabel: '白班 08:00-20:00',
    scope: '城市排水防涝泵站运行与内涝处置管理平台',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setOperator(name: string) {
      this.operator = name.trim() || '值班管理员'
    },
  },
})
