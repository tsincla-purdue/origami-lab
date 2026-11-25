"""Numerical coverage of a union of displayed convex facets."""
from itertools import combinations
import math

from scripts.audit_experiment import DIST, cross, dot, edges, sub, unit


def merged_length(spans):
    length = 0.0
    end = -math.inf
    for low, high in sorted(spans):
        length += max(0, high - max(low, end))
        end = max(end, high)
    return length


def interval_at(poly, x):
    crossings = [
        a[1] + (x - a[0]) / (b[0] - a[0]) * (b[1] - a[1])
        for a, b in edges(poly) if min(a[0], b[0]) < x < max(a[0], b[0])
    ]
    if crossings:
        return min(crossings), max(crossings)


def coverage(polygons, reference):
    """Return union area, reference area, missing area, and excess area."""
    all_polygons = [*polygons, reference]
    sweep_edges = [(a, b) for poly in all_polygons for a, b in edges(poly) if a[0] != b[0]]
    events = {p[0] for poly in all_polygons for p in poly}
    for (a, b), (c, d) in combinations(sweep_edges, 2):
        r, s = sub(b, a), sub(d, c)
        determinant = cross(r, s)
        if determinant:
            offset = sub(c, a)
            t, u = cross(offset, s) / determinant, cross(offset, r) / determinant
            if 0 < t < 1 and 0 < u < 1:
                events.add(a[0] + t * r[0])

    strips = []
    xs = sorted(events)
    for left, right in zip(xs, xs[1:]):
        # Between consecutive edge crossings and vertices, the vertical
        # interval endpoints retain their order and their lengths are linear.
        x = left + (right - left) / 2
        if not left < x < right:
            continue
        spans = [span for poly in polygons if (span := interval_at(poly, x))]
        length = merged_length(spans)
        target = interval_at(reference, x)
        target_length = common = 0.0
        if target:
            low, high = target
            target_length = high - low
            common = merged_length(
                (max(a, low), min(b, high)) for a, b in spans if a < high and b > low
            )
        width = right - left
        strips.append((width * length, width * target_length,
                       width * max(0, target_length - common), width * max(0, length - common)))
    return tuple(math.fsum(column) for column in zip(*strips))


def hull(polygons):
    """Candidate exterior support polygon, ignoring turns within DIST."""
    points = sorted({p for poly in polygons for p in poly})

    def chain(points):
        result = []
        for p in points:
            while len(result) >= 2:
                a, b = result[-2:]
                if cross(sub(b, a), sub(p, a)) > DIST * math.dist(a, p):
                    break
                result.pop()
            result.append(p)
        return result

    return chain(points)[:-1] + chain(reversed(points))[:-1]


def uncovered_edge(polygons, start, end):
    """Length of a candidate exterior edge with no supporting facet edge."""
    along = unit(start, end)
    extent = math.dist(start, end)
    spans = []
    for poly in polygons:
        for a, b in edges(poly):
            offsets = [sub(p, start) for p in (a, b)]
            if max(abs(cross(along, offset)) for offset in offsets) > DIST:
                continue
            low, high = sorted(dot(along, offset) for offset in offsets)
            low, high = max(0, low), min(extent, high)
            if low < high:
                spans.append((low, high))
    return max(0, extent - merged_length(spans))
