// Baileys session state stored in Postgres (public.wa_auth_state, service role
// only) instead of on disk, so the gateway survives restarts and redeploys on
// hosts with ephemeral filesystems (Render, Fly, containers) without a new QR scan.
import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from 'baileys';
import type { SupabaseClient } from '@supabase/supabase-js';

const CREDS_KEY = 'creds';
const key = (type: string, id: string) => `${type}:${id}`;

export async function usePostgresAuthState(db: SupabaseClient): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
  clear: () => Promise<void>;
  isRegistered: () => boolean;
}> {
  const read = async (keys: string[]): Promise<Map<string, unknown>> => {
    const out = new Map<string, unknown>();
    // Chunk: PostgREST URLs have a length limit.
    for (let i = 0; i < keys.length; i += 100) {
      const { data, error } = await db.from('wa_auth_state').select('key, value').in('key', keys.slice(i, i + 100));
      if (error) throw new Error(`auth state read failed: ${error.message}`);
      for (const row of data ?? []) out.set(row.key as string, JSON.parse(row.value as string, BufferJSON.reviver));
    }
    return out;
  };

  const write = async (rows: { key: string; value: unknown }[]) => {
    if (!rows.length) return;
    const { error } = await db.from('wa_auth_state').upsert(
      rows.map((r) => ({ key: r.key, value: JSON.stringify(r.value, BufferJSON.replacer), updated_at: new Date().toISOString() })),
    );
    if (error) throw new Error(`auth state write failed: ${error.message}`);
  };

  const remove = async (keys: string[]) => {
    if (!keys.length) return;
    const { error } = await db.from('wa_auth_state').delete().in('key', keys);
    if (error) throw new Error(`auth state delete failed: ${error.message}`);
  };

  const stored = (await read([CREDS_KEY])).get(CREDS_KEY) as AuthenticationCreds | undefined;
  const creds: AuthenticationCreds = stored ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const found = await read(ids.map((id) => key(type, id)));
          const result: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            let value = found.get(key(type, id));
            if (value && type === 'app-state-sync-key') value = proto.Message.AppStateSyncKeyData.fromObject(value as object);
            if (value !== undefined) result[id] = value as SignalDataTypeMap[T];
          }
          return result;
        },
        set: async (data) => {
          const upserts: { key: string; value: unknown }[] = [];
          const deletes: string[] = [];
          for (const type in data) {
            const entries = data[type as keyof SignalDataTypeMap] ?? {};
            for (const id in entries) {
              const value = entries[id];
              if (value) upserts.push({ key: key(type, id), value });
              else deletes.push(key(type, id));
            }
          }
          await Promise.all([write(upserts), remove(deletes)]);
        },
      },
    },
    saveCreds: () => write([{ key: CREDS_KEY, value: creds }]),
    clear: async () => {
      const { error } = await db.from('wa_auth_state').delete().neq('key', '');
      if (error) throw new Error(`auth state clear failed: ${error.message}`);
    },
    isRegistered: () => !!creds.me?.id,
  };
}
