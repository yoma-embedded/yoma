import { base64Encode } from "@yoma-desktop/util/encode"

export function stressSessionHref(sessionID: string) {
  return `/server/${base64Encode(stressServer())}/session/${sessionID}`
}

function stressServer() {
  return `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`
}
