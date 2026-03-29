/**
 * TJA Format Bidirectional Converter (Enhanced Robust Version)
 */

const GRID_DIVISIONS = 96

export interface TjaNote {
  measure: number
  position: number
  type: string
  attributes?: any
}

export interface TjaCommand {
  measure: number
  position: number
  type: 'BPM' | 'HS' | 'MEASURE' | 'GOGOSTART' | 'GOGOEND'
  value: string | null
}

export interface TjaMetadata {
  title: string
  subtitle: string
  offset: number
  difficulty: string
  level: number
  sevol: number
  songvol: number
  bpm?: number
  balloon?: number[]
  audio_url?: string | null
}

export interface TjaParseResult {
  metadata: TjaMetadata
  commands: TjaCommand[]
  notes: TjaNote[]
}

const DIFFICULTY_MAP: Record<string, string> = {
  Easy: '0', Normal: '1', Hard: '2', Oni: '3', Edit: '4',
}

const DIFFICULTY_NAMES: Record<string, string> = {
  '0': 'Easy', '1': 'Normal', '2': 'Hard', '3': 'Oni', '4': 'Edit',
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

const CMD_ORDER: Record<TjaCommand['type'], number> = {
  MEASURE: 0, BPM: 1, HS: 2, GOGOSTART: 3, GOGOEND: 4,
}

function sortCmd(a: TjaCommand, b: TjaCommand) {
  return (a.position - b.position) || (CMD_ORDER[a.type] - CMD_ORDER[b.type])
}

function commandToTja(cmd: TjaCommand): string {
  switch (cmd.type) {
    case 'BPM': return `#BPMCHANGE ${cmd.value}`
    case 'HS': return `#SCROLL ${cmd.value}`
    case 'MEASURE': return `#MEASURE ${cmd.value}`
    case 'GOGOSTART': return '#GOGOSTART'
    case 'GOGOEND': return '#GOGOEND'
  }
}

function normalizeCommandValue(type: TjaCommand['type'], value: string | null): string | null {
  if (value == null) return value
  if (type === 'BPM' || type === 'HS') {
    const num = parseFloat(value)
    if (Number.isNaN(num)) return value
    return String(Math.abs(num))
  }
  if (type === 'MEASURE') {
    const m = value.match(/^\s*(-?\d+(?:\.\d+)?)\s*\/\s*(-?\d+(?:\.\d+)?)\s*$/)
    if (!m) return value
    const n = Math.abs(parseFloat(m[1]))
    const d = Math.abs(parseFloat(m[2]))
    return `${n}/${d}`
  }
  return value
}

// GUI -> TJA
export function guiToTja(metadata: TjaMetadata, commands: TjaCommand[], notes: TjaNote[]): string {
  const lines: string[] = []
  const noteMap = new Map<number, Map<number, TjaNote>>()
  for (const n of notes) {
    if (!noteMap.has(n.measure)) noteMap.set(n.measure, new Map())
    noteMap.get(n.measure)!.set(n.position, n)
  }

  const cmdMap = new Map<number, TjaCommand[]>()
  for (const c of commands) {
    if (!cmdMap.has(c.measure)) cmdMap.set(c.measure, [])
    cmdMap.get(c.measure)!.push(c)
  }

  const maxMeasure = Math.max(0, ...notes.map(n => n.measure), ...commands.map(c => c.measure))

  lines.push(`TITLE:${metadata.title}`)
  if (metadata.subtitle) lines.push(`SUBTITLE:--${metadata.subtitle}`)

  const firstBpm = (cmdMap.get(0) || []).filter(c => c.type === 'BPM' && c.position === 0).sort(sortCmd)[0]
  const initialBpm = firstBpm?.value || String(metadata.bpm || 120)

  lines.push(`BPM:${initialBpm}`)
  lines.push(`OFFSET:${metadata.offset || 0}`)
  lines.push(`SEVOL:${metadata.sevol ?? 100}`)
  lines.push(`SONGVOL:${metadata.songvol ?? 100}`)
  lines.push(`COURSE:${DIFFICULTY_MAP[metadata.difficulty] || '3'}`)
  lines.push(`LEVEL:${metadata.level || 1}`)

  const balloons = notes.filter(n => n.type === '7' || n.type === '9').sort((a, b) => a.measure - b.measure || a.position - b.position)
  if (balloons.length) lines.push(`BALLOON:${balloons.map(n => n.attributes?.hits ?? 5).join(',')}`)

  lines.push('', '#START')

  for (let m = 0; m <= maxMeasure; m++) {
    const notesM = noteMap.get(m) || new Map()
    const cmdsM = (cmdMap.get(m) || []).slice().sort(sortCmd)

    for (const cmd of cmdsM.filter(c => c.position === 0)) {
      if (!(m === 0 && cmd.type === 'BPM' && cmd.value === initialBpm)) {
        lines.push(commandToTja(cmd))
      }
    }

    const allPos = new Set<number>()
    notesM.forEach((_, p) => allPos.add(p))
    cmdsM.forEach(c => { if (c.position > 0) allPos.add(c.position) })

    if (allPos.size === 0) {
      lines.push('0,')
      continue
    }

    let g = GRID_DIVISIONS
    allPos.forEach(p => { g = gcd(g, p) })
    const subdivisions = GRID_DIVISIONS / g

    const boundaries = new Set<number>([0, subdivisions])
    cmdsM.forEach(c => { if (c.position > 0) boundaries.add(c.position / g) })
    const sortedBoundaries = [...boundaries].sort((a, b) => a - b)

    for (let i = 0; i < sortedBoundaries.length - 1; i++) {
      const start = sortedBoundaries[i], end = sortedBoundaries[i + 1]
      const realPos = start * g
      if (realPos > 0) {
        cmdsM.filter(c => c.position === realPos).forEach(c => lines.push(commandToTja(c)))
      }
      const chars: string[] = []
      for (let j = start; j < end; j++) {
        const note = notesM.get(j * g)
        chars.push(note ? note.type : '0')
      }
      lines.push(chars.join('') + (end === subdivisions ? ',' : ''))
    }
  }

  lines.push('#END', '')
  return lines.join('\n')
}

// TJA -> GUI
export function tjaToGui(tjaText: string): TjaParseResult {
  const metadata: TjaMetadata = {
    title: '',
    subtitle: '',
    offset: 0,
    difficulty: 'Oni',
    level: 10,
    sevol: 100,
    songvol: 100,
    bpm: 120,
    balloon: [],
    audio_url: null
  }
  const commands: TjaCommand[] = [], notes: TjaNote[] = []
  let inChart = false, measure = 0, balloonIdx = 0
  let measureBuffer = '', commandBuffer: { line: string, index: number }[] = []

  const lines = tjaText.split('\n')
  for (const raw of lines) {
    let line = raw.trim()
    if (!line || line.startsWith('//')) continue

    if (!inChart) {
      if (line === '#START') { inChart = true; continue }
      const colonIdx = line.indexOf(':')
      if (colonIdx > 0) {
        const key = line.slice(0, colonIdx).toUpperCase(), val = line.slice(colonIdx + 1).trim()
        switch (key) {
          case 'TITLE': metadata.title = val; break
          case 'SUBTITLE': metadata.subtitle = val.replace(/^--/, ''); break
          case 'BPM': {
            const bpm = Math.abs(parseFloat(val))
            const bpmValue = Number.isNaN(bpm) ? '120' : String(bpm)
            metadata.bpm = Number.isNaN(bpm) ? 120 : bpm
            commands.push({ measure: 0, position: 0, type: 'BPM', value: bpmValue })
            break
          }
          case 'OFFSET': metadata.offset = parseFloat(val) || 0; break
          case 'SEVOL': {
            const parsed = parseFloat(val)
            metadata.sevol = Number.isNaN(parsed) ? 100 : parsed
            break
          }
          case 'SONGVOL': {
            const parsed = parseFloat(val)
            metadata.songvol = Number.isNaN(parsed) ? 100 : parsed
            break
          }
          case 'COURSE': metadata.difficulty = DIFFICULTY_NAMES[val] || 'Oni'; break
          case 'LEVEL': metadata.level = parseInt(val) || 1; break
          case 'BALLOON': metadata.balloon = val.split(',').map(v => parseInt(v)); break
        }
      }
      continue
    }

    if (line === '#END') break

    let i = 0
    while (i < line.length) {
      const char = line[i]
      if (char === '/' && line[i + 1] === '/') break // Skip mid-line comments
      
      if (char === '#') {
        const remaining = line.slice(i)
        const match = remaining.match(/^#([A-Z]+)(\s+[^\s,]+)?/)
        if (match) {
          commandBuffer.push({ line: match[0], index: measureBuffer.length })
          i += match[0].length
          continue
        }
      } else if (char === ',') {
        const len = measureBuffer.length || 1
        for (let j = 0; j < measureBuffer.length; j++) {
          const type = measureBuffer[j]
          if (type !== '0') {
            let pos = Math.round((j / len) * GRID_DIVISIONS), m = measure
            while (pos >= GRID_DIVISIONS) { m++; pos -= GRID_DIVISIONS }
            const note: TjaNote = { measure: m, position: pos, type }
            if ((type === '7' || type === '9') && metadata.balloon?.[balloonIdx] != null) note.attributes = { hits: metadata.balloon[balloonIdx++] }
            notes.push(note)
          }
        }
        for (const cmd of commandBuffer) {
          let pos = Math.round((cmd.index / len) * GRID_DIVISIONS), m = measure
          while (pos >= GRID_DIVISIONS) { m++; pos -= GRID_DIVISIONS }
          const [name, ...valParts] = cmd.line.split(/\s+/)
          const val = valParts.join(' ') || null
          const typeMap: Record<string, TjaCommand['type']> = { '#BPMCHANGE': 'BPM', '#SCROLL': 'HS', '#MEASURE': 'MEASURE', '#GOGOSTART': 'GOGOSTART', '#GOGOEND': 'GOGOEND' }
          const mappedType = typeMap[name.toUpperCase()]
          if (mappedType) commands.push({ measure: m, position: pos, type: mappedType, value: normalizeCommandValue(mappedType, val) })
        }
        measure++
        measureBuffer = ''
        commandBuffer = []
      } else if (!/\s/.test(char)) {
        measureBuffer += char
      }
      i++
    }
  }
  return { metadata, commands, notes }
}
