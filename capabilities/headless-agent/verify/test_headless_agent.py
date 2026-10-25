#!/usr/bin/env python3
"""Unit proof of the runner's rules with fake claude/codex binaries (no agent runs, no network).

usage: python3 verify/test_headless_agent.py   (exit 0 when every case passes)"""
import importlib.util
import json
import os
import stat
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ha", os.path.join(HERE, "..", "assets", "headless-agent.py"))
ha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ha)

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
cfg = None
if "--mcp-config" in sys.argv:
    cfg = json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1]))
seen = {"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt, "cfg": cfg,
        "env": sorted(k for k in os.environ if k.startswith(("HA_", "AGENTICNETS", "CLAUDE")) or k.endswith("_MCP_TOKEN"))}
result = "did it\nCODER_RESULT: " + json.dumps({"summary": "ok", "seen": seen})
if os.path.basename(sys.argv[0]) == "claude":
    print(json.dumps({"result": result, "total_cost_usd": 0.01, "num_turns": 3, "is_error": False}))
else:
    print(result)
'''

READ_ONLY_CLAUDE = {"profileId": "claude-read-only", "family": "claude-code", "mode": "read-only",
                    "command": ["claude", "-p", "--model", "{model}", "--allowedTools", "{allowedTools}",
                                "--disallowedTools", "{disallowedTools}", "--max-turns", "{maxTurns}",
                                "--no-session-persistence", "--output-format", "json"],
                    "promptVia": "stdin", "resultFormat": "claude-json", "defaultModel": "sonnet",
                    "allowedTools": "Read,Grep,Glob,Edit,Bash(git status:*)", "maxTurns": "30", "timeoutMin": "5", "mcp": True}
CODEX = {"profileId": "codex-read-only", "family": "codex", "mode": "read-only",
         "command": ["codex", "exec", "--model", "{model}", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"],
         "promptVia": "stdin", "resultFormat": "text", "defaultModel": "gpt-5-codex", "timeoutMin": "5"}

failures = []


def case(name, fn):
    try:
        fn()
        print("ok  ", name)
    except AssertionError as e:
        failures.append(name)
        print("FAIL", name, "-", e)


def setup():
    d = tempfile.mkdtemp()
    bindir = os.path.join(d, "bin")
    os.mkdir(bindir)
    for b in ("claude", "codex"):
        p = os.path.join(bindir, b)
        open(p, "w").write(FAKE)
        os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    root = os.path.join(d, "src")
    os.mkdir(root)
    env = {"PATH": bindir + os.pathsep + os.environ.get("PATH", ""), "HOME": d, "CLAUDECODE": "1",
           "OTHER_MCP_TOKEN": "leak", "HA_ROOT": root, "HA_PROMPT": "look at it"}
    return env, root


def run_with(profile, **extra):
    env, root = setup()
    env["HA_PROFILE"] = json.dumps(profile)
    env.update(extra)
    return ha.run(env), root


def t_read_only_claude_with_mcp():
    r, root = run_with(READ_ONLY_CLAUDE, HA_MCP_URL="http://127.0.0.1:8091/mcp", HA_MCP_TOOLS="explore_model,curate_model",
                       AGENTICNETS_MCP_TOKEN="secret")
    assert r["ok"], r
    seen = r["report"]["seen"]
    argv = seen["argv"]
    allowed = argv[argv.index("--allowedTools") + 1].split(",")
    assert allowed == ["Read", "Grep", "Glob", "mcp__agenticnets__explore_model", "mcp__agenticnets__curate_model"], allowed
    disallowed = argv[argv.index("--disallowedTools") + 1].split(",")
    for t in ("Bash", "Edit", "Write", "MultiEdit", "WebFetch", "WebSearch"):
        assert t in disallowed, (t, disallowed)
    assert "--strict-mcp-config" in argv
    assert seen["cfg"]["mcpServers"]["agenticnets"]["headers"]["Authorization"] == "Bearer secret"
    assert seen["env"] == [], seen["env"]          # no token, no HA_*, no CLAUDECODE in the agent's environment
    assert os.path.realpath(seen["cwd"]) == os.path.realpath(root)
    assert seen["prompt"] == "look at it"
    assert r["costUsd"] == "0.01" and r["turns"] == "3" and r["mode"] == "read-only"


def t_read_only_needs_the_placeholders():
    p = dict(READ_ONLY_CLAUDE, command=["claude", "-p", "--allowedTools", "Read,Edit"])
    try:
        run_with(p)
    except ha.Refused as e:
        assert "allowedTools" in str(e)
        return
    raise AssertionError("not refused")


def t_forbidden_flags():
    p = dict(READ_ONLY_CLAUDE, command=READ_ONLY_CLAUDE["command"] + ["--dangerously-skip-permissions"])
    try:
        run_with(p)
    except ha.Refused:
        return
    raise AssertionError("not refused")


def t_codex_sandbox_is_forced_and_mcp_refused():
    r, _ = run_with(CODEX)
    argv = r["report"]["seen"]["argv"]
    assert argv[:3] == ["exec", "--sandbox", "read-only"], argv
    assert "workspace-write" not in argv
    try:
        run_with(CODEX, HA_MCP_URL="http://x/mcp", HA_MCP_TOOLS="explore_model", AGENTICNETS_MCP_TOKEN="t")
    except ha.Refused as e:
        assert "codex" in str(e)
        return
    raise AssertionError("codex with MCP not refused")


def t_write_mode_keeps_the_profile_tools():
    p = dict(READ_ONLY_CLAUDE, mode="write")
    r, _ = run_with(p)
    argv = r["report"]["seen"]["argv"]
    assert "Edit" in argv[argv.index("--allowedTools") + 1]


def t_mcp_needs_an_allowlist_and_a_token():
    for extra, word in (({"HA_MCP_URL": "http://x/mcp"}, "allowed tools"),
                        ({"HA_MCP_URL": "http://x/mcp", "HA_MCP_TOOLS": "explore_model"}, "token")):
        try:
            run_with(READ_ONLY_CLAUDE, **extra)
        except ha.Refused as e:
            assert word in str(e), (word, str(e))
            continue
        raise AssertionError("not refused: %s" % extra)


def t_missing_root_and_binary():
    env, _ = setup()
    env["HA_PROFILE"] = json.dumps(READ_ONLY_CLAUDE)
    env["HA_ROOT"] = "/nonexistent/folder"
    try:
        ha.run(env)
        raise AssertionError("missing root not refused")
    except ha.Refused:
        pass
    env, _ = setup()
    env["HA_PROFILE"] = json.dumps(dict(READ_ONLY_CLAUDE, command=["no-such-agent"] + READ_ONLY_CLAUDE["command"][1:]))
    try:
        ha.run(env)
        raise AssertionError("missing binary not refused")
    except ha.Refused as e:
        assert "PATH" in str(e) or "enforced" in str(e), str(e)


def t_a_profile_without_mcp_gets_none_even_as_a_string():
    for flag in (False, "false"):
        try:
            run_with(dict(READ_ONLY_CLAUDE, mcp=flag), HA_MCP_URL="http://x/mcp", HA_MCP_TOOLS="explore_model",
                     AGENTICNETS_MCP_TOKEN="t")
        except ha.Refused as e:
            assert "no MCP" in str(e), str(e)
            continue
        raise AssertionError("mcp=%r not refused" % flag)


def t_token_properties_arrive_as_strings():
    p = dict(READ_ONLY_CLAUDE, command=json.dumps(READ_ONLY_CLAUDE["command"]), mcp="true")
    r, _ = run_with(p, HA_MCP_URL="http://x/mcp", HA_MCP_TOOLS="explore_model", AGENTICNETS_MCP_TOKEN="t")
    assert r["ok"] and "--strict-mcp-config" in r["report"]["seen"]["argv"], r


def t_the_profile_may_arrive_base64_encoded():
    import base64
    env, root = setup()
    env["HA_PROFILE_B64"] = base64.b64encode(json.dumps(READ_ONLY_CLAUDE).encode()).decode()
    r = ha.run(env)
    assert r["ok"] and r["profileId"] == "claude-read-only", r


def t_dollar_placeholders_and_model_override():
    p = dict(READ_ONLY_CLAUDE, command=[a.replace("{", "${") for a in READ_ONLY_CLAUDE["command"]])
    r, _ = run_with(p, HA_MODEL="opus")
    argv = r["report"]["seen"]["argv"]
    assert argv[argv.index("--model") + 1] == "opus", argv


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        case(name[2:].replace("_", " "), fn)
print("%d failed" % len(failures) if failures else "all passed")
sys.exit(1 if failures else 0)
