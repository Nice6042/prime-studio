#!/usr/bin/env python3
"""Validate readiness records with Draft 2020-12 plus normative semantics.

JSON Schema validates the portable record shape.  Equality between sibling
values and observer independence are deliberately enforced here instead of by
non-standard JSON Schema extensions.
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator


SECURITY_DIR = Path(__file__).resolve().parent
DEFAULT_SCHEMA = SECURITY_DIR / "readiness-oracle-record.schema.json"
DEFAULT_FIXTURES = SECURITY_DIR / "readiness-oracle-record.fixtures.json"
EPOCH_NAMES = ("policy", "broker", "session", "worker")
EFFECT_IDENTITY_FIELDS = ("effectId", "operation", "target", "kind", "sideEffect")


def load_json(path: Path) -> Any:
    with path.open(encoding="utf-8") as source:
        return json.load(source)


def json_pointer_parts(pointer: str) -> list[str]:
    if not pointer.startswith("/"):
        raise ValueError(f"JSON Patch path must start with '/': {pointer!r}")
    return [part.replace("~1", "/").replace("~0", "~") for part in pointer[1:].split("/")]


def apply_patches(document: dict[str, Any], patches: list[dict[str, Any]]) -> dict[str, Any]:
    result = copy.deepcopy(document)
    for patch in patches:
        operation = patch.get("op")
        parts = json_pointer_parts(patch.get("path", ""))
        if not parts:
            raise ValueError("root-document patches are not supported")

        parent: Any = result
        for part in parts[:-1]:
            parent = parent[int(part)] if isinstance(parent, list) else parent[part]

        key = parts[-1]
        if operation in {"add", "replace"}:
            if "value" not in patch:
                raise ValueError(f"{operation} patch is missing value: {patch!r}")
            if isinstance(parent, list):
                index = len(parent) if key == "-" else int(key)
                if operation == "add":
                    parent.insert(index, copy.deepcopy(patch["value"]))
                else:
                    parent[index] = copy.deepcopy(patch["value"])
            else:
                if operation == "replace" and key not in parent:
                    raise KeyError(f"replace target does not exist: {patch['path']}")
                parent[key] = copy.deepcopy(patch["value"])
        elif operation == "remove":
            if isinstance(parent, list):
                del parent[int(key)]
            else:
                del parent[key]
        else:
            raise ValueError(f"unsupported JSON Patch operation: {operation!r}")
    return result


def folded(value: Any) -> str:
    return value.casefold() if isinstance(value, str) else ""


def semantic_errors(record: dict[str, Any]) -> list[str]:
    """Return normative errors that portable Draft 2020-12 cannot express."""

    if record.get("status") != "implemented" and record.get("readiness") != "enforced":
        return []

    errors: list[str] = []
    expected = record["expectedEffect"]
    observed = record["observedEffect"]
    root_effect_id = record["effectId"]

    if expected["effectId"] != root_effect_id:
        errors.append("expectedEffect.effectId must equal root effectId")
    if observed["effectId"] != root_effect_id:
        errors.append("observedEffect.effectId must equal root effectId")
    for field in EFFECT_IDENTITY_FIELDS:
        if observed[field] != expected[field]:
            errors.append(f"observedEffect.{field} must equal expectedEffect.{field}")

    epochs = record["epochs"]
    epoch_evidence = record["epochEvidence"]
    for name in EPOCH_NAMES:
        if epochs[name] != epoch_evidence[name]["value"]:
            errors.append(f"epochs.{name} must equal epochEvidence.{name}.value")

    closure = record["closureIdentity"]
    if epochs["broker"] != closure["brokerEpoch"]:
        errors.append("epochs.broker must equal closureIdentity.brokerEpoch")
    if epochs["worker"] != closure["executorEpoch"]:
        errors.append("epochs.worker must equal closureIdentity.executorEpoch")

    subject_source = record["sourceIdentity"]
    observer = record["environmentBoundaryOracle"]["independentObserver"]
    observer_source = observer["sourceIdentity"]
    same_source_location = all(
        folded(observer_source[field]) == folded(subject_source[field])
        for field in ("repository", "commit", "path")
    )
    same_source_digest = folded(observer_source["digest"]) == folded(subject_source["digest"])
    if same_source_location or same_source_digest:
        errors.append("independent observer source identity must differ from the subject source")

    observer_closure = observer["closureIdentity"]
    same_studio_component = folded(observer_closure["component"]) == folded(closure["studio"])
    same_closure_digest = folded(observer_closure["artifactDigest"]) == folded(
        closure["artifactDigest"]
    )
    if same_studio_component or same_closure_digest:
        errors.append("independent observer closure identity must differ from the Studio closure")

    return errors


def schema_errors(
    validator: Draft202012Validator, record: dict[str, Any]
) -> list[str]:
    errors = sorted(validator.iter_errors(record), key=lambda error: list(error.absolute_path))
    rendered: list[str] = []
    for error in errors:
        location = "/" + "/".join(str(part) for part in error.absolute_path)
        rendered.append(f"schema {location}: {error.message}")
    return rendered


def validate_record(
    validator: Draft202012Validator, record: dict[str, Any]
) -> list[str]:
    structural = schema_errors(validator, record)
    if structural:
        return structural
    return [f"semantic: {message}" for message in semantic_errors(record)]


def load_validator(schema_path: Path) -> Draft202012Validator:
    schema = load_json(schema_path)
    expected_draft = "https://json-schema.org/draft/2020-12/schema"
    if schema.get("$schema") != expected_draft:
        raise ValueError(f"schema must declare {expected_draft}")
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema)


def validate_fixture_suite(
    validator: Draft202012Validator, fixtures_path: Path
) -> bool:
    fixtures = load_json(fixtures_path)
    positive = fixtures["positive"]
    positive_errors = validate_record(validator, positive["record"])
    if positive_errors:
        print(f"FAIL positive {positive['id']}")
        for error in positive_errors:
            print(f"  - {error}")
        return False

    print(f"PASS positive {positive['id']}")
    failed = False
    seen_ids: set[str] = set()
    for negative in fixtures["negative"]:
        fixture_id = negative["id"]
        if fixture_id in seen_ids:
            print(f"FAIL duplicate negative fixture id {fixture_id}")
            failed = True
            continue
        seen_ids.add(fixture_id)

        candidate = apply_patches(positive["record"], negative["patches"])
        errors = validate_record(validator, candidate)
        if not errors:
            print(f"FAIL negative {fixture_id}: malformed record was accepted")
            failed = True
            continue
        print(f"PASS negative {fixture_id}: {errors[0]}")

    print(
        f"fixture summary: 1 positive and {len(fixtures['negative'])} negative records checked"
    )
    return not failed


def validate_record_files(
    validator: Draft202012Validator, record_paths: list[Path]
) -> bool:
    failed = False
    for path in record_paths:
        record = load_json(path)
        errors = validate_record(validator, record)
        if errors:
            print(f"FAIL record {path}")
            for error in errors:
                print(f"  - {error}")
            failed = True
        else:
            print(f"PASS record {path}")
    return not failed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("records", nargs="*", type=Path, help="record JSON files to validate")
    parser.add_argument("--schema", type=Path, default=DEFAULT_SCHEMA)
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    try:
        validator = load_validator(args.schema)
        passed = (
            validate_record_files(validator, args.records)
            if args.records
            else validate_fixture_suite(validator, args.fixtures)
        )
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        print(f"validator error: {error}", file=sys.stderr)
        return 2
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
