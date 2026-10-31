#!/usr/bin/env python3
"""Unit proof of the runner's rules with fake claude/codex binaries (no agent runs, no network).

usage: python3 verify/test_headless_agent.py   (exit 0 when every case passes)"""
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ha", os.path.join(HERE, "..", "assets", "headless-agent.py"))
ha = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ha)

FAKE = r'''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
if "WRITE_IMPLEMENTATION_FIXTURE" in prompt:
    open("approval.py", "w").write("def approved(): return True\n")
cfg = None
if "--mcp-config" in sys.argv:
    cfg = json.load(open(sys.argv[sys.argv.index("--mcp-config") + 1]))
seen = {"argv": sys.argv[1:], "cwd": os.getcwd(), "prompt": prompt, "cfg": cfg,
        "env": sorted(k for k in os.environ if k.startswith(("HA_", "AGENTICNETS", "CLAUDE")) or k.endswith("_MCP_TOKEN"))}
context_dir = next((line.split(": ", 1)[1] for line in prompt.splitlines() if line.startswith("MODEL_CONTEXT_DIR: ")), os.getcwd())
if os.path.isfile(os.path.join(context_dir, "model-round.json")):
    seen["modelContext"] = json.load(open(os.path.join(context_dir, "model-round.json")))
    seen["contextDir"] = context_dir
if os.path.isfile(os.path.join(context_dir, "model-index.json")):
    index = json.load(open(os.path.join(context_dir, "model-index.json")))
    seen["modelIndex"] = index
    seen["detailBytes"] = [os.path.getsize(os.path.join(context_dir, entry["file"])) for entry in index["nets"]]
key = "FOCUS_ROUND_RESULT" if prompt.startswith("Focus round") else "CODER_RESULT"
result = "did it\n" + key + ": " + json.dumps({"summary": "ok", "seen": seen})
if os.path.basename(sys.argv[0]) == "claude":
    print(json.dumps({"result": result, "total_cost_usd": 0.01, "num_turns": 3, "is_error": False}))
else:
    print(result)
if "FAIL_IMPLEMENTATION_FIXTURE" in prompt: sys.exit(1)
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


def t_granted_mcp_credentials_connect_claude_and_do_not_reach_its_environment():
    r, _ = run_with(dict(READ_ONLY_CLAUDE, mcp=True), AGENTICNETS_MCP_URL='http://127.0.0.1:8091/mcp',
        AGENTICNETS_MCP_TOKEN='round-secret', HA_MCP_TOOLS='explore_model,focus_round_scope,focus_round_apply')
    seen = r['report']['seen']
    cfg = seen['cfg']['mcpServers']['agenticnets']
    assert cfg['url'] == 'http://127.0.0.1:8091/mcp' and cfg['headers']['Authorization'] == 'Bearer round-secret', cfg
    assert seen['env'] == [], seen
    allowed = seen['argv'][seen['argv'].index('--allowedTools')+1].split(',')
    assert 'mcp__agenticnets__focus_round_apply' in allowed and 'Bash' not in allowed, allowed
    r, _ = run_with(dict(CODEX, mcp=False), AGENTICNETS_MCP_URL='http://127.0.0.1:8091/mcp', AGENTICNETS_MCP_TOKEN='round-secret')
    assert r['report']['seen']['cfg'] is None, r


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


def t_model_only_rounds_with_both_providers_use_temporary_context_and_custom_result_key():
    for profile in (READ_ONLY_CLAUDE, CODEX):
        r, _ = run_with(dict(profile, mcp=False), HA_ROOT="", HA_CONTEXT_JSON=json.dumps({"roundId": "r", "nets": {"s::n": {"description": "Approval"}}}),
                        HA_PROMPT="Focus round: inspect the supplied model", HA_RESULT_KEY="FOCUS_ROUND_RESULT")
        assert r["ok"], r
        seen = r["report"]["seen"]
        assert seen["modelContext"]["roundId"] == "r", seen
        assert not os.path.exists(seen["cwd"]), "temporary context was not removed"
        assert seen["env"] == [] and seen["cfg"] is None, seen


def t_source_backed_rounds_keep_the_configured_folder():
    r, root = run_with(dict(READ_ONLY_CLAUDE, mcp=False), HA_CONTEXT_JSON='{"roundId":"r"}',
                       HA_PROMPT="Focus round: inspect sources", HA_RESULT_KEY="FOCUS_ROUND_RESULT")
    assert r["ok"] and os.path.realpath(r["report"]["seen"]["cwd"]) == os.path.realpath(root), r
    assert not os.path.exists(os.path.join(root, "model-round.json")), "source folder was modified"
    seen = r["report"]["seen"]
    assert seen["modelContext"]["roundId"] == "r" and not os.path.exists(seen["contextDir"]), seen


def t_large_rounds_use_stdin_and_searchable_files_with_both_providers():
    context = {"roundId": "r", "topic": "Morning advice", "snapshot": {
        "nets": {"modules::n%d" % i: {"definition": {"interactions": "Evidence " + "x" * 4000}} for i in range(65)},
        "index": [{"key": "modules::n%d" % i, "title": "Advice %d" % i} for i in range(65)],
        "fingerprints": {"modules::n0": "server-only"}, "hierarchy": [], "sharedPlaces": []}}
    for profile in (READ_ONLY_CLAUDE, CODEX):
        env, root = setup()
        env.update(HA_PROFILE=json.dumps(dict(profile, mcp=False)), HA_PROMPT="Focus round: find the relevant areas", HA_RESULT_KEY="FOCUS_ROUND_RESULT")
        proc = subprocess.run([sys.executable, ha.__file__, "run-context"], input=json.dumps(context), text=True,
                              capture_output=True, env=env, timeout=30)
        r = json.loads(proc.stdout);assert r["ok"], r
        seen = r["report"]["seen"]
        assert len(seen["modelIndex"]["nets"]) == 65 and min(seen["detailBytes"]) > 4000, seen
        assert "nets" not in seen["modelContext"]["snapshot"] and "fingerprints" not in seen["modelContext"]["snapshot"], seen
        assert len(seen["prompt"]) < 2000 and seen["env"] == [], seen
        assert os.path.realpath(seen["cwd"]) == os.path.realpath(root), seen
        assert os.listdir(root) == [] and not os.path.exists(seen["contextDir"]), seen


def t_context_file_names_cannot_escape_the_temporary_snapshot():
    env, _ = setup();env["HA_PROFILE"] = json.dumps(READ_ONLY_CLAUDE)
    r = ha.run(env, {"snapshot": {"nets": {"../../escape": {"description": "Data only"}}}})
    entry = r["report"]["seen"]["modelIndex"]["nets"][0]
    assert entry["key"] == "../../escape" and entry["file"].startswith("nets/") and ".." not in entry["file"], entry


def t_malformed_stdin_context_is_refused_without_launching_a_provider():
    env, _ = setup();env["HA_PROFILE"] = json.dumps(READ_ONLY_CLAUDE)
    proc = subprocess.run([sys.executable, ha.__file__, "run-context"], input='[1,2,3]', text=True, capture_output=True, env=env, timeout=30)
    result = json.loads(proc.stdout)
    assert not result["ok"] and "JSON object" in result["error"], result


def t_implementation_records_real_file_changes_preserves_existing_files_and_disables_mcp():
    env, root = setup()
    open(os.path.join(root, "existing.txt"), "w").write("Keep the user's work")
    env.update(HA_PROFILE=json.dumps(dict(READ_ONLY_CLAUDE, mode="write", mcp=False, allowedTools="Read,Grep,Glob,Edit,Write,Bash")),
               HA_PROMPT="WRITE_IMPLEMENTATION_FIXTURE")
    result = ha.run(env, {"roundId":"r", "job":{"phase":"implement"}})
    assert result["ok"] and result["mode"] == "write", result
    assert result["workspace"]["captured"] and result["workspace"]["changes"][0]["path"] == "approval.py", result
    assert result["workspace"]["changes"][0]["change"] == "added", result
    assert open(os.path.join(root, "existing.txt")).read() == "Keep the user's work"
    assert result["report"]["seen"]["cfg"] == {"mcpServers":{}}, result


def t_failed_implementation_still_records_partial_file_changes():
    env, root = setup()
    env.update(HA_PROFILE=json.dumps(dict(READ_ONLY_CLAUDE, mode="write", mcp=False)),
               HA_PROMPT="WRITE_IMPLEMENTATION_FIXTURE FAIL_IMPLEMENTATION_FIXTURE")
    result = ha.run(env, {"roundId":"r", "job":{"phase":"implement"}})
    assert not result["ok"] and result["workspace"]["captured"], result
    assert result["workspace"]["changes"][0]["path"] == "approval.py", result


def t_implementation_requires_an_explicit_source_root_and_refinement_refuses_write_mode():
    env, _ = setup(); env["HA_PROFILE"] = json.dumps(dict(READ_ONLY_CLAUDE,mode="write",mcp=False))
    for context in ({"job":{"phase":"refine"}}, {"job":{"phase":"question"}}):
        try: ha.run(env,context)
        except ha.Refused: pass
        else: raise AssertionError("a model-only phase accepted a write profile")
    env["HA_ROOT"] = ""
    try: ha.run(env,{"job":{"phase":"implement"}})
    except ha.Refused: pass
    else: raise AssertionError("implementation wrote into a temporary model workspace")


for name, fn in list(globals().items()):
    if name.startswith("t_") and callable(fn):
        case(name[2:].replace("_", " "), fn)
print("%d failed" % len(failures) if failures else "all passed")
sys.exit(1 if failures else 0)
