import { useState } from 'react'
import { Music, Users } from 'lucide-react'
import Lobby from './components/Lobby'

import Editor from './components/Editor'

const COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#84cc16', '#22c55e', 
  '#06b6d4', '#3b82f6', '#6366f1', '#a855f7', '#ec4899'
]

const sanitizeDisplayName = (value: string) =>
  value.trim().replace(/[<>"'`]/g, '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 20)

function App() {
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null)
  const [userId] = useState<string>(() => {
    const saved = localStorage.getItem('connectja_userid')
    if (saved) return saved
    const id = crypto.randomUUID()
    localStorage.setItem('connectja_userid', id)
    return id
  })
  const [userName, setUserName] = useState<string>(() => localStorage.getItem('connectja_username') || '')
  const [userColor, setUserColor] = useState<string>(() => {
    const saved = localStorage.getItem('connectja_usercolor')
    if (saved) return saved
    const randomColor = COLORS[Math.floor(Math.random() * COLORS.length)]
    localStorage.setItem('connectja_usercolor', randomColor)
    return randomColor
  })
  const [isNameSet, setIsNameSet] = useState<boolean>(() => !!localStorage.getItem('connectja_username'))

  const handleSetName = (e: React.FormEvent) => {
    e.preventDefault()
    const normalized = sanitizeDisplayName(userName)
    if (!normalized) return
    localStorage.setItem('connectja_username', normalized)
    setUserName(normalized)
    setIsNameSet(true)
  }

  const handleUpdateName = (nextName: string) => {
    const normalized = sanitizeDisplayName(nextName)
    if (!normalized) return
    localStorage.setItem('connectja_username', normalized)
    setUserName(normalized)
    setIsNameSet(true)
  }

  if (!isNameSet) {
    return (
      <div className="min-h-screen bg-neutral-900 flex items-center justify-center p-4">
        <form onSubmit={handleSetName} className="bg-neutral-800 p-8 rounded-3xl border border-neutral-700 w-full max-w-sm">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-orange-500/10 rounded-2xl">
              <Users className="w-12 h-12 text-orange-500" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center text-white mb-6">Enter Your Name</h2>
          <input
            type="text"
            value={userName}
            onChange={e => setUserName(e.target.value)}
            placeholder="Nickname..."
            className="w-full bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-3 text-white focus:border-orange-500 outline-none transition-all mb-6 text-center text-lg"
            autoFocus
            maxLength={20}
          />
          <button
            type="submit"
            disabled={!userName.trim()}
            className="w-full bg-orange-600 hover:bg-orange-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white font-bold py-3 rounded-xl transition-all"
          >
            Join Lobby
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className={selectedRoomId ? "h-screen bg-neutral-900 text-white flex flex-col" : "min-h-screen bg-neutral-900 text-white flex flex-col items-center"}>
      {!selectedRoomId ? (
        <>
          <header className="py-16 text-center">
            <h1 className="text-7xl font-black mb-4 bg-gradient-to-r from-orange-400 via-red-500 to-pink-500 bg-clip-text text-transparent tracking-tighter">
              Connectja
            </h1>
            <p className="text-2xl text-neutral-500 font-medium tracking-tight">A Score Editor for Drum Simulator.</p>
          </header>
          
          <main className="w-full flex justify-center px-8 pb-16">
            <Lobby userName={userName} onChangeUserName={handleUpdateName} onSelectRoom={setSelectedRoomId} />
          </main>

          <footer className="mt-auto py-8 text-sm text-neutral-600 text-center">
            <p>© 2026 Connectja Team • Supabase Realtime Project</p>
          </footer>
        </>
      ) : (
        <Editor roomId={selectedRoomId} onBack={() => setSelectedRoomId(null)} userId={userId} userName={userName} userColor={userColor} />
      )}
    </div>
  )
}

export default App
