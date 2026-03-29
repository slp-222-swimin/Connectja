export interface AudioEngineOptions {
  bpm: number
  offset: number
  measureOffsets: number[] // start time in seconds for each measure
}

class AudioEngine {
  public ctx: AudioContext | null = null
  public audioBuffer: AudioBuffer | null = null
  private source: AudioBufferSourceNode | null = null
  private activeSESources = new Set<AudioBufferSourceNode>()
  private songGain: GainNode | null = null
  private seGain: GainNode | null = null
  private seCompressor: DynamicsCompressorNode | null = null
  private seBaseVolume = 1

  // Sound Effects
  public donBuffer: AudioBuffer | null = null
  public kaBuffer: AudioBuffer | null = null

  // Playback state
  public isPlaying = false
  public startTime = 0 // AudioContext time when play started
  public startSeekPos = 0 // Seek position in seconds when play started

  // Scheduler state
  private schedulerTimer: number | null = null
  private nextScheduleTime = 0
  private scheduledNotes = new Set<string>() // prevent double scheduling
  private lookahead = 0.5 // Schedule 500ms ahead
  private scheduleInterval = 50 // ms
  private scheduleBacklook = 0.03 // also catch notes slightly behind current time (start-edge safety)

  constructor() {
    this.initContext()
  }

  private initContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    if (this.ctx && (!this.songGain || !this.seGain || !this.seCompressor)) {
      this.songGain = this.ctx.createGain()
      this.seGain = this.ctx.createGain()
      this.seCompressor = this.ctx.createDynamicsCompressor()
      // Keep SE peaks under control when many hits overlap.
      this.seCompressor.threshold.value = -14
      this.seCompressor.knee.value = 10
      this.seCompressor.ratio.value = 3.5
      this.seCompressor.attack.value = 0.008
      this.seCompressor.release.value = 0.06
      this.songGain.connect(this.ctx.destination)
      this.seGain.connect(this.seCompressor)
      this.seCompressor.connect(this.ctx.destination)
    }
  }

  public setVolumes(songVolume: number, seVolume: number) {
    this.initContext()
    const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1))
    const song = clamp(songVolume)
    const se = clamp(seVolume)
    if (this.songGain) this.songGain.gain.value = song
    this.seBaseVolume = se
    if (this.seGain) this.seGain.gain.value = se
  }

  public async loadAudio(url: string) {
    this.initContext()
    if (!this.ctx) return
    const res = await fetch(url, { cache: 'no-store' })
    const arrayBuffer = await res.arrayBuffer()
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer)
  }

  public async loadSEs() {
    this.initContext()
    if (!this.ctx) return
    try {
      const seBaseUrl = import.meta.env.BASE_URL || '/'
      const [donRes, kaRes] = await Promise.all([
        fetch(`${seBaseUrl}snd/don.mp3`),
        fetch(`${seBaseUrl}snd/ka.mp3`)
      ])
      
      if (!donRes.ok || !kaRes.ok) {
        console.warn(`Failed to fetch SE files: don:${donRes.status} ka:${kaRes.status}. Audio may be silent.`)
        return
      }

      const donArray = await donRes.arrayBuffer()
      const kaArray = await kaRes.arrayBuffer()
      
      // Attempt to decode, but catch individual errors
      try {
        this.donBuffer = await this.ctx.decodeAudioData(donArray)
      } catch (e) {
        console.error('Error decoding don.mp3. Check if the file is a valid MP3.', e)
      }
      
      try {
        this.kaBuffer = await this.ctx.decodeAudioData(kaArray)
      } catch (e) {
        console.error('Error decoding ka.mp3. Check if the file is a valid MP3.', e)
      }
      
    } catch (e) {
      console.error('Failed to load or decode SEs:', e)
    }
  }

  public play(startSeconds: number, onEnded?: () => void) {
    this.initContext()
    if (!this.ctx) return
    
    if (this.ctx.state === 'suspended') {
      this.ctx.resume()
    }

    this.stop() // Ensure clean state

    const ctx = this.ctx!
    this.startTime = ctx.currentTime
    
    // Use startSeconds for timing calculations even if negative
    this.startSeekPos = startSeconds

    if (this.audioBuffer) {
      this.source = this.ctx.createBufferSource()
      this.source.buffer = this.audioBuffer
      this.source.connect(this.songGain || this.ctx.destination)

      const safeStartSeconds = Math.max(0, startSeconds)
      const delayInSeconds = startSeconds < 0 ? Math.abs(startSeconds) : 0

      // If the requested time is beyond the buffer duration, don't start playing
      if (safeStartSeconds >= this.audioBuffer.duration) {
        if (onEnded) onEnded()
        return
      }

      this.source.start(this.ctx.currentTime + delayInSeconds, safeStartSeconds)
      
      this.source.onended = () => {
        if (this.isPlaying) {
          this.isPlaying = false
          if (onEnded) onEnded()
          this.stopScheduler()
        }
      }
    }

    this.isPlaying = true
  }

  public stop() {
    this.isPlaying = false
    this.stopScheduler()
    if (this.source) {
      try {
        this.source.stop()
      } catch (e) {
        // Ignore if already stopped
      }
      this.source.disconnect()
      this.source = null
    }
    this.stopAllSEs()
  }

  public getCurrentTime(): number {
    if (!this.isPlaying || !this.ctx) return this.startSeekPos
    const ctx = this.ctx!
    return this.startSeekPos + (ctx.currentTime - this.startTime)
  }

  public playSE(type: 'don' | 'ka', time?: number) {
    if (!this.ctx) return
    const buffer = type === 'don' ? this.donBuffer : this.kaBuffer
    if (!buffer) return

    const ctx = this.ctx!
    // Simple polyphony cap to avoid pathological overload.
    if (this.activeSESources.size >= 48) return
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.seGain || ctx.destination)
    this.activeSESources.add(source)
    const activeCount = this.activeSESources.size
    if (this.seGain) {
      // Gradually attenuate as simultaneous SE count rises.
      const attenuation = 1 / Math.max(1, Math.pow(activeCount, 0.35))
      const targetGain = Math.max(0.4, this.seBaseVolume * attenuation)
      this.seGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.01)
    }

    const cleanup = () => {
      if (this.activeSESources.has(source)) {
        this.activeSESources.delete(source)
      }
      if (this.seGain) {
        const afterCount = this.activeSESources.size
        const attenuation = 1 / Math.max(1, Math.pow(Math.max(1, afterCount), 0.35))
        const targetGain = Math.max(0.4, this.seBaseVolume * attenuation)
        this.seGain.gain.setTargetAtTime(targetGain, ctx.currentTime, 0.025)
      }
      try {
        source.disconnect()
      } catch (e) {
        // Ignore disconnect races after stop()
      }
    }

    source.onended = cleanup
    if (time && time > ctx.currentTime) {
      source.start(time)
    } else {
      source.start()
    }
  }

  private stopAllSEs() {
    this.activeSESources.forEach(source => {
      try {
        source.stop()
      } catch (e) {
        // Ignore if already stopped or not started yet
      }
      try {
        source.disconnect()
      } catch (e) {
        // Ignore disconnect races
      }
    })
    this.activeSESources.clear()
  }

  // --- Scheduler ---
  
  public startScheduler(
    getNotes: () => any[], 
    getAbsoluteTime: (measure: number, pos: number) => number,
    onNoteTriggered?: (noteId: string, scheduledAtCtxTime: number) => void
  ) {
    this.scheduledNotes.clear()
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    
    this.schedulerTimer = window.setInterval(() => {
      if (!this.isPlaying || !this.ctx) return
      
      const currentTime = this.getCurrentTime()
      const scheduleFrom = currentTime - this.scheduleBacklook
      const scheduleUntil = currentTime + this.lookahead
      const notes = getNotes()

      notes.forEach(note => {
        if (this.scheduledNotes.has(note.id)) return
        
        const noteTime = getAbsoluteTime(note.measure, note.position)
        
          if (noteTime >= scheduleFrom && noteTime <= scheduleUntil) {
            const ctx = this.ctx!
            const scheduleAtCtxTime = Math.max(ctx.currentTime, ctx.currentTime + (noteTime - currentTime))
          
          if (note.type === '1' || note.type === '3') {
            this.playSE('don', scheduleAtCtxTime)
            onNoteTriggered?.(note.id, scheduleAtCtxTime)
          } else if (note.type === '2' || note.type === '4') {
            this.playSE('ka', scheduleAtCtxTime)
            onNoteTriggered?.(note.id, scheduleAtCtxTime)
          } else if (note.type === '5' || note.type === '6') {
            // Find end note
            const endNote = notes.find(n => n.type === '8' && (n.measure > note.measure || (n.measure === note.measure && n.position > note.position)))
            if (endNote) {
              const endTime = getAbsoluteTime(endNote.measure, endNote.position)
              const duration = endTime - noteTime
              // Schedule rolls every 80ms.
              const intervalSec = 0.08
              const hits = Math.max(1, Math.floor(duration / intervalSec) + 1)
              for (let i = 0; i < hits; i++) {
                this.playSE('don', scheduleAtCtxTime + (i * intervalSec))
              }
              onNoteTriggered?.(note.id, scheduleAtCtxTime)
            }
          } else if (note.type === '7') {
            const requestedHits = Math.max(1, Number(note.attributes?.hits) || 5)
            const endNote = notes.find(n => n.type === '8' && (n.measure > note.measure || (n.measure === note.measure && n.position > note.position)))
            const endTime = endNote ? getAbsoluteTime(endNote.measure, endNote.position) : noteTime
            const duration = Math.max(0, endTime - noteTime)
            const intervalSec = duration > 0 ? (duration / requestedHits) : 0.08
            const actualHits = duration > 0 ? requestedHits : 1

            for (let i = 0; i < actualHits; i++) {
              this.playSE('don', scheduleAtCtxTime + (i * intervalSec))
            }
            onNoteTriggered?.(note.id, scheduleAtCtxTime)
          }

          this.scheduledNotes.add(note.id)
        }
      })
    }, this.scheduleInterval)
  }

  public stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer)
      this.schedulerTimer = null
    }
    this.scheduledNotes.clear()
  }
}

export const instance = new AudioEngine()
export default instance
