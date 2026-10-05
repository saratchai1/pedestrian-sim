"""Pure, Blender-independent helpers for the local zoo model pipeline."""

from __future__ import annotations

import hashlib
import math
import re
import struct
from pathlib import Path
from typing import Any, Mapping, Sequence

PIPELINE_VERSION = "1.0.0"
UNIT_TO_METRES = {"m": 1.0, "metre": 1.0, "meter": 1.0, "cm": 0.01, "mm": 0.001}


def parse_fbx_units(header: bytes) -> dict[str, float | str | None] | None:
    """Read binary FBX global unit factors from its header bytes."""
    if not header.startswith(b"Kaydara FBX Binary"):
        return None

    def read_double_property(property_name: str) -> float | None:
        marker = property_name.encode("ascii") + b"S\x06\x00\x00\x00doubleS\x06\x00\x00\x00NumberS\x00\x00\x00\x00D"
        offset = header.find(marker)
        if offset < 0 or offset + len(marker) + 8 > len(header):
            return None
        value = struct.unpack_from("<d", header, offset + len(marker))[0]
        return value if math.isfinite(value) and value > 0 else None

    unit_scale_cm = read_double_property("UnitScaleFactor")
    original_unit_scale_cm = read_double_property("OriginalUnitScaleFactor")
    if unit_scale_cm is None:
        return None

    known_units = ((100.0, "m"), (1.0, "cm"), (0.1, "mm"), (2.54, "in"), (30.48, "ft"), (91.44, "yd"))
    unit_name = next(
        (name for factor, name in known_units if math.isclose(unit_scale_cm, factor, rel_tol=1e-6)),
        "custom",
    )
    source_unit = unit_name if unit_name in {"m", "cm", "mm"} else "custom"
    return {
        "unitScaleFactorCm": unit_scale_cm,
        "originalUnitScaleFactorCm": original_unit_scale_cm,
        "sourceUnit": source_unit,
        "sourceUnitLabel": unit_name,
        "sourceUnitToMetres": unit_scale_cm / 100.0,
    }


def inspect_fbx_units(path: str | Path) -> dict[str, float | str] | None:
    """Read binary FBX units without importing the model.

    FBX's UnitScaleFactor is the number of centimetres in one source unit.
    Blender's scene unit settings are separate metadata and are not used here.
    """
    with Path(path).open("rb") as stream:
        return parse_fbx_units(stream.read(64 * 1024))


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
        # This conversion is applied to Blender-imported coordinates, whose unit
        # can differ from the raw FBX source unit (already converted by Blender).
        "scaleToMetres": resolve_scale_to_metres("unknown", scale_to_metres),
        "scaleSemantics": "Blender-imported coordinates to simulation metres",
        "localOriginSource": [float(value) for value in local_origin_source],
        "coordinateTransform": "simulation = (source - localOriginSource) * scaleToMetres",
        "visualDerivative": visual_derivative,
        "navigationDerivative": navigation_derivative,
        "preprocessVersion": PIPELINE_VERSION,
        "blenderVersion": blender_version,
        "generatedAt": generated_at,
    }
