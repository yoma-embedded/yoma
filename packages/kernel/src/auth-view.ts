/** Login display state only. Credentials never cross the kernel boundary. */
export interface AuthLoginView {
  id: string
  providerID: string
  status: "pending" | "success" | "cancelled" | "failed"
  prompt?: {
    id: string
    type: "text" | "secret" | "select" | "manual_code"
    message: string
    placeholder?: string
    options?: Array<{ id: string; label: string; description?: string }>
  }
  notice?: {
    type: "info" | "auth_url" | "device_code" | "progress"
    message?: string
    url?: string
    userCode?: string
  }
  error?: string
}
