/** Browser-safe, read-only views of saved oscilloscope captures. Times are seconds relative to trigger. */
export interface ScopeChannelInfo {
  ch: number
  label?: string
  unit: string
  probe: number
  coupling?: string
  vdiv: number
  offset: number
  points: number
  recordPoints: number
  stride: number
  interval: number
  t0: number
  /** Samples within 1% of the ADC rails at capture time; peaks are bounds, not readings. */
  clipped?: { low: number; high: number }
}

export interface ScopeCaptureInfo {
  id: string
  dir: string
  createdAt: number
  /** Instrument's own acquisition time (local, no zone) when the driver reported one. */
  acquiredAt?: string
  address: string
  driver?: string
  model?: string
  serial?: string
  mode: string
  quality: "exact" | "overview"
  trigger?: { mode?: string; source?: string; level?: number; slope?: string; status?: string }
  from: number
  to: number
  channels: ScopeChannelInfo[]
  screenshot?: { createdAt: number }
}

export interface ScopeViewParams {
  dir: string
  from?: number
  to?: number
  columns: number
  channels?: number[]
}

export interface ScopeViewResult {
  capture: ScopeCaptureInfo
  from: number
  to: number
  columns: number
  channels: {
    ch: number
    label?: string
    unit: string
    /** True only when each point is an actual stored sample; otherwise points are min/max envelopes. */
    exact: boolean
    points: { t: number; min: number; max: number }[]
  }[]
}
