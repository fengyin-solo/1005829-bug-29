import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：归属从监测编号改挂到点位，水位监测数据结构随之升级，旧演示数据整体作废重播种。
const STORAGE_KEY = 'drainage-pump:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, unknown[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache as Record<string, EntryRow[]>
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

/**
 * 读取一个独立集合（点位目录、审计表等不属于通用业务模块的数据）。
 * 首次访问、或存量数据里没有该键时，播种 initial 并落盘。
 */
export function loadCollection<T>(key: string, initial: T[]): T[] {
  const store = allRows()
  const existing = store[key]
  if (!existing) {
    saveCollection(key, initial)
    return clone(initial)
  }
  return existing as T[]
}

export function saveCollection<T>(key: string, rows: T[]): void {
  saveRows(key, rows as unknown as EntryRow[])
}

/**
 * 丢弃内存缓存，下次读写直接读 localStorage。
 * 两位监测员在两个页签同时操作时，后到的提交必须基于对方已写入的最新版本做校验。
 */
export function syncFromStorage(): void {
  cache = null
}

export function storageKey(): string {
  return STORAGE_KEY
}
