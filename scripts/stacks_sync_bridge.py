"""Dependency-free OneDrive backup bridge for Paper Assistant.

The live library is a local SQLite file and its PDF/HTML assets. This bridge
writes a one-way, consistent backup of that library into a OneDrive folder: a
transactionally-consistent copy of `library.db` plus mirrored PDFs and HTML
snapshots. It never reads from or writes to the live library beyond taking the
snapshot, and it never modifies the OneDrive copy's contents back onto the
local library. Restoring from a backup is an explicit, manual, offline
operation.
"""

import argparse
import hashlib
import json
import os
import shutil
import socket
import sqlite3
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path


def parse_args():
    parser = argparse.ArgumentParser(description="Back up a Stacks library to OneDrive")
    parser.add_argument("--local", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--remote", required=True)
    # Accepted for backward compatibility; this bridge is always a one-way backup.
    parser.add_argument("--policy", choices=("local",), default="local")
    parser.add_argument("--auto", action="store_true")
    return parser.parse_args()


def file_hash(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def database_hash(path):
    """Hash logical SQLite contents so backup/header differences do not conflict."""
    digest = hashlib.sha256()
    connection = sqlite3.connect(str(path), timeout=30)
    try:
        for statement in connection.iterdump():
            digest.update(statement.encode("utf8"))
            digest.update(b"\n")
    finally:
        connection.close()
    return digest.hexdigest()


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        ".{}.{}.syncing".format(destination.name, uuid.uuid4().hex)
    )
    shutil.copy2(str(source), str(temporary))
    os.replace(str(temporary), str(destination))


def copy_database(source, destination):
    """Use SQLite backup so the source database is copied consistently."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(
        ".{}.{}.syncing".format(destination.name, uuid.uuid4().hex)
    )
    source_connection = sqlite3.connect(str(source), timeout=30)
    destination_connection = sqlite3.connect(str(temporary), timeout=30)
    try:
        source_connection.backup(destination_connection)
        destination_connection.commit()
    finally:
        destination_connection.close()
        source_connection.close()
    os.replace(str(temporary), str(destination))


def paper_count(database):
    try:
        connection = sqlite3.connect(str(database))
        try:
            return int(connection.execute("SELECT COUNT(*) FROM papers").fetchone()[0])
        finally:
            connection.close()
    except Exception:
        return 0


def process_running(process_id):
    if not process_id:
        return False
    try:
        os.kill(int(process_id), 0)
        return True
    except (OSError, ValueError):
        return False


def clear_stale_lock(path):
    if not path.exists():
        return
    try:
        data = json.loads(path.read_text(encoding="utf8"))
        timestamp = datetime.fromisoformat(data.get("timestamp", ""))
        age = (datetime.now() - timestamp).total_seconds()
        if age > 1800 or not process_running(data.get("process_id")):
            path.unlink()
            return
    except Exception:
        path.unlink()
        return
    raise RuntimeError("Another Stacks backup is already running.")


@contextmanager
def sync_locks(local_directory, remote_directory):
    lock_paths = [
        local_directory / ".stacks_sync.lock",
        remote_directory / ".stacks_sync.lock",
    ]
    for path in lock_paths:
        path.parent.mkdir(parents=True, exist_ok=True)
        clear_stale_lock(path)
    lock_data = json.dumps(
        {
            "process_id": os.getpid(),
            "timestamp": datetime.now().isoformat(),
            "hostname": socket.gethostname(),
            "client": "Paper Assistant",
        }
    )
    try:
        for path in lock_paths:
            path.write_text(lock_data, encoding="utf8")
        yield
    finally:
        for path in lock_paths:
            try:
                path.unlink()
            except OSError:
                pass


def backup_database(local_database, remote_database, result):
    """Write a consistent copy of the live database to the backup folder."""
    result["progress"].append({"message": "Backing up the Stacks database"})
    if remote_database.exists() and database_hash(local_database) == database_hash(remote_database):
        return
    copy_database(local_database, remote_database)
    count = paper_count(local_database)
    if remote_database.exists():
        result["changes"]["papers_updated"] += count
        result["details"]["papers_updated"].append(
            "Backed up database with {} papers".format(count)
        )
    else:
        result["changes"]["papers_added"] += count
        result["details"]["papers_added"].append(
            "Initialized backup with {} papers".format(count)
        )


def asset_files(directory, suffixes):
    if not directory.exists():
        return {}
    if isinstance(suffixes, str):
        suffixes = (suffixes,)
    return {
        path.name: path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() in suffixes
    }


def backup_assets(local_directory, remote_directory, suffix, kind, result):
    """Copy any new or changed local assets into the backup (one-way)."""
    local_directory.mkdir(parents=True, exist_ok=True)
    remote_directory.mkdir(parents=True, exist_ok=True)
    local_files = asset_files(local_directory, suffix)
    remote_files = asset_files(remote_directory, suffix)
    result["progress"].append({"message": "Backing up {} files".format(kind)})
    copied_key = "pdfs_copied" if kind == "PDF" else "html_snapshots_copied"

    for name, local_path in sorted(local_files.items()):
        remote_path = remote_files.get(name)
        if remote_path is not None and file_hash(local_path) == file_hash(remote_path):
            continue
        copy_file(local_path, remote_directory / name)
        result["changes"][copied_key] += 1
        result["details"][copied_key].append("{} backed up".format(name))


def backup_feed_attachments(local_root, remote_root, result):
    """Back up the AI feed's attachment tree (feed/<id>/attachments/*), which is
    nested unlike the flat pdfs/ and html_snapshots/ dirs, so it's walked
    recursively and mirrored one-way preserving the relative path."""
    if not local_root.exists():
        return
    result["progress"].append({"message": "Backing up feed attachments"})
    for local_path in sorted(local_root.rglob("*")):
        if not local_path.is_file():
            continue
        # Only mirror the attachment files, not agent transcripts or scratch.
        if "attachments" not in local_path.relative_to(local_root).parts:
            continue
        relative = local_path.relative_to(local_root)
        remote_path = remote_root / relative
        if remote_path.exists() and file_hash(local_path) == file_hash(remote_path):
            continue
        remote_path.parent.mkdir(parents=True, exist_ok=True)
        copy_file(local_path, remote_path)
        result["changes"]["feed_files_copied"] += 1
        result["details"]["feed_files_copied"].append("{} backed up".format(relative))


def main():
    args = parse_args()
    local_directory = Path(args.local).expanduser().resolve()
    local_database = Path(args.database).expanduser().resolve()
    remote_directory = Path(args.remote).expanduser().resolve()
    remote_database = remote_directory / "library.db"
    if not local_database.exists():
        raise FileNotFoundError(
            "Stacks library database not found at {}".format(local_database)
        )
    if local_directory == remote_directory:
        raise ValueError("The backup folder must be different from the live library.")

    detail_keys = (
        "papers_added",
        "papers_updated",
        "pdfs_copied",
        "html_snapshots_copied",
        "feed_files_copied",
        "conflict_backups",
    )
    result = {
        "ok": True,
        "summary": "",
        "changes": {key: 0 for key in detail_keys},
        "details": {key: [] for key in detail_keys},
        "conflicts": 0,
        "errors": [],
        "cancelled": False,
        "progress": [],
        "logs": [],
    }

    started = time.time()
    with sync_locks(local_directory, remote_directory):
        backup_database(local_database, remote_database, result)
        backup_assets(
            local_directory / "pdfs",
            remote_directory / "pdfs",
            ".pdf",
            "PDF",
            result,
        )
        backup_assets(
            local_directory / "html_snapshots",
            remote_directory / "html_snapshots",
            (".html", ".htm"),
            "HTML snapshot",
            result,
        )
        backup_feed_attachments(
            local_directory / "feed",
            remote_directory / "feed",
            result,
        )

    total = sum(result["changes"].values())
    if total:
        result["summary"] = "Backup completed with {} changes".format(total)
    else:
        result["summary"] = "The OneDrive backup is already up to date"
    result["logs"].append(
        {
            "action": "backup_complete",
            "details": "{} in {:.2f}s".format(result["summary"], time.time() - started),
        }
    )
    print(json.dumps(result, default=str))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(
            json.dumps(
                {
                    "ok": False,
                    "summary": "Backup failed",
                    "changes": {},
                    "details": {},
                    "conflicts": 0,
                    "errors": [str(error)],
                    "cancelled": False,
                    "progress": [],
                    "logs": [],
                }
            )
        )
        sys.exit(1)
