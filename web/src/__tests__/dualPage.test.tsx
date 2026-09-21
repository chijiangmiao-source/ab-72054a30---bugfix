import { fireEvent, render, waitFor, within } from "@testing-library/react";
import type { RenderResult } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { listShotNumbers } from "../api";
import { TAB_ID_KEY } from "../pendingSync";

/** 模拟“同一个标签页”：渲染/重渲染前把标签页标识放进 sessionStorage */
function openTab(tabId: string): { page: RenderResult; ui: ReturnType<typeof within> } {
  sessionStorage.setItem(TAB_ID_KEY, tabId);
  const page = render(<App />);
  return { page, ui: within(page.container) };
}

function fillForm(
  ui: ReturnType<typeof within>,
  values: { scene?: string; notes?: string; inject?: boolean },
) {
  if (values.scene !== undefined) {
    fireEvent.change(ui.getByLabelText("场次"), { target: { value: values.scene } });
  }
  if (values.notes !== undefined) {
    fireEvent.change(ui.getByLabelText("备注"), { target: { value: values.notes } });
  }
  if (values.inject !== undefined) {
    const box = ui.getByLabelText(/注入提交后故障/);
    if ((box as HTMLInputElement).checked !== values.inject) fireEvent.click(box);
  }
}

function submit(ui: ReturnType<typeof within>) {
  fireEvent.click(ui.getByRole("button", { name: /领取镜号|重试领取镜号/ }));
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("双页面各自绑定自己的待重试操作", () => {
  it("首页面 503、次页面放弃继承项再 503、分别刷新重试后各自取回原号码", async () => {
    const scene = `vitest-dual-${crypto.randomUUID()}`;

    // 记录真实 POST 请求中的 client_op_id
    const postedOpIds: string[] = [];
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && url.includes("/api/shot-numbers")) {
        const body = JSON.parse(String(init?.body)) as { client_op_id: string };
        postedOpIds.push(body.client_op_id);
      }
      return realFetch(input, init);
    });

    // —— 标签页 A：开启故障注入提交 -> 503，1 号已持久化 ——
    const A = openTab("tab-A");
    fillForm(A.ui, { scene, notes: "吊臂全景", inject: true });
    submit(A.ui);
    expect(await A.ui.findByTestId("error-unavailable")).toBeInTheDocument();
    expect(A.ui.getByTestId("pending-banner")).toBeInTheDocument();
    expect(postedOpIds).toHaveLength(1);
    const opA = postedOpIds[0];

    // —— 标签页 B：打开后显示继承的待重试操作 ——
    const B = openTab("tab-B");
    expect(B.ui.getByTestId("pending-banner")).toBeInTheDocument();
    expect(B.ui.getByLabelText("场次")).toHaveValue(scene);
    expect(B.ui.getByLabelText("备注")).toHaveValue("吊臂全景");

    // B 放弃继承项：只影响 B 自己，A 的待重试状态与表单内容保持原样
    fireEvent.click(B.ui.getByRole("button", { name: "放弃该操作" }));
    expect(B.ui.queryByTestId("pending-banner")).not.toBeInTheDocument();
    expect(A.ui.getByTestId("pending-banner")).toBeInTheDocument();
    expect(A.ui.getByLabelText("备注")).toHaveValue("吊臂全景");

    // B 改填备注、再次注入故障提交 -> 另一个 client_op_id 持久化为 2 号
    fillForm(B.ui, { notes: "轨道近景" });
    submit(B.ui);
    expect(await B.ui.findByTestId("error-unavailable")).toBeInTheDocument();
    expect(postedOpIds).toHaveLength(2);
    const opB = postedOpIds[1];
    expect(opB).not.toBe(opA);

    // B 的提交不得清除、替换 A 的操作标识与表单内容
    expect(A.ui.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(A.ui.getByLabelText("备注")).toHaveValue("吊臂全景");
    expect(B.ui.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));

    // —— A 刷新：仍绑定自己的操作，重试取回 1 号（重放结果） ——
    A.page.unmount();
    const A2 = openTab("tab-A");
    expect(A2.ui.getByTestId("pending-banner")).toHaveTextContent(opA.slice(0, 8));
    expect(A2.ui.getByLabelText("备注")).toHaveValue("吊臂全景");
    submit(A2.ui);
    const cardA = await A2.ui.findByTestId("result-card");
    expect(cardA).toHaveTextContent("镜号 #1");
    expect(cardA).toHaveTextContent("重放结果");

    // A 完成自己的操作后，B 尚未恢复的待重试操作仍在
    expect(B.ui.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));

    // —— B 刷新：重试取回 2 号（重放结果） ——
    B.page.unmount();
    const B2 = openTab("tab-B");
    expect(B2.ui.getByTestId("pending-banner")).toHaveTextContent(opB.slice(0, 8));
    expect(B2.ui.getByLabelText("备注")).toHaveValue("轨道近景");
    submit(B2.ui);
    const cardB = await B2.ui.findByTestId("result-card");
    expect(cardB).toHaveTextContent("镜号 #2");
    expect(cardB).toHaveTextContent("重放结果");

    // 四次真实请求：两个不同的操作标识，重试各自沿用原标识
    expect(postedOpIds).toEqual([opA, opB, opA, opB]);

    // 场次列表恰好是连续的 [1, 2]，没有第三个号码
    await waitFor(async () => {
      const items = await listShotNumbers(scene);
      expect(items.map((it) => it.shot_number)).toEqual([1, 2]);
    });
    const items = await listShotNumbers(scene);
    expect(items.map((it) => it.client_op_id)).toEqual([opA, opB]);
  });
});
