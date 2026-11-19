"""Register a built FidelityFX Native Messaging helper with Chrome and Chromium."""

import argparse
import json
import os
from pathlib import Path
import re
import sys
from tempfile import NamedTemporaryFile


HOST = "com.kittyplays.fidelityfx"


def write_manifest(directory, manifest):
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"{HOST}.json"
    with NamedTemporaryFile(mode="w", encoding="utf-8", dir=directory, delete=False) as temporary:
        json.dump(manifest, temporary, indent=2)
        temporary.write("\n")
    try:
        os.replace(temporary.name, path)
    finally:
        Path(temporary.name).unlink(missing_ok=True)
    return path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--extension-id", required=True)
    parser.add_argument("--helper", type=Path, required=True)
    args = parser.parse_args()
    if not re.fullmatch("[a-p]{32}", args.extension_id):
        parser.error("Copy the 32-character extension ID from chrome://extensions")
    helper = args.helper.resolve()
    if not helper.is_file() or not os.access(helper, os.X_OK):
        parser.error(f"Built helper must be executable: {helper}")

    manifest = {
        "name": HOST,
        "description": "KittyPlays AMD FidelityFX helper",
        "path": str(helper),
        "type": "stdio",
        "allowed_origins": [f"chrome-extension://{args.extension_id}/"],
    }
    if sys.platform == "win32":
        import winreg

        path = write_manifest(Path(os.environ["LOCALAPPDATA"]) / "KittyPlays", manifest)
        for vendor in [r"Google\Chrome", "Chromium"]:
            key = rf"Software\{vendor}\NativeMessagingHosts\{HOST}"
            with winreg.CreateKey(winreg.HKEY_CURRENT_USER, key) as handle:
                winreg.SetValueEx(handle, "", 0, winreg.REG_SZ, str(path))
        print(path)
    elif sys.platform.startswith("linux"):
        config = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
        for browser in ["google-chrome", "chromium"]:
            print(write_manifest(config / browser / "NativeMessagingHosts", manifest))
    else:
        parser.error("FidelityFX helper registration is available on Linux and Windows")


if __name__ == "__main__":
    main()
