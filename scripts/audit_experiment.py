#!/usr/bin/env python3
"""Read-only structural and geometric audit of Origami Lab v1 JSON."""
import argparse
from itertools import combinations
import json
import math
import sys

DIST = 1e-8
AREA = 1e-8
RIGID = 1e-8
NEAR_AXIS = 1e-7
SMALL_AREA = 1e-10
MARK_IDENTITY = 1e-9
SQUARE = [(0, 0), (1, 0), (1, 1), (0, 1)]
BASIS = SQUARE[:3]
MATRIX = ("a", "b", "c", "d", "e", "f")


class Violation(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Violation(message)


def number(value):
    require(type(value) in (int, float) and math.isfinite(value), "expected a finite real number")
    return value


def integer(value):
    require(type(value) is int and value >= 0, "expected a nonnegative integer")
    return value


def point(value):
    return number(value["x"]), number(value["y"])


def sub(a, b):
    return a[0] - b[0], a[1] - b[1]


def dot(a, b):
    return a[0] * b[0] + a[1] * b[1]


def cross(a, b):
    return a[0] * b[1] - a[1] * b[0]


def unit(a, b):
    dx, dy = sub(b, a)
    size = math.hypot(dx, dy)
    require(size > 0 and math.isfinite(size), "degenerate line")
    return dx / size, dy / size


def edges(poly):
    return zip(poly, poly[1:] + poly[:1])


def area(poly):
    origin = poly[0]
    return math.fsum(cross(sub(a, origin), sub(b, origin)) for a, b in edges(poly)) / 2


def near(a, b):
    return math.dist(a, b) <= DIST


def signed(line, p):
    a, b = line
    return cross(unit(a, b), sub(p, a))


def on_segment(line, p):
    a, b = line
    if a == b:
        return False
    t = dot(unit(a, b), sub(p, a))
    return abs(signed(line, p)) <= DIST and -DIST <= t <= math.dist(a, b) + DIST


def contains(poly, p):
    return all(signed(edge, p) >= -DIST for edge in edges(poly))


def overlap(a, b):
    """Convex separating-axis test. Shared boundary has no interior overlap."""
    for poly in (a, b):
        for start, end in edges(poly):
            dx, dy = unit(start, end)
            normal = (-dy, dx)
            first = [dot(normal, p) for p in a]
            second = [dot(normal, p) for p in b]
            if min(max(first), max(second)) - max(min(first), min(second)) <= DIST:
                return False
    return True


def shared_edges(a, b):
    """Find positive-length material contacts, including partial edge contacts."""
    for start, end in edges(a):
        along = unit(start, end)
        for p, q in edges(b):
            if max(abs(cross(along, sub(v, start))) for v in (p, q)) > DIST:
                continue
            lo, hi = sorted(dot(along, sub(v, start)) for v in (p, q))
            lo, hi = max(0, lo), min(math.dist(start, end), hi)
            if hi - lo > DIST:
                yield tuple((start[0] + along[0] * t, start[1] + along[1] * t) for t in (lo, hi))


def transform(facet, p):
    a, b, c, d, e, f = (facet["transform"][key] for key in MATRIX)
    x, y = p
    return a * x + c * y + e, b * x + d * y + f


def frame(state):
    pose = state.get("pose")
    if pose is None:
        return 1, 0
    return (-1, pose["backOffset"]) if pose["reversed"] else (1, pose["frontOffset"])


def world(state, facet, p):
    x, y = transform(facet, p)
    sign, offset = frame(state)
    return sign * x + offset, y


def polygon(facet):
    poly = facet["poly"]
    require(isinstance(poly, list), "expected a material vertex list")
    return [point(p) for p in poly]


def ccw(poly):
    return poly if area(poly) > 0 else poly[::-1]


def state_checks(state, notes):
    require(all(number(state[name]) == 1 for name in ("width", "height", "size")), "sheet is not the v1 unit square")
    integer(state["foldCount"])
    next_id = integer(state["nextId"])
    pose = state.get("pose")
    if "pose" in state:
        require(type(pose["reversed"]) is bool, "invalid global orientation")
        front, back, axis = (number(pose[k]) for k in ("frontOffset", "backOffset", "materialAxisX"))
        require(abs(back - front - 2 * axis) <= DIST, "inconsistent turnover offsets")
    facets = state["facets"]
    require(isinstance(facets, list) and 0 < len(facets) <= 128, "invalid facet count")
    ids, ranks, material, folded = set(), [], [], []
    small = False
    for facet in facets:
        ident = integer(facet["id"])
        require(ident not in ids and ident < next_id, "duplicate or unallocated facet ID")
        ids.add(ident)
        ranks.append(integer(facet["z"]))
        poly = polygon(facet)
        require(len(poly) >= 3 and len(set(poly)) == len(poly), "degenerate material polygon")
        require(all(contains(SQUARE, p) for p in poly), "material polygon outside original sheet")
        require(area(poly) > 0, "non-positive material polygon area or inconsistent winding")
        require(all(contains(poly, p) for p in poly), "nonconvex material polygon")
        small |= area(poly) < SMALL_AREA or min(math.dist(*edge) for edge in edges(poly)) <= DIST
        a, b, c, d, _, _ = (number(facet["transform"][key]) for key in MATRIX)
        require(max(abs(math.hypot(a, b) - 1), abs(math.hypot(c, d) - 1),
                    abs(a * c + b * d), abs(abs(a * d - b * c) - 1)) <= RIGID,
                "facet transform is not rigid")
        image = [world(state, facet, p) for p in poly]
        for i, j in combinations(range(len(poly)), 2):
            require(abs(math.dist(poly[i], poly[j]) - math.dist(image[i], image[j])) <= DIST,
                    "facet transform changes a vertex-pair distance")
        material.append(poly)
        folded.append(ccw(image))
    require(set(ranks) == set(range(len(set(ranks)))), "noncompact layer ranks")
    require(abs(math.fsum(map(area, material)) - 1) <= AREA, "material area does not equal sheet area")

    adjacency = [set() for _ in facets]
    for i, j in combinations(range(len(facets)), 2):
        require(not overlap(material[i], material[j]), "material facet interiors overlap")
        if ranks[i] == ranks[j]:
            require(not overlap(folded[i], folded[j]), "overlapping folded facets share a layer rank")
        for contact in shared_edges(material[i], material[j]):
            adjacency[i].add(j)
            adjacency[j].add(i)
            require(all(near(world(state, facets[i], p), world(state, facets[j], p)) for p in contact),
                    "shared material hinge endpoints disagree in folded space")
    reached, pending = {0}, [0]
    while pending:
        neighbors = adjacency[pending.pop()] - reached
        reached.update(neighbors)
        pending.extend(neighbors)
    if len(reached) != len(facets) and small:
        notes.append("Small facet edges make edge-connected adjacency inconclusive.")
    else:
        require(len(reached) == len(facets), "material facets are not edge-connected")
    if small:
        notes.append("At least one facet is below the audit's small-feature scale.")

    creases = state["creases"]
    require(isinstance(creases, list), "expected a material crease list")
    for crease in creases:
        a, b = point(crease["a"]), point(crease["b"])
        require(a != b and contains(SQUARE, a) and contains(SQUARE, b), "invalid material crease")
        require("angle" not in crease, "nonflat crease angle is outside audited v1 operations")
    marks = state.get("marks", [])
    require(isinstance(marks, list), "expected a material mark list")
    seen = {}
    for mark in marks:
        ident, position = integer(mark["id"]), point(mark["point"])
        require(ident > 0 and ident not in seen and contains(SQUARE, position), "invalid material mark")
        gaps = [math.dist(position, other) for other in seen.values()]
        require(all(gap > MARK_IDENTITY for gap in gaps), "duplicate material mark position")
        if any(gap <= DIST for gap in gaps):
            notes.append("Material marks are closer than the audit distance tolerance.")
        seen[ident] = position


def same_except(before, after, *exceptions):
    return ({k: v for k, v in before.items() if k not in exceptions}
            == {k: v for k, v in after.items() if k not in exceptions})


def reflected(line, p):
    a, b = line
    dx, dy = unit(a, b)
    distance = cross((dx, dy), sub(p, a))
    return p[0] + 2 * dy * distance, p[1] - 2 * dx * distance


def line_reference(before, reference):
    ident = integer(reference["facetId"])
    facet = next((f for f in before["facets"] if f["id"] == ident), None)
    require(facet is not None, "line intent references a missing facet")
    line = point(reference["line"]["a"]), point(reference["line"]["b"])
    unit(*line)
    poly = polygon(facet)
    image = ccw([world(before, facet, p) for p in poly])
    creases = [(point(c["a"]), point(c["b"])) for c in before["creases"]]
    supporting = list(edges(image)) + [tuple(world(before, facet, p) for p in crease) for crease in creases]
    require(all(contains(image, p) for p in line)
            and any(all(on_segment(segment, p) for p in line) for segment in supporting),
            "line intent is not on the referenced material edge or crease")
    return ident, line


def check_intent(before, move, selected, axis, side, notes):
    intent = move.get("intent")
    if intent is None:
        notes.append("Geometric intent is absent. The recorded axis is audited, but O1/O2/O5 references are unverifiable.")
        return
    ident, source = line_reference(before, intent["source"])
    moving = point(intent["moving"])
    require(ident in selected and on_segment(source, moving) and side * signed(axis, moving) > DIST,
            "line intent's grab is not on the moving part of its named material")
    kind = intent["kind"]
    if kind == "align-lines":
        _, target = line_reference(before, intent["target"])
        require(all(abs(signed(target, reflected(axis, p))) <= DIST for p in source),
                "recorded axis does not align the intent's supporting lines")
        ends = [p for p in source if side * signed(axis, p) >= 0]
        if len(ends) == 1:
            d, e = (signed(axis, p) for p in source)
            t = d / (d - e)
            ends.append(tuple(a + (b - a) * t for a, b in zip(*source)))
        along = unit(*target)
        coords = [dot(along, sub(reflected(axis, p), target[0])) for p in ends]
        require(len(coords) == 2 and min(max(coords), math.dist(*target)) - max(min(coords), 0) > 0,
                "reflected moving segment misses the finite target")
    elif kind in ("perpendicular", "perpendicular-point"):
        pin = point(intent["pin"])
        require(abs(signed(axis, pin)) <= DIST and abs(dot(unit(*axis), unit(*source))) <= RIGID,
                "recorded axis violates its perpendicular or fixed pin constraint")
        landing = reflected(axis, moving)
        require(abs(signed(source, landing)) <= DIST, "reflected grab leaves the supporting line")
        if kind == "perpendicular":
            require(on_segment(source, landing), "line drag lands beyond the finite source")
    else:
        notes.append(f"Unrecognized geometric intent {kind!r}.")


def fold_checks(before, after, move, notes):
    require(same_except(before, after, "facets", "creases", "nextId", "foldCount"),
            "fold changed annotations, dimensions or global pose")
    require(after["foldCount"] == before["foldCount"] + 1, "incorrect fold count")
    require(not any(key in move for key in ("angle", "region", "window")) and not move.get("also")
            and move.get("layers", "all") == "all", "accepted fold outside the audited single-axis contract")
    axis = tuple(tuple(number(x) for x in p) for p in move["line"])
    require(len(axis) == 2 and all(len(p) == 2 for p in axis), "invalid recorded fold axis")
    unit(*axis)
    side = move["side"]
    require(type(side) is int and side in (-1, 1), "invalid recorded fold side")
    top = move.get("placement", "top")
    require(top in ("top", "bottom"), "invalid accepted layer placement")
    prior = {f["id"]: (f, polygon(f)) for f in before["facets"]}
    selected = set(prior)
    if "packet" in move:
        ids = [integer(i) for i in move["packet"]["facetIds"]]
        selected = set(ids)
        require(selected and len(ids) == len(selected) and selected <= prior.keys() and not move.get("attached"),
                "invalid accepted material packet")
    check_intent(before, move, selected, axis, side, notes)
    if math.dist(*axis) <= DIST:
        notes.append("The recorded axis has a very short defining segment.")
    if any(DIST < abs(signed(axis, world(before, f, p))) <= NEAR_AXIS
           for f, poly in prior.values() for p in poly):
        notes.append("A pre-fold vertex lies close to the recorded axis.")

    sign, _ = frame(before)
    groups = {ident: [] for ident in prior}
    rank = {False: {}, True: {}}
    for facet in after["facets"]:
        poly = polygon(facet)
        parents = [(f, old) for f, old in prior.values() if all(contains(old, p) for p in poly)]
        require(len(parents) == 1, "new facet has no unique material parent")
        parent, _ = parents[0]
        ident = parent["id"]
        actual = [world(after, facet, p) for p in BASIS]
        original = [world(before, parent, p) for p in BASIS]
        stays = all(near(p, q) for p, q in zip(actual, original))
        moves = all(near(p, reflected(axis, q)) for p, q in zip(actual, original))
        require(stays != moves, "facet transform is neither unchanged nor reflection across the recorded axis")
        heights = [side * signed(axis, world(before, parent, p)) for p in poly]
        if ident in selected:
            require(min(heights) >= -DIST if moves else max(heights) <= DIST, "piece is on the wrong fold side")
        else:
            require(stays, "unselected material moved")
        groups[ident].append((facet, poly, moves))
        old, new = sign * parent["z"], sign * facet["z"]
        require(rank[moves].setdefault(old, new) == new, "equal source ranks split within a packet")

    for moves, ranks in rank.items():
        order = [new for _, new in sorted(ranks.items())]
        require(all((a > b if moves else a < b) for a, b in zip(order, order[1:])), "packet layer order changed incorrectly")
    stationary, moving = rank[False].values(), rank[True].values()
    require(rank[False] and rank[True], "fold lacks a fixed or moving packet")
    require(max(stationary) < min(moving) if top == "top" else max(moving) < min(stationary),
            "moving packet landed on the wrong side of the stack")

    new_ids, chords = [], []
    for ident, children in groups.items():
        require(1 <= len(children) <= 2, "material parent was dropped or over-refined")
        require(abs(math.fsum(area(poly) for _, poly, _ in children) - area(prior[ident][1])) <= AREA,
                "child facets do not partition their parent area")
        if len(children) == 1:
            require(children[0][0]["id"] == ident, "unpartitioned facet lost its identity")
            continue
        fixed, mobile = sorted(children, key=lambda child: child[2])
        require(not fixed[2] and mobile[2] and fixed[0]["id"] == ident, "split facet IDs or motion are inconsistent")
        new_ids.append(mobile[0]["id"])
        contact = [p for edge in shared_edges(fixed[1], mobile[1]) for p in edge]
        require(contact, "split pieces share no material crease")
        chords.append(max(combinations(contact, 2), key=lambda pair: math.dist(*pair)))
    require(sorted(new_ids) == list(range(before["nextId"], before["nextId"] + len(new_ids)))
            and after["nextId"] == before["nextId"] + len(new_ids), "incorrect new facet ID allocation")
    old_creases = before["creases"]
    require(after["creases"][:len(old_creases)] == old_creases, "historical material creases changed")
    for crease in after["creases"][len(old_creases):]:
        a, b = point(crease["a"]), point(crease["b"])
        match = next((i for i, (p, q) in enumerate(chords)
                      if (near(a, p) and near(b, q)) or (near(a, q) and near(b, p))), None)
        require(match is not None, "new crease does not match a material split")
        chords.pop(match)
    require(not chords, "missing new material crease")
    notes.append("Continuous 3D motion and local clearance are not independently certified.")


def annotation_checks(step, operation, before, after, move, notes):
    require(same_except(before, after, "marks"), "mark operation changed the paper")
    marks = before.get("marks", [])
    if operation == "remove-mark":
        ident = integer(move["markAttempt"])
        expected = [mark for mark in marks if mark["id"] != ident]
        require(len(expected) == len(marks) - 1 and after.get("marks", []) == expected, "incorrect mark removal")
        return
    p = point(move["point"])
    require(after.get("marks") == marks + [{"id": step, "point": move["point"]}], "mark identity or position changed")
    creases = [(point(c["a"]), point(c["b"])) for c in before["creases"]]
    involved = [line for line in creases if on_segment(line, p)]
    contacts = involved + [line for line in edges(SQUARE) if on_segment(line, p)]
    angles = [abs(cross(unit(*a), unit(*b))) for a, b in combinations(contacts, 2)]
    require(involved and angles and max(angles) > 0, "mark is not a crease intersection")
    if max(angles) <= NEAR_AXIS:
        notes.append("Near-parallel lines make the mark intersection numerically inconclusive.")


def flip_checks(before, after, move):
    require(same_except(before, after, "pose"), "flip modified intrinsic material")
    positions = [world(before, f, p)[0] for f in before["facets"] for p in polygon(f)]
    center = (min(positions) + max(positions)) / 2
    require(abs(number(move["axisX"]) - center) <= DIST, "turnover axis is not the displayed center")
    old_sign, old_offset = frame(before)
    new_sign, new_offset = frame(after)
    require(new_sign == -old_sign and abs(old_offset + new_offset - 2 * center) <= DIST,
            "flip does not reverse the visible orientation around the recorded axis")
    if "pose" in after:
        require(abs(after["pose"]["materialAxisX"] - old_sign * (center - old_offset)) <= DIST,
                "stored material turnover center disagrees with the displayed axis")


def audit(data):
    operations = []
    errors = (KeyError, TypeError, ValueError, OverflowError, AttributeError, IndexError)

    def check(step, operation, run):
        notes, checked = [], []
        try:
            run(notes, checked)
            status = "inconclusive" if notes else "pass"
        except errors as error:
            status = "fail"
            notes.append(str(error))
        operations.append({"step": step, "operation": operation, "status": status, "checked": checked, "notes": notes})

    def initial(notes, checked):
        require(data["format"] == "origami-lab" and type(data["version"]) is int and data["version"] == 1,
                "expected an origami-lab v1 export")
        require(isinstance(data["attempts"], list) and len(data["attempts"]) <= 256, "invalid attempt list")
        state = data["initial"]
        state_checks(state, notes)
        require(len(state["facets"]) == 1 and state["foldCount"] == 0 and state["nextId"] == 1 and
                not state["creases"] and not state.get("marks") and "pose" not in state, "invalid initial metadata")
        facet = state["facets"][0]
        require(facet["id"] == 0 and all(near(transform(facet, p), p) for p in BASIS), "initial paper is not flat")
        checked.append("Initial unit-square partition and identity transform.")

    check(0, "initial", initial)
    if operations[-1]["status"] != "fail":
        active = []
        before = data["initial"]
        for step, attempt in enumerate(data["attempts"], 1):
            operation = attempt.get("operation", "fold") if isinstance(attempt, dict) else "invalid"

            def transition(notes, checked):
                after, move, verdict = attempt["state"], attempt["move"], attempt["validation"]["status"]
                require(isinstance(move, dict), "expected a recorded move object")
                state_checks(after, notes)
                checked.append("Snapshot material partition, rigidity, hinge consistency, layer ranks and annotations.")
                require(verdict in ("accepted", "rejected", "unverified"), "unknown recorded status")
                if operation == "fold":
                    if verdict == "accepted":
                        fold_checks(before, after, move, notes)
                        checked.append("Parent refinement, side and reflection, layer placement, and crease persistence.")
                        if move.get("intent", {}).get("kind") in ("align-lines", "perpendicular", "perpendicular-point"):
                            checked.append("Recorded material line references and geometric constraint.")
                        active.append((step, before, after))
                    else:
                        require(before == after, "rejected or unverified fold changed the state")
                        checked.append("Unchanged state.")
                        notes.append("The unchanged state is verified. The reason for refusal is not independently certified.")
                else:
                    require(verdict == "accepted", "non-fold operation has an invalid status")
                    if operation == "unfold":
                        require(active and integer(move["foldAttempt"]) == active[-1][0], "unfold does not target the last active fold")
                        _, saved, endpoint = active[-1]
                        changes = ("creases", "marks", "pose", "nextId")
                        require(same_except(endpoint, before, *changes) and same_except(saved, after, *changes)
                                and all(before.get(k) == after.get(k) for k in changes),
                                "unfold did not restore the certified mesh or retain history")
                        active.pop()
                        checked.append("Last active fold, restored mesh, and retained creases, marks and global pose.")
                        notes.append("The saved fold was reversed in history. Continuous 3D clearance is not certified.")
                    elif operation == "flip":
                        flip_checks(before, after, move)
                        checked.append("Unchanged material and mirrored global pose with reversed visible ordering.")
                    elif operation in ("mark", "remove-mark"):
                        annotation_checks(step, operation, before, after, move, notes)
                        checked.append("Material unchanged and recorded mark identity and position.")
                    else:
                        raise Violation("unknown operation")

            check(step, operation, transition)
            before = attempt.get("state") if isinstance(attempt, dict) else None

        def final(_notes, checked):
            require(data["final"] == before, "final does not match the last state")
            checked.append("Final state matches the last snapshot.")

        check(len(data["attempts"]) + 1, "final", final)
    statuses = {entry["status"] for entry in operations}
    status = "fail" if "fail" in statuses else "inconclusive" if "inconclusive" in statuses else "pass"
    return {"status": status, "operations": operations}


def unique_keys(pairs):
    result = dict(pairs)
    require(len(result) == len(pairs), "duplicate JSON object key")
    return result


def finite_float(text):
    return number(float(text))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", help="experiment JSON path, or - for stdin")
    args = parser.parse_args()
    try:
        if args.file == "-":
            data = json.load(sys.stdin, object_pairs_hook=unique_keys, parse_float=finite_float, parse_constant=finite_float)
        else:
            with open(args.file, encoding="utf-8") as stream:
                data = json.load(stream, object_pairs_hook=unique_keys, parse_float=finite_float, parse_constant=finite_float)
        report = audit(data)
    except (ValueError, OSError, RecursionError, OverflowError) as error:
        report = {"status": "fail", "operations": [], "error": str(error)}
    print(json.dumps(report, indent=2))
    return int(report["status"] == "fail")


if __name__ == "__main__":
    sys.exit(main())
