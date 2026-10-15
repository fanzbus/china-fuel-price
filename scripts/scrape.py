#!/usr/bin/env python3
"""抓取 qiyoujiage.com 首页 31 省油价，写 data/ + public/data/。

规则（诚实性硬要求）：
- 只取价格数字 + 调价时间，不抄文章。
- 解析失败 / 省份不足 31 / 价格越界 -> 直接失败退出，不写脏数据。
- 每天最多 1 次（由 GitHub Actions 定时触发），UA 明确标识。
- 预测/汇率上游取不到 -> forecast.json 写 no_data，不编造。
"""
import json
import re
import sys
import time
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

CST = timezone(timedelta(hours=8))  # 北京时间，种子与展示统一 +08:00

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PUBLIC_DATA = ROOT / "public" / "data"
SOURCE_URL = "http://www.qiyoujiage.com/"
UA = "china-fuel-price/1.0 (+https://github.com/fanzbus/china-fuel-price; daily sync, contact via repo)"

PROVINCES = ["北京", "上海", "江苏", "天津", "重庆", "江西", "辽宁", "安徽", "内蒙古",
             "福建", "宁夏", "甘肃", "青海", "广东", "山东", "广西", "山西", "贵州",
             "陕西", "海南", "四川", "河北", "西藏", "河南", "新疆", "黑龙江",
             "吉林", "云南", "湖北", "浙江", "湖南"]


def fetch_text(url, timeout=20):
    last = None
    for attempt in range(3):  # 失败重试 2 次
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
            for enc in ("utf-8", "gbk", "gb2312"):
                try:
                    return raw.decode(enc)
                except UnicodeDecodeError:
                    continue
            return raw.decode("utf-8", errors="replace")
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"fetch failed after 3 attempts: {url}: {last}")


def parse_prices(html):
    # 去脚本/样式，标签转空格，压缩空白
    text = re.sub(r"<script.*?</script>", " ", html, flags=re.S | re.I)
    text = re.sub(r"<style.*?</style>", " ", text, flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text)
    provinces = []
    for name in PROVINCES:
        m = re.search(rf"{re.escape(name)}\s*(\d+\.\d+)\s*(\d+\.\d+)\s*(\d+\.\d+)\s*(\d+\.\d+)", text)
        if not m:
            raise ValueError(f"province not found or unparsable: {name}")
        vals = [float(x) for x in m.groups()]
        if not all(3.0 <= v <= 15.0 for v in vals):
            raise ValueError(f"price out of range for {name}: {vals}")
        provinces.append({"province": name, "p92": vals[0], "p95": vals[1],
                          "p98": vals[2], "d0": vals[3]})
    if len(provinces) != 31:
        raise ValueError(f"expected 31 provinces, got {len(provinces)}")
    # 下次调价时间：如“下次油价10月15日24时调整”
    next_label = None
    m = re.search(r"下次油价\s*(\d+月\d+日\d+时)\s*调整", text)
    if m:
        next_label = m.group(1)
    status = "未知"
    if "搁浅" in text[:2000]:
        status = "搁浅（维持目前价格不变）"
    elif "下调" in text[:2000]:
        status = "预计下调"
    elif "上调" in text[:2000]:
        status = "预计上调"
    return provinces, next_label, status


def try_forecast():
    """尝试 Stooq + ER-API，任何一步失败即返回 no_data（不编造）。"""
    base = {"status": "no_data", "as_of": None, "change_rate_pct": None,
            "direction": None, "estimated_adjustment_yuan_per_ton": None,
            "confidence": None,
            "formula": "10 个工作日一揽子原油价格变化率；按发改委规则，变化率对应调价金额不足 50 元/吨时不作调整（搁浅）。本字段为规则计算，非人工预测。",
            "method": "取 Stooq Brent (brn.f) 与 WTI (cl.f) 最近 10 个工作日收盘价均值，与上一周期均值比较；汇率用 ER-API USD/CNY。任一上游取不到则 status=no_data，不编造。",
            "note": "暂无预测数据：上游公开源尚未在自动任务中验证通过。",
            "sources": {"fx": "https://open.er-api.com/v6/latest/USD",
                       "oil": "https://stooq.com/q/d/l/?s=brn.f&i=d 与 cl.f"}}
    try:
        def stooq(symbol):
            csv = fetch_text(f"https://stooq.com/q/d/l/?s={symbol}&i=d", timeout=15)
            rows = []
            for line in csv.strip().splitlines()[1:]:
                parts = line.split(",")
                if len(parts) >= 5:
                    rows.append(float(parts[4]))
            return rows
        brent = stooq("brn.f")
        wti = stooq("cl.f")
        if len(brent) < 20 or len(wti) < 20:
            return base
        # 最近 10 日均值 vs 再往前 10 日均值（近似上一周期）
        def change(rows):
            recent = sum(rows[-10:]) / 10
            prev = sum(rows[-20:-10]) / 10
            return (recent - prev) / prev * 100 if prev else None
        c = (change(brent) + change(wti)) / 2
        fx = json.loads(fetch_text("https://open.er-api.com/v6/latest/USD", timeout=15))
        usd_cny = fx.get("rates", {}).get("CNY")
        if c is None or not usd_cny:
            return base
        # 粗略换算：变化率 -> 元/吨量级（仅规则示意，标注为估算）
        est = round(c * 100, 0)  # 1% 约 100 元/吨量级估算
        direction = "上调" if est >= 50 else ("下调" if est <= -50 else "搁浅")
        base.update({"status": "estimated", "as_of": datetime.now(CST).isoformat(),
                     "change_rate_pct": round(c, 2), "direction": direction,
                     "estimated_adjustment_yuan_per_ton": est, "confidence": "低（仅原油现货均值近似，正式结果以发改委为准）",
                     "usd_cny": usd_cny,
                     "note": "规则估算，非官方预测；正式结果以国家发改委通知为准。"})
        return base
    except Exception:  # noqa: BLE001
        return base


def main():
    html = fetch_text(SOURCE_URL)
    provinces, next_label, status = parse_prices(html)
    now = datetime.now(CST)
    fetched_at = now.isoformat(timespec="seconds")
    # next_adjustment：解析“10月15日24时” -> 次日 00:00；解析失败则 null
    next_iso = None
    if next_label:
        m = re.match(r"(\d+)月(\d+)日(\d+)时", next_label)
        if m:
            mo, day, hour = map(int, m.groups())
            year = now.year
            if hour == 24:
                hour = 0
                # 次日：简单处理（月末跨月由 fromisoformat 校验，失败则 null）
                try:
                    from datetime import timedelta
                    dt = datetime(year, mo, day, tzinfo=now.tzinfo) + timedelta(days=1)
                    next_iso = dt.replace(hour=0, minute=0, second=0).isoformat(timespec="seconds")
                except ValueError:
                    next_iso = None
            else:
                try:
                    next_iso = datetime(year, mo, day, hour, tzinfo=now.tzinfo).isoformat(timespec="seconds")
                except ValueError:
                    next_iso = None

    prices = {"fetched_at": fetched_at, "source": "qiyoujiage.com",
              "source_url": SOURCE_URL, "unit": "元/升",
              "next_adjustment": next_iso, "next_adjustment_label": next_label,
              "adjustment_status": status,
              "note": "价格为事实数据，仅取数字与调价时间。历史从 2026-10-15 开始积累。",
              "provinces": provinces}
    DATA.mkdir(parents=True, exist_ok=True)
    PUBLIC_DATA.mkdir(parents=True, exist_ok=True)

    # 历史：只有变动才追加
    hist_path = DATA / "history.jsonl"
    last = None
    if hist_path.exists() and hist_path.read_text(encoding="utf-8").strip():
        try:
            last = json.loads(hist_path.read_text(encoding="utf-8").strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            last = None
    changed = (last is None or last.get("provinces") != provinces)
    if changed:
        with open(hist_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(prices, ensure_ascii=False) + "\n")
        print("history appended (changed)")
    else:
        print("history unchanged, not appended")

    (DATA / "prices.json").write_text(json.dumps(prices, ensure_ascii=False, indent=2), encoding="utf-8")
    # meta：保留 history_start，更新 fetched_at
    meta_path = DATA / "meta.json"
    meta = {}
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            meta = {}
    meta.update({"fetched_at": fetched_at, "updated_at": fetched_at,
                 "source": "qiyoujiage.com", "source_url": SOURCE_URL,
                 "next_adjustment": next_iso, "next_adjustment_label": next_label,
                 "history_start": meta.get("history_start", "2026-10-15")})
    (meta_path).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    forecast = try_forecast()
    (DATA / "forecast.json").write_text(json.dumps(forecast, ensure_ascii=False, indent=2), encoding="utf-8")

    # 同步到 public/data（Worker 通过 ASSETS 提供）
    for name in ["prices.json", "meta.json", "forecast.json"]:
        (PUBLIC_DATA / name).write_text((DATA / name).read_text(encoding="utf-8"), encoding="utf-8")
    for name in ["cities.json", "global.json"]:
        src = DATA / name
        if src.exists():
            (PUBLIC_DATA / name).write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
    if hist_path.exists():
        (PUBLIC_DATA / "history.jsonl").write_text(hist_path.read_text(encoding="utf-8"), encoding="utf-8")
    print(f"OK fetched_at={fetched_at} provinces=31 next={next_label} status={status} changed={changed}")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(f"FAILED: {e}", file=sys.stderr)
        sys.exit(2)
