'use client';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { FormMessage, type ActionState } from '@/components/form';
import { Alert, Button, Field, Input, Select } from '@/components/ui';
import { saveAiSettings, testAiSettings } from './ai-actions';

export type AiSettings = {
  provider: 'none' | 'anthropic' | 'bedrock';
  anthropic_model: string;
  anthropic_key_hint: string | null;
  bedrock_region: string | null;
  bedrock_model_id: string | null;
  aws_key_hint: string | null;
  aws_secret_set: boolean;
  classify_enabled: boolean;
  draft_enabled: boolean;
  ask_on_whatsapp: 'ai' | 'all' | 'none';
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_result: string | null;
};

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (recommended)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 (lower cost)' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (lowest cost)' },
];

export function AiSettingsForm({ s }: { s: AiSettings }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [state, setState] = useState<ActionState | undefined>();
  const [provider, setProvider] = useState(s.provider);
  const [model, setModel] = useState(s.anthropic_model || 'claude-opus-5-5');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [region, setRegion] = useState(s.bedrock_region ?? 'ap-south-1');
  const [bedrockModel, setBedrockModel] = useState(s.bedrock_model_id ?? '');
  const [awsKeyId, setAwsKeyId] = useState('');
  const [awsSecret, setAwsSecret] = useState('');
  const [classify, setClassify] = useState(s.classify_enabled);
  const [draft, setDraft] = useState(s.draft_enabled);
  const [ask, setAsk] = useState(s.ask_on_whatsapp);
  const [clearAnthropic, setClearAnthropic] = useState(false);
  const [clearAws, setClearAws] = useState(false);
  // Waiting for the gateway's test result: refresh until last_test_at changes (max ~40 s).
  const [testingSince, setTestingSince] = useState<string | null | undefined>(undefined);

  const waiting = testingSince !== undefined && s.last_test_at === testingSince;

  useEffect(() => {
    if (!waiting) return;
    const tick = setInterval(() => router.refresh(), 2000);
    const stop = setTimeout(() => setTestingSince(undefined), 40_000);
    return () => {
      clearInterval(tick);
      clearTimeout(stop);
    };
  }, [waiting, router]);

  function save() {
    start(async () => {
      const r = await saveAiSettings({
        provider,
        anthropic_model: model,
        bedrock_region: region,
        bedrock_model_id: bedrockModel,
        classify_enabled: classify,
        draft_enabled: draft,
        ask_on_whatsapp: ask,
        anthropic_key: anthropicKey,
        aws_key_id: awsKeyId,
        aws_secret: awsSecret,
        clear_anthropic_key: clearAnthropic,
        clear_aws_keys: clearAws,
      });
      setState(r);
      if (r.ok) {
        setAnthropicKey('');
        setAwsKeyId('');
        setAwsSecret('');
        setClearAnthropic(false);
        setClearAws(false);
        router.refresh();
      }
    });
  }

  function test() {
    start(async () => {
      const r = await testAiSettings();
      setState(r);
      if (r.ok) setTestingSince(s.last_test_at);
    });
  }

  return (
    <div className="space-y-5 text-sm">
      <Field label="AI service" htmlFor="ai-provider">
        <Select id="ai-provider" value={provider} onChange={(e) => setProvider(e.target.value as AiSettings['provider'])} className="max-w-sm">
          <option value="none">Off (keyword rules only)</option>
          <option value="anthropic">Anthropic API</option>
          <option value="bedrock">Amazon Bedrock</option>
        </Select>
      </Field>

      {provider === 'anthropic' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Anthropic API key"
            htmlFor="ai-key"
            hint={s.anthropic_key_hint ? `Saved: ••••${s.anthropic_key_hint}. Leave empty to keep it.` : 'From console.anthropic.com → API keys.'}
          >
            <Input id="ai-key" type="password" autoComplete="off" value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} placeholder="sk-ant-…" />
          </Field>
          <Field label="Model" htmlFor="ai-model">
            <Select id="ai-model" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </Select>
          </Field>
          {s.anthropic_key_hint ? (
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={clearAnthropic} onChange={(e) => setClearAnthropic(e.target.checked)} className="size-4 accent-accent" />
              Remove the saved key
            </label>
          ) : null}
        </div>
      ) : null}

      {provider === 'bedrock' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="AWS region" htmlFor="ai-region" hint="e.g. ap-south-1 (Mumbai)">
            <Input id="ai-region" value={region} onChange={(e) => setRegion(e.target.value)} />
          </Field>
          <Field label="Model / inference profile id" htmlFor="ai-bmodel" hint="Copy it from the Bedrock console.">
            <Input id="ai-bmodel" value={bedrockModel} onChange={(e) => setBedrockModel(e.target.value)} />
          </Field>
          <Field label="AWS access key id" htmlFor="ai-akid" hint={s.aws_key_hint ? `Saved: ••••${s.aws_key_hint}. Leave empty to keep it.` : 'An IAM user allowed only bedrock:InvokeModel.'}>
            <Input id="ai-akid" autoComplete="off" value={awsKeyId} onChange={(e) => setAwsKeyId(e.target.value)} />
          </Field>
          <Field label="AWS secret access key" htmlFor="ai-secret" hint={s.aws_secret_set ? 'Saved. Leave empty to keep it.' : undefined}>
            <Input id="ai-secret" type="password" autoComplete="off" value={awsSecret} onChange={(e) => setAwsSecret(e.target.value)} />
          </Field>
          {s.aws_key_hint || s.aws_secret_set ? (
            <label className="flex items-center gap-2 sm:col-span-2">
              <input type="checkbox" checked={clearAws} onChange={(e) => setClearAws(e.target.checked)} className="size-4 accent-accent" />
              Remove the saved AWS keys
            </label>
          ) : null}
        </div>
      ) : null}

      {provider !== 'none' ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 font-medium">What AI may do</legend>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={classify} onChange={(e) => setClassify(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
            <span>
              Understand unclear messages
              <span className="block text-ink-muted">Works out what Hinglish or vague messages ask, and which rule or course they mean. Replies still come from Setu.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} className="mt-0.5 size-4 accent-accent" />
            <span>
              Draft replies when Setu has no answer
              <span className="block text-ink-muted">Only from Setu&apos;s courses, sessions and rule replies. A draft is never sent until a person approves it.</span>
            </span>
          </label>
        </fieldset>
      ) : null}

      <Field label="Send suggested replies to approvers on WhatsApp" htmlFor="ai-ask" hint="Approvers are chosen on Digital Volunteer → WhatsApp account. They reply SEND 12, EDIT 12 text or SKIP 12.">
        <Select id="ai-ask" value={ask} onChange={(e) => setAsk(e.target.value as AiSettings['ask_on_whatsapp'])} className="max-w-sm">
          <option value="ai">AI drafts only</option>
          <option value="all">Every suggested reply</option>
          <option value="none">None (approve in the inbox only)</option>
        </Select>
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={save}>
          {pending ? 'Saving…' : 'Save AI settings'}
        </Button>
        {s.provider !== 'none' ? (
          <Button variant="secondary" disabled={pending || waiting} onClick={test}>
            {waiting ? 'Testing…' : 'Test'}
          </Button>
        ) : null}
      </div>
      <FormMessage state={state} />
      {s.last_test_result && !waiting ? (
        <Alert tone={s.last_test_ok ? 'ok' : 'danger'}>{s.last_test_result}</Alert>
      ) : null}
      <p className="text-xs text-ink-muted">
        Keys are stored where only the WhatsApp gateway can read them; this page never shows them again, only their last 4 characters.
      </p>
    </div>
  );
}
