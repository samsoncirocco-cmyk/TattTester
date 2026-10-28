# Council Enhance

> Directive for running AI Council prompt enhancement on a tattoo idea

## Goal

Transform a short user tattoo idea (e.g., "dragon sleeve") into three progressively detailed prompts (simple, detailed, ultra) plus a negative prompt, using the LLM Council pipeline with automatic provider fallback.

## When to Use

- Before calling **generate-design.md** to produce higher-quality images
- Testing the council enhancement pipeline end-to-end
- Verifying LLM provider credentials (Vertex AI, OpenRouter)
- Debugging the fallback chain behavior

## Prerequisites

- Next.js dev server running (`npm run dev`)
- At least one LLM provider configured (or use Demo Mode):
  - **Vertex AI (preferred)**: `NEXT_PUBLIC_VERTEX_AI_PROJECT_ID` or `GCP_PROJECT_ID`, plus service account credentials (`GOOGLE_APPLICATION_CREDENTIALS_JSON` or `GCP_SERVICE_ACCOUNT_EMAIL` + `GCP_PRIVATE_KEY`)
  - **OpenRouter**: `OPENROUTER_API_KEY` and `NEXT_PUBLIC_USE_OPENROUTER=true`
  - **Demo Mode**: `NEXT_PUBLIC_COUNCIL_DEMO_MODE=true` (no LLM calls, uses hardcoded mock responses)
  - **External Council API**: `NEXT_PUBLIC_COUNCIL_API_URL` (default: `http://localhost:8001/api`)
- Auth token: `NEXT_PUBLIC_AUTH_TOKEN` or `FRONTEND_AUTH_TOKEN`

## Steps

1. Start the dev server if not running:

   ```bash
   npm run dev
   ```

2. Send an enhancement request:

   ```bash
   curl -X POST http://localhost:3000/api/v1/council/enhance \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer YOUR_AUTH_TOKEN" \
     -d '{
       "user_prompt": "samurai fighting a dragon in Japanese style",
       "style": "Japanese",
       "body_part": "forearm",
       "complexity": "medium",
       "isStencilMode": false
     }'
   ```

3. The API route (`src/app/api/v1/council/enhance/route.ts`) validates the request (prompt must be >= 3 chars) and calls `enhancePrompt()` from `src/services/councilService.ts`.

4. The enhancement service follows this **fallback chain**:

   | Priority | Provider | Condition | Model | Cost |
   |----------|----------|-----------|-------|------|
   | 1 | Vertex AI | `NEXT_PUBLIC_VERTEX_AI_ENABLED !== 'false'` and credentials configured | `gemini-2.0-flash-exp` | ~$0 (free tier) |
   | 2 | OpenRouter | `NEXT_PUBLIC_USE_OPENROUTER === 'true'` and key set | Legacy: 3 models serial (see below). Typed path (`TYPESAFE_COUNCIL=true`): one current model | ~$0.08 legacy / ~$0.0014 typed |
   | 3 | Demo Mode | `NEXT_PUBLIC_COUNCIL_DEMO_MODE === 'true'` | Mock responses | $0 |
   | 4 | External API | Fallback to `COUNCIL_API_URL/prompt-generation` | Varies | Varies |
   | 5 | Mock fallback | All above fail | Hardcoded templates | $0 |

5. **OpenRouter council** (priority 2), two modes:
   - **Typed** (`TYPESAFE_COUNCIL=true` and `TYPESAFE_API_KEY` set): one generator (`COUNCIL_GENERATOR_MODEL`, default `google/gemini-2.5-flash`, or Vertex `GEMINI_MODEL` when that lane is configured) writes simple/detailed/ultra and the negative prompt. One TypeSafe `jev-latest` call scores the draft, chooses the image model, and checks two hazards. A low score or low confidence regenerates once. Timeout, HTTP error, missing key, or a repeated text/brand hazard falls through to the legacy path below.
   - **Legacy** (flag off, or TypeSafe unavailable) — serial, outdated ids kept for rollback:
     - Creative Director: `anthropic/claude-3.5-sonnet` (~$0.03) — artistic vision
     - Technical Expert: `openai/gpt-4-turbo` (~$0.03) — tattoo feasibility, also generates negative prompt
     - Style Specialist: `google/gemini-1.5-pro` (~$0.02) — style authenticity

6. After LLM generation, the service applies the **Council Skill Pack** (`councilSkillPack.ts`):
   - Anatomical flow tokens based on `bodyPart`
   - Aesthetic anchors appended to all prompt levels
   - Character detection and positional anchoring (for multi-character designs)
   - Stencil mode negative shield (blocks shading/gradients)

7. Response includes model selection from `styleModelMapping.ts` for optimal image generation model.

## Expected Output

```json
{
  "prompts": {
    "simple": "A Japanese style tattoo of a samurai fighting a dragon with clean lines...",
    "detailed": "A Japanese style tattoo featuring a samurai warrior in dynamic combat with a dragon, rendered with intricate linework...",
    "ultra": "A photorealistic Japanese style tattoo featuring a samurai warrior locked in battle with a serpentine dragon, masterfully composed for forearm placement..."
  },
  "negativePrompt": "blurry, low quality, distorted, watermark, text, signature...",
  "modelSelection": {
    "modelId": "imagen-3.0-generate-001",
    "modelName": "Imagen 3",
    "reasoning": "Best for detailed Japanese style",
    "estimatedTime": "5s",
    "cost": 0.02,
    "isFallback": false
  },
  "metadata": {
    "userIdea": "samurai fighting a dragon in Japanese style",
    "style": "Japanese",
    "bodyPart": "forearm",
    "provider": "vertex-ai",
    "enhancementTime": 2400,
    "generatedAt": "2025-01-15T..."
  }
}
```

## Edge Cases

- **All providers fail**: The service falls through to hardcoded mock responses. Output will still be valid but generic. Check `metadata.fallback: true` in the response.
- **OpenRouter rate limit**: Each council member call has its own retry. If one member fails, the entire OpenRouter path fails and falls through to the next provider.
- **Vertex AI auth**: The council API route (`runtime = 'nodejs'`) authenticates via `src/lib/google-auth-edge.ts` (`getGcpAccessToken`), not `google-auth-library`. Ensure credentials are available as env vars (`GOOGLE_APPLICATION_CREDENTIALS_JSON` or `GCP_SERVICE_ACCOUNT_EMAIL` + `GCP_PRIVATE_KEY`), not only file paths.
- **Character detection**: The service scans the prompt for known character names from `characterDatabase.ts`. Multi-character prompts get forced positional anchoring ("Character A on the left, Character B on the right").
- **Stencil mode**: Auto-detected from keywords in the prompt, or explicitly passed via `isStencilMode`. When active, the negative prompt gets a shield blocking shading and gradients.
- **JSON parse failure**: If the LLM returns malformed JSON, the service uses a brace-depth parser (`parseJsonFromText`) to extract the first valid JSON object. If that also fails, the provider path throws and falls through.
- **Demo mode delay**: Demo mode introduces a 3.2-second artificial delay to simulate real council discussion. This is intentional for UI testing.

## Cost

**Vertex AI path (recommended)**: Gemini 2.0 Flash is currently free or extremely low cost. Estimated $0 per call.

**OpenRouter legacy path**: ~$0.08 per enhancement in the service's flat sum (4 API calls across 3 models: creative, technical for detailed, style for ultra, technical for negative prompt). The flat sum counts the technical model once. A token-priced estimate of all four calls is ~$0.034. Per member:
- Creative Director (Claude 3.5 Sonnet): ~$0.03
- Technical Expert (GPT-4 Turbo): ~$0.03
- Style Specialist (Gemini 1.5 Pro): ~$0.02

**Typed path** (`TYPESAFE_COUNCIL=true`): 1 generator call (~$0.0013 at Gemini 2.5 Flash list price) + 1 Jev judge call (~$0.00007, input-only). A regeneration is those two calls again. `scripts/benchmark-council-typesafe.mjs` prints the comparison. The enhance route's budget debit is unchanged.

**Demo/Mock path**: $0 (no external API calls).

## Related Directives

- After enhancement, pass the `ultra` prompt to **generate-design.md** for image generation
- **api-endpoints.md** — API reference for `POST /api/v1/council/enhance`
- Ensure **import-artists.md** has been run if the council references artist style data
