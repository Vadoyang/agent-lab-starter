"""初始化：把假 web log 載入資料庫（Agent 的 search_logs 會查它）。

兩種後端自動判斷：
- ELK 版：ES_URL 指向 Elasticsearch（http，無帳密），再建立 Kibana 資料檢視。
- Wazuh 版：INDEXER_URL 指向 Wazuh indexer（https＋帳密）；不建 Kibana（改用 Grafana／Wazuh dashboard）。
每次執行都重建 weblogs，時間戳改成「現在往前推」，所以永遠是當天的紀錄。
"""
import datetime
import json
import os
import sys
import time

import httpx

import common
from common import indexer_request

KIBANA_URL = os.getenv("KIBANA_URL", "")          # 只有 ELK 版會設
DATA = os.getenv("WEBLOGS_FILE", "/data/weblogs.ndjson")
KIBANA_DATA_VIEWS = ["agent-events", "toolproxy-decisions", "sink-hits", "weblogs", "approvals", "actions"]
IS_WAZUH = bool(os.getenv("INDEXER_URL"))         # 有獨立 INDEXER_URL ＝ Wazuh 版


def retry(fn, what: str, tries: int = 5):
    for i in range(1, tries + 1):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            if i == tries:
                raise
            print(f"[seed] {what} 失敗（{type(e).__name__}），{5 * i} 秒後重試…", flush=True)
            time.sleep(5 * i)


def wait_indexer(timeout: int = 300) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = indexer_request("GET", "/_cluster/health")
            if r.status_code < 300:
                return True
        except Exception:  # noqa: BLE001
            pass
        print("[seed] 等待資料庫（indexer）啟動中…", flush=True)
        time.sleep(5)
    return False


def wait_http(url: str, name: str, timeout: int = 600) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            if httpx.get(url, timeout=5).status_code == 200:
                return True
        except Exception:  # noqa: BLE001
            pass
        print(f"[seed] 等待 {name} 啟動中…", flush=True)
        time.sleep(5)
    return False


def load_weblogs() -> int:
    retry(lambda: indexer_request("GET", "/_cluster/health?wait_for_status=yellow&timeout=60s"), "等叢集就緒")
    # 單節點：副本數設 0，叢集才會 green
    tmpl = {"index_patterns": ["weblogs*"], "priority": 100,
            "template": {"settings": {"number_of_replicas": 0}}}
    retry(lambda: indexer_request("PUT", "/_index_template/agentlab-weblogs", json=tmpl), "建立 index 範本")
    retry(lambda: indexer_request("DELETE", "/weblogs"), "刪除舊 weblogs")
    mapping = {"settings": {"number_of_replicas": 0}, "mappings": {"properties": {
        "@timestamp": {"type": "date"}, "src_ip": {"type": "keyword"}, "method": {"type": "keyword"},
        "path": {"type": "keyword"}, "status": {"type": "integer"}, "bytes": {"type": "integer"},
        "user_agent": {"type": "text", "fields": {"keyword": {"type": "keyword", "ignore_above": 512}}}}}}

    def create():
        r = indexer_request("PUT", "/weblogs", json=mapping)
        if r.status_code >= 400 and "resource_already_exists" not in r.text:
            r.raise_for_status()
    retry(create, "建立 weblogs index")

    now = datetime.datetime.now(datetime.timezone.utc)
    lines = []
    with open(DATA, encoding="utf-8") as f:
        for raw in f:
            if not raw.strip():
                continue
            d = json.loads(raw)
            d["@timestamp"] = (now - datetime.timedelta(minutes=d.pop("minutes_ago"))).isoformat()
            lines += [json.dumps({"index": {"_index": "weblogs"}}), json.dumps(d, ensure_ascii=False)]
    body = "\n".join(lines) + "\n"
    r = retry(lambda: indexer_request("POST", "/_bulk?refresh=true", content=body,
                                      headers={"Content-Type": "application/x-ndjson"}), "匯入 web log")
    r.raise_for_status()
    if r.json().get("errors"):
        print("[seed] 匯入時有錯誤：", r.text[:500], flush=True)
    return len(lines) // 2


def create_kibana_data_views() -> None:
    for name in KIBANA_DATA_VIEWS:
        body = {"data_view": {"title": f"{name}*", "name": name, "timeFieldName": "@timestamp"},
                "override": True}
        r = retry(lambda: httpx.post(f"{KIBANA_URL}/api/data_views/data_view", json=body,
                                     headers={"kbn-xsrf": "true"}, timeout=60), f"建立資料檢視 {name}")
        print(f"[seed] Kibana 資料檢視 {name}：{'OK' if r.status_code < 300 else r.text[:150]}", flush=True)


if __name__ == "__main__":
    mode = "Wazuh indexer" if IS_WAZUH else "Elasticsearch"
    print(f"[seed] 後端：{mode}（{common.INDEXER_URL}）", flush=True)
    if not wait_indexer():
        sys.exit("[seed] 資料庫未啟動，請看 docker compose logs")
    print(f"[seed] 已載入 {load_weblogs()} 筆 web log 到 weblogs", flush=True)

    if IS_WAZUH:
        print("[seed] Wazuh 版：治理事件由 Wazuh 讀本機 log 產生告警（wazuh-alerts-*），"
              "戰情室看 Grafana、技術細節看 Wazuh dashboard；不建 Kibana 資料檢視。", flush=True)
    elif KIBANA_URL:
        if wait_http(f"{KIBANA_URL}/api/status", "Kibana", timeout=600):
            create_kibana_data_views()
        else:
            print("[seed] Kibana 未就緒；稍後再執行一次：docker compose run --rm seed", flush=True)
    print("[seed] 完成", flush=True)
