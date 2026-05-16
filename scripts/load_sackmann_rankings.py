"""
Download Jeff Sackmann's current ATP/WTA rankings + player CSVs from GitHub
and upsert into Supabase players table.

Idempotent. Re-runnable. No API quota.

Usage:
  python scripts/load_sackmann_rankings.py
"""

import csv
import io
import os
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = create_client(URL, KEY)

SOURCES = {
    "ATP": (
        "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_players.csv",
        "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_rankings_current.csv",
    ),
    "WTA": (
        "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_players.csv",
        "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_rankings_current.csv",
    ),
}

HEADERS = {"User-Agent": "TenniFantasy/0.1 (alrevs13@gmail.com)"}
TOP_N = 500  # Cap inserts; tier model only needs top ~150.


def download_csv(url: str) -> list[dict]:
    r = requests.get(url, headers=HEADERS, timeout=60)
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def main():
    for tour, (players_url, rankings_url) in SOURCES.items():
        print(f"== {tour} ==")
        players = {p["player_id"]: p for p in download_csv(players_url)}
        rankings = download_csv(rankings_url)

        # Latest snapshot only.
        latest = max(r["ranking_date"] for r in rankings)
        snapshot = [r for r in rankings if r["ranking_date"] == latest]
        snapshot.sort(key=lambda r: int(r["rank"]))
        snapshot = snapshot[:TOP_N]

        print(f"  latest snapshot: {latest}, top {len(snapshot)}")

        upserted = 0
        for r in snapshot:
            pid = r["player"]
            p = players.get(pid)
            if not p:
                continue
            name = f"{p['name_first']} {p['name_last']}".strip()
            country = (p.get("ioc") or "").strip() or None

            existing = (
                sb.table("players")
                .select("id")
                .eq("full_name", name)
                .eq("tour", tour)
                .maybe_single()
                .execute()
            )
            payload = {
                "external_id": f"sackmann-{tour.lower()}-{pid}",
                "full_name": name,
                "tour": tour,
                "country": country,
                "current_rank": int(r["rank"]),
                "current_season_points": int(r["points"]),
            }
            if existing and existing.data:
                sb.table("players").update(payload).eq("id", existing.data["id"]).execute()
            else:
                sb.table("players").insert(payload).execute()
            upserted += 1

        print(f"  upserted {upserted}")


if __name__ == "__main__":
    main()
