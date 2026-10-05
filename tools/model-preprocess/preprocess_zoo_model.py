"""Inspect and derive visual/navigation GLBs from a local FBX using Blender."""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bpy
from mathutils import Matrix, Vector

from model_pipeline import (
    PIPELINE_VERSION,
    build_local_manifest,
    classify_navigation_mesh,
    inspect_fbx_units,
    resolve_scale_to_metres,
    sha256_file,
    transform_bounds_to_metres,
)


def parse_args(force_inspect: bool = False) -> argparse.Namespace:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, help="Read-only source FBX path")
    parser.add_argument("--config", default="config/zoo-model.local.json")
    parser.add_argument("--output-dir", default="generated/models/zoo")
    parser.add_argument("--scale-to-metres", type=float)
    parser.add_argument("--source-unit", choices=("unknown", "m", "cm", "mm", "custom"))
    parser.add_argument("--local-origin", nargs=3, type=float, metavar=("X", "Y", "Z"))
    parser.add_argument("--inspect-only", action="store_true")
    parser.add_argument("--max-review-triangles", type=int)
    parsed = parser.parse_args(arguments)
    if force_inspect:
        parsed.inspect_only = True
    return parsed


def load_config(path: Path) -> dict[str, Any]:
    if not path.exists():
        example = path.with_name("zoo-model.example.json")
        if example.exists():
            return json.loads(example.read_text(encoding="utf-8"))
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def utc_timestamp(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def object_collections(obj: bpy.types.Object) -> list[str]:
    return sorted({collection.name for collection in obj.users_collection})


def object_materials(obj: bpy.types.Object) -> list[str]:
    if not obj.data or not hasattr(obj.data, "materials"):
        return []
    return sorted({material.name for material in obj.data.materials if material})


def texture_references(objects: list[bpy.types.Object]) -> list[str]:
    references: set[str] = set()
    for obj in objects:
        for material in obj.data.materials if obj.data and hasattr(obj.data, "materials") else []:
            if not material or not material.use_nodes or not material.node_tree:
                continue
            for node in material.node_tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    image = node.image
                    references.add(image.filepath or f"packed:{image.name}")
    return sorted(references)


def hierarchy_depth(obj: bpy.types.Object) -> int:
    depth = 0
    parent = obj.parent
    while parent:
        depth += 1
        parent = parent.parent
    return depth


def bounds_for_object(obj: bpy.types.Object) -> dict[str, dict[str, float]]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    if not points:
        point = obj.matrix_world.translation
        points = [point]
    return {
        "min": {axis: min(getattr(point, axis) for point in points) for axis in ("x", "y", "z")},
        "max": {axis: max(getattr(point, axis) for point in points) for axis in ("x", "y", "z")},
    }


def union_bounds(bounds: list[dict[str, dict[str, float]]]) -> dict[str, dict[str, float]] | None:
    if not bounds:
        return None
    return {
        "min": {axis: min(item["min"][axis] for item in bounds) for axis in ("x", "y", "z")},
        "max": {axis: max(item["max"][axis] for item in bounds) for axis in ("x", "y", "z")},
    }


def dimensions(bounds: dict[str, dict[str, float]]) -> dict[str, float]:
    return {axis: bounds["max"][axis] - bounds["min"][axis] for axis in ("x", "y", "z")}


def scene_mesh_records(
    scale_to_metres: float | None = None,
    classification_rules: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    rules = classification_rules or {}
    very_small_limit = float(rules.get("verySmallMeshMetres", 0.05))
    very_large_triangle_limit = int(rules.get("reviewAboveTriangles", 250_000))
    scene_objects = list(bpy.context.scene.objects)
    mesh_objects = [obj for obj in scene_objects if obj.type == "MESH" and obj.data]
    object_records: list[dict[str, Any]] = []
    duplicate_data: dict[int, list[str]] = defaultdict(list)
    approximate_signatures: dict[tuple[Any, ...], list[str]] = defaultdict(list)
    vertex_count = triangle_count = degenerate_mesh_count = 0
    all_bounds: list[dict[str, dict[str, float]]] = []

    for object_index, obj in enumerate(mesh_objects, start=1):
        if object_index == 1 or object_index % 250 == 0:
            print(f"INVENTORY_PROGRESS={object_index}/{len(mesh_objects)}", flush=True)
        mesh = obj.data
        mesh.calc_loop_triangles()
        vertices = len(mesh.vertices)
        triangles = len(mesh.loop_triangles)
        vertex_count += vertices
        triangle_count += triangles
        bounds = bounds_for_object(obj)
        world_location, world_rotation, world_scale = obj.matrix_world.decompose()
        all_bounds.append(bounds)
        source_dimensions = dimensions(bounds)
        bounds_metres = transform_bounds_to_metres(bounds, scale_to_metres) if scale_to_metres else None
        dimensions_metres = dimensions(bounds_metres) if bounds_metres else None
        is_very_small = bool(
            dimensions_metres
            and math.sqrt(sum(value * value for value in dimensions_metres.values())) < very_small_limit
        )
        is_very_large = triangles > very_large_triangle_limit
        hidden = bool(obj.hide_render or obj.hide_get() or not obj.visible_get())
        materials = object_materials(obj)
        collections = object_collections(obj)

        # Flag empty/collapsed meshes without a Python-level pass over every triangle.
        if triangles == 0 or max(source_dimensions.values(), default=0) <= 1e-12:
            degenerate_mesh_count += 1

        duplicate_data[mesh.as_pointer()].append(obj.name)
        signature = (
            vertices,
            triangles,
            tuple(round(source_dimensions[axis], 5) for axis in ("x", "y", "z")),
            tuple(materials),
        )
        approximate_signatures[signature].append(obj.name)
        object_records.append(
            {
                "name": obj.name,
                "collections": collections,
                "materials": materials,
                "visible": not hidden,
                "hidden": hidden,
                "vertexCount": vertices,
                "triangleCount": triangles,
                "boundsSource": bounds,
                "dimensionsSource": source_dimensions,
                "boundsMetres": bounds_metres,
                "dimensionsMetres": dimensions_metres,
                "transformWorld": {
                    "location": [round(value, 6) for value in world_location],
                    "rotationQuaternion": [round(value, 8) for value in world_rotation],
                    "scale": [round(value, 8) for value in world_scale],
                },
                "hierarchyDepth": hierarchy_depth(obj),
                "verySmallMesh": is_very_small,
                "veryLargeMesh": is_very_large,
                "coordinateMagnitudeSource": max(
                    abs(value) for side in ("min", "max") for value in bounds[side].values()
                ),
                "meshDataName": mesh.name,
            }
        )

    bounds = union_bounds(all_bounds)
    bounds_metres = transform_bounds_to_metres(bounds, scale_to_metres) if bounds and scale_to_metres else None
    duplicate_groups = [sorted(names) for names in duplicate_data.values() if len(names) > 1]
    shared_group_sets = {frozenset(names) for names in duplicate_groups}
    probable_duplicate_groups = [
        sorted(names)
        for names in approximate_signatures.values()
        if len(names) > 1 and frozenset(names) not in shared_group_sets
    ]
    empty_count = sum(1 for obj in scene_objects if obj.type == "EMPTY")
    material_count = len({material.as_pointer() for obj in mesh_objects for material in obj.data.materials if material})

    scene_unit = bpy.context.scene.unit_settings
    inventory = {
        "objectCount": len(scene_objects),
        "meshCount": len(mesh_objects),
        "emptyObjectCount": empty_count,
        "hiddenObjectCount": sum(1 for item in object_records if item["hidden"]),
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "materialCount": material_count,
        "textureReferences": texture_references(mesh_objects),
        "boundsSource": bounds,
        "dimensionsSource": dimensions(bounds) if bounds else None,
        "boundsMetres": bounds_metres,
        "dimensionsMetres": dimensions(bounds_metres) if bounds_metres else None,
        "maximumHierarchyDepth": max((item["hierarchyDepth"] for item in object_records), default=0),
        "maximumCoordinateMagnitudeSource": max(
            (item["coordinateMagnitudeSource"] for item in object_records), default=0
        ),
        "degenerateMeshCount": degenerate_mesh_count,
        "verySmallMeshCount": sum(1 for item in object_records if item["verySmallMesh"]),
        "veryLargeMeshCount": sum(1 for item in object_records if item["veryLargeMesh"]),
        "sharedMeshDataGroups": duplicate_groups,
        "probableDuplicateGeometryGroups": probable_duplicate_groups,
        "blenderSceneUnits": {
            "system": scene_unit.system,
            "scaleLength": scene_unit.scale_length,
            "lengthUnit": scene_unit.length_unit,
        },
        "objects": sorted(object_records, key=lambda item: item["name"].casefold()),
    }
    return object_records, inventory


def markdown_inspection(report: dict[str, Any]) -> str:
    source = report["source"]
    inventory = report["inventory"]
    bounds = inventory.get("boundsMetres") or inventory.get("boundsSource")
    dimensions_value = inventory.get("dimensionsMetres") or inventory.get("dimensionsSource")
    units = "metres" if inventory.get("boundsMetres") else "source units (scale unresolved)"
    lines = [
        "# Zoo model inspection",
        "",
        f"- Source file: `{Path(source['path']).name}` (read-only)",
        f"- Size: {source['sizeBytes']:,} bytes",
        f"- Modified (UTC): {source['modifiedAt']}",
        f"- SHA-256: `{source['sha256']}`",
        f"- FBX source unit: `{(report['scale'].get('fbxGlobalSettings') or {}).get('sourceUnitLabel', report['scale']['sourceUnit'])}`",
        f"- FBX `UnitScaleFactor` (cm per source unit): `{(report['scale'].get('fbxGlobalSettings') or {}).get('unitScaleFactorCm')}`",
        f"- Blender-imported coordinate scale to metres: `{report['scale']['scaleToMetres']}`",
        f"- Objects / meshes: {inventory['objectCount']} / {inventory['meshCount']}",
        f"- Vertices / triangles: {inventory['vertexCount']:,} / {inventory['triangleCount']:,}",
        f"- Materials / textures: {inventory['materialCount']} / {len(inventory['textureReferences'])}",
        f"- Bounds ({units}): `{json.dumps(bounds, sort_keys=True)}`",
        f"- Dimensions ({units}): `{json.dumps(dimensions_value, sort_keys=True)}`",
        f"- Hidden objects: {inventory['hiddenObjectCount']}",
        f"- Empty objects: {inventory['emptyObjectCount']}",
        f"- Degenerate meshes: {inventory['degenerateMeshCount']:,}",
        f"- Very small meshes (< configured threshold): {inventory['verySmallMeshCount']:,}",
        f"- Very large meshes (> configured triangle threshold): {inventory['veryLargeMeshCount']:,}",
        f"- Shared mesh data groups: {len(inventory['sharedMeshDataGroups'])}",
        f"- Probable duplicate geometry groups: {len(inventory['probableDuplicateGeometryGroups'])}",
        "",
        "Scale is read from binary FBX `UnitScaleFactor` when available and converted by Blender's FBX importer. Confirm imported dimensions against a measured reference; when metadata is absent, set a post-import `scaleToMetres` explicitly.",
        "",
    ]
    return "\n".join(lines)


def markdown_classification(summary: dict[str, int], records: list[dict[str, Any]]) -> str:
    lines = ["# Navigation geometry review", "", "## Counts", ""]
    lines.extend(f"- {decision.title()}: {summary.get(decision, 0)}" for decision in ("include", "exclude", "review"))
    lines.extend(["", "## Objects requiring review", ""])
    review = [item for item in records if item["decision"] == "review"]
    lines.extend(f"- `{item['name']}` — {item['reason']}" for item in review[:500])
    if len(review) > 500:
        lines.append(f"- … {len(review) - 500} more; see `classification-review.json`.")
    lines.append("")
    return "\n".join(lines)


def resolve_origin(inventory: dict[str, Any], config: dict[str, Any], cli_origin: list[float] | None) -> tuple[float, float, float]:
    if cli_origin:
        return tuple(cli_origin)
    origin = config.get("localOrigin", {"mode": "boundsCenter"})
    if origin.get("mode", "boundsCenter") == "explicit":
        coordinates = origin.get("coordinates", (0, 0, 0))
        if len(coordinates) != 3:
            raise ValueError("localOrigin.coordinates must contain X, Y, and Z.")
        return tuple(float(value) for value in coordinates)
    bounds = inventory.get("boundsSource")
    if not bounds:
        return 0.0, 0.0, 0.0
    return tuple((bounds["min"][axis] + bounds["max"][axis]) / 2 for axis in ("x", "y", "z"))


def export_role(role: str, objects: list[bpy.types.Object], destination: Path) -> dict[str, Any]:
    view_layer = bpy.context.view_layer
    previous_active = view_layer.objects.active
    previous_selection = list(bpy.context.selected_objects)
    try:
        print(f"GLB_EXPORT_STARTED={role} ({len(objects)} meshes)", flush=True)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        if objects:
            view_layer.objects.active = objects[0]

        destination.parent.mkdir(parents=True, exist_ok=True)
        bpy.ops.export_scene.gltf(
            filepath=str(destination),
            export_format="GLB",
            use_selection=True,
            export_apply=True,
            export_texcoords=True,
            export_normals=True,
            export_materials="EXPORT",
            export_extras=True,
            export_animations=False,
            export_lights=False,
        )
    finally:
        bpy.ops.object.select_all(action="DESELECT")
        for obj in previous_selection:
            if bpy.data.objects.get(obj.name) is not None:
                obj.select_set(True)
        view_layer.objects.active = (
            previous_active if previous_active and bpy.data.objects.get(previous_active.name) else None
        )

    print(f"GLB_EXPORT_DONE={role}", flush=True)
    return {"path": str(destination), "sizeBytes": destination.stat().st_size, "meshCount": len(objects)}


def peak_memory_bytes() -> int | None:
    try:
        import psutil  # type: ignore

        process = psutil.Process()
        info = process.memory_info()
        return int(getattr(info, "peak_wset", info.rss))
    except Exception:
        return None


def run(force_inspect: bool = False) -> None:
    started = time.perf_counter()
    args = parse_args(force_inspect)
    source = Path(args.input).expanduser().resolve(strict=True)
    if source.suffix.lower() != ".fbx":
        raise ValueError("The preprocessing source must be an FBX file.")

    repo_root = Path.cwd()
    output = Path(args.output_dir).expanduser()
    if not output.is_absolute():
        output = (repo_root / output).resolve()
    output.mkdir(parents=True, exist_ok=True)

    config_path = Path(args.config).expanduser()
    if not config_path.is_absolute():
        config_path = (repo_root / config_path).resolve()
    config = load_config(config_path)
    scale_config = args.scale_to_metres
    if scale_config is None:
        scale_config = config.get("scaleToMetres")
    unit = args.source_unit or config.get("sourceUnit", "unknown")
    fbx_units = inspect_fbx_units(source)
    if unit == "unknown" and fbx_units:
        unit = str(fbx_units["sourceUnit"])

    stat = source.stat()
    source_metadata = {
        "path": str(source),
        "name": source.name,
        "sizeBytes": stat.st_size,
        "modifiedAt": utc_timestamp(source),
        "sha256": sha256_file(source),
    }
    print(f"SOURCE_HASHED={source_metadata['sha256']}", flush=True)

    # The source is only read by Blender's FBX importer; no save or write targets it.
    print(f"FBX_IMPORT_STARTED={source_metadata['sizeBytes']} bytes", flush=True)
    bpy.ops.import_scene.fbx(
        filepath=str(source),
        use_anim=False,
        use_custom_normals=not args.inspect_only,
        use_image_search=not args.inspect_only,
    )
    print("FBX_IMPORT_DONE", flush=True)
    blender_scene_units = bpy.context.scene.unit_settings
    if scale_config is None and fbx_units and blender_scene_units.system != "NONE":
        # Blender's FBX importer has already applied UnitScaleFactor to imported
        # coordinates. Convert Blender units to metres, not raw FBX units again.
        scale_config = float(blender_scene_units.scale_length)
    unresolved_scale = None
    try:
        scale_to_metres = resolve_scale_to_metres("unknown", scale_config)
    except ValueError as error:
        unresolved_scale = str(error)
        scale_to_metres = None
    if args.scale_to_metres is not None or config.get("scaleToMetres") is not None:
        scale_resolution_source = "explicit CLI/config post-import coordinate conversion"
    elif fbx_units and scale_to_metres is not None:
        scale_resolution_source = "FBX UnitScaleFactor via Blender importer; Blender scene scaleLength"
    elif unit != "unknown" and scale_to_metres is not None:
        scale_resolution_source = "declared source unit; Blender scene scaleLength"
    else:
        scale_resolution_source = "unresolved"

    rules = config.get("classification", {})
    print("MODEL_INVENTORY_STARTED", flush=True)
    object_records, inventory = scene_mesh_records(scale_to_metres, rules)
    print(
        f"MODEL_INVENTORY_DONE={inventory['meshCount']} meshes, {inventory['triangleCount']} triangles",
        flush=True,
    )
    report = {
        "reportVersion": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "source": source_metadata,
        "scale": {
            "sourceUnit": unit,
            "scaleToMetres": scale_to_metres,
            "resolved": scale_to_metres is not None,
            "resolutionError": unresolved_scale,
            "fbxGlobalSettings": fbx_units,
            "coordinateSpaceUnit": "Blender units after FBX import",
            "blenderSceneScaleLength": float(blender_scene_units.scale_length),
            "resolutionSource": scale_resolution_source,
        },
        "axisOrientation": {
            "blenderSourceUpAxis": "Z",
            "gltfDerivativeUpAxis": "Y",
            "transformDescription": "Blender glTF exporter converts to glTF Y-up; source FBX is not modified.",
        },
        "inventory": inventory,
    }
    (output / "model-inspection.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "model-inspection.md").write_text(markdown_inspection(report), encoding="utf-8")
    print(f"MODEL_INSPECTION={output / 'model-inspection.json'}")
    print(markdown_inspection(report))

    if args.max_review_triangles is not None:
        rules["reviewAboveTriangles"] = args.max_review_triangles
    classification_records = []
    record_by_name = {item["name"]: item for item in object_records}
    for item in object_records:
        decision = classify_navigation_mesh(
            {
                "name": item["name"],
                "collections": item["collections"],
                "materials": item["materials"],
                "visible": item["visible"],
                "triangleCount": item["triangleCount"],
                "dimensionsMetres": (
                    list(item["dimensionsMetres"].values()) if item["dimensionsMetres"] else None
                ),
            },
            rules,
        )
        classification_records.append({"name": item["name"], **decision})

    classification_summary = dict(Counter(item["decision"] for item in classification_records))
    classification_report = {
        "reportVersion": 1,
        "sourceSha256": source_metadata["sha256"],
        "rules": rules,
        "summary": classification_summary,
        "objects": classification_records,
    }
    (output / "classification-review.json").write_text(
        json.dumps(classification_report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    (output / "classification-review.md").write_text(
        markdown_classification(classification_summary, classification_records), encoding="utf-8"
    )

    if args.inspect_only:
        print("PREPROCESS=NOT_RUN (inspection-only)")
        return
    if scale_to_metres is None:
        raise ValueError(
            "Inspection is complete, but scale is unresolved. Confirm the imported coordinates and set a post-import scaleToMetres in config/zoo-model.local.json, then run again."
        )

    bounds = inventory.get("boundsMetres")
    if not bounds:
        raise ValueError("The source contains no mesh bounds; cannot generate derivatives.")
    extents = dimensions(bounds)
    longest_extent = max(extents.values())
    if longest_extent < 1 or longest_extent > 5000:
        raise ValueError(
            f"Model bounds look implausible at this scale (largest extent {longest_extent:.2f} m). Review source units and scaleToMetres."
        )

    decisions = {item["name"]: item["decision"] for item in classification_records}
    nav_objects = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.name in decisions and decisions[obj.name] == "include"
    ]
    visual_objects = [
        obj for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.data and not obj.hide_render and not obj.hide_get() and obj.visible_get()
    ]
    if not nav_objects:
        raise ValueError(
            "No high-confidence navigation meshes matched. Review classification-review.md and add verified names/patterns to the local config; nothing was simplified or removed."
        )

    origin = resolve_origin(inventory, config, args.local_origin)
    conversion = Matrix.Translation(Vector(origin) * -scale_to_metres) @ Matrix.Scale(scale_to_metres, 4)
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.matrix_world = conversion @ obj.matrix_world

    # No automatic decimation or geometry merge is performed: route width and topology stay intact.
    before_after = {
        "source": {
            "sizeBytes": source_metadata["sizeBytes"],
            "meshCount": inventory["meshCount"],
            "triangleCount": inventory["triangleCount"],
            "boundsMetres": bounds,
        },
        "navigationSelection": {
            "meshCount": len(nav_objects),
            "triangleCount": sum(len(obj.data.loop_triangles) for obj in nav_objects),
            "boundsMetres": union_bounds([bounds_for_object(obj) for obj in nav_objects]),
        },
        "visualSelection": {
            "meshCount": len(visual_objects),
            "triangleCount": sum(len(obj.data.loop_triangles) for obj in visual_objects),
        },
    }

    visual = export_role("visual", visual_objects, output / "visual.glb")
    navigation = export_role("nav", nav_objects, output / "nav.glb")
    elapsed = time.perf_counter() - started
    generated_at = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    manifest = build_local_manifest(
        source_file=str(source),
        source_sha256=source_metadata["sha256"],
        source_size=source_metadata["sizeBytes"],
        source_modified_at=source_metadata["modifiedAt"],
        scale_to_metres=scale_to_metres,
        source_unit=unit,
        local_origin_source=origin,
        visual_derivative="visual.glb",
        navigation_derivative="nav.glb",
        generated_at=generated_at,
        blender_version=bpy.app.version_string,
    )
    manifest["outputDirectory"] = str(output)
    manifest["classificationSummary"] = classification_summary
    manifest["metrics"] = {
        **before_after,
        "visualDerivative": visual,
        "navigationDerivative": navigation,
        "processingSeconds": round(elapsed, 3),
        "peakMemoryBytes": peak_memory_bytes(),
    }
    human_reference = config.get("scaleReference") or {}
    reference_name = str(human_reference.get("objectName", ""))
    reference_axis = str(human_reference.get("measuredAxis", "z")).lower()
    reference_length = human_reference.get("measuredLengthMetres")
    reference_object = next(
        (
            item for item in object_records
            if item["name"] == reference_name and item["dimensionsMetres"]
        ),
        None,
    )
    reference_status = "REVIEW"
    reference_measured_length = None
    if reference_object and reference_axis in ("x", "y", "z") and reference_length:
        reference_measured_length = reference_object["dimensionsMetres"][reference_axis]
        difference = abs(reference_measured_length - float(reference_length)) / float(reference_length)
        reference_status = "PASS" if difference <= 0.05 else "FAIL"

    width_candidates = []
    for item in object_records:
        dims = item["dimensionsMetres"]
        if item["name"] in decisions and decisions[item["name"]] == "include" and dims:
            candidate = min(dims["x"], dims["y"])
            if 0.6 <= candidate <= 8.0:
                width_candidates.append(candidate)

    manifest["scaleValidation"] = {
        "status": reference_status,
        "verificationMethod": "configured measured reference geometry",
        "referenceObjectName": reference_name or None,
        "referenceAxis": reference_axis if reference_name else None,
        "referenceExpectedLengthMetres": reference_length,
        "referenceObservedLengthMetres": reference_measured_length,
        "sourceUnit": unit,
        "scaleToMetres": scale_to_metres,
        "expectedHumanHeightMetres": 1.7,
        "recastAgentRadiusMetres": 0.30,
        "humanReferenceObjects": [
            {"name": item["name"], "dimensionsMetres": item["dimensionsMetres"]}
            for item in object_records
            if item["dimensionsMetres"] and re.search(r"human|person|adult|mannequin", item["name"], re.I)
        ],
        "walkwayWidthCandidatesMetres": sorted(width_candidates),
        "boundsLongestExtentMetres": longest_extent,
        "boundsStatus": "PASS" if 1 <= longest_extent <= 5000 else "REVIEW",
    }
    (output / "zoo-model.local.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    report["classificationSummary"] = classification_summary
    report["preprocess"] = {
        "version": PIPELINE_VERSION,
        "blenderVersion": bpy.app.version_string,
        "processingSeconds": round(elapsed, 3),
        "metrics": manifest["metrics"],
        "scaleValidation": manifest["scaleValidation"],
    }
    (output / "model-inspection.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    (output / "model-inspection.md").write_text(markdown_inspection(report), encoding="utf-8")

    print(f"SOURCE_SHA256={source_metadata['sha256']}")
    print(f"SOURCE_SIZE={source_metadata['sizeBytes']}")
    print(f"SOURCE_TRIANGLES={inventory['triangleCount']}")
    print(f"SOURCE_MESHES={inventory['meshCount']}")
    print(f"VISUAL_DERIVATIVE_SIZE={visual['sizeBytes']}")
    print(f"NAV_DERIVATIVE_SIZE={navigation['sizeBytes']}")
    print(f"NAV_TRIANGLES={before_after['navigationSelection']['triangleCount']}")
    print(f"PREPROCESS_SECONDS={elapsed:.3f}")
    print(f"PEAK_MEMORY_BYTES={manifest['metrics']['peakMemoryBytes']}")
    print(f"LOCAL_MANIFEST={output / 'zoo-model.local.json'}")


def main(force_inspect: bool = False) -> None:
    try:
        run(force_inspect)
    except Exception as error:
        print(f"MODEL_PREPROCESS_ERROR={error}", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()
