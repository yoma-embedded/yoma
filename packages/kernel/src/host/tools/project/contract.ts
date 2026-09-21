import { Type, type Static } from "typebox"
import type { ToolContract } from "../contract-types.ts"

const profile = Type.Object({
  name: Type.String(),
  chip: Type.String(),
  board: Type.String(),
  framework: Type.String(),
  buildCommand: Type.String(),
  firmware: Type.String(),
  probe: Type.String(),
  log: Type.String(),
  verification: Type.String(),
})
const memory = Type.Object({
  id: Type.Optional(Type.String()),
  title: Type.String({ maxLength: 160 }),
  content: Type.String({ maxLength: 6000 }),
  kind: Type.Union([Type.Literal("fact"), Type.Literal("experience"), Type.Literal("handoff")]),
  confidence: Type.Union([Type.Literal("verified"), Type.Literal("hypothesis")]),
  evidence: Type.String({
    description: "Evidence path, measurement or explicit user statement. Required for verified entries.",
  }),
  scope: Type.String({ description: "Applicable board, revision or task. Empty means this project." }),
  enabled: Type.Boolean(),
})
const parameters = Type.Object({
  action: Type.Union(["inspect", "configure", "search", "remember", "forget"].map((x) => Type.Literal(x))),
  revision: Type.Optional(
    Type.String({ description: "Exact revision returned by the latest inspect. Required for every write." }),
  ),
  profile: Type.Optional(profile),
  memory: Type.Optional(memory),
  id: Type.Optional(Type.String()),
  query: Type.Optional(Type.String()),
})
export type ProjectInput = Static<typeof parameters>
export const PROJECT_CONTRACT = {
  name: "project",
  label: "工程与记忆",
  parameters,
  description: `Inspect the current project's detected/saved profile and durable memory. Project scope is the nearest .yoma/project.json or Git root.
Actions: inspect; configure (complete profile, firmware path relative to root); search (query, enabled memories only); remember (new or existing memory); forget (id).
All writes require a fresh revision from inspect; on conflict, inspect again and reconcile. remember must include evidence for verified facts; keep untested theories as hypotheses. Use stable titles and update existing IDs.
Save useful validated experience and a handoff before finishing a substantial task, without copying transcripts or credentials. Do not resurrect forgotten entries. Respect board and version scope. Machine paths stay in toolchain configuration.
This tool does not execute build or hardware commands. Run builds using the existing command tools and report actual evidence; saved/detected commands are not proof of success.`,
  guidelines: [
    "Use project to inspect project configuration and retrieve/save cross-session experience. Save verified findings with evidence and unresolved work as a handoff before your final reply; never persist secrets or promote hypotheses to facts.",
  ],
  summary: (input: Partial<ProjectInput>) => input.memory?.title ?? input.query ?? input.action ?? "",
} as const satisfies ToolContract<typeof parameters>
