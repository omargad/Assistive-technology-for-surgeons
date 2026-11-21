# SurgeonPulse documentation

SurgeonPulse records a consenting surgeon's own heart rate during operations, lets the team mark operative phases and
events, collects a short post-operative workload debrief, and turns the data into reflective feedback for the surgeon
and cohort analyses for the research team. Start with the [project README](../README.md) for an overview and a quick
start.

> SurgeonPulse is a research tool, **not a medical device**. It does not diagnose anything, raises no alerts and does
> not monitor patients.

## Where to start

| You are… | Read |
| --- | --- |
| A surgeon taking part, or a team member who logs events in theatre | [User guide, Part A](user-guide.md#part-a-for-surgeons-participants), then [hardware](hardware.md) for wearing and pairing a strap |
| A clinical researcher planning or running a study | [Study protocol template](study-protocol.md), [privacy, ethics and governance](privacy-ethics.md), [metrics](metrics.md), [data model](data-model.md) |
| A data analyst | [Data model](data-model.md) (JSON and CSV formats), [metrics](metrics.md), [Python toolkit](../analysis/README.md) |
| A developer | [Architecture](architecture.md), [development guide](development.md), then the component READMEs and specs below |
| A research coordinator running the study server | [User guide, Part B](user-guide.md#part-b-for-research-coordinators), then the [server README](../apps/server/README.md) |

## Project documents (this folder)

| Document | Contents |
| --- | --- |
| [User guide](user-guide.md) | Part A for surgeons taking part (onboarding, pairing, recording, debrief, feedback, export, withdrawal); Part B for research coordinators (server, enrolment tokens, dashboard, exports) |
| [Hardware and sensors](hardware.md) | Supported heart-rate sources, choosing a sensor, practical use in theatre, pilot checklist, troubleshooting |
| [Privacy, ethics and governance](privacy-ethics.md) | Privacy by design as implemented, what is stored where, known gaps, the Australian ethics, privacy and regulatory landscape, HREC checklist |
| [Study protocol template](study-protocol.md) | A template protocol for an observational study, with operational definitions, measures and an analysis plan |
| [Architecture](architecture.md) | Design principles, components, data flows, sequence diagrams, recording state machine, cross-platform design, storage, security model |
| [Data model](data-model.md) | `SurgicalSession` and `ExportBundle` JSON, versioning, CSV exports, de-identification, participant codes, procedure catalogue |
| [Metrics](metrics.md) | Exact definitions of every metric, with interpretation notes, caveats and references |
| [Development guide](development.md) | Prerequisites, scripts, tests, fixtures and parity, extending SurgeonPulse, conventions, native builds, CI |

## Component documents

| Component | README | Specification |
| --- | --- | --- |
| Core library (`packages/core`) | | [SPEC.md](../packages/core/SPEC.md) |
| Mobile app (`apps/mobile`) | [README.md](../apps/mobile/README.md) | [SPEC.md](../apps/mobile/SPEC.md) |
| Dashboard (`apps/dashboard`) | [README.md](../apps/dashboard/README.md) | [SPEC.md](../apps/dashboard/SPEC.md) |
| Ingest server (`apps/server`) | [README.md](../apps/server/README.md) | [SPEC.md](../apps/server/SPEC.md) |
| Python toolkit (`analysis`) | [README.md](../analysis/README.md) | |
| Parity fixtures (`fixtures`) | [README.md](../fixtures/README.md) | |

## Status of this documentation

The documents describe the code as it is in this repository (version 0.1.0). Where the code and a document disagree,
the code and the component specifications are the source of truth; please report the mismatch. Legal, regulatory and
ethics content is planning guidance, not legal advice: the reviewing Human Research Ethics Committee (HREC),
Swinburne University of Technology's privacy office and the participating health services have the final say.
