"""
Load data/seed_catalog.json into Supabase.

Idempotent: upserts by external_id for tournaments and (full_name, tour) for
players. Re-runnable.

Usage:
  python scripts/load_seed.py
"""

import json
import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "data" / "seed_catalog.json"
load_dotenv(ROOT / ".env.local")

URL = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not URL or not KEY:
    sys.exit("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local")

sb = create_client(URL, KEY)

CATEGORY_NORMALIZE = {
    "250": "250",
    "500": "500",
    "1000": "1000",
    "Slam": "Slam",
    "Finals": "Finals",
}


def upsert_player(name: str, tour: str | None) -> str | None:
    """Return player UUID. Skip if name empty or tour unknown."""
    if not name:
        return None
    # Tour may be 'BOTH' for Slams; treat as ATP fallback for player record.
    canonical_tour = tour if tour in ("ATP", "WTA") else None
    res = (
        sb.table("players")
        .select("id")
        .eq("full_name", name)
        .eq("tour", canonical_tour)
        .maybe_single()
        .execute()
    )
    if res and res.data:
        return res.data["id"]
    ins = (
        sb.table("players")
        .insert({"full_name": name, "tour": canonical_tour})
        .execute()
    )
    return ins.data[0]["id"] if ins.data else None


def upsert_tournament(t: dict) -> str:
    """Upsert by external_id; return UUID."""
    payload = {
        "external_id": t["external_id"],
        "name": t["name"],
        "tour": t["tour"] if t["tour"] in ("ATP", "WTA") else "ATP",  # default Slams to ATP rec
        "category": CATEGORY_NORMALIZE.get(t["category"], t["category"]),
        "start_date": t["start_date"],
        "end_date": t["end_date"],
        "status": "completed",
    }
    sb.table("tournaments").upsert(payload, on_conflict="external_id").execute()
    res = (
        sb.table("tournaments")
        .select("id")
        .eq("external_id", t["external_id"])
        .single()
        .execute()
    )
    return res.data["id"]


def upsert_player_tournament(tournament_id: str, player_id: str, seed, points: float):
    sb.table("player_tournaments").upsert(
        {
            "tournament_id": tournament_id,
            "player_id": player_id,
            "seed": seed,
            "points_earned": int(round(points)),
            "status": "completed",
        },
        on_conflict="tournament_id,player_id",
    ).execute()


def main():
    seed = json.loads(SEED.read_text())
    tournaments = seed["tournaments"]
    print(f"Loading {len(tournaments)} tournaments...")

    # Cache players to cut roundtrips inside one run.
    player_cache: dict[tuple[str, str | None], str] = {}

    for i, t in enumerate(tournaments, 1):
        # Slams: split into per-tour records by name.
        # The sheet has one tab per Slam covering both tours; here a single
        # record represents the event regardless of tour. We default to ATP.
        tid = upsert_tournament(t)

        for p in t["players"]:
            tour = t["tour"] if t["tour"] in ("ATP", "WTA") else "ATP"
            key = (p["name"], tour)
            pid = player_cache.get(key)
            if not pid:
                pid = upsert_player(p["name"], tour)
                if pid:
                    player_cache[key] = pid
            if pid:
                upsert_player_tournament(tid, pid, p["seed"], p["points_earned"])

        if i % 10 == 0:
            print(f"  ...{i}/{len(tournaments)}")

    # Year-long rosters: just ensure those players exist with current_season_points.
    for tour, users in seed.get("year_long", {}).items():
        for user, picks in users.items():
            for p in picks:
                key = (p["name"], tour)
                if key in player_cache:
                    pid = player_cache[key]
                else:
                    pid = upsert_player(p["name"], tour)
                    if pid:
                        player_cache[key] = pid
                if pid:
                    sb.table("players").update(
                        {"current_season_points": int(round(p["season_points"]))}
                    ).eq("id", pid).execute()

    print(f"Done. {len(player_cache)} unique player rows touched.")


if __name__ == "__main__":
    main()
