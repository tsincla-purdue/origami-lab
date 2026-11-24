# Origami Lab — Working Guidance

Our purpose and design commitments are described in [docs/PRINCIPLES.md](docs/PRINCIPLES.md). Consult that document when making material changes to the folding model, interaction design, exploration system, or AI agent interface.

## Architectural commitments

- The paper's material identity, connectedness, fronts/backs, layers, creases, and feasible motion are part of the model, not merely rendering details.
- Human gestures and eventual model-generated actions must use one semantic action path through the geometric solver, validator, and experiment recorder. Do not give the AI a privileged geometry-editing bypass.
- Prefer physical intentions and ordinary manipulation to requiring users to supply crease coordinates, polygon IDs, or specialized commands. Advanced controls can remain for diagnostics.
- Treat ambiguous interpretations explicitly. Do not silently move more paper than the user selected unless the interface explains and displays the inferred admissible packet.
- Preserve accepted/rejected/unverified distinctions under documented physical assumptions. Never weaken checks solely to obtain a desired endpoint.
- Preserve reproducible action histories and support continuation by either a human or an agent.

## Evidence before claiming a feature works

For a failure reported through actual interaction, first reproduce it with a browser-level regression that fails on the old code. Test the natural pointer or touch workflow, not solely an API-level equivalent or a manually chosen dropdown. Inspect changed material geometry, layer order, and replay, not just dispatched events or successful builds.

Keep core examples in the regression suite: dog-ear then half-fold, upper-flap fold with lower layer fixed, unfold retaining a crease, pin-and-bring-point-to-line, and editable Undo. Report what remains unsupported or unverified. Do not claim that automated tests substitute for human tactile testing.

Work in reviewable pull requests; do not merge automatically.
