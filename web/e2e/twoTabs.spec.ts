import { expect, test } from "@playwright/test";

/**
 * 双标签页回归（真实浏览器）：两个标签页共享 localStorage 但各有独立的
 * sessionStorage，因此每页必须始终绑定自己的逻辑操作：
 *   A 提交后 503（1 号已持久化）→ B 继承后放弃、另建操作再得 503（2 号）→
 *   B 的放弃/新建不得清除或替换 A 的待重试身份 → 各自刷新后重试，
 *   A 取回 1 号、B 取回 2 号（均重放），列表恰好 [1, 2]。
 */

async function opPrefix(page: import("@playwright/test").Page): Promise<string> {
  const text = (await page.getByTestId("pending-banner").textContent()) ?? "";
  const match = text.match(/([0-9a-f]{8})/);
  if (!match) throw new Error(`未在待重试横幅中找到操作标识：${text}`);
  return match[1];
}

test("两个标签页的待重试操作互不清除，刷新后各自取回原号码", async ({
  context,
}) => {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const scene = `e2e-two-tab-${Date.now()}`;

  // 标签页 A：开启故障注入提交，收到 503，待重试操作保留（1 号已持久化）
  await pageA.goto("/");
  await pageA.getByLabel("场次").fill(scene);
  await pageA.getByLabel("备注").fill("吊臂全景");
  await pageA.getByLabel(/注入提交后故障/).check();
  await pageA.getByRole("button", { name: "领取镜号" }).click();
  await expect(pageA.getByTestId("error-unavailable")).toBeVisible();
  const prefixA = await opPrefix(pageA);

  // 标签页 B：新打开，继承到 A 广播的待重试操作
  await pageB.goto("/");
  await expect(pageB.getByTestId("pending-banner")).toContainText(prefixA);
  await expect(pageB.getByLabel("场次")).toHaveValue(scene);
  await expect(pageB.getByLabel("备注")).toHaveValue("吊臂全景");

  // B 放弃继承项：A 的待重试身份与表单必须原样保留
  await pageB.getByRole("button", { name: "放弃该操作" }).click();
  await expect(pageB.getByTestId("pending-banner")).toHaveCount(0);
  await expect(pageA.getByTestId("pending-banner")).toContainText(prefixA);
  await expect(pageA.getByLabel("备注")).toHaveValue("吊臂全景");

  // B 改填备注、保持故障注入开启并提交：另一个 client_op_id 持久化为 2 号
  await pageB.getByLabel("备注").fill("轨道近景");
  await expect(pageB.getByLabel(/注入提交后故障/)).toBeChecked();
  await pageB.getByRole("button", { name: "领取镜号" }).click();
  await expect(pageB.getByTestId("error-unavailable")).toBeVisible();
  const prefixB = await opPrefix(pageB);
  expect(prefixB).not.toBe(prefixA);

  // B 的新操作不得替换 A 的身份
  await expect(pageA.getByTestId("pending-banner")).toContainText(prefixA);
  await expect(pageA.getByLabel("备注")).toHaveValue("吊臂全景");
  await expect(pageB.getByLabel("备注")).toHaveValue("轨道近景");

  // 两个页面分别刷新：各自恢复自己的操作
  await pageA.reload();
  await expect(pageA.getByTestId("pending-banner")).toContainText(prefixA);
  await expect(pageA.getByLabel("备注")).toHaveValue("吊臂全景");
  await pageB.reload();
  await expect(pageB.getByTestId("pending-banner")).toContainText(prefixB);
  await expect(pageB.getByLabel("备注")).toHaveValue("轨道近景");

  // A 重试取回 1 号（重放）；完成 A 不清除 B 尚未恢复的操作
  await pageA.getByRole("button", { name: /重试领取镜号/ }).click();
  await expect(pageA.getByTestId("result-card")).toContainText("镜号 #1");
  await expect(pageA.getByTestId("result-card")).toContainText("重放结果");
  await expect(pageA.getByTestId("pending-banner")).toHaveCount(0);
  await expect(pageB.getByTestId("pending-banner")).toContainText(prefixB);

  // B 重试取回 2 号（重放）
  await pageB.getByRole("button", { name: /重试领取镜号/ }).click();
  await expect(pageB.getByTestId("result-card")).toContainText("镜号 #2");
  await expect(pageB.getByTestId("result-card")).toContainText("重放结果");

  // 场次列表恰好是连续的 [1, 2]：无重复、无缺口、没有第三个号码
  await expect(pageA.getByTestId("issued-row")).toHaveCount(2);
  await expect(pageA.getByTestId("issued-row").nth(0)).toContainText("#1");
  await expect(pageA.getByTestId("issued-row").nth(1)).toContainText("#2");
});
