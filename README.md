# longtake-mcp

MCP server for [Longtake Studio](https://longtake.studio) — an AI video studio that runs on **your own API key**. With this server an AI agent (Claude Code, Codex, Cursor, any MCP client) can set up a production, cast characters with a locked voice, shoot takes on Seedance 2.0 / 2.5, Veo 3.1, Gemini Omni or Kling 3.0, draft cheaply and finish in 1080p, and read back the cost of every render.

Renders launched by an agent are billed exactly like clicks in the studio: the model provider (BytePlus, Google, Kling, fal.ai) charges your own key at its list price. Agent access itself is neither metered nor marked up.

> Longtake is the name of the software. It is not the cinematography term "long take" — though that is where the name comes from: one take of one scene is the unit of work.

## What the agent gets — 13 tools

| Tool | What it does |
|---|---|
| `studio_overview` | Projects, episodes, scenes, characters and assets — the whole studio at a glance |
| `create_project` · `create_folder` · `create_scene` | The production structure: project → episode → scene |
| `create_character` | Cast a character with a portrait and a locked voice sample; the studio screen-tests the portrait against moderation |
| `generate_mocap` | A four-view character sheet (Seedream / Nano Banana Pro) |
| `upload_asset` | Reference images, audio and video clips for the project library |
| `estimate_cost` | The price of a take before it is shot — model, resolution, length, reference clips |
| `generate_video` | Shoot a take; `@names` in the prompt resolve to characters and assets; `draft: true` shoots a Seedance 2.5 draft |
| `finish_draft` | Finish a Seedance 2.5 draft in 1080p — the same take, rendered sharper |
| `take_status` · `scene_takes` | Status, file, token spend and what a take was shot as |
| `cancel_take` | Delete a take (a queued BytePlus render is cancelled at the provider) |

## Setup

1. **Issue a token.** In the studio: account menu → **API keys** → **Agent access — MCP** → create. It is shown once and can be revoked alone.
2. **Get the server.**

   ```bash
   git clone https://github.com/svatrous/longtake-mcp.git
   cd longtake-mcp && npm install
   ```

3. **Register it with your agent.** For Claude Code:

   ```bash
   claude mcp add longtake \
     -e STUDIO_URL=https://longtake.studio \
     -e STUDIO_TOKEN=cf_your_token \
     -- node /path/to/longtake-mcp/mcp-server.js
   ```

   Any other MCP client takes the same command and the same two environment variables. As JSON (Cursor, Codex, Claude Desktop):

   ```json
   {
     "mcpServers": {
       "longtake": {
         "command": "node",
         "args": ["/path/to/longtake-mcp/mcp-server.js"],
         "env": { "STUDIO_URL": "https://longtake.studio", "STUDIO_TOKEN": "cf_your_token" }
       }
     }
   }
   ```

The full guide, with what the token can and cannot do, is at [longtake.studio/mcp](https://longtake.studio/mcp). Prompt-writing skills for the same agent (Seedance 2.0, Seedance 2.5, Gemini Omni, character sheets) are at [longtake.studio/skills](https://longtake.studio/skills).

## Safety

The token acts as your account for the work: it shoots takes on your provider keys, inside your rate limits. It cannot read or change those keys, issue or revoke tokens, or touch billing — those routes turn an agent token away. Everything else you can do it can do too, including deleting a project, so keep it out of shared configs and revoke it in the same dialog if it leaks.

## License

MIT. This file is a copy of the studio's own `mcp-server.js`; the studio also serves it as [longtake.studio/mcp-server.cjs](https://longtake.studio/mcp-server.cjs).
