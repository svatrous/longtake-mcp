#!/usr/bin/env node
// Longtake MCP server: gives agents (Claude Code and others) tools to control the
// studio via its REST API. Point it at your studio with two env vars:
//   STUDIO_URL   — https://longtake.studio (or a self-hosted instance)
//   STUDIO_TOKEN — a personal agent token from account menu → API keys → Agent access
// Deps: npm i @modelcontextprotocol/sdk zod. Setup guide: https://longtake.studio/mcp
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const STUDIO_URL = process.env.STUDIO_URL || 'http://localhost:3711';
// Preferred: a personal agent token from the studio (account menu → "API keys" →
// "Agent access"). It signs in as the user who issued it and can be revoked alone.
const STUDIO_TOKEN = process.env.STUDIO_TOKEN || '';
// Legacy: the shared APP_PASSWORD. Always signs in as the studio owner — fine for
// your own studio, never hand it to someone else.
const STUDIO_PASSWORD = process.env.STUDIO_PASSWORD || '';
const AUTH_HEADER = STUDIO_TOKEN
  ? { Authorization: 'Bearer ' + STUDIO_TOKEN }
  : STUDIO_PASSWORD
    ? { Authorization: 'Basic ' + Buffer.from(':' + STUDIO_PASSWORD).toString('base64') }
    : {};

/* This file runs in two places: inside the studio's own folder, and as a copy downloaded
   from /mcp-server.cjs into a folder of the user's choosing. Everything that assumed the
   first case — the "cd here && npm start" advice, the path to the media folder — was
   simply wrong in the second, so the repo is claimed only when server.js is really here. */
const isLocalStudio = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(STUDIO_URL);
const STUDIO_DIR = fs.existsSync(path.join(__dirname, 'server.js')) ? __dirname : null;

/* The studio labels every refusal a person can act on with a machine code —
   MODEL_NOT_ACTIVATED, NEEDS_ARK_KEY, MODERATION, RATE_LIMITED. In the browser the code is
   what hangs the link on the message, which is why some of those sentences carry no URL of
   their own; an agent that only reads the prose loses both the address and the ability to
   tell a rate limit from a moderation refusal. So the code travels in the message and on
   the error object. The code → guide map is not copied here on purpose: it lives in the
   studio (HELP_FOR in public/app.js) and a second copy would drift. */
function studioError(body, fallback) {
  const err = new Error(body.error || fallback);
  // the rest of the answer too: a refusal can carry what the tool needs next (the final
  // a DRAFT_ALREADY_FINISHED names, the inputs a moderation refusal names)
  err.body = body;
  if (body.code) {
    err.code = body.code;
    err.message += ` [${body.code}]`;
  }
  /* A moderation refusal names the inputs the vendor refused (`refused`: @name, kind,
     route). The studio keeps them out of the sentence for the dictionary's sake; an agent
     reads prose, so here they go into the message — which of three clips it was is the
     whole question. */
  if (Array.isArray(body.refused) && body.refused.length) {
    err.refused = body.refused;
    err.message += ` — refused: ${body.refused.map((r) => `@${r.name} (${r.kind})`).join(', ')}`;
  }
  return err;
}

async function api(pathname, options = {}) {
  let res;
  try {
    res = await fetch(STUDIO_URL + pathname, {
      headers: { 'Content-Type': 'application/json', ...AUTH_HEADER },
      ...options,
    });
  } catch {
    throw new Error(`Studio not responding at ${STUDIO_URL}. ${isLocalStudio
      ? (STUDIO_DIR ? `Start it: cd ${STUDIO_DIR} && npm start` : 'Start the studio serving that port.')
      : 'Check STUDIO_URL — a studio that is not on this machine cannot be started from here.'}`);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    throw studioError(body, 'The studio rejected the sign-in. Set STUDIO_TOKEN to an agent token from the studio (account menu → "API keys" → "Agent access").');
  }
  if (!res.ok) throw studioError(body, `HTTP ${res.status}`);
  return body;
}

const text = (data) => ({
  content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data, null, 2) }],
});

/* a char that can continue an @name — @guard must not match inside @guard_gate */
const MENTION_CHAR = /[\w\-а-яё]/i;

/* the prompt can reference characters and assets by @name —
   we resolve the mentions into ids, the way the studio frontend does.
   Longest names first, and every claimed occurrence is blanked out (equal-length spaces),
   so a short name that is a prefix of a longer one doesn't drag an extra reference in. */
function parseMentions(state, projectId, prompt) {
  const entities = [
    ...state.characters.filter((c) => c.projectId === projectId).map((c) => ({ kind: 'character', id: c.id, name: c.name })),
    ...state.assets.filter((a) => a.projectId === projectId && !a.internal).map((a) => ({ kind: 'asset', id: a.id, name: a.name })),
  ].sort((a, b) => b.name.length - a.name.length);
  const characterIds = [];
  const mentionIds = [];
  let scan = prompt || '';
  for (const e of entities) {
    const tag = '@' + e.name;
    let hit = false;
    for (let i = scan.indexOf(tag); i !== -1; i = scan.indexOf(tag, i + 1)) {
      if (MENTION_CHAR.test(scan[i + tag.length] || '')) continue;
      if (MENTION_CHAR.test(scan[i - 1] || '')) continue; // me@hero.com is an address, not a tag
      hit = true;
      scan = scan.slice(0, i) + ' '.repeat(tag.length) + scan.slice(i + tag.length);
    }
    if (hit) (e.kind === 'character' ? characterIds : mentionIds).push(e.id);
  }
  return { characterIds, mentionIds };
}

function fileToDataUrl(filePath) {
  const abs = path.resolve(filePath);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).toLowerCase().replace('.', '');
  const mime = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg',
    // reference clips — the two containers ModelArk reads (a Blender blockout is one of these)
    mp4: 'video/mp4', mov: 'video/quicktime' }[ext];
  if (!mime) throw new Error(`Unsupported file format: .${ext}`);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/* Length of a voice sample, in seconds — the studio stores it and checks two limits before
   a render (each clip at least 2 s, all clips in one take within the model's window). In the
   browser the number comes from an <audio> element; here it is read out of the file itself.
   Only mp3 and wav are measured — the video model takes nothing else. Unreadable file →
   null, and the upload goes without a duration, exactly as it did before. */
const MP3_RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
const MP3_KBPS = {
  3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],   // MPEG 1, layer III
  2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],       // MPEG 2 / 2.5
};
function mp3Seconds(buf) {
  let at = 0;
  // an ID3v2 tag sits in front of the audio and its size is a syncsafe 28-bit integer
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    at = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  let seconds = 0;
  while (at + 4 <= buf.length) {
    if (buf[at] !== 0xff || (buf[at + 1] & 0xe0) !== 0xe0) { at++; continue; } // resync
    const version = (buf[at + 1] >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
    const layer = (buf[at + 1] >> 1) & 3;   // 1 = layer III
    const rates = MP3_RATES[version];
    const kbps = MP3_KBPS[version === 3 ? 3 : 2][(buf[at + 2] >> 4) & 0xf];
    const rate = rates && rates[(buf[at + 2] >> 2) & 3];
    if (layer !== 1 || !rate || !kbps) { at++; continue; }
    const samples = version === 3 ? 1152 : 576; // per frame: MPEG1 vs MPEG2/2.5
    const size = Math.floor(((samples / 8) * 1000 * kbps) / rate) + ((buf[at + 2] >> 1) & 1);
    if (size < 24) { at++; continue; }
    // the first frame is often a Xing/Info header (a VBR table, no audio) — not playtime
    const header = seconds === 0 && /Xing|Info/.test(buf.toString('latin1', at + 4, Math.min(at + size, buf.length)));
    if (!header) seconds += samples / rate; // samples per frame ÷ sample rate
    at += size;
  }
  return seconds || null;
}
function wavSeconds(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF') return null;
  let at = 12; let byteRate = 0;
  while (at + 8 <= buf.length) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ' && at + 20 <= buf.length) byteRate = buf.readUInt32LE(at + 16);
    if (id === 'data') return byteRate ? Math.min(size, buf.length - at - 8) / byteRate : null;
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  return null;
}
function audioSeconds(filePath) {
  try {
    const ext = path.extname(filePath).toLowerCase();
    const buf = fs.readFileSync(path.resolve(filePath));
    const secs = ext === '.wav' ? wavSeconds(buf) : ext === '.mp3' ? mp3Seconds(buf) : null;
    return secs > 0 && Number.isFinite(secs) ? Number(secs.toFixed(2)) : null;
  } catch { return null; }
}

/* Length and frame size of a clip, the way the browser measures them for the studio: the
   server refuses a clip outside 2–30 s or beyond 720p BY NAME before any money moves, but only
   if it knows the numbers. An agent has no <video> element, so ffprobe stands in for it; with
   no ffprobe on the machine the upload still goes, and the vendor judges the clip itself. */
function videoMeta(filePath) {
  try {
    const out = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', path.resolve(filePath)], { encoding: 'utf8' });
    const j = JSON.parse(out); const st = (j.streams || [])[0] || {};
    const duration = Number(j.format?.duration);
    return { duration: duration > 0 ? Number(duration.toFixed(2)) : undefined, width: st.width || undefined, height: st.height || undefined };
  } catch { return null; }
}

/* Engine ids, copied from the studio's MODELS list (server.js). A zod enum is fixed when the
   tool is registered, so it cannot be built from /api/state — adding an engine to the studio
   means adding its id here AND teaching estimate_cost how that engine is billed. */
const MODEL_IDS = [
  'dreamina-seedance-2-5-260628', 'dreamina-seedance-2-0-260128',
  'dreamina-seedance-2-0-fast-260128', 'dreamina-seedance-2-0-mini-260615',
  'gemini-omni-1.1-flash',
  'veo-3.1-generate-preview', 'veo-3.1-fast-generate-preview', 'veo-3.1-lite-generate-preview',
  'kling-3.0', 'kling-3.0-turbo',
];
const MODEL_NOTE = 'defaults to Seedance 2.0. Seedance: 4–15 s, adaptive ratio, references and voice samples (2.5: up to 30 s, 30 references). Veo: 16:9/9:16, duration 4, 6 or 8 only, no voice, Lite takes no references. Gemini Omni: no duration parameter (length is asked for in the prompt), no voice, price known only after the render. Kling: 16:9/9:16/1:1, 3–15 s, no references, no voice. Prices differ by an order of magnitude — ask estimate_cost first.';

const noRate = (m, resolution) => (m.resolutions?.includes(resolution)
  ? `Cost estimate unavailable — the studio reports no rate for ${m.id} at ${resolution} (update the studio).`
  : `Cost estimate unavailable — ${m.id} does not shoot ${resolution} (it has ${(m.resolutions || []).join(', ')}).`);

const server = new McpServer({ name: 'seedance-studio', version: '1.0.0' });

server.tool(
  'studio_overview',
  'Studio overview: projects with folders and scenes (ids and names), characters, assets, active renders. Call this first — all other tools use ids from here.',
  {},
  async () => {
    const s = await api('/api/state');
    const overview = {
      apiReady: s.config.hasKey,
      activeRenders: s.tasks.filter((t) => t.status === 'queued' || t.status === 'running').length,
      projects: s.projects.map((p) => (p.lock?.locked ? {
        /* A locked project comes back as a card without folders, scenes, characters or
           assets — reporting it with empty lists would read as "the work is gone". */
        id: p.id,
        name: p.name,
        locked: true,
        note: `This project is locked: a free project stops opening a day after it is created. It still holds ${p.lock.scenes} scene(s) and ${p.lock.takes} take(s); a subscription unlocks it. Every call touching it answers 402 until then.`,
        deleteAt: p.lock.deleteAt ? new Date(p.lock.deleteAt).toISOString() : undefined,
      } : {
        id: p.id,
        name: p.name,
        folders: s.folders.filter((f) => f.projectId === p.id).map((f) => ({
          id: f.id,
          name: f.name,
          scenes: s.scenes.filter((sc) => sc.folderId === f.id).map((sc) => ({
            id: sc.id,
            name: sc.name,
            takes: s.tasks.filter((t) => t.sceneId === sc.id).length,
          })),
        })),
        characters: s.characters.filter((c) => c.projectId === p.id).map((c) => ({
          id: c.id,
          name: '@' + c.name,
          hasVoice: Boolean(c.voiceAssetId || c.arkVoiceAsset),
          verifiedActor: Boolean(c.arkImageAsset || c.arkVoiceAsset),
          // screen test: 'rejected' means the portrait fails content moderation, so every
          // generation referencing this character will be refused until it is replaced
          screenTest: (c.imageAssetId || c.arkImageAsset) ? (c.check?.status || 'untested') : undefined,
        })),
        /* internal = a character's own portrait or voice sample: not listed in the library,
           not deletable and not @-mentionable — the studio hides them the same way
           (projectAssets in app.js). Listed here they read as ordinary references, and a
           name they do not even reserve can be claimed by a real asset later. */
        assets: s.assets.filter((a) => a.projectId === p.id && !a.internal).map((a) => `@${a.name} (${a.kind})`),
      })),
    };
    return text(overview);
  }
);

server.tool('create_project', 'Create a project (scaffolded with "Episode 1" and "Scene 1").', { name: z.string() }, async ({ name }) => {
  const p = await api('/api/projects', { method: 'POST', body: JSON.stringify({ name }) });
  const s = await api('/api/state');
  const folder = s.folders.find((f) => f.projectId === p.id);
  const scene = s.scenes.find((sc) => sc.projectId === p.id);
  return text({ project: p, folderId: folder?.id, sceneId: scene?.id });
});

server.tool('create_folder', 'Create a folder (episode) in a project — a "Scene 1" appears inside.', { projectId: z.string(), name: z.string() }, async (args) => {
  const f = await api('/api/folders', { method: 'POST', body: JSON.stringify(args) });
  const s = await api('/api/state');
  return text({ folder: f, sceneId: s.scenes.find((sc) => sc.folderId === f.id)?.id });
});

server.tool('create_scene', 'Create a scene in a folder.', { folderId: z.string(), name: z.string() }, async (args) => {
  return text(await api('/api/scenes', { method: 'POST', body: JSON.stringify(args) }));
});

server.tool(
  'upload_asset',
  'Upload a local file (image, audio, or a reference clip) to the project library. Returns the name for @mentions. A library picture referenced as @name reaches the video model exactly as it is — to put a face in front of a video model, make it a character\'s portrait (create_character): that lays the anti-moderation grain on it. A clip (mp4/mov, 2–30 s, 480p or 720p) mentioned as @name goes to Seedance as a reference video — motion, camera movement, pacing, an effect — and its seconds are billed as input on top of the take; pass durationSec (and width/height) so the studio can check the limits before any money moves.',
  {
    projectId: z.string(), filePath: z.string().describe('absolute path to the file'), name: z.string().optional(),
    durationSec: z.number().positive().optional().describe('length of an audio or video file in seconds; measured here with ffprobe (video) or from the file (mp3/wav) when omitted'),
    width: z.number().int().positive().optional().describe('frame width of a clip in px (measured with ffprobe when omitted)'),
    height: z.number().int().positive().optional().describe('frame height of a clip in px (measured with ffprobe when omitted)'),
  },
  async ({ projectId, filePath, name, durationSec, width, height }) => {
    const dataUrl = fileToDataUrl(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const isVideo = ext === '.mp4' || ext === '.mov';
    const meta = isVideo ? videoMeta(filePath) : null;
    const body = {
      projectId, name: name || path.basename(filePath), dataUrl,
      duration: durationSec ?? (isVideo ? meta?.duration : audioSeconds(filePath) ?? undefined),
      width: width ?? meta?.width, height: height ?? meta?.height,
    };
    const asset = await api('/api/assets', { method: 'POST', body: JSON.stringify(body) });
    if (isVideo && !meta && !(durationSec && width && height)) {
      asset.note = 'ffprobe was not found, so the clip went up unmeasured: the studio could not check its length and frame size — pass durationSec, width and height, or the vendor will judge the clip at render time.';
    }
    return text(asset);
  }
);

server.tool(
  'generate_mocap',
  'Generate a character mockup sheet (21:9, 4 panels: full-body front·profile·back·portrait). From a real-person photo (photoPaths) and/or a text description. Engine: Seedream (BytePlus) with a Gemini fallback. The result is saved as an asset in the library. Pass its id to create_character as imageAssetId to cast it — the sheet gets the anti-moderation grain at that moment.',
  {
    projectId: z.string(),
    description: z.string().optional().describe('who it is; required when there are no photos; write the style right here'),
    photoPaths: z.array(z.string()).max(14).optional().describe('paths to photos of the person (up to 14)'),
    assetName: z.string().optional().describe('name for the @mention; without it the sheet is called "mockup" (then mockup-2, …) — this tool has no character name to build one from'),
  },
  async ({ projectId, description, photoPaths, assetName }) => {
    if (!description && !photoPaths?.length) throw new Error('Need a description and/or photos.');
    const refs = (photoPaths || []).map(fileToDataUrl);
    const identity =
      (refs.length ? 'The character is the EXACT person shown in the provided photos — identity must match the photos perfectly: same face, hairstyle, build, skin tone.' : '') +
      (description ? ` The character: ${description}.` : '');
    const prompt =
      'Create a single character reference sheet (model sheet). ' +
      'One seamless light-gray studio background, four panels left to right: ' +
      '(1) full-body front view, (2) full-body side profile view, (3) full-body back view, (4) close-up head-and-shoulders portrait, neutral expression. ' +
      identity + ' ' +
      'The character must be perfectly consistent across all panels — same face, hairstyle, build, one consistent outfit. ' +
      `Neutral standing pose, soft even studio lighting, ${refs.length ? 'photorealistic, ' : ''}no text or watermarks.`;
    /* projectId books the spend to this project — without it the frame is billed to the
       studio total and never shows up in the project's own figure. */
    const r = await api('/api/banana', { method: 'POST', body: JSON.stringify({ projectId, prompt, aspectRatio: '21:9', imageSize: '2K', referenceDataUrls: refs }) });
    const asset = await api('/api/assets', { method: 'POST', body: JSON.stringify({ projectId, name: assetName || 'mockup', dataUrl: r.dataUrl }) });
    return text({ asset, engine: r.engine, engineModel: r.engineModel });
  }
);

server.tool(
  'create_character',
  'Create a character: name (for @mentions) + appearance (a local sheet via imageFilePath, or a library assetId) + voice (audio file or assetId). The voice is locked in — it does not change from scene to scene. A character with a portrait is screen-tested automatically: a 4s clip is rendered to find out whether the reference clears content moderation, and the verdict comes back in `check` ("rejected" = the portrait reads as a real person and every take with it would fail — replace it with a clearly animated one or a verified actor asset://).',
  {
    projectId: z.string(),
    name: z.string(),
    imageAssetId: z.string().optional().describe('an existing library asset — it becomes the character\'s portrait and gets the anti-moderation grain at that moment (the clean file stays for previews; the asset itself stays in the library)'),
    imageFilePath: z.string().optional().describe('path to a local character sheet — preferred for a photorealistic face: the file is stored as the character\'s own (not listed in the library) and gets the automatic anti-moderation grain, the way attaching a file in Cast does'),
    voiceAssetId: z.string().optional(),
    voiceFilePath: z.string().optional().describe('path to a 2–15 s voice sample — mp3 or wav only, the video model takes nothing else; all speaking characters in one take share that 15 s window (30 s on Seedance 2.5)'),
    arkImageAsset: z.string().optional().describe('asset:// of a verified BytePlus actor'),
    arkVoiceAsset: z.string().optional(),
    grainLevel: z.number().int().min(10).max(100).optional().describe('strength of the anti-moderation grain on the portrait, 10–100 (default 60): the percent of black the darkest grain cell may reach. Raise it when Seedance 2.5 refuses a face that 2.0 accepts; the clean portrait is kept for previews, only the copy shown to the video model changes'),
  },
  async ({ projectId, name, imageAssetId, imageFilePath, voiceAssetId, voiceFilePath, arkImageAsset, arkVoiceAsset, grainLevel }) => {
    /* internal: a file handed to the character belongs to the character, not to the library —
       it is not listed, not @-mentionable and dies with it, exactly as in the cast dialog. */
    let imageId = imageAssetId || null;
    if (!imageId && imageFilePath) {
      /* grain: the server lays the anti-moderation noise over the sheet and keeps that copy
         next to the clean one — the only version the video model is shown. Without it a
         photoreal face is refused far more often, and the studio's own advice ("attach it as
         a file, files get the grain") is something an agent cannot otherwise follow. */
      const a = await api('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ projectId, name: name + '-mockup', dataUrl: fileToDataUrl(imageFilePath), internal: true, grain: true, grainLevel }),
      });
      imageId = a.id;
    }
    let voiceId = voiceAssetId || null;
    if (!voiceId && voiceFilePath) {
      /* duration: the studio checks the length of reference audio before a render, and the
         check needs a number — without it a 30 s sample only fails at the vendor. */
      const a = await api('/api/assets', {
        method: 'POST',
        body: JSON.stringify({ projectId, name: name + '-voice', dataUrl: fileToDataUrl(voiceFilePath), duration: audioSeconds(voiceFilePath) || undefined, internal: true }),
      });
      voiceId = a.id;
    }
    return text(await api('/api/characters', {
      method: 'POST',
      body: JSON.stringify({ projectId, name, imageAssetId: imageId, voiceAssetId: voiceId, arkImageAsset: arkImageAsset || null, arkVoiceAsset: arkVoiceAsset || null, grainLevel }),
    }));
  }
);

/* A draft's final: the newest take made from it that has not ended without a render. The
   same rule as the reel's finalOf (public/app.js) and the studio's own check, which refuses a
   second final with DRAFT_ALREADY_FINISHED (server.js prepareFinish). */
const GONE_STATUS = ['failed', 'cancelled', 'expired'];
const finalOf = (tasks, draftId) => tasks.find((t) => t.finishOf === draftId && !GONE_STATUS.includes(t.status));
const brief = (t) => ({ id: t.id, takeNo: t.takeNo, status: t.status });

server.tool(
  'generate_video',
  'Generate a take (video) in a scene. In the prompt you can reference characters and assets by @name (see studio_overview) — the studio attaches portraits, voices and references itself. A @clip from the library goes to Seedance as a reference video (say what to take from it: "the camera movement of @clip", "the pacing of @clip"); up to 3 clips per take on the 2.0 family, 10 on 2.5, 30 s of reference video in total, and every second of it is billed on top of the take. Write the prompt in English: Russian is not among the prompt languages of these models, and the studio translates it only if its owner switched translation on. With draft: true it shoots a Seedance 2.5 draft — 480p, billed as an ordinary 480p take — that finish_draft can later render again as the same shot in 1080p; shoot several (variants) and finish the one that works. The task is async: track it via take_status.',
  {
    sceneId: z.string(),
    prompt: z.string(),
    model: z.enum(MODEL_IDS).optional().describe(`${MODEL_NOTE} With draft: true the default is the model that shoots drafts (Seedance 2.5).`),
    resolution: z.enum(['360p', '480p', '720p', '1080p', '4K']).optional().describe('defaults to 720p, the one size every engine has (a draft: 480p, the only size drafts are shot in); 360p is Omni only, 480p is Seedance only, 4K is on Seedance 2.0, Veo 3.1/Fast and Kling 3.0'),
    ratio: z.enum(['adaptive', '16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).optional().describe('defaults to adaptive on Seedance and to 16:9 on engines that have no adaptive; 2.5 with a first/last frame accepts adaptive only'),
    duration: z.number().int().optional().describe('4–15 sec (Seedance 2.0), 4–30 (2.5), 3–15 (Kling), 4/6/8 (Veo), or -1 = model decides (Seedance only); defaults to 8'),
    generateAudio: z.boolean().optional().describe('defaults to true'),
    variants: z.number().int().min(1).max(4).optional().describe('takes at once, defaults to 1'),
    firstFrameAssetId: z.string().optional(),
    lastFrameAssetId: z.string().optional(),
    cameraPhrases: z.array(z.string()).optional().describe('English camera-movement phrases, e.g. "Slow cinematic dolly in toward the subject."'),
    draft: z.boolean().optional().describe('Seedance 2.5 only: a 480p draft that finish_draft can render again as the same shot in 1080p within 7 days. Billed as an ordinary 480p take. With draft, model defaults to 2.5 and resolution to 480p'),
  },
  async (args) => {
    const s = await api('/api/state');
    const scene = s.scenes.find((sc) => sc.id === args.sceneId);
    if (!scene) throw new Error(`Scene ${args.sceneId} not found — check against studio_overview.`);
    const { characterIds, mentionIds } = parseMentions(s, scene.projectId, args.prompt);
    /* A draft belongs to one model (the one with draftMode — 2.5 today), so a draft that
       names none takes that one: the studio's default (2.0) would be refused on the spot. A
       model named explicitly goes out as asked — the studio says what is wrong with it
       better than a silent swap would. */
    const draftModel = args.draft ? s.config.models.find((m) => m.draftMode) : null;
    if (args.draft && !draftModel) throw new Error('This studio has no model that shoots drafts.');
    // the studio's own default, the one estimate_cost quotes — not an id written in here
    const modelId = args.model || draftModel?.id
      || s.config.models.find((m) => m.default)?.id || 'dreamina-seedance-2-0-260128';
    /* Veo, Omni and Kling have no adaptive ratio and refuse the take rather than clamp it,
       so the default follows the chosen engine instead of failing every first attempt. */
    const picked = s.config.models.find((m) => m.id === modelId);
    const defaultRatio = picked?.ratios && !picked.ratios.includes('adaptive') ? '16:9' : 'adaptive';
    const tasks = await api('/api/generate', {
      method: 'POST',
      body: JSON.stringify({
        projectId: scene.projectId,
        sceneId: args.sceneId,
        prompt: args.prompt,
        cameraPhrases: args.cameraPhrases || [],
        variants: args.variants || 1,
        model: modelId,
        firstFrameId: args.firstFrameAssetId || null,
        lastFrameId: args.lastFrameAssetId || null,
        mentionIds,
        characterIds,
        ratio: args.ratio || defaultRatio,
        // a draft left without a size gets the studio's — 480p, the only one drafts have
        resolution: args.resolution || (args.draft ? undefined : '720p'),
        duration: args.duration ?? 8,
        generateAudio: args.generateAudio ?? true,
        draft: args.draft,
      }),
    });
    /* POST /api/generate answers with slimTask, which strips resolvedPrompt — so this
       field was always empty and the agent never saw what its @mentions turned into.
       The single-task route keeps it; one extra call is cheap next to a render. */
    let resolved = tasks[0]?.resolvedPrompt;
    if (!resolved && tasks[0]?.id) {
      resolved = await api(`/api/tasks/${tasks[0].id}`).then((t) => t.resolvedPrompt).catch(() => undefined);
    }
    return text({
      tasks: tasks.map(brief),
      resolvedPrompt: resolved,
      hint: args.draft
        ? 'A 480p draft; it renders in 1–3 min — check take_status. Judge it on content, not sharpness: its mistakes carry into the final. Once it succeeds, finish_draft renders the same shot in 1080p (within 7 days).'
        : 'Render takes 1–3 min. Check take_status; the video is saved locally automatically.',
    });
  }
);

server.tool(
  'finish_draft',
  "Finish a Seedance 2.5 draft (a take shot with generate_video draft: true) in 1080p. The model renders the SAME shot again at full size: composition, camera path, blocking, timing, faces and sound carry over, fine detail is drawn again — and so are the draft's mistakes. A new 1080p take gives a different video; an upscale works from the draft's pixels alone. Billed as an ordinary 1080p take of the draft's length on 2.5 — about $2.84 per 5 s at 16:9 at list price. Quote it with estimate_cost once the draft has succeeded (its values are the real ones then): model 2.5, resolution 1080p, and duration, ratio and referenceVideoSec from the draft's take_status. The final is a new take in the draft's scene; the draft stays. Possible for 7 days after the draft, on the key it was shot on. A draft has one live final at a time: calling this again returns that final instead of paying twice, while a failed or deleted final can be finished again — and is paid again.",
  { taskId: z.string().describe('id of the draft take (from generate_video, take_status or scene_takes)') },
  async ({ taskId }) => {
    const tasks = await api('/api/tasks');
    const draft = tasks.find((t) => t.id === taskId);
    if (!draft) throw new Error('Take not found.');
    const already = (final) => text({
      tasks: [brief(final)],
      finishOf: taskId,
      alreadyFinished: true,
      hint: 'This draft already has a final — nothing new was rendered or billed. Check take_status.',
    });
    /* Checked here and not only by the studio: this file is what the agent runs whatever
       version the studio is on, and a studio from before the one-final rule would simply
       render — and bill — the same shot a second time. */
    const existing = finalOf(tasks, taskId);
    if (existing) return already(existing);
    try {
      const made = await api('/api/generate', {
        method: 'POST',
        // the draft's id is the whole request; the studio needs the project to file it
        body: JSON.stringify({ projectId: draft.projectId, finishOfTaskId: taskId }),
      });
      return text({
        tasks: made.map(brief),
        finishOf: taskId,
        hint: 'The final renders in 1080p — usually within a couple of minutes. Check take_status.',
      });
    } catch (e) {
      // a finish that got there first — the studio names its final in the refusal
      if (e.code === 'DRAFT_ALREADY_FINISHED' && e.body?.final) return already(e.body.final);
      throw e;
    }
  }
);

/* A local studio in this very folder → the file on disk; anything else → its URL. The url
   and the header are separate fields on purpose: glued into one string the value stops
   being a URL, and a curl built from it fails to parse before it ever asks for the file. */
function mediaLocation(webPath) {
  if (!webPath) return null;
  if (isLocalStudio && STUDIO_DIR) return { file: path.join(STUDIO_DIR, 'data', webPath.replace(/^\//, '')) };
  const url = STUDIO_URL + webPath;
  const auth = STUDIO_TOKEN ? 'Bearer <STUDIO_TOKEN>'
    : STUDIO_PASSWORD ? 'Basic <base64(":" + STUDIO_PASSWORD)>' : null;
  return auth ? { url, auth } : { url };
}

server.tool('take_status', "Take status: queued/running/succeeded/failed + video file, last frame, token spend, and what the take was shot as: model, resolution, ratio, duration and referenceVideoSec (seconds of @clips it was billed for). A Seedance 2.5 draft carries draft: true and final — its live 1080p final, or null; a final carries finishOf, the draft it was made from.", { taskId: z.string() }, async ({ taskId }) => {
  const tasks = await api('/api/tasks');
  const t = tasks.find((x) => x.id === taskId);
  if (!t) throw new Error('Take not found.');
  const p = t.params || {};
  const final = p.draft ? finalOf(tasks, t.id) : undefined;
  // undefined fields drop out of the JSON: a plain take shows none of the draft ones
  return text({
    id: t.id, takeNo: t.takeNo, status: t.status, error: t.error,
    // what it was shot as — all estimate_cost needs to price a draft's final
    model: t.model, resolution: p.resolution, ratio: p.ratio, duration: p.duration,
    referenceVideoSec: t.inputSeconds,
    draft: p.draft,
    final: p.draft ? (final ? brief(final) : null) : undefined,
    finishOf: t.finishOf,
    videoFile: mediaLocation(t.videoFile),
    lastFrame: mediaLocation(t.lastFrame),
    tokens: t.usage?.total_tokens || null,
  });
});

server.tool('scene_takes', "Scene takes (brief, newest first). A Seedance 2.5 draft is marked draft: true; a draft's 1080p final carries finishOf.", { sceneId: z.string() }, async ({ sceneId }) => {
  const tasks = await api('/api/tasks');
  return text(tasks.filter((t) => t.sceneId === sceneId).map((t) => ({
    ...brief(t), starred: t.starred || false,
    draft: t.params?.draft, finishOf: t.finishOf,
    prompt: (t.prompt || '').slice(0, 90),
  })));
});

server.tool('cancel_take', 'Delete a take. A queued BytePlus take is also cancelled at the provider, so its tokens are not burned. Everywhere else this is only a delete: Veo, Omni and Kling accept the render when it is created and have no cancel at all, and a take that is already running cannot be called back on any engine — it is paid for and the file is thrown away.', { taskId: z.string() }, async ({ taskId }) => {
  await api(`/api/tasks/${taskId}`, { method: 'DELETE' });
  return text('Deleted.');
});

server.tool(
  'estimate_cost',
  'Estimate generation cost before running. Seedance is billed in tokens (duration × width × height × 24 / 1024, at a $/M rate that differs per model and resolution); Veo and Kling are billed by the second; Gemini Omni is billed by tokens it decides after the fact, so its figure is a pessimistic guess. A Seedance 2.5 draft (generate_video draft: true) costs exactly a 480p take on 2.5 — price it with that model, not the default; its final (finish_draft) costs a 1080p take on 2.5 of the draft\'s duration and ratio, plus the draft\'s referenceVideoSec from take_status.',
  {
    resolution: z.enum(['360p', '480p', '720p', '1080p', '4K']),
    ratio: z.enum(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']).optional(),
    durationSec: z.number().int().min(3).max(30),
    variants: z.number().int().min(1).max(4).optional(),
    model: z.enum(MODEL_IDS).optional().describe(MODEL_NOTE),
    referenceVideoSec: z.number().min(0).max(30).optional().describe('total length of the @clips the prompt will reference — billed as input seconds on the cheaper video-input column (Seedance only)'),
  },
  async ({ resolution, ratio, durationSec, variants, model, referenceVideoSec }) => {
    const s = await api('/api/state');
  /* The studio's own default, not the first row of the list: the list leads with the
     newest model (2.5) while a take with no model shoots on 2.0 — so an unqualified
     estimate quoted ~1.5x what generate_video would actually spend. */
    const m = s.config.models.find((x) => x.id === model)
      || s.config.models.find((x) => x.default)
      || s.config.models[0];
    /* A price for a render the studio would refuse reads as authoritative as any other,
       and the caller spends the next minute wondering why /api/generate said no. The
       per-branch rate lookups below already stop at a size the model does not have; the
       ceiling on length had nothing checking it at all — 30 s on a 15 s model priced out
       fine. */
    if (m?.resolutions && !m.resolutions.includes(resolution)) return text({ error: noRate(m, resolution) });
    if (m?.maxDuration && durationSec > m.maxDuration) {
      return text({ error: `Cost estimate unavailable — ${m.id} shoots up to ${m.maxDuration} s (asked for ${durationSec}).` });
    }
    /* Not every engine is billed in tokens, and running the BytePlus formula over one that
       is not would quote Seedance's arithmetic for someone else's model. Veo and Kling
       publish a flat rate per second of output — that price is exact, known before the
       render. Kling's sound moves it into another column, and generate_video asks for
       sound by default, so that is the column quoted. */
    if (m?.billing === 'videoSeconds') {
      const rates = m.secondRatesAudio || m.secondRates;
      const rate = m.resolutions?.includes(resolution) ? rates?.[resolution] : null;
      if (!rate) return text({ error: noRate(m, resolution) });
      const seconds = Math.min(m.maxDuration || durationSec, Math.max(m.minDuration || 0, durationSec));
      return text({
        model: m.id, billing: 'per second of video', pricePerSecond: rate, seconds,
        estimatedUSD: Number((rate * seconds * (variants || 1)).toFixed(2)), exact: true,
      });
    }
    /* Omni's bill comes from tokens the model decides after the fact: two identical runs
       were charged $0.34 and $1.01. The studio quotes the higher observed rate, and so
       does this — under-promising by a factor of three is the worse mistake. */
    if (m?.billing === 'videoTokens') {
      const tokens = m.resolutions?.includes(resolution) ? m.videoTokensPerRender?.[resolution] : null;
      if (!tokens) return text({ error: noRate(m, resolution) });
      return text({
        model: m.id, billing: 'per render, tokens decided by the model', tokens,
        pricePerMillion: m.videoTokenPrice,
        estimatedUSD: Number(((tokens / 1e6) * (m.videoTokenPrice || 17.5) * (variants || 1)).toFixed(2)),
        exact: false,
        note: 'Length barely moves this number and the real bill arrives with the take; the figure above is the pessimistic end of what has been measured.',
      });
    }
    if (m?.billing) {
      return text({ error: `Cost estimate unavailable — ${m.id} is billed as "${m.billing}", which this tool cannot compute. Shoot it and read the take's own cost.` });
    }
    // BytePlus prices some resolutions apart (2.0: 7.7 at 1080p, 4.0 at 4K; 2.5: 11.7 at
    // 1080p), so take the per-resolution rate when the studio reports one.
    /* A take with reference clips is billed on the video-input column — cheaper per
       million, but the clips' own seconds are paid for on top of the take's. */
    const withVideo = Number(referenceVideoSec) > 0;
    const listRate = withVideo
      ? (m?.videoRates?.[resolution] ?? m?.videoPricePerMillion ?? s.config.priceVideoPerMillion)
      : (m?.rates?.[resolution] ?? m?.pricePerMillion ?? s.config.pricePerMillion);
    // A limited-time provider discount is what the render will actually be billed at while
    // it runs; the studio reports the windows so the estimate cannot quote a stale price.
    const promo = (s.config.promos || []).find((p) =>
      p.models.includes(m?.id)
      && (!p.resolutions || p.resolutions.includes(resolution))
      && Date.now() >= Date.parse(p.from) && Date.now() < Date.parse(p.until));
    const pricePerMillion = promo ? listRate * (1 - promo.off) : listRate;
    // a model may carry its own pixel map (2.5 differs from the 2.0 series at 480p)
    const dims = (m?.pixels || s.config.pixels)?.[resolution]?.[ratio || '16:9'];
    if (!dims) return text({ error: `Cost estimate unavailable — the studio did not report pixel dimensions for ${resolution}/${ratio || '16:9'} (update the studio).` });
    const [w, h] = dims;
    const tokens = Math.round(((Number(referenceVideoSec) || 0) + durationSec) * w * h * 24 / 1024);
    const cost = (tokens / 1e6) * pricePerMillion * (variants || 1);
    return text({
      tokens, estimatedUSD: Number(cost.toFixed(2)), pricePerMillion, model: m?.id,
      ...(withVideo ? { referenceVideoSec, note: 'Reference clips are billed as input seconds on the video-input column.' } : {}),
      ...(promo ? { promo: { off: `${Math.round(promo.off * 100)}%`, until: promo.until, listPricePerMillion: listRate } } : {}),
    });
  }
);

(async () => {
  await server.connect(new StdioServerTransport());
})();
