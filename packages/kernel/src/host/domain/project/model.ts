/** Domain data; no host or browser dependencies. Host RPC return types check the wire shape. */
export interface ProjectProfile {
  name: string
  chip: string
  board: string
  framework: string
  buildCommand: string
  firmware: string
  probe: string
  log: string
  verification: string
}
export type MemoryKind = "fact" | "experience" | "handoff"
export type MemoryConfidence = "verified" | "hypothesis"
export interface ProjectMemory {
  id: string
  title: string
  content: string
  kind: MemoryKind
  confidence: MemoryConfidence
  evidence: string
  scope: string
  enabled: boolean
  updatedAt: string
  source: string
}
export interface ProjectBaseline {
  profile: ProjectProfile
  command: string
  checkedAt: string
  exitCode: number
  ok: boolean
  output: string
  firmwareHash?: string
}
export interface ProjectContextView {
  root: string
  revision: string
  profile: ProjectProfile
  saved: boolean
  detectedFrom: string[]
  memories: ProjectMemory[]
  baseline?: ProjectBaseline
  warnings: string[]
}
export interface MemoryInput {
  id?: string
  title: string
  content: string
  kind: MemoryKind
  confidence: MemoryConfidence
  evidence: string
  scope: string
  enabled: boolean
}
