"""Export the checked Linux browser runtime without private profile data."""
from __future__ import annotations
import argparse, gzip, hashlib, io, json, os, re, shutil, subprocess, tarfile, tempfile
from pathlib import Path

EXPECTED_BINARY_SHA256 = "15261d747064ae49a124d9e416b0c9e2c1d78285a0b2b04534d394d922b12355"
EXPECTED_SOURCE_SHA256 = "9fd2e4e942385471ce1000b0f63873c57e2dfd5c768dbcb7b0c917fa227673c7"
REQUIRED_RUNTIME = ("chimeric.js", "local-runtime.js", "chatgpt-credentials.js", "provider-settings.js", "antigravity-settings.js", "image-generation-settings.js", "decision-settings.js", "usage-indicator.js", "voice-settings.js", "class2-settings.js", "provider-events.js", "protected-resource-view.js", "local_asr.py", "sqliteWorkerEntry.js", "orgsImportWorker.js", "sandbox/gitScanWorker.js", "stallWatchdogEntry.js", "asset-manifest.json", "patch-manifest.json")
BROWSER_MODULES = frozenset({"chatgpt-credentials.js", "provider-settings.js", "antigravity-settings.js", "image-generation-settings.js", "decision-settings.js", "usage-indicator.js", "voice-settings.js", "class2-settings.js", "provider-events.js", "protected-resource-view.js"})

def release_metadata() -> dict:
    package = json.loads((Path(__file__).resolve().parents[1] / "package.json").read_text())
    version = package.get("version", "")
    if not isinstance(version, str) or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-rc\.[1-9]\d*)?", version):
        raise ValueError("package.json must declare a stable or rc.N semantic version")
    return {"product": "Chimeric", "version": version, "runtimeVersion": "0.1.71"}

def macos_versions(version: str) -> tuple[str, str]:
    if "-rc." in version:
        short, candidate = version.split("-rc.")
        if not 1 <= int(candidate) <= 255:
            raise ValueError("macOS release candidate number must be between 1 and 255")
        return short, short + "fc" + candidate
    return version, version

def build_antigravity_bridge(destination: Path, *, platform: str) -> dict:
    targets = {"darwin-arm64": ("darwin", "arm64"), "linux-x64": ("linux", "amd64")}
    if platform not in targets: raise ValueError(f"unsupported Antigravity transport target: {platform}")
    source = Path(__file__).resolve().parent / "antigravity-http-bridge/main.go"
    if not source.is_file() or source.is_symlink(): raise ValueError("Antigravity transport helper source is missing or unsafe")
    source_sha = _sha256(source)
    compiler = os.environ.get("CHIMERIC_GO") or shutil.which("go")
    if not compiler or not Path(compiler).is_file() or not os.access(compiler, os.X_OK):
        raise ValueError("Go compiler is required to package Antigravity transport; add go to PATH or set CHIMERIC_GO")
    destination = destination.resolve(); destination.parent.mkdir(parents=True, exist_ok=True)
    goos, goarch = targets[platform]
    env = dict(os.environ, CGO_ENABLED="0", GOOS=goos, GOARCH=goarch, GO111MODULE="off",
               GOTOOLCHAIN="local", GOWORK="off", GOFLAGS="", GOPROXY="off", GOSUMDB="off")
    with tempfile.TemporaryDirectory(prefix=".agy-http-bridge-", dir=destination.parent) as temporary:
        compiled = Path(temporary) / "agy-http-bridge"
        try:
            version = subprocess.run([compiler, "version"], check=True, capture_output=True, text=True, env=env, timeout=30).stdout.strip()
            subprocess.run([compiler, "build", "-trimpath", "-buildvcs=false", "-o", str(compiled), str(source)],
                           check=True, capture_output=True, text=True, env=env, cwd=source.parent, timeout=180)
        except (OSError, subprocess.SubprocessError) as exc:
            raise ValueError("Could not build the required Antigravity transport helper") from exc
        header = compiled.read_bytes()[:20] if compiled.is_file() else b""
        if goos == "linux":
            valid = len(header) == 20 and header[:6] == b"\x7fELF\x02\x01" and header[18:20] == b"\x3e\x00"
        else:
            valid = len(header) == 20 and header[:8] == b"\xcf\xfa\xed\xfe\x0c\x00\x00\x01"
        if not valid: raise ValueError(f"Antigravity transport compiler produced an invalid {platform} executable")
        if _sha256(source) != source_sha: raise ValueError("Antigravity transport source changed during compilation; build again")
        compiled.chmod(0o755); os.replace(compiled, destination)
    return {"path": "bin/agy-http-bridge", "platform": platform, "sourceSha256": source_sha,
            "binarySha256": _sha256(destination), "compiler": version, "cgoEnabled": False}

def _inside(path: Path, root: Path) -> bool:
    try: path.resolve(strict=False).relative_to(root.resolve(strict=False)); return True
    except ValueError: return False

def _read_json(path: Path) -> dict:
    if not path.is_file() or path.is_symlink(): raise ValueError(f"required journal is missing or unsafe: {path.name}")
    try: value = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc: raise ValueError(f"invalid JSON journal: {path}") from exc
    if not isinstance(value, dict): raise ValueError(f"JSON journal must contain an object: {path}")
    return value

def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""): digest.update(chunk)
    return digest.hexdigest()

def _validate_asset_tree(assets: Path, asset_sha: str) -> None:
    if not assets.is_dir() or assets.is_symlink(): raise ValueError("asset root must be a regular directory")
    marker = assets / ".science-assets-sha256"
    if not marker.is_file() or marker.is_symlink() or marker.read_text().strip() != asset_sha: raise ValueError("asset integrity marker is missing or mismatched")
    for item in assets.rglob("*"):
        if item.is_symlink() and not _inside(item.resolve(strict=False), assets): raise ValueError(f"asset symlink escapes asset root: {item}")

def _relative_name(name: str) -> str:
    name = name.replace("\\", "/")
    if name == ".": return ""
    if name.startswith("/") or any(part in ("", "..") for part in name.split("/")): raise ValueError(f"unsafe archive member path: {name!r}")
    return name[2:] if name.startswith("./") else name

def _asset_inventory(root: Path) -> dict[str, tuple[str, object]]:
    result = {"": ("dir", None)}
    for item in root.rglob("*"):
        rel = item.relative_to(root).as_posix()
        if rel == ".science-assets-sha256": continue
        if item.is_symlink():
            target = os.readlink(item)
            if not _inside(item.parent / target, root) or not (item.parent / target).exists(): raise ValueError(f"asset symlink is dangling or escapes root: {item}")
            result[rel] = ("symlink", target)
        elif item.is_dir(): result[rel] = ("dir", None)
        elif item.is_file(): result[rel] = ("file", (_sha256(item), item.stat().st_size))
        else: raise ValueError(f"unsupported asset entry: {item}")
    return result

def _validate_archive_binding(archive: Path, assets: Path, expected_tree_sha: str) -> tuple[str, str]:
    raw = gzip.decompress(archive.read_bytes())
    tree_sha = hashlib.sha256(raw).hexdigest()
    if tree_sha != expected_tree_sha: raise ValueError("decompressed asset archive does not match manifest sha256")
    inventory = _asset_inventory(assets); seen = {}
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as tar:
        for member in tar.getmembers():
            rel = _relative_name(member.name)
            if rel in seen: raise ValueError(f"duplicate archive member: {member.name}")
            if rel == "":
                if not member.isdir(): raise ValueError("archive root is not a directory")
                seen[rel] = ("dir", None); continue
            if member.isdir(): entry = ("dir", None)
            elif member.isfile():
                data = tar.extractfile(member)
                if data is None: raise ValueError(f"archive file has no payload: {member.name}")
                payload = data.read(); entry = ("file", (hashlib.sha256(payload).hexdigest(), len(payload)))
            elif member.issym():
                target = member.linkname
                resolved = (assets / rel).parent / target
                if not _inside(resolved, assets) or not resolved.exists(): raise ValueError(f"archive symlink is dangling or escapes root: {member.name}")
                entry = ("symlink", target)
            else: raise ValueError(f"unsupported archive member type: {member.name}")
            seen[rel] = entry
    if seen != inventory: raise ValueError("asset tree does not exactly match decompressed archive")
    return tree_sha, hashlib.sha256(archive.read_bytes()).hexdigest()

def validate_inputs(runtime: Path, binary: Path, expected_binary_sha256: str = EXPECTED_BINARY_SHA256, *, platform: str = "linux-x64", source_sha256: str = EXPECTED_SOURCE_SHA256) -> tuple[dict, dict, Path, Path]:
    runtime, binary = runtime.resolve(), binary.resolve()
    if not runtime.is_dir() or runtime.is_symlink(): raise ValueError("runtime must be a regular directory")
    if not binary.is_file() or binary.is_symlink() or not os.access(binary, os.X_OK): raise ValueError("native main must be a regular executable file")
    patches = _read_json(runtime / "patch-manifest.json")
    if patches.get("platform") != platform: raise ValueError(f"This target requires the checked {platform} runtime.")
    if patches.get("sourceSha256") != source_sha256: raise ValueError("runtime source journal is not the verified revision")
    if not isinstance(patches.get("outputSha256"), str) or _sha256(runtime / "chimeric.js") != patches["outputSha256"]: raise ValueError("native runtime entry does not match outputSha256")
    if _sha256(binary) != expected_binary_sha256: raise ValueError("Runtime binary does not match the verified release.")
    manifest = _read_json(runtime / "asset-manifest.json")
    archive_name, root_name, asset_sha = manifest.get("archive"), manifest.get("rootRelative"), manifest.get("sha256")
    if not all(isinstance(v, str) and v for v in (archive_name, root_name, asset_sha)): raise ValueError("asset manifest lacks archive, rootRelative, or sha256")
    archive, assets = (runtime / archive_name).resolve(), (runtime / root_name).resolve()
    if not _inside(archive, runtime) or not _inside(assets, runtime): raise ValueError("asset manifest path escapes runtime")
    if not archive.is_file() or archive.is_symlink(): raise ValueError("asset archive must be a regular file")
    if manifest.get("archiveSha256") and _sha256(archive) != manifest["archiveSha256"]: raise ValueError("asset archive does not match archiveSha256")
    _validate_asset_tree(assets, asset_sha)
    _validate_archive_binding(archive, assets, asset_sha)
    for name in REQUIRED_RUNTIME:
        path = runtime / name
        if not _inside(path, runtime) or not path.is_file() or path.is_symlink(): raise ValueError(f"required runtime file is missing or unsafe: {name}")
    return patches, manifest, archive, assets

def export_bundle(runtime: Path, binary: Path, out: Path, *, expected_binary_sha256: str = EXPECTED_BINARY_SHA256) -> dict:
    out = out.resolve()
    if out.exists(): raise ValueError(f"destination must not already exist: {out}")
    source = Path(__file__).resolve().parents[1]
    patches, manifest, archive, assets = validate_inputs(runtime, binary, expected_binary_sha256)
    stage = Path(tempfile.mkdtemp(prefix=f".{out.name}.", dir=out.parent))
    try:
        (stage / "bin").mkdir(); (stage / "runtime").mkdir()
        shutil.copy2(binary, stage / "bin/chimeric"); (stage / "bin/chimeric").chmod(0o755)
        transport = build_antigravity_bridge(stage / "bin/agy-http-bridge", platform="linux-x64")
        for name in REQUIRED_RUNTIME:
            target = stage / "runtime" / name; target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(Path(runtime) / name, target)
            if name.endswith(".js") and name not in {"chimeric.js", "local-runtime.js"} | BROWSER_MODULES: target.with_suffix(".ts").symlink_to(target.name)
        shutil.copy2(archive, stage / "runtime" / archive.name); shutil.copytree(assets, stage / "runtime" / assets.name, symlinks=True)
        tree_sha, raw_archive_sha = _validate_archive_binding(stage / "runtime" / archive.name, stage / "runtime" / assets.name, manifest["sha256"])
        if _sha256(stage / "runtime/chimeric.js") != patches["outputSha256"]: raise ValueError("staged runtime entry changed during export")
        manifest = dict(manifest); manifest.pop("root", None); (stage / "runtime/asset-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
        shutil.copy2(source / "tools/launcher.mjs", stage / "launcher.mjs")
        metadata = release_metadata()
        (stage / "chimeric-version.json").write_text(json.dumps(metadata, indent=2) + "\n")
        command = stage / "chimeric"; command.write_text('#!/bin/sh\nset -eu\nCHIMERIC_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexport BUN_BE_BUN=1\nexec "$CHIMERIC_ROOT/bin/chimeric" "$CHIMERIC_ROOT/launcher.mjs" "$@"\n'); command.chmod(0o755)
        record = {**metadata, "platform": "linux-x64", "nativeSourceSha256": patches["sourceSha256"], "binarySha256": expected_binary_sha256, "backendBundleSha256": _sha256(stage / "runtime/local-runtime.js"), "assetArchiveRawGzipSha256": raw_archive_sha, "assetTreeTarSha256": tree_sha, "moduleVersion": manifest["moduleVersion"], "antigravityTransport": transport, "privateProfileIncluded": False, "executionVerified": False}
        (stage / "BUNDLE-BUILD.json").write_text(json.dumps(record, indent=2) + "\n"); (stage / "NOTICE.txt").write_text("Chimeric integrates the local research runtime 0.1.71. Original component copyright and license notices remain in the bundled assets. This development export has not completed the portable release audit.\n")
        os.replace(stage, out); return record
    except Exception:
        shutil.rmtree(stage, ignore_errors=True); raise

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument("--runtime", type=Path, required=True); parser.add_argument("--binary", type=Path, required=True); parser.add_argument("--out", type=Path, required=True); args = parser.parse_args()
    try: print(json.dumps(export_bundle(args.runtime, args.binary, args.out)))
    except (OSError, ValueError, KeyError) as exc: parser.error(str(exc))

if __name__ == "__main__": main()
