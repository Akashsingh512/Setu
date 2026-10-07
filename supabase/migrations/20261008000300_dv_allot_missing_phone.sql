-- Allotting on WhatsApp, two gaps closed:
--   * The person is in Setu but has no phone number: the bot asks for it
--     ("What is Vinod's WhatsApp number?"), saves it on their profile, then allots.
--   * The person has no team (e.g. a super admin): leads come from the allotter's
--     team, else the team with the most free leads. Their profile is not changed.

alter table public.dv_allot_pending add column if not exists target_profile_id uuid references public.profiles (id);

create function private.swap_check(p_fn regprocedure, p_old text, p_new text) returns void
language plpgsql as $$
declare
  v_def text := pg_get_functiondef(p_fn);
begin
  if position(p_new in v_def) > 0 then
    return;   -- already done
  end if;
  if position(p_old in v_def) = 0 then
    raise exception 'Allot fix: expected text not found in %', p_fn;
  end if;
  execute replace(v_def, p_old, p_new);
end;
$$;

-- 1. Known person without a phone: ask for it.
select private.swap_check('public.dv_allot_by_whatsapp(uuid,integer,text)',
  '    v_reply := private.dv_allot_to(v_allotter, t, p_count, m.id);',
  '    if t.phone is null then
      insert into public.dv_allot_pending (allotter_id, chat_jid, target_name, target_profile_id, count, need)
      values (v_allotter.id, m.chat_jid, t.full_name, t.id, p_count, ''phone'');
      v_reply := format(E''%s is in Setu but has no phone number. What is %s''''s WhatsApp number? I will save it and send them the leads.\n(Reply CANCEL to stop.)'',
                        t.full_name, split_part(t.full_name, '' '', 1));
    else
      v_reply := private.dv_allot_to(v_allotter, t, p_count, m.id);
    end if;');

-- 2. The answer: save the number on that person, then allot.
select private.swap_check('public.dv_allot_continue(uuid)',
  '  -- The number may belong to someone after all: allot to them.',
  '  -- A known person who had no number: save it on their profile, then allot.
  if pd.target_profile_id is not null then
    if exists (select 1 from public.profiles
                where id <> pd.target_profile_id and status = ''active''
                  and right(regexp_replace(coalesce(phone, ''''), ''\D'', '''', ''g''), 10) = right(regexp_replace(pd.target_phone, ''\D'', '''', ''g''), 10)) then
      perform private.dv_allot_reply(m, format(''%s already belongs to someone else in Setu. Please send %s''''s own number. (Or CANCEL.)'', pd.target_phone, pd.target_name), ''allot-reply'');
      return jsonb_build_object(''handled'', true);
    end if;
    update public.profiles set phone = pd.target_phone where id = pd.target_profile_id returning * into t;
    delete from public.dv_allot_pending where allotter_id = v_allotter.id;
    perform private.audit(''dv.member_phone_added_by_allotter'', ''profile'', t.id, jsonb_build_object(''allotter'', v_allotter.id), v_allotter.id);
    v_reply := format(E''Saved %s as %s''''s number.\n'', pd.target_phone, t.full_name) || private.dv_allot_to(v_allotter, t, pd.count, m.id);
    perform private.dv_allot_reply(m, v_reply, ''allot-reply'');
    return jsonb_build_object(''handled'', true);
  end if;

  -- The number may belong to someone after all: allot to them.');

-- 3. No team: take leads from the allotter''s team, else the team with the most free leads.
select private.swap_check('private.dv_allot_to(public.profiles,public.profiles,integer,uuid,jsonb)',
  '  if t.team_id is null then',
  '  if t.team_id is null then
    -- Only for picking leads; the person''s profile keeps no team.
    t.team_id := coalesce(p_allotter.team_id, (
      select le.team_id from public.leads le
       where le.assigned_to is null and le.archived_at is null and le.merged_into_id is null and le.team_id is not null
       group by le.team_id order by count(*) desc limit 1));
  end if;
  if t.team_id is null then');

drop function private.swap_check(regprocedure, text, text);
