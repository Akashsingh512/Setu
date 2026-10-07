-- A "Welcome" course response: the reply to a plain greeting ("hello", "Jai Gurudev")
-- in a private chat, at most once every 6 hours per chat (the gateway checks that).
-- Edited on the Course responses page like the others; no row = the built-in text.

alter table public.dv_response_templates drop constraint dv_response_templates_kind_check;
alter table public.dv_response_templates add constraint dv_response_templates_kind_check
  check (kind in ('greeting', 'course_details', 'course_list', 'no_upcoming', 'fallback'));
