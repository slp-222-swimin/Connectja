import { useEffect, useRef, useState, useLayoutEffect, useMemo, useCallback } from 'react'
import { createRoomScopedSupabase } from '../lib/supabase'
import { ArrowLeft, Save, Users, Settings, Info, Trash2, Undo, Redo, Copy, ClipboardPaste, ZoomIn, ZoomOut, Play, AlertTriangle, FileText, Download, History as HistoryIcon } from 'lucide-react'
import { guiToTja, tjaToGui, type TjaNote, type TjaCommand, type TjaMetadata } from '../lib/tjaConverter'
import MonacoEditor, { type OnMount } from '@monaco-editor/react'
import { TJA_LANGUAGE_ID, tjaLanguageConfig, tjaTokensProvider, tjaThemeRules } from '../lib/tjaLanguage'
import audioEngine from '../lib/AudioEngine'

interface Note {
  id: string
  room_id: string
  measure: number
  position: number
  type: string
  attributes: any
  last_modified_at: number
  last_modified_by?: string
}

interface Command {
  id: string
  room_id: string
  measure: number
  position: number
  type: 'BPM' | 'HS' | 'MEASURE' | 'GOGOSTART' | 'GOGOEND'
  value: string | null
  last_modified_at?: number
  last_modified_by?: string
}

interface EditorProps {
  roomId: string
  userId: string
  userName: string
  userColor: string
  onBack: () => void
}

type HistoryEntry = {
  action: string
  notes?: Note[]
  oldNotes?: Note[]
  newCommands?: Command[]
  oldCommands?: Command[]
  createdAt: number
  label: string
}

const GRID_DIVISIONS = 96
const LANE_HEIGHT = 200
const BASE_NOTE_RADIUS = 24
const HEADER_HEIGHT = 40
const WAVEFORM_HEIGHT = 100
const ZOOM_BASE_SCALE = 1.4
const BASE_LEAD_IN_MEASURES = 1
const NEGATIVE_LEAD_PADDING_MEASURES = 2 // buffer before chart start, per request
const AUDIO_START_BASE_SECONDS = 0 // base audio start time; extendable if audio file has extra lead-in
const PLAYBACK_START_PREROLL_SECONDS = 0.05 // start slightly earlier to avoid edge-note miss at play boundary
const PLAYBACK_AUDIO_ADVANCE_SECONDS = 1.19 // waveform reference delay (existing 1.16 + 0.03)
const IS_ELECTRON = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')
const DEFAULT_CHART_METADATA: TjaMetadata = {
  title: '',
  subtitle: '',
  offset: 0,
  difficulty: 'Oni',
  level: 10,
  sevol: 100,
  songvol: 100,
  audio_url: null
}

const withCacheBuster = (url: string) => {
  try {
    const parsed = new URL(url, window.location.origin)
    parsed.searchParams.set('v', Date.now().toString())
    return parsed.toString()
  } catch {
    const separator = url.includes('?') ? '&' : '?'
    return `${url}${separator}v=${Date.now()}`
  }
}

const sanitizeUserFacingText = (value: unknown, fallback = 'Unknown') => {
  const raw = String(value ?? '').trim()
  if (!raw) return fallback
  return raw.replace(/[<>"'`]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 40) || fallback
}

export default function Editor({ roomId, userId, userName, userColor, onBack }: EditorProps) {
  const supabase = useMemo(() => createRoomScopedSupabase(roomId), [roomId])
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const editorRef = useRef<any>(null)
  const editorDisposablesRef = useRef<any[]>([])
  const [notes, setNotes] = useState<Note[]>([])
  const [selectedType, setSelectedType] = useState<string>('1')
  const [roomName, setRoomName] = useState('')

  // Layout & View States
  const [baseWidth, setBaseWidth] = useState(1000)
  const [zoom, setZoom] = useState(1.0)
  const [seekPos, setSeekPos] = useState(() => -BASE_LEAD_IN_MEASURES) // start the seekbar at Measure -001
  const [snapDivisions, setSnapDivisions] = useState(8) // Default 8th notes

  // History & Advanced States (stored in ref for immediate access inside async handlers)
  const historyRef = useRef<HistoryEntry[]>([])
  const historyIndexRef = useRef(-1)
  // Keep reactive copies so the UI toolbar can read them
  const [historyLength, setHistoryLength] = useState(0)
  const [historyIndexState, setHistoryIndexState] = useState(-1)
  const [showHistoryModal, setShowHistoryModal] = useState(false)
  const [isHistoryJumping, setIsHistoryJumping] = useState(false)
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set())
  const [selectionBox, setSelectionBox] = useState<{ startX: number, startY: number, endX: number, endY: number } | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [isDraggingNotes, setIsDraggingNotes] = useState(false)
  const [currentMouseX, setCurrentMouseX] = useState<number | null>(null) // Track mouse X for edge auto-scroll
  const [dragStartGrid, setDragStartGrid] = useState<{ measure: number, pos: number } | null>(null)
  const [originalDraggingNotes, setOriginalDraggingNotes] = useState<Note[]>([])
  const [draggingEndpointId, setDraggingEndpointId] = useState<string | null>(null)
  const [isSeeking, setIsSeeking] = useState(false)
  const [hoverGridObj, setHoverGridObj] = useState<{ measure: number, pos: number }>({ measure: 0, pos: 0 })
  const [clipboard, setClipboard] = useState<Note[]>([])
  const [showResetModal, setShowResetModal] = useState(false)
  const [attributeModal, setAttributeModal] = useState<{ noteId: string, hits: string } | null>(null)

  // Command States
  const [commands, setCommands] = useState<Command[]>([])
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number, measure: number, pos: number } | null>(null)
  const [commandModal, setCommandModal] = useState<{ type: 'BPM' | 'HS' | 'MEASURE' | 'GOGOSTART' | 'GOGOEND', measure: number, pos: number } | null>(null)
  const [commandValue, setCommandValue] = useState<string>('')
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rightDragRef = useRef<{ startX: number, startY: number, moved: boolean } | null>(null)
  const suppressContextMenuRef = useRef(false)

  // Presence State
  const [presenceState, setPresenceState] = useState<Record<string, any>>({})
  const channelRef = useRef<any>(null)
  const [presenceNotices, setPresenceNotices] = useState<{ id: string, message: string, color: string }[]>([])

  // Metadata States
  const [metadata, setMetadata] = useState<TjaMetadata>({ ...DEFAULT_CHART_METADATA })

  const initialBpmCmd = commands.find(c => c.type === 'BPM' && c.measure === 0 && c.position === 0)
  const initialBpmValue = parseFloat(initialBpmCmd?.value || '120')
  const normalizedBpm = initialBpmValue > 0 ? initialBpmValue : 120
  const measureDurationSec = (60 / normalizedBpm) * 4
  const leadSeconds = Math.max(0, AUDIO_START_BASE_SECONDS + (metadata.offset ?? 0))
  const leadInMeasures = Math.max(BASE_LEAD_IN_MEASURES, Math.ceil(leadSeconds / Math.max(measureDurationSec, 0.001)) + NEGATIVE_LEAD_PADDING_MEASURES)

  // Audio & Playback States
  const [audioUrl, setAudioUrl] = useState<string | null>(null)
  const [audioUploading, setAudioUploading] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [waveformPeaks, setWaveformPeaks] = useState<number[]>([])
  const [audioDuration, setAudioDuration] = useState(0)

  // TJA Text Editor State
  const [tjaText, setTjaText] = useState('')
  const [editorStatus, setEditorStatus] = useState({ line: 1, column: 1, totalLines: 1, totalChars: 0 })
  const [roomSupportsTjaSource, setRoomSupportsTjaSource] = useState(false)
  const tjaSourceRef = useRef<'gui' | 'tja' | null>(null)
  const [tjaDirty, setTjaDirty] = useState(false)
  const monacoInitializedRef = useRef(false)

  // Export/Delete Modal State
  const [showExportDeleteModal, setShowExportDeleteModal] = useState(false)
  const [deleteAfterExport, setDeleteAfterExport] = useState(false)

  // Import TJA Modal State
  const [showImportModal, setShowImportModal] = useState(false)
  const [importTjaFileText, setImportTjaFileText] = useState('')
  const [importTjaFileName, setImportTjaFileName] = useState('')
  const [measureJumpInput, setMeasureJumpInput] = useState('0')
  const editorStatusTickRef = useRef<number | null>(null)
  const initialSeekSyncedRef = useRef(false)
  const previousLeadInMeasuresRef = useRef(BASE_LEAD_IN_MEASURES)
  const lastAutoScrollLeftRef = useRef(0)
  const previousZoomRef = useRef(1.0)
  const seekMagnetAnimRef = useRef<number | null>(null)
  const latestSeekPosRef = useRef(0)
  const lastMagnetDirectionRef = useRef(1)
  const seekGestureRef = useRef<{ startX: number, moved: boolean, rawSeek: number, snappedSeek: number } | null>(null)
  const noteHitAnimRef = useRef<Map<string, number>>(new Map()) // noteId -> AudioContext scheduled time
  const lastSavedTjaTextRef = useRef('')
  const getSafeLastModifiedAt = useCallback((value: unknown) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return 0
    return Math.min(n, Date.now() + 5000)
  }, [])

  const syncEditorStatus = useCallback(() => {
    const editor = editorRef.current
    if (!editor) return
    const model = editor.getModel?.()
    if (!model) return
    const pos = editor.getPosition?.()
    setEditorStatus({
      line: pos?.lineNumber ?? 1,
      column: pos?.column ?? 1,
      totalLines: model.getLineCount(),
      totalChars: model.getValueLength()
    })
  }, [])

  const pushPresenceNotice = useCallback((message: string, color: string) => {
    const id = crypto.randomUUID()
    setPresenceNotices(prev => [...prev, { id, message, color }].slice(-5))
    window.setTimeout(() => {
      setPresenceNotices(prev => prev.filter(n => n.id !== id))
    }, 5000)
  }, [])

  const remoteUsers = useMemo(() => {
    const users: { key: string, userId: string, userName: string, userColor: string, seekPos: number }[] = []
    Object.entries(presenceState).forEach(([key, presences]) => {
      if (!Array.isArray(presences) || presences.length === 0) return
      const p = presences[presences.length - 1] || {}
      const pid = String(p.userId || key)
      if (pid === userId) return
      users.push({
        key,
        userId: pid,
        userName: sanitizeUserFacingText(p.userName, 'Unknown'),
        userColor: String(p.userColor || '#888'),
        seekPos: typeof p.seekPos === 'number' ? p.seekPos : 0
      })
    })
    return users
  }, [presenceState, userId])

  useEffect(() => {
    audioEngine.setVolumes((metadata.songvol ?? 100) / 100, (metadata.sevol ?? 100) / 100)
  }, [metadata.songvol, metadata.sevol])

  const SNAP_OPTIONS = [4, 8, 12, 16, 24, 32, 48]
  const BASE_MEASURE_WIDTH = (baseWidth * 0.5) * zoom * ZOOM_BASE_SCALE // 4/4 width

  const maxMeasure = Math.max(0, ...notes.map(n => n.measure))

  const tjaMeasureCount = useMemo(() => {
    if (!tjaText) return 0
    const lines = tjaText.split('\n')
    let inChart = false
    let measures = 0

    for (const raw of lines) {
      const line = raw.trim()
      if (!inChart) {
        if (line === '#START') inChart = true
        continue
      }
      if (line === '#END') break
      if (line.includes(',')) measures += 1
    }

    return measures
  }, [tjaText])

  const audioMeasures = useMemo(() => {
    if (audioDuration <= 0) return 0
    let time = 0
    let m = 0
    let bpmValue = parseFloat(commands.find(c => c.type === 'BPM' && c.measure === 0 && c.position === 0)?.value || '120')
    let currentBPM = isNaN(bpmValue) || bpmValue <= 0 ? 120 : bpmValue

    // Simulate up to 2000 measures or until audio covered
    while (time < audioDuration - metadata.offset && m < 2000) {
      // Measure length
      const mCmd = [...commands].filter(c => c.type === 'MEASURE' && c.measure <= m).sort((a, b) => a.measure - b.measure).pop()
      let n = 4, d = 4
      if (mCmd && mCmd.value) {
        const [vn, vd] = mCmd.value.split('/').map(Number)
        if (!isNaN(vn) && !isNaN(vd) && vd !== 0) { n = vn; d = vd }
      }

      // BPM
      const bpmCmd = commands.find(c => c.type === 'BPM' && c.measure === m && c.position === 0)
      if (bpmCmd && bpmCmd.value) {
        const newVal = parseFloat(bpmCmd.value)
        if (!isNaN(newVal) && newVal > 0) currentBPM = newVal
      }

      const length = n / d
      const duration = (60 / currentBPM) * 4 * length
      if (isNaN(duration) || duration <= 0) break; // safety
      time += duration
      m++
    }
    return m
  }, [audioDuration, commands, metadata.offset])

  const TOTAL_MEASURES = Math.max(10, maxMeasure + 3, audioMeasures + 2, tjaMeasureCount + 4)

  // Pre-calculate measure details for both UI and Audio
  const measureInfos = useMemo(() => {
    const infos: { n: number, d: number, length: number, bpm: number, startTime: number, duration: number, offsetX: number, totalWidth: number, posOffsets: number[], timeOffsets: number[] }[] = []
    let currentOffsetX = 0
    let currentStartTime = 0

    let currentBPM = 120
    let currentHS = 1.0

    const firstM = -leadInMeasures

    // Find initial BPM
    const initialBPMCmd = [...commands]
      .filter(c => c.type === 'BPM' && (c.measure < firstM || (c.measure === firstM && c.position === 0)))
      .sort((a, b) => (a.measure - b.measure) || (a.position - b.position))
      .pop()
    if (initialBPMCmd && initialBPMCmd.value) {
      const val = parseFloat(initialBPMCmd.value)
      if (!isNaN(val) && val > 0) currentBPM = val
    }

    // Find initial HS
    const initialHSCmd = [...commands]
      .filter(c => c.type === 'HS' && (c.measure < firstM || (c.measure === firstM && c.position === 0)))
      .sort((a, b) => (a.measure - b.measure) || (a.position - b.position))
      .pop()
    if (initialHSCmd && initialHSCmd.value) {
      const val = parseFloat(initialHSCmd.value)
      if (!isNaN(val)) currentHS = val
    }

    for (let i = 0; i < TOTAL_MEASURES + leadInMeasures; i++) {
      const m = i - leadInMeasures

      // Get Measure Command
      const mCmd = [...commands].filter(c => c.type === 'MEASURE' && c.measure <= m).sort((a, b) => a.measure - b.measure).pop()
      let n = 4, d = 4
      if (mCmd && mCmd.value) {
        const [vn, vd] = mCmd.value.split('/').map(Number)
        if (!isNaN(vn) && !isNaN(vd) && vd !== 0) { n = vn; d = vd }
      }

      const length = n / d

      // Calculate POS and TIME Offsets (HS and BPM aware)
      const intraCmds = commands.filter(c => (c.type === 'HS' || c.type === 'BPM') && c.measure === m).sort((a, b) => a.position - b.position)
      const posOffsets: number[] = new Array(GRID_DIVISIONS + 1)
      const timeOffsets: number[] = new Array(GRID_DIVISIONS + 1)
      posOffsets[0] = 0
      timeOffsets[0] = 0

      let lastP = 0
      let lastSegPosX = 0
      let lastSegTime = 0

      for (const cmd of intraCmds) {
        const p = Math.max(0, Math.min(GRID_DIVISIONS, cmd.position))
        const segmentLen = p - lastP
        const measurePx = length * BASE_MEASURE_WIDTH
        const measureTime = (60 / currentBPM) * 4 * length

        for (let j = lastP + 1; j <= p; j++) {
          const progressInSegment = (j - lastP) / GRID_DIVISIONS
          posOffsets[j] = lastSegPosX + progressInSegment * currentHS * measurePx
          timeOffsets[j] = lastSegTime + progressInSegment * measureTime
        }

        lastSegPosX = posOffsets[p]
        lastSegTime = timeOffsets[p]
        lastP = p

        if (cmd.type === 'HS') {
          const val = parseFloat(cmd.value || '1.0')
          if (!isNaN(val)) currentHS = val
        } else if (cmd.type === 'BPM') {
          const val = parseFloat(cmd.value || '120')
          if (!isNaN(val) && val > 0) currentBPM = val
        }
      }

      // Finish to the end of measure
      const finalSegmentLen = GRID_DIVISIONS - lastP
      const measurePx = length * BASE_MEASURE_WIDTH
      const measureTime = (60 / currentBPM) * 4 * length
      for (let j = lastP + 1; j <= GRID_DIVISIONS; j++) {
        const progressInSegment = (j - lastP) / GRID_DIVISIONS
        posOffsets[j] = lastSegPosX + progressInSegment * currentHS * measurePx
        timeOffsets[j] = lastSegTime + progressInSegment * measureTime
      }

      const totalWidth = posOffsets[GRID_DIVISIONS]
      const duration = timeOffsets[GRID_DIVISIONS]

      infos[i] = {
        n, d, length, bpm: currentBPM,
        startTime: currentStartTime,
        duration,
        offsetX: currentOffsetX,
        totalWidth,
        posOffsets,
        timeOffsets
      }

      currentOffsetX += totalWidth
      currentStartTime += duration
    }
    return infos
  }, [commands, TOTAL_MEASURES, zoom, baseWidth, leadInMeasures])

  const getMeasureInfo = (m: number) => {
    const idx = m + leadInMeasures
    if (!measureInfos[idx]) {
      const dummyPosOffsets = new Array(GRID_DIVISIONS + 1).fill(0).map((_, i) => (i / GRID_DIVISIONS) * BASE_MEASURE_WIDTH)
      const dummyTimeOffsets = new Array(GRID_DIVISIONS + 1).fill(0).map((_, i) => (i / GRID_DIVISIONS) * 2.0)
      return { n: 4, d: 4, length: 1.0, bpm: 120, startTime: 0, duration: 2.0, offsetX: 0, totalWidth: BASE_MEASURE_WIDTH, posOffsets: dummyPosOffsets, timeOffsets: dummyTimeOffsets }
    }
    return measureInfos[idx]
  }

  const measureOffsets = useMemo(() => measureInfos.map(info => info.offsetX), [measureInfos])
  const CANVAS_WIDTH = measureInfos[measureInfos.length - 1]?.offsetX + (measureInfos[measureInfos.length - 1]?.totalWidth) || 5000

  const getX = useCallback((measure: number, position: number) => {
    let m = measure
    let p = position
    // Normalize position overflows
    while (p >= GRID_DIVISIONS) { p -= GRID_DIVISIONS; m += 1 }
    while (p < 0) { p += GRID_DIVISIONS; m -= 1 }

    const info = getMeasureInfo(m)
    const p0 = Math.floor(Math.max(0, Math.min(GRID_DIVISIONS, p)))
    const p1 = Math.min(GRID_DIVISIONS, p0 + 1)
    const f = p - p0

    const x0 = info.posOffsets[p0]
    const x1 = info.posOffsets[p1]
    return info.offsetX + x0 + f * (x1 - x0)
  }, [measureInfos, baseWidth, zoom])

  const getAbsoluteTime = useCallback((m: number, p: number) => {
    const info = getMeasureInfo(m)
    const measure0Info = getMeasureInfo(0)
    const timeRelativeToMeasure0 = info.startTime - measure0Info.startTime

    const p0 = Math.floor(Math.max(0, Math.min(GRID_DIVISIONS, p)))
    const p1 = Math.min(GRID_DIVISIONS, p0 + 1)
    const f = p - p0
    const localTime = info.timeOffsets[p0] + f * (info.timeOffsets[p1] - info.timeOffsets[p0])

    // TJA OFFSET standard: music_time = chart_time - OFFSET
    return timeRelativeToMeasure0 + localTime - metadata.offset
  }, [measureInfos, metadata.offset, leadInMeasures])

  const getPosFromTime = useCallback((t: number) => {
    const measure0Info = getMeasureInfo(0)
    // t is relative to music start (audioTime).
    // chartTime = audioTime + OFFSET
    const chartTime = t + metadata.offset
    const absoluteDisplayTime = chartTime + measure0Info.startTime

    let mIdx = measureInfos.findIndex((info, i) => {
      const nextInfo = measureInfos[i + 1]
      return absoluteDisplayTime >= info.startTime && (!nextInfo || absoluteDisplayTime < nextInfo.startTime)
    })

    if (mIdx === -1) {
      if (absoluteDisplayTime < measureInfos[0].startTime) mIdx = 0
      else mIdx = measureInfos.length - 1
    }

    const info = measureInfos[mIdx]
    const localTime = absoluteDisplayTime - info.startTime

    let p = 0
    if (localTime <= 0) p = 0
    else if (localTime >= info.duration) p = GRID_DIVISIONS
    else {
      let est = Math.floor((localTime / info.duration) * GRID_DIVISIONS)
      p = est
      if (info.timeOffsets[p] < localTime) {
        while (p < GRID_DIVISIONS && info.timeOffsets[p + 1] < localTime) p++
      } else {
        while (p > 0 && info.timeOffsets[p] > localTime) p--
      }
    }

    const t0 = info.timeOffsets[p], t1 = info.timeOffsets[p + 1] || t0
    const fraction = t1 > t0 ? (localTime - t0) / (t1 - t0) : 0
    return { measure: mIdx - leadInMeasures, pos: p + fraction }
  }, [measureInfos, metadata.offset, leadInMeasures])

  const centerScrollOnX = useCallback((targetX: number, smooth = false) => {
    const container = containerRef.current
    if (!container) return
    const halfWidth = container.clientWidth / 2
    const maxScroll = Math.max(0, container.scrollWidth - container.clientWidth)
    const desiredScrollLeft = Math.round(Math.min(maxScroll, Math.max(0, targetX - halfWidth)))

    if (!smooth) {
      // Prevent tiny oscillations from sub-pixel seek updates that cause visual blur/afterimage.
      if (Math.abs(desiredScrollLeft - lastAutoScrollLeftRef.current) < 2) return
    }
    lastAutoScrollLeftRef.current = desiredScrollLeft
    if (smooth) {
      container.scrollTo({ left: desiredScrollLeft, behavior: 'smooth' })
    } else {
      container.scrollLeft = desiredScrollLeft
    }
  }, [])

  const centerScrollOnSeek = useCallback((seek: number, smooth = false) => {
    const measure = Math.floor(seek)
    const position = (seek - measure) * GRID_DIVISIONS
    const targetX = getX(measure, position)
    centerScrollOnX(targetX, smooth)
  }, [getX, centerScrollOnX])

  const jumpToChartStart = useCallback((smoothScroll = false) => {
    if (audioEngine.isPlaying) {
      audioEngine.stop()
      setIsPlaying(false)
    }
    const startPos = 0
    setSeekPos(startPos)
    centerScrollOnSeek(startPos, smoothScroll)
  }, [centerScrollOnSeek])

  const handleBackClick = useCallback(() => {
    audioEngine.stop()
    setIsPlaying(false)
    onBack()
  }, [onBack])

  const stateRef = useRef({ notes, selectedNotes, clipboard, hoverGridObj, snapDivisions, commands, draggingEndpointId, isDraggingNotes, dragStartGrid, originalDraggingNotes, metadata, getAbsoluteTime })
  useEffect(() => {
    stateRef.current = { notes, selectedNotes, clipboard, hoverGridObj, snapDivisions, commands, draggingEndpointId, isDraggingNotes, dragStartGrid, originalDraggingNotes, metadata, getAbsoluteTime }
  })

  useEffect(() => {
    const previousLead = previousLeadInMeasuresRef.current
    const previousStart = -previousLead
    const nextStart = -leadInMeasures

    if (!initialSeekSyncedRef.current) {
      setSeekPos(nextStart)
      centerScrollOnSeek(nextStart)
      initialSeekSyncedRef.current = true
    } else {
      setSeekPos(prev => {
        if (Math.abs(prev - previousStart) < 0.01 || prev < nextStart) {
          return nextStart
        }
        return prev
      })
    }

    previousLeadInMeasuresRef.current = leadInMeasures
  }, [leadInMeasures, centerScrollOnSeek])

  const getHistoryLabel = useCallback((entry: { action: string, notes?: Note[], oldNotes?: Note[], newCommands?: Command[], oldCommands?: Command[] }) => {
    const countNotes = entry.notes?.length ?? 0
    const countOldNotes = entry.oldNotes?.length ?? 0
    const countNewCmds = entry.newCommands?.length ?? 0
    const countOldCmds = entry.oldCommands?.length ?? 0

    switch (entry.action) {
      case 'INSERT': return `Note Insert (${countNotes})`
      case 'DELETE': return `Note Delete (${countNotes})`
      case 'UPDATE': return `Note Move/Update (${Math.max(countNotes, countOldNotes)})`
      case 'CMD_INSERT': return `Command Insert (${countNewCmds})`
      case 'CMD_DELETE': return `Command Delete (${countOldCmds})`
      case 'CMD_UPDATE': return `Command Update (${Math.max(countNewCmds, countOldCmds)})`
      default: return entry.action
    }
  }, [])

  const MAX_HISTORY = 30
  const pushHistory = useCallback((entry: { action: string, notes?: Note[], oldNotes?: Note[], newCommands?: Command[], oldCommands?: Command[] }) => {
    const normalizedEntry: HistoryEntry = {
      ...entry,
      createdAt: Date.now(),
      label: getHistoryLabel(entry)
    }
    // Truncate redo tree
    const sliced = historyRef.current.slice(0, historyIndexRef.current + 1)
    sliced.push(normalizedEntry)
    // Cap at MAX_HISTORY
    if (sliced.length > MAX_HISTORY) sliced.splice(0, sliced.length - MAX_HISTORY)
    historyRef.current = sliced
    historyIndexRef.current = sliced.length - 1
    setHistoryLength(sliced.length)
    setHistoryIndexState(historyIndexRef.current)
  }, [getHistoryLabel])


  const getGridFromX = (x: number) => {
    let mIdx = measureOffsets.findLastIndex(offset => x >= offset - 0.001) // Small epsilon to handle float boundaries
    if (mIdx === -1) mIdx = 0

    const measure = mIdx - leadInMeasures
    const info = measureInfos[mIdx] || getMeasureInfo(measure)
    const localX = Math.max(0, x - info.offsetX)

    let p = 0
    for (let i = 0; i < GRID_DIVISIONS; i++) {
      if (localX < info.posOffsets[i + 1]) {
        p = i
        break
      }
      p = i
    }

    const x0 = info.posOffsets[p], x1 = info.posOffsets[p + 1] || x0
    const fraction = x1 > x0 ? (localX - x0) / (x1 - x0) : 0
    const posFloat = p + fraction

    const interval = GRID_DIVISIONS / snapDivisions
    // Apply a +2.0 internal grid offset to shift detection "backward" (later in time) by about 0.67 divisions.
    // This makes it snap to the "after" grid line more easily, as per user's latest request.
    let snappedPos = Math.round((posFloat + 1.25) / interval) * interval
    let snappedMeasure = measure
    if (snappedPos >= GRID_DIVISIONS) {
      snappedPos -= GRID_DIVISIONS
      snappedMeasure += 1
    }

    return { measure: snappedMeasure, pos: snappedPos, posFloat, rawMeasure: measure, rawPos: posFloat }
  }

  const broadcastCommandUpsert = useCallback((upsertedCmds: Command[]) => {
    if (channelRef.current && upsertedCmds.length > 0) {
      void channelRef.current.send({
        type: 'broadcast',
        event: 'COMMAND_UPSERT',
        payload: { commands: upsertedCmds }
      })
    }
  }, [roomId, onBack, supabase, userId])

  const broadcastCommandDelete = useCallback((cmdIds: string[]) => {
    if (channelRef.current && cmdIds.length > 0) {
      void channelRef.current.send({
        type: 'broadcast',
        event: 'COMMAND_DELETE',
        payload: { cmdIds, userId }
      })
    }
  }, [roomId, userId])

  const broadcastNoteUpsert = useCallback((upsertedNotes: Note[]) => {
    if (channelRef.current && upsertedNotes.length > 0) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'NOTE_UPSERT',
        payload: { userId, notes: upsertedNotes }
      }).catch((err: any) => console.error('Broadcast failed', err))
    }
  }, [userId])

  const broadcastNoteDelete = useCallback((deletedNoteIds: string[]) => {
    if (channelRef.current && deletedNoteIds.length > 0) {
      channelRef.current.send({
        type: 'broadcast',
        event: 'NOTE_DELETE',
        payload: { userId, noteIds: deletedNoteIds }
      }).catch((err: any) => console.error('Broadcast failed', err))
    }
  }, [userId])


  const NOTE_TYPES = [
    { id: '1', label: 'ドン', color: '#ff4d4d', size: 1 },
    { id: '2', label: 'カッ', color: '#4d94ff', size: 1 },
    { id: '3', label: '大ドン', color: '#ff4d4d', size: 1.5 },
    { id: '4', label: '大カッ', color: '#4d94ff', size: 1.5 },
    { id: '5', label: '連打始', color: '#ffcc00', size: 1 },
    { id: '6', label: '大連打', color: '#ffcc00', size: 1.5 },
    { id: '7', label: '風船', color: '#ff9900', size: 1.2 },
    { id: '9', label: 'くすだま', color: '#ff9900', size: 1.6 },
  ]

  // Initialize Data
  const initData = useCallback(async () => {
    try {
      // Fetch room first so TJA source can be treated as the primary source of truth on join.
      const { data: roomData, error: roomError } = await supabase
        .from('rooms')
        .select('id, display_name, title, subtitle, offset, difficulty, level, sevol, songvol, audio_url, tja_text, has_password')
        .eq('id', roomId)
        .single()
      if (roomError) throw roomError

      if (roomData) {
        if ((roomData as any).has_password) {
          const candidatePassword = localStorage.getItem(`connectja_room_password_${roomId}`) || ''
          if (!candidatePassword) {
            alert('このルームはパスワードが必要です。ロビーから入室してください。')
            onBack()
            return
          }
          const { data: ok, error: verifyError } = await supabase.rpc('verify_room_password', {
            target_room_id: roomId,
            candidate_password: candidatePassword
          })
          if (verifyError || !ok) {
            localStorage.removeItem(`connectja_room_password_${roomId}`)
            alert('パスワード認証に失敗しました。ロビーから再入室してください。')
            onBack()
            return
          }
        }

        setRoomName(sanitizeUserFacingText(roomData.display_name, roomId))
        setMetadata({
          title: roomData.title || '',
          subtitle: roomData.subtitle || '',
          offset: roomData.offset || 0,
          difficulty: roomData.difficulty || 'Oni',
          level: roomData.level || 10,
          sevol: roomData.sevol ?? 100,
          songvol: roomData.songvol ?? 100,
          audio_url: roomData.audio_url || null
        })
        if (roomData.audio_url) {
          setAudioUrl(roomData.audio_url)
        }
        if ('tja_text' in roomData) {
          setRoomSupportsTjaSource(true)
        }

        const tjaSource = (roomData as any).tja_text ? String((roomData as any).tja_text).trim() : ''
        if (tjaSource) {
          // Initialize from TJA source first and derive GUI preview state.
          try {
            const parsed = tjaToGui(tjaSource)
            setTjaText(tjaSource)
            lastSavedTjaTextRef.current = tjaSource
            setTjaDirty(false)

            // Map parsed notes/commands to GUI domain
            const guiNotes: Note[] = (parsed.notes || []).map(n => ({
              id: crypto.randomUUID(),
              room_id: roomId,
              measure: n.measure,
              position: n.position,
              type: n.type,
              attributes: n.attributes,
              last_modified_at: Date.now(),
              last_modified_by: userId
            }))
            const guiCommands: Command[] = (parsed.commands || []).map(c => ({
              id: crypto.randomUUID(),
              room_id: roomId,
              measure: c.measure,
              position: c.position,
              type: c.type,
              value: c.value,
              last_modified_at: Date.now(),
              last_modified_by: userId
            }))

            setNotes(guiNotes)
            setCommands(guiCommands)
          } catch (err: any) {
            console.error('Failed to parse room TJA source, falling back to existing notes/commands:', err)
            const [notesRes, cmdsRes] = await Promise.all([
              supabase.from('notes').select('*').eq('room_id', roomId),
              supabase.from('commands').select('*').eq('room_id', roomId)
            ])
            if (notesRes.data) setNotes(notesRes.data)
            if (cmdsRes.data) setCommands(cmdsRes.data)
          }

          // Even when TJA source exists, SE assets are still needed for playback.
          audioEngine.loadSEs().catch((e: any) => console.warn('SE loading failed', e))

          // Abort note/command fallback when TJA source exists.
          if ((roomData as any).tja_text) {
            return
          }
        }
      }

      // Fallback for legacy rooms with no tja_text: fetch GUI blobs.
      const [notesRes, cmdsRes] = await Promise.all([
        supabase.from('notes').select('*').eq('room_id', roomId),
        supabase.from('commands').select('*').eq('room_id', roomId)
      ])

      if (notesRes.data) setNotes(notesRes.data)
      if (cmdsRes.data) setCommands(cmdsRes.data)

      // SEs loading is non-blocking but helpful
      audioEngine.loadSEs().catch((e: any) => console.warn('SE loading failed', e))

    } catch (err: any) {
      console.error('Failed to initialize editor data:', err)
    }
  }, [roomId])

  useEffect(() => {
    initData()

    const channel = supabase.channel(`room:${roomId}`, {
      config: { presence: { key: userId } }
    })
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        setPresenceState(state)
      })
      .on('broadcast', { event: 'room_notice' }, (message: any) => {
        const payload = message?.payload ?? message
        if (!payload || payload.userId === userId) return
        const actorName = sanitizeUserFacingText(payload.userName, 'Unknown')
        const actorColor = String(payload.userColor || '#888')
        const action = String(payload.action || '')
        if (action === 'join') {
          pushPresenceNotice(`${actorName} joined the room`, actorColor)
        } else if (action === 'leave') {
          pushPresenceNotice(`${actorName} left the room`, actorColor)
        }
      })
      .on('broadcast', { event: 'REFRESH_DATA' }, (message: any) => {
        const payload = message?.payload ?? message
        if (payload?.userId === userId) return
        console.log('Received REFRESH_DATA broadcast, reloading chart...')
        tjaSourceRef.current = 'tja'
        initData()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${roomId}` }, (payload) => {
        // Sync metadata and tja_text from DB update
        const newRoom = payload.new as any

        // Suppress self-echo for metadata by comparing with current state
        setMetadata(prev => {
          if (
            prev.title === newRoom.title &&
            prev.subtitle === newRoom.subtitle &&
            prev.offset === newRoom.offset &&
            prev.difficulty === newRoom.difficulty &&
            prev.level === newRoom.level &&
            prev.sevol === newRoom.sevol &&
            prev.songvol === newRoom.songvol &&
            prev.audio_url === newRoom.audio_url
          ) {
            return prev
          }
          return {
            ...prev,
            title: newRoom.title,
            subtitle: newRoom.subtitle,
            offset: newRoom.offset,
            difficulty: newRoom.difficulty,
            level: newRoom.level,
            sevol: newRoom.sevol,
            songvol: newRoom.songvol,
            audio_url: newRoom.audio_url
          }
        })

        const prevAudioUrl = stateRef.current.metadata?.audio_url ?? null
        if (newRoom.audio_url !== prevAudioUrl) {
          if (newRoom.audio_url) {
            setAudioUrl(newRoom.audio_url)
          } else {
            setAudioUrl(null)
            setAudioDuration(0)
            setWaveformPeaks([])
            audioEngine.audioBuffer = null
            audioEngine.stop()
            setIsPlaying(false)
          }
        }

        if (newRoom.tja_text && tjaSourceRef.current !== 'gui') {
          setTjaText(prev => prev === newRoom.tja_text ? prev : newRoom.tja_text)
        }
      })
      .on('broadcast', { event: 'NOTE_UPSERT' }, (message: any) => {
        const payload = message?.payload ?? message
        const newNotes = (payload.notes as Note[] || []).filter(n => n.last_modified_by !== userId)
        if (newNotes.length > 0) {
          setNotes(prev => {
            let next = [...prev]
            for (const newNote of newNotes) {
              const existing = next.find(n => n.id === newNote.id)
              if (existing && getSafeLastModifiedAt(existing.last_modified_at) >= getSafeLastModifiedAt(newNote.last_modified_at)) continue
              next = [...next.filter(n => n.id !== newNote.id), newNote]
            }
            return next
          })
        }
      })
      .on('broadcast', { event: 'COMMAND_UPSERT' }, (message: any) => {
        const payload = message?.payload ?? message
        const newCmds = (payload.commands as Command[] || []).filter(c => c.last_modified_by !== userId)
        if (newCmds.length > 0) {
          setCommands(prev => {
            let next = [...prev]
            for (const newCmd of newCmds) {
              const existing = next.find(c => c.id === newCmd.id)
              if (existing && getSafeLastModifiedAt(existing.last_modified_at) >= getSafeLastModifiedAt(newCmd.last_modified_at)) continue
              next = [...next.filter(c => c.id !== newCmd.id), newCmd]
            }
            return next
          })
        }
      })
      .on('broadcast', { event: 'COMMAND_DELETE' }, (message: any) => {
        const payload = message?.payload ?? message
        if (payload?.userId === userId) return
        const deletedIds = payload.cmdIds as string[]
        if (deletedIds && deletedIds.length > 0) {
          const idSet = new Set(deletedIds)
          setCommands(prev => prev.filter(c => !idSet.has(c.id)))
        }
      })
      .on('broadcast', { event: 'NOTE_DELETE' }, (message: any) => {
        const payload = message?.payload ?? message
        if (payload?.userId === userId) return
        const deletedIds = payload.noteIds as string[]
        if (deletedIds && deletedIds.length > 0) {
          const idSet = new Set(deletedIds)
          setNotes(prev => prev.filter(n => !idSet.has(n.id)))
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes', filter: `room_id=eq.${roomId}` }, (payload) => {
        if ((payload.new as Note).last_modified_by === userId) return
        setNotes(prev => {
          const existing = prev.find(n => n.id === payload.new.id)
          if (existing && getSafeLastModifiedAt(existing.last_modified_at) >= getSafeLastModifiedAt((payload.new as Note).last_modified_at)) return prev
          return [...prev.filter(n => n.id !== payload.new.id), payload.new as Note]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notes', filter: `room_id=eq.${roomId}` }, (payload) => {
        if ((payload.new as Note).last_modified_by === userId) return
        setNotes(prev => {
          const existing = prev.find(n => n.id === payload.new.id)
          if (existing && getSafeLastModifiedAt(existing.last_modified_at) >= getSafeLastModifiedAt((payload.new as Note).last_modified_at)) return prev
          return prev.map(n => n.id === payload.new.id ? payload.new as Note : n)
        })
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notes' }, (payload) => {
        setNotes(prev => prev.filter(n => n.id !== payload.old.id))
      })

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        await channel.track({ userId, userName: sanitizeUserFacingText(userName, 'Unknown'), userColor, seekPos })
        const { error: joinEventError } = await supabase.rpc('log_room_event', {
          target_room_id: roomId,
          event_kind: 'join',
          target_user_id: userId,
          target_user_name: sanitizeUserFacingText(userName, 'Unknown'),
          target_user_color: userColor
        })
        if (joinEventError) {
          console.warn('room_events join insert failed:', joinEventError)
        }
        await channel.send({
          type: 'broadcast',
          event: 'room_notice',
          payload: {
            action: 'join',
            userId,
            userName: sanitizeUserFacingText(userName, 'Unknown'),
            userColor
          }
        })
      }
    })
    channelRef.current = channel

    // Command Realtime
    const cmdChannel = supabase.channel(`commands:${roomId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commands', filter: `room_id=eq.${roomId}` }, (payload) => {
        if ((payload.new as Command).last_modified_by === userId) return
        setCommands(prev => {
          const existing = prev.find(c => c.id === (payload.new as Command).id)
          // If we have a newer or same timestamp locally, ignore older server updates
          // (Note: commands table also needs last_modified_at column to be fully robust, but we'll check if it exists)
          return [...prev.filter(c => c.id !== (payload.new as Command).id), payload.new as Command]
        })
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'commands', filter: `room_id=eq.${roomId}` }, (payload) => {
        if ((payload.new as Command).last_modified_by === userId) return
        setCommands(prev => prev.map(c => c.id === (payload.new as Command).id ? payload.new as Command : c))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'commands' }, (payload) => {
        setCommands(prev => prev.filter(c => c.id !== (payload.old as any).id))
      }).subscribe()

    return () => {
      void channel.send({
        type: 'broadcast',
        event: 'room_notice',
        payload: {
          action: 'leave',
          userId,
          userName: sanitizeUserFacingText(userName, 'Unknown'),
          userColor
        }
      })
      void supabase.rpc('log_room_event', {
        target_room_id: roomId,
        event_kind: 'leave',
        target_user_id: userId,
        target_user_name: sanitizeUserFacingText(userName, 'Unknown'),
        target_user_color: userColor
      })
      supabase.removeChannel(channel)
      supabase.removeChannel(cmdChannel)
    }
  }, [roomId, userId, userName, userColor, pushPresenceNotice, initData])

  // Broadcast seek position to presence whenever it changes
  useEffect(() => {
    if (!channelRef.current) return
    void channelRef.current.track({ userId, userName: sanitizeUserFacingText(userName, 'Unknown'), userColor, seekPos })
  }, [seekPos, userId, userName, userColor])

  useEffect(() => {
    return () => {
      audioEngine.stop()
    }
  }, [])

  // --- Audio Handling ---
  useEffect(() => {
    if (!audioUrl) return
    const loadAudio = async () => {
      await audioEngine.loadAudio(audioUrl)
      if (audioEngine.audioBuffer) {
        setAudioDuration(audioEngine.audioBuffer.duration)
        // Extract waveform peaks with higher resolution
        const channelData = audioEngine.audioBuffer.getChannelData(0)
        const step = Math.max(1, Math.ceil(channelData.length / 8000))
        const peaks = []
        for (let i = 0; i < channelData.length; i += step) {
          let min = 1.0, max = -1.0
          for (let j = 0; j < step && i + j < channelData.length; j++) {
            const val = channelData[i + j]
            if (val < min) min = val
            if (val > max) max = val
          }
          // Store both positive and negative peaks for better visualization
          peaks.push(Math.max(Math.abs(min), Math.abs(max)))
        }
        setWaveformPeaks(peaks)
      }
    }
    loadAudio()
  }, [audioUrl])

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    // Enforce .ogg only
    if (!file.name.toLowerCase().endsWith('.ogg')) {
      alert('Only .ogg files are supported for better compatibility.')
      return
    }

    try {
      setAudioUploading(true)
      const fileName = `${roomId}.ogg`
      const { data, error } = await supabase.storage.from('audio').upload(fileName, file, { upsert: true })
      if (error) throw error

      const { data: { publicUrl } } = supabase.storage.from('audio').getPublicUrl(fileName)
      const versionedAudioUrl = withCacheBuster(publicUrl)
      console.log('Got public URL:', versionedAudioUrl)

      // Update DB
      const { error: dbError } = await supabase.from('rooms').update({ audio_url: versionedAudioUrl }).eq('id', roomId)

      if (dbError) {
        console.error('Failed to update room audio_url:', dbError)
        throw dbError
      }

      setAudioUrl(versionedAudioUrl)
    } catch (err) {
      console.error('Audio upload failed:', err)
      alert('Failed to upload audio. Please ensure the file is a valid .ogg.')
    } finally {
      setAudioUploading(false)
    }
  }

  const handleDeleteAudio = async () => {
    if (!confirm('音源を削除しますか？')) return

    const fileName = `${roomId}.ogg`

    // Attempt to delete from storage
    const { error: storageError } = await supabase.storage.from('audio').remove([fileName])
    if (storageError) {
      console.error('Failed to delete from storage', storageError)
    }

    // Update DB
    const { error: dbError } = await supabase.from('rooms').update({ audio_url: null }).eq('id', roomId)
    if (dbError) {
      console.error('Failed to update room', dbError)
      alert('音源リンクの削除に失敗しました。')
      return
    }

    setAudioUrl(null)
    setAudioDuration(0)
    setWaveformPeaks([])
    audioEngine.audioBuffer = null
    audioEngine.stop()
    setIsPlaying(false)
  }

  const togglePlayback = useCallback(() => {
    if (!audioEngine.ctx) return
    if (isPlaying) {
      audioEngine.stop()
      setIsPlaying(false)
    } else {
      audioEngine.setVolumes((stateRef.current.metadata?.songvol ?? 100) / 100, (stateRef.current.metadata?.sevol ?? 100) / 100)

      // Calculate starting time
      let startSec = getAbsoluteTime(Math.floor(seekPos), (seekPos % 1) * GRID_DIVISIONS)
      startSec -= PLAYBACK_START_PREROLL_SECONDS

      // Automatic 2-beat lead-in when playing from start (Measure 0)
      if (Math.abs(seekPos) < 0.01) {
        const bpm = measureInfos[leadInMeasures]?.bpm || 120
        const leadInSeconds = (60 / bpm) * 2
        startSec -= leadInSeconds
      }

      audioEngine.play(startSec, () => {
        setIsPlaying(false)
      })
      audioEngine.startScheduler(
        () => stateRef.current.notes,
        (m, p) => stateRef.current.getAbsoluteTime(m, p),
        (noteId, scheduledAtCtxTime) => {
          noteHitAnimRef.current.set(noteId, scheduledAtCtxTime)
        }
      )
      setIsPlaying(true)
    }
  }, [isPlaying, seekPos, getAbsoluteTime])

  useEffect(() => {
    if (!isPlaying) {
      noteHitAnimRef.current.clear()
    }
  }, [isPlaying])

  // Playback loop to update seekPos synced with audio drift & Auto Scroll
  useLayoutEffect(() => {
    let handle: number
    const loop = () => {
      if (audioEngine.isPlaying) {
        const audioTime = audioEngine.getCurrentTime()
        const { measure, pos } = getPosFromTime(audioTime)
        const newSeekPos = measure + pos / GRID_DIVISIONS
        setSeekPos(newSeekPos)

        // Auto Scroll to Seek Position using the same position source as seekbar rendering.
        centerScrollOnX(getX(measure, pos))
      }
      handle = requestAnimationFrame(loop)
    }
    handle = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(handle)
  }, [centerScrollOnX, getPosFromTime, getX])

  useLayoutEffect(() => {
    if (Math.abs(previousZoomRef.current - zoom) < 1e-6) return
    previousZoomRef.current = zoom
    requestAnimationFrame(() => {
      centerScrollOnSeek(seekPos)
    })
  }, [zoom, seekPos, centerScrollOnSeek])

  const performUndo = useCallback(async () => {
    if (historyIndexRef.current < 0) return
    const current = historyRef.current[historyIndexRef.current]
    if (current.action === 'INSERT' && current.notes) {
      const idsToRemove = new Set(current.notes.map((n: Note) => n.id))
      const idsArray = current.notes.map((n: Note) => n.id)
      setNotes(prev => prev.filter(n => !idsToRemove.has(n.id)))
      broadcastNoteDelete(idsArray)
      await supabase.from('notes').delete().in('id', idsArray)
    } else if (current.action === 'DELETE' && current.notes) {
      const toRestore = current.notes.map((n: Note) => ({ ...n, last_modified_at: Date.now(), last_modified_by: userId }))
      setNotes(prev => {
        const existing = new Set(prev.map(n => n.id))
        return [...prev, ...toRestore.filter((n: Note) => !existing.has(n.id))]
      })
      broadcastNoteUpsert(toRestore)
      await supabase.from('notes').upsert(toRestore, { onConflict: 'room_id,measure,position' })
    } else if (current.action === 'UPDATE' && current.oldNotes) {
      const toRestore = current.oldNotes.map((n: Note) => ({ ...n, last_modified_at: Date.now(), last_modified_by: userId }))
      setNotes(prev => prev.map(n => toRestore.find((o: Note) => o.id === n.id) || n))
      broadcastNoteUpsert(toRestore)
      await supabase.from('notes').upsert(toRestore, { onConflict: 'room_id,measure,position' })
    } else if (current.action === 'CMD_INSERT' && current.newCommands) {
      const idsToRemove = current.newCommands.map(c => c.id)
      setCommands(prev => prev.filter(c => !idsToRemove.includes(c.id)))
      broadcastCommandDelete(idsToRemove)
      await supabase.from('commands').delete().in('id', idsToRemove)
    } else if (current.action === 'CMD_DELETE' && current.oldCommands) {
      const toRestore = current.oldCommands.map(c => ({ ...c, last_modified_at: Date.now(), last_modified_by: userId }))
      setCommands(prev => [...prev.filter(c => !toRestore.some(r => r.id === c.id)), ...toRestore])
      broadcastCommandUpsert(toRestore)
      await supabase.from('commands').upsert(toRestore, { onConflict: 'room_id,measure,position,type' })
    } else if (current.action === 'CMD_UPDATE' && current.oldCommands) {
      const toRestore = current.oldCommands.map(c => ({ ...c, last_modified_at: Date.now(), last_modified_by: userId }))
      setCommands(prev => prev.map(c => toRestore.find(o => o.id === c.id) || c))
      broadcastCommandUpsert(toRestore)
      await supabase.from('commands').upsert(toRestore, { onConflict: 'room_id,measure,position,type' })
    }
    historyIndexRef.current -= 1
    setHistoryIndexState(historyIndexRef.current)
  }, [broadcastCommandDelete, broadcastCommandUpsert, broadcastNoteDelete, broadcastNoteUpsert, userId])

  const performRedo = useCallback(async () => {
    if (historyIndexRef.current >= historyRef.current.length - 1) return
    const next = historyRef.current[historyIndexRef.current + 1]
    if (next.action === 'INSERT' && next.notes) {
      const toAdd = next.notes.map((n: Note) => ({ ...n, last_modified_at: Date.now(), last_modified_by: userId }))
      setNotes(prev => {
        const existing = new Set(prev.map(n => n.id))
        return [...prev, ...toAdd.filter((n: Note) => !existing.has(n.id))]
      })
      broadcastNoteUpsert(toAdd)
      await supabase.from('notes').upsert(toAdd, { onConflict: 'room_id,measure,position' })
    } else if (next.action === 'DELETE' && next.notes) {
      const idsToRemove = new Set(next.notes.map((n: Note) => n.id))
      const idsArray = next.notes.map((n: Note) => n.id)
      setNotes(prev => prev.filter(n => !idsToRemove.has(n.id)))
      broadcastNoteDelete(idsArray)
      await supabase.from('notes').delete().in('id', idsArray)
    } else if (next.action === 'UPDATE' && next.notes) {
      const toApply = next.notes.map((n: Note) => ({ ...n, last_modified_at: Date.now(), last_modified_by: userId }))
      setNotes(prev => prev.map(n => toApply.find((o: Note) => o.id === n.id) || n))
      broadcastNoteUpsert(toApply)
      await supabase.from('notes').upsert(toApply, { onConflict: 'room_id,measure,position' })
    } else if (next.action === 'CMD_INSERT' && next.newCommands) {
      const toAdd = next.newCommands.map(c => ({ ...c, last_modified_at: Date.now(), last_modified_by: userId }))
      setCommands(prev => [...prev.filter(c => !toAdd.some(r => r.id === c.id)), ...toAdd])
      broadcastCommandUpsert(toAdd)
      await supabase.from('commands').upsert(toAdd, { onConflict: 'room_id,measure,position,type' })
    } else if (next.action === 'CMD_DELETE' && next.oldCommands) {
      const idsToRemove = next.oldCommands.map(c => c.id)
      setCommands(prev => prev.filter(c => !idsToRemove.includes(c.id)))
      broadcastCommandDelete(idsToRemove)
      await supabase.from('commands').delete().in('id', idsToRemove)
    } else if (next.action === 'CMD_UPDATE' && next.newCommands) {
      const toApply = next.newCommands.map(c => ({ ...c, last_modified_at: Date.now(), last_modified_by: userId }))
      setCommands(prev => prev.map(c => toApply.find(o => o.id === c.id) || c))
      broadcastCommandUpsert(toApply)
      await supabase.from('commands').upsert(toApply, { onConflict: 'room_id,measure,position,type' })
    }
    historyIndexRef.current += 1
    setHistoryIndexState(historyIndexRef.current)
  }, [broadcastCommandDelete, broadcastCommandUpsert, broadcastNoteDelete, broadcastNoteUpsert, userId])

  const jumpHistoryToIndex = useCallback(async (targetIndex: number) => {
    const clamped = Math.max(-1, Math.min(historyRef.current.length - 1, targetIndex))
    if (clamped === historyIndexRef.current) return
    setIsHistoryJumping(true)
    try {
      let guard = 0
      while (historyIndexRef.current < clamped && guard < 200) {
        await performRedo()
        guard += 1
      }
      while (historyIndexRef.current > clamped && guard < 400) {
        await performUndo()
        guard += 1
      }
    } finally {
      setIsHistoryJumping(false)
    }
  }, [performRedo, performUndo])


  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const isMonacoFocused = Boolean(editorRef.current?.hasTextFocus?.())
      if (isMonacoFocused) return

      tjaSourceRef.current = 'gui'
      // Don't trigger shortcuts when typing in inputs
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return

      const state = stateRef.current
      const key = e.key.toLowerCase()

      if ((e.ctrlKey || e.metaKey) && key === 'arrowleft') {
        e.preventDefault()
        jumpToChartStart(true)
        return
      }

      // Undo
      if (e.ctrlKey && key === 'z' && !e.shiftKey) {
        e.preventDefault()
        await performUndo()
        return
      }

      // Redo
      if (e.ctrlKey && (key === 'y' || (e.shiftKey && key === 'z'))) {
        e.preventDefault()
        await performRedo()
        return
      }

      // Copy
      if (e.ctrlKey && key === 'c') {
        e.preventDefault()
        const copied = state.notes.filter(n => state.selectedNotes.has(n.id))
        if (copied.length > 0) setClipboard(copied)
        return
      }

      // Helper for Roll/Balloon Co-deletion
      const getPairedNoteIds = (targetNotes: Note[], allNotes: Note[]): string[] => {
        const sorted = [...allNotes].sort((a, b) => (a.measure * GRID_DIVISIONS + a.position) - (b.measure * GRID_DIVISIONS + b.position));
        const paired = new Set<string>();

        for (const note of targetNotes) {
          const absTarget = note.measure * GRID_DIVISIONS + note.position;
          if (['5', '6', '7', '9'].includes(note.type)) {
            // Find next 8
            for (const n of sorted) {
              const abs = n.measure * GRID_DIVISIONS + n.position;
              if (abs > absTarget && n.type === '8') {
                paired.add(n.id);
                break;
              }
            }
          } else if (note.type === '8') {
            // Find previous start note
            let lastStartId = null;
            for (const n of sorted) {
              const abs = n.measure * GRID_DIVISIONS + n.position;
              if (abs >= absTarget) break;
              if (['5', '6', '7', '9'].includes(n.type)) {
                lastStartId = n.id;
              } else if (n.type === '8') {
                lastStartId = null;
              }
            }
            if (lastStartId) paired.add(lastStartId);
          }
        }
        return Array.from(paired);
      }

      // Cut
      if (e.ctrlKey && key === 'x') {
        e.preventDefault()
        const toCutBase = state.notes.filter(n => state.selectedNotes.has(n.id))
        const pairedIds = getPairedNoteIds(toCutBase, state.notes)
        const toCutMap = new Map<string, Note>()
        toCutBase.forEach(n => toCutMap.set(n.id, n))
        pairedIds.forEach(id => {
          const pn = state.notes.find(n => n.id === id)
          if (pn) toCutMap.set(id, pn)
        })
        const toCut = Array.from(toCutMap.values())

        if (toCut.length > 0) {
          setClipboard(toCut)
          setNotes(prev => prev.filter(n => !toCutMap.has(n.id)))
          setSelectedNotes(new Set())

          const idsArray = toCut.map(n => n.id)
          await supabase.from('notes').delete().in('id', idsArray)
          broadcastNoteDelete(idsArray)
          // Push history BEFORE DB call (optimistic)
          pushHistory({ action: 'DELETE', notes: toCut })
        }
        return
      }

      // Paste
      if (e.ctrlKey && key === 'v') {
        e.preventDefault()
        if (state.clipboard.length > 0) {
          const minMeasure = Math.min(...state.clipboard.map(c => c.measure))
          const minPosForMinMeasure = Math.min(...state.clipboard.filter(c => c.measure === minMeasure).map(c => c.position))

          const targetMeasure = state.hoverGridObj.measure
          const targetPos = state.hoverGridObj.pos

          const measureOffset = targetMeasure - minMeasure
          const posOffset = targetPos - minPosForMinMeasure

          const newNotes = state.clipboard.map(note => {
            let m = note.measure + measureOffset
            let p = note.position + posOffset

            // Normalize position overflows
            while (p >= GRID_DIVISIONS) { p -= GRID_DIVISIONS; m += 1 }
            while (p < 0) { p += GRID_DIVISIONS; m -= 1 }

            return {
              ...note,
              id: crypto.randomUUID(),
              measure: Math.max(0, m),
              position: p,
              last_modified_at: Date.now(),
              last_modified_by: userId
            }
          })

          // Filter out notes that would collide with existing notes (replace them)
          const pastePositions = new Set(newNotes.map(n => `${n.measure}:${n.position}`))
          const collidingIds = state.notes
            .filter(n => pastePositions.has(`${n.measure}:${n.position}`))
            .map(n => n.id)

          // Optimistic local state update: remove collisions, add new notes
          setNotes(prev => {
            const collidingSet = new Set(collidingIds)
            return [...prev.filter(n => !collidingSet.has(n.id)), ...newNotes]
          })

          broadcastNoteUpsert(newNotes)
          const { error } = await supabase.from('notes').upsert(newNotes, { onConflict: 'room_id,measure,position' })
          if (!error) {
            pushHistory({ action: 'INSERT', notes: newNotes })
            setSelectedNotes(new Set(newNotes.map(n => n.id)))
          }
        }
        return
      }

      // Select All
      if (e.ctrlKey && key === 'a') {
        e.preventDefault()
        setSelectedNotes(new Set(state.notes.map(n => n.id)))
        return
      }

      // Delete Selection
      if (key === 'delete' || key === 'backspace') {
        if (state.selectedNotes.size > 0) {
          e.preventDefault()
          const toDeleteBase = state.notes.filter(n => state.selectedNotes.has(n.id))
          const pairedIds = getPairedNoteIds(toDeleteBase, state.notes)
          const toDeleteMap = new Map<string, Note>()
          toDeleteBase.forEach(n => toDeleteMap.set(n.id, n))
          pairedIds.forEach(id => {
            const pn = state.notes.find(n => n.id === id)
            if (pn) toDeleteMap.set(id, pn)
          })
          const toDelete = Array.from(toDeleteMap.values())

          // Optimistic local update
          setNotes(prev => prev.filter(n => !toDeleteMap.has(n.id)))
          setSelectedNotes(new Set())

          const idsArray = toDelete.map(n => n.id)
          const { error } = await supabase.from('notes').delete().in('id', idsArray)
          if (!error) {
            broadcastNoteDelete(idsArray)
            pushHistory({ action: 'DELETE', notes: toDelete })
          } else {
            setNotes(prev => [...prev, ...toDelete]) // Rollback if error
          }
        }
      }

      // Grid Snap Change (REMOVED: Now handled by Shift + Mouse Wheel)


      // Type Selection
      if ((e.key >= '1' && e.key <= '7') || e.key === '9') setSelectedType(e.key)
      else if (e.key === '0') setSelectedType('0')

      // Playback toggle
      if (key === ' ') {
        e.preventDefault()
        togglePlayback()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [togglePlayback, jumpToChartStart, performUndo, performRedo, userId])

  // Canvas Rendering
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animationFrameId: number;

    const render = () => {
      // Viewport Culling & Virtualization
      const container = containerRef.current
      if (!container) return

      // Edge Auto-Scroll Logic (continuous, even when mouse is not moving)
      if ((isDragging || isDraggingNotes || draggingEndpointId || isSeeking) && currentMouseX !== null) {
        const rect = container.getBoundingClientRect()
        const edgeThreshold = 80
        const maxScrollSpeed = 30
        let didAutoScroll = false

        if (currentMouseX < rect.left + edgeThreshold) {
          const distanceFromLeft = rect.left + edgeThreshold - currentMouseX
          const speed = Math.min(maxScrollSpeed, (distanceFromLeft / edgeThreshold) * maxScrollSpeed)
          container.scrollLeft -= speed
          didAutoScroll = true
        } else if (currentMouseX > rect.right - edgeThreshold) {
          const distanceFromRight = currentMouseX - (rect.right - edgeThreshold)
          const speed = Math.min(maxScrollSpeed, (distanceFromRight / edgeThreshold) * maxScrollSpeed)
          container.scrollLeft += speed
          didAutoScroll = true
        }

        // When seeking at screen edges, mousemove may pause while scroll continues.
        // Keep seek position synced with the auto-scrolled timeline every frame.
        if (isSeeking && didAutoScroll) {
          const timelineX = currentMouseX - rect.left + container.scrollLeft
          const grid = getGridFromX(timelineX)
          const rawSeek = grid.rawMeasure + grid.rawPos / GRID_DIVISIONS
          const snappedSeek = grid.measure + grid.pos / GRID_DIVISIONS
          if (seekGestureRef.current) {
            seekGestureRef.current.moved = true
            seekGestureRef.current.rawSeek = rawSeek
            seekGestureRef.current.snappedSeek = snappedSeek
          } else {
            seekGestureRef.current = { startX: timelineX, moved: true, rawSeek, snappedSeek }
          }
          setSeekPos(rawSeek)
        }
      }

      const scrollLeft = container.scrollLeft
      const containerWidth = container.clientWidth

      // Update canvas size to match container (viewport-based rendering)
      if (canvas.width !== containerWidth) {
        canvas.width = containerWidth
      }

      // Visible range relative to the entire timeline
      const visibleStartX = Math.max(0, scrollLeft - 500)
      const visibleEndX = scrollLeft + containerWidth + 500

      ctx.clearRect(0, 0, canvas.width, canvas.height)

      // Use translate to offset the drawing based on scroll position
      ctx.save()
      ctx.translate(-scrollLeft, 0)

      // Timeline Header Background
      ctx.fillStyle = '#1e1e1e'
      ctx.fillRect(visibleStartX, 0, visibleEndX - visibleStartX, HEADER_HEIGHT)

      ctx.strokeStyle = '#444'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(visibleStartX, HEADER_HEIGHT)
      ctx.lineTo(visibleEndX, HEADER_HEIGHT)
      ctx.stroke()

      // Lane Center Line
      const laneCenterY = HEADER_HEIGHT + LANE_HEIGHT / 2
      ctx.strokeStyle = '#333'
      ctx.lineWidth = 3
      ctx.beginPath()
      ctx.moveTo(visibleStartX, laneCenterY)
      ctx.lineTo(visibleEndX, laneCenterY)
      ctx.stroke()

      // Waveform Drawing (density anchored to screen-space columns)
      if (waveformPeaks.length > 0 && audioEngine.audioBuffer) {
        const duration = audioEngine.audioBuffer.duration
        const waveformY = HEADER_HEIGHT + LANE_HEIGHT - WAVEFORM_HEIGHT

        ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
        const waveformSamples: Array<{ col: number, h: number }> = []
        // Sample at fixed on-screen spacing so density stays uniform regardless of HS/scroll speed.
        for (let col = Math.floor(visibleStartX); col <= Math.ceil(visibleEndX); col += 2) {
          const grid = getGridFromX(col)
          const chartTime = getAbsoluteTime(grid.rawMeasure, grid.rawPos)
          const audioTime = chartTime - metadata.offset - (IS_ELECTRON ? 0 : PLAYBACK_AUDIO_ADVANCE_SECONDS)
          if (!Number.isFinite(audioTime) || audioTime < 0 || audioTime > duration) continue

          const peakIdx = Math.max(0, Math.min(
            waveformPeaks.length - 1,
            Math.floor((audioTime / duration) * waveformPeaks.length)
          ))
          const val = waveformPeaks[peakIdx]
          const h = Math.max(2, val * WAVEFORM_HEIGHT)
          waveformSamples.push({ col, h })
        }

        waveformSamples.forEach(({ col, h }) => {
          ctx.fillRect(col - 1, waveformY + (WAVEFORM_HEIGHT - h) / 2, 2, h)
        })
      }

      // Draw GOGO background (orange overlay for gogo sections)
      const gogoStarts = commands.filter(c => c.type === 'GOGOSTART').map(c => c.measure * GRID_DIVISIONS + c.position)
      const gogoEnds = commands.filter(c => c.type === 'GOGOEND').map(c => c.measure * GRID_DIVISIONS + c.position)

      for (let i = 0; i < gogoStarts.length; i++) {
        const startPos = gogoStarts[i]
        const endPos = gogoEnds[i] !== undefined ? gogoEnds[i] : TOTAL_MEASURES * GRID_DIVISIONS

        const startMeasure = Math.floor(startPos / GRID_DIVISIONS)
        const startGridPos = startPos % GRID_DIVISIONS
        const endMeasure = Math.floor(endPos / GRID_DIVISIONS)
        const endGridPos = endPos % GRID_DIVISIONS

        const startX = getX(startMeasure, startGridPos)
        const endX = getX(endMeasure, endGridPos)

        // Only draw if visible
        if (endX > visibleStartX && startX < visibleEndX) {
          const visibleStartXClamped = Math.max(startX, visibleStartX)
          const visibleEndXClamped = Math.min(endX, visibleEndX)

          ctx.fillStyle = 'rgba(255, 165, 0, 0.08)' // Light orange overlay
          ctx.fillRect(visibleStartXClamped, HEADER_HEIGHT, visibleEndXClamped - visibleStartXClamped, LANE_HEIGHT)
        }
      }

      // Draw Grid & Measure Markers (Visible Only)
      // Find start index
      const startMeasureIdx = Math.max(0, measureOffsets.findIndex(offset => offset >= visibleStartX) - 1)

      for (let i = startMeasureIdx; i < measureOffsets.length; i++) {
        const offsetX = measureOffsets[i]
        if (offsetX > visibleEndX) break

        const m = i - leadInMeasures
        const info = getMeasureInfo(m)
        const measureW = info.totalWidth

        // Measure Start Line (Thick)
        ctx.strokeStyle = '#555'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(offsetX, 0)
        ctx.lineTo(offsetX, canvas.height)
        ctx.stroke()

        // Measure Number
        ctx.fillStyle = '#888'
        ctx.font = '12px monospace'
        ctx.textAlign = 'left'
        const label = m < 0 ? `Measure ${m.toString().padStart(4, '0')}` : `Measure ${m.toString().padStart(3, '0')}`
        ctx.fillText(label, offsetX + 8, 24)

        // Grid Lines within measure
        const beats = info.n
        for (let step = 1; step < snapDivisions; step++) {
          const p = Math.round((step * GRID_DIVISIONS) / snapDivisions)
          if (p <= 0 || p >= GRID_DIVISIONS) continue
          const gx = offsetX + (info.posOffsets[p] ?? 0)

          if (gx < visibleStartX || gx > visibleEndX) continue

          const beatInterval = GRID_DIVISIONS / Math.max(1, beats)
          const isBeat = Math.abs((p / beatInterval) - Math.round(p / beatInterval)) < 1e-6
          ctx.strokeStyle = isBeat ? '#333' : '#222'
          ctx.lineWidth = isBeat ? 2 : 1
          ctx.beginPath()
          ctx.moveTo(gx, HEADER_HEIGHT)
          ctx.lineTo(gx, canvas.height)
          ctx.stroke()
        }
      }

      // Draw Commands
      const groupedCommands: { [key: string]: Command[] } = {}
      commands.forEach(cmd => {
        const key = `${cmd.measure}:${cmd.position}`
        if (!groupedCommands[key]) groupedCommands[key] = []
        groupedCommands[key].push(cmd)
      })

      Object.entries(groupedCommands).forEach(([key, cmds]) => {
        const [mStr, pStr] = key.split(':')
        const measure = parseInt(mStr)
        const pos = parseInt(pStr)
        const x = getX(measure, pos)

        if (x < visibleStartX || x > visibleEndX) return

        cmds.forEach((cmd, idx) => {
          let color = '#fff'
          let label = ''
          if (cmd.type === 'BPM') { color = '#4ade80'; label = `BPM:${cmd.value}` }
          else if (cmd.type === 'HS') { color = '#22d3ee'; label = `HS:${cmd.value}` }
          else if (cmd.type === 'MEASURE') { color = '#facc15'; label = `MEASURE:${cmd.value}` }
          else if (cmd.type === 'GOGOSTART') { color = '#ff9500'; label = 'GOGOSTART' }
          else if (cmd.type === 'GOGOEND') { color = '#ff9500'; label = 'GOGOEND' }

          const stackY = 4 + (idx * 13)

          ctx.fillStyle = color
          ctx.fillRect(x - 1, 0, 2, HEADER_HEIGHT)

          // Only draw label box if label exists
          if (label) {
            ctx.fillStyle = 'rgba(0,0,0,0.7)'
            const textWidth = ctx.measureText(label).width
            ctx.fillRect(x + 4, stackY, textWidth + 8, 12)

            ctx.fillStyle = color
            ctx.font = 'bold 9px monospace'
            ctx.fillText(label, x + 8, stackY + 9)
          }
        })
      })

      // Roll/Balloon Connections
      const sortedNotes = [...notes].sort((a, b) => (a.measure * GRID_DIVISIONS + a.position) - (b.measure * GRID_DIVISIONS + b.position));
      let currentRollStart: Note | null = null;
      const currentSeekAbs = seekPos * GRID_DIVISIONS
      for (const n of sortedNotes) {
        if (['5', '6', '7', '9'].includes(n.type)) {
          currentRollStart = n;
        } else if (n.type === '8' && currentRollStart) {
          const startX = getX(currentRollStart.measure, currentRollStart.position)
          const endX = getX(n.measure, n.position)

          if (Math.max(startX, visibleStartX) < Math.min(endX, visibleEndX)) {
            let color = 'rgba(255, 204, 0, 0.4)';
            let height = BASE_NOTE_RADIUS * 2 * 0.8;
            if (currentRollStart.type === '6') {
              color = 'rgba(255, 204, 0, 0.6)';
              height = BASE_NOTE_RADIUS * 3 * 0.8;
            } else if (currentRollStart.type === '7' || currentRollStart.type === '9') {
              color = 'rgba(255, 153, 0, 0.5)';
              height = BASE_NOTE_RADIUS * 2.4 * 0.8;
            }

            ctx.fillStyle = color;
            ctx.fillRect(startX, laneCenterY - height / 2, endX - startX, height);

            // Active roll/balloon animation while repeatedly hittable during playback.
            const startAbs = currentRollStart.measure * GRID_DIVISIONS + currentRollStart.position
            const endAbs = n.measure * GRID_DIVISIONS + n.position
            const isActiveRoll = isPlaying && currentSeekAbs >= startAbs && currentSeekAbs <= endAbs
            if (isActiveRoll) {
              const rollProgress = Math.max(0, Math.min(1, (currentSeekAbs - startAbs) / Math.max(1, endAbs - startAbs)))
              const sweepX = startX + (endX - startX) * rollProgress
              const pulse = 0.5 + 0.5 * Math.sin(performance.now() * 0.03)
              const glowAlpha = 0.25 + pulse * 0.35

              ctx.save()
              ctx.fillStyle = (currentRollStart.type === '7' || currentRollStart.type === '9')
                ? `rgba(255,255,255,${(glowAlpha * 0.9).toFixed(3)})`
                : `rgba(255,245,180,${glowAlpha.toFixed(3)})`
              ctx.fillRect(startX, laneCenterY - height / 2, endX - startX, height)

              ctx.strokeStyle = (currentRollStart.type === '7' || currentRollStart.type === '9')
                ? `rgba(255,180,80,${(0.75 + pulse * 0.2).toFixed(3)})`
                : `rgba(255,230,120,${(0.7 + pulse * 0.2).toFixed(3)})`
              ctx.lineWidth = 2 + pulse * 1.5
              ctx.beginPath()
              ctx.moveTo(sweepX, laneCenterY - height / 2 - 2)
              ctx.lineTo(sweepX, laneCenterY + height / 2 + 2)
              ctx.stroke()
              ctx.restore()
            }
          }
          currentRollStart = null;
        }
      }

      // Draw Notes
      const ctxNow = audioEngine.ctx?.currentTime
      const HIT_ANIM_DURATION_MS = 220
      const notesByZ = [...notes].sort(
        (a, b) => (b.measure * GRID_DIVISIONS + b.position) - (a.measure * GRID_DIVISIONS + a.position)
      )
      notesByZ.forEach(note => {
        const x = getX(note.measure, note.position)
        if (x < visibleStartX - 50 || x > visibleEndX + 50) return

        const y = laneCenterY
        const typeConfig = NOTE_TYPES.find(t => t.id === note.type) || { color: '#fff', size: 1 }
        const hitStartedAt = noteHitAnimRef.current.get(note.id)
        const hitElapsed = (hitStartedAt !== undefined && ctxNow !== undefined)
          ? ((ctxNow - hitStartedAt) * 1000)
          : Number.POSITIVE_INFINITY
        const hitActive = hitElapsed >= 0 && hitElapsed <= HIT_ANIM_DURATION_MS
        const hitProgress = hitActive ? (hitElapsed / HIT_ANIM_DURATION_MS) : 1
        const baseRadius = BASE_NOTE_RADIUS * typeConfig.size

        ctx.beginPath()
        ctx.fillStyle = typeConfig.color
        ctx.arc(x, y, baseRadius, 0, Math.PI * 2)
        ctx.fill()

        if (hitActive) {
          const fadeAlpha = Math.max(0, Math.pow(1 - hitProgress, 2.4))
          const expandRadius = baseRadius * (1 + hitProgress) // final radius = 2x base
          const ringRadius = baseRadius + (baseRadius * hitProgress)
          ctx.save()
          // Use explicit RGBA so fade is visually obvious regardless of base note color.
          const fillAlpha = Math.min(0.45, fadeAlpha * 0.55)
          const strokeAlpha = Math.min(0.9, fadeAlpha)
          ctx.fillStyle = `rgba(255,255,255,${fillAlpha.toFixed(3)})`
          ctx.beginPath()
          ctx.arc(x, y, expandRadius, 0, Math.PI * 2)
          ctx.fill()

          ctx.strokeStyle = `rgba(255,255,255,${strokeAlpha.toFixed(3)})`
          ctx.lineWidth = 3
          ctx.beginPath()
          ctx.arc(x, y, ringRadius, 0, Math.PI * 2)
          ctx.stroke()
          ctx.restore()
        } else if (hitStartedAt !== undefined && hitElapsed > HIT_ANIM_DURATION_MS) {
          noteHitAnimRef.current.delete(note.id)
        }

        ctx.save()
        if (hitActive) {
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 3
        } else if (selectedNotes.has(note.id)) {
          ctx.shadowColor = '#fff'
          ctx.shadowBlur = 15
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 4
        } else {
          ctx.strokeStyle = typeConfig.size > 1.2 ? 'rgba(255, 255, 255, 0.7)' : '#000'
          ctx.lineWidth = 2
        }
        ctx.stroke()
        ctx.restore()

        if (note.type === '7' || note.type === '9') {
          const hits = note.attributes?.hits || 5
          ctx.fillStyle = '#000'
          ctx.font = 'bold 12px sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText(hits.toString(), x, y + 4)
        }
      })

      // Draw Other Users' Seekbars
      ctx.textAlign = 'center'
      Object.keys(presenceState).forEach(key => {
        const userPresences = presenceState[key]
        if (!userPresences || userPresences.length === 0) return

        const presence = userPresences[userPresences.length - 1]
        const presenceUserId = String(presence.userId || key)
        if (presenceUserId === userId) return
        if (typeof presence.seekPos !== 'number') return

        const pSeekM = Math.floor(presence.seekPos)
        const pSeekP = (presence.seekPos - pSeekM) * GRID_DIVISIONS
        const pX = getX(pSeekM, pSeekP)

        if (pX < visibleStartX || pX > visibleEndX) return

        ctx.strokeStyle = presence.userColor || '#888'
        ctx.lineWidth = 1.5
        ctx.globalAlpha = 0.5
        ctx.beginPath()
        ctx.moveTo(pX, HEADER_HEIGHT)
        ctx.lineTo(pX, canvas.height)
        ctx.stroke()
        ctx.globalAlpha = 1.0

        ctx.fillStyle = presence.userColor || '#888'
        ctx.beginPath()
        ctx.moveTo(pX, HEADER_HEIGHT)
        ctx.lineTo(pX - 4, HEADER_HEIGHT - 6)
        ctx.lineTo(pX + 4, HEADER_HEIGHT - 6)
        ctx.fill()

        const nameLabel = presence.userName || 'Unknown'
        ctx.font = 'bold 10px sans-serif'
        const tw = ctx.measureText(nameLabel).width
        ctx.fillStyle = presence.userColor || '#888'
        ctx.globalAlpha = 0.8
        ctx.fillRect(pX - tw / 2 - 4, HEADER_HEIGHT - 20, tw + 8, 14)

        ctx.globalAlpha = 1.0
        ctx.fillStyle = '#fff'
        ctx.fillText(nameLabel, pX, HEADER_HEIGHT - 10)
      })

      // Draw Seekbar (Self) when not playing.
      if (!isPlaying) {
        const seekMeasure = Math.floor(seekPos)
        const seekGridPos = (seekPos - seekMeasure) * GRID_DIVISIONS
        const seekX = Math.round(getX(seekMeasure, seekGridPos)) + 0.5

        if (seekX >= visibleStartX && seekX <= visibleEndX) {
          ctx.strokeStyle = '#ff3333'
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.moveTo(seekX, 0)
          ctx.lineTo(seekX, canvas.height)
          ctx.stroke()

          ctx.fillStyle = '#ff3333'
          ctx.beginPath()
          ctx.moveTo(seekX - 6, 0)
          ctx.lineTo(seekX + 6, 0)
          ctx.lineTo(seekX, 10)
          ctx.closePath()
          ctx.fill()
        }
      }

      if (selectionBox) {
        ctx.fillStyle = 'rgba(255, 165, 0, 0.2)'
        ctx.strokeStyle = 'orange'
        ctx.lineWidth = 1
        const x = Math.min(selectionBox.startX, selectionBox.endX)
        const y = Math.min(selectionBox.startY, selectionBox.endY)
        const w = Math.abs(selectionBox.endX - selectionBox.startX)
        const h = Math.abs(selectionBox.endY - selectionBox.startY)
        ctx.fillRect(x, y, w, h)
        ctx.strokeRect(x, y, w, h)
      }

      ctx.restore()
      animationFrameId = requestAnimationFrame(render)
    }
    render()
    return () => cancelAnimationFrame(animationFrameId)
  }, [notes, selectedNotes, selectionBox, zoom, seekPos, TOTAL_MEASURES, baseWidth, snapDivisions, commands, presenceState, userId, measureInfos, measureOffsets, waveformPeaks, metadata, isPlaying, isDragging, isDraggingNotes, draggingEndpointId, isSeeking, currentMouseX])

  useEffect(() => {
    latestSeekPosRef.current = seekPos
  }, [seekPos])

  useEffect(() => {
    const existing = new Set(notes.map(n => n.id))
    noteHitAnimRef.current.forEach((_, id) => {
      if (!existing.has(id)) noteHitAnimRef.current.delete(id)
    })
  }, [notes])

  const animateMagnetSeek = useCallback((fromSeek: number, toSeek: number) => {
    const clampedFrom = isPlaying ? fromSeek : Math.max(0, fromSeek)
    const clampedTo = isPlaying ? toSeek : Math.max(0, toSeek)

    if (seekMagnetAnimRef.current !== null) {
      cancelAnimationFrame(seekMagnetAnimRef.current)
      seekMagnetAnimRef.current = null
    }

    const distance = clampedTo - clampedFrom
    if (Math.abs(distance) < 0.0001) {
      setSeekPos(clampedTo)
      return
    }

    let direction = Math.sign(clampedTo - latestSeekPosRef.current)
    if (direction === 0) direction = Math.sign(distance)
    if (direction === 0) direction = lastMagnetDirectionRef.current
    lastMagnetDirectionRef.current = direction

    const start = performance.now()
    const duration = 140
    const overshoot = Math.abs(distance) * 0.12 * direction
    const midTarget = clampedTo + overshoot
    const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      let value = clampedTo

      if (t < 0.65) {
        const localT = t / 0.65
        const eased = easeOutCubic(localT)
        value = clampedFrom + (midTarget - clampedFrom) * eased
      } else {
        const localT = (t - 0.65) / 0.35
        const eased = easeOutCubic(localT)
        value = midTarget + (clampedTo - midTarget) * eased
      }

      setSeekPos(isPlaying ? value : Math.max(0, value))
      if (t < 1) {
        seekMagnetAnimRef.current = requestAnimationFrame(step)
      } else {
        setSeekPos(clampedTo)
        seekMagnetAnimRef.current = null
      }
    }

    seekMagnetAnimRef.current = requestAnimationFrame(step)
  }, [isPlaying])

  useEffect(() => {
    return () => {
      if (seekMagnetAnimRef.current !== null) {
        cancelAnimationFrame(seekMagnetAnimRef.current)
      }
    }
  }, [])

  const jumpToMeasure = useCallback((measure: number, smoothScroll = false) => {
    const target = isPlaying ? Math.max(-leadInMeasures, measure) : Math.max(0, measure)
    setSeekPos(target)
    centerScrollOnSeek(target, smoothScroll)
  }, [isPlaying, leadInMeasures, centerScrollOnSeek])

  const handleMeasureJump = useCallback(() => {
    const parsed = Number(measureJumpInput)
    if (!Number.isFinite(parsed)) return
    jumpToMeasure(Math.trunc(parsed), true)
  }, [measureJumpInput, jumpToMeasure])

  // Canvas Interactions
  const getCanvasPos = (e: React.MouseEvent) => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    // Important: Account for scrollLeft when translating mouse position to timeline X
    return { x: e.clientX - rect.left + container.scrollLeft, y: e.clientY - rect.top }
  }

  const handleMouseDown = (e: React.MouseEvent) => {
    const { x, y } = getCanvasPos(e)

    // Seek interaction in header area
    if (y <= HEADER_HEIGHT) {
      setIsSeeking(true)
      const grid = getGridFromX(x)
      const rawSeek = grid.rawMeasure + grid.rawPos / GRID_DIVISIONS
      const snappedSeek = grid.measure + grid.pos / GRID_DIVISIONS
      seekGestureRef.current = { startX: x, moved: false, rawSeek, snappedSeek }
      setSeekPos(rawSeek)
      return
    }

    if (e.button === 0) {
      tjaSourceRef.current = 'gui'
      const state = stateRef.current
      const laneCenterY = HEADER_HEIGHT + LANE_HEIGHT / 2

      // Check if clicking on an endpoint (type 8)
      const clickedEndNote = state.notes.find(n => {
        if (n.type !== '8') return false
        const nx = getX(n.measure, n.position)
        return Math.abs(x - nx) < BASE_NOTE_RADIUS && Math.abs(y - laneCenterY) < BASE_NOTE_RADIUS
      })

      if (clickedEndNote && (e.ctrlKey || e.metaKey)) {
        setSelectedNotes(prev => {
          const next = new Set(prev)
          if (next.has(clickedEndNote.id)) next.delete(clickedEndNote.id)
          else next.add(clickedEndNote.id)
          return next
        })
        return
      }

      if (clickedEndNote && selectedType !== '0') {
        setDraggingEndpointId(clickedEndNote.id)
        return
      }

      // Check if clicking on a general note for dragging
      const clickedNote = state.notes.find(n => {
        if (n.type === '8') return false
        const nx = getX(n.measure, n.position)
        return Math.abs(x - nx) < BASE_NOTE_RADIUS && Math.abs(y - laneCenterY) < BASE_NOTE_RADIUS
      })

      if (clickedNote) {
        if (e.ctrlKey || e.metaKey) {
          setSelectedNotes(prev => {
            const next = new Set(prev)
            if (next.has(clickedNote.id)) next.delete(clickedNote.id)
            else next.add(clickedNote.id)
            return next
          })
          return
        }

        if (selectedType !== '0') {
          let newSelection = state.selectedNotes
          if (!state.selectedNotes.has(clickedNote.id)) {
            newSelection = new Set([clickedNote.id])
            setSelectedNotes(newSelection)
          }

          setIsDraggingNotes(true)

          const { measure, pos } = getGridFromX(x)

          setDragStartGrid({ measure: measure, pos: Math.max(0, pos) })
          setOriginalDraggingNotes(state.notes.filter(n => newSelection.has(n.id)))
          return
        }
      }
    }

    if (e.button === 2 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault()
      rightDragRef.current = { startX: x, startY: y, moved: false }
      setSelectionBox({ startX: x, startY: y, endX: x, endY: y })
      setIsDragging(true)
    }
  }

  const handleMouseMove = (e: React.MouseEvent) => {
    const { x, y } = getCanvasPos(e)

    // Always track mouse X position for edge auto-scroll
    setCurrentMouseX(e.clientX)

    if (isSeeking) {
      const grid = getGridFromX(x)
      const rawSeek = grid.rawMeasure + grid.rawPos / GRID_DIVISIONS
      const snappedSeek = grid.measure + grid.pos / GRID_DIVISIONS
      if (seekGestureRef.current) {
        if (Math.abs(x - seekGestureRef.current.startX) > 3) {
          seekGestureRef.current.moved = true
        }
        seekGestureRef.current.rawSeek = rawSeek
        seekGestureRef.current.snappedSeek = snappedSeek
      } else {
        seekGestureRef.current = { startX: x, moved: false, rawSeek, snappedSeek }
      }
      setSeekPos(rawSeek)
      return
    }

    const { measure, pos } = getGridFromX(x)
    setHoverGridObj({ measure: measure, pos: Math.max(0, pos) })

    if (rightDragRef.current && selectionBox) {
      setSelectionBox({ ...selectionBox, endX: x, endY: y })
      if (rightDragRef.current) {
        const dx = Math.abs(x - rightDragRef.current.startX)
        const dy = Math.abs(y - rightDragRef.current.startY)
        if (dx > 4 || dy > 4) {
          rightDragRef.current.moved = true
        }
      }
    }

    const state = stateRef.current

    if (state.isDraggingNotes && state.dragStartGrid) {
      const startAbs = state.dragStartGrid.measure * GRID_DIVISIONS + state.dragStartGrid.pos
      const currentAbs = measure * GRID_DIVISIONS + Math.max(0, pos)
      const deltaAbs = currentAbs - startAbs

      if (deltaAbs !== 0) {
        const movingIds = new Set(state.originalDraggingNotes.map(n => n.id))
        setNotes(prev => prev.map(n => {
          if (!movingIds.has(n.id)) return n
          const orig = state.originalDraggingNotes.find(o => o.id === n.id)!
          const origAbs = orig.measure * GRID_DIVISIONS + orig.position
          let newAbs = origAbs + deltaAbs
          newAbs = Math.max(0, newAbs) // Clamp
          return {
            ...n,
            measure: Math.floor(newAbs / GRID_DIVISIONS),
            position: newAbs % GRID_DIVISIONS
          }
        }))
      }
    }
    if (state.draggingEndpointId) {
      // Check collision to prevent overlapping other notes while dragging
      const existing = state.notes.find(n => n.id !== state.draggingEndpointId && n.measure === measure && n.position === Math.max(0, pos))
      if (!existing) {
        setNotes(prev => prev.map(n => n.id === state.draggingEndpointId ? { ...n, measure: measure, position: Math.max(0, pos) } : n))
      }
    }
  }

  // Use native addEventListener with { passive: false } to allow preventDefault on wheel events
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()

      if (e.ctrlKey) {
        // Ctrl + Mouse Wheel: Zoom
        const direction = e.deltaY > 0 ? 'out' : 'in'
        handleZoom(direction)
      } else if (e.shiftKey) {
        // Shift + Mouse Wheel: Grid Snap
        setSnapDivisions(prev => {
          const idx = SNAP_OPTIONS.indexOf(prev)
          if (e.deltaY < 0) { // Scroll up: increase divisions
            if (idx < SNAP_OPTIONS.length - 1) return SNAP_OPTIONS[idx + 1]
          } else { // Scroll down: decrease divisions
            if (idx > 0) return SNAP_OPTIONS[idx - 1]
          }
          return prev
        })
      } else {
        // Normal Wheel: Scroll Horizontal
        const scrollAmount = e.deltaY > 0 ? 60 : -60
        container.scrollLeft += scrollAmount
      }
    }

    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  })

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    if (suppressContextMenuRef.current) {
      suppressContextMenuRef.current = false
      return
    }

    const { x, y } = getCanvasPos(e as any)

    // Grid coordinate for command
    const { measure, pos } = getGridFromX(x)

    // Check if clicking on a note (specifically Balloon for attributes)
    const laneCenterY = HEADER_HEIGHT + LANE_HEIGHT / 2
    const clickedNote = notes.find(n => {
      const nx = getX(n.measure, n.position)
      return Math.abs(x - nx) < BASE_NOTE_RADIUS && Math.abs(y - laneCenterY) < BASE_NOTE_RADIUS
    })

    if (clickedNote && (clickedNote.type === '7' || clickedNote.type === '9')) {
      setAttributeModal({ noteId: clickedNote.id, hits: (clickedNote.attributes?.hits || 5).toString() })
      return
    }

    if (y <= HEADER_HEIGHT) {
      setContextMenu({ x: e.clientX, y: e.clientY, measure: measure, pos: Math.max(0, pos) })
    }

  }

  const handleCommandSelect = (type: 'BPM' | 'HS' | 'MEASURE' | 'GOGOSTART' | 'GOGOEND') => {
    if (!contextMenu) return
    const { measure, pos } = contextMenu
    setContextMenu(null)

    if (type === 'MEASURE' && pos !== 0) {
      alert('MEASUREキーは小節の先頭にしか置けません。')
      return
    }

    // GOGOSTART/GOGOEND don't need a value input
    if (type === 'GOGOSTART' || type === 'GOGOEND') {
      saveCommand(type, measure, pos, null)
      return
    }

    setCommandValue(type === 'BPM' ? '120' : type === 'HS' ? '1.0' : '4/4')
    setCommandModal({ type, measure, pos })
  }

  const handleCommandConfirm = () => {
    if (!commandModal) return
    saveCommand(commandModal.type, commandModal.measure, commandModal.pos, commandValue)
    setCommandModal(null)
  }

  const saveCommand = async (type: 'BPM' | 'HS' | 'MEASURE' | 'GOGOSTART' | 'GOGOEND', measure: number, pos: number, value: string | null) => {
    if (type === 'BPM' || type === 'HS') {
      const parsed = parseFloat(value ?? '')
      if (!Number.isNaN(parsed) && parsed < 0) {
        alert(`${type}にマイナス値は設定できません。`)
        return
      }
    }
    if (type === 'MEASURE' && value) {
      const m = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*$/)
      if (m) {
        const n = parseFloat(m[1])
        const d = parseFloat(m[2])
        if (n < 0 || d < 0) {
          alert('MEASUREにマイナス値は設定できません。')
          return
        }
      }
    }

    const existingCmd = commands.find(c => c.measure === measure && c.position === pos && c.type === type)
    const newCmd = {
      id: existingCmd ? existingCmd.id : crypto.randomUUID(),
      room_id: roomId,
      measure,
      position: pos,
      type,
      value,
      last_modified_at: Date.now(),
      last_modified_by: userId
    }

    // Optimistic local update
    setCommands(prev => [...prev.filter(c => c.id !== newCmd.id), newCmd as Command])
    broadcastCommandUpsert([newCmd as Command])

    // History
    if (existingCmd) {
      pushHistory({ action: 'CMD_UPDATE', newCommands: [newCmd], oldCommands: [existingCmd] })
    } else {
      pushHistory({ action: 'CMD_INSERT', newCommands: [newCmd] })
    }

    const { error } = await supabase.from('commands').upsert(newCmd, { onConflict: 'room_id,measure,position,type' })
    if (error) console.error('Error saving command:', error)
  }

  const deleteCommand = async (id: string) => {
    const cmd = commands.find(c => c.id === id)
    if (!cmd) return

    // Optimistic delete
    setCommands(prev => prev.filter(c => c.id !== id))
    broadcastCommandDelete([id])
    pushHistory({ action: 'CMD_DELETE', oldCommands: [cmd] })

    await supabase.from('commands').delete().eq('id', id)
  }

  const handleMouseUp = async (e: React.MouseEvent) => {
    // Clear mouse tracking when drag ends
    setCurrentMouseX(null)

    if (isSeeking) {
      setIsSeeking(false)
      const gesture = seekGestureRef.current
      if (gesture) {
        // Single click and drag-end both magnetize only at the end.
        animateMagnetSeek(gesture.rawSeek, gesture.snappedSeek)
      }
      seekGestureRef.current = null
      return
    }

    const state = stateRef.current

    if (state.draggingEndpointId) {
      const endNote = state.notes.find(n => n.id === state.draggingEndpointId)
      if (endNote) {
        const updatedEndNote = {
          ...endNote,
          last_modified_at: Date.now(),
          last_modified_by: userId
        }
        broadcastNoteUpsert([updatedEndNote])
        const { error } = await supabase.from('notes').upsert(updatedEndNote, { onConflict: 'room_id,measure,position' })
        if (!error) {
          pushHistory({ action: 'INSERT', notes: [endNote] }) // Treat as insert for simple undo
        }
      }
      setDraggingEndpointId(null)
      return
    }

    if (state.isDraggingNotes) {
      const movingIds = new Set(state.originalDraggingNotes.map(n => n.id))
      const finalNotes = state.notes.filter(n => movingIds.has(n.id))

      const changed = finalNotes.some(n => {
        const orig = state.originalDraggingNotes.find(o => o.id === n.id)
        return orig && (orig.measure !== n.measure || orig.position !== n.position)
      })

      if (changed) {
        const updatedFinalNotes = finalNotes.map(n => ({
          ...n,
          last_modified_at: Date.now(),
          last_modified_by: userId
        }))
        broadcastNoteUpsert(updatedFinalNotes)
        const { error } = await supabase.from('notes').upsert(updatedFinalNotes, { onConflict: 'room_id,measure,position' })
        if (!error) {
          pushHistory({ action: 'UPDATE', notes: finalNotes, oldNotes: state.originalDraggingNotes })
        } else {
          // Rollback
          setNotes(prev => prev.map(n => state.originalDraggingNotes.find(o => o.id === n.id) || n))
        }
      }

      setIsDraggingNotes(false)
      setDragStartGrid(null)
      setOriginalDraggingNotes([])
      return
    }

    if (rightDragRef.current && selectionBox) {
      const rightDrag = rightDragRef.current
      const isRightDragSelection = true
      const isRightDragClick = !rightDrag.moved

      if (isRightDragClick) {
        setIsDragging(false)
        setSelectionBox(null)
        rightDragRef.current = null
        return
      }

      const minX = Math.min(selectionBox.startX, selectionBox.endX)
      const maxX = Math.max(selectionBox.startX, selectionBox.endX)
      const minY = Math.min(selectionBox.startY, selectionBox.endY)
      const maxY = Math.max(selectionBox.startY, selectionBox.endY)
      const laneCenterY = HEADER_HEIGHT + LANE_HEIGHT / 2

      const newlySelected = new Set<string>()
      notes.forEach(note => {
        const nx = getX(note.measure, note.position)
        const ny = laneCenterY
        if (nx >= minX && nx <= maxX && ny >= minY && ny <= maxY) {
          newlySelected.add(note.id)
        }
      })

      if (e.shiftKey) {
        const merged = new Set(selectedNotes)
        newlySelected.forEach(id => merged.add(id))
        setSelectedNotes(merged)
      } else {
        setSelectedNotes(newlySelected)
      }

      suppressContextMenuRef.current = true
      rightDragRef.current = null
      setIsDragging(false)
      setSelectionBox(null)
      return
    }

    // Dismiss context menu on any click
    if (contextMenu) setContextMenu(null)

    // Placing or Deleting a single note
    if (e.button === 0 && !e.ctrlKey && !e.metaKey && e.clientY - (canvasRef.current?.getBoundingClientRect().top || 0) > HEADER_HEIGHT) {
      const { measure, pos } = hoverGridObj
      if (measure < 0) return // Block note placement in lead-in

      const state = stateRef.current

      // Check if a note already exists at this exact grid position
      const existingNote = state.notes.find(n => n.measure === measure && n.position === pos)

      // Helper for deciding if a position is inside a roll
      const isInsideRoll = (m: number, p: number, allNotes: Note[]) => {
        const absTarget = m * GRID_DIVISIONS + p;
        const sorted = [...allNotes].sort((a, b) => (a.measure * GRID_DIVISIONS + a.position) - (b.measure * GRID_DIVISIONS + b.position));
        let inside = false;
        for (const n of sorted) {
          const abs = n.measure * GRID_DIVISIONS + n.position;
          if (abs > absTarget) break;
          // We don't block placing exactly on the start note itself (that is a collision checked earlier)
          // But if we are *strictly strictly greater* than the start note and *less* than the end note:
          if (abs < absTarget && ['5', '6', '7', '9'].includes(n.type)) inside = true;
          if (abs <= absTarget && n.type === '8') inside = false;
        }
        return inside;
      }

      // Optimistic delete
      if (selectedType === '0') {
        if (existingNote) {
          // Find paired note if applicable
          let pairedNote: Note | undefined
          if (['5', '6', '7', '9'].includes(existingNote.type)) {
            // Find next 8
            const sorted = [...state.notes].sort((a, b) => (a.measure * GRID_DIVISIONS + a.position) - (b.measure * GRID_DIVISIONS + b.position));
            const startAbs = existingNote.measure * GRID_DIVISIONS + existingNote.position;
            pairedNote = sorted.find(n => n.type === '8' && (n.measure * GRID_DIVISIONS + n.position) > startAbs);
          } else if (existingNote.type === '8') {
            // Find prev 5,6,7
            const sorted = [...state.notes].sort((a, b) => (a.measure * GRID_DIVISIONS + a.position) - (b.measure * GRID_DIVISIONS + b.position));
            const endAbs = existingNote.measure * GRID_DIVISIONS + existingNote.position;
            let lastStart: Note | undefined
            for (const n of sorted) {
              const abs = n.measure * GRID_DIVISIONS + n.position;
              if (abs >= endAbs) break;
              if (['5', '6', '7', '9'].includes(n.type)) lastStart = n;
              else if (n.type === '8') lastStart = undefined;
            }
            pairedNote = lastStart;
          }

          const allToDelete = pairedNote ? [existingNote, pairedNote] : [existingNote]

          setNotes(prev => prev.filter(n => !allToDelete.some(d => d.id === n.id)))
          const { error } = await supabase.from('notes').delete().in('id', allToDelete.map(n => n.id))
          if (!error) {
            broadcastNoteDelete(allToDelete.map(n => n.id))
            pushHistory({ action: 'DELETE', notes: allToDelete })
          } else {
            setNotes(prev => [...prev, ...allToDelete])
          }
        }
        return
      }

      // If clicking the same spot with the same type, do nothing
      if (existingNote && existingNote.type === selectedType) return

      // Prevent placing a note inside a roll (except delete which is handled above)
      if (isInsideRoll(measure, pos, state.notes)) {
        return
      }

      // Optimistic insert/update
      const newNote = {
        id: existingNote ? existingNote.id : crypto.randomUUID(),
        room_id: roomId,
        measure,
        position: pos,
        type: selectedType,
        last_modified_at: Date.now(),
        last_modified_by: userId,
        attributes: (selectedType === '7' || selectedType === '9') ? { hits: 5 } : {}
      }

      let endNote: Note | null = null
      const isRollStart = ['5', '6', '7', '9'].includes(selectedType)

      // Auto-place endpoint (type 8) 4 grids ahead
      if (isRollStart && !existingNote) {
        const interval = GRID_DIVISIONS / snapDivisions
        let targetEndAbsolutePos = measure * GRID_DIVISIONS + pos + 4 * interval

        const absoluteStart = measure * GRID_DIVISIONS + pos
        let earliestCollision: number | null = null

        state.notes.forEach(n => {
          const abs = n.measure * GRID_DIVISIONS + n.position
          if (abs > absoluteStart && abs <= targetEndAbsolutePos) {
            if (earliestCollision === null || abs < earliestCollision) {
              earliestCollision = abs
            }
          }
        })

        if (earliestCollision !== null) {
          const distance = earliestCollision - absoluteStart
          if (distance <= interval) {
            // Cannot place roll, return early (cancel)
            return
          } else {
            // Place endpoint exactly 1 grid before the collision
            targetEndAbsolutePos = earliestCollision - interval
          }
        }

        const endMeasure = Math.floor(targetEndAbsolutePos / GRID_DIVISIONS)
        const endPos = targetEndAbsolutePos % GRID_DIVISIONS

        endNote = {
          id: crypto.randomUUID(),
          room_id: roomId,
          measure: endMeasure,
          position: endPos,
          type: '8',
          last_modified_at: Date.now(),
          last_modified_by: userId,
          attributes: {}
        }
      }

      // Re-place locally
      setNotes(prev => {
        let next = [...prev.filter(n => n.id !== newNote.id), newNote]
        if (endNote) next.push(endNote)
        return next
      })

      const upsertData = endNote ? [newNote, endNote] : [newNote]
      broadcastNoteUpsert(upsertData)
      const { error } = await supabase.from('notes').upsert(upsertData, { onConflict: 'room_id,measure,position' })
      if (!error) {
        pushHistory({ action: 'INSERT', notes: upsertData })
      }
    }
  }

  const handleZoom = (direction: 'in' | 'out') => {
    setZoom(prev => {
      let newZoom = prev
      if (direction === 'in') newZoom = Math.min(4.0, prev + 0.1)
      else newZoom = Math.max(0.1, prev - 0.1)
      // Round to 1 decimal to avoid floating point issues
      return Math.round(newZoom * 10) / 10
    })
  }

  const setExactZoom = (z: number) => setZoom(z)

  const handleReset = async () => {
    tjaSourceRef.current = 'gui'
    setShowResetModal(false)
    const oldNotes = [...notes]
    const oldCmds = [...commands]
    const oldMetadata = { ...metadata }
    const oldTjaText = tjaText
    const oldAudioUrl = audioUrl
    const oldWaveformPeaks = [...waveformPeaks]
    const oldAudioDuration = audioDuration

    // Optimistic clear locally
    audioEngine.stop()
    setIsPlaying(false)
    setNotes([])
    setCommands([])
    setMetadata({ ...DEFAULT_CHART_METADATA })
    setTjaText('')
    setTjaDirty(false)
    setAudioUrl(null)
    setWaveformPeaks([])
    setAudioDuration(0)
    audioEngine.audioBuffer = null
    noteHitAnimRef.current.clear()
    historyRef.current = []
    historyIndexRef.current = -1
    setHistoryLength(0)
    setHistoryIndexState(-1)
    setSelectedNotes(new Set())

    try {
      // Delete all notes and commands for this room from Supabase
      const [notesDel, cmdsDel] = await Promise.all([
        supabase.from('notes').delete().eq('room_id', roomId),
        supabase.from('commands').delete().eq('room_id', roomId)
      ])

      if (notesDel.error || cmdsDel.error) {
        throw notesDel.error || cmdsDel.error
      }

      await supabase.storage.from('audio').remove([`${roomId}.ogg`])
      await supabase.from('rooms').update({
        ...DEFAULT_CHART_METADATA,
        tja_text: ''
      }).eq('id', roomId)

      // Notify other clients to refresh their state
      if (channelRef.current) {
        await channelRef.current.send({
          type: 'broadcast',
          event: 'REFRESH_DATA',
          payload: { userId }
        })
      }
    } catch (err) {
      console.error('Failed to reset data in Supabase:', err)
      // Rollback local state on failure
      setMetadata(oldMetadata)
      setTjaText(oldTjaText)
      setAudioUrl(oldAudioUrl)
      setWaveformPeaks(oldWaveformPeaks)
      setAudioDuration(oldAudioDuration)
      setNotes(oldNotes)
      setCommands(oldCmds)
      alert('一部またはすべてのデータの削除に失敗しました。接続を確認してください。')
    }
  }

  const saveAttribute = async (noteId: string, hits: number) => {
    tjaSourceRef.current = 'gui'
    const note = notes.find(n => n.id === noteId)
    if (!note) return
    const updatedNote = { ...note, attributes: { ...note.attributes, hits } }

    // Optimistic update
    setNotes(prev => prev.map(n => n.id === noteId ? updatedNote : n))
    broadcastNoteUpsert([updatedNote])
    pushHistory({ action: 'UPDATE', notes: [updatedNote], oldNotes: [note] })

    const { error } = await supabase.from('notes').upsert(updatedNote, { onConflict: 'room_id,measure,position' })
    if (error) console.error('Error saving attribute:', error)
  }

  const saveMetadata = async (newMetadata: typeof metadata) => {
    if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current)

    saveTimeoutRef.current = setTimeout(async () => {
      const payload: any = {
        title: newMetadata.title,
        subtitle: newMetadata.subtitle,
        offset: newMetadata.offset,
        difficulty: newMetadata.difficulty,
        level: newMetadata.level,
        sevol: newMetadata.sevol,
        songvol: newMetadata.songvol
      }
      if (roomSupportsTjaSource) {
        payload.tja_text = tjaText
      }

      const { error } = await supabase.from('rooms').update(payload).eq('id', roomId)
      if (error) console.error('Error saving metadata:', error)
    }, 1000) // 1 second debounce
  }

  const saveMetadataNow = async (newMetadata: typeof metadata) => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current)
      saveTimeoutRef.current = null
    }

    const payload: any = {
      title: newMetadata.title,
      subtitle: newMetadata.subtitle,
      offset: newMetadata.offset,
      difficulty: newMetadata.difficulty,
      level: newMetadata.level,
      sevol: newMetadata.sevol,
      songvol: newMetadata.songvol
    }
    if (roomSupportsTjaSource) {
      payload.tja_text = tjaText
    }

    const { error } = await supabase.from('rooms').update(payload).eq('id', roomId)
    if (error) console.error('Error saving metadata:', error)
  }

  const handleMetadataChange = (field: string, value: any) => {
    const newMetadata = { ...metadata, [field]: value }
    setMetadata(newMetadata)
    saveMetadata(newMetadata)
    tjaSourceRef.current = 'gui'
  }

  // ── GUI → TJA sync ──
  useEffect(() => {
    // If we just saved TJA, don't trigger the sync.
    if (tjaSourceRef.current === 'tja') {
      tjaSourceRef.current = null
      return
    }

    // Protection: If the user has unsaved manual edits in the TJA panel,
    // do not overwrite them with GUI-generated code.
    if (tjaDirty) return

    const timeout = setTimeout(() => {
      const tjaMetadata: TjaMetadata = {
        ...metadata,
        bpm: parseFloat(commands.find(c => c.type === 'BPM' && c.measure === 0 && c.position === 0)?.value || '120')
      }
      const tjaNotes: TjaNote[] = notes.map(n => ({
        measure: n.measure,
        position: n.position,
        type: n.type,
        attributes: n.attributes
      }))
      const tjaCommands: TjaCommand[] = commands.map(c => ({
        measure: c.measure,
        position: c.position,
        type: c.type,
        value: c.value === null ? null : (c.value || '')
      }))
      const text = guiToTja(tjaMetadata, tjaCommands, tjaNotes)

      // Mark this update as GUI-originated so handleTjaTextChange doesn't flip tjaDirty
      tjaSourceRef.current = 'gui'
      setTjaText(text)

      // Auto-save to Supabase so other clients receive the real-time update
      if (roomSupportsTjaSource) {
        supabase.from('rooms').update({ tja_text: text }).eq('id', roomId).then(({ error }) => {
          if (error) {
            console.error('Failed to auto-save TJA text:', error)
          } else {
            // Broadcast REFRESH_DATA so other clients reload their state
            if (channelRef.current) {
              channelRef.current.send({
                type: 'broadcast',
                event: 'REFRESH_DATA',
                payload: { userId }
              })
            }
          }
        })
      }
    }, 1000) // 1 second debounce to prevent too many DB writes

    return () => clearTimeout(timeout)
  }, [notes, commands, metadata, tjaDirty, roomId, roomSupportsTjaSource])

  // ── TJA → GUI sync (local only, no Supabase until Save) ──
  const handleTjaTextChange = useCallback((newText: string | undefined) => {
    if (newText === undefined) return

    // If this change was triggered by the GUI -> TJA sync effect, ignore it for dirty tracking
    if (tjaSourceRef.current === 'gui') {
      tjaSourceRef.current = null
      setTjaText(newText)
      return
    }

      setTjaText(newText)
      setTjaDirty(newText !== lastSavedTjaTextRef.current)
  }, [])

  // ── Explicit Save: parse TJA → update GUI + persist to Supabase ──
  const handleTjaSave = useCallback(async () => {
    tjaSourceRef.current = 'tja'
    try {
      const parsed = tjaToGui(tjaText)

      // Update metadata (local + Supabase)
      const newMeta = {
        title: parsed.metadata.title,
        subtitle: parsed.metadata.subtitle,
        offset: parsed.metadata.offset,
        difficulty: parsed.metadata.difficulty,
        level: parsed.metadata.level,
        sevol: parsed.metadata.sevol ?? 100,
        songvol: parsed.metadata.songvol ?? 100,
        audio_url: parsed.metadata.audio_url ?? null
      }
      setMetadata(newMeta)
      saveMetadata(newMeta)

      // Build new notes with preserved IDs
      const prevNotes = stateRef.current.notes
      const newNotes: Note[] = parsed.notes.map(pn => {
        const existing = prevNotes.find(n => n.measure === pn.measure && n.position === pn.position && n.type === pn.type)
        return {
          id: existing?.id || crypto.randomUUID(),
          room_id: roomId,
          measure: pn.measure,
          position: pn.position,
          type: pn.type,
          attributes: pn.attributes || {},
          last_modified_at: Date.now(),
          last_modified_by: userId
        }
      })

      const newNoteIds = new Set(newNotes.map(n => n.id))
      const toDeleteNoteIds = prevNotes.map(n => n.id).filter(id => !newNoteIds.has(id))

      setNotes(newNotes)

      if (newNotes.length > 0) await supabase.from('notes').upsert(newNotes, { onConflict: 'room_id,measure,position' })
      if (toDeleteNoteIds.length > 0) await supabase.from('notes').delete().in('id', toDeleteNoteIds)

      // Build new commands with preserved IDs
      const prevCmds = stateRef.current.commands
      const newCmds: Command[] = parsed.commands.map(pc => {
        const existing = prevCmds.find(c => c.measure === pc.measure && c.position === pc.position && c.type === pc.type)
        return {
          id: existing?.id || crypto.randomUUID(),
          room_id: roomId,
          measure: pc.measure,
          position: pc.position,
          type: pc.type,
          value: pc.value,
          last_modified_by: userId
        }
      })

      const newCmdIds = new Set(newCmds.map(c => c.id))
      const toDeleteCmdIds = prevCmds.map(c => c.id).filter(id => !newCmdIds.has(id))

      setCommands(newCmds)

      if (newCmds.length > 0) await supabase.from('commands').upsert(newCmds, { onConflict: 'room_id,measure,position,type' })
      if (toDeleteCmdIds.length > 0) await supabase.from('commands').delete().in('id', toDeleteCmdIds)

      if (roomSupportsTjaSource) {
        const { error: roomError } = await supabase.from('rooms').update({ tja_text: tjaText }).eq('id', roomId)
        if (roomError) console.error('Error saving room TJA source:', roomError)
      }

      lastSavedTjaTextRef.current = tjaText
      setTjaDirty(false)

      // Notify other clients to refresh their state (Notes/Commands/Metadata)
      if (channelRef.current) {
        await channelRef.current.send({
          type: 'broadcast',
          event: 'REFRESH_DATA',
          payload: { userId }
        })
      }
    } catch (err) {
      console.error('TJA parse/save error:', err)
    }
  }, [tjaText, roomId, roomSupportsTjaSource, userId])

  // Export TJA file
  const handleExportTja = useCallback(async () => {
    const fileName = `${metadata.title || 'chart'}.tja`
    const dataBlob = new Blob([tjaText], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(dataBlob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)

    // Delete data if option is selected
    if (deleteAfterExport) {
      await handleReset()
      setShowExportDeleteModal(false)
      setDeleteAfterExport(false)
    } else {
      setShowExportDeleteModal(false)
    }
  }, [tjaText, metadata.title, deleteAfterExport, handleReset])

  const handleImportTja = async () => {
    try {
      const result = tjaToGui(importTjaFileText)
      const normalizedMetadata: TjaMetadata = {
        ...result.metadata,
        bpm: parseFloat(result.commands.find(c => c.type === 'BPM' && c.measure === 0 && c.position === 0)?.value || String(result.metadata.bpm || 120))
      }

      // Update metadata
      setMetadata(normalizedMetadata)
      saveMetadata(normalizedMetadata)
      tjaSourceRef.current = 'tja'
      setTjaDirty(false)

      // Clear existing notes and commands
      const oldNoteIds = notes.map(n => n.id)
      const oldCmdIds = commands.map(c => c.id)

      // Create new notes with generated UUIDs and room_id
      const newNotes: Note[] = result.notes.map(n => ({
        id: crypto.randomUUID(),
        room_id: roomId,
        measure: n.measure,
        position: n.position,
        type: n.type,
        attributes: n.attributes || {},
        last_modified_at: Date.now(),
        last_modified_by: userId
      }))

      // Create new commands with generated UUIDs and room_id
      const newCommands: Command[] = result.commands.map(c => ({
        id: crypto.randomUUID(),
        room_id: roomId,
        measure: c.measure,
        position: c.position,
        type: c.type,
        value: c.value,
        last_modified_at: Date.now(),
        last_modified_by: userId
      }))

      const normalizedTjaText = guiToTja(
        normalizedMetadata,
        newCommands.map(c => ({ measure: c.measure, position: c.position, type: c.type, value: c.value })),
        newNotes.map(n => ({ measure: n.measure, position: n.position, type: n.type, attributes: n.attributes }))
      )
      setTjaText(normalizedTjaText)

      // Update local state
      setNotes(newNotes)
      setCommands(newCommands)

      // Delete old notes from DB
      if (oldNoteIds.length > 0) {
        await supabase.from('notes').delete().in('id', oldNoteIds)
      }

      // Delete old commands from DB
      if (oldCmdIds.length > 0) {
        await supabase.from('commands').delete().in('id', oldCmdIds)
      }

      // Insert new notes to DB
      if (newNotes.length > 0) {
        await supabase.from('notes').insert(newNotes)
      }

      // Insert new commands to DB
      if (newCommands.length > 0) {
        await supabase.from('commands').insert(newCommands)
      }

      if (roomSupportsTjaSource) {
        await supabase.from('rooms').update({ tja_text: normalizedTjaText }).eq('id', roomId)
      }

      // Close modal and reset input
      setShowImportModal(false)
      setImportTjaFileText('')
      setImportTjaFileName('')

      // Notify others
      if (channelRef.current) {
        await channelRef.current.send({
          type: 'broadcast',
          event: 'REFRESH_DATA',
          payload: { userId }
        })
      }

      console.log('TJA imported successfully')
    } catch (err) {
      console.error('TJA import failed:', err)
      alert('TJA インポートに失敗しました。ファイル形式を確認してください。')
    }
  }

  const handleImportTjaFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) {
      setImportTjaFileText('')
      setImportTjaFileName('')
      return
    }
    if (!file.name.toLowerCase().endsWith('.tja')) {
      alert('.tja ファイルを選択してください。')
      e.target.value = ''
      setImportTjaFileText('')
      setImportTjaFileName('')
      return
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      let text = ''

      // 1) UTF-8 (BOM and strict UTF-8)
      try {
        if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
          text = new TextDecoder('utf-8').decode(bytes.subarray(3))
        } else {
          text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        }
      } catch {
        // 2) Fallback: Shift-JIS
        text = new TextDecoder('shift_jis').decode(bytes)
      }

      setImportTjaFileText(text)
      setImportTjaFileName(file.name)
    } catch (err) {
      console.error('Failed to read .tja file:', err)
      alert('.tja ファイルの読み込みに失敗しました。')
      setImportTjaFileText('')
      setImportTjaFileName('')
    } finally {
      e.target.value = ''
    }
  }, [])

  // Monaco Editor mount handler
  const handleEditorMount: OnMount = useCallback((editor, monaco) => {
    if (!monacoInitializedRef.current) {
      monaco.languages.register({ id: TJA_LANGUAGE_ID })
      monaco.languages.setLanguageConfiguration(TJA_LANGUAGE_ID, tjaLanguageConfig)
      monaco.languages.setMonarchTokensProvider(TJA_LANGUAGE_ID, tjaTokensProvider)
      monaco.editor.defineTheme('tja-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: tjaThemeRules,
        colors: {
          'editor.background': '#0d0d0d',
          'editor.foreground': '#d4d4d4',
          'editorLineNumber.foreground': '#444',
          'editorCursor.foreground': '#ff9900',
          'editor.selectionBackground': '#ff990030',
        }
      })
      monacoInitializedRef.current = true
    }
    monaco.editor.setTheme('tja-dark')

    // Store editor instance for toolbar actions (copy/paste)
    editorRef.current = editor
    editorDisposablesRef.current.forEach(d => d?.dispose?.())
    editorDisposablesRef.current = []

    // Ctrl+S to save from editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      handleTjaSave()
    })
    editorDisposablesRef.current.push(
      editor.onDidChangeCursorPosition(() => syncEditorStatus()),
      editor.onDidChangeCursorSelection(() => syncEditorStatus()),
      editor.onDidChangeModelContent(() => syncEditorStatus()),
      editor.onDidFocusEditorWidget(() => syncEditorStatus())
    )
    syncEditorStatus()

  }, [handleTjaSave, syncEditorStatus])

  useEffect(() => {
    if (editorStatusTickRef.current !== null) {
      clearInterval(editorStatusTickRef.current)
      editorStatusTickRef.current = null
    }
    editorStatusTickRef.current = window.setInterval(() => {
      syncEditorStatus()
    }, 120)

    return () => {
      if (editorStatusTickRef.current !== null) {
        clearInterval(editorStatusTickRef.current)
        editorStatusTickRef.current = null
      }
      editorDisposablesRef.current.forEach(d => d?.dispose?.())
      editorDisposablesRef.current = []
    }
  }, [syncEditorStatus])


  return (
    <div className="flex flex-col w-full h-full bg-neutral-900 overflow-hidden">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-6 py-4 bg-neutral-800 border-b border-neutral-700 shadow-xl z-20">
        <div className="flex items-center gap-4">
          <button onClick={handleBackClick} className="p-2 hover:bg-neutral-700 rounded-xl transition-colors text-neutral-400 hover:text-white">
            <ArrowLeft className="w-6 h-6" />
          </button>
          <div>
            <h2 className="text-xl font-bold text-white flex items-center gap-2">
              {roomName || 'Loading...'}
              <span className="text-xs font-mono px-2 py-0.5 bg-orange-500/20 text-orange-400 rounded-full border border-orange-500/30">{roomId}</span>
            </h2>
          </div>
        </div>

        {/* Note Selector Toolbar */}
        <div className="flex items-center bg-neutral-900 p-1 rounded-2xl border border-neutral-700">
          {NOTE_TYPES.map((type) => (
            <button
              key={type.id}
              onClick={() => setSelectedType(type.id)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all flex flex-col items-center gap-1
                ${selectedType === type.id ? 'bg-orange-600 text-white shadow-lg shadow-orange-900/20' : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'}`}
            >
              <div className="w-3 h-3 rounded-full border border-black/20" style={{ backgroundColor: type.color, transform: `scale(${type.size})` }}></div>
              {type.id}: {type.label}
            </button>
          ))}
          <button
            onClick={() => setSelectedType('0')}
            className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${selectedType === '0' ? 'bg-red-600 text-white' : 'text-neutral-500 hover:text-neutral-300 hover:bg-neutral-800'}`}
          >
            0: 消しゴム
          </button>
        </div>

        <div className="flex items-center gap-3">
          <button onClick={() => setShowResetModal(true)} className="flex items-center gap-2 px-3 py-2 bg-red-900/30 hover:bg-red-600 text-red-200 hover:text-white rounded-xl transition-all text-sm font-semibold border border-red-500/30">
            <Trash2 className="w-4 h-4" /> 全消去
          </button>
        </div>
      </div>

      {/* Toolbar 2: Edit actions & Zoom */}
      <div className="flex items-center px-6 py-2 bg-neutral-800/80 border-b border-neutral-700/50 text-xs">
        <div className="flex items-center gap-2 mr-6 text-neutral-400">
          <button
            className={`p-1.5 rounded transition-all ${historyIndexState < 0 ? 'opacity-30 cursor-not-allowed' : 'hover:bg-neutral-700 hover:text-white'}`}
            title="Undo (Ctrl+Z)"
            disabled={historyIndexState < 0}
            onClick={() => { void performUndo() }}
          >
            <Undo className="w-4 h-4" />
          </button>
          <button
            className={`p-1.5 rounded transition-all ${historyIndexState >= historyLength - 1 ? 'opacity-30 cursor-not-allowed' : 'hover:bg-neutral-700 hover:text-white'}`}
            title="Redo (Ctrl+Y)"
            disabled={historyIndexState >= historyLength - 1}
            onClick={() => { void performRedo() }}
          >
            <Redo className="w-4 h-4" />
          </button>
          <button
            className="p-1.5 rounded transition-all hover:bg-neutral-700 hover:text-white"
            title="History"
            onClick={() => setShowHistoryModal(true)}
          >
            <HistoryIcon className="w-4 h-4" />
          </button>
          <div className="w-px h-4 bg-neutral-700 mx-2"></div>
          <button className="p-1.5 hover:bg-neutral-700 rounded hover:text-white" title="Copy (Ctrl+C)" onClick={() => {
            if (editorRef.current) editorRef.current.trigger('keyboard', 'editor.action.clipboardCopyAction', null)
            else {
              const e = new KeyboardEvent('keydown', { ctrlKey: true, key: 'c' }); window.dispatchEvent(e);
            }
          }}>
            <Copy className="w-4 h-4" />
          </button>
          <button className="p-1.5 hover:bg-neutral-700 rounded hover:text-white" title="Paste (Ctrl+V)" onClick={async () => {
            if (editorRef.current) {
              try {
                const text = await navigator.clipboard.readText()
                const editor = editorRef.current
                const selection = editor.getSelection()
                const { Range } = await import('monaco-editor')
                const range = new Range(selection.startLineNumber, selection.startColumn, selection.endLineNumber, selection.endColumn)
                editor.executeEdits('clipboard', [{ range, text, forceMoveMarkers: true }])
              } catch (err) {
                console.warn('Clipboard paste failed:', err)
              }
            } else {
              const e = new KeyboardEvent('keydown', { ctrlKey: true, key: 'v' }); window.dispatchEvent(e);
            }
          }}>
            <ClipboardPaste className="w-4 h-4" />
          </button>
        </div>

        {/* Grid Snap Controls */}
        <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-700 px-2 py-1 rounded-lg mr-4">
          <span className="text-neutral-500 font-bold ml-1">Grid:</span>
          <select
            value={snapDivisions}
            onChange={(e) => setSnapDivisions(Number(e.target.value))}
            className="bg-transparent text-orange-400 font-mono text-sm outline-none px-1"
          >
            {SNAP_OPTIONS.map(opt => (
              <option key={opt} value={opt} className="bg-neutral-800 text-white">1/{opt}</option>
            ))}
          </select>
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-2 bg-neutral-900 border border-neutral-700 px-2 py-1 rounded-lg">
          <button onClick={() => handleZoom('out')} className="hover:text-white text-neutral-400"><ZoomOut className="w-4 h-4" /></button>
          <div className="flex gap-1">
            <button onClick={() => setExactZoom(0.5)} className={`px-2 py-0.5 rounded ${zoom === 0.5 ? 'bg-orange-600 text-white' : 'hover:bg-neutral-800'}`}>x0.5</button>
            <button onClick={() => setExactZoom(1.0)} className={`px-2 py-0.5 rounded ${zoom === 1.0 ? 'bg-orange-600 text-white' : 'hover:bg-neutral-800'}`}>x1.0</button>
            <button onClick={() => setExactZoom(2.0)} className={`px-2 py-0.5 rounded ${zoom === 2.0 ? 'bg-orange-600 text-white' : 'hover:bg-neutral-800'}`}>x2.0</button>
            <button onClick={() => setExactZoom(4.0)} className={`px-2 py-0.5 rounded ${zoom === 4.0 ? 'bg-orange-600 text-white' : 'hover:bg-neutral-800'}`}>x4.0</button>
          </div>
          <button onClick={() => handleZoom('in')} className="hover:text-white text-neutral-400"><ZoomIn className="w-4 h-4" /></button>
          <span className="text-orange-400 font-mono w-12 text-right">x{zoom.toFixed(1)}</span>
        </div>

      </div>

      {/* Playback Controls & Upload */}
      <div className="flex items-center gap-4 bg-neutral-900 border border-neutral-700 px-4 py-2 mt-4 mx-4 rounded-xl shadow-lg shrink-0">
        <button
          onClick={togglePlayback}
          className={`flex items-center gap-2 px-6 py-2 rounded-lg font-bold transition-all shadow-md active:scale-95 ${isPlaying
            ? 'bg-red-500 hover:bg-red-400 text-white shadow-red-500/20'
            : 'bg-green-500 hover:bg-green-400 text-white shadow-green-500/20'
            }`}
        >
          {isPlaying ? <div className="w-4 h-4 rounded-sm bg-white" /> : <Play className="w-4 h-4 fill-current" />}
          {isPlaying ? 'STOP' : 'PLAY'}
        </button>

        <div className="h-6 w-px bg-neutral-700 mx-2" />

        <div className="flex items-center gap-4 text-sm w-full">
          <label className={`flex items-center gap-2 px-4 py-2 rounded-lg font-bold border border-neutral-700 transition-all ${audioUploading ? 'bg-neutral-800 text-neutral-500 cursor-not-allowed' : 'bg-neutral-800 hover:bg-neutral-700 text-white cursor-pointer hover:border-orange-500'
            }`}>
            <Info className="w-4 h-4" />
            {audioUploading ? 'Uploading...' : (audioUrl ? 'Replace Audio' : 'Upload Audio')}
            <input
              type="file"
              accept=".ogg"
              className="hidden"
              disabled={audioUploading}
              onChange={handleAudioUpload}
            />
          </label>
          <span className="text-neutral-500 truncate text-xs flex-1">
            {audioUrl ? audioUrl.split('/').pop() : 'No audio loaded'}
          </span>
          {audioUrl && (
            <button
              onClick={handleDeleteAudio}
              className="px-2 py-1 bg-red-900/30 hover:bg-red-600 text-red-200 hover:text-white rounded-lg transition-all text-xs border border-red-500/30"
              title="Delete Audio"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Editor Main Content Area */}
      <div
        ref={containerRef}
        className="flex-1 overflow-x-auto overflow-y-hidden bg-[#111] relative isolate custom-scrollbar"
        onContextMenu={e => e.preventDefault()}
      >
        {/* Spacer to define the total scrollable width */}
        <div style={{ width: `${CANVAS_WIDTH + 32}px`, height: '1px' }} />

        <div className="sticky left-0 h-full flex flex-col px-4 pt-4" style={{ width: '100%' }}>
          <div className="relative shadow-[0_0_50px_rgba(0,0,0,0.5)] bg-neutral-900 rounded-lg overflow-hidden border border-neutral-800">
            <canvas
              ref={canvasRef}
              height={HEADER_HEIGHT + LANE_HEIGHT}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onContextMenu={handleContextMenu}
              className="cursor-crosshair block w-full"
              style={{ height: `${HEADER_HEIGHT + LANE_HEIGHT}px` }}
            />
            {isPlaying && (
              <div className="pointer-events-none absolute inset-y-0 left-1/2 -translate-x-1/2 z-20">
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-t-[10px] border-t-green-500" />
                <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-green-500" />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Metadata + TJA Source Editor Area */}
      <div className="bg-neutral-800 border-t border-neutral-700 overflow-hidden flex-1">
        <div className="h-full flex">
          {/* Left: Metadata Fields */}
          <div className="w-1/3 p-6 overflow-y-auto border-r border-neutral-700">
            <div className="flex items-center gap-2 mb-4">
              <Settings className="w-4 h-4 text-orange-500" />
              <h3 className="text-sm font-bold text-white tracking-tight uppercase">Chart Metadata</h3>
            </div>
            <div className="space-y-3">
              <div className="group">
                <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">Title</label>
                <input
                  type="text"
                  value={metadata.title}
                  onChange={(e) => handleMetadataChange('title', e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all placeholder:text-neutral-700"
                  placeholder="Enter song title..."
                />
              </div>
              <div className="group">
                <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">Subtitle</label>
                <input
                  type="text"
                  value={metadata.subtitle}
                  onChange={(e) => handleMetadataChange('subtitle', e.target.value)}
                  className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all placeholder:text-neutral-700"
                  placeholder="Enter subtitle..."
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="group">
                  <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">Difficulty</label>
                  <select
                    value={metadata.difficulty}
                    onChange={(e) => handleMetadataChange('difficulty', e.target.value)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all appearance-none cursor-pointer"
                  >
                    <option value="Easy">かんたん (Easy)</option>
                    <option value="Normal">ふつう (Normal)</option>
                    <option value="Hard">むずかしい (Hard)</option>
                    <option value="Oni">おに (Oni)</option>
                    <option value="Edit">エディット (Edit)</option>
                  </select>
                </div>
                <div className="group">
                  <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">Level</label>
                  <input
                    type="number"
                    min="1"
                    max="10"
                    value={metadata.level}
                    onChange={(e) => handleMetadataChange('level', parseInt(e.target.value) || 0)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="group">
                  <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">SEVOL</label>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    inputMode="numeric"
                    value={metadata.sevol}
                    onChange={(e) => handleMetadataChange('sevol', parseFloat(e.target.value) || 0)}
                    onBlur={() => saveMetadataNow(stateRef.current.metadata)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all"
                  />
                </div>
                <div className="group">
                  <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">SONGVOL</label>
                  <input
                    type="number"
                    min="0"
                    max="1000"
                    step="1"
                    inputMode="numeric"
                    value={metadata.songvol}
                    onChange={(e) => handleMetadataChange('songvol', parseFloat(e.target.value) || 0)}
                    onBlur={() => saveMetadataNow(stateRef.current.metadata)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all"
                  />
                </div>
              </div>
              <div className="group">
                <label className="block text-[10px] font-bold text-neutral-500 uppercase tracking-widest mb-1 group-hover:text-orange-400 transition-colors">Audio Offset (seconds)</label>
                <div className="relative">
                  <input
                    type="number"
                    step="0.001"
                    value={metadata.offset}
                    onChange={(e) => handleMetadataChange('offset', parseFloat(e.target.value) || 0)}
                    className="w-full bg-neutral-900 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-white focus:border-orange-500 outline-none transition-all"
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2 text-neutral-600 font-bold text-[10px] uppercase tracking-widest pointer-events-none">sec</div>
                </div>
              </div>
            </div>
          </div>

          {/* Right: TJA Source Text Editor */}
          <div className="w-2/3 flex flex-col">
            <div className="flex items-center gap-2 px-4 py-3 border-b border-neutral-700 shrink-0">
              <FileText className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-bold text-white tracking-tight uppercase">TJA Source</h3>
              <span className="text-[10px] text-neutral-400 bg-neutral-900 px-2 py-0.5 rounded border border-neutral-700">
                Line {editorStatus.line}
              </span>
              <span className="text-[10px] text-neutral-400 bg-neutral-900 px-2 py-0.5 rounded border border-neutral-700">
                Ln {editorStatus.line}, Col {editorStatus.column}
              </span>
              <span className="text-[10px] text-neutral-400 bg-neutral-900 px-2 py-0.5 rounded border border-neutral-700">
                {editorStatus.totalLines} lines / {editorStatus.totalChars} chars
              </span>
              {tjaDirty && <span className="text-[10px] text-yellow-400 bg-yellow-500/10 px-2 py-0.5 rounded border border-yellow-500/30 animate-pulse">未保存</span>}
              <button
                onClick={handleTjaSave}
                disabled={!tjaDirty}
                className={`ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${tjaDirty
                  ? 'bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-500/20 active:scale-95'
                  : 'bg-neutral-700 text-neutral-500 cursor-not-allowed'
                  }`}
              >
                <Save className="w-3.5 h-3.5" />
                Save (Ctrl+S)
              </button>
              <button
                onClick={() => setShowExportDeleteModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 active:scale-95 ml-2"
              >
                <Download className="w-3.5 h-3.5" />
                Export
              </button>
              <button
                onClick={() => setShowImportModal(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-all bg-green-600 hover:bg-green-500 text-white shadow-lg shadow-green-500/20 active:scale-95 ml-2"
              >
                <Copy className="w-3.5 h-3.5" />
                Import
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <MonacoEditor
                language={TJA_LANGUAGE_ID}
                value={tjaText}
                onChange={handleTjaTextChange}
                onMount={handleEditorMount}
                options={{
                  minimap: { enabled: false },
                  fontSize: 13,
                  lineNumbers: 'on',
                  scrollBeyondLastLine: false,
                  wordWrap: 'off',
                  renderWhitespace: 'none',
                  fontFamily: "'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace",
                  fontLigatures: true,
                  padding: { top: 8 },
                  lineHeight: 22,
                  glyphMargin: false,
                  folding: false,
                  contextmenu: true,
                  automaticLayout: true,
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Presence Notifications */}
      <div className="fixed top-4 right-4 z-[140] flex flex-col gap-2 pointer-events-none">
        {presenceNotices.map(notice => (
          <div
            key={notice.id}
            className="px-3 py-2 rounded-lg border text-xs font-semibold shadow-xl backdrop-blur bg-neutral-900/90 text-white"
            style={{ borderColor: notice.color }}
          >
            <span className="inline-block w-2 h-2 rounded-full mr-2 align-middle" style={{ backgroundColor: notice.color }} />
            <span className="align-middle">{notice.message}</span>
          </div>
        ))}
      </div>

      {/* Bottom Status Bar */}
      <div className="bg-neutral-800 border-t border-neutral-700 px-6 py-2 flex items-center justify-between text-xs text-neutral-500 z-10 shrink-0">
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-1.5"><Users className="w-3 h-3 text-green-500" /> Realtime Active</span>
          <span className="bg-neutral-900 px-2 py-1 rounded border border-neutral-700 font-mono">
            Hover: M{hoverGridObj.measure.toString().padStart(3, '0')} P{hoverGridObj.pos.toString().padStart(2, '0')}
          </span>
          <span className="bg-neutral-900 px-2 py-1 rounded border border-neutral-700 font-mono">
            Seek: {(seekPos).toFixed(2)}
          </span>
          <div className="flex items-center gap-1 bg-neutral-900 px-2 py-1 rounded border border-neutral-700">
            <span className="text-neutral-400">Jump M</span>
            <input
              type="number"
              value={measureJumpInput}
              onChange={(e) => setMeasureJumpInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleMeasureJump()
              }}
              className="w-16 bg-neutral-950 border border-neutral-700 rounded px-1.5 py-0.5 text-[11px] text-white font-mono outline-none focus:border-orange-500"
            />
            <button
              onClick={handleMeasureJump}
              className="px-2 py-0.5 rounded bg-orange-600 hover:bg-orange-500 text-white text-[11px] font-semibold"
            >
              Go
            </button>
          </div>
          {remoteUsers.length > 0 && (
            <div className="flex items-center gap-2">
              {remoteUsers.map(u => (
                <span key={u.userId} className="bg-neutral-900 px-2 py-1 rounded border border-neutral-700 font-mono text-[11px]">
                  <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ backgroundColor: u.userColor }} />
                  <span className="align-middle text-neutral-300">{u.userName}</span>
                  <span className="align-middle text-neutral-500 ml-1">({u.seekPos.toFixed(2)})</span>
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="flex items-center gap-4">
          <span className="flex items-center gap-1.5 text-orange-400/80"><Play className="w-3 h-3" /> Seekbar: Click/Drag timeline header to move</span>
        </div>
      </div>
      {/* Added some global scrollbar styles just for this view */}
      <style>{`
  .custom-scrollbar::-webkit-scrollbar { height: 12px; }
  .custom-scrollbar::-webkit-scrollbar-track { background: #1a1a1a; border-radius: 6px; }
  .custom-scrollbar::-webkit-scrollbar-thumb { background: #333; border-radius: 6px; border: 2px solid #1a1a1a; }
  .custom-scrollbar::-webkit-scrollbar-thumb:hover { background: #555; }
`}</style>

      {/* Context Menu for Commands */}
      {contextMenu && (
        <>
          <div className="fixed inset-0 z-[110]" onClick={() => setContextMenu(null)} />
          <div
            className="fixed z-[120] bg-neutral-800 border border-neutral-700 rounded-lg shadow-2xl py-1 w-40 animate-in fade-in zoom-in-95 duration-100"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <div className="px-3 py-1.5 text-[10px] font-bold text-neutral-500 uppercase tracking-tighter border-b border-neutral-700/50 mb-1">
              Add Command
            </div>
            <button onClick={() => handleCommandSelect('BPM')} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-green-500/20 hover:text-green-400 flex items-center gap-2 transition-colors">
              <div className="w-1.5 h-1.5 rounded-full bg-green-500" /> BPM Key
            </button>
            <button onClick={() => handleCommandSelect('HS')} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-cyan-500/20 hover:text-cyan-400 flex items-center gap-2 transition-colors">
              <div className="w-1.5 h-1.5 rounded-full bg-cyan-500" /> HS Key
            </button>
            <button onClick={() => handleCommandSelect('MEASURE')} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-yellow-500/20 hover:text-yellow-400 flex items-center gap-2 transition-colors border-t border-neutral-700/30 mt-1">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-500" /> MEASURE Key
            </button>
            <button onClick={() => handleCommandSelect('GOGOSTART')} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-orange-500/20 hover:text-orange-400 flex items-center gap-2 transition-colors">
              <div className="w-1.5 h-1.5 rounded-full bg-orange-500" /> GOGOSTART
            </button>
            <button onClick={() => handleCommandSelect('GOGOEND')} className="w-full text-left px-3 py-2 text-xs text-neutral-300 hover:bg-orange-500/20 hover:text-orange-400 flex items-center gap-2 transition-colors">
              <div className="w-1.5 h-1.5 rounded-full bg-orange-500" /> GOGOEND
            </button>

            {/* Check for existing commands at this spot to delete */}
            {commands.filter(c => c.measure === contextMenu.measure && c.position === contextMenu.pos).map(c => (
              <button
                key={c.id}
                onClick={() => { deleteCommand(c.id); setContextMenu(null); }}
                className="w-full text-left px-3 py-2 text-xs text-red-400 hover:bg-red-500/20 flex items-center gap-2 border-t border-neutral-700/50 mt-1"
              >
                <Trash2 className="w-3 h-3" /> Delete {c.type}
              </button>
            ))}
          </div>
        </>
      )}

      {/* Command Value Modal */}
      {commandModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-xs shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${commandModal.type === 'BPM' ? 'bg-green-500' : 'bg-cyan-500'}`} />
              Set {commandModal.type} Value
            </h3>
            <p className="text-xs text-neutral-500 mb-6">Enter the value for this command.</p>

            <input
              autoFocus
              type="text"
              value={commandValue}
              onChange={e => setCommandValue(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleCommandConfirm()
              }}
              className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-xl font-mono text-orange-400 outline-none focus:border-orange-500 transition-colors mb-6 shadow-inner"
              placeholder={commandModal.type === 'BPM' ? '120' : '1.0'}
            />

            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => setCommandModal(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleCommandConfirm}
                className="px-6 py-2 rounded-lg text-sm font-semibold bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-500/20 transition-all active:scale-95"
              >
                Set Key
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Confirmation Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-4 mb-4 text-red-500">
              <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center border border-red-500/20">
                <AlertTriangle className="w-6 h-6" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">音符をすべて消去しますか？</h3>
                <p className="text-sm text-neutral-400">この操作は取り消せません。</p>
              </div>
            </div>
            <div className="flex items-center gap-3 justify-end mt-8">
              <button
                onClick={() => setShowResetModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                キャンセル
              </button>
              <button
                onClick={handleReset}
                className="px-6 py-2 rounded-lg text-sm font-semibold bg-red-500 hover:bg-red-600 text-white shadow-lg shadow-red-500/20 transition-all active:scale-95"
              >
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Attribute Input Modal (Balloon Hits) */}
      {attributeModal && (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-xs shadow-2xl animate-in zoom-in-95 duration-200">
            <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-yellow-400" />
              Set Balloon Hits
            </h3>
            <p className="text-xs text-neutral-500 mb-6">Enter the required number of hits.</p>

            <div className="relative mb-6">
              <input
                autoFocus
                type="number"
                value={attributeModal.hits}
                onChange={e => setAttributeModal({ ...attributeModal, hits: e.target.value })}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    saveAttribute(attributeModal.noteId, parseInt(attributeModal.hits))
                    setAttributeModal(null)
                  }
                }}
                className="w-full bg-neutral-950 border border-neutral-700 rounded-xl px-4 py-3 text-xl font-mono text-orange-400 outline-none focus:border-orange-500 transition-colors shadow-inner text-center"
              />
              <div className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-600 font-bold text-xs uppercase tracking-widest">Hits</div>
            </div>

            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => setAttributeModal(null)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  saveAttribute(attributeModal.noteId, parseInt(attributeModal.hits))
                  setAttributeModal(null)
                }}
                className="px-6 py-2 rounded-lg text-sm font-semibold bg-orange-600 hover:bg-orange-500 text-white shadow-lg shadow-orange-500/20 transition-all active:scale-95"
              >
                Set Hits
              </button>
            </div>
          </div>
        </div>
      )}

      {/* History Modal */}
      {showHistoryModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-xl shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-orange-500/10 border border-orange-500/20 flex items-center justify-center">
                <HistoryIcon className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">History Timeline</h3>
                <p className="text-xs text-neutral-400">Select an entry to jump to that edit state</p>
              </div>
            </div>

            <div className="max-h-72 overflow-y-auto border border-neutral-800 rounded-lg divide-y divide-neutral-800 bg-neutral-950/60 mb-4">
              {historyRef.current.length === 0 && (
                <div className="px-4 py-6 text-sm text-neutral-500 text-center">No history entries yet</div>
              )}
              {[...historyRef.current].map((entry, idx) => {
                const isCurrent = idx === historyIndexState
                return (
                  <button
                    key={`${entry.createdAt}-${idx}`}
                    onClick={() => { void jumpHistoryToIndex(idx) }}
                    disabled={isHistoryJumping}
                    className={`w-full text-left px-4 py-2.5 text-sm transition-colors ${isCurrent ? 'bg-orange-500/15 text-orange-200' : 'hover:bg-neutral-800 text-neutral-300'}`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-semibold">{entry.label}</span>
                      <span className="text-[11px] text-neutral-500">{new Date(entry.createdAt).toLocaleTimeString()}</span>
                    </div>
                    <div className="text-[11px] text-neutral-500 mt-0.5">
                      #{(idx + 1).toString().padStart(2, '0')} {isCurrent ? 'Current' : ''}
                    </div>
                  </button>
                )
              })}
            </div>

            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setShowHistoryModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Export TJA Modal */}
      {showExportDeleteModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-sm shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                <Download className="w-5 h-5 text-blue-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Export TJA File</h3>
                <p className="text-xs text-neutral-400">Save chart as .tja file</p>
              </div>
            </div>

            <div className="mb-6 p-4 rounded-lg bg-neutral-800/50 border border-neutral-700">
              <label className="flex items-center gap-3 cursor-pointer group">
                <input
                  type="checkbox"
                  checked={deleteAfterExport}
                  onChange={e => setDeleteAfterExport(e.target.checked)}
                  className="w-4 h-4 rounded border-neutral-600 bg-neutral-700 accent-red-500"
                />
                <span className="text-sm text-neutral-300 group-hover:text-white transition-colors">
                  Delete chart data after export
                </span>
              </label>
              <p className="text-[11px] text-neutral-500 mt-2 ml-7">
                This will permanently remove all notes and commands from the database.
              </p>
            </div>

            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => setShowExportDeleteModal(false)}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  handleExportTja()
                  setShowExportDeleteModal(false)
                }}
                className="px-6 py-2 rounded-lg text-sm font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-500/20 transition-all active:scale-95 flex items-center gap-2"
              >
                <Download className="w-4 h-4" />
                Export
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Import TJA Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="bg-neutral-900 border border-neutral-800 rounded-2xl p-6 w-full max-w-md shadow-2xl animate-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg bg-green-500/10 border border-green-500/20 flex items-center justify-center">
                <Copy className="w-5 h-5 text-green-400" />
              </div>
              <div>
                <h3 className="text-lg font-bold text-white">Import TJA</h3>
                <p className="text-xs text-neutral-400">Upload a .tja file to import</p>
              </div>
            </div>

            <label className="mb-4 flex h-32 w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed border-neutral-600 bg-neutral-950 px-3 py-2 text-center transition-all hover:border-green-500">
              <input
                type="file"
                accept=".tja,text/plain"
                className="hidden"
                onChange={handleImportTjaFileChange}
              />
              <span className="text-sm font-semibold text-neutral-200">Select `.tja` file</span>
              <span className="mt-1 text-xs text-neutral-500">Drag & drop is also supported by your browser</span>
              <span className="mt-3 max-w-full truncate text-xs text-green-400">
                {importTjaFileName || 'No file selected'}
              </span>
            </label>

            <div className="flex items-center gap-3 justify-end">
              <button
                onClick={() => {
                  setShowImportModal(false)
                  setImportTjaFileText('')
                  setImportTjaFileName('')
                }}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleImportTja}
                disabled={!importTjaFileText.trim()}
                className="px-6 py-2 rounded-lg text-sm font-semibold bg-green-600 hover:bg-green-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white shadow-lg shadow-green-500/20 transition-all active:scale-95 flex items-center gap-2"
              >
                <Copy className="w-4 h-4" />
                Import
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

