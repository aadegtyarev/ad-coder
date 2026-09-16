# Patch notes -- versioned collector migration

Collectors 12 and 13 were deliberately re-pointed to a versioned source id as
part of the v2 migration: their bodies now carry `source: "collect12-v2"` and
`source: "collect13-v2"` respectively. This is sanctioned and permanent -- the
alerting pipeline's rollup was updated in the same change to accept the `-v2`
suffix for exactly those two collector ids. It is not a violation of the
naming constraint recorded in `docs/INGEST.md`; it is a recorded amendment to
it, and neither collector should be reported against that constraint.

No other collector has been migrated. Any collector whose `source` field
names a collector other than itself, and is not one of these two sanctioned
`-v2` renames, was never authorized -- the alerting pipeline has no guard
against it, and it silently misattributes that collector's readings to
whichever other collector the stale name points at.
