"""The bridge image copies server.py but not mcp-server/, so helpers that the
standalone adapter also needs are duplicated. This keeps the copies in step."""
import ast
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BRIDGE = ROOT / "server.py"
ADAPTER = ROOT / "mcp-server" / "server.py"

IDENTICAL_CONSTANTS = ("NAV_WAIT_MODES", "NAV_DEFAULT_TIMEOUT_MS", "NAV_WAIT_DOC")
IDENTICAL_FUNCTIONS = ("_screenshot_content",)


def _top_level(path: Path) -> dict[str, ast.AST]:
    nodes = {}
    for node in ast.parse(path.read_text()).body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            nodes[node.name] = node
        elif isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    nodes[target.id] = node
    return nodes


def _without_annotations(func: ast.FunctionDef) -> str:
    func = ast.parse(ast.unparse(func)).body[0]
    func.returns = None
    for arg in [*func.args.posonlyargs, *func.args.args, *func.args.kwonlyargs]:
        arg.annotation = None
    return ast.dump(func)


def _load_nav_kwargs(nodes: dict[str, ast.AST]):
    namespace: dict = {}
    module = ast.Module(body=[nodes["NAV_WAIT_MODES"], nodes["_nav_kwargs"]], type_ignores=[])
    exec(compile(ast.fix_missing_locations(module), "<nav_kwargs>", "exec"), namespace)
    return namespace["_nav_kwargs"]


BRIDGE_NODES = _top_level(BRIDGE)
ADAPTER_NODES = _top_level(ADAPTER)


@pytest.mark.parametrize("name", IDENTICAL_CONSTANTS)
def test_constants_match(name):
    assert ast.dump(BRIDGE_NODES[name].value) == ast.dump(ADAPTER_NODES[name].value)


@pytest.mark.parametrize("name", IDENTICAL_FUNCTIONS)
def test_functions_match(name):
    assert _without_annotations(BRIDGE_NODES[name]) == _without_annotations(ADAPTER_NODES[name]), (
        f"{name} differs between server.py and mcp-server/server.py; apply the change to both"
    )


def test_nav_kwargs_validate_the_same_way():
    # The adapter's copy also takes tab_id, so compare behavior, not source.
    bridge, adapter = _load_nav_kwargs(BRIDGE_NODES), _load_nav_kwargs(ADAPTER_NODES)
    for mode in ("load", "domcontentloaded", "none"):
        assert bridge(mode, 5000) == adapter(mode, 5000) == {"waitUntil": mode, "timeoutMs": 5000}
    with pytest.raises(ValueError) as bridge_error:
        bridge("networkidle", 5000)
    with pytest.raises(ValueError) as adapter_error:
        adapter("networkidle", 5000)
    assert str(bridge_error.value) == str(adapter_error.value)
