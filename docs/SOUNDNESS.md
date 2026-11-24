# Origami Lab soundness contract

This audit covers exported `origami-lab` v1 experiments. It concerns the finite
model of one zero-thickness square and single-axis flat folds. It samples
saved constructions and deliberately altered records.

## Status and scope

- **Accepted** means the application executed a supported operation on a
  verified state. For a fold, the model splits material on one axis and
  turns the selected half-plane or packet through 180 degrees. It checks
  the flat result for area, rigid facet placement, material hinges, layer
  placement, and the restrictions of its local clearance model. Flip and
  Unfold use the recorded global pose and certified fold history. Mark and
  Remove mark change annotations in original sheet coordinates.
- **Rejected** means the application found an invalid request or a violation
  of a supported model rule. The snapshot remains unchanged. For example,
  missing material on the moving side and a torn hinge are reasons for rejection.
- **Unverified** means the application could not certify the request in its
  supported model. The snapshot remains unchanged. Examples include a vertex
  in the near-axis band, an unsupported stack operation, and insufficient
  hinge-clearance evidence.

An accepted flat endpoint and local hinge or packet clearance do not establish
a globally collision-free continuous 3D motion. That question would require
evidence along the trajectory. Thickness, self-contact during intermediate
angles, arbitrary compound folds, and the behavior of real sheets remain
outside this contract.

## Running the independent checker

```sh
python3 scripts/audit_experiment.py saved-experiment.json
```

Use `-` as the file name for standard input. The checker uses only the
Python standard library and reads the supplied history. It does not import
Origami Lab, Origamio, or their geometry. The application serializer supplies
test inputs. Snapshot geometry is evidence subjected to independent tests
rather than an instruction to the checker to reproduce the app's folding
algorithm.

The report lists each step, the checks it performed, and any remaining gaps.
`pass` means the reported scope was supported by the data and passed its
checks. `fail` means invalid input or a detected invariant violation and
returns exit code 1. `inconclusive` means the checked hypotheses passed
within tolerance while other claims remain unresolved. It returns exit
code 0, as does `pass`. Consequently a structurally valid fold history will
usually report `inconclusive` because the file cannot supply motion
certificates. A refusal audit only checks that the state did not change.
A clean report has no bearing on provenance or the authenticity of the
recorded interaction.

Run the independent fixture suite with
`npm run build && python3 -B tests/audit/test_audit.py`. PR CI also passes
JSON downloaded inside the browser regressions to the checker. The Vitest
geometry tests that import Origamio and the application's
`importExperiment` replay are useful regression checks. Both share the
engine under test.

## Soundness ledger

| Invariant | Check and evidence | Limit |
| --- | --- | --- |
| Material partition and area | The checker verifies finite, convex, consistently wound polygons within the original unit square. A separating-axis test checks interiors, and summed polygon areas check coverage. It also checks unique, allocated facet IDs. Positive exports and drops, duplicates, and vertex tampering exercise these checks. | Tolerance-scale overlaps and gaps can escape detection. This is a bounded numerical partition check. |
| Rigid placements and material adjacency | The checker tests both orthogonal matrix columns, determinant magnitude, and all facet vertex-pair distances. It finds partial shared edges independently and checks both endpoints agree in world coordinates. It checks edge-connected adjacency. A tampered rigid translation exercises the hinge check even though it preserves area and distances. | Contacts below the distance tolerance may be indistinguishable from point contacts. State checks concern the saved endpoint. |
| Parent refinement and moving side | Each child belongs to a pre-fold material facet. Child areas recover the parent, new IDs match the split, and each new transform agrees at three noncollinear samples with the former transform or its reflection across the saved axis. The old half-plane, move side and selected material determine which children may move. The test suite changes the recorded fold axis and checks that this fails with the geometry unchanged. | No integration over the fold path. Exceptions such as legacy clearance decisions are not independently certified. |
| Layer order | Endpoint facets with overlapping interiors require distinct ranks. The checker preserves relative stationary ranks, reverses moving ranks and checks exposed top/bottom placement in the current pose. Swapped ranks fail. | The Origamio-based validator checks local hinge blocking, buried packets, and related clearance conditions. The checker does not prove global swept-volume clearance. |
| Creases and marks | Old material-coordinate crease records persist. A new crease must match a shared boundary of a split parent. Marks persist through turns, folds and unfolds. At creation the checker checks finite segment intersection against creases and the original boundary, then tracks the operation's mark ID and deletion. Negative fixtures change both a mark request and its snapshot to an invalid location. | Source proximity and intersection parallelism are tolerance-limited. The saved file does not establish which pixel the user selected or whether an alternate gesture interpretation was available. |
| Flip, Unfold and final | The checker independently derives the displayed bounding-box center and effective reflection; the intrinsic mesh and annotations must be identical. Two same-axis turns give the original orientation and placement within tolerance. For Unfold, the checker derives the stack of still-active folds, compares the endpoint mesh, and checks the prior mesh is restored with current creases, marks, ID allocator and global pose. Paired-turn, reverse-side folds, LIFO and interleaved annotation exports exercise this. The final snapshot must equal the last state. | A turnover about a different center can shift the paper's position. Unfold retains the current global pose. History certifies the discrete inverse, with continuous collision clearance unresolved. |
| Fold intent | O3 alignment and O4 perpendicular intents serialize a source facet and line. The checker verifies the supporting segment belongs to that facet, the grab lies on the moving side, and the saved axis satisfies the line alignment or fixed perpendicular constraint. A false pin fails. | O1, O2 and ordinary O5 generally save the resolved axis without their input references. The checker explicitly leaves these intent claims inconclusive. Independent analytic checks on known fixture inputs can verify their outcomes. |
| Refusal and continuous motion | The checker verifies an unchanged snapshot on `rejected` or `unverified` operations. The current validator decides supported local motion and provides the refusal reason. | The checker does not independently prove the reason, general 3D foldability, or freedom from false rejections. |

## Numerical policy and evidence

Both the runtime and this audit use IEEE-754 binary64. Constructed points
are approximations to their mathematical values. Origamio's geometry
epsilon is `1e-9`, its polygon area cutoff is `1e-10`, and its
near-axis classification extends to `1e-7` in unit-sheet coordinates.
The checker uses absolute `1e-8` distance, area and normalized rigidity
tests. Its separating-axis overlap requires positive penetration larger
than the distance tolerance along every tested normal. It uses that
tolerance for material contacts and notes small features (area under
`1e-10` or an edge at most `1e-8`), short axes, near-axis vertices just
outside the audit distance band, and near-parallel mark lines. These
cases can be numerically inconclusive. Evidence of a violation beyond
tolerance fails. The checker does not substitute symbolic algebra or
derive error bounds for arbitrary long sequences. Fixture identities
are tested more tightly (`1e-12`) where their conditioning allows it.

- The seed `0x0a16` sample found **zero structural false accepts** in
  32 pairs of seven-fold attempts, including turns and unfolds. Across both
  axis directions the producer recorded 260 accepted folds and 188 rejected
  folds. The tests compare these histories without counting unchecked motion
  claims as passes. This sample gives no estimate of real-sheet safety.
- To measure **numerical sensitivity**, the suite swaps each axis's endpoints
  and reverses its side. The sample had zero verdict changes and maximum
  intrinsic landing drift of `1.02e-15`. Near the square edge, offsets
  `1e-10`, `2e-9`, `5e-8`, `2e-7`, and `1e-5` produce rejection, two
  unverified near-axis results, and two accepted results, respectively.
  A small triangle cut with endpoints at `(s, 0)` and `(0, s)` is rejected
  at `s = 1e-6` and `3e-6`, and accepted at `2e-5`. These reproduce
  tolerance effects rather than fabricated invariant violations. Run
  `python3 -B tests/audit/test_audit.py` after building to reproduce them.
- Independent analytic oracles check the exported equilateral outcome
  `(1/2, sqrt(3)/2)` and the golden-ratio construction with height
  `(1 + sqrt(5))/4`. No exported user pentagon history was present in the
  audited checkout. The pentagon test is an explicitly synthetic analytic
  fixture for three upper vertices, checking equal radii and adjacent chords.
  It does not establish a five-vertex construction or verify the user's
  particular marks. A later user export can be checked with the same CLI.
