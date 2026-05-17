"""
Merge duplicate `players` rows where the only difference is a Wikipedia
disambiguation suffix (e.g. "Tommy Paul" vs "Tommy Paul (tennis)").

For each (tour, normalized_name) group with >1 row:
  - Canonical = row WITHOUT a parenthetical suffix (else most-referenced).
  - Move FK refs (year_long_rosters, tournament_picks, player_tournaments,
    matches.winner_id / player1_id / player2_id, year_long_rosters.replaced_by,
    tournament_picks.replaced_by) from dupes to canonical, skipping rows that
    would collide on a unique/primary key.
  - Delete duplicates.

Idempotent. Re-runnable.

Usage:
  python scripts/dedupe_players.py --dry-run
  python scripts/dedupe_players.py
"""

import argparse
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
sb = create_client(
    os.environ["NEXT_PUBLIC_SUPABASE_URL"],
    os.environ["SUPABASE_SERVICE_ROLE_KEY"],
)

DISAMBIG_RE = re.compile(r"\s*\([^)]*\)\s*$")


def normalize(name: str) -> str:
    return DISAMBIG_RE.sub("", name or "").strip().lower()


def has_disambig(name: str) -> bool:
    return bool(DISAMBIG_RE.search(name or ""))


def fetch_all_players() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        chunk = (
            sb.table("players")
            .select("id, full_name, tour, country, current_rank, current_season_points")
            .order("full_name")
            .range(offset, offset + 999)
            .execute()
            .data
            or []
        )
        rows.extend(chunk)
        if len(chunk) < 1000:
            break
        offset += 1000
    return rows


def ref_count(pid: str) -> int:
    total = 0
    for table, col in (
        ("year_long_rosters", "player_id"),
        ("tournament_picks", "player_id"),
        ("player_tournaments", "player_id"),
    ):
        n = sb.table(table).select(col, count="exact").eq(col, pid).limit(1).execute().count or 0
        total += n
    return total


def pick_canonical(group: list[dict]) -> dict:
    # Prefer rows without disambig; tiebreak by ref count, then by richest profile.
    decorated = []
    for p in group:
        score = 0
        if not has_disambig(p["full_name"]):
            score += 1000
        score += ref_count(p["id"])
        if p.get("current_rank") is not None:
            score += 1
        if p.get("current_season_points"):
            score += 1
        decorated.append((score, p))
    decorated.sort(key=lambda x: -x[0])
    return decorated[0][1]


def reassign(canonical_id: str, dup_id: str, dry_run: bool) -> dict:
    moved: dict[str, int] = defaultdict(int)
    skipped: dict[str, int] = defaultdict(int)

    # year_long_rosters: PK (league_id, user_id, tour, player_id).
    rows = sb.table("year_long_rosters").select("league_id, user_id, tour").eq("player_id", dup_id).execute().data or []
    for r in rows:
        exists = (
            sb.table("year_long_rosters")
            .select("player_id")
            .eq("league_id", r["league_id"])
            .eq("user_id", r["user_id"])
            .eq("tour", r["tour"])
            .eq("player_id", canonical_id)
            .limit(1)
            .execute()
            .data
        )
        if exists:
            skipped["year_long_rosters"] += 1
            continue
        if not dry_run:
            sb.table("year_long_rosters").update({"player_id": canonical_id}).eq("league_id", r["league_id"]).eq("user_id", r["user_id"]).eq("tour", r["tour"]).eq("player_id", dup_id).execute()
        moved["year_long_rosters"] += 1

    # year_long_rosters.replaced_by — just null/update.
    rb = sb.table("year_long_rosters").select("league_id, user_id, tour, player_id").eq("replaced_by", dup_id).execute().data or []
    for r in rb:
        if not dry_run:
            sb.table("year_long_rosters").update({"replaced_by": canonical_id}).eq("league_id", r["league_id"]).eq("user_id", r["user_id"]).eq("tour", r["tour"]).eq("player_id", r["player_id"]).execute()
        moved["year_long_rosters.replaced_by"] += 1

    # tournament_picks: unique (league_id, tournament_id, user_id, player_id).
    rows = sb.table("tournament_picks").select("id, league_id, tournament_id, user_id").eq("player_id", dup_id).execute().data or []
    for r in rows:
        exists = (
            sb.table("tournament_picks")
            .select("id")
            .eq("league_id", r["league_id"])
            .eq("tournament_id", r["tournament_id"])
            .eq("user_id", r["user_id"])
            .eq("player_id", canonical_id)
            .limit(1)
            .execute()
            .data
        )
        if exists:
            skipped["tournament_picks"] += 1
            continue
        if not dry_run:
            sb.table("tournament_picks").update({"player_id": canonical_id}).eq("id", r["id"]).execute()
        moved["tournament_picks"] += 1

    rb = sb.table("tournament_picks").select("id").eq("replaced_by", dup_id).execute().data or []
    for r in rb:
        if not dry_run:
            sb.table("tournament_picks").update({"replaced_by": canonical_id}).eq("id", r["id"]).execute()
        moved["tournament_picks.replaced_by"] += 1

    # player_tournaments: PK (tournament_id, player_id).
    rows = sb.table("player_tournaments").select("tournament_id, seed, status, round_reached, points_earned").eq("player_id", dup_id).execute().data or []
    for r in rows:
        exists = sb.table("player_tournaments").select("player_id").eq("tournament_id", r["tournament_id"]).eq("player_id", canonical_id).limit(1).execute().data
        if exists:
            # merge richer values into canonical if dup has data canonical lacks
            canon = sb.table("player_tournaments").select("seed, points_earned, round_reached, status").eq("tournament_id", r["tournament_id"]).eq("player_id", canonical_id).single().execute().data
            patch = {}
            if canon.get("seed") is None and r.get("seed") is not None:
                patch["seed"] = r["seed"]
            if (not canon.get("round_reached")) and r.get("round_reached"):
                patch["round_reached"] = r["round_reached"]
            if (canon.get("points_earned") or 0) == 0 and (r.get("points_earned") or 0) > 0:
                patch["points_earned"] = r["points_earned"]
            if patch and not dry_run:
                sb.table("player_tournaments").update(patch).eq("tournament_id", r["tournament_id"]).eq("player_id", canonical_id).execute()
            skipped["player_tournaments"] += 1
            continue
        if not dry_run:
            sb.table("player_tournaments").update({"player_id": canonical_id}).eq("tournament_id", r["tournament_id"]).eq("player_id", dup_id).execute()
        moved["player_tournaments"] += 1

    # matches: winner_id / player1_id / player2_id.
    for col in ("winner_id", "player1_id", "player2_id"):
        rows = sb.table("matches").select("id").eq(col, dup_id).execute().data or []
        for r in rows:
            if not dry_run:
                sb.table("matches").update({col: canonical_id}).eq("id", r["id"]).execute()
            moved[f"matches.{col}"] += 1

    return {"moved": dict(moved), "skipped": dict(skipped)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    players = fetch_all_players()
    print(f"{len(players)} players total")

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for p in players:
        key = (p["tour"], normalize(p["full_name"]))
        groups[key].append(p)

    dups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"{len(dups)} duplicate group(s)")

    for key, group in dups.items():
        tour, norm = key
        canonical = pick_canonical(group)
        non_canon = [g for g in group if g["id"] != canonical["id"]]
        print(f"\n  [{tour}] {norm}: {len(group)} rows -> canonical '{canonical['full_name']}'")
        for d in non_canon:
            result = reassign(canonical["id"], d["id"], args.dry_run)
            print(f"    merge '{d['full_name']}' ({d['id']}): {result}")
            if not args.dry_run:
                sb.table("players").delete().eq("id", d["id"]).execute()

    print("\ndone")


if __name__ == "__main__":
    main()
