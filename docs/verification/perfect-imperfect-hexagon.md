# Perfect imperfect hexagon benchmark

The fixture preserves the actual 36-operation playground export from
November 25, 2026. The checked-in JSON is a semantic copy of
`origami-experiment (4).json`. The original upload's SHA-256 was
`5c9f1ce3100cfb7d99aa990b74bde2723c764513b414e3dc177add6c25719af6`.
The regression compares semantic data across replay and re-export.
[Canonical fixture](../../tests/fixtures/perfect-imperfect-hexagon.json)

## Rerun

```sh
npm test -- tests/perfect-imperfect-hexagon.test.mjs
python3 -B tests/audit/test_audit.py HumanHexagon
ORIGAMI_REPORT_HEXAGON=1 npm test -- tests/perfect-imperfect-hexagon.test.mjs --silent=false
```

The first command replays and compares every snapshot and operation, including
recorded packets, layer order, marks, mark sources, and turnover. The second
runs the independent material audit and prints silhouette measurements.
The third prints the symbolic checker's verdict, dependencies, assumptions,
and recorded operands for each of the 36 steps. Both suites run in PR CI.

## Physical history and numerical silhouette

The model accepts 17 folds, 10 unfolds, 6 marks, and 3 flips. The replay retains
all 15 final facets and 6 material marks. The independent material audit finds
no failures. Its overall **Inconclusive** verdict reflects the limits of its
continuous-motion and clearance checks. A failed replay reports the first
failing prefix and the applicable engine, snapshot, or evidence error. An
independent material failure reports its first affected step.
[Soundness contract](../SOUNDNESS.md)

The silhouette test sweeps the union of all projected facets, counting overlaps
once. It checks coverage of the support polygon's perimeter and interior
before comparing its six exterior corners in cyclic order. The vertex tolerance
is `1e-8` in unit-sheet coordinates. The side and angle tolerances scale with
that distance tolerance, and the area tolerance is `1e-8` square units.

In the intrinsic frame the boundary matches the six reference vertices in
the issue. The last turnover, at step 34, records a reversed pose with a
back offset of `1.125`. In displayed coordinates the hexagon is centered at
`x = 0.625`, a shift of `+0.125` from the intrinsic reference. The test compares
all displayed facets with the pose-transformed reference and separately reports
the direct comparison with the untransformed coordinates. The latter has
symmetric-difference area approximately `0.135316469341` square units.

In both correctly aligned frames, the largest corner deviation is about
`3.51e-16`, the largest side-length deviation is about `4.44e-16`, and the
largest angle deviation from 120° is about `9.95e-14` degrees. The union area is
approximately `0.216506350946109` with an aligned symmetric difference below
`8e-17` square units on the test run. These are numerical measurements of
the folded silhouette.

## Symbolic coverage

The current checker certifies steps 1, 3, and 26. Eight relationships are
conditional on recorded assumptions, and steps 14 and 16 are inconclusive.
Ten other construction steps are unverified. The remaining thirteen
unverified rows are unfolds and flips with no asserted fold constraint.
The report contains no invalid or quarantined entries.

The first missing proof dependency is step 4. Its two selected points on
facet 2 have material coordinates but lack recorded construction identities.
The crease introduced by that fold is therefore an unproved reference.
For example, the mark at step 11 is a conditional intersection using the
certified step 1 axis and the unproved crease from step 4. All six marks
retain their recorded, explicit source-line pairs.

Later gaps include separate facet placements at steps 33 and 35, unsupported
line alignment at steps 20 and 22, a projected value the checker cannot
reliably evaluate at step 14, and a root outside its supported exact
arithmetic at step 16. The complete symbolic derivation of the hexagon
remains open. [Issue #24](https://github.com/tsincla-purdue/origami-lab/issues/24)
