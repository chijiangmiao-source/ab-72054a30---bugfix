import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { FormEvent } from "react";
import {
  allocateShotNumber,
  ConflictError,
  listShotNumbers,
  NetworkError,
  ServiceUnavailableError,
} from "./api";
import {
  clearPending,
  loadInheritedPending,
  loadOwnPending,
  newOpId,
  PENDING_KEY,
  persistPending,
  resolveTabId,
  watchPendingStorage,
} from "./pendingSync";
import type { PendingOp } from "./pendingSync";
import type { Allocation, ShotNumberItem } from "./types";

type ErrorKind = "conflict" | "unavailable" | "network" | "unknown";
interface ErrorState {
  kind: ErrorKind;
  message: string;
}

export default function App() {
  // 标签页身份：本次挂载确定后不再变化（sessionStorage 保证刷新后仍是同一个）
  const [tabId] = useState(resolveTabId);
  // 恢复待重试操作：优先本页自己的槽位（刷新恢复），否则继承公告栏中其他页面
  // 尚未恢复的操作。本页操作一旦持久化，就只认自己的槽位。
  const restored = useRef<PendingOp | null>(
    loadOwnPending(tabId) ?? loadInheritedPending(),
  );
  const [sceneId, setSceneId] = useState(restored.current?.scene_id ?? "");
  const [notes, setNotes] = useState(restored.current?.notes ?? "");
  const [inject, setInject] = useState(restored.current?.inject ?? false);
  const [pending, setPending] = useState<PendingOp | null>(restored.current);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<ErrorState | null>(null);
  const [result, setResult] = useState<Allocation | null>(null);
  const [issued, setIssued] = useState<ShotNumberItem[]>([]);
  // 表单控件 id 按实例区分：同屏存在多个页面实例时 label 仍能正确关联
  const uid = useId();
  const sceneInputId = `scene-${uid}`;
  const notesInputId = `notes-${uid}`;
  const injectInputId = `inject-${uid}`;
  // 本页放弃过的继承项：不再因公告栏变化而自动拾回
  const ignoredInherited = useRef<Set<string>>(new Set());

  const refreshIssued = useCallback(async (scene: string) => {
    if (!scene) {
      setIssued([]);
      return;
    }
    try {
      setIssued(await listShotNumbers(scene));
    } catch {
      /* 列表刷新失败不影响主流程 */
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void refreshIssued(sceneId.trim()), 250);
    return () => clearTimeout(timer);
  }, [sceneId, refreshIssued]);

  useEffect(
    () =>
      // 公告栏变化只影响“继承展示”：本页已有自己的待重试操作时，
      // 其他页面的写入/清除一概不得替换本页的操作身份
      watchPendingStorage(PENDING_KEY, (raw) => {
        if (loadOwnPending(tabId)) return;
        let op: PendingOp | null = null;
        if (raw) {
          try {
            op = JSON.parse(raw) as PendingOp;
          } catch {
            return;
          }
          if (ignoredInherited.current.has(op.client_op_id)) return;
        }
        setPending(op);
        setError(null);
        if (op) {
          setSceneId(op.scene_id);
          setNotes(op.notes);
          setInject(op.inject);
        }
      }),
    [tabId],
  );

  async function attempt(op: PendingOp) {
    setSubmitting(true);
    setError(null);
    try {
      const alloc = await allocateShotNumber({
        scene_id: op.scene_id,
        client_op_id: op.client_op_id,
        notes: op.notes,
        inject_failure_after_commit: op.inject,
      });
      setResult(alloc);
      setPending(null);
      clearPending(tabId, op);
      void refreshIssued(op.scene_id);
    } catch (err) {
      // 失败一律保留待重试操作，由用户决定何时重试
      if (err instanceof ConflictError) {
        setError({ kind: "conflict", message: err.message });
      } else if (err instanceof ServiceUnavailableError) {
        setError({
          kind: "unavailable",
          message: `${err.message}。操作已保留，可安全重试：同一操作标识不会重复占号。`,
        });
      } else if (err instanceof NetworkError) {
        setError({
          kind: "network",
          message: `${err.message}。操作已保留，恢复网络后可安全重试。`,
        });
      } else {
        setError({
          kind: "unknown",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function buildOp(opId: string): PendingOp {
    return {
      client_op_id: opId,
      scene_id: sceneId.trim(),
      notes,
      inject,
    };
  }

  function handleSubmit(ev: FormEvent) {
    ev.preventDefault();
    if (submitting) return;
    // 有待重试操作时复用其 client_op_id —— 重试同一逻辑操作而非新建操作
    const op = buildOp(pending?.client_op_id ?? newOpId());
    setPending(op);
    persistPending(tabId, op);
    void attempt(op);
  }

  function handleResubmitAsNew() {
    if (submitting) return;
    const op = buildOp(newOpId());
    setPending(op);
    persistPending(tabId, op);
    void attempt(op);
  }

  function handleDiscardPending() {
    const own = loadOwnPending(tabId);
    if (own) {
      // 本页自己的操作：清除自己的槽位（公告栏仍指向它时一并清除）
      clearPending(tabId, own);
    } else if (pending) {
      // 仅是继承来的操作：只从本页移除，共享存储保持原样，
      // 其他页面的待重试身份不受任何影响
      ignoredInherited.current.add(pending.client_op_id);
    }
    setPending(null);
    setError(null);
  }

  const canSubmit = !submitting && sceneId.trim().length > 0;

  return (
    <main className="page">
      <h1>场记镜号发放</h1>
      <p className="hint">
        同一操作标识（client_op_id）无论重试多少次，只会领取到一个镜号。
      </p>

      <form onSubmit={handleSubmit} className="card">
        <label htmlFor={sceneInputId}>场次</label>
        <input
          id={sceneInputId}
          value={sceneId}
          onChange={(e) => setSceneId(e.target.value)}
          placeholder="例如 S12-夜-仓库"
          required
        />

        <label htmlFor={notesInputId}>备注</label>
        <textarea
          id={notesInputId}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="镜头内容备注（可空）"
          rows={2}
        />

        <label className="inline" htmlFor={injectInputId}>
          <input
            id={injectInputId}
            type="checkbox"
            checked={inject}
            onChange={(e) => setInject(e.target.checked)}
          />
          注入提交后故障（开发模式）
        </label>

        {pending && (
          <div className="banner pending" data-testid="pending-banner">
            <span>
              有待重试的操作 <code>{pending.client_op_id.slice(0, 8)}…</code>
              ，重试将沿用原操作标识，不会重复占号。
            </span>
            <button type="button" className="link" onClick={handleDiscardPending}>
              放弃该操作
            </button>
          </div>
        )}

        {error && (
          <div className={`banner error`} data-testid={`error-${error.kind}`} role="alert">
            {error.kind === "conflict" ? (
              <>
                <strong>内容冲突：</strong>
                {error.message}
                <button
                  type="button"
                  className="link"
                  onClick={handleResubmitAsNew}
                  disabled={submitting}
                >
                  以新操作重新提交
                </button>
              </>
            ) : (
              <>
                <strong>提交失败：</strong>
                {error.message}
              </>
            )}
          </div>
        )}

        <button type="submit" disabled={!canSubmit}>
          {submitting ? "提交中…" : pending ? "重试领取镜号" : "领取镜号"}
        </button>
      </form>

      {result && (
        <section className="card result" data-testid="result-card">
          <div className="shot">镜号 #{result.shot_number}</div>
          <div className="meta">
            场次 {result.scene_id} ・ 操作 {result.client_op_id.slice(0, 8)}…
            {result.replayed && <span className="tag">重放结果，未重复占号</span>}
          </div>
        </section>
      )}

      <section className="card">
        <h2>本场次已发放{sceneId.trim() ? `（${sceneId.trim()}）` : ""}</h2>
        {issued.length === 0 ? (
          <p className="hint">暂无已发放镜号</p>
        ) : (
          <table data-testid="issued-table">
            <thead>
              <tr>
                <th>镜号</th>
                <th>备注</th>
                <th>操作标识</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {issued.map((item) => (
                <tr key={item.client_op_id} data-testid="issued-row">
                  <td>#{item.shot_number}</td>
                  <td>{item.notes || "—"}</td>
                  <td>
                    <code>{item.client_op_id.slice(0, 8)}…</code>
                  </td>
                  <td>{item.created_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
