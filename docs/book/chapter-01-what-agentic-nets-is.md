# Chapter 1: What Agentic-Nets Is

Agentic-Nets is not primarily a workflow engine, an agent framework, or a
visual automation tool.

It is a governed, event-sourced operating runtime for persistent, evolving
processes.

The central idea is that a process should not necessarily be treated as a
static definition that is started, executed once, and then finished. Many real
systems do not work that way. Software development, operations, research,
support, project management, incident handling, organizational processes, and
autonomous agents all evolve continuously. Their state changes. Their
environment changes. Their tools change. Their responsibilities change. And
sometimes the process itself has to change while it is already running.

Agentic-Nets is designed around this idea.

A net is therefore not simply a workflow definition waiting to be executed. It
is a live runtime structure that can persist for days, months, or potentially
years. It holds state. It receives new information. It executes deterministic
actions. It invokes AI when reasoning is required. It communicates with
external systems. It can be observed. It can be modified. And it can evolve
while it continues operating.

## From Workflow Execution to Living Processes

Traditional automation systems are commonly built around the concept of a
workflow run. A workflow is defined. An input arrives. The workflow starts.
Nodes execute. The workflow eventually finishes. The definition normally
remains stable while the execution takes place.

This model is extremely useful for automation, integration, and orchestration.

Agentic-Nets starts from a different assumption: some processes should not be
understood as runs at all. They should be understood as continuously operating
systems.

Consider a software-development team. The team does not start when a ticket
arrives and disappear after the ticket has been completed. The team continues
to exist. It remembers previous decisions. It receives new work. It has
responsibilities. It uses tools. It reacts to incidents. Its members learn.
Its processes improve. New capabilities are introduced. Old procedures are
replaced. The organization itself evolves.

Agentic-Nets models this kind of behavior directly. Instead of repeatedly
starting isolated workflow executions, a persistent net remains active and
continuously processes new state.

A simplified comparison:

```text
Traditional workflow            Agentic-Nets

Input                                LIVE NET
  |
  v                                    State
Start workflow                           |
  |                              +-------+--------+
  v                              |       |        |
Execute steps                    v       v        v
  |                            React   Reason   Execute
  v                              |       |        |
Produce result                   +-------+--------+
  |                                      |
  v                                      v
End                                  New State
                                         |
                                         v
                                     Continue...
```

There does not have to be a final state. The system keeps operating.

## The Net Is Part of the Runtime

Agentic-Nets uses concepts originating from Petri nets. At the most
fundamental level there are three elements:

- **Places** represent state.
- **Tokens** represent information, work items, context, or other persistent
  data.
- **Transitions** represent actions that can change the state of the system.

A very small net might look like this:

```text
[Incident]
     |
     v
 Analyze logs
     |
     v
[Diagnosis]
```

The important property is that this is not merely a diagram. The places and
tokens exist inside the runtime. The state is real. Transitions can execute.
New tokens can arrive. Existing tokens move through the system. Other nets can
interact with the same state.

The net is therefore both a model of the process and part of the running
process itself. This distinction becomes particularly important when a system
grows beyond a simple workflow.

## Nets Are Live Structures

A major architectural property of Agentic-Nets is that the structure does not
have to be frozen once execution begins. A running system may be modified
while it continues operating. It is possible to:

- add a new place,
- introduce a new transition,
- replace an existing transition,
- add another deterministic execution path,
- deploy a new tool,
- connect another remote executor,
- inject another Tool-Net,
- extend a persona,
- add monitoring logic,
- or introduce a new application that interacts with existing runtime state.

This leads to an important distinction. Agentic-Nets is not merely executing a
predefined process. It hosts a process that continues to evolve while it is
alive.

A system might begin with a simple structure:

```text
Request -> Agent -> Result
```

Later, observations may show that part of the agent's work follows a
predictable pattern. The live system can then evolve toward:

```text
Request -> Validation -> Deterministic lookup -> Agent
        -> Automated verification -> Result
```

Later still, more reasoning becomes deterministic. The process does not need
to remain structurally identical to the process that originally started
operating.

This is one of the reasons why the term *runtime* is important. Agentic-Nets
does not merely store workflow definitions. It operates evolving structures.

## Persistent State Instead of Temporary Conversations

AI systems are often centered around conversations. A user starts a session.
Context accumulates. The model performs work. Eventually the session becomes
too large, expires, or is replaced.

This is useful for conversational AI, but it is a weak foundation for
processes that need to operate continuously.

Agentic-Nets separates process state from model context. State exists
independently of any particular LLM invocation. An engineering system might
maintain:

```text
project-context     architecture      current-incidents
known-problems      build-results     deployment-state
open-decisions      lessons-learned
```

These are not required to live inside one giant prompt. They exist as
structured tokens in different places. An agent receives the context it needs
for the current task. The result is written back into the runtime. Another
agent, or a deterministic transition, may later use the same information.

Intelligence can come and go while the process continues to remember.

That leads to the first core principle of Agentic-Nets:

> **The runtime owns the state. The AI uses the state.**

## AI Is an Execution Mechanism, Not the Runtime

Agentic-Nets does not assume that every step should be performed by an LLM. A
transition may represent many different kinds of execution:

```text
PASS        -> routing
MAP         -> deterministic transformation
HTTP        -> service interaction
COMMAND     -> local or remote execution
LINK        -> structural or knowledge interaction
LLM         -> bounded AI reasoning
AGENT       -> iterative intelligent work
```

This produces an important architectural property: deterministic execution and
AI reasoning are peers inside the same process model. The system uses
intelligence only where intelligence is valuable.

A process might look like this:

```text
Incident
   |
   v
COMMAND   collect diagnostics
   |
   v
MAP       normalize result
   |
   v
AGENT     investigate cause
   |
   v
HTTP      inspect Jenkins
   |
   v
COMMAND   run verification
   |
   v
Developer review
```

Only one part of this process requires substantial reasoning. Everything else
remains deterministic. This matters for reliability, for predictability, and
for cost.

The objective is not to maximize LLM usage. The objective is to use
intelligence where it creates value.

## Rules Before Actions: The Policy Envelope

Autonomy without boundaries is not an operating environment; it is a liability.
So governance in Agentic-Nets is not one layer in the stack. It is an envelope
around everything the runtime does.

Before an agent acts, the runtime has already decided what it may do:

- **Capability flags** determine which tools a persona can even see: read,
  write, execute, http, logs, and further explicit capabilities.
- **Tool allowlists and scopes** narrow those capabilities per transition.
- **Credentials** never enter a net definition; transitions reference a key,
  and the secret is resolved from the vault at fire time.
- **Budgets and spend breakers** bound what intelligence may cost.
- **Executor boundaries** decide which machine is allowed to run which
  command.
- **Approvals** put humans in front of the decisions that matter.

The consequence is a runtime where every intelligent actor operates inside
rules that were set before it acted, and where the record of what it did
(the subject of the next sections) can be checked against those rules.

## The Runtime Does Not Need to Own the Intelligence

The separation between process and intelligence goes further. Agentic-Nets can
operate as a runtime without a single LLM configured inside it.

External clients interact with Agentic-Nets through MCP. A connected coding
agent or AI client may inspect models and runtime state, create sessions,
nets, places, and transitions, configure and deploy them, create tokens, query
history, execute transitions, analyze existing nets, or modify a running
process.

This creates a very important separation:

```text
        Agentic-Nets

           owns

        process
        state
        history
        execution
        permissions
        deployment
        tools

             |
             |  requests intelligence
             v

      External AI Client
```

The AI may be Claude today. It might be Codex tomorrow. It could be a local
model, or another MCP-compatible system. Or a particular process may
eventually need no AI at all. The runtime remains.

This gives us the second core principle:

> **Agentic-Nets owns the process. AI supplies intelligence to the process.**

The intelligence is replaceable. The process is persistent.

## MCP as a Runtime Control Plane

MCP is therefore more than an integration feature. It is a programmable
control plane for Agentic-Nets.

The Studio is one way to interact with the runtime. MCP is another. The CLI is
another. Dedicated applications are another. They all interact with the same
underlying system:

```text
                 Agentic-Nets Runtime

                         ^
                         |
        +----------------+----------------+
        |                |                |
      Studio            MCP              CLI
        |                |                |
      Human        Coding Agent      Automation
```

This makes the runtime independent from any single user interface. It also
makes Agentic-Nets particularly interesting for coding agents. A coding agent
does not merely use Agentic-Nets as a tool. It can help construct Agentic-Nets
itself: inspect the existing runtime, create new nets, deploy new behavior,
run it, inspect the result, and modify the system again.

That begins to create the possibility of systems that extend their own
operational structure, inside the policy envelope described above.

## Multiple Nets Form One System

A complex Agentic-Nets model does not consist of one enormous Petri net.
Multiple nets coexist. They have different responsibilities. They communicate
through shared places.

One net might represent a persona. Another provides reusable tooling. Another
monitors the system. Another handles deployment. Another manages project
context. Because they operate within the same runtime environment, they
collectively form a larger system:

```text
             Shared Incident Place
               ^              ^
               |              |
          SRE Persona     Log Tool-Net
               |              |
               +------+-------+
                      |
                      v
               Diagnosis Place
                      |
              +-------+--------+
              v                v
        Developer Persona   Jenkins Net
```

A shared place is more than a storage location. It is a communication boundary
between independently structured nets. Nets become composable runtime
components.

## Tool-Nets and Persona-Nets

This composability allows different kinds of nets to emerge.

A **Tool-Net** represents a reusable operational capability: analyze a Jenkins
build, collect server logs, inspect a cloud instance, create a hotfix branch,
run integration tests, generate a deployment report. A Tool-Net can contain
deterministic transitions, command execution, APIs, or AI where necessary.

A **Persona-Net** represents something more persistent. It defines how an
intelligent role behaves over time:

```text
Developer Persona

inbox -> understand task -> plan -> use tools
      -> implement -> verify -> report result
```

The persona is not just a prompt. It is an executable behavioral structure
with durable context, declared tools, and bounded authority. The model can
give a persona access to particular Tool-Nets, command capabilities, MCP
servers, shared places, or other personas. Personas evolve by acquiring new
capabilities without redefining the entire system.

## NetHub: Installing Processes Instead of Rebuilding Them

Once nets become reusable runtime structures, distribution becomes the obvious
next step. That is the purpose of NetHub.

Instead of repeatedly rebuilding the same process, a net is exported and
installed into another runtime environment:

```text
Existing system -> Export -> NetHub -> Install
               -> Target model / session -> Live runtime structure
```

A reusable artifact might be a Tool-Net, a monitoring net, an
incident-analysis process, a persona, a development process, or an entire
organizational structure, dependencies bundled and credentials scrubbed.

This changes the meaning of process reuse. Instead of copying documentation
that describes how a process should work, we distribute the executable process
itself. NetHub begins to resemble a package ecosystem for operational
behavior.

## Applications: Interfaces Over Living Processes

Agentic-Nets also separates the runtime from the experience presented to an
end user. Users do not need to interact with a Petri-net editor. An
application provides a purpose-built interface over the runtime: a Kanban
board, a Goals application, an Interview application, a Protocol application,
an incident console, a project dashboard.

The architecture then looks different from a conventional application stack:

```text
A typical system            An Agentic-Nets application

UI                          Application UI
 |                                |
 v                                v
REST API                    Agentic-Nets runtime
 |                                |
 v                                v
Business logic              Places + Tokens
 |                                |
 v                                v
Database                    Nets + Personas + Tools
```

The application becomes a projection of the running process. Different
applications expose different perspectives onto the same underlying runtime. A
Kanban interface displays work items. A monitoring application displays
execution activity. A conversational application interacts with a persona. A
management application shows goals. All of them operate on the same persistent
system, and none of them owns a private database.

This is one of the points where Agentic-Nets stops looking like a workflow
product and starts looking like an application runtime.

## Event Sourcing: The Runtime Remembers Its Own Evolution

Another foundational property is event sourcing. Durable changes inside the
runtime are represented as immutable events. The current state is therefore
not the only information available; the history that created that state also
exists.

This changes observability. Instead of only asking *what is the current
state*, we ask *how did we get here*. Which transition created this token?
Which input did the agent receive? Which tool was executed? Which result came
back? Which transition failed, and how often was it retried? Which route was
selected? What happened before the incident? How did this process behave last
week?

The history becomes evidence. And the evidence is not only useful for
debugging. It is the foundation for improving the process itself.

## From Observability to Crystallization

This leads to one of the most important long-term ideas behind Agentic-Nets:
**crystallization**.

AI is extremely useful when the correct process is not yet known. An agent
investigates a problem, reasons about alternatives, uses tools, retries
operations, and eventually finds a solution.

But suppose the same class of problem appears repeatedly. And suppose the
event history shows that the agent performs almost the same sequence of
operations every time. At that point, invoking expensive probabilistic
reasoning for every execution no longer makes sense.

The process evolves:

```text
Initially:            After observation:         Eventually:

Problem               Problem                    Problem
   |                     |                          |
   v                     v                          v
Agent                 Deterministic prep         Deterministic workflow
   |                     |                          |
   v                     v                          |  exceptional case?
Result                Agent                         |yes
                         |                          v
                         v                       Agent
                      Deterministic verify          |
                         |                          v
                         v                       Result
                      Result
```

This is crystallization. Intelligence discovers the process. Event history
provides evidence about how the process behaves. Stable behavior is extracted
into deterministic structure. The AI remains for the cases where uncertainty
still exists.

Crystallization is a controlled feedback loop, not an automatic one:

```text
Observe -> Analyze -> Propose -> Approve -> Version -> Verify -> Crystallize
```

The platform never silently rewrites itself. Changes are proposed against
evidence, approved, versioned, and verified, and the previous structure
remains available for rollback.

The effect is real and measurable. On one production reporting lane, the agent
version of the lane consumed 821,000 LLM tokens per execution. The
crystallized replacement produces the same output with zero.

A young process might be 20% deterministic and 80% AI. A mature process might
become 90% deterministic and 10% AI. That does not represent less
intelligence. It represents learned intelligence becoming infrastructure.

## Runtime Agents: Agents That Improve the Runtime

Once execution history and runtime structure are both available
programmatically, another possibility appears. Agents do not need to perform
only domain work. They can reason about Agentic-Nets itself.

A runtime agent may observe a net, inspect its execution history, find
bottlenecks, detect repeated failures, analyze agent behavior, recommend
structural changes, create or modify transitions, deploy the improvement, and
observe again. Its proposals travel through the same approval gates as
everyone else's; a runtime agent has no privileged path around the policy
envelope.

This introduces a reflexive property: the runtime contains agents that help
operate and improve the runtime. Combined with MCP, event sourcing, and live
structural modification, the system does not merely execute processes. It
increasingly participates in engineering them.

## Toward an Operating Environment for Intelligent Processes

Taken individually, many Agentic-Nets features look familiar. Petri nets
exist. Workflow engines exist. AI agents exist. MCP exists. Event sourcing
exists. Remote execution exists. Application frameworks exist. Package
registries exist.

The interesting part is how these ideas combine:

```text
 +--------------------- POLICY ENVELOPE ----------------------+
 |    capabilities · approvals · vault · budgets · scopes     |
 |                                                            |
 |                     APPLICATIONS                           |
 |        Kanban | Goals | Interview | Protocol               |
 |                          |                                 |
 |                          v                                 |
 |                      PERSONAS                              |
 |            Developer | SRE | Analyst | PM                  |
 |                          |                                 |
 |                          v                                 |
 |                      LIVE NETS                             |
 |         Tool-Nets | Process-Nets | Persona-Nets            |
 |                          |                                 |
 |                          v                                 |
 |                    SHARED STATE                            |
 |                   Places + Tokens                          |
 |                          |                                 |
 |                          v                                 |
 |                   EXECUTION LAYER                          |
 |        Deterministic | AI | MCP | Commands                 |
 |                          |                                 |
 |                          v                                 |
 |               EVENT-SOURCED HISTORY                        |
 |                          |                                 |
 |                          v                                 |
 |     Observe -> Analyze -> Propose -> Approve -> Evolve     |
 |                                                            |
 +------------------------------------------------------------+
                            ^
                            |
                 NetHub: package · distribute · install
```

This is why the operating-system analogy is useful. Agentic-Nets is not an
operating system in the traditional sense of CPU scheduling, memory pages, or
hardware devices. It is an operating environment for persistent intelligent
processes: the substrate within which state persists, processes execute,
tools are available, agents reason, personas exist, applications interact,
processes communicate, capabilities are installed, history is recorded, and
the system evolves, all inside explicit policy boundaries.

## The Core Product Principles

The resulting product philosophy can be summarized in three statements.

> **Agentic-Nets owns the process. AI supplies intelligence to the process.**

> **Use AI where uncertainty requires intelligence. Use deterministic
> execution everywhere else.**

> **A process should learn from its own execution and evolve, through
> approved changes, while it continues to operate.**

This leads to the product definition:

> **Agentic-Nets is a governed, event-sourced operating runtime for
> persistent, evolving processes. Its nets maintain persistent state,
> cooperate through shared places, can be modified while running, integrate
> deterministic automation and AI as equal execution mechanisms, and evolve
> over time from exploratory agent behavior into optimized deterministic
> structure. The runtime owns the process; intelligence is supplied to it, by
> any model or none.**

Or, expressed in one sentence:

> **Workflow engines execute runs. Agentic-Nets operates evolving systems.**

That distinction is the foundation for everything that follows.

## The Chapter in Ten Plain Sentences

1. **No runs.** A process here does not start and finish; it stays alive until
   you retire it.
2. **Visible state.** Work sits in places you can see and query, not inside a
   chat log or a hidden queue.
3. **Durable AI teammates.** A persona keeps its context, tools, and
   responsibilities for months, not for one prompt.
4. **Equal steps.** A shell command, an HTTP call, a data transform, and an AI
   decision are peers in the same net.
5. **Rules before actions.** Permissions, budgets, credentials, and approvals
   bound what every agent may do, before it does it.
6. **Change it while it runs.** Add a place, swap a step, or attach a tool
   without stopping the system.
7. **A history that answers.** Every token, fire, and decision is recorded, so
   "what happened and why" is a query, not a guess.
8. **AI that makes itself cheaper.** When an AI step keeps making the same
   decision, you crystallize it into plain automation and stop paying for
   tokens.
9. **Intelligence is supplied, not built in.** Use a server LLM, a local
   model, the MCP client you already have, or no model at all.
10. **Apps are views, not silos.** A Kanban board, a goal tracker, and a
    monitor are projections over the same living process, not separate
    applications with their own databases.

## See It Live

Three real nets run on the public demo instance behind read-only share links,
rendered in the same Studio editor operators use. No install, no login:

- [01 · Token Flow Basics](https://agentic-nets.com/#/shared-net/f2663810-bcce-4ed2-9507-40f77b3be04c)
- [02 · The Seven Transition Types](https://agentic-nets.com/#/shared-net/c1b98b10-c521-4b33-9318-7e68114fa3ec)
- [12 · Crystallization: AI first, then free](https://agentic-nets.com/#/shared-net/c989eac2-b6ef-4b35-a107-6ac3ef26d469)

Or install the desktop app from the
[releases page](https://github.com/alexejsailer/agentic-nets/releases/latest):
one download, no Docker, no API key, with reasoning supplied by the MCP client
you already use.
