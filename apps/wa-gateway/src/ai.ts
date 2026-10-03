// Optional AI classification through Amazon Bedrock (Claude).
//
// Used only when keyword rules found nothing in a question-like message. The
// model *classifies*: it never writes the reply, so it cannot invent dates,
// venues or links - replies are always built from CRM data. It is never told
// lead data or permissions, and its answer is validated before use.
//
// Enabled when AWS_REGION, BEDROCK_MODEL_ID and AWS credentials are set
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or any standard AWS credential source).
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import type { DvIntent } from '@crm/shared';

const region = process.env.AWS_REGION?.trim();
const modelId = process.env.BEDROCK_MODEL_ID?.trim();
const client = region && modelId ? new BedrockRuntimeClient({ region }) : null;

export const aiEnabled = () => client !== null;

export interface AiClassification {
  intent: DvIntent;
  courseIds: string[];
}

/** Returns null when AI is off, times out, or answers with anything unexpected. */
export async function classifyWithAi(text: string, courses: { id: string; name: string }[]): Promise<AiClassification | null> {
  if (!client || !modelId) return null;
  const list = courses.map((c, i) => `${i + 1}. ${c.name}`).join('\n');
  const system =
    'You classify WhatsApp messages sent to an Art of Living volunteer group. ' +
    'Messages may be in English, Hindi or Hinglish. Reply with JSON only, no prose: ' +
    '{"intent":"course_info"|"seva_request"|"none","courses":[numbers]}. ' +
    'course_info = asking about courses, programs, dates, timings, venue, registration. ' +
    'seva_request = offering to volunteer or asking for contact numbers to call. ' +
    'none = anything else (greetings, thanks, chit-chat, unclear). When unsure, answer none. ' +
    '"courses" lists the numbers of courses from the list that the message clearly refers to, else [].';
  try {
    const res = await client.send(
      new ConverseCommand({
        modelId,
        system: [{ text: system }],
        messages: [{ role: 'user', content: [{ text: `Courses:\n${list || '(none)'}\n\nMessage:\n${text.slice(0, 1000)}` }] }],
        inferenceConfig: { maxTokens: 60, temperature: 0 },
      }),
      { abortSignal: AbortSignal.timeout(8_000) },
    );
    const out = res.output?.message?.content?.map((c) => c.text ?? '').join('') ?? '';
    const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { intent?: string; courses?: unknown };
    if (json.intent !== 'course_info' && json.intent !== 'seva_request' && json.intent !== 'none') return null;
    const nums = Array.isArray(json.courses) ? json.courses.filter((x): x is number => Number.isInteger(x)) : [];
    return { intent: json.intent, courseIds: nums.map((n) => courses[n - 1]?.id).filter((x): x is string => !!x) };
  } catch {
    return null; // AI is an optional helper: failures fall back to "a person decides"
  }
}
