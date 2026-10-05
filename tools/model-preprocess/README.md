# Local large-model workflow

This pipeline reads the source FBX locally and writes ignored, reproducible inspection reports and GLB derivatives. It never saves to, renames, moves, or uploads the source FBX. Geometry is not decimated or merged automatically.

## Requirements

- Node.js and the repository npm dependencies.
- Blender 4.2 LTS or newer with the glTF 2.0 exporter available. A Windows portable ZIP works without administrator rights. Extract it under `.tools/blender/`, `tools/blender-<version>-windows-x64/`, or set `BLENDER_EXE` to its full executable path. The launcher searches both local folders automatically.
- Enough memory and disk space for Blender to open the source and write two derivatives. The visual GLB can remain large if the source contains dense geometry or embedded textures.

## Inspect first

From the repository root in PowerShell:

```powershell
npm run model:inspect -- --input "C:\path with spaces\zoo.fbx"
```

The command creates `generated/models/zoo/model-inspection.json`, `model-inspection.md`, and `classification-review.json`. It reports object/mesh/vertex/triangle/material counts, texture references, bounds, source coordinate magnitudes, hidden and empty objects, degenerate meshes, shared/probable duplicate geometry, and hierarchy depth. The report includes the source size, modified time, and SHA-256.

The first run creates `config/zoo-model.local.json` from the committed example. Confirm the FBX unit using the source authoring settings or a known measured dimension, then set `sourceUnit` and `scaleToMetres` in that local file. To get a scale validation `PASS`, also set `scaleReference.objectName`, `measuredAxis`, and `measuredLengthMetres` from a known object dimension; without that reference, the pipeline reports `REVIEW`. Supported declared units are metres (`1`), centimetres (`0.01`), and millimetres (`0.001`). Use `custom` with an explicit conversion when the source uses another unit. Unknown units do not receive a guessed scale.

## Review and preprocess

The name rules in the example intentionally include only clearly named walkways, paths, floors, ramps, stairs, bridges, roads, and gates. They exclude obvious decoration such as trees, foliage, signs, furniture, and roofs. Everything else remains `review`; meshes over the configured triangle limit and extremely small meshes also remain `review` even when their names match a walkway rule. It is not silently added to the navigation mesh. Edit the local config's `forceIncludeNames`, `forceExcludeNames`, or regex rules after reviewing `classification-review.md` and its JSON detail.

Then run:

```powershell
npm run model -- --input "C:\path with spaces\zoo.fbx"
```

Or supply a one-time explicit conversion:

```powershell
npm run model -- --input "C:\path with spaces\zoo.fbx" --source-unit cm --scale-to-metres 0.01
```

The pipeline writes `visual.glb`, `nav.glb`, `zoo-model.local.json`, and updated inspection/classification reports under `generated/models/zoo/`. The local manifest records the absolute source path, SHA-256, size, modified time, unit conversion, local-origin transform, Blender and pipeline versions, derivative sizes, triangle counts, processing time, and peak memory when available. Local manifests can contain a user path and are ignored by Git.

The `visual.glb` contains visible source meshes for display. The `nav.glb` contains only meshes confidently classified for navigation. The source model is not part of GitHub. Neither derivative is a substitute for checking walkway widths, ramps/stairs, door openings, and navigation connectivity against the source. In Vite development mode, the browser console logs import/scene timing, geometry and NavMesh metrics, simulation initialization time, FPS, and active/total agents. The NavMesh tile-data byte figure estimates serialized tile data; it does not include browser, geometry, or crowd memory.

## Load in EvacSim

Run `npm run dev`, choose both `visual.glb` and `nav.glb` in the same file picker action, and let EvacSim load the visual scene while building navigation from the navigation derivative plus any Build Mode geometry. Then build the NavMesh, create Spawn Areas on walkable surfaces, place at least two exits when the geometry supports them, and run the 100-agent scenario before larger benchmarks. The app still accepts small standalone FBX and GLB files; direct FBX files above 100 MiB are directed to preprocessing because FBXLoader buffers and parses the whole file in browser memory.

## Safety and reproducibility

- One simulation world unit is one metre after `scaleToMetres` is applied.
- Blender exports glTF with glTF's Y-up convention. The manifest records the reversible source-origin offset and unit factor.
- The origin defaults to the source bounds center to improve float precision while preserving the source-to-simulation transform.
- No automatic decimation, route-width edits, mesh merging, or duplicate deletion is performed. Probable duplicates are reported for review.
- Review classification before relying on `nav.glb`; no confident include match stops navigation export.
- `local-data/`, `generated/models/`, `.tools/`, local configs, and Blender backups are ignored. `npm run check:artifacts` blocks accidentally tracked large files before publishing.
- This workflow covers geometry and pedestrian movement only. It does not model fire, smoke, temperature, visibility, toxicity, FED, or fire spread.
