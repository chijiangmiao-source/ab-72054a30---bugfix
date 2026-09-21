/**
 * 待重试操作的持久化：每个标签页只认自己正在处理的逻辑操作。
 *
 * 存储分两层：
 * - 标签页私有（生产环境为 sessionStorage）：本页自己的待重试操作，刷新后仍在；
 *   其他标签页的放弃、新建或完成都不会清除或替换它。
 * - 跨页广播（生产环境为 localStorage + storage 事件）：最近保存的待重试操作，
 *   仅供“新打开且没有自己操作”的页面继承一次；已有自己操作的页面一律忽略广播。
 */
import { watchPendingStorage } from "./pendingSync";

export interface PendingOp {
  client_op_id: string;
  scene_id: string;
  notes: string;
  inject: boolean;
}

/** 与 Web Storage 对齐的最小接口，便于测试为每个标签页注入独立存储。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface PendingStoreDeps {
  /** 本页私有存储（默认 sessionStorage） */
  own?: StorageLike;
  /** 跨页广播存储（默认 localStorage） */
  broadcast?: StorageLike;
  /** 订阅广播内容变更（默认监听 storage 事件），返回取消订阅函数 */
  watchBroadcast?: (listener: (raw: string | null) => void) => () => void;
}

export interface PendingStore {
  /** 本页自己的待重试操作（刷新恢复用），没有则为 null */
  loadOwn(): PendingOp | null;
  /** 仅当本页没有自己的操作时，继承一次广播中的操作并转为己有；否则返回 null */
  inheritBroadcast(): PendingOp | null;
  /** 保存本页操作：写私有存储，并广播给之后打开的页面 */
  saveOwn(op: PendingOp): void;
  /** 清除本页操作；仅当广播仍指向该操作时才一并撤下，不动其他页面广播的操作 */
  clearOwn(op: PendingOp): void;
  /** 订阅其他页面广播内容的变化 */
  watchBroadcast(listener: (op: PendingOp | null) => void): () => void;
}

const OWN_KEY = "shotnumbers.pendingOp.own.v1";
const BROADCAST_KEY = "shotnumbers.pendingOp.v1";

function parseOp(raw: string | null): PendingOp | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingOp;
  } catch {
    return null;
  }
}

function readOp(storage: StorageLike, key: string): PendingOp | null {
  try {
    return parseOp(storage.getItem(key));
  } catch {
    return null;
  }
}

function writeOp(storage: StorageLike, key: string, op: PendingOp | null): void {
  try {
    if (op) storage.setItem(key, JSON.stringify(op));
    else storage.removeItem(key);
  } catch {
    /* 存储不可用时仅保留内存态 */
  }
}

function browserStorage(kind: "sessionStorage" | "localStorage"): StorageLike {
  // 某些环境（如禁用存储的隐私模式）访问即抛错，退化为内存存储
  try {
    return window[kind];
  } catch {
    const mem = new Map<string, string>();
    return {
      getItem: (key) => mem.get(key) ?? null,
      setItem: (key, value) => void mem.set(key, value),
      removeItem: (key) => void mem.delete(key),
    };
  }
}

export function createPendingStore(deps: PendingStoreDeps = {}): PendingStore {
  const own = deps.own ?? browserStorage("sessionStorage");
  const broadcast = deps.broadcast ?? browserStorage("localStorage");
  const watch =
    deps.watchBroadcast ??
    ((listener: (raw: string | null) => void) =>
      watchPendingStorage(BROADCAST_KEY, listener));

  return {
    loadOwn: () => readOp(own, OWN_KEY),

    inheritBroadcast() {
      if (readOp(own, OWN_KEY)) return null;
      const inherited = readOp(broadcast, BROADCAST_KEY);
      if (inherited) writeOp(own, OWN_KEY, inherited);
      return inherited;
    },

    saveOwn(op) {
      writeOp(own, OWN_KEY, op);
      writeOp(broadcast, BROADCAST_KEY, op);
    },

    clearOwn(op) {
      writeOp(own, OWN_KEY, null);
      // 广播可能已被其他页面的操作覆盖，只有仍指向本页操作时才能撤下
      const current = readOp(broadcast, BROADCAST_KEY);
      if (current && current.client_op_id === op.client_op_id) {
        writeOp(broadcast, BROADCAST_KEY, null);
      }
    },

    watchBroadcast: (listener) => watch((raw) => listener(parseOp(raw))),
  };
}
