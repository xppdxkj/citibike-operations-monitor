from __future__ import annotations

import argparse
import json
import math
import zipfile
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
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
    parser.add_argument("--weather", type=Path)
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
    distance_bands = defaultdict(Counter)
    hourly_timeline = defaultdict(Counter)
    unique_start_stations: set[str] = set()
    active_dates: set[str] = set()
    total_rows = 0
    valid_rows = 0
    duration_sum = 0.0
    distance_xtx = np.zeros((4, 4), dtype=float)
    distance_xty = np.zeros(4, dtype=float)
    distance_y2 = 0.0
    distance_y_sum = 0.0
    distance_n = 0

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
                    chunk["hour_ts"] = chunk["started_at"].dt.floor("h").dt.strftime("%Y-%m-%dT%H:00")
                    chunk["weekday"] = chunk["started_at"].dt.weekday
                    chunk["is_weekend"] = chunk["weekday"] >= 5
                    chunk["date"] = chunk["started_at"].dt.date.astype(str)
                    chunk["user"] = chunk["member_casual"].fillna("unknown")
                    chunk["bike"] = chunk["rideable_type"].fillna("unknown")
                    chunk["electric"] = chunk["bike"].str.contains("electric", case=False, na=False)
                    lat1 = np.radians(pd.to_numeric(chunk["start_lat"], errors="coerce").to_numpy(dtype=float))
                    lon1 = np.radians(pd.to_numeric(chunk["start_lng"], errors="coerce").to_numpy(dtype=float))
                    lat2 = np.radians(pd.to_numeric(chunk["end_lat"], errors="coerce").to_numpy(dtype=float))
                    lon2 = np.radians(pd.to_numeric(chunk["end_lng"], errors="coerce").to_numpy(dtype=float))
                    delta_lat = lat2 - lat1
                    delta_lon = lon2 - lon1
                    haversine = np.sin(delta_lat / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin(delta_lon / 2) ** 2
                    chunk["distance_km"] = 6371.0088 * 2 * np.arcsin(np.sqrt(np.clip(haversine, 0, 1)))
                    chunk["valid_distance"] = chunk["distance_km"].between(0.1, 30)
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
                    chunk["distance_band"] = pd.cut(
                        chunk["distance_km"], bins=[0.1, 1, 2, 4, 8, 30],
                        labels=["≤1km", "1–2km", "2–4km", "4–8km", ">8km"],
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
                    distance_chunk = chunk[chunk["valid_distance"]]
                    for (band, user), group in distance_chunk.groupby(["distance_band", "user"], observed=True):
                        distance_bands[str(band)][str(user)] += len(group)
                        distance_bands[str(band)]["duration_sum"] += float(group["duration_min"].sum())
                        distance_bands[str(band)]["rides"] += len(group)

                    for timestamp, group in chunk.groupby("hour_ts"):
                        stats = hourly_timeline[str(timestamp)]
                        stats["rides"] += len(group)
                        stats["member"] += int((group["user"] == "member").sum())
                        stats["casual"] += int((group["user"] == "casual").sum())
                        stats["electric"] += int(group["electric"].sum())
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        distance_group = group[group["valid_distance"]]
                        stats["distance_sum"] += float(distance_group["distance_km"].sum())
                        stats["distance_count"] += len(distance_group)

                    for user, group in chunk.groupby("user"):
                        stats = user_stats[str(user)]
                        stats["rides"] += len(group)
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        stats["weekend"] += int(group["is_weekend"].sum())
                        stats["electric"] += int(group["electric"].sum())
                        distance_group = group[group["valid_distance"]]
                        stats["distance_sum"] += float(distance_group["distance_km"].sum())
                        stats["distance_count"] += len(distance_group)
                        for hour_value, count in group.groupby("hour").size().items():
                            stats[f"hour_{int(hour_value)}"] += int(count)

                    for bike, group in chunk.groupby("bike"):
                        stats = bike_stats[str(bike)]
                        stats["rides"] += len(group)
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        stats["member"] += int((group["user"] == "member").sum())
                        distance_group = group[group["valid_distance"]]
                        stats["distance_sum"] += float(distance_group["distance_km"].sum())
                        stats["distance_count"] += len(distance_group)

                    for zone, group in chunk.groupby("start_zone"):
                        stats = region_start[str(zone)]
                        stats["rides"] += len(group)
                        stats["member"] += int((group["user"] == "member").sum())
                        stats["electric"] += int(group["electric"].sum())
                        stats["duration_sum"] += float(group["duration_min"].sum())
                        distance_group = group[group["valid_distance"]]
                        stats["distance_sum"] += float(distance_group["distance_km"].sum())
                        stats["distance_count"] += len(distance_group)
                        for hour_value, count in group.groupby("hour").size().items():
                            stats[f"hour_{int(hour_value)}"] += int(count)
                    region_end.update(chunk["end_zone"].value_counts().astype(int).to_dict())

                    routes.update({(str(start), str(end)): int(count) for (start, end), count in chunk.groupby(["start_station_name", "end_station_name"]).size().items() if start != end})
                    start_stations.update(chunk["start_station_name"].astype(str).value_counts().astype(int).to_dict())
                    end_stations.update(chunk["end_station_name"].astype(str).value_counts().astype(int).to_dict())

                    model_rows = chunk[chunk["valid_distance"]]
                    if not model_rows.empty:
                        x = np.column_stack([
                            np.ones(len(model_rows)),
                            np.log(model_rows["distance_km"].to_numpy(dtype=float)),
                            model_rows["electric"].astype(float).to_numpy(),
                            (model_rows["user"] == "casual").astype(float).to_numpy(),
                        ])
                        y = np.log(model_rows["duration_min"].to_numpy(dtype=float))
                        distance_xtx += x.T @ x
                        distance_xty += x.T @ y
                        distance_y2 += float(y @ y)
                        distance_y_sum += float(y.sum())
                        distance_n += len(y)

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
            "avgDistance": round(stats["distance_sum"] / stats["distance_count"], 2) if stats["distance_count"] else 0,
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
            "avgDistance": round(stats["distance_sum"] / stats["distance_count"], 2) if stats["distance_count"] else 0,
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
            "avgDistance": round(stats["distance_sum"] / stats["distance_count"], 2) if stats["distance_count"] else 0,
        })
    regions.sort(key=lambda row: row["starts"], reverse=True)

    def series(counter_map: defaultdict, labels: list) -> list[dict]:
        return [{"label": label, "member": int(counter_map[key]["member"]), "casual": int(counter_map[key]["casual"])} for key, label in labels]

    distance_beta = np.linalg.solve(distance_xtx, distance_xty) if distance_n and np.linalg.matrix_rank(distance_xtx) == 4 else np.zeros(4)
    distance_sse = distance_y2 - 2 * float(distance_beta @ distance_xty) + float(distance_beta @ distance_xtx @ distance_beta)
    distance_sst = distance_y2 - (distance_y_sum ** 2 / distance_n) if distance_n else 0
    distance_model = {
        "samples": distance_n,
        "r2": round(max(0.0, 1 - distance_sse / distance_sst), 4) if distance_sst else 0,
        "distanceElasticity": round(float(distance_beta[1]), 4),
        "electricDurationEffectPct": round(float(np.expm1(distance_beta[2]) * 100), 2),
        "casualDurationEffectPct": round(float(np.expm1(distance_beta[3]) * 100), 2),
        "method": "log(duration) ~ log(straight-line distance) + electric + casual",
    }

    weather_analysis = None
    if args.weather and args.weather.exists():
        weather_raw = json.loads(args.weather.read_text(encoding="utf-8"))
        weather_hourly = weather_raw["hourly"]
        weather_frame = pd.DataFrame({
            "timestamp": weather_hourly["time"],
            "temperature": weather_hourly["temperature_2m"],
            "apparentTemperature": weather_hourly["apparent_temperature"],
            "precipitation": weather_hourly["precipitation"],
            "windSpeed": weather_hourly["wind_speed_10m"],
        })
        rides_frame = pd.DataFrame([
            {
                "timestamp": timestamp,
                "rides": int(stats["rides"]),
                "member": int(stats["member"]),
                "casual": int(stats["casual"]),
                "electric": int(stats["electric"]),
                "avgDuration": stats["duration_sum"] / stats["rides"] if stats["rides"] else 0,
                "avgDistance": stats["distance_sum"] / stats["distance_count"] if stats["distance_count"] else 0,
            }
            for timestamp, stats in sorted(hourly_timeline.items())
        ])
        merged = rides_frame.merge(weather_frame, on="timestamp", how="inner")
        merged["datetime"] = pd.to_datetime(merged["timestamp"])
        merged["hour"] = merged["datetime"].dt.hour
        merged["weekday"] = merged["datetime"].dt.weekday
        merged["scheduleBaseline"] = merged.groupby(["weekday", "hour"])["rides"].transform("mean")
        merged["demandIndex"] = merged["rides"] / merged["scheduleBaseline"].replace(0, np.nan) * 100
        merged["rainBand"] = pd.cut(merged["precipitation"], [-0.001, 0.099, 2.5, float("inf")], labels=["无降雨", "小雨", "中到大雨"])
        merged["temperatureBand"] = pd.cut(merged["temperature"], [-50, 10, 15, 20, 25, 60], labels=["≤10°C", "10–15°C", "15–20°C", "20–25°C", ">25°C"])

        weather_effects = []
        for column, label in [("temperature", "气温 +1°C"), ("precipitation", "降雨 +1mm"), ("windSpeed", "风速 +1km/h")]:
            weather_effects.append({"factor": label, "correlation": round(float(merged[["demandIndex", column]].corr().iloc[0, 1]), 4)})

        hour_dummies = pd.get_dummies(merged["hour"], prefix="hour", drop_first=True, dtype=float)
        weekday_dummies = pd.get_dummies(merged["weekday"], prefix="weekday", drop_first=True, dtype=float)
        weather_x = pd.concat([merged[["temperature", "precipitation", "windSpeed"]].astype(float), hour_dummies, weekday_dummies], axis=1)
        weather_matrix = np.column_stack([np.ones(len(weather_x)), weather_x.to_numpy(dtype=float)])
        weather_y = np.log1p(merged["rides"].to_numpy(dtype=float))
        weather_beta, *_ = np.linalg.lstsq(weather_matrix, weather_y, rcond=None)
        predictions = weather_matrix @ weather_beta
        weather_r2 = 1 - float(((weather_y - predictions) ** 2).sum()) / float(((weather_y - weather_y.mean()) ** 2).sum())
        controlled = [
            {"factor": "气温 +1°C", "effectPct": round(float(np.expm1(weather_beta[1]) * 100), 2)},
            {"factor": "降雨 +1mm", "effectPct": round(float(np.expm1(weather_beta[2]) * 100), 2)},
            {"factor": "风速 +1km/h", "effectPct": round(float(np.expm1(weather_beta[3]) * 100), 2)},
        ]
        rain_impact = merged.groupby("rainBand", observed=True).agg(hours=("rides", "size"), avgRides=("rides", "mean"), demandIndex=("demandIndex", "mean")).reset_index()
        temperature_impact = merged.groupby("temperatureBand", observed=True).agg(hours=("rides", "size"), avgRides=("rides", "mean"), demandIndex=("demandIndex", "mean")).reset_index()
        weather_analysis = {
            "source": "Open-Meteo historical hourly weather",
            "matchedHours": len(merged),
            "controlledModelR2": round(weather_r2, 4),
            "method": "log(hourly rides) ~ temperature + precipitation + wind + hour fixed effects + weekday fixed effects",
            "correlations": weather_effects,
            "controlledEffects": controlled,
            "rainImpact": [{"label": str(row.rainBand), "hours": int(row.hours), "avgRides": round(row.avgRides, 1), "demandIndex": round(row.demandIndex, 1)} for row in rain_impact.itertuples()],
            "temperatureImpact": [{"label": str(row.temperatureBand), "hours": int(row.hours), "avgRides": round(row.avgRides, 1), "demandIndex": round(row.demandIndex, 1)} for row in temperature_impact.itertuples()],
        }

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
        "distanceBands": [{"label": label, "member": int(distance_bands[label]["member"]), "casual": int(distance_bands[label]["casual"]), "avgDuration": round(distance_bands[label]["duration_sum"] / distance_bands[label]["rides"], 1) if distance_bands[label]["rides"] else 0} for label in ["≤1km", "1–2km", "2–4km", "4–8km", ">8km"]],
        "distanceModel": distance_model,
        "weather": weather_analysis,
        "topRoutes": [{"start": start, "end": end, "rides": count} for (start, end), count in routes.most_common(20)],
        "topStartStations": [{"name": name, "rides": count} for name, count in start_stations.most_common(20)],
        "topEndStations": [{"name": name, "rides": count} for name, count in end_stations.most_common(20)],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps(payload["meta"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
