#!/bin/sh
# Redis of the SCADA pair: repair an AOF that a hard stop left broken, then start Redis.
#
# A power loss (or a frozen host) leaves the tail of the open incr AOF unwritten (zeros):
# Redis then stops at once with "Bad file format reading the append only file", on both
# servers at the same time (seen twice on the VMs, 2026-10-26). Only that tail is lost
# anyway; cutting it is what redis-check-aof --fix does. Before that the AOF folder is
# copied, and a cut larger than AOF_MAX_CUT bytes is not done: that is not a torn tail,
# a human looks at it (the handbook has the steps).
#
#   entrypoint: ["/bin/sh", "/usr/local/bin/redis-start.sh"]   (the image's command follows)
set -u

DIR=/data/appendonlydir
MAX_CUT=${AOF_MAX_CUT:-16777216}
KEEP=${AOF_KEEP_BACKUPS:-3}

say() { echo "aof-repair: $*"; }

manifest=$(ls "$DIR"/*.manifest 2>/dev/null | head -n 1)
if [ -n "$manifest" ] && ! out=$(redis-check-aof "$manifest" 2>&1); then
	say "the AOF does not load:"
	printf '%s\n' "$out" | tail -n 5
	cut=$(printf '%s\n' "$out" | sed -n 's/.*diff=\([0-9][0-9]*\).*/\1/p' | tail -n 1)
	if [ -z "$cut" ] || [ "$cut" -gt "$MAX_CUT" ]; then
		say "NOT repaired: ${cut:-an unknown number of} bytes would be cut (limit $MAX_CUT); repair it by hand" >&2
		exit 1
	fi
	backup="/data/appendonlydir.bak-$(date -u +%Y%m%dT%H%M%SZ)"
	cp -a "$DIR" "$backup" || { say "no backup, no repair" >&2; exit 1; }
	if ! echo y | redis-check-aof --fix "$manifest" >/dev/null 2>&1 || ! redis-check-aof "$manifest" >/dev/null 2>&1; then
		say "the repair failed; the AOF is as it was in $backup" >&2
		exit 1
	fi
	say "cut $cut broken bytes at the end; the AOF before the cut is in $backup"
	# keep the newest KEEP backups: each holds the whole AOF
	ls -d /data/appendonlydir.bak-* 2>/dev/null | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do
		rm -rf "$old"
	done
fi

exec docker-entrypoint.sh "$@"
