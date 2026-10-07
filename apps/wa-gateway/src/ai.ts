// Optional AI for Digital Volunteer: Anthropic API or Amazon Bedrock, chosen by a
// super admin in Setu (Settings > AI). The keys live in public.dv_ai_settings, which
// only this gateway (service role) can read. The old environment variables
// (AWS_REGION + BEDROCK_MODEL_ID + AWS keys) still work when nothing is set in Setu.
//
// What AI may do:
//   * classify - work out what an unclear (often Hinglish) message asks, and which
//     reply rule or course it means. The reply itself is still built from Setu data.
//   * draft    - when nothing in Setu answers a question, draft a short reply using
//     ONLY facts taken from Setu. A draft always waits for a person to approve it
//     (in the inbox or by SEND/EDIT/SKIP on WhatsApp); the database enforces that.
// It is never given lead data or permissions. Any failure means "a person decides".
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod/v4';
import type { DvIntent } from '@crm/shared';

type Settings = {
  provider: 'none' | 'anthropic' | 'bedrock';
  anthropic_api_key: string | null;
  anthropic_model: string;
  bedrock_region: string | null;
  bedrock_model_id: string | null;
  aws_access_key_id: string | null;
  aws_secret_access_key: string | null;
  /** A Bedrock API key ("long-term API key"), used instead of the IAM keys when set. */
  bedrock_api_key?: string | null;
  classify_enabled: boolean;
  draft_enabled: boolean;
};

let settings: Settings | null = null;
let loadedAt = 0;
let anthropic: Anthropic | null = null;
let bedrock: BedrockRuntimeClient | null = null;
let clientKey = '';

/** Reads the settings at most once a minute (or now, when forced) and (re)creates the client if they changed. */
export async function loadAiSettings(db: SupabaseClient, force = false): Promise<void> {
  if (!force && settings && Date.now() - loadedAt < 60_000) return;
  const { data } = await db.from('dv_ai_settings').select('*').eq('id', true).maybeSingle();
  let s = (data as Settings | null) ?? null;
  // Fallback: Bedrock configured only through environment variables (older setups).
  if ((!s || s.provider === 'none') && process.env.AWS_REGION?.trim() && process.env.BEDROCK_MODEL_ID?.trim()) {
    s = {
      provider: 'bedrock',
      anthropic_api_key: null,
      anthropic_model: 'claude-opus-5-5',
      bedrock_region: process.env.AWS_REGION.trim(),
      bedrock_model_id: process.env.BEDROCK_MODEL_ID.trim(),
      aws_access_key_id: null, // the AWS SDK reads AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY itself
      aws_secret_access_key: null,
      classify_enabled: true,
      draft_enabled: s?.draft_enabled ?? false,
    };
  }
  settings = s;
  loadedAt = Date.now();

  const key = JSON.stringify([s?.provider, s?.anthropic_api_key, s?.bedrock_region, s?.aws_access_key_id, s?.aws_secret_access_key, s?.bedrock_api_key]);
  if (key === clientKey) return;
  clientKey = key;
  anthropic = s?.provider === 'anthropic' && s.anthropic_api_key ? new Anthropic({ apiKey: s.anthropic_api_key, timeout: 30_000, maxRetries: 1 }) : null;
  bedrock =
    s?.provider === 'bedrock' && s.bedrock_region
      ? new BedrockRuntimeClient({
          region: s.bedrock_region,
          // A Bedrock API key is sent as a bearer token; otherwise IAM keys (or the environment).
          ...(s.bedrock_api_key
            ? { token: { token: s.bedrock_api_key }, authSchemePreference: ['httpBearerAuth'] }
            : s.aws_access_key_id && s.aws_secret_access_key
              ? { credentials: { accessKeyId: s.aws_access_key_id, secretAccessKey: s.aws_secret_access_key } }
              : {}),
        })
      : null;
}

const ready = () => (settings?.provider === 'anthropic' && !!anthropic) || (settings?.provider === 'bedrock' && !!bedrock && !!settings.bedrock_model_id);
export const aiClassifyEnabled = () => ready() && !!settings?.classify_enabled;
export const aiDraftEnabled = () => ready() && !!settings?.draft_enabled;

/** One request. With a schema the answer is validated JSON; otherwise plain text. Null on any failure. */
async function complete<T>(system: string, user: string, schema: z.ZodType<T> | null, maxTokens: number): Promise<T | string | null> {
  if (!settings) return null;
  try {
    if (settings.provider === 'anthropic' && anthropic) {
      const model = settings.anthropic_model || 'claude-opus-5-5';
      // Quick, routine work: low effort. Haiku models don't take an effort setting.
      const effort = model.startsWith('claude-haiku') ? {} : { effort: 'low' as const };
      if (schema) {
        const res = await anthropic.messages.parse({
          model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: user }],
          output_config: { format: zodOutputFormat(schema), ...effort },
        });
        if (res.stop_reason === 'refusal') return null;
        return res.parsed_output ?? null;
      }
      const res = await anthropic.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
        ...(Object.keys(effort).length ? { output_config: effort } : {}),
      });
      if (res.stop_reason === 'refusal') return null;
      const text = res.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
      return text || null;
    }
    if (settings.provider === 'bedrock' && bedrock && settings.bedrock_model_id) {
      const res = await bedrock.send(
        new ConverseCommand({
          modelId: settings.bedrock_model_id,
          system: [{ text: schema ? `${system}\nReply with JSON only, no other text.` : system }],
          messages: [{ role: 'user', content: [{ text: user }] }],
          inferenceConfig: { maxTokens },
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      const out = res.output?.message?.content?.map((c) => c.text ?? '').join('').trim() ?? '';
      if (!schema) return out || null;
      const parsed = schema.safeParse(JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)));
      return parsed.success ? parsed.data : null;
    }
  } catch (e) {
    lastError = (e as Error).message;
  }
  return null;
}
let lastError: string | null = null;

const Classification = z.object({
  intent: z.enum(['course_info', 'seva_request', 'rule', 'question', 'none']),
  rule: z.number().int().nullable(),
  courses: z.array(z.number().int()),
});

export interface AiClassification {
  /** 'question' = a real question that no rule or course answer covers (may get a draft). */
  intent: DvIntent | 'question' | 'rule';
  courseIds: string[];
  ruleIndex: number | null;
}

/** What an unclear message asks. Null when AI is off, fails, or isn't sure. */
export async function classifyWithAi(
  text: string,
  courses: { id: string; name: string }[],
  rules: { name: string; keywords: string[] }[],
): Promise<AiClassification | null> {
  if (!aiClassifyEnabled()) return null;
  const courseList = courses.map((c, i) => `${i + 1}. ${c.name}`).join('\n') || '(none)';
  const ruleList = rules.map((r, i) => `${i + 1}. ${r.name} (words like: ${r.keywords.slice(0, 6).join(', ')})`).join('\n') || '(none)';
  const system =
    'You sort WhatsApp messages sent to an Art of Living volunteer group or its WhatsApp number. ' +
    'Messages may be in English, Hindi or Hinglish. Choose one intent:\n' +
    '- rule: the message clearly asks what one of the numbered topics below covers (set "rule" to its number).\n' +
    '- course_info: asks about courses or programs - dates, timings, venue, registration, fees (set "courses" to the numbers it refers to).\n' +
    '- seva_request: offers to volunteer, or asks for contact numbers / leads to call.\n' +
    '- question: another real question someone at the centre should answer.\n' +
    '- none: greetings, thanks, chit-chat, forwards, or anything unclear.\n' +
    'When unsure, choose none. Use null / [] when a field does not apply.';
  const r = await complete(system, `Topics:\n${ruleList}\n\nCourses:\n${courseList}\n\nMessage:\n${text.slice(0, 1000)}`, Classification, 2000);
  if (!r || typeof r === 'string') return null;
  const ruleIndex = r.intent === 'rule' && r.rule && r.rule >= 1 && r.rule <= rules.length ? r.rule - 1 : null;
  return {
    intent: r.intent === 'rule' && ruleIndex === null ? 'none' : r.intent,
    courseIds: r.courses.map((n) => courses[n - 1]?.id).filter((x): x is string => !!x),
    ruleIndex,
  };
}

/**
 * A short reply drafted only from `facts`. Null when drafting is off or fails.
 * The database never sends a draft without a person's approval.
 */
export async function draftReply(text: string, facts: string): Promise<string | null> {
  if (!aiDraftEnabled()) return null;
  const system =
    'You draft WhatsApp replies for an Art of Living centre. A volunteer checks every draft before it is sent.\n' +
    'Rules:\n' +
    '- Use ONLY the facts provided. Never invent or guess dates, times, venues, fees, links, phone numbers or names.\n' +
    '- If the facts do not answer the question, say kindly that a volunteer will reply soon.\n' +
    '- Answer in the same language and style as the message (English, Hindi or Hinglish).\n' +
    '- Keep it short and warm: at most 80 words, plain text (WhatsApp *bold* is fine). No sign-off.';
  const r = await complete(system, `Facts from Setu:\n${facts || '(no facts available)'}\n\nMessage to answer:\n${text.slice(0, 1000)}`, null, 4000);
  if (typeof r !== 'string') return null;
  return r.trim().slice(0, 1500) || null;
}

/** For Settings > Test AI: one tiny real call with the saved settings. */
export async function testAi(db: SupabaseClient): Promise<{ ok: boolean; result: string }> {
  await loadAiSettings(db, true);
  if (!settings || settings.provider === 'none') return { ok: false, result: 'AI is switched off (choose Anthropic or Amazon Bedrock).' };
  if (!ready()) return { ok: false, result: 'The AI settings are incomplete.' };
  lastError = null;
  const r = await complete('Reply with the single word: OK', 'Test', null, 1000);
  const model = settings.provider === 'anthropic' ? settings.anthropic_model : settings.bedrock_model_id;
  if (typeof r === 'string') return { ok: true, result: `Working: ${settings.provider === 'anthropic' ? 'Anthropic' : 'Amazon Bedrock'} · ${model}` };
  return { ok: false, result: `Not working: ${(lastError ?? 'no answer').slice(0, 300)}` };
}
