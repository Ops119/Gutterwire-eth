"""CLI: python -m gutterwire {run,scan,digest,status,chats}"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from . import db
from .config import get_settings
from .pipeline import build, digest_due, run_hourly, scan, send_digest


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="gutterwire")
    parser.add_argument("--env", default=".env", help="path to .env file")
    parser.add_argument("-v", "--verbose", action="store_true")
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run", help="hourly job: scan, then send the digest if 48h have passed")
    sub.add_parser("scan", help="discover, filter, check and review, without sending")
    d = sub.add_parser("digest", help="send a digest now")
    d.add_argument("--dry-run", action="store_true", help="print the digest instead of sending")
    sub.add_parser("status", help="show pipeline counts and today's API budget use")
    sub.add_parser("chats", help="list chats that have messaged the bot, to find TELEGRAM_CHAT_ID")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    # Never log full request URLs: the Telegram token is part of the URL path.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    settings = get_settings(args.env)
    app = build(settings)

    if args.cmd == "run":
        out = run_hourly(app)
        out.get("digest", {}).pop("text", None)
        print(json.dumps(out, indent=1))
    elif args.cmd == "scan":
        print(json.dumps(scan(app), indent=1))
    elif args.cmd == "digest":
        if args.dry_run:
            app.telegram = None
        out = send_digest(app)
        print(out.pop("text"))
        print(json.dumps(out, indent=1), file=sys.stderr)
    elif args.cmd == "status":
        rows = app.conn.execute("SELECT status, COUNT(*) n FROM candidates GROUP BY status").fetchall()
        print("candidates:", {r["status"]: r["n"] for r in rows})
        print("calls:", app.conn.execute("SELECT COUNT(*) FROM calls").fetchone()[0])
        last = db.kv_get(app.conn, "last_digest_at")
        print("last digest:", db.iso(float(last)) if last else "never")
        print("budget today:", app.budget.report())
        print("gemini:", "on" if app.gemini else "off (template notes)",
              "| coinmarketcap:", "on" if app.cmc else "off",
              "| telegram:", "ready" if app.telegram and settings.telegram_chat_id else "not configured")
    elif args.cmd == "chats":
        if not app.telegram:
            print("Set TELEGRAM_BOT_TOKEN first.", file=sys.stderr)
            return 1
        for chat in app.telegram.recent_chats():
            print(chat["id"], chat.get("type"), chat.get("title") or chat.get("username") or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
