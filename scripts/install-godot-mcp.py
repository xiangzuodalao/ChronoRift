"""Install the pinned Godot AI release; never executes project code."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

VERSION = "4.1.0"
SHA256 = "535d8a7541871af8d991b07fe5031550dd6121a31b844400476b334a70612831"
destination = Path(sys.argv[1]).resolve()
destination.parent.mkdir(parents=True, exist_ok=True)
if destination.exists():
    raise SystemExit(f"Installation already exists: {destination}; doctor it before replacing it")
with tempfile.TemporaryDirectory(dir=destination.parent) as temp:
    root = Path(temp)
    archive = root / "plugin.zip"
    url = f"https://github.com/hi-godot/godot-ai/releases/download/v{VERSION}/godot-ai-v4-plugin.zip"
    with urllib.request.urlopen(url, timeout=60) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise SystemExit("Godot AI archive checksum mismatch")
    archive.write_bytes(data)
    with zipfile.ZipFile(archive) as package:
        total = 0
        seen = set()
        for entry in package.infolist():
            target = root / "plugin" / entry.filename
            mode = entry.external_attr >> 16
            total += entry.file_size
            if (not target.resolve().is_relative_to(root / "plugin")
                    or stat.S_IFMT(mode) not in (0, stat.S_IFREG, stat.S_IFDIR)
                    or entry.filename in seen or total > 64 * 1024 * 1024):
                raise SystemExit("Unsafe Godot AI archive")
            seen.add(entry.filename)
        package.extractall(root / "plugin")
    addon = root / "plugin/addons/godot_ai"
    if not (addon / "plugin.cfg").is_file():
        raise SystemExit("Unexpected Godot AI archive layout")
    # Move before creating the venv: entrypoint shebangs contain absolute paths.
    destination.mkdir()
    shutil.move(str(root / "plugin"), str(destination / "plugin"))
try:
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv is required to install the pinned Python environment")
    os.environ["UV_PYTHON_INSTALL_DIR"] = str(destination / "python")
    subprocess.run([uv, "venv", "--python", "3.12.13", "--managed-python", str(destination / "venv")], check=True)
    subprocess.run([uv, "pip", "install", "--python", str(destination / "venv/bin/python"), "-r", str(Path(__file__).with_name("godot-mcp-requirements.txt"))], check=True)
    inventory = {}
    for path in sorted((destination / "plugin").rglob("*")):
        if path.is_file():
            inventory[str(path.relative_to(destination))] = hashlib.sha256(path.read_bytes()).hexdigest()
    (destination / "installation.json").write_text(json.dumps({"version": VERSION, "archiveSha256": SHA256, "files": inventory}, indent=2) + "\n")
except BaseException:
    shutil.rmtree(destination)
    raise
print(json.dumps({"version": VERSION, "directory": str(destination)}))
