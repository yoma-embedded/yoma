import { useLanguage } from "@/context/language"

const zh = {
  history: "历史采集", readOnly: "只读回放", select: "选择示波器历史采集", refresh: "刷新历史",
  missingOption: "文件已缺失", listError: "采集列表读取失败", reading: "读取保存的采集…",
  emptyTitle: "示波器 · 波形记录", empty: "采集后，在这里独立查看波形、缩放与测量。保存的记录无需连接仪器即可回放。",
  emptyHelp: "首次采集可让 agent 连接示波器并保存波形。", instrument: "示波器",
  single: "单次触发采集", current: "读取当前记录", saved: "保存的记录", trigger: "触发状态（采集时）", unknown: "未记录",
  overview: "概览抽样 · 可能遗漏采样间的毛刺", exact: "连续采样记录", acquisition: "采集信息",
  sampling: "采样详情", stored: "已存", record: "记录", points: "点", unthinned: "未抽样", stride: "每 {stride} 点取 1 点",
  missing: "这份历史采集的文件已缺失或损坏", restore: "请选择另一份采集，或恢复原始文件。",
  noScreenshot: "这份采集未关联仪器截图。", readScreenshot: "查看仪器截图", readingScreenshot: "读取截图…",
  rereadScreenshot: "重新读取截图", screenshot: "示波器仪器截图", enlargeScreenshot: "放大仪器截图",
  screenshotError: "截图文件无法显示", noReadableScreenshot: "这份采集没有可读取的截图",
  screenshotTime: "截图时间", screenshotHint: "截图是仪器屏幕图像；上方波形来自保存的采样数据。",
  waveformError: "保存的波形无法读取", panLeft: "向前平移", panRight: "向后平移", zoomIn: "放大波形", zoomOut: "缩小波形",
  fit: "全程", cursorA: "游标 A", cursorB: "游标 B", clear: "清游标", axisUnit: "纵轴单位",
  canvas: "示波器保存波形，横轴为触发相对时间，纵轴为通道标注单位", loading: "读取保存数据…", chooseChannel: "请选择要查看的通道",
  view: "视窗", horizontal: "时基", vertical: "纵轴", auto: "自动量程", preview: "预览", envelope: "保峰包络", samples: "实际采样点",
  cursorReadings: "示波器游标读数", channel: "通道", delta: "幅值差 / Δt 样本", range: "范围", zoomForDelta: "放大到实际采样点后显示",
  cursorHint: "点击波形放置游标，Shift + 点击放 B", navigationHint: "滚轮 / 双指缩放 · 拖动平移 · 双击全程",
  clipping: "触及量程边界", captureScale: "采集时", rate: "已存采样率",
} as const

const en: Record<keyof typeof zh, string> = {
  history: "Capture history", readOnly: "Read-only replay", select: "Select oscilloscope capture", refresh: "Refresh history",
  missingOption: "File missing", listError: "Unable to read capture history", reading: "Reading saved captures…",
  emptyTitle: "Oscilloscope · waveform records", empty: "Review, zoom and measure captured waveforms here. Saved records can be replayed without an instrument connection.",
  emptyHelp: "For a first capture, ask the agent to connect to your oscilloscope and save a waveform.", instrument: "Oscilloscope",
  single: "Single-trigger capture", current: "Current record", saved: "Saved record", trigger: "Trigger at capture", unknown: "Not recorded",
  overview: "Subsampled overview · may miss inter-sample glitches", exact: "Continuous sample record", acquisition: "Acquisition details",
  sampling: "Sampling details", stored: "Saved", record: "record", points: "points", unthinned: "Not subsampled", stride: "1 in {stride} samples",
  missing: "This historical capture is missing or damaged", restore: "Select another capture or restore the original files.",
  noScreenshot: "No instrument screenshot is associated with this capture.", readScreenshot: "View instrument screenshot", readingScreenshot: "Reading screenshot…",
  rereadScreenshot: "Reload screenshot", screenshot: "Oscilloscope screenshot", enlargeScreenshot: "Enlarge instrument screenshot",
  screenshotError: "Unable to display screenshot", noReadableScreenshot: "This capture has no readable screenshot",
  screenshotTime: "Screenshot time", screenshotHint: "The screenshot shows the instrument display; the waveform above uses saved samples.",
  waveformError: "Unable to read saved waveform", panLeft: "Pan earlier", panRight: "Pan later", zoomIn: "Zoom in", zoomOut: "Zoom out",
  fit: "Fit", cursorA: "Cursor A", cursorB: "Cursor B", clear: "Clear cursors", axisUnit: "Vertical unit",
  canvas: "Saved oscilloscope waveform: trigger-relative time on the horizontal axis and channel units on the vertical axis", loading: "Reading saved data…", chooseChannel: "Select a channel to view",
  view: "Window", horizontal: "Timebase", vertical: "Vertical", auto: "Auto range", preview: "Preview", envelope: "Peak envelope", samples: "Stored samples",
  cursorReadings: "Oscilloscope cursor readings", channel: "Channel", delta: "Amplitude / sample Δt", range: "range", zoomForDelta: "Zoom in to stored samples",
  cursorHint: "Click to place a cursor; Shift + click places B", navigationHint: "Scroll / pinch to zoom · drag to pan · double-click to fit",
  clipping: "At ADC limit", captureScale: "At capture", rate: "Saved sample rate",
}

export function useScopeCopy() {
  const language = useLanguage()
  return (key: keyof typeof zh, values?: Record<string, string | number>) => {
    const value: string = (language.locale() === "zh" ? zh : en)[key]
    return values ? value.replace(/\{(\w+)\}/g, (match, name: string) => String(values[name] ?? match)) : value
  }
}
