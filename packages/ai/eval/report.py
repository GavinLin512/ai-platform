# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Compare eval runs side by side.

    uv run eval/report.py eval/results/*.json
    python3 eval/report.py eval/results/*.json

Standard library only, so it runs anywhere Python 3.11+ does. `uv run` reads the inline
metadata block above (PEP 723) and needs no virtualenv or requirements.txt.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Run:
    path: Path
    suite: str
    label: str
    precision: float
    recall: float
    f1: float
    cost: float
    errors: list[dict]

    @classmethod
    def load(cls, path: Path) -> Run:
        data = json.loads(path.read_text(encoding="utf-8"))
        label = data["mode"]
        if data["mode"] == "llm":
            label = f"llm {data['model']} effort={data['effort']} verify={data['verify']}"
        m = data["metrics"]
        return cls(
            path=path,
            suite=data["suite"],
            label=label,
            precision=m["precision"],
            recall=m["recall"],
            f1=m["f1"],
            cost=data["usage"]["costUsd"],
            errors=[c for c in data["cases"] if c["outcome"] in ("FP", "FN")],
        )


def pct(x: float) -> str:
    return f"{x * 100:5.1f}%"


def main(paths: list[str]) -> int:
    if not paths:
        print(__doc__)
        return 1
    runs = sorted((Run.load(Path(p)) for p in paths), key=lambda r: (r.suite, r.label))

    print(f"| {'suite':<12} | {'run':<48} | precision | recall |   F1   |   cost   |")
    print(f"|{'-' * 14}|{'-' * 50}|-----------|--------|--------|----------|")
    for r in runs:
        print(
            f"| {r.suite:<12} | {r.label:<48} |  {pct(r.precision)}   | {pct(r.recall)} | {pct(r.f1)} | ${r.cost:7.4f} |"
        )

    for r in runs:
        if not r.errors:
            continue
        print(f"\n{r.suite} / {r.label}: {len(r.errors)} errors")
        for case in r.errors:
            expected = ", ".join(case["expected"]) or "-"
            predicted = ", ".join(case["predicted"]) or "-"
            print(f"  {case['outcome']} {case['id']}  {case['input']}  expected [{expected}]  got [{predicted}]")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
