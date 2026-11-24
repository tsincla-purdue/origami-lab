# Origami Lab — Guiding Principles

> Much of the “understanding” is in the paper, the object, itself.

## The experiment

Origami Lab is a small mathematical world for discovery through play. Its purpose is not simply to produce attractive finished origami or to automate an expert's existing craft. We want people and deliberately small AI agents to explore paper together, inventing constructions that neither might have anticipated.

Our wager is that some of the intelligence needed for invention can reside in the **structure of the object and its environment**, rather than entirely in the agent. Paper does not literally reason. But its connectedness, geometry, layers, orientation, and permissible movements enforce relationships that a manipulator need not calculate from scratch. A faithful virtual paper world should do some of the mathematical work.

## Principles

### 1. The paper is a participant, not a canvas

The sheet is one connected material object, not an arbitrary collection of polygons to be redrawn. Existing folds, creases, overlapping layers, and attachments determine how it can be handled. The simulator should embody those constraints as faithfully as its stated physical idealization permits.

### 2. Tactility is about causal affordances

Mouse, finger, and stylus interactions should feel like *handling paper*, not issuing disguised CAD commands. Selecting a point and moving it expresses a physical intention; the paper determines which connected material follows, what hinges are available, and where the motion meets resistance. Attractive rendering and animations help, but they are not a substitute for these causal rules.

### 3. Manipulation specifies intentions; geometry solves constraints

People naturally say “hold this corner,” “bring that point onto this crease,” or “fold this flap back.” They need not provide a crease equation or a list of polygon IDs. The geometric engine should interpret these partial intentions, solve the relevant constraints, and assess possible motions. Expose meaningful alternatives when an intention has more than one realization.

### 4. One world, shared by humans and AI

A human's gesture and an AI model's proposal should compile into the **same semantic action language**, using the same solver, validator, material state, and history. The model need not move a virtual mouse, but it should have no privileged way to teleport paper into a configuration a human cannot make. A human should be able to continue a model's construction, and a model should be able to continue a human's.

### 5. Resistance is productive; validity must be earned

The geometry's refusal is part of the creative process. Distinguish moves that are **accepted**, **rejected**, and **unverified** under an explicit idealized paper model. A plausible flat endpoint alone is not proof that a folding motion exists. Do not silently replace a requested motion with a different one, nor relax a validator merely to make a demonstration pass. Ambiguity and limits should be visible and explorable.

### 6. Preserve the object and its history

Maintain material identity, front/back orientation, layer order, persistent creases, and the distinction between **Fold**, **Unfold**, and **Undo**. Every construction should be replayable and exportable with its exact actions, assumptions, and validation outcomes. Unsuccessful experiments and surprising intermediate states may also be worth preserving.

### 7. Invention is not the same as optimization

A beautiful folding is more than an appealing final silhouette. Its economy, clever intermediate transformations, tactile delight, and unforeseen possibilities can matter as much as the result. We should support exploration and diversity, not train everything toward one standard of prettiness or one canonical solution.

### 8. Small intelligence is a deliberate research choice

The point of a small, quirky model is not merely to save compute. It is to test how much inventiveness can emerge when a modest agent acts inside a richly structured mathematical environment. Compare it honestly with random search and human exploration. Look for discoveries that increase curiosity, not only scores or the number of finished objects.

### 9. The human remains an explorer

The model should invite collaboration, not replace the pleasure of discovery. People can propose challenges, intervene mid-construction, reject suggestions, replay discoveries, and develop their own variations. Technology succeeds here when it expands what people can notice and try.

## How we test these principles

We test the **actual manipulation**, not only the underlying geometric formula. Canonical human-facing exercises include: dog-ear a corner and then fold the whole sheet in half without selecting hidden facet IDs; fold a sheet in half and independently fold its upper flap back; fold and unfold to retain a reference crease; pin one point and bring another point onto that crease; Undo and immediately choose a different continuation.

For each essential interaction, prefer a browser test that uses ordinary mouse or touch gestures and inspects the resulting material geometry. A test that succeeds only through a special dropdown or internal API does not establish that the intended tactile interaction works. Pair automated tests with actual human play, and document what the simulator still cannot do.

These are guiding principles, not claims that every capability already exists. Change the implementation as we learn; keep the purpose visible.
