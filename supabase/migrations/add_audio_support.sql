-- Add audio_url to rooms
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS audio_url TEXT;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS tja_text TEXT;

-- Prepare Storage Bucket
INSERT INTO storage.buckets (id, name, public) VALUES ('audio', 'audio', true) ON CONFLICT (id) DO NOTHING;

-- Set up Storage Policies (Allow public/anon uploads for the prototype)
CREATE POLICY "Public Audio Access" ON storage.objects
  FOR SELECT USING (bucket_id = 'audio');

CREATE POLICY "Public Audio Upload" ON storage.objects
  FOR INSERT WITH CHECK (bucket_id = 'audio');

CREATE POLICY "Public Audio Update" ON storage.objects
  FOR UPDATE USING (bucket_id = 'audio');

CREATE POLICY "Public Audio Delete" ON storage.objects
  FOR DELETE USING (bucket_id = 'audio');

-- Ensure RLS is enabled and allow public access for prototype
ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public Rooms Select" ON public.rooms FOR SELECT USING (true);
CREATE POLICY "Public Rooms Insert" ON public.rooms FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Rooms Update" ON public.rooms FOR UPDATE USING (true);

ALTER TABLE public.notes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Notes Select" ON public.notes FOR SELECT USING (true);
CREATE POLICY "Public Notes Insert" ON public.notes FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Notes Update" ON public.notes FOR UPDATE USING (true);
CREATE POLICY "Public Notes Delete" ON public.notes FOR DELETE USING (true);

ALTER TABLE public.commands ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public Commands Select" ON public.commands FOR SELECT USING (true);
CREATE POLICY "Public Commands Insert" ON public.commands FOR INSERT WITH CHECK (true);
CREATE POLICY "Public Commands Update" ON public.commands FOR UPDATE USING (true);
CREATE POLICY "Public Commands Delete" ON public.commands FOR DELETE USING (true);
