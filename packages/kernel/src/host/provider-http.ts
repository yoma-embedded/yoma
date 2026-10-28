/** Never expose an authenticated endpoint's error body to the renderer. */
export async function providerJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status}`)
  }
  if (!response.body) throw new Error("Empty provider response")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = "",
    bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 2 * 1024 * 1024) throw new Error("Provider response is too large")
      text += decoder.decode(value, { stream: true })
    }
    return JSON.parse(text + decoder.decode()) as unknown
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
