# spec-004: Add lane-report tool and daily command to steward-observe

kind: tool-net

Add a python3 script tool steward-lane-report that reads the newest p-steward-lanes observation, renders its lane rows as a markdown table, and writes a single token to p-steward-lane-report. Register the tool in the asset catalog and capability manifest, and expose it through steward-observe with a command lane and a daily scheduled map lane. Keep all protected lanes untouched and retain ten lane-report tokens.

## Why
Answers idea-001 and the person's direct request to make lane measurements readable; supports the goal of keeping the Desktop model observable while health is stable (24 lanes running, 0 errors) and cost is zero (costUsd24h 0.0).

### Nets touched
- steward-observe

### Lanes and places touched
- p-steward-lane-report
- p-steward-lane-report-cmd
- t-steward-lane-report-cmd
- t-steward-lane-report-daily

### A new lane reads
- p-steward-lane-report-cmd
- p-steward-health

### A new lane writes
- p-steward-lane-report
- p-steward-lane-report-cmd

### Changes, in order
- Create assets/steward-lane-report.py with shared-library markers: read the newest token from p-steward-lanes, render its lane rows as a markdown table, and emit one token {kind: lane-report, observationId, markdown, lanes} to p-steward-lane-report.
- Register tool id steward-lane-report in assets/index.json pointing to assets/steward-lane-report.py.
- Register tool id steward-lane-report in capability.yaml.
- Edit nets/steward-observe.net.json: add place p-steward-lane-report with retain 10, and place p-steward-lane-report-cmd.
- Edit nets/steward-observe.net.json: add command lane t-steward-lane-report-cmd that reads p-steward-lane-report-cmd (consume true) and writes p-steward-lane-report via executor steward-lane-report.
- Edit nets/steward-observe.net.json: add map lane t-steward-lane-report-daily scheduled cron '0 10 6 * * *' Europe/Berlin reading p-steward-health (consume false) and writing a request command token {toolId: steward-lane-report, argv: [report], env: {MODEL_ID: steward}} to p-steward-lane-report-cmd.
- Update verify/smoke.json to assert both new lanes are running and that writing a request token to p-steward-lane-report-cmd produces a lane-report token in p-steward-lane-report.

### Files expected to change
- assets/steward-lane-report.py
- assets/index.json
- capability.yaml
- nets/steward-observe.net.json
- verify/smoke.json

### Verify after install
After a request token is written to p-steward-lane-report-cmd, t-steward-lane-report-cmd fires and p-steward-lane-report contains a token with kind 'lane-report', a non-empty markdown table, and a lanes array matching the newest p-steward-lanes observation; t-steward-lane-report-daily is scheduled for 06:10 Europe/Berlin; all lanes remain error-free.

### Rollback
previous pack version

### Blast radius
Only steward-observe is touched; two new lanes are added and zero existing lanes are stopped.
