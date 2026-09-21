/**
 * 双标签页状态回归：每个页面必须始终绑定自己正在处理的逻辑操作。
 *
 * 场景（对应线上故障报告）：
 *   1. 标签页 A 提交后收到注入故障 503，待重试操作已保留（1 号已持久化）；
 *   2. 新打开的标签页 B 继承到该操作，放弃后改填内容、再次注入故障提交
 *     （另一个 client_op_id 持久化为 2 号）；
 *   3. B 的放弃与新建都不得清除/替换 A 的待重试身份；
 *   4. 两个页面分别刷新后各自重试，A 取回 1 号、B 取回 2 号（均为重放），
 *      场次列表恰好是连续的 [1, 2]，没有第三个号码。
 */
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listShotNumbers } from "../api";
import App from "../App";
import { createPendingStore } from "../pendingStore";
import type { PendingStore, StorageLike } from "../pendingStore";

/** 标签页私有存储的内存实现（每个“标签页”各持有一份） */
class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

/** 跨页广播：所有标签页共享一份，写入时同步通知订阅者（模拟 storage 事件） */
class BroadcastHub extends MemoryStorage {
  private listeners = new Set<(raw: string | null) => void>();

  override setItem(key: string, value: string): void {
    super.setItem(key, value);
    this.emit(value);
  }

  override removeItem(key: string): void {
    super.removeItem(key);
    this.emit(null);
  }

  onChange(listener: (raw: string | null) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(raw: string | null): void {
    for (const listener of [...this.listeners]) listener(raw);
  }
}

interface PostedOp {
  client_op_id: string;
  scene_id: string;
  notes: string;
}

/** 同一浏览器中的两个标签页：共享广播，各自持有私有存储 */
function openTwoTabs() {
  const hub = new BroadcastHub();
  const makeStore = (own: StorageLike): PendingStore =>
    createPendingStore({
      own,
      broadcast: hub,
      watchBroadcast: (listener) => hub.onChange(listener),
    });
  return {
    sessionA: new MemoryStorage(),
    sessionB: new MemoryStorage(),
    makeStore,
  };
}

function fillAndSubmit(
  page: RenderResult,
  scene: string,
  notesVal: string,
): void {
  const q = within(page.container);
  fireEvent.change(q.getByLabelText("场次"), { target: { value: scene } });
  fireEvent.change(q.getByLabelText("备注"), { target: { value: notesVal } });
  fireEvent.click(q.getByLabelText(/注入提交后故障/));
  fireEvent.click(q.getByRole("button", { name: "领取镜号" }));
}

const posted: PostedOp[] = [];

beforeEach(() => {
  posted.length = 0;
  localStorage.clear();
  sessionStorage.clear();
  // 记录两个页面发出的真实发号请求，其余请求原样放行到真实 API
  const realFetch = globalThis.fetch.bind(globalThis);
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST" && String(input).includes("/api/shot-numbers")) {
      posted.push(JSON.parse(String(init.body)) as PostedOp);
    }
    return realFetch(input, init);
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("双标签页各自保持自己的逻辑操作", () => {
  it("放弃/新建互不影响，刷新后各自重试取回原号码", async () => {
    const scene = `SYNC-RECOVERY-${crypto.randomUUID()}`;
    const { sessionA, sessionB, makeStore } = openTwoTabs();

    // 标签页 A：开启故障注入提交，收到 503，待重试操作保留（1 号已持久化）
    const pageA = render(<App store={makeStore(sessionA)} />);
    const a = within(pageA.container);
    fillAndSubmit(pageA, scene, "吊臂全景");
    expect(await a.findByTestId("error-unavailable")).toBeInTheDocument();
    expect(a.getByTestId("pending-banner")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    const opA = posted[0].client_op_id;
    expect(posted[0].notes).toBe("吊臂全景");

    // 标签页 B：新打开，继承到 A 广播的待重试操作
    const pageB = render(<App store={makeStore(sessionB)} />);
    const b = within(pageB.container);
    expect(b.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(b.getByLabelText("场次")).toHaveValue(scene);
    expect(b.getByLabelText("备注")).toHaveValue("吊臂全景");
    expect(b.getByLabelText(/注入提交后故障/)).toBeChecked();

    // B 放弃继承项：A 的待重试身份与表单必须原样保留
    fireEvent.click(b.getByRole("button", { name: "放弃该操作" }));
    expect(b.queryByTestId("pending-banner")).not.toBeInTheDocument();
    expect(a.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(a.getByLabelText("场次")).toHaveValue(scene);
    expect(a.getByLabelText("备注")).toHaveValue("吊臂全景");
    expect(a.getByTestId("error-unavailable")).toBeInTheDocument();

    // B 改填备注、保持故障注入开启并提交：另一个 client_op_id 持久化为 2 号
    fireEvent.change(b.getByLabelText("备注"), { target: { value: "轨道近景" } });
    fireEvent.click(b.getByRole("button", { name: "领取镜号" }));
    expect(await b.findByTestId("error-unavailable")).toBeInTheDocument();
    expect(posted).toHaveLength(2);
    const opB = posted[1].client_op_id;
    expect(opB).not.toBe(opA);
    expect(posted[1].notes).toBe("轨道近景");
    expect(b.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));

    // B 的新操作不得替换 A 的身份
    expect(a.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(a.getByLabelText("备注")).toHaveValue("吊臂全景");

    // 两个页面分别刷新：各自恢复自己的操作
    pageA.unmount();
    const pageA2 = render(<App store={makeStore(sessionA)} />);
    const a2 = within(pageA2.container);
    expect(a2.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(a2.getByLabelText("场次")).toHaveValue(scene);
    expect(a2.getByLabelText("备注")).toHaveValue("吊臂全景");

    pageB.unmount();
    const pageB2 = render(<App store={makeStore(sessionB)} />);
    const b2 = within(pageB2.container);
    expect(b2.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));
    expect(b2.getByLabelText("场次")).toHaveValue(scene);
    expect(b2.getByLabelText("备注")).toHaveValue("轨道近景");

    // A 重试取回 1 号（重放）；完成 A 不清除 B 尚未恢复的操作
    fireEvent.click(a2.getByRole("button", { name: /重试领取镜号/ }));
    const cardA = await a2.findByTestId("result-card");
    expect(cardA).toHaveTextContent("镜号 #1");
    expect(cardA).toHaveTextContent("重放结果");
    expect(cardA).toHaveTextContent(opA.slice(0, 8));
    expect(a2.queryByTestId("pending-banner")).not.toBeInTheDocument();
    expect(b2.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));

    // B 重试取回 2 号（重放）
    fireEvent.click(b2.getByRole("button", { name: /重试领取镜号/ }));
    const cardB = await b2.findByTestId("result-card");
    expect(cardB).toHaveTextContent("镜号 #2");
    expect(cardB).toHaveTextContent("重放结果");
    expect(cardB).toHaveTextContent(opB.slice(0, 8));

    // 两页始终绑定各自标识：四次真实请求的操作标识为 A、B、A、B
    expect(posted.map((p) => p.client_op_id)).toEqual([opA, opB, opA, opB]);

    // 场次列表恰好是连续的 [1, 2]：无重复、无缺口、没有第三个号码
    const listed = await listShotNumbers(scene);
    expect(listed.map((it) => it.shot_number)).toEqual([1, 2]);
    expect(listed.map((it) => it.client_op_id).sort()).toEqual([opA, opB].sort());
    await waitFor(() =>
      expect(b2.getAllByTestId("issued-row")).toHaveLength(2),
    );
  });

  it("没有自己操作的页面会实时继承其他页面广播的待重试操作", async () => {
    const scene = `SYNC-RECOVERY-${crypto.randomUUID()}`;
    const { sessionA, sessionB, makeStore } = openTwoTabs();

    // A 先打开且尚未操作；B 在之后提交并失败
    const pageA = render(<App store={makeStore(sessionA)} />);
    const a = within(pageA.container);
    expect(a.queryByTestId("pending-banner")).not.toBeInTheDocument();

    const pageB = render(<App store={makeStore(sessionB)} />);
    const b = within(pageB.container);
    fillAndSubmit(pageB, scene, "吊臂全景");
    expect(await b.findByTestId("error-unavailable")).toBeInTheDocument();
    const opB = posted[0].client_op_id;

    // A 没有自己的操作：实时继承 B 的广播并转为己有
    await waitFor(() =>
      expect(a.getByTestId("pending-banner")).toHaveTextContent(
        opB.slice(0, 8),
      ),
    );
    expect(a.getByLabelText("场次")).toHaveValue(scene);
    expect(a.getByLabelText("备注")).toHaveValue("吊臂全景");
  });
});
