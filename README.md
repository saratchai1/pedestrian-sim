# EvacSim

Browser-based BIM evacuation simulation prototype inspired by Pathfinder-style BIM-to-egress workflows. It imports IFC and FBX, builds a Recast/Detour navigation mesh, simulates microscopic pedestrian agents, and reports evacuation/bottleneck metrics in real time.

## Current capabilities

- Import `.ifc` in the browser with `web-ifc`.
- Import `.fbx` in the browser with Three.js `FBXLoader`.
- Build geometry and scenario inputs directly in the browser without IFC/FBX: floor/corridor polygons, wall segments, door openings, Spawn Areas, direct Exits, rectangular obstacles and stair links.
- Insert a door by clicking near a drawn wall; EvacSim splits that wall into two segments to create a real NavMesh opening.
- Mark drawn doors as exits so their opening width is carried directly into the evacuation flow model.
- Select drawn elements for delete or ΔX/ΔZ/ΔY translation.
- Use metric grid snapping, multiple floor elevations and history-based Undo/Clear.
- Save an authored EvacSim model in browser storage, reload it later, or download/import a portable `.evacsim.json` file. The saved model includes Build geometry, Spawn Areas, Exits, simulation settings and manual quick-test spawn/exits.
- Add build geometry on top of imported IFC/FBX while keeping drawn geometry in world metres even when the imported model uses a scale conversion.
- Correct IFC Z-up geometry into the app's Y-up navigation coordinate system.
- Detect IFC semantic entities including building storeys, spaces, doors and stairs.
- Infer exit candidates from IFC door names/types and read `IfcDoor.OverallWidth` when available.
- Generate Recast NavMesh from imported geometry.
- Optional experimental IFC stair off-mesh links for disconnected storeys.
- Click to place an occupant spawn and multiple exits manually.
- Assign occupants to the shortest reachable exit using NavMesh path length.
- Simulate Detour crowd agents with local avoidance at a fixed 30 Hz simulation step.
- Render occupants as animated human figures rather than debug cylinders.
- Use a hybrid LOD crowd renderer: up to 72 nearby agents use articulated knees, elbows, hands, shoes, neck, hair, body-shape variation, breathing, sway and smoothed turning; medium-distance agents use simplified humanoids; far agents use lightweight silhouettes.
- Keep all avatar levels instanced so visual realism improves without changing Detour routing/collision or cloning a heavy rigged GLB for every occupant.
- Seeded occupant profiles, including custom/adult/mixed/slow/staff presets.
- Pre-movement delay distributions.
- Optional SFPE-style exit flow cap using effective door width and a delay timer.
- Live evacuation time, P95 time, density heatmap, exit throughput, queue length and queue wait.
- Live individual occupant markers with hover details for ID, movement state, profile and coordinates.
- Adjustable simulation playback speed from 0.25× to 4×, independent of occupant walking speed.
- Per-exit configured/measured flow diagnostics.
- Save multiple completed scenarios locally for comparison.
- Export per-agent CSV including profile, speed, pre-movement time, queue wait, exit, evacuation time and travel distance.
- Built-in demo building.
- Static deployment configuration for Netlify and GitHub Pages.

## Run locally

    npm install
    npm run dev

Production check:

    npm run build
    npm run preview

The postinstall script copies `web-ifc.wasm` into `public/` so IFC parsing works in the browser.

## GitHub Pages deployment

Set the repository's **Settings → Pages → Build and deployment → Source** to **GitHub Actions** once. Push to `main` to build and deploy `dist/`; the workflow also supports manual runs from the Actions tab. The walkway preview model is copied into the production bundle during build.

For this repository, the preview URL will be `https://saratchai1.github.io/pedestrian-sim/?preview=zoo-walkways` after the first successful deployment.

## In-app Build Mode

Use the top workspace switch: **View / Build / Simulate**.

1. Choose **Build**.
2. Click **New blank plan** for a standalone model, or keep an imported IFC/FBX open and draw additions on top of it.
3. Set **Floor elevation** and **Grid snap**.
4. Choose **Floor / corridor**, click 3+ polygon points, then press **Finish polygon** (or Enter).
5. Choose **Spawn Area**, set **Spawn occupants**, draw a polygon, then press **Finish polygon**. Multiple Spawn Areas can be created on different elevations.
6. Add **Exit** markers directly with a configured width, or create a Door opening and mark it as an exit.
7. Draw walls by two clicks, obstacles by two opposite corners, and stair links by start/end plan positions.
8. For another storey, change Floor elevation and draw its floor. Stair end elevation is current elevation + Stair rise.
9. Press **Build NavMesh** after geometry changes. Spawn Areas and direct Exit markers do not require a NavMesh rebuild by themselves.
10. Switch to **Simulate** and choose an explicit scenario source:
    - **Built scenario** uses only Build Mode Spawn Areas + Build Mode Exits. Their summed population is the source of truth.
    - **Manual quick test** uses only manual spawn/exits plus the Manual occupants and Manual spawn radius controls.
11. Press **Save model** to keep the authored model in this browser. Use **Load saved** to reopen it, or **Download model / Import model** for a portable file. Legacy BuildPlan JSON files remain importable.

Build geometry is stored in world metres and is combined with imported model geometry only when NavMesh is generated. Saved EvacSim model files persist the geometry authored inside EvacSim; source IFC/FBX file bytes are not embedded.

## Imported model workflow

1. Import an IFC or FBX file.
2. Set Model scale so the Three.js scene is in metres. Typical values are `1` for metres, `0.01` for centimetres and `0.001` for millimetres.
3. Build the NavMesh.
4. For IFC, optionally enable experimental stair links and/or load detected exit candidates.
5. Set a spawn point by clicking a walkable surface.
6. Add or confirm one or more exits.
7. Configure occupant profile, count, pre-movement delay and seed.
8. Configure exit-flow settings if the prototype SFPE-style cap is desired.
9. Run the simulation.
10. Save the completed scenario for comparison or export the agent CSV.

## Zoo Large Model Workflow

The 885 MB zoo FBX stays on the local machine and is not stored in GitHub. Use Blender's headless importer to inspect and produce a visual GLB and a separate lightweight navigation GLB. The workflow keeps source coordinates, records a reversible local-origin offset, requires an explicit unit conversion, and leaves uncertain geometry in a review report. It does not decimate or merge geometry automatically.

1. Install the Windows portable Blender ZIP without administrator rights and place it under `.tools/blender/` or `tools/blender-<version>-windows-x64/`, or set `BLENDER_EXE` to its `blender.exe` path.
2. Inspect the source without creating derivatives:

   ```powershell
   npm run model:inspect -- --input "C:\path\to\zoo.fbx"
   ```

3. Review `generated/models/zoo/model-inspection.md` and `classification-review.md`. Binary FBX `UnitScaleFactor` metadata is read as centimetres per source unit; compare that scale and the reported metre bounds with an authoring setting or a known measured dimension. Add an independent `scaleReference` before treating scale validation as complete. Update include/exclude rules for the real walkway geometry.
4. Generate the local-only derivatives and manifest:

   ```powershell
   npm run model -- --input "C:\path\to\zoo.fbx"
   ```

5. Start EvacSim with `npm run dev` and import `visual.glb` and `nav.glb` together. Visual geometry appears in the viewer; only the navigation derivative and Build Mode geometry feed NavMesh generation.
6. Build the NavMesh, draw Spawn Areas on walkable surfaces, define exits and widths, and run the 100-agent evacuation scenario before trying larger populations. Check route connectivity, path queries, queues, evacuation completion, metrics, and CSV output against the real geometry.

Inspection reports, local manifests, generated GLBs, source FBX files, and Blender working files are excluded from Git. `npm run check:artifacts` guards against accidentally tracking large files. See [tools/model-preprocess/README.md](tools/model-preprocess/README.md) for unit, classification, scale, and troubleshooting details.

Priority order is walkway topology, scale, exit and bottleneck widths, navigation connectivity, reproducibility, simulation performance, rendering performance, and visual fidelity. EvacSim simulates pedestrian movement on geometry; it does not simulate smoke, temperature, toxicity, FED, visibility, or fire spread.

## Exit flow prototype

When enabled, the exit-flow limiter uses:

    effective width = exit width - 2 * boundary layer
    flow rate = specific flow * effective width

The default UI values are `1.316 pers/s-m` specific flow and `0.15 m` boundary layer per side because those values match the maximum-flow verification example documented by Pathfinder. The implementation is intentionally labelled **SFPE-style** rather than SFPE-compliant; EvacSim has not completed a matching verification/validation program.

## Architecture

    IFC (web-ifc) -----\
                       -> Three.js -> Recast NavMesh -> Detour Crowd
    FBX (FBXLoader) --/                                  |
                                                          +-> density / queues / flow / CSV
                                                          +-> scenario comparison

## Scope and limitations

This is an engineering and research prototype, not a validated life-safety or code-compliance product.

- It does not yet model fire, smoke, toxicity, visibility or FED.
- IFC exit detection is heuristic because IFC authoring conventions for naming exits vary.
- Experimental stair links estimate lower/upper endpoints from stair geometry; they are disabled by default.
- Off-mesh stair traversal does not yet implement a calibrated stair-speed model.
- Human avatars are performance-oriented procedural characters with hybrid LOD. They are more human-like than debug primitives but are not photorealistic scanned characters.
- The SFPE-style door cap is a simplified maximum-flow delay timer, not the complete Pathfinder SFPE density/speed model.
- Density is currently a 1 m x 1 m sampled occupancy diagnostic.
- Build Mode supports selection, delete, translation, wall-cut door openings, persistent Spawn Areas and width-aware Exits, but it is not a full CAD editor: grip/vertex editing, wall joins, dimensions and arbitrary rotation/resize are not implemented yet.
- Elevators and assisted evacuation are not implemented.
- No NIST, IMO or Pathfinder-style verification and validation suite has been completed.
- Results must not be used for safety certification.

## Next milestones

1. Add repeatable benchmark scenes and automated verification tests, beginning with simple door-flow cases.
2. Add internal IFC door/room connectivity and room-level density history.
3. Add calibrated stair speed and multi-floor validation.
4. Add batch scenario runner and design-option comparison.
5. Couple FDS/PyroSim fields for smoke, visibility and FED-aware routing.
6. Add richer result playback and time-history charts.
