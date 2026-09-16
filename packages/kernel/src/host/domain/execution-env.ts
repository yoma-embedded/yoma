/** A session's native processes and shell tools consume the same immutable environment snapshot. */
const snapshots = new WeakMap<object, Readonly<NodeJS.ProcessEnv>>()

export function bindExecutionEnv<T extends object>(env: T, variables: NodeJS.ProcessEnv): T {
  snapshots.set(env, Object.freeze({ ...variables }))
  return env
}

/** Standalone tools have no session binding; copy the host environment once at invocation entry. */
export function executionEnvSnapshot(env: object): NodeJS.ProcessEnv {
  return { ...(snapshots.get(env) ?? process.env) }
}
