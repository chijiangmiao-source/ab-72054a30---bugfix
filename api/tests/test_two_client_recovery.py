"""双客户端恢复：两个页面各自的待重试操作互不影响，重试各自取回原号码。

对应前端双标签页场景的服务端语义：两个 client_op_id 先后“提交后故障”
（号码已持久化但客户端只收到 503），随后各自重试必须取回最初分配的号码，
场次列表保持连续、无重复、无缺口。
"""
import httpx

from server_util import allocate


def test_two_clients_recover_their_own_numbers(server):
    scene = "SYNC-RECOVERY"
    op_a = "op-page-a"
    op_b = "op-page-b"

    # 页面 A：提交后故障 —— 1 号已持久化，但客户端只收到 503
    a_first = allocate(server.base_url, scene, op_a, notes="吊臂全景",
                       inject_failure_after_commit=True)
    assert a_first.status_code == 503

    # 页面 B：另一个 client_op_id 同样提交后故障 —— 持久化为 2 号
    b_first = allocate(server.base_url, scene, op_b, notes="轨道近景",
                       inject_failure_after_commit=True)
    assert b_first.status_code == 503

    # 两个页面分别刷新并重试（仍带注入标志）：各自取回最初的号码，均为重放
    a_retry = allocate(server.base_url, scene, op_a, notes="吊臂全景",
                       inject_failure_after_commit=True)
    assert a_retry.status_code == 200
    assert a_retry.json()["shot_number"] == 1
    assert a_retry.json()["replayed"] is True

    b_retry = allocate(server.base_url, scene, op_b, notes="轨道近景",
                       inject_failure_after_commit=True)
    assert b_retry.status_code == 200
    assert b_retry.json()["shot_number"] == 2
    assert b_retry.json()["replayed"] is True

    # 场次列表恰好是连续的 [1, 2]：无重复、无缺口、没有第三个号码
    listing = httpx.get(f"{server.base_url}/api/scenes/{scene}/shot-numbers", timeout=10)
    assert listing.status_code == 200
    items = listing.json()
    assert [it["shot_number"] for it in items] == [1, 2]
    assert [it["client_op_id"] for it in items] == [op_a, op_b]
