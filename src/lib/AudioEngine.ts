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

  constructor() {
    this.initContext()
  }

  private initContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
    }
    if (this.ctx && (!this.songGain || !this.seGain)) {
      this.songGain = this.ctx.createGain()
      this.seGain = this.ctx.createGain()
      this.songGain.connect(this.ctx.destination)
      this.seGain.connect(this.ctx.destination)
    }
  }

  public setVolumes(songVolume: number, seVolume: number) {
    this.initContext()
    const clamp = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 1))
    const song = clamp(songVolume)
    const se = clamp(seVolume)
    if (this.songGain) this.songGain.gain.value = song
    if (this.seGain) this.seGain.gain.value = se
  }

  public async loadAudio(url: string) {
    this.initContext()
    if (!this.ctx) return
    const res = await fetch(url)
    const arrayBuffer = await res.arrayBuffer()
    this.audioBuffer = await this.ctx.decodeAudioData(arrayBuffer)
  }

  public async loadSEs() {
    this.initContext()
    if (!this.ctx) return
    try {
      const [donRes, kaRes] = await Promise.all([
        fetch('/snd/don.mp3'),
        fetch('/snd/ka.mp3')
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
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.connect(this.seGain || ctx.destination)
    this.activeSESources.add(source)

    const cleanup = () => {
      if (this.activeSESources.has(source)) {
        this.activeSESources.delete(source)
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
    getAbsoluteTime: (measure: number, pos: number) => number
  ) {
    this.scheduledNotes.clear()
    if (this.schedulerTimer) clearInterval(this.schedulerTimer)
    
    this.schedulerTimer = window.setInterval(() => {
      if (!this.isPlaying || !this.ctx) return
      
      const currentTime = this.getCurrentTime()
      const scheduleUntil = currentTime + this.lookahead
      const notes = getNotes()

      notes.forEach(note => {
        if (this.scheduledNotes.has(note.id)) return
        
        const noteTime = getAbsoluteTime(note.measure, note.position)
        
          if (noteTime >= currentTime && noteTime <= scheduleUntil) {
            const ctx = this.ctx!
            const scheduleAtCtxTime = ctx.currentTime + (noteTime - currentTime)
          
          if (note.type === '1' || note.type === '3') {
            this.playSE('don', scheduleAtCtxTime)
          } else if (note.type === '2' || note.type === '4') {
            this.playSE('ka', scheduleAtCtxTime)
          } else if (note.type === '5' || note.type === '6') {
            // Find end note
            const endNote = notes.find(n => n.type === '8' && (n.measure > note.measure || (n.measure === note.measure && n.position > note.position)))
            if (endNote) {
              const endTime = getAbsoluteTime(endNote.measure, endNote.position)
              const duration = endTime - noteTime
              // schedule rolls every 20ms
              const hits = Math.max(1, Math.floor(duration / 0.02))
              for (let i = 0; i < hits; i++) {
                this.playSE('don', scheduleAtCtxTime + (i * 0.02))
              }
            }
          } else if (note.type === '7') {
            const hits = note.attributes?.hits || 5
            for (let i = 0; i < hits; i++) {
              this.playSE('don', scheduleAtCtxTime + (i * 0.05)) // 5ms apart visually sounds like a burst or machine gun
            }
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
