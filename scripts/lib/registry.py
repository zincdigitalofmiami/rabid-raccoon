"""Read the symbol registry snapshot (JSON export from npm run registry:snapshot)."""
import json
from pathlib import Path

SNAPSHOT_PATH = (
    Path(__file__).resolve().parent.parent.parent
    / "src" / "lib" / "symbol-registry" / "snapshot.json"
)


def load_snapshot() -> dict:
    """Load the full registry snapshot."""
    if not SNAPSHOT_PATH.exists():
        raise FileNotFoundError(
            f"Registry snapshot not found at {SNAPSHOT_PATH}. "
            "Run: npm run registry:snapshot"
        )
    return json.loads(SNAPSHOT_PATH.read_text())


def get_symbols_by_role(role_key: str) -> list[str]:
    """Return symbol codes for a given role, ordered by position."""
    snapshot = load_snapshot()
    members = [
        m for m in snapshot["roleMembers"]
        if m["roleKey"] == role_key and m["enabled"]
    ]
    members.sort(key=lambda m: (m["position"], m["symbolCode"]))
    return [m["symbolCode"] for m in members]
