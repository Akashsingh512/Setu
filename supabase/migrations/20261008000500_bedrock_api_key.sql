-- Amazon Bedrock API keys ("Generate long-term API key" in the Bedrock console) as an
-- alternative to an IAM access key + secret. Stored like the other AI keys: readable
-- only by the WhatsApp gateway (service role); the app only sees its last 4 characters.

alter table public.dv_ai_settings add column bedrock_api_key text;

create or replace function public.dv_ai_settings_get()
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s public.dv_ai_settings;
begin
  if not private.is_super_admin() then
    raise exception 'Only a super admin can see AI settings' using errcode = '42501';
  end if;
  select * into s from public.dv_ai_settings where id;
  -- Never the keys themselves: whether they are set, and their last 4 characters.
  return jsonb_build_object(
    'provider', s.provider,
    'anthropic_model', s.anthropic_model,
    'anthropic_key_hint', case when s.anthropic_api_key is not null then right(s.anthropic_api_key, 4) end,
    'bedrock_region', s.bedrock_region,
    'bedrock_model_id', s.bedrock_model_id,
    'aws_key_hint', case when s.aws_access_key_id is not null then right(s.aws_access_key_id, 4) end,
    'aws_secret_set', s.aws_secret_access_key is not null,
    'bedrock_api_key_hint', case when s.bedrock_api_key is not null then right(s.bedrock_api_key, 4) end,
    'classify_enabled', s.classify_enabled,
    'draft_enabled', s.draft_enabled,
    'ask_on_whatsapp', s.ask_on_whatsapp,
    'last_test_at', s.last_test_at,
    'last_test_ok', s.last_test_ok,
    'last_test_result', s.last_test_result,
    'updated_at', s.updated_at);
end;
$$;

drop function public.dv_ai_settings_save(text, text, text, text, boolean, boolean, text, text, text, text);

create function public.dv_ai_settings_save(
  p_provider text, p_anthropic_model text, p_bedrock_region text, p_bedrock_model_id text,
  p_classify boolean, p_draft boolean, p_ask_on_whatsapp text,
  p_anthropic_key text default null, p_aws_key_id text default null, p_aws_secret text default null,
  p_bedrock_api_key text default null
) returns void
language plpgsql security definer set search_path = '' as $$
declare
  s public.dv_ai_settings;
begin
  if not private.is_super_admin() then
    raise exception 'Only a super admin can change AI settings' using errcode = '42501';
  end if;
  if p_provider not in ('none', 'anthropic', 'bedrock') then
    raise exception 'Unknown AI provider' using errcode = '22023';
  end if;
  update public.dv_ai_settings
     set provider = p_provider,
         anthropic_model = coalesce(nullif(btrim(p_anthropic_model), ''), 'claude-opus-5-5'),
         bedrock_region = nullif(btrim(p_bedrock_region), ''),
         bedrock_model_id = nullif(btrim(p_bedrock_model_id), ''),
         classify_enabled = coalesce(p_classify, classify_enabled),
         draft_enabled = coalesce(p_draft, draft_enabled),
         ask_on_whatsapp = coalesce(p_ask_on_whatsapp, ask_on_whatsapp),
         anthropic_api_key = case when p_anthropic_key is null then anthropic_api_key else nullif(btrim(p_anthropic_key), '') end,
         aws_access_key_id = case when p_aws_key_id is null then aws_access_key_id else nullif(btrim(p_aws_key_id), '') end,
         aws_secret_access_key = case when p_aws_secret is null then aws_secret_access_key else nullif(btrim(p_aws_secret), '') end,
         bedrock_api_key = case when p_bedrock_api_key is null then bedrock_api_key else nullif(btrim(p_bedrock_api_key), '') end,
         last_test_at = null, last_test_ok = null, last_test_result = null,
         updated_at = now(), updated_by = auth.uid()
   where id
  returning * into s;
  if s.provider = 'anthropic' and s.anthropic_api_key is null then
    raise exception 'Add the Anthropic API key' using errcode = '22023';
  end if;
  if s.provider = 'bedrock' and (s.bedrock_region is null or s.bedrock_model_id is null) then
    raise exception 'Add the AWS region and the Bedrock model id' using errcode = '22023';
  end if;
  -- The audit never contains a key.
  perform private.audit('dv.ai_settings_changed', 'dv_ai_settings', null, jsonb_build_object(
    'provider', s.provider, 'classify', s.classify_enabled, 'draft', s.draft_enabled, 'ask_on_whatsapp', s.ask_on_whatsapp,
    'anthropic_key_changed', p_anthropic_key is not null, 'aws_keys_changed', p_aws_key_id is not null or p_aws_secret is not null,
    'bedrock_api_key_changed', p_bedrock_api_key is not null));
end;
$$;

revoke all on function public.dv_ai_settings_save(text, text, text, text, boolean, boolean, text, text, text, text, text) from public, anon;
grant execute on function public.dv_ai_settings_save(text, text, text, text, boolean, boolean, text, text, text, text, text) to authenticated;
