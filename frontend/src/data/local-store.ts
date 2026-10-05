import { SEED_COLLECTIONS, SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
// v2：归属模型从「监测编号」改为「监测点位」，旧库里的警戒水位可能被随手改过，
// 点位阈值与判定快照不再可信，整体以新播种数据重建一次。
const STORAGE_KEY = 'drainage-pump:entries:v2'
const COLLECTION_PREFIX = 'drainage-pump:collection:'

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

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
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

// 模块之外的辅助集合（点位台账、审计痕迹等）：各用一个独立的 localStorage 键，
// 首次访问时从种子数据播种，之后以浏览器里的改动为准。
const collectionCache = new Map<string, unknown[]>()

export function listCollection<T>(name: string): T[] {
  const hit = collectionCache.get(name)
  if (hit) {
    return hit as T[]
  }
  const key = `${COLLECTION_PREFIX}${name}`
  let rows: T[]
  if (typeof window === 'undefined' || !window.localStorage) {
    rows = clone((SEED_COLLECTIONS[name] ?? []) as T[])
  } else {
    const raw = window.localStorage.getItem(key)
    if (!raw) {
      rows = clone((SEED_COLLECTIONS[name] ?? []) as T[])
      window.localStorage.setItem(key, JSON.stringify(rows))
    } else {
      try {
        rows = JSON.parse(raw) as T[]
      } catch {
        rows = clone((SEED_COLLECTIONS[name] ?? []) as T[])
        window.localStorage.setItem(key, JSON.stringify(rows))
      }
    }
  }
  collectionCache.set(name, rows)
  return rows
}

export function saveCollection<T>(name: string, rows: T[]): void {
  collectionCache.set(name, rows)
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(`${COLLECTION_PREFIX}${name}`, JSON.stringify(rows))
  }
}

export function resetCollection<T>(name: string): T[] {
  const rows = clone((SEED_COLLECTIONS[name] ?? []) as T[])
  saveCollection(name, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
