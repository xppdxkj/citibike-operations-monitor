from __future__ import annotations

import argparse
import json
import math
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import pandas as pd


WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def zone_for(lat: float, lng: float) -> str:
    if not math.isfinite(lat) or not math.isfinite(lng):
        return "未知区域"
    if lng < -74.02:
        return "新泽西"
    if lng > -73.93 and lat < 40.79:
        return "皇后区"
    if lat < 40.70:
        return "布鲁克林南部"
    if lng > -73.97 and lat < 40.73:
        return "布鲁克林北部"
    if lat < 40.72:
        return "曼哈顿下城"
    if lat < 40.755:
        return "曼哈顿中城"
    if lat < 40.80:
        return "曼哈顿上城"
    return "北部城区"


def safe_ratio(numerator: float, denominator: float) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description="Aggregate Citi Bike monthly trip CSV ZIP into a compact dashboard dataset.")
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--month", required=True)
    args = parser.parse_args()

    hourly = defaultdict(Counter)
    weekday = defaultdict(Counter)
    time_band = defaultdict(Counter)
    region_start = defaultdict(Counter)
    region_end = Counter()
    user_stats = defaultdict(Counter)
    bike_stats = defaultdict(Counter)
    routes = Counter()
    start_stations = Counter()
    end_stations = Counter()
    duration_bands = defaultdict(Counter)
    unique_start_stations: set[str] = set()
    active_dates: set[str] = set()
    total_rows = 0
    valid_rows = 0
    duration_sum = 0.0

    columns = [
        "rideable_type", "started_at", "ended_at", "start_station_name", "end_station_name",
        "start_lat", "start_lng", "end_lat", "end_lng", "member_casual",
    ]

    with zipfile.ZipFile(args.input) as archive:
        members = [name for name in archive.namelist() if name.lower().endswith(".csv")]
        for member in members:
            with archive.open(member) as source:
                for chunk in pd.read_csv(source, usecols=columns, chunksize=250_000, low_memory=False):
                    total_rows += len(chunk)
                    chunk["started_at"] = pd.to_datetime(chunk["started_at"], errors="coerce")
                    chunk["ended_at"] = pd.to_datetime(chunk["ended_at"], errors="coerce")
                    chunk["duration_min"] = (chunk["ended_at"] - chunk["started_at"]).dt.total_seconds() / 60
                    chunk = chunk[
                        chunk["started_at"].notna()
                        & chunk["ended_at"].notna()
                        & chunk["start_station_name"].notna()
                        & chunk["end_station_name"].notna()
                        & chunk["duration_min"].between(1, 180)
                    ].copy()
                    if chunk.empty:
                        continue

                    valid_rows += len(chunk)
                    duration_sum += float(chunk["duration_min"].sum())
                    chunk["hour"] = chunk["started_at"].dt.hour
                    chunk["weekday"] = chunk["started_at"].dt.weekday
                    chunk["is_weekend"] = chunk["weekday"] >= 5
                    chunk["date"] = chunk["started_at"].dt.date.astype(str)
                    chunk["user"] = chunk["member_casual"].fillna("unknown")
                    chunk["bike"] = chunk["rideable_type"].fillna("unknown")
                    chunk["electric"] = chunk["bike"].str.contains("electric", case=False, na=False)
                    chunk["start_zone"] = [zone_for(lat, lng) for lat, lng in zip(chunk["start_lat"], chunk["start_lng"])]
                    chunk["end_zone"] = [zone_for(lat, lng) for lat, lng in zip(chunk["end_lat"], chunk["end_lng"])]
                    chunk["time_band"] = pd.cut(
                        chunk["hour"], bins=[-1, 5, 9, 15, 19, 23],
                        labels=["夜间 0–5", "早高峰 6–9", "日间 10–15", "晚高峰 16–19", "晚间 20–23"],
                    ).astype(str)
                    chunk["duration_band"] = pd.cut(
                        chunk["duration_min"], bins=[0, 10, 20, 30, 60, 180],
                        labels=["≤10分钟", "10–20分钟", "20–30分钟", "30–60分钟", ">60分钟"],
                    ).astype(str)

                    active_dates.update(chunk["date"].unique().tolist())
                    unique_start_stations.update(chunk["start_station_name"].astype(str).unique().tolist())

                    for (hour_value, user), count in chunk.groupby(["hour", "user"]).size().items():
                        hourly[int(hour_value)][str(user)] += int(count)
                    for (day_value, user), count in chunk.groupby(["weekday", "user"]).size().items():
                        weekday[int(day_value)][str(user)] += int(count)
                    for (band, user), count in chunk.groupby(["time_band", "user"], observed=True).size().items():
                        time_band[str(band)][str(user)] += int(count)
                    for (band, user), count in chunk.groupby(["duration_band", "user"], observed=True).size().items():
                        duration_bands[str(band)][str(user)] += int(count)

                    for user, group in chunk.groupby("user"):
                        stats = user_stats[str(user)]
                        stats["rides"] += len(group)
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        stats["weekend"] += int(group["is_weekend"].sum())
                        stats["electric"] += int(group["electric"].sum())
                        for hour_value, count in group.groupby("hour").size().items():
                            stats[f"hour_{int(hour_value)}"] += int(count)

                    for bike, group in chunk.groupby("bike"):
                        stats = bike_stats[str(bike)]
                        stats["rides"] += len(group)
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        stats["member"] += int((group["user"] == "member").sum())

                    for zone, group in chunk.groupby("start_zone"):
                        stats = region_start[str(zone)]
                        stats["rides"] += len(group)
                        stats["member"] += int((group["user"] == "member").sum())
                        stats["electric"] += int(group["electric"].sum())
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        for hour_value, count in group.groupby("hour").size().items():
                            stats[f"hour_{int(hour_value)}"] += int(count)
                    region_end.update(chunk["end_zone"].value_counts().astype(int).to_dict())

                    routes.update({(str(start), str(end)): int(count) for (start, end), count in chunk.groupby(["start_station_name", "end_station_name"]).size().items() if start != end})
                    start_stations.update(chunk["start_station_name"].astype(str).value_counts().astype(int).to_dict())
                    end_stations.update(chunk["end_station_name"].astype(str).value_counts().astype(int).to_dict())

    users = []
    for user, stats in user_stats.items():
        rides = int(stats["rides"])
        peak_hour = max(range(24), key=lambda hour_value: stats[f"hour_{hour_value}"])
        users.append({
            "type": user,
            "rides": rides,
            "share": safe_ratio(rides, valid_rows),
            "avgDuration": round(stats["duration_sum"] / rides, 1) if rides else 0,
            "weekendShare": safe_ratio(stats["weekend"], rides),
            "electricShare": safe_ratio(stats["electric"], rides),
            "peakHour": peak_hour,
        })

    bikes = []
    for bike, stats in bike_stats.items():
        rides = int(stats["rides"])
        bikes.append({
            "type": bike,
            "rides": rides,
            "share": safe_ratio(rides, valid_rows),
            "avgDuration": round(stats["duration_sum"] / rides, 1) if rides else 0,
            "memberShare": safe_ratio(stats["member"], rides),
        })

    regions = []
    for zone, stats in region_start.items():
        rides = int(stats["rides"])
        peak_hour = max(range(24), key=lambda hour_value: stats[f"hour_{hour_value}"])
        regions.append({
            "name": zone,
            "starts": rides,
            "ends": int(region_end[zone]),
            "netFlow": int(region_end[zone]) - rides,
            "share": safe_ratio(rides, valid_rows),
            "memberShare": safe_ratio(stats["member"], rides),
            "electricShare": safe_ratio(stats["electric"], rides),
            "avgDuration": round(stats["duration_sum"] / rides, 1) if rides else 0,
            "peakHour": peak_hour,
        })
    regions.sort(key=lambda row: row["starts"], reverse=True)

    def series(counter_map: defaultdict, labels: list) -> list[dict]:
        return [{"label": label, "member": int(counter_map[key]["member"]), "casual": int(counter_map[key]["casual"])} for key, label in labels]

    payload = {
        "meta": {
            "source": "Citi Bike monthly trip data",
            "month": args.month,
            "files": len(members),
            "rawRows": total_rows,
            "validRides": valid_rows,
            "activeDays": len(active_dates),
            "stations": len(unique_start_stations),
            "avgDuration": round(duration_sum / valid_rows, 1) if valid_rows else 0,
            "generatedAt": pd.Timestamp.now("UTC").isoformat(),
            "filters": "站点完整、时长1–180分钟",
        },
        "users": sorted(users, key=lambda row: row["rides"], reverse=True),
        "bikes": sorted(bikes, key=lambda row: row["rides"], reverse=True),
        "regions": regions,
        "hourly": series(hourly, [(hour_value, f"{hour_value:02d}:00") for hour_value in range(24)]),
        "weekday": series(weekday, list(enumerate(WEEKDAYS))),
        "timeBands": series(time_band, [(label, label) for label in ["夜间 0–5", "早高峰 6–9", "日间 10–15", "晚高峰 16–19", "晚间 20–23"]]),
        "durationBands": series(duration_bands, [(label, label) for label in ["≤10分钟", "10–20分钟", "20–30分钟", "30–60分钟", ">60分钟"]]),
        "topRoutes": [{"start": start, "end": end, "rides": count} for (start, end), count in routes.most_common(20)],
        "topStartStations": [{"name": name, "rides": count} for name, count in start_stations.most_common(20)],
        "topEndStations": [{"name": name, "rides": count} for name, count in end_stations.most_common(20)],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["meta"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
