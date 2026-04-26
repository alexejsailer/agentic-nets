# Foundations

## From a 2012 Diploma Thesis at KIT to Agentic-Nets

Agentic-Nets did not appear out of nowhere. It is the modern descendant of a 2012 diploma thesis at the Karlsruhe Institute of Technology (KIT) that built a Java simulation engine for **XML-Netze** — a higher-order Petri-net variant where places hold structured documents as tokens and transitions are guarded by inscriptions. The runtime in this repository is the same architecture, re-cast 14 years later for AI agents instead of business processes.

This document exists so that anyone reading the code can see what it is built on, where it comes from, and why the design decisions look the way they do.

---

## The source

> **Konzeption und Realisierung einer Simulationskomponente zur risikobewussten Prozessanalyse**
>
> Alexej Sailer · Diplomarbeit · 02. März 2012
>
> Karlsruher Institut für Technologie (KIT) · Institut für Angewandte Informatik und Formale Beschreibungsverfahren (AIFB)
>
>
> 86 pages.

The thesis built a simulation engine for **XML-Netze**, a higher-order Petri-net variant in which:

- Places hold typed XML documents as tokens (*Stellen sind Behälter für XML-Dokumente, deren Struktur durch ein XML-Schema definiert ist*).
- Transitions carry **inscriptions** that filter, bind, and mutate documents.
- Arc inscriptions select documents by structural and value-based predicates.
- A custom **ANTLR-based query language** (Chapter 3) provides selection and binding semantics.
- A **risk extension** (Chapter 5) models delays and risk-dependent deadlocks at firing time.

The intent of the thesis was a runtime where it is possible to simulate not only *Schönwetterflüge* of a business process but also what happens when things go wrong (Diplomarbeit, p. 3). Fourteen years later, the same intent applies to AI agents — except the things that go wrong are different in kind, not in shape.

---

## The 1:1 architectural map

The same skeleton, re-cast for AI agents:

| Concept | Diplomarbeit (2012) | Agentic-Nets (2026) | Reference in thesis |
|---|---|---|---|
| **Substrate** | Higher-order Petri net (XML-Netze) | Higher-order Petri net (Agentic-Nets) | Ch. 2, p. 5–6 |
| **Token** | Typed XML document, schema-defined | Typed JSON token, queryable via ArcQL | Ch. 4.3.3, p. 32–35 |
| **Place** | Container of XML documents, identified by `schemaName` and `placeId` | Event-sourced node tree, identified by name and parent path | Abb. 4.3, p. 30 |
| **Transition data model** | `Transition { id, name, subnet, inscription:String, preset[*], postset[*], incomingArc[*], outgoingArc[*], costFactor, averageCost, averageDuration }` | `Transition { id, kind, presets, postsets, action, emit, mode }` | Abb. 4.3, p. 30 |
| **Inscription** | Guarded query + selection + binding + mutation, ANTLR-parsed at firing time | JSON inscription with action + emit rules, dispatched at firing time | Ch. 3 + 4.3.4, p. 7–24, 36–40 |
| **Query language** | ANTLR-generated lexer/parser, hierarchical getter chains resolved via Java Reflection | ArcQL: `FROM $ WHERE $.field=='value'`, hierarchical token access | Ch. 3.1, p. 7–19 |
| **Token persistence** | `PlaceSchemaManager` singleton per place; JAXB marshalling/unmarshalling to disk | Per-model event log, immutable read model, ArcQL with reservation visibility | Abb. 4.5, p. 34 |
| **Token binding** | `TokenBinding { schema, schemaName, placeId, tokenName, rootElement: JAXBElement, ... }` | `Token { id, name, parentId, properties: { ... } }` | Abb. 4.6, p. 35 |
| **Schema enforcement** | `xjc` JAXB-Schema-Compiler generates Java beans from XSD | JSON property bags validated at write time | Ch. 4.3.2, p. 31–32 |
| **Firing strategies** | Sequential and parallel strategies (random choice for non-determinism, multi-thread for parallelism) | SINGLE and FOREACH execution modes (atomic and bounded-parallel) | Ch. 4.3.5, p. 41–42 |
| **Risk model** | Risiko-XML-Dokumente, Reduktionsmaßnahmen, Verzögerung, risk-induced deadlocks | Capability flags (`r---`, `rw--`, `rwx-`, `rwxh`), capacity gating, retry policies, timeouts | Ch. 5.2, p. 49–60 |
| **What-if simulation** | Risk-Simulationseinheiten — copies of the net with different risk-reduction combinations | Multi-net composition, replay of token streams | Ch. 4.3.5 + 5.2.3, p. 42, 59 |
| **Modelling tool integration** | KIT-Horus export plug-in feeding the simulation engine | Designtime API + visual editor + builder agent feeding the runtime | Ch. 6, p. 61–68 |
| **Validation case study** | Globale-Softwareentwicklung process simulation | Multi-agent workflows: agile-team net, intel-gather platform, log analyzer, etc. | Ch. 7.1, p. 69–81 |

---

## What changed in 14 years

The substrate is the same. The motivation, the surrounding technology, and the entity using the system are different.

| Then (2012) | Now (2026) |
|---|---|
| XML documents as tokens | JSON tokens (smaller, web-native, schema-on-read) |
| Transitions modelled human business processes | Transitions can be agent, LLM, HTTP, command, map, pass, or link |
| The "agent" was a human modeller using KIT-Horus | The agent is an LLM with runtime-enforced capability flags |
| Risk modelled wall-clock delays and deadlocks | Capability flags model permission boundaries the prompt cannot escape |
| A single net per simulation run | Composable nets — many nets exchange tokens through shared inboxes |
| Java + JAXB + Reflection | Spring Boot + event sourcing + CQRS + Angular + reactive |
| KIT-Horus as the modelling front-end | A builder agent as the modelling front-end — you talk, the agent designs the net |

The most significant change is the last row. In 2012, modelling a net meant drawing it in KIT-Horus by hand. In 2026, the modelling itself is a conversation with an agent that lives inside the runtime. The net has become its own author.

---

## Why this lineage matters

Higher-order Petri nets carry sixty years of formal literature on properties that AI agent systems urgently need but rarely articulate:

- **Liveness** — can the system always make progress, or can it deadlock?
- **Reachability** — given a state, can the system reach a desired state?
- **Boundedness** — does any place grow without bound?
- **Soundness** (van der Aalst, 1997) — every workflow instance terminates, every transition is realisable, every state can lead to a terminal state.

These are not vibes. They are decision problems with formal answers. When a multi-agent system is built on a Petri-net substrate, those answers are reachable. When it is built on chained prompts, they are not.

The thesis was about modelling business processes that contain risk. Agentic-Nets is about modelling AI agents with the same rigour — because an agent that can run a shell command, write a file, or call an API needs every guarantee a business process needs, plus a few more.

---

## A personal note

I built the simulation engine for XML-Netze in 2012 because business processes deserved better than ad-hoc workflow scripts. I am building Agentic-Nets in 2026 because AI agents deserve better than ad-hoc prompt chains. The substrate is the same. The lesson is the same. The thing being modelled is the only thing that changed.

If anything in this repository feels deliberate rather than fashionable, this is why.

---

## Figures from the 2012 thesis

The fourteen diagrams below were extracted directly from the original Diplomarbeit and copied into this repository as visual evidence of the lineage described above. They are organised as five acts — the architecture that defines the substrate, the query language that drives decisions, the visual modelling tool that authors nets, the risk extension that governs them, and a real process simulated end-to-end. Each is paired with one sentence on what it shows and where the same idea lives in Agentic-Nets today.

> **Attribution.** Figures are reproduced from the author's own 2012 Diplomarbeit at the Karlsruhe Institute of Technology (KIT). Several screenshots show **KIT-Horus**, the Petri-net modelling tool developed at the **AIFB** institute (*Institut für Angewandte Informatik und Formale Beschreibungsverfahren*) at KIT, which the thesis used as its modelling front-end. KIT-Horus and the visual style of its rendered Petri nets are property of AIFB / KIT and are reproduced here under fair-use academic citation.

### Act I — The architecture: a substrate, not a script

#### 1. Simulation-Component architecture

![UML component diagram of the simulation engine showing Settings-GUI / Document-Preparation, Object-Management, Inscription-Parser, JAXB-Object-Generator, Schema/XML-Document-Management, Inscription-Evaluation, Analysis, and Simulation-Algorithm components inside the Simulation-Component, with XML-Net and Risks as the upstream input](docs/foundations/simulation-component-architecture.png)

The 2012 simulation engine, decomposed into eight components (Settings/Document-Preparation, Object-Management, Inscription-Parser, JAXB-Object-Generator, Schema/XML-Document-Management, Inscription-Evaluation, Analysis, Simulation-Algorithm) — the direct architectural template for Agentic-Nets's split between master (orchestration + inscription evaluation), node (event-sourced document/token management), executor (parallel firing + side-effect dispatch), and the GUI/builder agent (settings + authoring).

#### 2. The data model of nets, transitions, places, and arcs

![XML schema diagram of the Petrinet root with transitions, places, arcs, and resources lists; Transition has id, name, subnet, inscription string, preset and postset Place lists, incoming and outgoing Arc lists, costFactor, averageCost, timeUnit, averageDuration; Place has id, name, schemaName, tokenCount, superPlaceId; Arc has id, sourceNodeId, targetNodeId, arcweight](docs/foundations/xml-net-data-model.png)

The schema-level definition of an XML-Netz: a `Petrinet` holds `transitions`, `places`, `arcs`, `resources`; a `Transition` carries an `inscription:String`, `preset[*]`, `postset[*]`, `incomingArc[*]`, `outgoingArc[*]`, plus cost and duration metadata; a `Place` carries a `schemaName` defining its typed contents — this is the same data model Agentic-Nets implements today as `Transition { id, kind, presets, postsets, action, emit, mode }` over event-sourced typed places.

### Act II — The query language: how a transition decides whether to fire

#### 3. The ANTLR grammar of the inscription query language

![ANTLR grammar excerpt showing the production rules query, boolExpression with or-expressions, andExpression with and-expressions, eqExpression with equality and inequality, relationExpression with less-than/greater-than/etc, addExpression with plus and minus, multExpression with multiplication/division/modulo, unaryExpression with negation, and expression yielding constants or selections](docs/foundations/antlr-query-grammar.png)

The 2012 query grammar — boolean → equality → relation → arithmetic → unary → expression → selection-or-constant — is exactly the ladder a query language has to descend to reach a single comparable value, and is the same shape ArcQL takes today (`FROM $ WHERE $.field == 'value'` parses through this very hierarchy in modernised form).

#### 4. Parsing an inscription into an abstract syntax tree

![Abstract syntax tree of an ANTLR-parsed inscription query showing query at the root, descending through boolExpression, andExpression, eqExpression, relationExpression on both sides of an equals sign, with one side being a selection that resolves to p7947477.dollarsign-raum.get(complexTypeAttribut Bezeichnung).get(0) and the other being the constant ServerRaum](docs/foundations/query-syntax-tree.png)

A concrete AST produced by the ANTLR parser — every inscription is reduced to this kind of tree before evaluation, with selections resolved against typed place tokens via Java reflection in 2012 and against typed JSON tokens via ArcQL today.

#### 5. A real inscription, end to end

![Inscription source listing with a query selecting from p7947477.raum.getBezeichnung equal to ServerRaum, p18481767.angestellter.getVerantwortung equal to Server-Administration, and p26205617.risk.getLikelihoodPercentage greater than 0.1, then a transition section creating a new likelihood value, modifying the risk's likelihoodPercentageAfterReduction, assigning the modified risk back to p26205617, and removing the risk document from the preset](docs/foundations/inscription-example.png)

An actual inscription that mixes a process query (find a server-room and the responsible administrator) with a policy query (find a risk whose likelihood exceeds 10 %) and then mutates the risk — proving that the same inscription DSL governs *both* business state and governance state at firing time, exactly as Agentic-Nets's inscriptions today route both data and capability/policy decisions through the same evaluation path.

### Act III — The authoring surface: the modelling tool

#### 6. The visual editor with its palette

![KIT-Horus visual editor screenshot showing a Petri net diagram in the centre with places labelled Pflichtenheft, F-Anforderungen, NF-Anforderungen, Produktbibliothek, transitions labelled Funktionale Anforderungen trennen, Nicht-Funktionale Anforderungen trennen, existiert die Komponente, existiret die Komponente nicht, plus a risk marker ServerAusfall IPR; on the right a Palette panel offering Place, Transition, Arc model elements and Image, Text, Line, and shape graphics](docs/foundations/visual-editor-palette.png)

The KIT-Horus drag-drop editor — Place / Transition / Arc as first-class palette elements, plus visual risk markers on transitions — is the direct ancestor of the Angular visual editor in `agentic-net-gui`, where the same primitives plus seven transition kinds (pass / map / http / llm / agent / command / link) are drawn the same way.

#### 7. Opening the inscription editor on a transition

![KIT-Horus right-click context menu on a transition with options Undo, Redo, Cut, Copy, plus a highlighted Open Inscription-Language Editor entry that points to a tab opening below showing the actual inscription with a query filtering anforderung tokens whose typ is not Functional and not Datenbank, then a transition section creating a new instance and assigning it](docs/foundations/inscription-language-editor.png)

Right-click on any transition → *Open Inscription-Language Editor* — the editor lives where the transition lives, not in a separate file system. This is exactly Agentic-Nets's "double-click to edit inscription JSON in Monaco" experience, and the next step beyond it is the conversational builder agent that authors the inscription from a prompt.

#### 8. A complete sub-net with schema, inscription, and risk

![KIT-Horus screenshot of the Replikation sub-process: a Petri net with places F-Anforderungen, F-Anforderung, Produktbibliothek and transitions Replikation and existiert die Komponente bereits with a RiskPlace risk marker on top, an Einschub panel showing the Anforderung typed schema with id, name, typ, beschreibung fields, and below the inscription editor with a query filtering on p17103083.anforderung, a transition creating complexInstance test, assigning it to p2348232.anforderung, and removing fDokument from preset](docs/foundations/subnet-replikation-with-inscription.png)

A sub-net rendered with all four pillars on screen at once — visual structure (places + transitions + arcs), typed place schema (right), risk attachment on a transition (top), and the bound inscription that selects, transforms, and emits tokens (bottom). This single image is arguably the strongest evidence: it is what an Agentic-Net looks like today, drawn 14 years earlier.

### Act IV — The risk extension: governance, by name

#### 9. The Risk Management editor in KIT-Horus

![KIT-Horus Risk Management editor for ServerAusfall with fields for Name, Likelihood low, Impact middle, Impact-Type time, Deadlock yes/no, Cause intern, Cause-Resource nonhuman, Stakeholder browse; below it a Reduction sub-panel with Name, Type, Description, and Refinement Path fields, plus an existing reduction list showing ServerReplikation as ImpactPermanentReduction, ServerKuehlRaum as CauseReduction, and ServerReboot as ImpactSingularReduction](docs/foundations/risk-management-editor.png)

The full Risk Management GUI from 2012: Name, Likelihood, Impact, Impact-Type, Deadlock, Cause, Reduction list — every field that today appears in Agentic-Nets's capability flag set (`r---` / `rw--` / `rwx-` / `rwxh`), capacity gating, retry policies, and timeout configuration. This is the screen the policy editor in Agentic-Nets is descended from.

#### 10. The risk data model

![XML schema of the Risk type from the thesis with attributes id, name, petriNode, resources, dependency, stakeholder, riskPlace, riskManagement, deadlock boolean, likelihood string, likelihoodPercentage double, likelihoodPercentageAfterReduction double, impact string, impactType string, impactPercentage double, cause string, causeResourceKind string, visible boolean, simulate boolean, riskDefinitionFileName string, occured boolean; with sub-types RiskPetriNode, RiskResource, RiskDependency, RiskStakeholder, and RiskManagement containing a reductionList of RiskReduction](docs/foundations/risk-data-model.png)

The XSD of the `Risk` type — the formal contract behind the editor in the previous figure — captures every axis Agentic-Nets's runtime governance covers today: identity (`id`, `name`), scope (`petriNode`, `riskPlace`, `resources`), policy (`likelihood`, `impact`, `deadlock`), and remediation (`riskManagement → reductionList`).

#### 11. A concrete risk instance, attached to a place

![Tree view of a ServerAusfall risk XML document with id ServerAusfall-ID156..., name ServerAusfall, riskManagement containing a reductionList with name ServerReplikation, type ImpactPermanentReduction, impactPercentageAfterReduction 0.3, likelihoodPercentageAfterReduction 0.0, plus a side panel showing the corresponding visual marker ServerAusfall IPR placed on a Petri net transition existiret die Komponente, and a project explorer listing the risk XML files alongside the process XML files](docs/foundations/risk-instance-server-ausfall.png)

A real risk document — *ServerAusfall* with a *ServerReplikation* reduction tactic — and the visual marker that binds it to a specific transition in the net. Today the equivalent in an Agentic-Net is a per-transition policy block (`autoEmit:false`, `capacity:200`, role flag, retry policy) carried in the inscription JSON; the structure is unchanged.

#### 12. A transition under multiple stacked risks

![A small Petri net fragment showing a single ProjectManager transition with three independent risk markers attached: EarthquakeRisk ISR pointing in from one side, Server down IPR from another, and CoolingUnitRisk CR from below; surrounded by Place, Place1, EmergencyEvacuation, and Temperature decreasing tokens](docs/foundations/transition-with-risks.png)

One transition, three independent risks — *EarthquakeRisk ISR*, *Server-down IPR*, *CoolingUnitRisk CR* — modelled as orthogonal governance constraints. This is the same composition pattern Agentic-Nets uses today when an agent transition runs under a stacked role flag, capacity limit, retry budget, and credential scope simultaneously.

#### 13. A process fragment with a risk attached to a real transition

![A small Petri net showing the place F-Anforderungen flowing into the transition existiert die Komponente bereits, which has the risk marker ServerAusfall CR with a ServerKuehlRaum reduction attached above; the transition emits to existierende Komponente; another transition existiret die Komponente nicht emits to Nicht-Existierende Komponente, with Produktbibliothek as a shared input place](docs/foundations/process-fragment-with-risk.png)

The same modelling primitive in a real workflow context: the *ServerAusfall* risk attaches to the existence-check transition with a *ServerKuehlRaum* reduction tactic — the direct ancestor of an Agentic-Net where an HTTP transition firing under a strict timeout has its retry policy and fallback emit rules encoded right next to it in the inscription.

### Act V — Validation: a real process, simulated end to end

#### 14. The Globale-Softwareentwicklung case study

![A large complex Petri net spanning the page, depicting a global software development process with many places (such as Pflichtenheft, F-Anforderungen, NF-Anforderungen, fertige Software, Inhouse-Funk-fa, fertige Komponente Inhouse, fertige Komponente Offshore) connected through transitions for splitting requirements, deciding inhouse versus offshore development, integration, and final product assembly, all linked by a dense web of arcs](docs/foundations/case-study-software-process.png)

The thesis closes with a real-world process — a globally distributed software development workflow — modelled and simulated end-to-end on the runtime built in the preceding chapters. The same kind of composition is what Agentic-Nets does today with multi-net workflows like the agile-team net, the intel-gather platform, or the log analyzer: the substrate scales from a toy example to an actual operating system for a process, and back.

---

## Bibliography

- Sailer, A. (2012). *Konzeption und Realisierung einer Simulationskomponente zur risikobewussten Prozessanalyse* [Diplomarbeit]. Karlsruher Institut für Technologie, Institut AIFB.
- Petri, C. A. (1962). *Kommunikation mit Automaten* [Dissertation]. Universität Hamburg.
- Reisig, W. *Petrinetze: Modellierungstechnik, Analysemethoden, Fallstudien*. Springer.
- Priese, L. & Wimmel, H. (2003). *Theoretische Informatik: Petri-Netze*. Springer. (Cited in the thesis as PrWi03 for the formal Petri-net definition.)
- van der Aalst, W. M. P. (1997). *Verification of Workflow Nets*. Application and Theory of Petri Nets 1997, LNCS 1248.

---

*Agentic-Nets is built on a substrate that has been studied for sixty years and prototyped by the author in 2012. The runtime in this repository is the result of taking that substrate seriously for AI agents.*
