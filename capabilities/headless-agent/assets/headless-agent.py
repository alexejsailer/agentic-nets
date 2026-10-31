#!/usr/bin/env python3
"""headless-agent: run a headless CLI agent (Claude Code, Codex) in a folder, once, under a profile.

One runner for every package that needs a coder (docs/plans/explorer-architecture-fit-2026-10-15.md,
Phase 2 item 8). The caller's lane renders a command token; the profile, the folder and the prompt
arrive as environment variables:

  HA_PROFILE     the profile token's data as JSON (see below)              required, or
  HA_PROFILE_B64 the same JSON, base64-encoded (a value no template or reader can reshape)
  HA_ROOT        the folder the agent works in (~ allowed)                  required
  HA_PROMPT      the task                                                   required
  HA_MODEL       the agent's model; empty: the profile's defaultModel
  HA_RESULT_KEY  the agent ends its reply with one line "<key>: {json}"    default CODER_RESULT
  HA_MCP_URL     an MCP server the agent may use (HTTP)                     optional
  HA_MCP_TOOLS   the tools of that server it may call, comma separated     required with HA_MCP_URL
  HA_MCP_SERVER  the server's name for the agent                           default agenticnets
  HA_MCP_TOKEN_ENV  the variable holding the server's bearer token         default AGENTICNETS_MCP_TOKEN
  HA_TIMEOUT_MIN overrides the profile's timeoutMin

A profile: {profileId, title, family: claude-code | codex, command: [argv with {model}, {allowedTools},
{disallowedTools}, {maxTurns} placeholders ($-prefixed forms are accepted too)], promptVia: stdin | argv,
resultFormat: claude-json | text, mode: read-only | write, defaultModel, allowedTools, maxTurns,
timeoutMin, mcp: true | false}.

The runner, not the profile, enforces the mode. read-only: a claude-code profile keeps only the
reading tools (and the allowed MCP tools) and always passes the write and shell tools as disallowed; a
codex profile always runs in the read-only sandbox and gets no MCP server (it cannot be limited to
the allowed tools). The agent never sees a token in its environment: an MCP server reaches it as a
private config file, the token variables are removed from its environment.

Prints exactly one JSON object: {ok, exitCode, agentId, profileId, mode, model, report, text, stderr,
durationSec, costUsd, turns, error?}. Exit code 0 even when the agent failed: the lane records it.

usage: headless-agent.py run | check
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

READ_TOOLS = ("Read", "Grep", "Glob", "LS", "NotebookRead")
WRITE_AND_SHELL = ("Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch")
FORBIDDEN_FLAGS = ("--dangerously-skip-permissions", "--permission-mode", "--dangerously-bypass-approvals-and-sandbox",
                   "--yolo", "--full-auto")
TOOL_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_-]{0,63}$")
STRIP_ENV = ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "AGENTICNETS_MCP_URL")


class Refused(Exception):
    """The profile or the request cannot be run safely as asked."""


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def as_list(v):
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str) and v.strip():
        s = v.strip()
        if s.startswith("["):
            try:
                return [str(x) for x in json.loads(s)]
            except ValueError:
                pass
        return [x.strip() for x in s.split(",") if x.strip()]
    return []


def load_profile(raw):
    if not raw or not raw.strip():
        raise Refused("no profile: HA_PROFILE is empty")
    try:
        p = json.loads(raw)
    except ValueError as e:
        raise Refused("the profile is not JSON: %s" % e)
    if not isinstance(p, dict):
        raise Refused("the profile must be an object")
    p["command"] = as_list(p.get("command"))
    if not p["command"]:
        raise Refused("profile %s has no command" % p.get("profileId", "?"))
    mode = str(p.get("mode") or "read-only")
    if mode not in ("read-only", "write"):
        raise Refused("profile mode must be read-only or write, not %s" % mode)
    p["mode"] = mode
    family = str(p.get("family") or "").strip()
    if not family:
        binary = os.path.basename(p["command"][0])
        family = "codex" if binary == "codex" else "claude-code" if binary == "claude" else ""
    p["family"] = family
    return p


def placeholder(argv, name, value):
    out = []
    for a in argv:
        out.append(a.replace("${%s}" % name, value).replace("{%s}" % name, value))
    return out


def plan(profile, env):
    """The argv, the stdin text and the extra files of one run; Refused when it cannot be run safely."""
    mode, family = profile["mode"], profile["family"]
    argv = list(profile["command"])
    model = (env.get("HA_MODEL") or "").strip() or str(profile.get("defaultModel") or "")
    allowed = as_list(profile.get("allowedTools"))
    mcp_url = (env.get("HA_MCP_URL") or "").strip()
    if not mcp_url and str(profile.get("mcp")).strip().lower() == "true":
        mcp_url = (env.get("AGENTICNETS_MCP_URL") or "").strip()
    mcp_tools = as_list(env.get("HA_MCP_TOOLS"))
    server = (env.get("HA_MCP_SERVER") or "agenticnets").strip()
    if mcp_url and not mcp_tools:
        raise Refused("an MCP server needs its allowed tools (HA_MCP_TOOLS); a missing list would mean every tool")
    for t in mcp_tools:
        if not TOOL_NAME.match(t):
            raise Refused("'%s' is not a tool name" % t)
    if not re.match(r"^[a-z][a-z0-9-]{0,31}$", server):
        raise Refused("'%s' is not a server name" % server)
    if mcp_url and str(profile.get("mcp")).strip().lower() == "false":
        raise Refused("profile %s takes no MCP server" % profile.get("profileId", "?"))
    if mode == "read-only" and family not in ("claude-code", "codex"):
        raise Refused("read-only can only be enforced for claude-code and codex profiles, not '%s'" % (family or "unknown"))
    if mode == "read-only":
        for a in argv:
            for f in FORBIDDEN_FLAGS:
                if a == f or a.startswith(f + "="):
                    raise Refused("a read-only profile may not pass %s" % f)
    mcp_names = ["mcp__%s__%s" % (server, t) for t in mcp_tools] if mcp_url else []
    disallowed = as_list(profile.get("disallowedTools"))
    if family == "claude-code":
        if mode == "read-only":
            allowed = [t for t in (allowed or list(READ_TOOLS[:3])) if t in READ_TOOLS]
            disallowed = sorted(set(disallowed) | set(WRITE_AND_SHELL))
            if not any("{allowedTools}" in a for a in argv) or not any("{disallowedTools}" in a for a in argv):
                raise Refused("a read-only claude-code profile must pass {allowedTools} and {disallowedTools}")
        allowed = allowed + mcp_names
        argv = placeholder(argv, "allowedTools", ",".join(allowed))
        argv = placeholder(argv, "disallowedTools", ",".join(disallowed))
    elif family == "codex":
        if mcp_url:
            raise Refused("codex cannot be limited to the allowed MCP tools; it would reach every tool of the server")
        if mode == "read-only":
            fixed, i = [], 0
            while i < len(argv):
                if argv[i] == "--sandbox" and i + 1 < len(argv):
                    i += 2
                    continue
                if argv[i].startswith("--sandbox="):
                    i += 1
                    continue
                fixed.append(argv[i])
                i += 1
            # the sandbox goes right after the subcommand, before the prompt marker
            at = 2 if len(fixed) > 1 and fixed[1] == "exec" else 1
            argv = fixed[:at] + ["--sandbox", "read-only"] + fixed[at:]
    argv = placeholder(argv, "model", model)
    argv = placeholder(argv, "maxTurns", str(profile.get("maxTurns") or "40"))
    # an option whose value stayed empty (no model configured) is dropped with its value
    cleaned, i = [], 0
    while i < len(argv):
        if argv[i].startswith("--") and i + 1 < len(argv) and argv[i + 1] == "" and argv[i] in ("--model", "--max-turns"):
            i += 2
            continue
        cleaned.append(argv[i])
        i += 1
    return {"argv": cleaned, "model": model, "mcpUrl": mcp_url, "mcpServer": server, "mcpNames": mcp_names}


def child_env(env, token_env):
    out = {}
    for k, v in env.items():
        if k in STRIP_ENV or k.startswith("HA_") or k == token_env or k.endswith("_MCP_TOKEN"):
            continue
        out[k] = v
    return out


def profile_text(env):
    raw = env.get("HA_PROFILE") or ""
    if not raw.strip() and (env.get("HA_PROFILE_B64") or "").strip():
        try:
            raw = base64.b64decode(env["HA_PROFILE_B64"].strip()).decode("utf-8")
        except (ValueError, UnicodeDecodeError) as e:
            raise Refused("HA_PROFILE_B64 is not base64 JSON: %s" % e)
    return raw


def context_object(raw):
    # Script args.input may arrive as a JSON object or as JSON text encoded once by the template.
    for _ in range(3):
        if isinstance(raw, dict): return raw
        if not isinstance(raw, str): break
        raw = json.loads(raw)
    raise Refused("model context must be a JSON object")


def write_context(workspace, context):
    """Searchable index and per-net files: no whole-model prompt or environment limit."""
    summary = json.loads(json.dumps(context))
    snapshot = summary.get("snapshot")
    def save(name, value):
        path = os.path.join(workspace, name)
        with open(path, "w", encoding="utf-8") as out: json.dump(value, out, ensure_ascii=False, indent=2)
    if isinstance(snapshot, dict) and isinstance(snapshot.get("nets"), dict):
        nets = snapshot.pop("nets")
        snapshot.pop("fingerprints", None)
        index = {k: snapshot.pop(k) for k in ("levels", "hierarchy", "relations", "sharedPlaces") if k in snapshot}
        entries = {item["key"]: item for item in snapshot.pop("index", []) if isinstance(item, dict) and "key" in item}
        os.mkdir(os.path.join(workspace, "nets"))
        for key, value in nets.items():
            filename = "nets/" + hashlib.sha256(key.encode()).hexdigest() + ".json"
            save(filename, value)
            entries.setdefault(key, {"key": key})["file"] = filename
        index["nets"] = list(entries.values())
        save("model-index.json", index)
        snapshot["indexFile"] = "model-index.json"
    save("model-round.json", summary)


def source_snapshot(root):
    """Fingerprint source files without changing git or recording file contents."""
    git_env = dict(os.environ, GIT_OPTIONAL_LOCKS="0")
    listing = subprocess.run(["git", "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
                             capture_output=True, env=git_env, timeout=30) if shutil.which("git") else None
    dirty = []
    if listing is not None and listing.returncode == 0:
        paths = [os.fsdecode(p) for p in listing.stdout.split(b"\0") if p]
        status = subprocess.run(["git", "-C", root, "status", "--porcelain=v1", "-z", "--", "."], capture_output=True, env=git_env, timeout=30)
        entries = status.stdout.split(b"\0"); i = 0
        while i < len(entries):
            entry = os.fsdecode(entries[i]); i += 1
            if not entry: continue
            dirty.append({"path": entry[3:], "status": entry[:2]})
            if "R" in entry[:2] or "C" in entry[:2]: i += 1
    else:
        paths = []
        ignored = {".git", "node_modules", ".build", "DerivedData", ".venv", "__pycache__", ".gradle", "target", "dist"}
        for folder, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = [d for d in dirs if d not in ignored and not os.path.islink(os.path.join(folder, d))]
            paths.extend(os.path.relpath(os.path.join(folder, f), root) for f in files)
    if len(paths) > 20000: raise Refused("the source folder exceeds the implementation audit's 20000-file limit")
    files, total = {}, 0
    for relative in sorted(set(paths)):
        full = os.path.abspath(os.path.join(root, relative))
        if os.path.commonpath([root, full]) != root: raise Refused("a source path leaves the configured folder")
        if os.path.islink(full):
            files[relative] = hashlib.sha256(os.fsencode(os.readlink(full))).hexdigest(); continue
        if not os.path.isfile(full): continue
        total += os.path.getsize(full)
        if total > 512 * 1024 * 1024: raise Refused("the source folder exceeds the implementation audit's 512 MB limit")
        digest = hashlib.sha256()
        with open(full, "rb") as content:
            for chunk in iter(lambda: content.read(1024 * 1024), b""): digest.update(chunk)
        files[relative] = digest.hexdigest()
    return files, dirty


def audited_implementation(env):
    root = os.path.realpath(os.path.expanduser(env.get("HA_ROOT") or ""))
    if not (env.get("HA_ROOT") or "").strip() or not os.path.isdir(root): raise Refused("implementation needs an existing configured source folder")
    if load_profile(profile_text(env))["mode"] != "write": raise Refused("implementation needs a write profile")
    before, dirty = source_snapshot(root)
    local = dict(env, HA_IMPLEMENTATION_AUDITED="true")
    try:
        result = run(local)
    except Exception as exc:
        result = {"ok": False, "exitCode": 1, "mode": "write", "error": str(exc)}
    try:
        after, _ = source_snapshot(root)
        changes = [{"path": path, "change": "added" if path not in before else "deleted" if path not in after else "modified",
                    "beforeSha256": before.get(path), "afterSha256": after.get(path)}
                   for path in sorted(set(before) | set(after)) if before.get(path) != after.get(path)]
        result["workspace"] = {"captured": True, "root": root, "changes": changes, "preExistingChanges": dirty}
    except Exception as exc:
        result["ok"] = False; result["error"] = "Could not record the final source state: " + str(exc)
        result["workspace"] = {"captured": False, "root": root, "preExistingChanges": dirty}
    return result


def run(env, context=None):
    if context is None and (env.get("HA_CONTEXT_JSON") or "").strip():
        context = context_object(env["HA_CONTEXT_JSON"])
    # Sources stay in their configured root; all model evidence is staged outside it for both modes.
    if context is not None:
        context = context_object(context)
        phase = context.get("job", {}).get("phase")
        profile = load_profile(profile_text(env))
        if phase in ("question", "investigate", "refine") and profile["mode"] != "read-only":
            raise Refused("question and layer-refinement runs require a read-only source profile")
        if phase == "implement" and (profile["mode"] != "write" or not (env.get("HA_ROOT") or "").strip()):
            raise Refused("implementation requires a write profile and an explicit source folder")
        with tempfile.TemporaryDirectory(prefix="headless-model-") as workspace:
            write_context(workspace, context)
            local = dict(env)
            local.pop("HA_CONTEXT_JSON", None)
            local["HA_ROOT"] = (env.get("HA_ROOT") or "").strip() or workspace
            if phase == "implement": local["HA_IMPLEMENTATION"] = "true"
            local["HA_PROMPT"] = (env.get("HA_PROMPT") or "") + "\nMODEL_CONTEXT_DIR: " + workspace + \
                "\nRead model-round.json there first, then model-index.json when present. Follow its per-net file references using absolute paths under MODEL_CONTEXT_DIR."
            return run(local)
    if env.get("HA_IMPLEMENTATION") == "true" and env.get("HA_IMPLEMENTATION_AUDITED") != "true":
        return audited_implementation(env)
    started = time.time()
    profile = load_profile(profile_text(env))
    root = (env.get("HA_ROOT") or "").strip()
    if not root:
        raise Refused("no folder: HA_ROOT is empty")
    root = os.path.expanduser(root)
    if not os.path.isdir(root):
        raise Refused("the folder %s does not exist on this executor" % root)
    prompt = env.get("HA_PROMPT") or ""
    if not prompt.strip():
        raise Refused("no task: HA_PROMPT is empty")
    p = plan(profile, env)
    binary = p["argv"][0]
    if not shutil.which(binary):
        raise Refused("%s is not on this executor's PATH" % binary)
    token_env = (env.get("HA_MCP_TOKEN_ENV") or "AGENTICNETS_MCP_TOKEN").strip()
    tmp = tempfile.mkdtemp(prefix="headless-agent-")
    try:
        argv = list(p["argv"])
        if p["mcpUrl"] or (profile["family"] == "claude-code" and env.get("HA_IMPLEMENTATION") == "true"):
            token = (env.get(token_env) or "").strip()
            if p["mcpUrl"] and not token:
                raise Refused("no token for the MCP server (%s on the lane)" % token_env)
            cfg = os.path.join(tmp, "mcp.json")
            fd = os.open(cfg, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                servers = {p["mcpServer"]: {"type": "http", "url": p["mcpUrl"], "headers": {"Authorization": "Bearer " + token}}} if p["mcpUrl"] else {}
                json.dump({"mcpServers": servers}, f)
            argv[1:1] = ["--mcp-config", cfg, "--strict-mcp-config"]
        stdin_text = prompt
        if str(profile.get("promptVia") or "stdin") == "argv":
            argv.append(prompt)
            stdin_text = None
        timeout_min = env.get("HA_TIMEOUT_MIN") or profile.get("timeoutMin") or 30
        try:
            timeout_s = max(30, int(float(timeout_min) * 60))
        except ValueError:
            timeout_s = 1800
        try:
            proc = subprocess.run(argv, cwd=root, env=child_env(env, token_env), input=stdin_text,
                                  capture_output=True, text=True, timeout=timeout_s)
            rc, out, err = proc.returncode, proc.stdout or "", proc.stderr or ""
            timed_out = False
        except subprocess.TimeoutExpired as e:
            rc, timed_out = 124, True
            out = (e.stdout or b"").decode("utf-8", "replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
            err = (e.stderr or b"").decode("utf-8", "replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    text, cost, turns, is_error = out, "", "", rc != 0
    if str(profile.get("resultFormat") or "text") == "claude-json":
        try:
            j = json.loads(out.strip().splitlines()[-1]) if out.strip() else {}
            text = str(j.get("result", ""))
            cost = str(j.get("total_cost_usd", "") or "")
            turns = str(j.get("num_turns", "") or "")
            is_error = bool(j.get("is_error", False)) or rc != 0
        except (ValueError, IndexError):
            text = out
    key = (env.get("HA_RESULT_KEY") or "CODER_RESULT").strip()
    report = None
    for line in reversed(text.splitlines()):
        s = line.strip()
        if s.startswith(key + ":"):
            try:
                report = json.loads(s.split(":", 1)[1].strip())
            except ValueError:
                report = {"unparsed": s[:2000]}
            break
    result = {"ok": not is_error and not timed_out, "exitCode": rc, "agentId": profile.get("profileId") or profile.get("agentId"),
              "profileId": profile.get("profileId"), "mode": profile["mode"], "model": p["model"], "report": report,
              "text": text[-6000:], "stderr": err[-2000:], "durationSec": round(time.time() - started),
              "costUsd": cost, "turns": turns}
    if timed_out:
        result["error"] = "the agent did not finish within %d minutes" % (timeout_s // 60)
    return result


def check(env):
    profile = load_profile(profile_text(env))
    binary = profile["command"][0]
    return {"ok": bool(shutil.which(binary)), "profileId": profile.get("profileId"), "binary": binary,
            "path": shutil.which(binary) or None, "mode": profile["mode"], "family": profile["family"]}


def main(argv):
    action = argv[1] if len(argv) > 1 else "run"
    try:
        if action == "run":
            emit(run(dict(os.environ)))
        elif action == "run-context":
            raw = sys.stdin.buffer.read(32 * 1024 * 1024 + 1)
            if len(raw) > 32 * 1024 * 1024: raise Refused("model context exceeds the runner's 32 MB input limit")
            emit(run(dict(os.environ), context_object(raw.decode("utf-8"))))
        elif action == "check":
            emit(check(dict(os.environ)))
        else:
            emit({"ok": False, "error": "usage: headless-agent.py run | check"})
    except Refused as e:
        emit({"ok": False, "refused": True, "error": str(e)})
    except Exception as e:  # noqa: BLE001 - the lane records every failure as a result
        emit({"ok": False, "error": "%s: %s" % (type(e).__name__, e)})
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
