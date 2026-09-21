"""开发模式故障注入：首次持久提交后返回 503，重试只取回原号码且不再触发。"""
import httpx

from server_util import RunningServer, allocate


def _post_injected(base_url: str, scene_id: str, client_op_id: str, notes: str) -> httpx.Response:
    return httpx.post(
        f"{base_url}/api/shot-numbers",
        json={
            "scene_id": scene_id,
            "client_op_id": client_op_id,
            "notes": notes,
            "inject_failure_after_commit": True,
        },
        timeout=10,
    )


def test_injected_failure_commits_once_and_replays_without_refailing(server):
    payload = dict(scene_id="S-inj", client_op_id="op-inj-1", notes="雨夜",
                   inject_failure_after_commit=True)

    first = httpx.post(f"{server.base_url}/api/shot-numbers", json=payload, timeout=10)
    assert first.status_code == 503
    assert first.json()["detail"]["error"] == "injected_failure_after_commit"

    # 503 不代表未生效：号码已持久化
    stored = httpx.get(f"{server.base_url}/api/operations/op-inj-1")
    assert stored.status_code == 200
    assert stored.json()["shot_number"] == 1

    # 带着注入标志重试同内容：只取回原号码，不再触发故障
    retry = httpx.post(f"{server.base_url}/api/shot-numbers", json=payload, timeout=10)
    assert retry.status_code == 200
    assert retry.json()["shot_number"] == 1
    assert retry.json()["replayed"] is True

    # 不带标志重试亦如此
    retry2 = allocate(server.base_url, "S-inj", "op-inj-1", notes="雨夜")
    assert retry2.status_code == 200
    assert retry2.json()["shot_number"] == 1

    # 无缺口：下一个新操作拿到 2
    nxt = allocate(server.base_url, "S-inj", "op-inj-2", notes="续拍")
    assert nxt.status_code == 201
    assert nxt.json()["shot_number"] == 2


def test_two_failed_ops_each_recover_their_own_number(server):
    """双页面场景：两个操作先后注入故障 503（各自号码已持久化），
    交错重试时各自取回自己最初分配的号码，列表无重复、无缺口。"""
    scene = "S-dual"

    # 两个页面先后提交并触发注入故障：客户端只见 503，号码其实已生效
    first_a = _post_injected(server.base_url, scene, "op-dual-a", "吊臂全景")
    assert first_a.status_code == 503
    first_b = _post_injected(server.base_url, scene, "op-dual-b", "轨道近景")
    assert first_b.status_code == 503

    # A 先重试：取回 1 号，重放；B 的操作不受影响
    retry_a = _post_injected(server.base_url, scene, "op-dual-a", "吊臂全景")
    assert retry_a.status_code == 200
    assert retry_a.json()["shot_number"] == 1
    assert retry_a.json()["replayed"] is True

    # B 再重试：取回 2 号，重放
    retry_b = _post_injected(server.base_url, scene, "op-dual-b", "轨道近景")
    assert retry_b.status_code == 200
    assert retry_b.json()["shot_number"] == 2
    assert retry_b.json()["replayed"] is True

    # 场次列表恰好是连续的 [1, 2]，没有第三个号码
    listed = httpx.get(f"{server.base_url}/api/scenes/{scene}/shot-numbers", timeout=10)
    assert listed.status_code == 200
    items = listed.json()
    assert [item["shot_number"] for item in items] == [1, 2]
    assert [item["client_op_id"] for item in items] == ["op-dual-a", "op-dual-b"]


def test_inject_flag_ignored_outside_dev_mode(db_path):
    srv = RunningServer(db_path, dev_mode=False).start()
    try:
        resp = httpx.post(
            f"{srv.base_url}/api/shot-numbers",
            json={"scene_id": "S1", "client_op_id": "op-1",
                  "inject_failure_after_commit": True},
            timeout=10,
        )
        assert resp.status_code == 201
        assert resp.json()["shot_number"] == 1
    finally:
        srv.stop()
