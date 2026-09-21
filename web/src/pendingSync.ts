/**
 * 待重试操作的跨页面持久化与同步。
 *
 * 存储布局：
 * - sessionStorage 中的标签页标识（TAB_ID_KEY）：同一标签页刷新后保持不变，
 *   新打开的标签页各自生成，互不相同的身份；
 * - localStorage 中每个标签页独立的槽位（PENDING_KEY.tab.<tabId>）：只由所属
 *   页面写入与清除，其他页面的提交、放弃、完成都不会触碰 —— 每个页面始终
 *   绑定自己正在处理的逻辑操作；
 * - localStorage 中的公告栏（PENDING_KEY）：记录最近持久化的待重试操作，供
 *   新打开（自身尚无槽位）的页面继承展示；仅当公告栏仍指向本页操作时才允许
 *   清除，因此一个页面完成或放弃操作，不会抹掉其他页面尚未恢复的操作。
 */
export interface PendingOp {
  client_op_id: string;
  scene_id: string;
  notes: string;
  inject: boolean;
}

/** 公告栏键（沿用 v1 键，旧版本遗留的待重试操作仍可被继承） */
export const PENDING_KEY = "shotnumbers.pendingOp.v1";
/** sessionStorage 中的标签页标识键 */
export const TAB_ID_KEY = "shotnumbers.tabId.v1";

/** 本标签页在 localStorage 中的专属槽位键 */
export function tabSlotKey(tabId: string): string {
  return `${PENDING_KEY}.tab.${tabId}`;
}

export function newOpId(): string {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}

export function resolveTabId(): string {
  try {
    const existing = sessionStorage.getItem(TAB_ID_KEY);
    if (existing) return existing;
    const id = newOpId();
    sessionStorage.setItem(TAB_ID_KEY, id);
    return id;
  } catch {
    return newOpId();
  }
}

function parseOp(raw: string | null): PendingOp | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingOp;
  } catch {
    return null;
  }
}

export function loadOwnPending(tabId: string): PendingOp | null {
  try {
    return parseOp(localStorage.getItem(tabSlotKey(tabId)));
  } catch {
    return null;
  }
}

export function loadInheritedPending(): PendingOp | null {
  try {
    return parseOp(localStorage.getItem(PENDING_KEY));
  } catch {
    return null;
  }
}

export function persistPending(tabId: string, op: PendingOp): void {
  try {
    localStorage.setItem(tabSlotKey(tabId), JSON.stringify(op));
    localStorage.setItem(PENDING_KEY, JSON.stringify(op));
  } catch {
    /* 存储不可用时仅保留内存态 */
  }
}

export function clearPending(tabId: string, op: PendingOp): void {
  try {
    localStorage.removeItem(tabSlotKey(tabId));
    if (loadInheritedPending()?.client_op_id === op.client_op_id) {
      localStorage.removeItem(PENDING_KEY);
    }
  } catch {
    /* 存储不可用时仅保留内存态 */
  }
}

export function watchPendingStorage(
  storageKey: string,
  listener: (raw: string | null) => void,
): () => void {
  const handleStorage = (event: StorageEvent) => {
    if (event.storageArea === localStorage && event.key === storageKey) {
      listener(event.newValue);
    }
  };
  window.addEventListener("storage", handleStorage);
  return () => window.removeEventListener("storage", handleStorage);
}
