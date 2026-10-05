import { defineStore } from 'pinia'

const OPERATOR_KEY = 'drainage-pump:operator'

function readOperator(): string {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage.getItem(OPERATOR_KEY) ?? '值班管理员'
  }
  return '值班管理员'
}

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: readOperator(),
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
    // 切换当前登录监测人：水位监测的点位归属以这个身份为准。
    setOperator(name: string) {
      this.operator = name
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.setItem(OPERATOR_KEY, name)
      }
    },
  },
})
