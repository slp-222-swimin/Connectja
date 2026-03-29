-- Add GOGOSTART and GOGOEND Command Support
-- This migration ensures the commands table is set up correctly for GOGO commands

-- Create commands table if it doesn't exist
CREATE TABLE IF NOT EXISTS public.commands (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  room_id TEXT REFERENCES public.rooms(id) ON DELETE CASCADE,
  measure INTEGER NOT NULL,
  position INTEGER NOT NULL,
  type TEXT NOT NULL, -- 'BPM', 'HS', 'MEASURE', 'GOGOSTART', 'GOGOEND'
  value TEXT, -- Nullable for GOGOSTART/GOGOEND
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create unique constraint for measure+position per room
ALTER TABLE public.commands DROP CONSTRAINT IF EXISTS commands_unique_per_room;
ALTER TABLE public.commands 
ADD CONSTRAINT commands_unique_per_room UNIQUE(room_id, measure, position, type);

-- Enable RLS if not already enabled
ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;

-- Create or replace RLS policies
DROP POLICY IF EXISTS "Public Commands Select" ON public.commands;
DROP POLICY IF EXISTS "Public Commands Insert" ON public.commands;
DROP POLICY IF EXISTS "Public Commands Update" ON public.commands;
DROP POLICY IF EXISTS "Public Commands Delete" ON public.commands;

CREATE POLICY "Public Commands Select" ON public.commands FOR SELECT USING (true);
CREATE POLICY "Public Commands Insert" ON public.commands FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Commands Update" ON public.commands FOR UPDATE USING (true);
CREATE POLICY "Public Commands Delete" ON public.commands FOR DELETE USING (true);

-- Realtime subscription setup (commands table is already in supabase_realtime via initial setup)
-- ALTER PUBLICATION supabase_realtime ADD TABLE public.commands;

-- Verification (optional - comment out if running multiple queries at once)
-- SELECT 
--   table_name,
--   column_name,
--   data_type
-- FROM information_schema.columns
-- WHERE table_name = 'commands'
-- ORDER BY ordinal_position;
