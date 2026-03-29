-- Join/Leave notifications for room presence

CREATE TABLE IF NOT EXISTS public.room_events (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('join', 'leave')),
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS room_events_room_id_created_at_idx
  ON public.room_events (room_id, created_at DESC);

ALTER TABLE public.room_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public RoomEvents Select" ON public.room_events;
DROP POLICY IF EXISTS "Public RoomEvents Insert" ON public.room_events;
DROP POLICY IF EXISTS "Public RoomEvents Delete" ON public.room_events;

CREATE POLICY "Public RoomEvents Select"
  ON public.room_events FOR SELECT
  USING (true);

CREATE POLICY "Public RoomEvents Insert"
  ON public.room_events FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Public RoomEvents Delete"
  ON public.room_events FOR DELETE
  USING (true);

ALTER PUBLICATION supabase_realtime ADD TABLE public.room_events;

-- Active users view for nickname uniqueness checks
CREATE OR REPLACE VIEW public.active_room_users AS
SELECT DISTINCT ON (user_id)
  room_id,
  user_id,
  user_name,
  user_color,
  event_type,
  created_at
FROM public.room_events
ORDER BY user_id, created_at DESC;
