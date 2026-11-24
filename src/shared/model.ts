import { z } from 'zod';

export const cueSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(200),
  time: z.number().finite().positive()
}).strict();
export const videoSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(200),
  media: z.string().regex(/^[a-f0-9-]+\.(mp4|webm)$/),
  duration: z.number().finite().positive(),
  width: z.number().int().positive(), height: z.number().int().positive(),
  cues: z.array(cueSchema).max(10000).transform(cues => cues.sort((a, b) => a.time - b.time))
}).strict().superRefine((p, ctx) => {
  const times = new Set<number>();
  const ids = new Set<string>();
  for (const cue of p.cues) {
    if (cue.time >= p.duration || times.has(cue.time) || ids.has(cue.id))
      ctx.addIssue({ code: 'custom', message: 'Pause points must be unique and inside the video.' });
    times.add(cue.time); ids.add(cue.id);
  }
});
export const projectSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(200),
  videos: z.array(z.string().uuid()).max(10000)
}).strict();
export const catalogSchema = z.object({
  version: z.literal(2), videos: z.array(videoSchema).max(10000),
  projects: z.array(projectSchema).max(10000)
}).strict().superRefine((c, ctx) => {
  const ids = new Set(c.videos.map(p => p.id));
  if (ids.size !== c.videos.length || new Set(c.projects.map(p => p.id)).size !== c.projects.length)
    ctx.addIssue({ code: 'custom', message: 'Duplicate document identifiers.' });
  if (c.projects.some(p => p.videos.some(id => !ids.has(id))))
    ctx.addIssue({ code: 'custom', message: 'Project references a missing video.' });
});
const legacySchema = z.object({
  version: z.literal(1), projects: z.array(videoSchema).max(10000),
  playlists: z.array(z.object({
    id: z.string().uuid(), name: z.string().trim().min(1).max(200),
    projects: z.array(z.string().uuid()).max(10000)
  }).strict()).max(10000)
}).strict();
export function parseCatalog(value: unknown): Catalog {
  if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1)
    return catalogSchema.parse(value);
  const old = legacySchema.parse(value);
  const used = new Set(old.playlists.flatMap(list => list.projects));
  return catalogSchema.parse({
    version: 2, videos: old.projects,
    projects: [
      ...old.playlists.map(list => ({ id: list.id, name: list.name, videos: list.projects })),
      ...old.projects.filter(video => !used.has(video.id)).map(video => ({ id: video.id, name: video.name, videos: [video.id] }))
    ]
  });
}
export type Cue = z.infer<typeof cueSchema>;
export type Video = z.infer<typeof videoSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type Workspace = { path: string; catalog: Catalog; recovery?: string; filePath?: string; projectId?: string };
export type ImportedMedia = { media: string; url: string; name: string };
export interface DemoAPI {
  newProject(): Promise<Workspace>;
  openProject(): Promise<Workspace | null>;
  openLegacyWorkspace(): Promise<Workspace | null>;
  currentProject(): Promise<Workspace | null>;
  saveProject(catalog: Catalog, projectId: string, saveAs: boolean): Promise<Workspace | null>;
  importMedia(): Promise<ImportedMedia | null>;
  cancelOperation(): Promise<void>;
  fullscreen(enabled: boolean): Promise<void>;
  onProgress(listener: (message: string) => void): () => void;
  onFullscreen(listener: (enabled: boolean) => void): () => void;
  onFocus(listener: (focused: boolean) => void): () => void;
}
export const mediaUrl = (media: string) => `demo-media://asset/${media}`;
