"""Pure, Blender-independent helpers for the local zoo model pipeline."""

from __future__ import annotations

import hashlib
import math
import re
from pathlib import Path
from typing import Any, Mapping, Sequence

PIPELINE_VERSION = "1.0.0"
UNIT_TO_METRES = {"m": 1.0, "metre": 1.0, "meter": 1.0, "cm": 0.01, "mm": 0.001}


def resolve_scale_to_metres(source_unit: str | None, configured_scale: float | None) -> float:
    """Resolve a declared unit and reject implicit/contradictory conversions."""
    unit = (source_unit or "unknown").strip().lower()
    expected = UNIT_TO_METRES.get(unit)
    if configured_scale is None:
        if expected is None:
            raise ValueError("Set scaleToMetres in the local config; source units are unknown.")
        return expected

    scale = float(configured_scale)
    if not math.isfinite(scale) or scale <= 0:
        raise ValueError("scaleToMetres must be a finite number greater than zero.")
    if expected is not None and not math.isclose(scale, expected, rel_tol=0.001, abs_tol=1e-9):
        raise ValueError(f"scaleToMetres={scale:g} conflicts with declared sourceUnit={unit!r}.")
    return scale


def _vector(value: Mapping[str, Any] | Sequence[float]) -> tuple[float, float, float]:
    if isinstance(value, Mapping):
        return float(value["x"]), float(value["y"]), float(value["z"])
    if len(value) != 3:
        raise ValueError("A 3D point must contain exactly three coordinates.")
    return float(value[0]), float(value[1]), float(value[2])


def transform_bounds_to_metres(
    bounds: Mapping[str, Any], scale_to_metres: float, local_origin: Sequence[float] = (0, 0, 0)
) -> dict[str, dict[str, float]]:
    """Apply the pipeline's uniform scale and source-coordinate origin offset."""
    scale = resolve_scale_to_metres("unknown", scale_to_metres)
    origin = _vector(local_origin)
    low = _vector(bounds["min"])
    high = _vector(bounds["max"])
    result = []
    for axis in range(3):
        a = (low[axis] - origin[axis]) * scale
        b = (high[axis] - origin[axis]) * scale
        result.append((min(a, b), max(a, b)))
    return {
        "min": {axis: result[i][0] for i, axis in enumerate(("x", "y", "z"))},
        "max": {axis: result[i][1] for i, axis in enumerate(("x", "y", "z"))},
    }


def _matches(patterns: Sequence[str], haystack: str) -> str | None:
    for pattern in patterns:
        if re.search(pattern, haystack, flags=re.IGNORECASE):
            return pattern
    return None


def classify_navigation_mesh(
    record: Mapping[str, Any], rules: Mapping[str, Any]
) -> dict[str, str]:
    """Classify conservatively; uncertain geometry remains visible for review."""
    name = str(record.get("name", ""))
    hidden = not bool(record.get("visible", True))
    if hidden:
        return {"decision": "exclude", "reason": "object is hidden in the source scene"}

    force_include = {str(value).casefold() for value in rules.get("forceIncludeNames", [])}
    force_exclude = {str(value).casefold() for value in rules.get("forceExcludeNames", [])}
    folded_name = name.casefold()
    if folded_name in force_exclude:
        return {"decision": "exclude", "reason": "exact name is force-excluded"}
    if folded_name in force_include:
        return {"decision": "include", "reason": "exact name is force-included"}

    labels = [name]
    labels.extend(str(value) for value in record.get("collections", []))
    labels.extend(str(value) for value in record.get("materials", []))
    haystack = " | ".join(labels)

    excluded = _matches(rules.get("excludeNamePatterns", []), haystack)
    if excluded:
        return {"decision": "exclude", "reason": f"matches exclude pattern {excluded!r}"}

    max_triangles = int(rules.get("reviewAboveTriangles", 250_000))
    if int(record.get("triangleCount", 0)) > max_triangles:
        return {"decision": "review", "reason": "high triangle count; review before navigation use"}

    dimensions = record.get("dimensionsMetres")
    if dimensions and len(dimensions) == 3:
        diagonal = math.sqrt(sum(float(component) ** 2 for component in dimensions))
        threshold = float(rules.get("verySmallMeshMetres", 0.05))
        if diagonal < threshold:
            return {"decision": "review", "reason": f"very small mesh ({diagonal:.3f} m diagonal)"}

    included = _matches(rules.get("includeNamePatterns", []), haystack)
    if included:
        return {"decision": "include", "reason": f"matches include pattern {included!r}"}
    return {"decision": "review", "reason": "no confident include or exclude rule matched"}


def sha256_file(path: str | Path, chunk_size: int = 8 * 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def build_local_manifest(
    *,
    source_file: str,
    source_sha256: str,
    source_size: int,
    source_modified_at: str,
    scale_to_metres: float,
    source_unit: str,
    local_origin_source: Sequence[float],
    visual_derivative: str,
    navigation_derivative: str,
    generated_at: str,
    blender_version: str,
) -> dict[str, Any]:
    """Build the ignored local manifest; callers must not commit this file."""
    return {
        "schemaVersion": 1,
        "sourceFile": str(Path(source_file).resolve()),
        "sourceSha256": source_sha256,
        "sourceSize": int(source_size),
        "sourceModifiedAt": source_modified_at,
        "sourceUnit": source_unit,
        "scaleToMetres": resolve_scale_to_metres(source_unit, scale_to_metres),
        "localOriginSource": [float(value) for value in local_origin_source],
        "coordinateTransform": "simulation = (source - localOriginSource) * scaleToMetres",
        "visualDerivative": visual_derivative,
        "navigationDerivative": navigation_derivative,
        "preprocessVersion": PIPELINE_VERSION,
        "blenderVersion": blender_version,
        "generatedAt": generated_at,
    }
