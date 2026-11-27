"""Run after npm run build. Fixture production uses the app; adjudication does not."""
from collections import Counter
from copy import deepcopy
import json
import math
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from scripts.audit_experiment import AREA, DIST, area, audit, dot, edges, frame, polygon, transform, unit, world  # noqa: E402
from silhouette import coverage, hull, uncovered_edge  # noqa: E402

HEXAGON = ROOT / "tests/fixtures/perfect-imperfect-hexagon.json"


def export_fixtures():
    result = subprocess.run(["node", "tests/audit/export_fixtures.mjs"], cwd=ROOT, check=True, capture_output=True)
    return json.loads(result.stdout)


def project(matrix, p):
    x, y = p
    return (matrix["a"] * x + matrix["c"] * y + matrix["e"],
            matrix["b"] * x + matrix["d"] * y + matrix["f"])


class HumanHexagon(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.experiment = json.loads(HEXAGON.read_text(encoding="utf-8"))

    def test_every_operation_passes_the_independent_material_checks(self):
        report = audit(self.experiment)
        failures = [entry for entry in report["operations"] if entry["status"] == "fail"]
        self.assertFalse(failures, f"First material soundness failure: {failures[:1]}")
        rows = report["operations"]
        self.assertEqual([row["step"] for row in rows], list(range(38)))
        self.assertTrue(all(row["checked"] for row in rows), rows)

    def test_silhouette_metrics(self):
        final = self.experiment["final"]
        self.assertEqual(len(final["facets"]), 15)
        root3 = math.sqrt(3)
        side, target_area = root3 / 6, root3 / 8
        reference = [(1/2, root3/2), (3/4, 5*root3/12), (3/4, root3/4),
                     (1/2, root3/6), (1/4, root3/4), (1/4, 5*root3/12)]
        intrinsic = [[transform(facet, p) for p in polygon(facet)] for facet in final["facets"]]
        displayed = [[world(final, facet, p) for p in polygon(facet)] for facet in final["facets"]]
        sign, offset = frame(final)
        self.assertEqual((sign, offset), (-1, 1.125))
        display_reference = [(sign * x + offset, y) for x, y in reference]
        for name, polygons, expected in (("intrinsic", intrinsic, reference), ("displayed", displayed, display_reference)):
            with self.subTest(frame=name):
                # A support polygon alone would hide gaps. Verify coverage of
                # both its boundary and its interior before using its corners.
                boundary = hull(polygons)
                self.assertEqual(len(boundary), 6, boundary)
                perimeter_gap = max(uncovered_edge(polygons, *edge) for edge in edges(boundary))
                _, _, hull_gap, hull_outside = coverage(polygons, boundary)
                self.assertLessEqual(perimeter_gap, DIST)
                self.assertLessEqual(hull_gap + hull_outside, AREA)
                cyclic = [ordered[i:] + ordered[:i]
                          for ordered in (expected, expected[::-1]) for i in range(6)]
                vertex_error = min(max(math.dist(a, b) for a, b in zip(boundary, match)) for match in cyclic)
                side_error = max(abs(math.dist(a, b) - side) for a, b in edges(boundary))
                angles = [math.degrees(math.acos(dot(unit(p, boundary[i-1]), unit(p, boundary[(i+1) % 6]))))
                          for i, p in enumerate(boundary)]
                angle_error = max(abs(angle - 120) for angle in angles)
                union_area, _, missing, outside = coverage(polygons, expected)
                print(f"Hexagon {name}: max vertex error {vertex_error:.3g}, max side error {side_error:.3g}, "
                      f"max angle error {angle_error:.3g}°, union area {union_area:.16g}, "
                      f"missing {missing:.3g}, excess {outside:.3g}.")
                self.assertLessEqual(vertex_error, DIST)
                self.assertLessEqual(side_error, 2 * DIST)
                self.assertLessEqual(angle_error, math.degrees(4 * DIST / side))
                self.assertLessEqual(abs(union_area - target_area), AREA)
                self.assertLessEqual(missing + outside, AREA)

        # Show the cost of comparing screen coordinates to the intrinsic target directly.
        _, _, missing, outside = coverage(displayed, reference)
        print(f"Displayed versus untransformed reference: center shift {offset - 1:.3g} in x, "
              f"symmetric-difference area {missing + outside:.12g}.")

    def test_coverage_detects_a_hole_and_protrusion_even_when_areas_agree(self):
        def rectangle(x, y, w, h):
            return [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]

        square = rectangle(0, 0, 2, 2)
        ring = [rectangle(0, 0, 2, .5), rectangle(0, 1.5, 2, .5),
                rectangle(0, .5, .5, 1), rectangle(1.5, .5, .5, 1)]
        self.assertEqual(hull(ring), square)
        self.assertEqual(coverage(ring, square), (3, 4, 1, 0))
        self.assertEqual(coverage([*ring, ring[0], rectangle(2, 0, .5, 2)], square), (4, 4, 1, 1))


class IndependentAudit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixtures = export_fixtures()

    def assert_structural(self, experiment):
        report = audit(experiment)
        self.assertNotEqual(report["status"], "fail", report)
        return report

    def test_actual_exports_and_evidence_gaps(self):
        names = ("initial", "half", "dogEar", "lifo", "doubleFlip", "reverse", "marks",
                 "o1", "o2", "o3", "o4", "equilateral", "golden", "rejected")
        for name in names:
            with self.subTest(name=name):
                report = self.assert_structural(self.fixtures[name])
                self.assertEqual(len(report["operations"]), len(self.fixtures[name]["attempts"]) + 2)
        self.assertEqual(audit(self.fixtures["initial"])["status"], "pass")
        for name in ("o1", "o2", "equilateral", "golden"):
            report = audit(self.fixtures[name])["operations"][-2]
            self.assertEqual(report["status"], "inconclusive")
            self.assertIn("intent is absent", " ".join(report["notes"]))
        for name in ("o3", "o4"):
            report = audit(self.fixtures[name])["operations"][-2]
            self.assertTrue(any("geometric constraint" in check for check in report["checked"]))
        self.assertEqual(self.fixtures["doubleFlip"]["final"], self.fixtures["half"]["final"])

    def test_independent_construction_oracles(self):
        def landing(name, p):
            facets = self.fixtures[name]["final"]["facets"]
            top = max(facets, key=lambda facet: facet["z"])
            return project(top["transform"], p)

        def compare(actual, expected):
            self.assertLess(math.dist(actual, expected), 1e-12)

        compare(landing("o1", (0, 1)), (.4, .2))
        compare(landing("o2", (1, 0)), (0, 1))
        compare(landing("o3", (.6, 0)), (0, .6))
        compare(landing("o4", (.2, 0)), (1.3, 0))
        equilateral = landing("equilateral", (1, 0))
        compare(equilateral, (.5, math.sqrt(3) / 2))
        for base in ((0, 0), (1, 0)):
            self.assertAlmostEqual(math.dist(equilateral, base), 1, places=12)

        golden = landing("golden", (.75, 0))
        compare(golden, (.25, (1 + math.sqrt(5)) / 4))
        self.assertAlmostEqual(math.dist(golden, (.25, .25)), math.sqrt(5) / 4, places=12)

    def test_synthetic_upper_three_pentagon_vertices(self):
        # Standalone analytic reference, unrelated to any saved user session or claimed five-vertex export.
        center, r = (.5, .5), .4
        dx = r * math.sqrt(10 + 2 * math.sqrt(5)) / 4
        dy = r * (math.sqrt(5) - 1) / 4
        upper_three = [(center[0] - dx, center[1] + dy), (center[0], center[1] + r),
                       (center[0] + dx, center[1] + dy)]
        chords = [math.dist(a, b) for a, b in zip(upper_three, upper_three[1:])]
        for p in upper_three:
            self.assertAlmostEqual(math.dist(center, p), r, places=12)
        self.assertAlmostEqual(chords[0], chords[1], places=12)
        self.assertAlmostEqual(chords[0], 2 * r * math.sin(math.pi / 5), places=12)

    def test_tampered_histories(self):
        def altered(name, index=-1):
            experiment = deepcopy(self.fixtures[name])
            return experiment, experiment["attempts"][index]

        cases = {}
        for tamper in ("transform", "polygon", "dropped", "duplicated", "layer", "axis", "crease", "wrong-status"):
            data, entry = altered("half")
            facets = entry["state"]["facets"]
            if tamper == "transform":
                facets[1]["transform"]["e"] += .05  # A rigid translation still breaks the hinge.
            elif tamper == "polygon":
                facets[0]["poly"][0]["x"] -= .05
            elif tamper == "dropped":
                facets.pop()
            elif tamper == "duplicated":
                facets.append(deepcopy(facets[0]))
            elif tamper == "layer":
                facets[0]["z"], facets[1]["z"] = facets[1]["z"], facets[0]["z"]
            elif tamper == "axis":
                for point in entry["move"]["line"]:
                    point[0] += .05
            elif tamper == "crease":
                entry["state"]["creases"][0]["b"]["y"] -= .1
            else:
                entry["validation"]["status"] = "rejected"
            data["final"] = deepcopy(entry["state"])
            cases[tamper] = data

        data, entry = altered("marks", index=4)
        bad_point = {"x": .37, "y": .37}
        entry["move"]["point"] = bad_point
        entry["state"]["marks"][0]["point"] = bad_point
        cases["invalid mark intersection"] = data
        data, entry = altered("marks", index=-1)
        entry["move"]["markAttempt"] = 999
        cases["invalid mark removal"] = data
        data, entry = altered("lifo")
        entry["move"]["foldAttempt"] = 2
        cases["invalid unfold"] = data
        data, entry = altered("doubleFlip")
        entry["move"]["axisX"] += .1
        cases["invalid flip"] = data
        data, entry = altered("reverse", index=1)
        entry["state"]["pose"]["backOffset"] += .2
        entry["state"]["pose"]["materialAxisX"] += .1
        cases["forged global pose"] = data
        data, entry = altered("o4")
        entry["move"]["intent"]["pin"]["x"] += .1
        cases["false perpendicular intent"] = data
        data, _ = altered("half")
        data["final"]["nextId"] += 1
        cases["final mismatch"] = data

        for name, data in cases.items():
            with self.subTest(tamper=name):
                self.assertEqual(audit(data)["status"], "fail")

    def test_cli_exit_status(self):
        data = deepcopy(self.fixtures["half"])
        for code in (0, 1):
            result = subprocess.run([sys.executable, "scripts/audit_experiment.py", "-"], input=json.dumps(data),
                                    text=True, cwd=ROOT, capture_output=True)
            self.assertEqual(result.returncode, code, result.stderr)
            self.assertEqual(json.loads(result.stdout)["status"], ("inconclusive", "fail")[code])
            data["attempts"][0]["state"]["facets"][0]["transform"]["a"] = 2
        for malformed in ('{"version":1,"version":2}', '{"x":1e999}', '{"x":NaN}'):
            result = subprocess.run([sys.executable, "scripts/audit_experiment.py", "-"], input=malformed,
                                    text=True, cwd=ROOT, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(json.loads(result.stdout)["status"], "fail")

    def test_seeded_metamorphic_recordings(self):
        counts = Counter()
        false_accepts, asymmetries, failures = [], [], []
        max_drift = 0.0
        for pair_number, (original, reversed_axis) in enumerate(self.fixtures["seeded"], 1):
            for experiment in (original, reversed_axis):
                report = audit(experiment)
                for entry, outcome in zip(experiment["attempts"], report["operations"][1:-1]):
                    if "operation" not in entry:
                        counts[entry["validation"]["status"]] += 1
                        if entry["validation"]["status"] == "accepted" and outcome["status"] == "fail":
                            false_accepts.append((pair_number, outcome))
                if report["status"] == "fail":
                    failures.append((pair_number, report))
            pairs = zip(original["attempts"], reversed_axis["attempts"])
            for step, (a, b) in enumerate(pairs, 1):
                if a["validation"]["status"] != b["validation"]["status"]:
                    asymmetries.append((pair_number, step))
                    continue
                ac = {f["id"]: f for f in a["state"]["facets"]}
                bc = {f["id"]: f for f in b["state"]["facets"]}
                self.assertEqual(ac.keys(), bc.keys())
                for ident, facet in ac.items():
                    peer = bc[ident]
                    self.assertEqual(facet["z"], peer["z"])
                    corners = [(p["x"], p["y"]) for p in facet["poly"]]
                    other_corners = [(p["x"], p["y"]) for p in peer["poly"]]
                    self.assertEqual(len(corners), len(other_corners))
                    for p in corners:
                        self.assertLess(min(math.dist(p, q) for q in other_corners), 1e-8)
                        max_drift = max(max_drift, math.dist(project(facet["transform"], p), project(peer["transform"], p)))
        print(f"Seed 0x0a16, 32 axis/reversed-axis pairs: {dict(counts)}. "
              f"Detected structural false accepts: {len(false_accepts)}.")
        print(f"Numerical sensitivity: {len(asymmetries)} verdict changes on axis reversal, "
              f"{max_drift:.3g} maximum intrinsic landing drift.")
        self.assertGreater(counts["accepted"], 150)
        self.assertEqual(false_accepts, [])
        self.assertEqual(failures, [])
        self.assertEqual(asymmetries, [])
        self.assertLess(max_drift, 1e-8)

    def test_upper_strip_under_axis_reversal_turnover_and_small_perturbations(self):
        for offset, histories in zip((-1, 0, 1), self.fixtures["packetSymmetries"], strict=True):
            width = 3 / 16 + offset / 1024
            original = histories[0]["attempts"][-2]["state"]
            for experiment in histories:
                with self.subTest(width=width, move=experiment["attempts"][-2]["move"]):
                    self.assert_structural(experiment)
                    before, swing, opened = experiment["attempts"][-3:]
                    self.assertEqual(swing["validation"]["code"], "packet-fold")
                    self.assertEqual(opened["move"]["foldAttempt"], len(experiment["attempts"]) - 1)
                    final = swing["state"]
                    # These dyadic cuts yield exactly the same intrinsic geometry in all three frames.
                    self.assertEqual(final["facets"], original["facets"])
                    base, upper, tip = final["facets"]
                    self.assertEqual([base["id"], upper["id"], tip["id"]], [0, 1, 2])
                    self.assertEqual(area(polygon(tip)), width)
                    self.assertEqual(transform(tip, (1, 1)), (2 * width, 1))
                    self.assertEqual(opened["state"]["facets"], before["state"]["facets"])
                    self.assertEqual(opened["state"]["marks"], before["state"]["marks"])
                    self.assertEqual(opened["state"]["creases"], final["creases"])
                    self.assertEqual(len(final["creases"]), len(before["state"]["creases"]) + 1)

    def test_numerical_threshold_sweep(self):
        near = [("rejected", "no-op"), ("unverified", "near-axis"), ("unverified", "near-axis"),
                ("accepted", "simple-fold"), ("accepted", "simple-fold")]
        slivers = [("rejected", "no-op"), ("rejected", "no-op"), ("accepted", "simple-fold")]
        for group, expected in (("near", near), ("slivers", slivers)):
            results = []
            for experiment in self.fixtures[group]:
                self.assert_structural(experiment)
                v = experiment["attempts"][-1]["validation"]
                results.append((v["status"], v["code"]))
            print(f"Threshold sweep {group}: {results}")
            self.assertEqual(results, expected)


if __name__ == "__main__":
    unittest.main()
