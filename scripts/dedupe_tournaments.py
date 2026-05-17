"""
Find and merge duplicate tournament rows grouped by (tour, name, year(start_date)).

Strategy:
  - For each duplicate group, pick a canonical row = the one with the most
    associated player_tournaments rows (tiebreak: oldest external_id).
  - Move league_tournaments, player_tournaments, tournament_drafts,
    tournament_picks, matches refs from duplicates to canonical.
    Skip rows that would collide on a unique/primary key.
  - Delete the duplicate tournament rows (cascade clears any leftovers).

Idempotent. Re-runnable.

Usage:
  python scripts/dedupe_tournaments.py --dry-run
  python scripts/dedupe_tournaments.py
"""

import argparse
import os
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


def fetch_all_tournaments() -> list[dict]:
    rows: list[dict] = []
    offset = 0
    while True:
        chunk = (
            sb.table("tournaments")
            .select("id, name, tour, category, start_date, external_id")
            .order("start_date")
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


def count_refs(tid: str) -> dict[str, int]:
    out = {}
    for table in (
        "player_tournaments",
        "league_tournaments",
        "tournament_drafts",
        "tournament_picks",
        "matches",
    ):
        res = sb.table(table).select("tournament_id", count="exact").eq("tournament_id", tid).limit(1).execute()
        out[table] = res.count or 0
    return out


def pick_canonical(group: list[dict]) -> dict:
    # Sort by player_tournaments count desc, then external_id asc.
    decorated = []
    for t in group:
        n = sb.table("player_tournaments").select("player_id", count="exact").eq("tournament_id", t["id"]).limit(1).execute().count or 0
        decorated.append((n, t.get("external_id") or "", t))
    decorated.sort(key=lambda x: (-x[0], x[1]))
    return decorated[0][2]


def reassign_refs(canonical_id: str, dup_id: str, dry_run: bool) -> dict:
    """Move refs from dup to canonical. Returns counts moved/skipped."""
    moved = defaultdict(int)
    skipped = defaultdict(int)

    # league_tournaments: PK (league_id, tournament_id). Conflict if league already has canonical.
    lt_dup = sb.table("league_tournaments").select("league_id").eq("tournament_id", dup_id).execute().data or []
    for r in lt_dup:
        exists = sb.table("league_tournaments").select("league_id").eq("league_id", r["league_id"]).eq("tournament_id", canonical_id).limit(1).execute().data
        if exists:
            skipped["league_tournaments"] += 1
            continue
        if not dry_run:
            sb.table("league_tournaments").update({"tournament_id": canonical_id}).eq("league_id", r["league_id"]).eq("tournament_id", dup_id).execute()
        moved["league_tournaments"] += 1

    # player_tournaments: PK (tournament_id, player_id).
    pt_dup = sb.table("player_tournaments").select("player_id").eq("tournament_id", dup_id).execute().data or []
    for r in pt_dup:
        exists = sb.table("player_tournaments").select("player_id").eq("tournament_id", canonical_id).eq("player_id", r["player_id"]).limit(1).execute().data
        if exists:
            skipped["player_tournaments"] += 1
            continue
        if not dry_run:
            sb.table("player_tournaments").update({"tournament_id": canonical_id}).eq("tournament_id", dup_id).eq("player_id", r["player_id"]).execute()
        moved["player_tournaments"] += 1

    # tournament_drafts: unique (league_id, tournament_id).
    td_dup = sb.table("tournament_drafts").select("league_id, id").eq("tournament_id", dup_id).execute().data or []
    for r in td_dup:
        exists = sb.table("tournament_drafts").select("id").eq("league_id", r["league_id"]).eq("tournament_id", canonical_id).limit(1).execute().data
        if exists:
            skipped["tournament_drafts"] += 1
            continue
        if not dry_run:
            sb.table("tournament_drafts").update({"tournament_id": canonical_id}).eq("id", r["id"]).execute()
        moved["tournament_drafts"] += 1

    # tournament_picks: unique (league_id, tournament_id, user_id, player_id).
    tp_dup = sb.table("tournament_picks").select("id, league_id, user_id, player_id").eq("tournament_id", dup_id).execute().data or []
    for r in tp_dup:
        exists = sb.table("tournament_picks").select("id").eq("league_id", r["league_id"]).eq("tournament_id", canonical_id).eq("user_id", r["user_id"]).eq("player_id", r["player_id"]).limit(1).execute().data
        if exists:
            skipped["tournament_picks"] += 1
            continue
        if not dry_run:
            sb.table("tournament_picks").update({"tournament_id": canonical_id}).eq("id", r["id"]).execute()
        moved["tournament_picks"] += 1

    # matches: no shared unique constraint with tournament_id+id.
    m_dup = sb.table("matches").select("id").eq("tournament_id", dup_id).execute().data or []
    for r in m_dup:
        if not dry_run:
            sb.table("matches").update({"tournament_id": canonical_id}).eq("id", r["id"]).execute()
        moved["matches"] += 1

    return {"moved": dict(moved), "skipped": dict(skipped)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    rows = fetch_all_tournaments()
    print(f"{len(rows)} tournaments total")

    groups: dict[tuple, list[dict]] = defaultdict(list)
    for t in rows:
        year = t["start_date"][:4] if t.get("start_date") else "?"
        key = (t["tour"], t["name"].strip().lower(), year)
        groups[key].append(t)

    dup_groups = {k: v for k, v in groups.items() if len(v) > 1}
    print(f"{len(dup_groups)} duplicate group(s)")

    for key, group in dup_groups.items():
        tour, name, year = key
        canonical = pick_canonical(group)
        print(f"\n  {tour} {name} {year}: {len(group)} rows -> canonical {canonical['id']}")
        for t in group:
            if t["id"] == canonical["id"]:
                continue
            result = reassign_refs(canonical["id"], t["id"], args.dry_run)
            print(f"    merge {t['id']} (ext={t.get('external_id')}): {result}")
            if not args.dry_run:
                sb.table("tournaments").delete().eq("id", t["id"]).execute()

    print("\ndone")


if __name__ == "__main__":
    main()
