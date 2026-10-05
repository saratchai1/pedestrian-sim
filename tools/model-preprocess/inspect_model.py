"""Blender entry point for read-only source inventory and geometry review."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from preprocess_zoo_model import main

main(force_inspect=True)
