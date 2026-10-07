"""Export only explicitly named walkway meshes from a navigation GLB."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parent))
from model_pipeline import classify_navigation_mesh


def main() -> None:
    arguments = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args(arguments)

    config = json.loads(Path(args.config).read_text(encoding="utf-8"))
    rules = config.get("classification", {})
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(Path(args.input).resolve(strict=True)))

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    selected = []
    excluded_water = []
    for obj in meshes:
        decision = classify_navigation_mesh(
            {"name": obj.name, "visible": True, "triangleCount": 0}, rules
        )
        if decision["decision"] == "include":
            selected.append(obj)
        elif decision["decision"] == "exclude" and "exclude pattern" in decision["reason"]:
            excluded_water.append(obj.name)

    if not selected:
        raise RuntimeError("No explicitly named walkway meshes matched the local classification rules.")

    destination = Path(args.output).resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = selected[0]
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

    print(f"INPUT_MESHES={len(meshes)}")
    print(f"WALKWAY_MESHES={len(selected)}")
    print(f"EXCLUDED_WATER_MESHES={len(excluded_water)}")
    print(f"OUTPUT={destination}")
    print(f"OUTPUT_BYTES={destination.stat().st_size}")


if __name__ == "__main__":
    main()
