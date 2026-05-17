"""
Pull Jeff Sackmann ATP/WTA match CSVs for a year and ingest as per-tournament
draws + points_earned into Supabase player_tournaments.

For each tournament block in the CSV:
  - Match to a tournaments row by (tour, year, name) — fuzzy ILIKE
  - For each player who appears in any match: derive seed, round reached,
    points_earned via data/scoring_points.json
  - Upsert player_tournaments(tournament_id, player_id, seed, status, round_reached, points_earned)
  - Create missing players (name + tour + country)

Idempotent. Re-runnable. No API quota.

Usage:
  python scripts/load_sackmann_draws.py 2026
  python scripts/load_sackmann_draws.py 2025 2026
  python scripts/load_sackmann_draws.py 2026 --dry-run
"""

import argparse
import csv
import io
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import requests
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = create_client(URL, KEY)

POINTS = json.loads((ROOT / "data" / "scoring_points.json").read_text(encoding="utf-8"))

SOURCES = {
    "ATP": "https://raw.githubusercontent.com/JeffSackmann/tennis_atp/master/atp_matches_{year}.csv",
    "WTA": "https://raw.githubusercontent.com/JeffSackmann/tennis_wta/master/wta_matches_{year}.csv",
}

HEADERS = {"User-Agent": "TenniFantasy/0.1 (alrevs13@gmail.com)"}

# Round ranking (higher = further).
ROUND_RANK = {
    "R128": 1, "R64": 2, "R32": 3, "R16": 4,
    "QF": 5, "SF": 6, "F": 7, "W": 8,
    "RR": 3, "BR": 4,  # RR (round robin at Finals); BR (bronze, rare)
}


def download_csv(url: str) -> list[dict]:
    r = requests.get(url, headers=HEADERS, timeout=120)
    if r.status_code == 404:
        return []
    r.raise_for_status()
    return list(csv.DictReader(io.StringIO(r.text)))


def normalize_name(s: str) -> str:
    s = s.lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


# Hand-curated aliases where Sackmann name differs from common name in our DB.
TOURNAMENT_ALIASES = {
    "us open": ["us open", "us. open"],
    "australian open": ["australian open"],
    "roland garros": ["roland garros", "french open"],
    "wimbledon": ["wimbledon", "the championships"],
    "atp finals": ["nitto atp finals", "atp finals", "tour finals"],
    "wta finals": ["wta finals"],
}


def fetch_tournaments(tour: str, year: int) -> list[dict]:
    res = (
        sb.table("tournaments")
        .select("id, name, tour, category, start_date, end_date")
        .eq("tour", tour)
        .gte("start_date", f"{year}-01-01")
        .lte("start_date", f"{year}-12-31")
        .execute()
    )
    return res.data or []


def match_tournament(sackmann_name: str, candidates: list[dict]) -> dict | None:
    n = normalize_name(sackmann_name)
    aliases = [n]
    for canonical, alts in TOURNAMENT_ALIASES.items():
        if n in alts or canonical in n:
            aliases.extend(alts + [canonical])
    aliases = list(set(aliases))

    # Exact normalized match first.
    for c in candidates:
        cn = normalize_name(c["name"])
        if cn in aliases or n == cn:
            return c
    # Substring either direction.
    for c in candidates:
        cn = normalize_name(c["name"])
        for a in aliases:
            if a and (a in cn or cn in a):
                return c
    return None


def parse_seed(raw: str | None) -> int | None:
    if not raw:
        return None
    raw = raw.strip()
    if not raw or not raw.isdigit():
        return None
    return int(raw)


def compute_reached(matches: list[dict], player_name: str) -> str:
    """Return furthest round the player reached at this tournament."""
    best = None
    won_final = False
    for m in matches:
        r = m["round"]
        rank = ROUND_RANK.get(r, 0)
        in_match = (m["winner_name"] == player_name or m["loser_name"] == player_name)
        if not in_match:
            continue
        if best is None or rank > ROUND_RANK.get(best, 0):
            best = r
        if r == "F" and m["winner_name"] == player_name:
            won_final = True
    if won_final:
        return "W"
    if best is None:
        return ""
    # If they won at round X, they reached the next round above X.
    # E.g. won an R32 match → reached R16. (Final winner handled above.)
    return advance_if_won(best, player_name, matches)


def advance_if_won(round_played: str, player_name: str, matches: list[dict]) -> str:
    """If player won their match at round_played, they reached the next round."""
    won_at_round = any(
        m["round"] == round_played and m["winner_name"] == player_name for m in matches
    )
    if not won_at_round:
        return round_played
    next_round = {
        "R128": "R64", "R64": "R32", "R32": "R16", "R16": "QF",
        "QF": "SF", "SF": "F", "F": "W",
        "RR": "SF",  # winning a round-robin doesn't directly advance, approximated
    }
    return next_round.get(round_played, round_played)


def lookup_points(tour: str, category: str, reached: str) -> int:
    if not reached:
        return 0
    table = POINTS.get(tour, {}).get(category)
    if not table:
        return 0
    return int(table.get(reached, 0))


def upsert_player(full_name: str, tour: str, country: str | None) -> str | None:
    existing = (
        sb.table("players")
        .select("id")
        .eq("full_name", full_name)
        .eq("tour", tour)
        .limit(1)
        .execute()
    )
    if existing.data:
        pid = existing.data[0]["id"]
        if country:
            sb.table("players").update({"country": country}).eq("id", pid).execute()
        return pid
    ins = (
        sb.table("players")
        .insert({"full_name": full_name, "tour": tour, "country": country})
        .execute()
    )
    return ins.data[0]["id"] if ins.data else None


def process(year: int, dry_run: bool):
    for tour, url_tpl in SOURCES.items():
        url = url_tpl.format(year=year)
        print(f"\n== {tour} {year} ==")
        rows = download_csv(url)
        if not rows:
            print(f"  no data at {url}")
            continue

        # Group matches by tourney_id.
        by_tourney: dict[str, list[dict]] = defaultdict(list)
        names: dict[str, str] = {}
        for r in rows:
            tid = r.get("tourney_id") or ""
            by_tourney[tid].append(r)
            names.setdefault(tid, r.get("tourney_name") or "")

        candidates = fetch_tournaments(tour, year)
        print(f"  {len(by_tourney)} tournament blocks, {len(candidates)} in DB")

        for tid, matches in by_tourney.items():
            tname = names[tid]
            target = match_tournament(tname, candidates)
            if not target:
                print(f"  SKIP no match: {tname}")
                continue
            category = target["category"]
            if category not in POINTS.get(tour, {}):
                print(f"  SKIP no points table: {tname} ({category})")
                continue

            # Aggregate per-player data.
            player_rows: dict[str, dict] = {}
            for m in matches:
                for who in ("winner", "loser"):
                    name = m.get(f"{who}_name") or ""
                    if not name:
                        continue
                    ioc = (m.get(f"{who}_ioc") or "").strip() or None
                    seed = parse_seed(m.get(f"{who}_seed"))
                    if name not in player_rows:
                        player_rows[name] = {"seed": seed, "country": ioc}
                    else:
                        if seed is not None and player_rows[name]["seed"] is None:
                            player_rows[name]["seed"] = seed
                        if ioc and not player_rows[name]["country"]:
                            player_rows[name]["country"] = ioc

            entries = []
            for name, info in player_rows.items():
                reached = compute_reached(matches, name)
                points = lookup_points(tour, category, reached)
                entries.append(
                    {
                        "name": name,
                        "seed": info["seed"],
                        "country": info["country"],
                        "reached": reached,
                        "points": points,
                    }
                )

            print(f"  {tname} -> {target['name']} ({category}): {len(entries)} players")

            if dry_run:
                continue

            for e in entries:
                pid = upsert_player(e["name"], tour, e["country"])
                if not pid:
                    continue
                sb.table("player_tournaments").upsert(
                    {
                        "tournament_id": target["id"],
                        "player_id": pid,
                        "seed": e["seed"],
                        "status": "completed" if e["reached"] in ("W",) else "entered",
                        "round_reached": e["reached"] or None,
                        "points_earned": e["points"],
                    }
                ).execute()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("years", nargs="+", type=int)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    for y in args.years:
        process(y, args.dry_run)


if __name__ == "__main__":
    main()
