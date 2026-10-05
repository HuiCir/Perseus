"""Independent execution providers. No task policies, tool classification or merge path."""
import json
import subprocess
import threading
import time
import uuid


class WorkCopies:
    def __init__(self, create, execute, destroy):
        self.create = create
        self.execute_native = execute
        self.destroy = destroy
        self.condition = threading.Condition()
        self.scopes = {}
        self.closed_ids = set()
        self.closed = False

    def open(self, scope_id):
        if not isinstance(scope_id, str) or not scope_id:
            raise ValueError("Scope identity required")
        with self.condition:
            if self.closed or scope_id in self.closed_ids or scope_id in self.scopes:
                raise ValueError("Scope already opened or closed")
            state = {"opening": True, "active": 0, "closing": False}
            self.scopes[scope_id] = state
        started = time.time() * 1000
        try:
            native = self.create()
            state.update(native=native, provenance={"kind": "independent_work_copy",
                "scopeId": scope_id, "authoritative": False,
                "snapshotStartedAt": started, "snapshotFinishedAt": time.time() * 1000})
        except BaseException as error:
            state["error"] = str(error)
            raise
        finally:
            with self.condition:
                state["opening"] = False
                self.condition.notify_all()
        return {"ok": True, "provenance": state["provenance"]}

    def execute(self, scope_id, payload):
        with self.condition:
            state = self.scopes.get(scope_id)
            if not state or state["opening"] or state["closing"] or "error" in state or self.closed:
                raise ValueError("Acquisition scope is not executable")
            state["active"] += 1
        try:
            return self.execute_native(state["native"], payload)
        finally:
            with self.condition:
                state["active"] -= 1
                self.condition.notify_all()

    def close(self, scope_id):
        with self.condition:
            self.closed_ids.add(scope_id)
            state = self.scopes.get(scope_id)
            if not state:
                return {"ok": True}
            while state["closing"]:
                self.condition.wait()
                if scope_id not in self.scopes:
                    return {"ok": True}
            state["closing"] = True
            while state["opening"] or state["active"]:
                self.condition.wait()
        try:
            if "native" in state:
                self.destroy(state["native"])
        except BaseException:
            with self.condition:
                state["closing"] = False
                self.condition.notify_all()
            raise
        else:
            with self.condition:
                self.scopes.pop(scope_id, None)
                self.condition.notify_all()
        return {"ok": True}

    def shutdown(self):
        with self.condition:
            self.closed = True
            identities = list(self.scopes)
        for identity in identities:
            self.close(identity)


def native_state_copies(snapshot, execute):
    """snapshot must copy the real state under its native atomic-operation lock."""
    return WorkCopies(snapshot, execute, lambda _state: None)


def docker_work_copies(container, execute, *, network="none"):
    """Full container filesystem copies without pausing the authoritative container.

    Snapshot intervals are reported, not claimed to be atomic point-in-time views.
    Volumes are rejected because Docker commit does not copy them. Network services
    need their own independent provider; this local-workspace provider is offline.
    """
    def command(args):
        return subprocess.check_output(["docker", *args], text=True).strip()

    info = json.loads(command(["inspect", container]))[0]
    if info.get("Mounts"):
        raise ValueError("Volume-backed state requires an explicit snapshot provider")
    if network != "none":
        raise ValueError("External service state is not isolated by a filesystem copy")
    commit_help = command(["commit", "--help"])
    no_pause = "--no-pause" if "--no-pause" in commit_help else "--pause=false"

    def create():
        image = "perseus-se-image-" + uuid.uuid4().hex
        name = "perseus-se-copy-" + uuid.uuid4().hex
        try:
            command(["commit", no_pause, container, image])
            command(["run", "-d", "--init", "--pull", "never", "--network", network,
                     "--name", name, image, "sh", "-c", "while :; do sleep 3600; done"])
            return {"container": name, "image": image}
        except BaseException:
            subprocess.run(["docker", "rm", "-f", name], capture_output=True)
            subprocess.run(["docker", "image", "rm", image], capture_output=True)
            raise

    def destroy(state):
        command(["rm", "-f", state["container"]])
        command(["image", "rm", state["image"]])

    return WorkCopies(create, lambda state, payload: execute(state["container"], payload), destroy)
