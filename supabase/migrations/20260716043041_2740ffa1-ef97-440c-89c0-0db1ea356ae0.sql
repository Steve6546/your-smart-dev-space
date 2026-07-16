CREATE TABLE public.project_index (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  project_id uuid NOT NULL,
  user_id uuid NOT NULL,
  path text NOT NULL,
  kind text NOT NULL DEFAULT 'file',
  language text,
  size integer NOT NULL DEFAULT 0,
  functions text[] NOT NULL DEFAULT '{}',
  classes text[] NOT NULL DEFAULT '{}',
  interfaces text[] NOT NULL DEFAULT '{}',
  types text[] NOT NULL DEFAULT '{}',
  imports text[] NOT NULL DEFAULT '{}',
  exports text[] NOT NULL DEFAULT '{}',
  routes text[] NOT NULL DEFAULT '{}',
  api_endpoints text[] NOT NULL DEFAULT '{}',
  db_tables text[] NOT NULL DEFAULT '{}',
  env_vars text[] NOT NULL DEFAULT '{}',
  symbols_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);

CREATE INDEX project_index_project_id_idx ON public.project_index(project_id);
CREATE INDEX project_index_path_idx ON public.project_index(project_id, path);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_index TO authenticated;
GRANT ALL ON public.project_index TO service_role;

ALTER TABLE public.project_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owners manage project_index"
  ON public.project_index
  FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TRIGGER project_index_touch_updated_at
  BEFORE UPDATE ON public.project_index
  FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();