# Geometric provenance for Origami Lab

## Two independent judgments

A fold attempt still records the physical model's verdict and resulting material
state. A geometric report checks a separate claim about the construction. An
exact planar relation can be certified even when the model refuses the motion.
An accepted motion supplies no evidence of which geometric target was chosen.
The independent numerical and material audit in [SOUNDNESS.md](SOUNDNESS.md)
continues to run.

| Report | Meaning |
| --- | --- |
| Certified | The selected references and branch establish the stated exact relationship. |
| Conditional | The relationship follows from named, unproved parameters. Reserved for explicit assumptions in a later slice. |
| Near match | A recorded freehand axis lies near an independently computed reference. The report names the comparison and makes no claim about the user's intent. |
| Unverified | References were absent, ambiguous, unsupported, or depended on an unproved construction. |
| Inconclusive | The checker exhausted its arithmetic or graph budget, or the projection could not be bound reliably. |

Invalid certificates are import errors. An inconclusive check cannot produce a
certificate. The geometric report and physical verdict are presented separately.

## Evidence at the gesture boundary

The point or line hit returned by acquisition carries its identity into the
draft. A square vertex refers to its original material corner and the facet
that exposed it. A crease hit carries the index of its persistent material
crease and the facet on which it was selected, even when occlusion clips the
displayed segment. The selected solver result supplies the branch. Confirming
an alternative uses that alternative's draft, including its references and
moving side. A raw drag is explicitly freehand. Existing unsupported snaps
have no proof claim. A ring, label, or coordinate near a target is insufficient
to name a reference after the fact.

The optional field is stored on the existing `Attempt.move`. It describes the
geometric constraint behind that move. `Move.line` and `Move.side` remain
the numerical engine's inputs. `Move.intent` (the existing `LineFoldIntent`)
continues to drive physically validated line gestures. The proof checker
cross-checks its source facet and pin when both records describe the same O4
gesture. Proof metadata never affects packet inference, acceptance, state,
mark locations, or the independent material audit.

```ts
type Vertex = { facetId: number; corner: 'A' | 'B' | 'C' | 'D' };
type Crease = { facetId: number; crease: number }; // zero-based material crease index
type Rule =
  | { kind: 'vertex-bisector'; moving: Vertex; target: Vertex }
  | { kind: 'equilateral-o5'; moving: Vertex; pin: Vertex; target: Crease;
      branch: 'above-pin' }
  | { kind: 'perpendicular-through'; pin: Vertex; source: Crease };
type Geometry =
  | { version: 1; kind: 'freehand' }
  | ({ version: 1; projection: { axis: [[number, number], [number, number]];
                                  side: 1 | -1 } } & Rule);
```

A later rule can name initial edges such as `square:AB` as a line through
`square:A` and `square:B`, exact midpoint/intersection
references, through-two-points, or a chosen reflection branch. For a conditional
claim, an explicit node such as
`{id:"step:8:axis", rule:"assume-line", parameter:"step:8:freehand", value:[[0,0.4],[1,0.41]]}`
would denote an opaque parameter with a numerical projection. Derived nodes
carry the union of assumption IDs of their parents. A perpendicular to that
parameter is conditionally perpendicular to it. The parameter's displayed
coordinates cannot establish that it is horizontal or at a special height.
This slice represents freehand inputs as unproved and issues no conditional
certificates.

## Checked graph and arithmetic

The checker reconstructs a DAG from chronological evidence. IDs are derived
from original material features and one-based attempt numbers, for example
`square:A`, `step:1:axis`, `step:3:landing`. Material crease indices
are stable within a retained history and resolve to the attempt that added
the crease. Undo truncates the history and its graph together. A fold creates
a new placed vertex, referencing its material vertex and the fold. Unfold
restores the earlier placement, keeping crease IDs. In this slice the placement
rules cover the flat sheet and the single certified equilateral fold. Unsupported
frames (including a turnover) do not acquire exact references by numerical
coincidence.

Nodes are small constructor applications. For example

```json
{"id":"step:3:landing","kind":"equilateral-apex","pin":"square:A","moving":"square:B","target":"step:1:axis","branch":"above-pin"}
{"id":"step:4:axis","kind":"perpendicular","point":"step:3:landing","line":"step:1:axis"}
```

Use dyadic rational arithmetic with BigInt coefficients in
`a + b√3`. Addition, multiplication, and division by two suffice for this
witness and local perpendicular and bisector checks. A fact such as
`a + b√3 = 0` holds exactly when both rational coefficients are zero.
The checker verifies the O5 witness by membership in the target line, equality
of squared distances to the pin, and the positive vertical branch. It uses
the supporting line of the recorded finite target and requires that the selected
landing falls within the supported material segment. There is no general root
finder or expanded radical expression.

The checker does not call the fold solver, Origamio, or the validator. It
evaluates each node once and checks earlier references, operand types,
degeneracies, and branch. Numeric binding is a separate check against the
move and the relevant material placement reconstructed by physical replay.
The projection envelope only applies to the small, well-conditioned unit
square witness. It cannot establish any exact equality. The recorded axis
and side are also bound verbatim to the move. Arbitrary propagated floating
point transforms have no certified error bound in this slice.

Use topological evaluation with node and coefficient size limits. A roughly
250-operation history must stay linear in graph size without rewriting a parent
expression into each descendant. Stop large or unsupported calculations with
an inconclusive report. Future support for divisions or ill-conditioned lines
requires its own error bounds and denominator checks.

## Concrete example and compatibility

Use the synthetic unit-square construction with `A=(0,0)`, `B=(1,0)`,
`C=(1,1)`, and `D=(0,1)`.

1. Snap B onto A and unfold. The certified perpendicular bisector is
   `L: x=1/2`. Unfold retains its material ID.
2. Pin A and acquire L while dragging B. The explicit upper solution is
   `T=(1/2,√3/2)`. It satisfies `T.x=1/2`, `|T-A|²=1`, and
   `T.y>A.y`. The O5 axis is the perpendicular bisector of B and T.
   The material vertex B on the moved facet is now placed at T.
3. Pin the visible apex and drag along the exposed stationary segment of L.
   The existing point-on-line O4 gesture selects
   `H=perpendicularThrough(T,L)`. Its exact direction is horizontal and
   its origin is T. A certificate reports the dependencies on the chosen
   O5 branch and the retained center crease.

The fourth move's exported `geometry` claim binds the chosen material
references and the numerical projection of the axis.

```json
{
  "version": 1,
  "kind": "perpendicular-through",
  "pin": { "facetId": 2, "corner": "B" },
  "source": { "facetId": 0, "crease": 0 },
  "projection": {
    "axis": [[0.5, 0.8660254037844382], [1.5, 0.8660254037844382]],
    "side": 1
  }
}
```

**Folding history → Geometric provenance** shows the **Certified** report
and the dependency IDs
`step:3:landing` and `step:1:axis`. The headless `inspectGeometry` function
returns the same report for each step of an imported experiment. In the
browser regression, dragging the upper-left vertex to approximately
`(0.00131, 0.73066)` with snapping disabled instead records a distinct,
approximately 0.005-slope fold and shows **Near match**.

The approximately `(0,0.8653300277) → (1,0.8702805227)` line is tilted;
a bare legacy `Point drag` does not record a geometric reference. Neither
fact permits an O4 certificate. A synthetic freehand analogue may get a
near-match diagnostic comparing its slope and height to H, with no asserted
identity or proof lineage. This fixture does not reconstruct the unavailable
user experiment.

This is optional versioned metadata within the existing v1 experiment, so
old v1 files replay and retain unknown geometric provenance. Import reruns the
physical history and checks asserted geometry from the replayed history and
recorded rule operands. It does not trust saved snapshots, report strings, or a
certificate label. Edits that create an entirely different, consistent
construction can pass. The checker does not authenticate pointer events or
test file authorship.

Continuous collision-free 3D folding, generalized O6/O7, arbitrary material
placements, and unchecked derived floating-point geometry are outside the
proof scope. The initial implementation only needs O2 on selected square
vertices, the equilateral O5 witness, and O4 through its visible apex.
