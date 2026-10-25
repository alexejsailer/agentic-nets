# Refiner

The AI side of the focus loop, as an application in the model: a `request` hands the focus work over (kind refinement, structure or ground; a focus scope and a subject when wanted), the agent lane `t-refiner-pass` runs the pass through the Agentic-Nets MCP server and reports into `runs`. The Explorer's Focus view has the "Hand over to the AI" button and the MCP tool `hand_over` writes the same request; the master installs this application on first use and attaches its MCP server when it knows one. The lane ships stopped and is fired once per request.

Packed with `npm run pack:refiner`; the master seeds the packed copy (`application-templates/refiner.json`).
