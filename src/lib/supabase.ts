import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('Supabase credentials not found. Please check your .env file.')
}

export const supabase = createClient(supabaseUrl || '', supabaseAnonKey || '')

export function createRoomScopedSupabase(roomId: string) {
  const password = (typeof window !== 'undefined')
    ? (window.localStorage.getItem(`connectja_room_password_${roomId}`) || '')
    : ''
  const userId = (typeof window !== 'undefined') ? (window.localStorage.getItem('connectja_userid') || '') : ''
  const userName = (typeof window !== 'undefined') ? (window.localStorage.getItem('connectja_username') || '') : ''
  const userColor = (typeof window !== 'undefined') ? (window.localStorage.getItem('connectja_usercolor') || '') : ''

  return createClient(supabaseUrl || '', supabaseAnonKey || '', {
    global: {
      headers: {
        'x-room-id': roomId,
        ...(password ? { 'x-room-password': password } : {}),
        ...(userId ? { 'x-user-id': userId } : {}),
        ...(userName ? { 'x-user-name': userName } : {}),
        ...(userColor ? { 'x-user-color': userColor } : {})
      }
    }
  })
}
