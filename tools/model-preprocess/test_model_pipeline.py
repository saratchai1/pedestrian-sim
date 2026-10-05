import unittest

from model_pipeline import (
    build_local_manifest,
    classify_navigation_mesh,
    resolve_scale_to_metres,
    transform_bounds_to_metres,
)


class ModelPipelineTests(unittest.TestCase):
    def test_unit_scale_conversion_requires_an_explicit_or_declared_unit(self):
        self.assertEqual(resolve_scale_to_metres("m", None), 1.0)
        self.assertEqual(resolve_scale_to_metres("cm", None), 0.01)
        self.assertEqual(resolve_scale_to_metres("mm", None), 0.001)
        self.assertEqual(resolve_scale_to_metres("unknown", 0.0254), 0.0254)
        with self.assertRaisesRegex(ValueError, "unknown"):
            resolve_scale_to_metres("unknown", None)
        with self.assertRaisesRegex(ValueError, "conflicts"):
            resolve_scale_to_metres("cm", 1.0)

    def test_local_origin_transform_preserves_dimensions_and_centers_model(self):
        bounds = {"min": {"x": 1000, "y": 2000, "z": -50}, "max": {"x": 1200, "y": 2300, "z": 50}}
        result = transform_bounds_to_metres(bounds, 0.01, (1100, 2150, 0))
        self.assertEqual(result["min"], {"x": -1.0, "y": -1.5, "z": -0.5})
        self.assertEqual(result["max"], {"x": 1.0, "y": 1.5, "z": 0.5})

    def test_geometry_classification_obeys_hidden_and_name_rules(self):
        rules = {
            "includeNamePatterns": [r"walkway|floor"],
            "excludeNamePatterns": [r"tree|foliage"],
            "forceIncludeNames": ["ManualSurface"],
            "forceExcludeNames": ["ManualProp"],
        }
        def decide(name, visible=True, materials=()):
            return classify_navigation_mesh(
                {"name": name, "visible": visible, "materials": list(materials), "dimensionsMetres": [5, 2, 0.1], "triangleCount": 10},
                rules,
            )["decision"]

        self.assertEqual(decide("Main Walkway"), "include")
        self.assertEqual(decide("Ficus Tree"), "exclude")
        self.assertEqual(decide("Unknown", materials=("floor_surface",)), "include")
        self.assertEqual(decide("Hidden walk floor", visible=False), "exclude")
        self.assertEqual(decide("ManualSurface"), "include")
        self.assertEqual(decide("ManualProp"), "exclude")

    def test_high_triangle_walkway_remains_for_manual_review(self):
        result = classify_navigation_mesh(
            {
                "name": "Main Walkway",
                "visible": True,
                "triangleCount": 250_001,
                "dimensionsMetres": [80, 4, 0.1],
            },
            {"includeNamePatterns": [r"walkway"], "reviewAboveTriangles": 250_000},
        )
        self.assertEqual(result["decision"], "review")

    def test_manifest_keeps_source_metadata_and_reversible_origin(self):
        manifest = build_local_manifest(
            source_file="C:/local/model.fbx",
            source_sha256="a" * 64,
            source_size=885_148_848,
            source_modified_at="2026-10-05T03:27:53Z",
            scale_to_metres=0.01,
            source_unit="custom",
            local_origin_source=(1000, 2000, 0),
            visual_derivative="visual.glb",
            navigation_derivative="nav.glb",
            generated_at="2026-10-05T00:00:00Z",
            blender_version="5.2.2",
        )
        self.assertEqual(manifest["sourceSize"], 885_148_848)
        self.assertEqual(manifest["sourceSha256"], "a" * 64)
        self.assertEqual(manifest["scaleToMetres"], 0.01)
        self.assertEqual(manifest["localOriginSource"], [1000.0, 2000.0, 0.0])
        self.assertIn("source - localOriginSource", manifest["coordinateTransform"])
        self.assertEqual(manifest["navigationDerivative"], "nav.glb")


if __name__ == "__main__":
    unittest.main()
