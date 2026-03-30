import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { Music, Users, ArrowRight, Loader2, PencilLine, X, Lock } from 'lucide-react'

interface Room {
  id: string
  display_name: string
  created_at: string
  has_password?: boolean
}

interface LobbyProps {
  userName: string
  onChangeUserName: (name: string) => void
  onSelectRoom: (roomId: string) => void
}

export default function Lobby({ userName, onChangeUserName, onSelectRoom }: LobbyProps) {
  const [rooms, setRooms] = useState<Room[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRenameOpen, setIsRenameOpen] = useState(false)
  const [draftName, setDraftName] = useState(userName)
  const [renameError, setRenameError] = useState<string | null>(null)
  const [joiningRoomId, setJoiningRoomId] = useState<string | null>(null)
  const [passwordRoom, setPasswordRoom] = useState<Room | null>(null)
  const [roomPasswordInput, setRoomPasswordInput] = useState('')
  const [roomPasswordError, setRoomPasswordError] = useState<string | null>(null)
  const [passwordSubmitting, setPasswordSubmitting] = useState(false)

  useEffect(() => {
    setDraftName(userName)
  }, [userName])

  useEffect(() => {
    async function fetchRooms() {
      try {
        setLoading(true)
        const { data, error } = await supabase
          .from('rooms')
          .select('id, display_name, created_at, has_password')
          .order('id', { ascending: true })

        if (error) throw error
        setRooms(data || [])
      } catch (err: any) {
        console.error('Error fetching rooms:', err)
        setError(err.message)
      } finally {
        setLoading(false)
      }
    }

    fetchRooms()
  }, [])

  const fetchLatestRoom = async (roomId: string) => {
    const { data, error } = await supabase
      .from('rooms')
      .select('id, display_name, created_at, has_password')
      .eq('id', roomId)
      .single()

    if (error) throw error
    return data as Room
  }

  const openPasswordModal = (room: Room) => {
    setPasswordRoom(room)
    setRoomPasswordInput('')
    setRoomPasswordError(null)
  }

  const handleEnterRoom = async (room: Room) => {
    try {
      setJoiningRoomId(room.id)
      const latestRoom = await fetchLatestRoom(room.id)
      if (!latestRoom.has_password) {
        localStorage.removeItem(`connectja_room_password_${room.id}`)
        onSelectRoom(room.id)
        return
      }

      openPasswordModal(latestRoom)
    } catch (err: any) {
      console.error('Error checking room password:', err)
      setError(err.message || 'Failed to check room password.')
    } finally {
      setJoiningRoomId(null)
    }
  }

  const handlePasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!passwordRoom) return

    try {
      setPasswordSubmitting(true)
      setRoomPasswordError(null)
      const latestRoom = await fetchLatestRoom(passwordRoom.id)
      if (!latestRoom.has_password) {
        localStorage.removeItem(`connectja_room_password_${passwordRoom.id}`)
        setPasswordRoom(null)
        onSelectRoom(passwordRoom.id)
        return
      }

      const { data, error } = await supabase.rpc('verify_room_password', {
        target_room_id: passwordRoom.id,
        candidate_password: roomPasswordInput
      })

      if (error) {
        throw error
      }

      if (!data) {
        setRoomPasswordError('パスワードが違います')
        return
      }

      localStorage.setItem(`connectja_room_password_${passwordRoom.id}`, roomPasswordInput)
      setPasswordRoom(null)
      onSelectRoom(passwordRoom.id)
    } catch (err: any) {
      console.error('Error validating room password:', err)
      setRoomPasswordError(err.message || 'パスワード確認に失敗しました')
    } finally {
      setPasswordSubmitting(false)
    }
  }

  const checkNicknameAvailability = async (nextName: string, currentName: string) => {
    const normalized = nextName.trim()
    if (!normalized) return { ok: false, errorMessage: '名前を入力してください' }

    if (normalized.toLowerCase() === currentName.trim().toLowerCase()) {
      return { ok: true }
    }

    const { data, error } = await supabase
      .from('room_events')
      .select('user_id, user_name, event_type, created_at')
      .order('created_at', { ascending: false })

    if (error) {
      return { ok: false, errorMessage: `名前の確認に失敗しました: ${error.message}` }
    }

    const activeNames = new Set<string>()
    const seenUsers = new Set<string>()

    for (const row of data || []) {
      const uid = String(row.user_id || '').trim()
      if (!uid || seenUsers.has(uid)) continue
      seenUsers.add(uid)

      if (String(row.event_type || '') !== 'join') continue

      const name = String(row.user_name || '').trim().toLowerCase()
      if (name) activeNames.add(name)
    }

    if (activeNames.has(normalized.toLowerCase())) {
      return { ok: false, errorMessage: 'この名前は既に使われています' }
    }

    return { ok: true }
  }

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-vh-50 text-neutral-400">
        <Loader2 className="w-10 h-10 animate-spin mb-4 text-orange-500" />
        <p>Loading rooms...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="bg-red-900/20 border border-red-500/50 p-6 rounded-2xl text-red-200 max-w-lg">
        <h3 className="text-xl font-bold mb-2">Connection Error</h3>
        <p className="mb-4">{error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  return (
    <div className="w-full max-w-6xl">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 bg-neutral-800/70 border border-neutral-700 rounded-2xl px-4 py-3">
          <div className="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center">
            <Users className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-[0.2em] text-neutral-500">Current Nickname</p>
            <p className="text-white font-semibold">{userName}</p>
          </div>
        </div>

        <button
          onClick={() => setIsRenameOpen(true)}
          className="inline-flex items-center gap-2 self-start md:self-auto px-4 py-3 rounded-2xl bg-neutral-800 border border-neutral-700 text-sm font-semibold text-white hover:border-orange-500 hover:bg-neutral-800/80 transition-all"
        >
          <PencilLine className="w-4 h-4 text-orange-400" />
          Change Nickname
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {rooms.map((room) => (
          <button
            key={room.id}
            onClick={() => handleEnterRoom(room)}
            disabled={joiningRoomId === room.id || passwordSubmitting}
            className="bg-neutral-800 p-8 rounded-3xl border border-neutral-700 hover:border-orange-500 hover:bg-neutral-800/50 transition-all group text-left relative overflow-hidden"
          >
            <div className="flex items-center mb-6">
              <div className="p-3 bg-orange-500/10 rounded-2xl mr-4 group-hover:bg-orange-500/20 transition-colors">
                <Music className="w-8 h-8 text-orange-500" />
              </div>
              <div>
                <h2 className="text-2xl font-bold text-white group-hover:text-orange-400 transition-colors">
                  {room.display_name}
                </h2>
                <p className="text-sm text-neutral-500">ID: {room.id}</p>
                {room.has_password && (
                  <p className="text-xs text-neutral-400 mt-1 inline-flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5" />
                    Password Required
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between mt-8">
              <div className="flex items-center text-neutral-400">
                <Users className="w-5 h-5 mr-2" />
                <span className="text-sm tracking-wide">Enter Room</span>
              </div>
              {joiningRoomId === room.id ? (
                <Loader2 className="w-6 h-6 text-orange-400 animate-spin" />
              ) : (
                <ArrowRight className="w-6 h-6 text-neutral-600 group-hover:text-orange-500 group-hover:translate-x-2 transition-all" />
              )}
            </div>

            <div className="absolute -bottom-10 -right-10 w-32 h-32 bg-orange-500/5 rounded-full blur-3xl group-hover:bg-orange-500/10 transition-all"></div>
          </button>
        ))}

        {rooms.length === 0 && (
          <div className="col-span-full py-20 text-center bg-neutral-800/30 rounded-3xl border border-dashed border-neutral-700">
            <p className="text-neutral-500">No rooms found. Did you run the SQL script?</p>
          </div>
        )}
      </div>

      {isRenameOpen && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-neutral-800 bg-neutral-900 shadow-2xl p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Nickname</p>
                <h3 className="text-xl font-bold text-white">Change your display name</h3>
              </div>
              <button
                onClick={() => {
                  setIsRenameOpen(false)
                  setRenameError(null)
                  setDraftName(userName)
                }}
                className="p-2 rounded-xl bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form
              onSubmit={async (e) => {
                e.preventDefault()

                const result = await checkNicknameAvailability(draftName, userName)
                if (!result.ok) {
                  setRenameError(result.errorMessage || '名前の確認に失敗しました')
                  return
                }

                const normalized = draftName.trim()
                setRenameError(null)
                onChangeUserName(normalized)
                setIsRenameOpen(false)
              }}
            >
              <input
                value={draftName}
                onChange={(e) => {
                  setDraftName(e.target.value)
                  setRenameError(null)
                }}
                maxLength={20}
                autoFocus
                placeholder="Nickname..."
                className="w-full bg-neutral-950 border border-neutral-700 rounded-2xl px-4 py-3 text-white outline-none focus:border-orange-500 transition-colors"
              />
              {renameError && (
                <p className="mt-3 text-sm text-red-400">{renameError}</p>
              )}
              <div className="flex justify-end gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => {
                    setIsRenameOpen(false)
                    setRenameError(null)
                    setDraftName(userName)
                  }}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!draftName.trim()}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white transition-colors"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {passwordRoom && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-3xl border border-neutral-800 bg-neutral-900 shadow-2xl p-6">
            <div className="flex items-start justify-between gap-4 mb-5">
              <div>
                <p className="text-xs uppercase tracking-[0.2em] text-neutral-500">Protected Room</p>
                <h3 className="text-xl font-bold text-white">{passwordRoom.display_name}</h3>
              </div>
              <button
                onClick={() => {
                  setPasswordRoom(null)
                  setRoomPasswordInput('')
                  setRoomPasswordError(null)
                }}
                className="p-2 rounded-xl bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handlePasswordSubmit}>
              <input
                type="password"
                value={roomPasswordInput}
                onChange={(e) => {
                  setRoomPasswordInput(e.target.value)
                  setRoomPasswordError(null)
                }}
                autoFocus
                placeholder="Room password..."
                className="w-full bg-neutral-950 border border-neutral-700 rounded-2xl px-4 py-3 text-white outline-none focus:border-orange-500 transition-colors"
              />
              {roomPasswordError && (
                <p className="mt-3 text-sm text-red-400">{roomPasswordError}</p>
              )}
              <div className="flex justify-end gap-3 mt-5">
                <button
                  type="button"
                  onClick={() => {
                    setPasswordRoom(null)
                    setRoomPasswordInput('')
                    setRoomPasswordError(null)
                  }}
                  className="px-4 py-2 rounded-xl text-sm font-semibold text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!roomPasswordInput || passwordSubmitting}
                  className="px-5 py-2 rounded-xl text-sm font-semibold bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white transition-colors inline-flex items-center gap-2"
                >
                  {passwordSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  Enter
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  )
}
