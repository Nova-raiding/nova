#!/usr/bin/env python3
"""Copy local objects into OSS using the app's cloud key convention.

Designed for the isolated ECS candidate. The source is retained. Existing cloud
keys are never overwritten. A copied body is verified before its metadata is
committed. A partial run stops for review before any retry.
"""

import hashlib
import json
import os
import pathlib
import subprocess
import sys
import tempfile


def run(args):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            universal_newlines=True, timeout=45)
    return result


def confined_regular_file(root, path, reason):
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (FileNotFoundError, RuntimeError, ValueError):
        raise RuntimeError(reason)
    if path.is_symlink() or not resolved.is_file():
        raise RuntimeError(reason)
    return resolved


def object_exists(key, base):
    head = run(["ossutil", "api", "head-object", "--key", key] + base)
    if head.returncode == 0:
        return True
    if "404" in head.stderr + head.stdout or "NoSuchKey" in head.stderr + head.stdout:
        return False
    raise RuntimeError("OSS_TARGET_LOOKUP_FAILED")


def download_object(bucket, key, destination, region, endpoint):
    get = run(["ossutil", "cp", "oss://" + bucket + "/" + key,
               str(destination), "--force", "--mode", "EcsRamRole",
               "--region", region, "--endpoint", endpoint])
    if get.returncode or not destination.is_file():
        raise RuntimeError("OSS_BODY_READBACK_FAILED")


def main():
    source = pathlib.Path(os.environ["LOCAL_OBJECT_ROOT"]).resolve()
    if not source.is_dir() or not source.as_posix().endswith("/objects"):
        raise RuntimeError("LOCAL_OBJECT_ROOT_INVALID")
    bucket = os.environ["ASSET_STORAGE_BUCKET"]
    region = os.environ["ASSET_STORAGE_REGION"]
    endpoint = os.environ["ASSET_STORAGE_ENDPOINT"]
    prefix = os.environ.get("ASSET_STORAGE_PREFIX", "merchant-assets").strip("/")
    if not endpoint.startswith("https://") or not prefix:
        raise RuntimeError("OSS_DESTINATION_INVALID")
    base = ["--bucket", bucket, "--mode", "EcsRamRole", "--region", region,
            "--endpoint", endpoint]
    copied = 0
    verified = 0
    for meta_file in sorted(source.rglob("*.meta.json")):
        meta_file = confined_regular_file(source, meta_file,
                                           "LOCAL_METADATA_FILE_INVALID")
        meta = json.loads(meta_file.read_text())
        logical = meta["key"]
        if meta_file.relative_to(source).as_posix() != logical + ".meta.json":
            raise RuntimeError("LOCAL_METADATA_KEY_MISMATCH")
        body = confined_regular_file(
            source, pathlib.Path(str(meta_file)[:-len(".meta.json")]),
            "LOCAL_OBJECT_FILE_INVALID")
        payload = body.read_bytes()
        digest = hashlib.sha256(payload).hexdigest()
        if digest != meta["sha256"] or len(payload) != meta["sizeBytes"]:
            raise RuntimeError("LOCAL_OBJECT_INTEGRITY_FAILED")
        key = prefix + "/" + logical
        meta_key = key + ".merchant-meta.json"
        body_exists = object_exists(key, base)
        meta_exists = object_exists(meta_key, base)
        if meta_exists and not body_exists:
            raise RuntimeError("OSS_METADATA_WITHOUT_BODY")
        with tempfile.TemporaryDirectory(prefix="store-nova-oss-verify-") as temp:
            downloaded = pathlib.Path(temp) / "body"
            if body_exists:
                download_object(bucket, key, downloaded, region, endpoint)
                if hashlib.sha256(downloaded.read_bytes()).hexdigest() != digest:
                    raise RuntimeError("OSS_EXISTING_BODY_MISMATCH")
            elif "--apply" in sys.argv:
                put = run(["ossutil", "api", "put-object", "--key", key,
                           "--body", "file://" + str(body), "--forbid-overwrite",
                           "--content-type", meta["contentType"],
                           "--server-side-encryption", "AES256",
                           "--metadata", "sha256=" + digest,
                           "--metadata", "workspaceId=" + meta["workspaceId"],
                           "--metadata", "zone=" + meta["zone"]] + base)
                if put.returncode:
                    raise RuntimeError("OSS_BODY_PUT_FAILED")
                download_object(bucket, key, downloaded, region, endpoint)
                if hashlib.sha256(downloaded.read_bytes()).hexdigest() != digest:
                    raise RuntimeError("OSS_BODY_READBACK_FAILED")
            cloud_meta = pathlib.Path(temp) / "merchant-meta.json"
            cloud_meta.write_text(json.dumps(meta, separators=(",", ":")))
            if meta_exists:
                existing_meta = pathlib.Path(temp) / "existing-meta.json"
                download_object(bucket, meta_key, existing_meta, region, endpoint)
                try:
                    matches = json.loads(existing_meta.read_text()) == meta
                except (UnicodeDecodeError, json.JSONDecodeError):
                    matches = False
                if not matches:
                    raise RuntimeError("OSS_EXISTING_METADATA_MISMATCH")
            elif "--apply" in sys.argv:
                put_meta = run(["ossutil", "api", "put-object", "--key", meta_key,
                                "--body", "file://" + str(cloud_meta), "--forbid-overwrite",
                                "--content-type", "application/json", "--server-side-encryption", "AES256",
                                "--metadata", "workspaceId=" + meta["workspaceId"],
                                "--metadata", "zone=" + meta["zone"]] + base)
                if put_meta.returncode:
                    raise RuntimeError("OSS_METADATA_PUT_FAILED")
        if "--apply" in sys.argv and not meta_exists:
            copied += 1
        verified += 1
    print(json.dumps({"mode": "apply" if "--apply" in sys.argv else "dry-run",
                      "objects_verified": verified, "objects_copied": copied,
                      "source_retained": True}))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"state": "blocked", "reason": str(error)}), file=sys.stderr)
        sys.exit(1)
