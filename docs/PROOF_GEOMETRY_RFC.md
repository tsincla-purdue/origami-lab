# Geometric provenance for Origami Lab

## Two independent judgments

A fold attempt still records the physical model's verdict and resulting material
state. Captured intent records the references and relationship the user chose.
A geometric report checks that intent. An exact planar relation can be certified even when the model refuses the motion.
An accepted motion supplies no evidence of which geometric target was chosen.
The independent numerical and material audit in [SOUNDNESS.md](SOUNDNESS.md)
continues to run.

| Report | Meaning |
| --- | --- |
| Certified | The selected references and branch establish the stated exact relationship. |
| Conditional | The relationship follows from named material-line assumptions. |
| Near match | A recorded freehand axis lies near an independently computed reference. The report names the comparison and makes no claim about the user's intent. |
| Unverified | References were absent, ambiguous, unsupported, or depended on an unproved construction. |
| Inconclusive | The checker exhausted its arithmetic or graph budget, or the projection could not be bound reliably. |
| Invalid | Recorded references are malformed or contradict the numerical operation. |

Invalid evidence is visible in a recorded gesture and rejected on import.
Unverified and inconclusive evidence stays with the replayed experiment.
Only a successful symbolic check produces a certificate.

## Evidence at the gesture boundary

The point or line hit returned by acquisition carries its identity into the
draft. A square vertex refers to its original material corner and the facet
that exposed it. A crease hit carries the index of its persistent material
crease and the facet on which it was selected, even when occlusion clips the
displayed segment. The selected solver result supplies the branch. Confirming
an alternative uses that alternative's draft, including its references and
moving side. A raw drag is explicitly freehand. Unsupported snaps retain their
selected references. A ring, label, or coordinate near a target is insufficient
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
type Point = { x: number; y: number };
type SelectedPoint = { point: Point; material?: {
  facetId: number; point: Point; corner?: Vertex['corner']; markId?: number; edgeMidpoint?: number;
} };
type SelectedLine = { facetId: number; line: { a: Point; b: Point }; crease?: number };
type Intent =
  | { kind: 'vertex-bisector'; moving: Vertex; target: Vertex }
  | { kind: 'equilateral-o5'; moving: Vertex; pin: Vertex; target: Crease;
      branch: 'above-pin' }
  | { kind: 'perpendicular-through'; pin: Vertex; source: Crease }
  | { kind: 'point-on-line'; moving: SelectedPoint; pin: SelectedPoint; target: SelectedLine;
      landing: Point; branch: 'before-foot' | 'at-foot' | 'after-foot' }
  | { kind: 'point-to-point'; moving: SelectedPoint; target: SelectedPoint }
  | { kind: 'through-points'; points: SelectedPoint[] }
  | { kind: 'marked-perpendicular'; moving: SelectedPoint; through: SelectedPoint;
      source: SelectedLine; landing: Point }
  | { kind: 'line-fold'; source: SelectedLine; target?: SelectedLine; pin?: SelectedPoint };
type Geometry =
  | { version: 1; kind: 'freehand' }
  | ({ version: 1; projection: { axis: [[number, number], [number, number]];
                                  side: 1 | -1 } } & Intent);
```

Point-on-line captures store the selected points in displayed coordinates
with their material facet and coordinates where available. They store the
target facet, acquired segment, and material crease ID when the target is a
crease. The chosen landing and its branch relative to the perpendicular foot
come from the selected preview, including when the user picks an alternative.
Point-to-point, crease-through-point, and line-fold gestures also retain the
references used by their previews. The earlier `equilateral-o5` record still
imports. The checker applies the same witness to a new point-on-line record
when its references have the needed proofs.

Mark creation also saves the two acquired material lines as an optional
`sources` pair on `Attempt.move`. An operand is either `{edge: index}` for the
original square boundary or `{crease: index}` for a retained crease. Import
checks that the pair actually produces the saved material point. Older marks
retain their positions and their missing source identities stay unknown.

## Material construction graph

The checker reconstructs a directed acyclic graph from chronological evidence.
Initial vertices, edges and edge midpoints have stable square IDs. Attempts
introduce axes and other constructed objects under one-based step IDs.
A retained crease index names its originating material axis where replay can
bind it to the selected facet's cut. Marks reference those axes or square
edges through line intersections. Undo truncates the graph with the history.

The graph supports lines through two points, intersections, midpoints,
perpendiculars, perpendicular bisectors and reflections. It also evaluates the
chosen branch of a circle-line intersection. Each rule names prior objects.
Evaluation is lazy and memoized, so using a prior result never expands its
construction into a second expression tree.

The exact kernel uses reduced BigInt values of the form
`(a + b√3) / d`. Division rationalizes the denominator. Circle-line
branches currently support square roots of rational squares and three times
rational squares. Other roots, exhausted node or coefficient budgets, and
unreliable numerical projections produce **Inconclusive**. Parallel lines
lack a unique exact intersection.

A freehand material segment introduces a named parameter for its recorded
binary64 coordinates. An accepted crease without supported symbolic lineage
can similarly enter as an explicitly unproved parameter. Descendants
inherit their operand assumptions. The numerical parameter can be evaluated
exactly, and its absolute orientation remains unproved. For a two-mark
conditional perpendicular, both marks must reference the supporting line in
their definitions. A nearby numeric point alone supplies no exact incidence.

## From the graph to a fold

Dragging a mark through the neighborhood of its reflected landing can acquire
a perpendicular through a second mark on one unambiguous exposed crease
segment. The pointer must pass the second mark. Ordinary landings and other
snaps remain candidates and the existing acquisition and release rules
resolve the competition.

The checker establishes incidence of both material points on the selected
line. It constructs the perpendicular through the second point, reflects the
first, and verifies the midpoint and perpendicular identities. The gesture
evaluates that construction and projects the axis and landing into the
selected facet using the current display isometry. The resulting proposal
goes through the material validator. Geometry can still be previewed from a
numerically identified pair when its exact lineage is inconclusive.

Folds, unfolds and turnover carry their own numerical placements. Material
construction IDs and coordinates persist through them. The certified
same-facet relationships are invariant under that facet's rigid placement.
Projection checks bind the derived proposal to the recorded numerical move.
This slice does not certify arbitrary constructions spanning separate
material placements. It retains the earlier synthetic apex path for the
specific cross-facet gesture exercised by that fixture.

## Checking boundary

Import first verifies physical replay. The symbolic checker then rebuilds
the graph from acquired references, checking operand types, incidence,
branch selection, and numerical projection. A tolerance establishes that
the projected construction matches the physical move within the numerical
envelope. Exact mathematical equality is checked in the graph. Saved
verdicts supply no authority for either check.

Reference or projection contradictions are import errors. Unsupported or
inconclusive evidence stays in the file. The optional `maxDerivedNodes`
setting bounds symbolic work for a particular inspection or import, so a
later check can revisit the same evidence with a larger budget. The
independent [material audit](SOUNDNESS.md) continues to check numerical sheet
invariants and has its own verdict.

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

The representative browser tests also draw a crease through opposite edge
midpoints, mark intersections on an oblique freehand crease, turn the sheet
over, and construct a conditional perpendicular through one of the marks.
They check that a slightly tilted freehand continuation remains a numerical
near match. These tests use synthetic gestures. The original hexagon
history and its later operations were unavailable for replay.

The proof scope is planar. It excludes continuous collision-free 3D
foldability, generalized O6/O7, and unsupported algebraic roots or placements.
