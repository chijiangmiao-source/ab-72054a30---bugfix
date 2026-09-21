import { expect, test } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("两个标签页各自保持自己的待重试操作，刷新后分别取回 1、2 号", async ({
  page: pageA,
}) => {
  const scene = `e2e-dual-${Date.now()}`;
  const pageB = await pageA.context().newPage();

  // —— 标签页 A：故障注入提交 -> 503，1 号已持久化 ——
  await pageA.goto("/");
  await pageA.getByLabel("场次").fill(scene);
  await pageA.getByLabel("备注").fill("吊臂全景");
  await pageA.getByLabel(/注入提交后故障/).check();
  await pageA.getByRole("button", { name: "领取镜号" }).click();
  await expect(pageA.getByTestId("error-unavailable")).toBeVisible();
  await expect(pageA.getByTestId("pending-banner")).toBeVisible();
  const opACode = (await pageA.getByTestId("pending-banner").locator("code").textContent())!;

  // —— 标签页 B：打开后继承并显示 A 的待重试操作 ——
  await pageB.goto("/");
  await expect(pageB.getByTestId("pending-banner")).toBeVisible();
  await expect(pageB.getByLabel("场次")).toHaveValue(scene);
  await expect(pageB.getByLabel("备注")).toHaveValue("吊臂全景");

  // B 放弃继承项：只影响 B，A 的待重试身份保持不变
  await pageB.getByRole("button", { name: "放弃该操作" }).click();
  await expect(pageB.getByTestId("pending-banner")).toHaveCount(0);
  await expect(pageA.getByTestId("pending-banner")).toBeVisible();

  // B 改填备注、再次故障注入提交 -> 另一个 client_op_id 持久化为 2 号
  await pageB.getByLabel("备注").fill("轨道近景");
  await pageB.getByLabel(/注入提交后故障/).check();
  await pageB.getByRole("button", { name: "领取镜号" }).click();
  await expect(pageB.getByTestId("error-unavailable")).toBeVisible();
  const opBCode = (await pageB.getByTestId("pending-banner").locator("code").textContent())!;
  expect(opBCode).not.toBe(opACode);

  // B 的提交没有替换 A：两页各自绑定自己的操作标识与表单内容
  await expect(pageA.getByTestId("pending-banner").locator("code")).toHaveText(opACode);
  await expect(pageA.getByLabel("备注")).toHaveValue("吊臂全景");
  await expect(pageB.getByLabel("备注")).toHaveValue("轨道近景");

  // —— A 刷新：仍绑定自己的操作，重试取回 1 号（重放） ——
  await pageA.reload();
  await expect(pageA.getByTestId("pending-banner").locator("code")).toHaveText(opACode);
  await pageA.getByRole("button", { name: /重试领取镜号/ }).click();
  await expect(pageA.getByTestId("result-card")).toContainText("镜号 #1");
  await expect(pageA.getByTestId("result-card")).toContainText("重放结果");
  await expect(pageA.getByTestId("pending-banner")).toHaveCount(0);

  // A 完成不能清除 B 尚未恢复的操作
  await expect(pageB.getByTestId("pending-banner").locator("code")).toHaveText(opBCode);

  // —— B 刷新：仍绑定自己的操作，重试取回 2 号（重放） ——
  await pageB.reload();
  await expect(pageB.getByTestId("pending-banner").locator("code")).toHaveText(opBCode);
  await pageB.getByRole("button", { name: /重试领取镜号/ }).click();
  await expect(pageB.getByTestId("result-card")).toContainText("镜号 #2");
  await expect(pageB.getByTestId("result-card")).toContainText("重放结果");

  // 场次列表恰好连续 [1, 2]，没有第三个号码
  const origin = new URL(pageA.url()).origin;
  const res = await pageA.request.get(
    `${origin}/api/scenes/${encodeURIComponent(scene)}/shot-numbers`,
  );
  expect(res.ok()).toBeTruthy();
  const items = (await res.json()) as { shot_number: number }[];
  expect(items.map((it) => it.shot_number)).toEqual([1, 2]);

  await pageB.close();
});
