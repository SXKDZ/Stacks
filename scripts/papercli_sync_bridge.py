"""Dependency-free OneDrive sync bridge for Paper Assistant.

The bridge mirrors PaperCLI's directory-based sync contract: papers.db, PDFs,
and HTML snapshots are synchronized under lock. The selected conflict policy
decides which database/file wins; keep_both preserves timestamped conflict
copies before choosing the newest database as the shared canonical copy.
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
    parser = argparse.ArgumentParser(description="Sync a PaperCLI library")
    parser.add_argument("--local", required=True)
    parser.add_argument("--remote", required=True)
    parser.add_argument(
        "--policy",
        choices=("local", "remote", "keep_both"),
        default="keep_both",
    )
    parser.add_argument("--auto", action="store_true")
    return parser.parse_args()


def database_target(value):
    path = Path(value).expanduser().resolve()
    if path.suffix.lower() in (".db", ".sqlite"):
        return path.parent, path
    return path, path / "papers.db"


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
    """Use SQLite backup so a source database is copied consistently."""
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
    raise RuntimeError("Another PaperCLI sync is already running.")


@contextmanager
def sync_locks(local_directory, remote_directory):
    lock_paths = [
        local_directory / ".papercli_sync.lock",
        remote_directory / ".papercli_sync.lock",
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


def conflict_name(path, label):
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return path.with_name("{}.{}-{}{}".format(path.stem, label, stamp, path.suffix))


def sync_database(local_database, remote_database, policy, result):
    result["progress"].append({"message": "Comparing PaperCLI databases"})
    if not remote_database.exists():
        copy_database(local_database, remote_database)
        count = paper_count(local_database)
        result["changes"]["papers_added"] += count
        result["details"]["papers_added"].append(
            "Initialized remote database with {} papers".format(count)
        )
        return
    if database_hash(local_database) == database_hash(remote_database):
        return

    count = max(paper_count(local_database), paper_count(remote_database))
    if policy == "remote":
        copy_database(remote_database, local_database)
        result["changes"]["papers_updated"] += count
        result["details"]["papers_updated"].append("Remote database applied locally")
        return
    if policy == "keep_both":
        local_backup = conflict_name(local_database, "remote")
        remote_backup = conflict_name(remote_database, "local")
        copy_database(remote_database, local_backup)
        copy_database(local_database, remote_backup)
        result["changes"]["conflict_backups"] += 2
        result["details"]["conflict_backups"].extend(
            [local_backup.name, remote_backup.name]
        )
        result["conflicts"] += 1
        if remote_database.stat().st_mtime > local_database.stat().st_mtime:
            copy_database(remote_database, local_database)
            result["details"]["papers_updated"].append(
                "Newest remote database applied; both originals were backed up"
            )
        else:
            copy_database(local_database, remote_database)
            result["details"]["papers_updated"].append(
                "Newest local database applied; both originals were backed up"
            )
        result["changes"]["papers_updated"] += count
        return

    copy_database(local_database, remote_database)
    result["changes"]["papers_updated"] += count
    result["details"]["papers_updated"].append("Local database applied remotely")


def asset_files(directory, suffix):
    if not directory.exists():
        return {}
    return {
        path.name: path
        for path in directory.iterdir()
        if path.is_file() and path.suffix.lower() == suffix
    }


def remote_variant(name, existing):
    path = Path(name)
    candidate = "{}_remote{}".format(path.stem, path.suffix)
    index = 2
    while candidate in existing:
        candidate = "{}_remote_{}{}".format(path.stem, index, path.suffix)
        index += 1
    return candidate


def sync_assets(local_directory, remote_directory, suffix, kind, policy, result):
    local_directory.mkdir(parents=True, exist_ok=True)
    remote_directory.mkdir(parents=True, exist_ok=True)
    local_files = asset_files(local_directory, suffix)
    remote_files = asset_files(remote_directory, suffix)
    result["progress"].append({"message": "Synchronizing {} files".format(kind)})
    copied_key = "pdfs_copied" if kind == "PDF" else "html_snapshots_copied"

    for name in sorted(set(local_files) | set(remote_files)):
        local_path = local_files.get(name)
        remote_path = remote_files.get(name)
        if local_path is None and remote_path is not None:
            copy_file(remote_path, local_directory / name)
            result["changes"][copied_key] += 1
            result["details"][copied_key].append("{} from remote".format(name))
            continue
        if remote_path is None and local_path is not None:
            copy_file(local_path, remote_directory / name)
            result["changes"][copied_key] += 1
            result["details"][copied_key].append("{} to remote".format(name))
            continue
        if local_path is None or remote_path is None:
            continue
        if file_hash(local_path) == file_hash(remote_path):
            continue

        result["conflicts"] += 1
        if policy == "remote":
            copy_file(remote_path, local_path)
            result["changes"][copied_key] += 1
            result["details"][copied_key].append("{} resolved from remote".format(name))
        elif policy == "keep_both":
            variant = remote_variant(name, set(local_files) | set(remote_files))
            copy_file(remote_path, local_directory / variant)
            copy_file(remote_path, remote_directory / variant)
            copy_file(local_path, remote_path)
            result["changes"][copied_key] += 2
            result["details"][copied_key].append(
                "{} kept with remote variant {}".format(name, variant)
            )
        else:
            copy_file(local_path, remote_path)
            result["changes"][copied_key] += 1
            result["details"][copied_key].append("{} resolved from local".format(name))


def main():
    args = parse_args()
    local_directory, local_database = database_target(args.local)
    remote_directory, remote_database = database_target(args.remote)
    if not local_database.exists():
        raise FileNotFoundError(
            "PaperCLI database not found at {}".format(local_database)
        )
    if local_directory == remote_directory:
        raise ValueError("Local and remote PaperCLI directories must be different.")

    policy = "local" if args.auto else args.policy
    detail_keys = (
        "papers_added",
        "papers_updated",
        "pdfs_copied",
        "html_snapshots_copied",
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
        sync_database(local_database, remote_database, policy, result)
        sync_assets(
            local_directory / "pdfs",
            remote_directory / "pdfs",
            ".pdf",
            "PDF",
            policy,
            result,
        )
        sync_assets(
            local_directory / "html_snapshots",
            remote_directory / "html_snapshots",
            ".html",
            "HTML snapshot",
            policy,
            result,
        )

    total = sum(result["changes"].values())
    if total:
        result["summary"] = "Sync completed with {} changes".format(total)
    else:
        result["summary"] = "Local and OneDrive libraries are already in sync"
    result["logs"].append(
        {
            "action": "sync_complete",
            "details": "{} in {:.2f}s using {} policy".format(
                result["summary"], time.time() - started, policy
            ),
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
                    "summary": "Sync failed",
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
