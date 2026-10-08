"""Load a Python file that is not on the import path as a module, for the tests in this directory."""
import importlib.machinery
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_module(name, path):
    """Import `path` as module `name`. Registered in sys.modules (dataclasses look their module up there), so
    give each test file its own `name` for a shared script."""
    loader = importlib.machinery.SourceFileLoader(name, str(path))
    spec = importlib.util.spec_from_loader(name, loader)
    assert spec is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    loader.exec_module(module)
    return module
