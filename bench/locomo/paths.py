"""
Every path this harness uses, resolved from THIS file's location so the scripts work
from any cwd and nothing depends on where the repo is checked out.

All of them are overridable by env var:

  LOCOMO_DATA    the locomo10.json file       (default <harness>/data/locomo10.json)
  LOCOMO_WORK    intermediates, resumable     (default <harness>/work)
  LOCOMO_OUT     where reports are written    (default <harness>/out)

See DATA.md for how to obtain the dataset. `out/` is gitignored; the committed
evidence behind the published tables lives in `results/` and is never written to.
"""
import os
import sys

HARNESS_ROOT = os.path.dirname(os.path.abspath(__file__))
# The memory-core checkout this harness measures: bench/locomo -> bench -> repo root.
REPO_ROOT = os.path.dirname(os.path.dirname(HARNESS_ROOT))

DATA = os.environ.get("LOCOMO_DATA") or os.path.join(HARNESS_ROOT, "data", "locomo10.json")
WORK = os.environ.get("LOCOMO_WORK") or os.path.join(HARNESS_ROOT, "work")
OUT = os.environ.get("LOCOMO_OUT") or os.path.join(HARNESS_ROOT, "out")

CORPUS = os.path.join(WORK, "corpus.json")
RANKINGS = os.path.join(WORK, "rankings")
MEM0_DIR = os.path.join(WORK, "mem0")
LOGS = os.path.join(WORK, "logs")


def require_dataset(path=None):
    """Fail with one clear line instead of a FileNotFoundError traceback."""
    p = path or DATA
    if not os.path.exists(p):
        sys.exit(
            f"error: LoCoMo dataset not found at {p}\n"
            f"       It is a third-party 2.8 MB file and is deliberately not committed here.\n"
            f"       See {os.path.join(HARNESS_ROOT, 'DATA.md')} for the download command and\n"
            f"       expected sha256, or point LOCOMO_DATA at an existing copy."
        )
    return p


def require_corpus(path=None):
    p = path or CORPUS
    if not os.path.exists(p):
        sys.exit(
            f"error: canonical corpus not found at {p}\n"
            f"       Build it first:  python3 build_corpus.py\n"
            f"       Every system reads this one file, which is what makes the comparison\n"
            f"       same-corpus by construction."
        )
    return p


def require_file(path, what, how):
    if not os.path.exists(path):
        sys.exit(f"error: {what} not found at {path}\n       {how}")
    return path
