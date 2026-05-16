"""
Load data/wiki_calendar_<year>.json into Supabase tournaments table.

Idempotent: upserts by external_id. Re-runnable.

Usage:
  python scripts/load_wiki.py 2026
  python scripts/load_wiki.py 2025 2026
"""

import json
import os
import sys
from datetime import date, datetime
from pathlib import Path

from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
URL = os.environ["NEXT_PUBLIC_SUPABASE_URL"]
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
sb = create_client(URL, KEY)


def status_for(start: str, end: str) -> str:
    today = date.today()
    s = datetime.strptime(start, "%Y-%m-%d").date()
    e = datetime.strptime(end, "%Y-%m-%d").date()
    if e < today:
        return "completed"
    if s <= today <= e:
        return "live"
    return "upcoming"


def week_start(start: str) -> str:
    d = datetime.strptime(start, "%Y-%m-%d").date()
    return (d.fromordinal(d.toordinal() - d.weekday())).isoformat()


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: python scripts/load_wiki.py YEAR [YEAR ...]")
    for arg in sys.argv[1:]:
        year = int(arg)
        path = ROOT / "data" / f"wiki_calendar_{year}.json"
        catalog = json.loads(path.read_text(encoding="utf-8"))
        n = 0
        for t in catalog["tournaments"]:
            sb.table("tournaments").upsert(
                {
                    "external_id": t["external_id"],
                    "name": t["name"],
                    "tour": t["tour"],
                    "category": t["category"],
                    "surface": t.get("surface"),
                    "start_date": t["start_date"],
                    "end_date": t["end_date"],
                    "week_start": week_start(t["start_date"]),
                    "status": status_for(t["start_date"], t["end_date"]),
                },
                on_conflict="external_id",
            ).execute()
            n += 1
        print(f"{year}: upserted {n}")


if __name__ == "__main__":
    main()
